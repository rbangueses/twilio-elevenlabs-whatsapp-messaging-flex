export function mintHandoffId(conversationSid, now = Date.now()) {
  return `handoff_${conversationSid}_${now}`;
}
