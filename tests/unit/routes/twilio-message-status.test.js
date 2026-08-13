import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    expect(s.deliveryStatuses.IM1.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns 400 when MessageSid is missing', async () => {
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
      .send({ MessageStatus: 'delivered', ConversationSid: 'CH1' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when MessageStatus is missing', async () => {
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
      .send({ MessageSid: 'IM1', ConversationSid: 'CH1' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when ConversationSid is missing', async () => {
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
      .send({ MessageSid: 'IM1', MessageStatus: 'delivered' });

    expect(res.status).toBe(400);
  });

  it('returns 200 with no-op on duplicate MessageSid and MessageStatus', async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    const spyUpsert = vi.spyOn(store, 'upsert');
    app.use(
      createMessageStatusRoute({
        store,
        cache: createIdempotencyCache(),
        config: {},
        logger: { info() {}, warn() {}, error() {}, child: () => ({ info() {}, warn() {}, error() {} }) },
        skipSignatureVerification: true,
      }),
    );

    // Send the same payload twice
    const payload = { MessageSid: 'IMdup', MessageStatus: 'delivered', ConversationSid: 'CH1' };
    const res1 = await request(app)
      .post('/webhooks/twilio/message-status')
      .type('form')
      .send(payload);
    const res2 = await request(app)
      .post('/webhooks/twilio/message-status')
      .type('form')
      .send(payload);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(spyUpsert).toHaveBeenCalledOnce();
  });

  it('initializes new conversation when not present', async () => {
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
      .send({ MessageSid: 'IM2', MessageStatus: 'delivered', ConversationSid: 'CH2' });

    expect(res.status).toBe(200);
    const s = await store.get('CH2');
    expect(s.mode).toBe('bot');
    expect(s.deliveryStatuses.IM2).toBeDefined();
  });
});
