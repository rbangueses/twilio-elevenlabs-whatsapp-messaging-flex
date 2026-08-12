import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileStore } from '../../src/state/file-store.js';
import { createIdempotencyCache } from '../../src/idempotency/cache.js';
import { createConversationRoute } from '../../src/routes/twilio-conversation.js';

function fakeConversationsClient() {
  return {
    ensureBotParticipant: vi.fn().mockResolvedValue(undefined),
    writeBotMessage: vi.fn().mockResolvedValue('IMbot1'),
  };
}

function fakeSession(agentReply) {
  const listeners = [];
  return {
    open: vi.fn().mockResolvedValue({ elevenlabsConversationId: 'conv_1' }),
    sendUserMessage: vi.fn(() => setImmediate(() => listeners.forEach((l) => l(agentReply)))),
    onAgentResponse: (fn) => listeners.push(fn),
    onToolCall: vi.fn(),
    onClose: vi.fn(),
    close: vi.fn(),
  };
}

function fakeManager(session) {
  return {
    getOrOpen: vi.fn().mockResolvedValue(session),
    close: vi.fn(),
    size: () => 1,
  };
}

let store, dir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'route-'));
  store = createFileStore({ path: join(dir, 'state.json') });
  return () => rm(dir, { recursive: true, force: true });
});

function buildApp({ session }) {
  const conversationsClient = fakeConversationsClient();
  const manager = fakeManager(session);
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(
    createConversationRoute({
      store,
      cache: createIdempotencyCache(),
      conversationsClient,
      sessionManager: manager,
      config: { botIdentity: 'bot', elevenlabs: { escalateOnMedia: false } },
      logger: { child: () => ({ info() {}, warn() {}, error() {} }), info() {}, warn() {}, error() {} },
      // Bypass signature check in this test — signature middleware has its own tests
      skipSignatureVerification: true,
    }),
  );
  return { app, conversationsClient, manager };
}

describe('POST /webhooks/twilio/conversation', () => {
  it('relays a text message to ElevenLabs and writes the bot reply back', async () => {
    const session = fakeSession('Hi there!');
    const { app, conversationsClient } = buildApp({ session });

    const res = await request(app)
      .post('/webhooks/twilio/conversation')
      .type('form')
      .send({
        EventType: 'onMessageAdded',
        ConversationSid: 'CH1',
        MessageSid: 'IM1',
        Author: 'whatsapp:+15551234567',
        Body: 'hello',
      });

    expect(res.status).toBe(200);
    expect(session.sendUserMessage).toHaveBeenCalledWith('hello');
    expect(conversationsClient.writeBotMessage).toHaveBeenCalledWith({
      conversationSid: 'CH1',
      body: 'Hi there!',
      correlationId: expect.any(String),
    });
    expect((await store.get('CH1')).mode).toBe('bot');
  });

  it('ignores messages authored by the bot', async () => {
    const session = fakeSession('should not be called');
    const { app } = buildApp({ session });
    const res = await request(app)
      .post('/webhooks/twilio/conversation')
      .type('form')
      .send({ EventType: 'onMessageAdded', ConversationSid: 'CH1', MessageSid: 'IM1', Author: 'bot', Body: 'x' });
    expect(res.status).toBe(200);
    expect(session.sendUserMessage).not.toHaveBeenCalled();
  });

  it('sends a fallback message on non-text media when ESCALATE_ON_MEDIA is off', async () => {
    const session = fakeSession('should not be called');
    const { app, conversationsClient } = buildApp({ session });
    await request(app)
      .post('/webhooks/twilio/conversation')
      .type('form')
      .send({
        EventType: 'onMessageAdded',
        ConversationSid: 'CH1',
        MessageSid: 'IM2',
        Author: 'whatsapp:+15551234567',
        Body: '',
        Media: JSON.stringify([{ Sid: 'ME1' }]),
      });

    expect(session.sendUserMessage).not.toHaveBeenCalled();
    expect(conversationsClient.writeBotMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringMatching(/describe your request in text/i) }),
    );
  });

  it('dedups by MessageSid on retries', async () => {
    const session = fakeSession('Hi there!');
    const { app } = buildApp({ session });
    const payload = {
      EventType: 'onMessageAdded',
      ConversationSid: 'CH1',
      MessageSid: 'IM3',
      Author: 'whatsapp:+15551234567',
      Body: 'hello',
    };
    await request(app).post('/webhooks/twilio/conversation').type('form').send(payload);
    await request(app).post('/webhooks/twilio/conversation').type('form').send(payload);
    expect(session.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('does not relay when mode is not bot', async () => {
    const session = fakeSession('should not be called');
    const { app } = buildApp({ session });
    await store.upsert('CH1', () => ({ conversationSid: 'CH1', mode: 'human_pending' }));
    const res = await request(app)
      .post('/webhooks/twilio/conversation')
      .type('form')
      .send({ EventType: 'onMessageAdded', ConversationSid: 'CH1', MessageSid: 'IM4', Author: 'whatsapp:+1', Body: 'hi' });
    expect(res.status).toBe(200);
    expect(session.sendUserMessage).not.toHaveBeenCalled();
  });
});
