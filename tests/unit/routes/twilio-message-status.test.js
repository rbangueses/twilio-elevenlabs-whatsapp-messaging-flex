import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore } from '../../../src/state/file-store.js';
import { createIdempotencyCache } from '../../../src/idempotency/cache.js';
import { createMessageStatusRoute } from '../../../src/routes/twilio-message-status.js';

let dir, store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ms-'));
  store = createFileStore({ path: join(dir, 'state.json') });
  await store.upsert('CH1', () => ({ conversationSid: 'CH1', mode: 'bot' }));
  return () => rm(dir, { recursive: true, force: true });
});

describe('POST /webhooks/twilio/message-status', () => {
  it('records the status against the conversation state', async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(
      createMessageStatusRoute({
        store,
        cache: createIdempotencyCache(),
        config: {},
        logger: { info() {}, warn() {}, error() {}, child: () => ({ info() {}, warn() {}, error() {} }) },
        skipSignatureVerification: true,
      }),
    );

    const res = await request(app)
      .post('/webhooks/twilio/message-status')
      .type('form')
      .send({ MessageSid: 'IM1', MessageStatus: 'delivered', ConversationSid: 'CH1' });

    expect(res.status).toBe(200);
    const s = await store.get('CH1');
    expect(s.deliveryStatuses.IM1.status).toBe('delivered');
  });
});
