import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export class InvalidTransition extends Error {
  constructor(from, to, current) {
    super(`Cannot transition ${current} -> ${to} (expected ${from})`);
    this.name = 'InvalidTransition';
  }
}

export function createFileStore({ path }) {
  const locks = new Map();
  let cache = null;

  async function readAll() {
    if (cache) return cache;
    try {
      cache = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      cache = {};
    }
    return cache;
  }

  async function writeAll(data) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, path);
    cache = data;
  }

  async function withLock(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve();
    let release;
    const p = new Promise((r) => (release = r));
    locks.set(key, prev.then(() => p));
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (locks.get(key) === p) locks.delete(key);
    }
  }

  return {
    async get(sid) {
      const all = await readAll();
      return all[sid] ?? null;
    },
    async upsert(sid, mutator) {
      return withLock(sid, async () => {
        const all = await readAll();
        const now = new Date().toISOString();
        const prev = all[sid] ?? null;
        const next = {
          ...mutator(prev),
          conversationSid: sid,
          createdAt: prev?.createdAt ?? now,
          updatedAt: now,
        };
        all[sid] = next;
        await writeAll(all);
        return next;
      });
    },
    async transitionMode(sid, from, to, patch = {}) {
      const allowed = Array.isArray(from) ? from : [from];
      return withLock(sid, async () => {
        const all = await readAll();
        const prev = all[sid];
        if (!prev || !allowed.includes(prev.mode)) {
          throw new InvalidTransition(allowed.join('|'), to, prev?.mode ?? 'null');
        }
        const now = new Date().toISOString();
        const next = { ...prev, ...patch, mode: to, updatedAt: now };
        all[sid] = next;
        await writeAll(all);
        return next;
      });
    },
  };
}
