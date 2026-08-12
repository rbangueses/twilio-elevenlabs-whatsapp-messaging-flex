import express from 'express';
import { healthRouter } from './routes/health.js';
import { createConversationRoute } from './routes/twilio-conversation.js';
import { createMessageStatusRoute } from './routes/twilio-message-status.js';
import { loadConfig } from './config.js';

export function createServer(config, deps = {}) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(healthRouter(config));

  if (deps.store && deps.cache && deps.conversationsClient && deps.sessionManager && deps.logger) {
    app.use(
      createConversationRoute({
        store: deps.store,
        cache: deps.cache,
        conversationsClient: deps.conversationsClient,
        sessionManager: deps.sessionManager,
        config,
        logger: deps.logger,
      }),
    );
  }

  if (deps.store && deps.cache && deps.logger) {
    app.use(
      createMessageStatusRoute({
        store: deps.store,
        cache: deps.cache,
        config,
        logger: deps.logger,
      }),
    );
  }

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = createServer(config);
  app.listen(config.port, () => console.log(`relay listening on :${config.port}`));
}
