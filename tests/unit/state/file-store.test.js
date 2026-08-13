import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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

  it('cross-key concurrent writes both survive on disk (Finding 2 regression)', async () => {
    const half = 50;
    await store.upsert('CH1', () => ({ conversationSid: 'CH1', mode: 'bot', counter: 0 }));
    await store.upsert('CH2', () => ({ conversationSid: 'CH2', mode: 'bot', counter: 0 }));

    await Promise.all([
      ...Array.from({ length: half }, () =>
        store.upsert('CH1', (prev) => ({ ...prev, counter: prev.counter + 1 })),
      ),
      ...Array.from({ length: half }, () =>
        store.upsert('CH2', (prev) => ({ ...prev, counter: prev.counter + 1 })),
      ),
    ]);

    // Simulate a restart: read the file directly from disk, bypassing in-memory cache.
    const raw = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    expect(raw.CH1.counter).toBe(half);
    expect(raw.CH2.counter).toBe(half);
  });

  it('transitionMode accepts an array of allowed source modes', async () => {
    await store.upsert('CH1', () => ({ conversationSid: 'CH1', mode: 'human_pending' }));
    const next = await store.transitionMode('CH1', ['bot', 'human_pending'], 'human');
    expect(next.mode).toBe('human');
  });
});
