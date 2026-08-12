import { describe, it, expect } from 'vitest';
import { createIdempotencyCache } from '../../../src/idempotency/cache.js';

describe('idempotency cache', () => {
  it('records and recalls values', () => {
    const c = createIdempotencyCache({ ttlMs: 1000, now: () => 0 });
    expect(c.seen('k')).toBe(false);
    c.remember('k', { id: 1 });
    expect(c.seen('k')).toBe(true);
    expect(c.recall('k')).toEqual({ id: 1 });
  });

  it('expires entries past TTL', () => {
    let t = 0;
    const c = createIdempotencyCache({ ttlMs: 100, now: () => t });
    c.remember('k', 'v');
    t = 101;
    expect(c.seen('k')).toBe(false);
    expect(c.recall('k')).toBeUndefined();
  });
});
