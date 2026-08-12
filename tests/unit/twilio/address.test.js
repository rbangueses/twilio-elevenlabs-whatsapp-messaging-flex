import { describe, it, expect } from 'vitest';
import { normalizeAddress } from '../../../src/twilio/address.js';

describe('normalizeAddress', () => {
  it('normalizes valid whatsapp addresses', () => {
    expect(normalizeAddress('WhatsApp:+15551234567')).toBe('whatsapp:+15551234567');
    expect(normalizeAddress(' whatsapp:+15551234567 ')).toBe('whatsapp:+15551234567');
  });

  it('rejects addresses missing the whatsapp scheme', () => {
    expect(() => normalizeAddress('+15551234567')).toThrow();
    expect(() => normalizeAddress('sms:+15551234567')).toThrow();
  });
});
