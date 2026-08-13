import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileStore } from '../../src/state/file-store.js';
import { createIdempotencyCache } from '../../src/idempotency/cache.js';
import { createConversationRoute } from '../../src/routes/twilio-conversation.js';
import { createMessageStatusRoute } from '../../src/routes/twilio-message-status.js';

let dir, store, cache;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dup-'));
  store = createFileStore({ path: join(dir, 'state.json') });
  cache = createIdempotencyCache();
  return () => rm(dir, { recursive: true, force: true });
});

describe('duplicate webhook handling', () => {
  it('conversation webhook is idempotent on MessageSid', async () => {
    const send = vi.fn(() => setImmediate(() => handlers.forEach((h) => h('ok'))));
    const handlers = [];
    const session = {
      open: vi.fn().mockResolvedValue({ elevenlabsConversationId: 'c1' }),
      sendUserMessage: send,
      onAgentResponse: (fn) => handlers.push(fn),
      onToolCall: vi.fn(),
      close: vi.fn(),
    };
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(
      createConversationRoute({
        store, cache,
        conversationsClient: { ensureBotParticipant: vi.fn().mockResolvedValue(), writeBotMessage: vi.fn().mockResolvedValue('IM1') },
        sessionManager: { getOrOpen: vi.fn().mockResolvedValue(session), close: vi.fn() },
        config: { botIdentity: 'bot', elevenlabs: { escalateOnMedia: false } },
        logger: { child: () => ({ info() {}, warn() {}, error() {} }), info() {}, warn() {}, error() {} },
        skipSignatureVerification: true,
      }),
    );

    const payload = { EventType: 'onMessageAdded', ConversationSid: 'CH1', MessageSid: 'IMdup', Author: 'whatsapp:+1', Body: 'hi' };
    await request(app).post('/webhooks/twilio/conversation').type('form').send(payload);
    await request(app).post('/webhooks/twilio/conversation').type('form').send(payload);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('message-status webhook is idempotent on MessageSid+MessageStatus', async () => {
    await store.upsert('CH1', () => ({ conversationSid: 'CH1', mode: 'bot' }));
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(
      createMessageStatusRoute({
        store, cache, config: {},
        logger: { child: () => ({ info() {}, warn() {}, error() {} }), info() {}, warn() {}, error() {} },
        skipSignatureVerification: true,
      }),
    );

    for (let i = 0; i < 3; i += 1) {
      await request(app).post('/webhooks/twilio/message-status').type('form').send({
        ConversationSid: 'CH1', MessageSid: 'IM1', MessageStatus: 'delivered',
      });
    }
    const s = await store.get('CH1');
    expect(s.deliveryStatuses.IM1.status).toBe('delivered');
  });
});
