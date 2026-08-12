export function createIdempotencyCache({ ttlMs = 24 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const store = new Map();

  function purge(key) {
    const entry = store.get(key);
    if (entry && entry.expiresAt <= now()) {
      store.delete(key);
      return true;
    }
    return false;
  }

  return {
    seen(key) {
      purge(key);
      return store.has(key);
    },
    remember(key, value) {
      store.set(key, { value, expiresAt: now() + ttlMs });
    },
    recall(key) {
      purge(key);
      return store.get(key)?.value;
    },
  };
}
