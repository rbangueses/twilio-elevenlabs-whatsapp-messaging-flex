import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { verifyTwilioSignature } from '../../../src/twilio/signature.js';

const authToken = 'test-token';

function buildApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.post(
    '/webhooks/twilio/conversation',
    verifyTwilioSignature({ authToken }),
    (_req, res) => res.status(200).send('ok'),
  );
  return app;
}

function sign(url, body) {
  return twilio.getExpectedTwilioSignature(authToken, url, body);
}

describe('verifyTwilioSignature', () => {
  it('accepts a correctly signed form-encoded request', async () => {
    const app = buildApp();
    const body = { ConversationSid: 'CH1', Body: 'hi' };
    const url = 'http://127.0.0.1/webhooks/twilio/conversation';
    const sig = sign(url, body);
    const res = await request(app)
      .post('/webhooks/twilio/conversation')
      .set('Host', '127.0.0.1')
      .set('X-Forwarded-Proto', 'http')
      .set('X-Twilio-Signature', sig)
      .type('form')
      .send(body);
    expect(res.status).toBe(200);
  });

  it('rejects an unsigned or wrongly signed request', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/webhooks/twilio/conversation')
      .set('X-Twilio-Signature', 'not-a-valid-signature')
      .type('form')
      .send({ ConversationSid: 'CH1' });
    expect(res.status).toBe(403);
  });
});
