import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore, InvalidTransition } from '../../../src/state/file-store.js';

let dir, store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'store-'));
  store = createFileStore({ path: join(dir, 'state.json') });
  return () => rm(dir, { recursive: true, force: true });
});

describe('file store', () => {
  it('returns null for unknown conversation', async () => {
    expect(await store.get('CHnone')).toBeNull();
  });

  it('upserts and reads back state', async () => {
    const s = await store.upsert('CH1', () => ({
      conversationSid: 'CH1',
      customerAddress: 'whatsapp:+15551234567',
      businessAddress: 'whatsapp:+14155238886',
      mode: 'bot',
    }));
    expect(s.mode).toBe('bot');
    expect((await store.get('CH1')).customerAddress).toBe('whatsapp:+15551234567');
  });

  it('serializes concurrent upserts on the same key', async () => {
    await store.upsert('CH1', () => ({ conversationSid: 'CH1', mode: 'bot', counter: 0 }));
    await Promise.all(
      Array.from({ length: 10 }, () =>
        store.upsert('CH1', (prev) => ({ ...prev, counter: prev.counter + 1 })),
      ),
    );
    expect((await store.get('CH1')).counter).toBe(10);
  });

  it('transitionMode enforces allowed source modes', async () => {
    await store.upsert('CH1', () => ({ conversationSid: 'CH1', mode: 'bot' }));
    const next = await store.transitionMode('CH1', 'bot', 'human_pending', { handoffId: 'h1' });
    expect(next.mode).toBe('human_pending');
    expect(next.handoffId).toBe('h1');
    await expect(
      store.transitionMode('CH1', 'bot', 'human_pending'),
    ).rejects.toBeInstanceOf(InvalidTransition);
  });
});
