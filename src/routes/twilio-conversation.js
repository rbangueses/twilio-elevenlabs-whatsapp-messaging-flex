import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { verifyTwilioSignature } from '../twilio/signature.js';
import { detectMedia } from '../media/detect.js';
import { mintHandoffId } from '../elevenlabs/handoff-id.js';

const MEDIA_FALLBACK =
  'I can only read text on WhatsApp right now — please describe your request in text and I will help.';
const AGENT_RESPONSE_TIMEOUT_MS = 20_000;

export function createConversationRoute({
  store,
  cache,
  conversationsClient,
  sessionManager,
  config,
  logger,
  skipSignatureVerification = false,
}) {
  const router = Router();
  const middlewares = [];
  if (!skipSignatureVerification) {
    middlewares.push(verifyTwilioSignature({ authToken: config.twilio?.authToken ?? '' }));
  }

  router.post('/webhooks/twilio/conversation', ...middlewares, async (req, res) => {
    const body = req.body ?? {};
    if (body.EventType !== 'onMessageAdded') return res.status(200).end();
    if (body.Author === config.botIdentity) return res.status(200).end();

    const conversationSid = body.ConversationSid;
    const messageSid = body.MessageSid;
    if (!conversationSid || !messageSid) return res.status(400).end();

    const correlationId = randomUUID();
    const log = logger.child({ correlationId, conversationSid, messageSid });

    const key = `twilio:msg:${messageSid}`;
    if (cache.seen(key)) {
      log.info('duplicate_message_ignored');
      return res.status(200).end();
    }
    cache.remember(key, true);

    const state = await store.upsert(conversationSid, (prev) => ({
      conversationSid,
      customerAddress: body.Author,
      businessAddress: body.ProxyAddress ?? prev?.businessAddress ?? '',
      mode: prev?.mode ?? 'bot',
      elevenlabsConversationId: prev?.elevenlabsConversationId ?? null,
      elevenlabsSessionStatus: prev?.elevenlabsSessionStatus ?? 'idle',
      handoffId: prev?.handoffId ?? mintHandoffId(conversationSid),
      flexInteractionSid: prev?.flexInteractionSid ?? null,
      taskSid: prev?.taskSid ?? null,
      lastInboundMessageSid: messageSid,
      lastCustomerMessageAt: new Date().toISOString(),
    }));

    if (state.mode !== 'bot') {
      log.info({ mode: state.mode }, 'not_in_bot_mode');
      return res.status(200).end();
    }

    const media = detectMedia(body);
    if (media.hasMedia && !config.elevenlabs?.escalateOnMedia) {
      await conversationsClient.ensureBotParticipant(conversationSid);
      await conversationsClient.writeBotMessage({ conversationSid, body: MEDIA_FALLBACK, correlationId });
      return res.status(200).end();
    }

    try {
      await conversationsClient.ensureBotParticipant(conversationSid);
      const session = await sessionManager.getOrOpen({
        conversationSid,
        dynamicVariables: {
          twilioConversationSid: conversationSid,
          customerAddress: state.customerAddress,
          businessAddress: state.businessAddress,
          handoffId: state.handoffId,
        },
      });

      // Subscribe BEFORE sending to avoid a subscribe-race where the agent
      // replies before we register the listener.
      const agentReplyPromise = waitForAgentResponse(session, AGENT_RESPONSE_TIMEOUT_MS);
      session.sendUserMessage(body.Body ?? '');
      const reply = await agentReplyPromise;
      await conversationsClient.writeBotMessage({ conversationSid, body: reply, correlationId });
      res.status(200).end();
    } catch (err) {
      log.error({ err }, 'bot_reply_failed');
      await conversationsClient
        .writeBotMessage({
          conversationSid,
          body: "I'm having trouble responding right now. Please try again in a moment.",
          correlationId,
        })
        .catch(() => {});
      res.status(200).end();
    }
  });

  return router;
}

function waitForAgentResponse(session, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('agent_response_timeout'));
    }, timeoutMs);
    session.onAgentResponse((text) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(text);
    });
  });
}
