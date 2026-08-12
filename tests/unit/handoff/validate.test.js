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
  it('drops a non-numeric priority silently', () => {
    const r = validateEscalationPayload({ ...good, priority: '5' });
    expect(r.ok).toBe(true);
    expect(r.value.priority).toBeUndefined();
  });
  it('reports missing vs invalid field distinctly', () => {
    const missing = validateEscalationPayload({ ...good, intent: undefined });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/missing field: intent/);

    const invalid = validateEscalationPayload({ ...good, intent: 42 });
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toMatch(/invalid field: intent/);
  });
  it('rejects businessAddress without whatsapp scheme', () => {
    const r = validateEscalationPayload({ ...good, businessAddress: '+14155238886' });
    expect(r.ok).toBe(false);
  });
  it('passes numeric priority through', () => {
    const r = validateEscalationPayload({ ...good, priority: 7 });
    expect(r.value.priority).toBe(7);
  });
});
