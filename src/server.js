import { fileURLToPath } from 'node:url';
import './env.js';
import express from 'express';
import twilio from 'twilio';
import { WebSocket } from 'ws';

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createStore } from './state/store.js';
import { createIdempotencyCache } from './idempotency/cache.js';
import { createConversationsClient } from './twilio/conversations.js';
import { createSession } from './elevenlabs/session.js';
import { createSessionManager } from './elevenlabs/session-manager.js';
import { createFlexClient } from './handoff/flex.js';
import { createHandoffController } from './handoff/controller.js';
import { createTaskRouterHandler } from './taskrouter/event-handler.js';

import { healthRouter } from './routes/health.js';
import { createConversationRoute } from './routes/twilio-conversation.js';
import { createMessageStatusRoute } from './routes/twilio-message-status.js';
import { createEscalateRoute } from './routes/elevenlabs-escalate.js';
import { createTaskRouterRoute } from './routes/taskrouter-events.js';

export function bootstrap({ config = loadConfig() } = {}) {
  const logger = createLogger({ level: config.logLevel });
  if (!config.handoffToken) {
    logger.warn('handoff_token_missing_escalate_route_will_reject_all_requests');
  }
  const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);
  const store = createStore(config);
  const cache = createIdempotencyCache();
  const conversationsClient = createConversationsClient({ twilioClient, botIdentity: config.botIdentity, conversationsServiceSid: config.twilio.conversationsServiceSid });
  const flexClient = createFlexClient({ twilioClient, flexConfig: config.flex });
  const sessionManager = createSessionManager({
    idleTimeoutMs: config.elevenlabs.idleTimeoutMs,
    sessionFactory: () =>
      createSession({
        url: config.elevenlabs.wsUrl,
        apiKey: config.elevenlabs.apiKey,
        agentId: config.elevenlabs.agentId,
        wsFactory: (url, opts) => new WebSocket(url, opts),
      }),
  });
  const handoffController = createHandoffController({ store, cache, sessionManager, flexClient, logger });
  const taskRouterHandler = createTaskRouterHandler({ store, cache, logger });

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(healthRouter(config));
  app.use(createConversationRoute({ store, cache, conversationsClient, sessionManager, config, logger }));
  app.use(createMessageStatusRoute({ store, cache, config, logger }));
  app.use(createEscalateRoute({ controller: handoffController, config }));
  app.use(createTaskRouterRoute({ handler: taskRouterHandler, config }));

  return { app, store, cache, sessionManager, logger };
}

export function createServer(config, deps = {}) {
  // retained for tests: builds an app with only /health and any deps callers wire
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(healthRouter(config));
  return app;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadConfig();
  const { app, logger } = bootstrap({ config });
  const server = app.listen(config.port, () => logger.info({ port: config.port }, 'relay_listening'));
  server.on('error', (err) => logger.error({ err: { message: err.message, code: err.code } }, 'server_error'));
}
