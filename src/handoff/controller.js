import { validateEscalationPayload } from './validate.js';
import { InvalidTransition } from '../state/file-store.js';

export function createHandoffController({ store, cache, sessionManager, flexClient, logger }) {
  return async function handle(req, res) {
    const validation = validateEscalationPayload(req.body);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
    const payload = validation.value;
    const log = logger.child({
      conversationSid: payload.conversationSid,
      handoffId: payload.handoffId,
    });

    const dedupKey = `handoff:${payload.conversationSid}:${payload.handoffId}`;
    const remembered = cache.recall(dedupKey);
    if (remembered) {
      return res.status(200).json(remembered);
    }

    const existing = await store.get(payload.conversationSid);
    if (existing?.flexInteractionSid) {
      const response = {
        interactionSid: existing.flexInteractionSid,
        taskSid: existing.taskSid,
        handoffId: existing.handoffId,
      };
      cache.remember(dedupKey, response);
      return res.status(200).json(response);
    }

    try {
      await store.transitionMode(payload.conversationSid, 'bot', 'human_pending', {
        handoffId: payload.handoffId,
        elevenlabsConversationId: payload.elevenlabsConversationId ?? existing?.elevenlabsConversationId ?? null,
      });
    } catch (err) {
      if (err instanceof InvalidTransition) {
        return res.status(409).json({ error: 'invalid_state_transition' });
      }
      throw err;
    }

    let interactionSid, taskSid;
    try {
      ({ interactionSid, taskSid } = await flexClient.createInteraction(payload));
    } catch (err) {
      log.error({ err }, 'flex_interaction_create_failed');
      return res.status(502).json({ error: 'flex_interaction_create_failed' });
    }

    await store.upsert(payload.conversationSid, (prev) => ({
      ...prev,
      flexInteractionSid: interactionSid,
      taskSid,
    }));

    sessionManager.close(payload.conversationSid);

    const response = { interactionSid, taskSid, handoffId: payload.handoffId };
    cache.remember(dedupKey, response);
    return res.status(200).json(response);
  };
}
