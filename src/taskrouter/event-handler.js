import { InvalidTransition } from '../state/file-store.js';

const ACCEPT = 'reservation.accepted';
const COMPLETE = new Set(['task.completed', 'task.canceled']);

function parseAttributes(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export function createTaskRouterHandler({ store, cache, logger }) {
  return async function handle(req, res) {
    const body = req.body ?? {};
    const eventSid = body.EventSid;
    if (!eventSid) return res.status(400).end();

    const key = `taskrouter:${eventSid}`;
    if (cache.seen(key)) return res.status(200).end();
    cache.remember(key, true);

    const attrs = parseAttributes(body.TaskAttributes);
    const conversationSid = attrs.conversationSid;
    if (!conversationSid) return res.status(200).end();

    const log = logger.child({ conversationSid, eventSid, eventType: body.EventType });

    try {
      if (body.EventType === ACCEPT) {
        await store.transitionMode(conversationSid, 'human_pending', 'human', { taskSid: body.TaskSid });
      } else if (COMPLETE.has(body.EventType)) {
        await store.transitionMode(conversationSid, ['human', 'human_pending'], 'closed');
      }
    } catch (err) {
      if (err instanceof InvalidTransition) {
        log.warn({ err }, 'ignored_invalid_transition');
      } else {
        throw err;
      }
    }

    res.status(200).end();
  };
}
