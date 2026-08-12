import { describe, it, expect } from 'vitest';
import { validateEscalationPayload } from '../../../src/handoff/validate.js';

const good = {
  conversationSid: 'CHabc',
  handoffId: 'handoff_CHabc_1',
  customerAddress: 'whatsapp:+15551234567',
  businessAddress: 'whatsapp:+14155238886',
  intent: 'billing_dispute',
  reason: 'explicit_human_request',
  summary: 'Customer disputes charge.',
};

describe('validateEscalationPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(validateEscalationPayload(good).ok).toBe(true);
  });
  it('rejects a non-CH conversation sid', () => {
    const r = validateEscalationPayload({ ...good, conversationSid: 'IMabc' });
    expect(r.ok).toBe(false);
  });
  it('rejects addresses without whatsapp: scheme', () => {
    const r = validateEscalationPayload({ ...good, customerAddress: '+15551234567' });
    expect(r.ok).toBe(false);
  });
  it('rejects a summary over 500 characters', () => {
    const r = validateEscalationPayload({ ...good, summary: 'a'.repeat(501) });
    expect(r.ok).toBe(false);
  });
});
