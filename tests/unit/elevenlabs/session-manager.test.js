import { describe, it, expect, vi } from 'vitest';
import { createSessionManager } from '../../../src/elevenlabs/session-manager.js';

function fakeSession() {
  return {
    _closed: false,
    open: vi.fn(async () => ({ elevenlabsConversationId: 'conv_1' })),
    sendUserMessage: vi.fn(),
    onAgentResponse: vi.fn(),
    onToolCall: vi.fn(),
    onClose: vi.fn(),
    close() { this._closed = true; },
  };
}

describe('session manager', () => {
  it('reuses a session for the same conversation', async () => {
    const factory = vi.fn(() => fakeSession());
    const mgr = createSessionManager({ sessionFactory: factory, idleTimeoutMs: 1000 });
    await mgr.getOrOpen({ conversationSid: 'CH1', dynamicVariables: {} });
    await mgr.getOrOpen({ conversationSid: 'CH1', dynamicVariables: {} });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('closes and removes a session', async () => {
    const s = fakeSession();
    const mgr = createSessionManager({ sessionFactory: () => s, idleTimeoutMs: 1000 });
    await mgr.getOrOpen({ conversationSid: 'CH1', dynamicVariables: {} });
    mgr.close('CH1');
    expect(s._closed).toBe(true);
    expect(mgr.size()).toBe(0);
  });

  it('closes idle sessions after the timeout', async () => {
    vi.useFakeTimers();
    const s = fakeSession();
    const mgr = createSessionManager({ sessionFactory: () => s, idleTimeoutMs: 500 });
    await mgr.getOrOpen({ conversationSid: 'CH1', dynamicVariables: {} });
    vi.advanceTimersByTime(600);
    expect(s._closed).toBe(true);
    vi.useRealTimers();
  });
});
