import { Router } from 'express';
import { verifyTwilioSignature } from '../twilio/signature.js';

export function createMessageStatusRoute({
  store,
  cache,
  config,
  logger,
  skipSignatureVerification = false,
}) {
  const router = Router();
  const middlewares = [];
  if (!skipSignatureVerification) {
    middlewares.push(verifyTwilioSignature({ authToken: config.twilio?.authToken ?? '' }));
  }

  router.post('/webhooks/twilio/message-status', ...middlewares, async (req, res) => {
    const { MessageSid, MessageStatus, ConversationSid } = req.body ?? {};
    if (!MessageSid || !MessageStatus || !ConversationSid) return res.status(400).end();

    const key = `twilio:status:${MessageSid}:${MessageStatus}`;
    if (cache.seen(key)) return res.status(200).end();
    cache.remember(key, true);

    await store.upsert(ConversationSid, (prev) => ({
      ...(prev ?? { conversationSid: ConversationSid, mode: 'bot' }),
      deliveryStatuses: {
        ...(prev?.deliveryStatuses ?? {}),
        [MessageSid]: { status: MessageStatus, updatedAt: new Date().toISOString() },
      },
    }));

    res.status(200).end();
  });

  return router;
}
