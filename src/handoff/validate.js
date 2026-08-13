const REQUIRED = ['conversationSid', 'handoffId', 'customerAddress', 'businessAddress', 'intent', 'reason', 'summary'];

export function validateEscalationPayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  for (const key of REQUIRED) {
    if (body[key] === undefined || body[key] === null) {
      return { ok: false, error: `missing field: ${key}` };
    }
    if (typeof body[key] !== 'string' || body[key].length === 0) {
      return { ok: false, error: `invalid field: ${key}` };
    }
  }
  if (!body.conversationSid.startsWith('CH')) return { ok: false, error: 'conversationSid must start with CH' };
  if (!body.customerAddress.startsWith('whatsapp:')) return { ok: false, error: 'customerAddress must start with whatsapp:' };
  if (!body.businessAddress.startsWith('whatsapp:')) return { ok: false, error: 'businessAddress must start with whatsapp:' };
  if (body.summary.length > 500) return { ok: false, error: 'summary exceeds 500 characters' };
  if (body.intent.length > 64) return { ok: false, error: 'intent exceeds 64 characters' };
  if (body.reason.length > 64) return { ok: false, error: 'reason exceeds 64 characters' };
  const value = { ...body };
  if (typeof value.priority !== 'number') {
    delete value.priority;
  }
  if (typeof value.elevenlabsConversationId !== 'string' || value.elevenlabsConversationId.length === 0) {
    delete value.elevenlabsConversationId;
  }
  return { ok: true, value };
}
