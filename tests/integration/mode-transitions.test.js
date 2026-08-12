import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileStore } from '../../src/state/file-store.js';
import { createIdempotencyCache } from '../../src/idempotency/cache.js';
import { createTaskRouterHandler } from '../../src/taskrouter/event-handler.js';
import { createTaskRouterRoute } from '../../src/routes/taskrouter-events.js';

let dir, store, cache;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tr-'));
  store = createFileStore({ path: join(dir, 'state.json') });
  cache = createIdempotencyCache();
  await store.upsert('CH1', () => ({
    conversationSid: 'CH1',
    mode: 'human_pending',
    flexInteractionSid: 'KD1',
    taskSid: 'WT1',
  }));
  return () => rm(dir, { recursive: true, force: true });
});

function build() {
  const handler = createTaskRouterHandler({
    store, cache,
    logger: { info() {}, warn() {}, error() {}, child: () => ({ info() {}, warn() {}, error() {} }) },
  });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(createTaskRouterRoute({ handler, config: {}, skipSignatureVerification: true }));
  return app;
}

async function post(app, body) {
  return request(app).post('/webhooks/taskrouter/events').type('form').send(body);
}

describe('TaskRouter events', () => {
  it('flips human_pending -> human on reservation.accepted', async () => {
    const res = await post(build(), {
      EventType: 'reservation.accepted',
      EventSid: 'EV1',
      TaskSid: 'WT1',
      TaskAttributes: JSON.stringify({ conversationSid: 'CH1' }),
    });
    expect(res.status).toBe(200);
    expect((await store.get('CH1')).mode).toBe('human');
  });

  it('flips human -> closed on task.completed', async () => {
    const app = build();
    await post(app, {
      EventType: 'reservation.accepted', EventSid: 'EV1', TaskSid: 'WT1',
      TaskAttributes: JSON.stringify({ conversationSid: 'CH1' }),
    });
    const res = await post(app, {
      EventType: 'task.completed', EventSid: 'EV2', TaskSid: 'WT1',
      TaskAttributes: JSON.stringify({ conversationSid: 'CH1' }),
    });
    expect(res.status).toBe(200);
    expect((await store.get('CH1')).mode).toBe('closed');
  });

  it('ignores unrelated events', async () => {
    const res = await post(build(), {
      EventType: 'reservation.created', EventSid: 'EV3', TaskSid: 'WT1',
      TaskAttributes: JSON.stringify({ conversationSid: 'CH1' }),
    });
    expect(res.status).toBe(200);
    expect((await store.get('CH1')).mode).toBe('human_pending');
  });

  it('dedups on EventSid', async () => {
    const app = build();
    await post(app, {
      EventType: 'reservation.accepted', EventSid: 'EV1', TaskSid: 'WT1',
      TaskAttributes: JSON.stringify({ conversationSid: 'CH1' }),
    });
    // Force mode back to check the dedup is real, not a coincidence
    await store.upsert('CH1', (prev) => ({ ...prev, mode: 'human_pending' }));
    await post(app, {
      EventType: 'reservation.accepted', EventSid: 'EV1', TaskSid: 'WT1',
      TaskAttributes: JSON.stringify({ conversationSid: 'CH1' }),
    });
    expect((await store.get('CH1')).mode).toBe('human_pending');
  });
});
