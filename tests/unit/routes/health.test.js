import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createServer } from '../../../src/server.js';

describe('GET /health', () => {
  it('returns config presence flags', async () => {
    const app = createServer({
      hasTwilio: true,
      hasElevenLabs: true,
      hasFlex: false,
    });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      service: 'twilio-elevenlabs-whatsapp-flex-relay',
      hasTwilio: true,
      hasElevenLabs: true,
      hasFlex: false,
    });
  });
});
