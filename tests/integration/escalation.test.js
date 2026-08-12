import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileStore } from '../../src/state/file-store.js';
import { createIdempotencyCache } from '../../src/idempotency/cache.js';
import { createHandoffController } from '../../src/handoff/controller.js';
import { createEscalateRoute } from '../../src/routes/elevenlabs-escalate.js';

let dir, store, cache;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'esc-'));
  store = createFileStore({ path: join(dir, 'state.json') });
  cache = createIdempotencyCache();
  await store.upsert('CH1', () => ({
    conversationSid: 'CH1',
    customerAddress: 'whatsapp:+15551234567',
    businessAddress: 'whatsapp:+14155238886',
    mode: 'bot',
    handoffId: 'handoff_CH1_1',
  }));
  return () => rm(dir, { recursive: true, force: true });
});

function build({ flexClient, sessionManager }) {
  const controller = createHandoffController({
    store,
    cache,
    sessionManager,
    flexClient,
    logger: { info() {}, warn() {}, error() {}, child: () => ({ info() {}, warn() {}, error() {} }) },
  });
  const app = express();
  app.use(express.json());
  app.use(createEscalateRoute({ controller, config: { handoffToken: 't' } }));
  return app;
}

const payload = {
  conversationSid: 'CH1',
  handoffId: 'handoff_CH1_1',
  customerAddress: 'whatsapp:+15551234567',
  businessAddress: 'whatsapp:+14155238886',
  intent: 'billing_dispute',
  reason: 'explicit_human_request',
  summary: 'Customer disputes a charge.',
};

describe('POST /webhooks/elevenlabs/escalate-to-flex', () => {
  it('creates a Flex Interaction and moves state to human_pending, closing the ElevenLabs session', async () => {
    const flexClient = { createInteraction: vi.fn().mockResolvedValue({ interactionSid: 'KD1', taskSid: 'WT1' }) };
    const sessionManager = { close: vi.fn() };
    const res = await request(build({ flexClient, sessionManager }))
      .post('/webhooks/elevenlabs/escalate-to-flex')
      .set('Authorization', 'Bearer t')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ interactionSid: 'KD1', taskSid: 'WT1', handoffId: 'handoff_CH1_1' });
    expect(sessionManager.close).toHaveBeenCalledWith('CH1');
    const s = await store.get('CH1');
    expect(s.mode).toBe('human_pending');
    expect(s.flexInteractionSid).toBe('KD1');
    expect(s.taskSid).toBe('WT1');
  });

  it('is idempotent — returns the stored Flex ids on retry, does not create a second Interaction', async () => {
    const flexClient = { createInteraction: vi.fn().mockResolvedValue({ interactionSid: 'KD1', taskSid: 'WT1' }) };
    const sessionManager = { close: vi.fn() };
    const app = build({ flexClient, sessionManager });
    await request(app).post('/webhooks/elevenlabs/escalate-to-flex').set('Authorization', 'Bearer t').send(payload);
    const res = await request(app).post('/webhooks/elevenlabs/escalate-to-flex').set('Authorization', 'Bearer t').send(payload);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ interactionSid: 'KD1', taskSid: 'WT1', handoffId: 'handoff_CH1_1' });
    expect(flexClient.createInteraction).toHaveBeenCalledTimes(1);
  });

  it('returns 400 for a malformed payload', async () => {
    const flexClient = { createInteraction: vi.fn() };
    const sessionManager = { close: vi.fn() };
    const res = await request(build({ flexClient, sessionManager }))
      .post('/webhooks/elevenlabs/escalate-to-flex')
      .set('Authorization', 'Bearer t')
      .send({ ...payload, conversationSid: 'IMbad' });
    expect(res.status).toBe(400);
    expect(flexClient.createInteraction).not.toHaveBeenCalled();
  });

  it('returns 401 without the bearer token', async () => {
    const flexClient = { createInteraction: vi.fn() };
    const sessionManager = { close: vi.fn() };
    const res = await request(build({ flexClient, sessionManager }))
      .post('/webhooks/elevenlabs/escalate-to-flex')
      .send(payload);
    expect(res.status).toBe(401);
  });

  it('returns 502 on Flex Interaction failure and leaves mode at human_pending', async () => {
    const flexClient = {
      createInteraction: vi.fn().mockRejectedValue(new Error('flex boom')),
    };
    const sessionManager = { close: vi.fn() };
    const res = await request(build({ flexClient, sessionManager }))
      .post('/webhooks/elevenlabs/escalate-to-flex')
      .set('Authorization', 'Bearer t')
      .send(payload);

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'flex_interaction_create_failed' });
    const s = await store.get('CH1');
    expect(s.mode).toBe('human_pending');
    expect(s.flexInteractionSid).toBeUndefined();
    expect(sessionManager.close).not.toHaveBeenCalled();
  });

  it('returns 409 when the conversation is not in bot mode', async () => {
    await store.upsert('CH1', (prev) => ({ ...prev, mode: 'human' }));
    const flexClient = { createInteraction: vi.fn() };
    const sessionManager = { close: vi.fn() };
    const res = await request(build({ flexClient, sessionManager }))
      .post('/webhooks/elevenlabs/escalate-to-flex')
      .set('Authorization', 'Bearer t')
      .send(payload);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'invalid_state_transition' });
    expect(flexClient.createInteraction).not.toHaveBeenCalled();
  });
});
