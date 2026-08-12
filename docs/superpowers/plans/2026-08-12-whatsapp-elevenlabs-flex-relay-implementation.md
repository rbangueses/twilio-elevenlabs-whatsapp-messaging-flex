# WhatsApp ElevenLabs Flex Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Node.js relay service described in `docs/superpowers/specs/2026-08-12-whatsapp-elevenlabs-flex-relay-design.md`: a two-way WhatsApp bridge where Twilio Conversations is source of truth, ElevenLabs Agent WebSocket handles bot turns, and Flex Interactions pick up the same Conversation on escalation.

**Architecture:** A small Express app owns four inbound routes (Twilio Conversation, Twilio message-status, ElevenLabs escalation, TaskRouter events) plus `/health`. Per-conversation state and idempotency live in a pluggable store (file-backed for local dev). An ElevenLabs session manager keeps one WebSocket per active `bot`-mode Conversation, closes it on mode change, and reopens on reconnect.

**Tech Stack:** Node.js 20+, Express 4, `twilio` SDK v5, `ws` v8 for the ElevenLabs WebSocket, `pino` for structured logging, `vitest` for tests, `supertest` for HTTP integration tests. Plain JavaScript with JSDoc; no TypeScript build step.

## Global Constraints

- Node.js `>=20.0.0` (native `fetch`, `AbortController`, `crypto.randomUUID`).
- Twilio Conversations webhooks are configured as **form-encoded** (default). Signature validation uses `twilio.validateRequest`. Do not switch to JSON without updating validation.
- Twilio Conversations `onMessageAdded` events with `Author` equal to `BOT_IDENTITY` MUST be ignored to prevent bot loops.
- Every operation is idempotent — Twilio and ElevenLabs both retry.
- Persist the `bot -> human_pending` mode change BEFORE calling the Flex Interactions API. This is a spec-level invariant.
- Never send customer messages to ElevenLabs when mode is `human_pending`, `human`, or `closed`.
- Bot participant identity defaults to `bot` and is configured via `BOT_IDENTITY`. Do not hardcode it.
- `HANDOFF_TOKEN` MUST be validated with a timing-safe comparison. Do not log the header or the token.
- All log lines include a correlation ID derived from `ConversationSid` when available.
- No feature flags, no backwards-compat shims — this is a new codebase.

---

## File Structure

```
/
  package.json
  vitest.config.js
  .env.example                          copy of examples/env.example plus new keys
  .gitignore
  src/
    server.js                           app entry, wires routes and middleware
    config.js                           env parsing + validation
    logger.js                           pino instance + correlation-id child helper
    state/
      file-store.js                     file-backed state store (default)
      store.js                          factory returning the configured store
    idempotency/
      cache.js                          in-memory TTL cache for dedup keys
    twilio/
      signature.js                      X-Twilio-Signature middleware
      address.js                        WhatsApp address helpers
      conversations.js                  bot participant + write message
    elevenlabs/
      handoff-id.js                     mint handoffId per Conversation
      session.js                        one WebSocket session lifecycle
      session-manager.js                pool of sessions keyed by conversationSid
    media/
      detect.js                         detect non-text media on inbound
    handoff/
      auth.js                           bearer-token middleware
      validate.js                       escalation payload schema
      flex.js                           Flex Interactions API client
      controller.js                     POST /webhooks/elevenlabs/escalate-to-flex
    taskrouter/
      event-handler.js                  mode transitions on TaskRouter events
    routes/
      health.js
      twilio-conversation.js
      twilio-message-status.js
      elevenlabs-escalate.js            thin wrapper around handoff/controller.js
      taskrouter-events.js
  tests/
    unit/                               mirrors src/
    integration/
      inbound-message.test.js
      escalation.test.js
      duplicates.test.js
      mode-transitions.test.js
```

Each `src/` file has one responsibility. Route files stay thin — orchestration logic lives in the domain modules they call.

---

## Task 1: Project scaffolding, `/health`, and the vitest harness

**Files:**
- Create: `package.json`
- Create: `vitest.config.js`
- Create: `.gitignore`
- Create: `.env.example` (root-level; leave `examples/env.example` for reference)
- Create: `src/server.js`
- Create: `src/routes/health.js`
- Create: `src/config.js` (skeleton — filled in Task 2)
- Test: `tests/unit/routes/health.test.js`

**Interfaces produced:**
- `createServer(config): express.Application` — factory used by tests and the entry point.
- `GET /health` returns `{ ok, service, hasTwilio, hasElevenLabs, hasFlex }`.

- [ ] **Step 1: Initialize package.json**

Create `package.json`:

```json
{
  "name": "twilio-elevenlabs-whatsapp-flex-relay",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "dev": "node --watch src/server.js",
    "start": "node src/server.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "express": "^4.19.2",
    "pino": "^9.0.0",
    "twilio": "^5.3.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "supertest": "^7.0.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Add config skeleton and `.env.example`**

Create `src/config.js`:

```js
export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 3000),
    nodeEnv: env.NODE_ENV ?? 'development',
    hasTwilio: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
    hasElevenLabs: Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID),
    hasFlex: Boolean(env.FLEX_WORKSPACE_SID && env.FLEX_WORKFLOW_SID),
  };
}
```

Create `.env.example` by copying `examples/env.example` and appending:

```
BOT_IDENTITY=bot
ELEVENLABS_IDLE_TIMEOUT_MS=900000
ESCALATE_ON_MEDIA=false
LOG_LEVEL=info
```

Create `.gitignore`:

```
node_modules
.data
.env
*.log
```

- [ ] **Step 3: Write the failing test**

Create `tests/unit/routes/health.test.js`:

```js
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createServer } from '../../../src/server.js';

describe('GET /health', () => {
  it('returns config presence flags', async () => {
    const app = createServer({
      hasTwilio: true,
      hasElevenLabs: true,
      hasFlex: false,
    });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      service: 'twilio-elevenlabs-whatsapp-flex-relay',
      hasTwilio: true,
      hasElevenLabs: true,
      hasFlex: false,
    });
  });
});
```

Create `vitest.config.js`:

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['tests/**/*.test.js'],
    testTimeout: 5000,
  },
});
```

- [ ] **Step 4: Install and confirm the test fails**

Run: `npm install`
Run: `npm test`
Expected: FAIL — cannot resolve `../../../src/server.js`.

- [ ] **Step 5: Implement `/health` and `createServer`**

Create `src/routes/health.js`:

```js
import { Router } from 'express';

export function healthRouter(config) {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'twilio-elevenlabs-whatsapp-flex-relay',
      hasTwilio: Boolean(config.hasTwilio),
      hasElevenLabs: Boolean(config.hasElevenLabs),
      hasFlex: Boolean(config.hasFlex),
    });
  });
  return router;
}
```

Create `src/server.js`:

```js
import express from 'express';
import { healthRouter } from './routes/health.js';
import { loadConfig } from './config.js';

export function createServer(config) {
  const app = express();
  app.use(healthRouter(config));
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = createServer(config);
  app.listen(config.port, () => {
    console.log(`relay listening on :${config.port}`);
  });
}
```

- [ ] **Step 6: Run test — expect PASS**

Run: `npm test`
Expected: 1 passed.

- [ ] **Step 7: Commit**

```bash
git add package.json vitest.config.js .gitignore .env.example src tests
git commit -m "feat: scaffold relay service with /health"
```

---

## Task 2: Config loader with validation

**Files:**
- Modify: `src/config.js`
- Test: `tests/unit/config.test.js`

**Interfaces consumed:** none.

**Interfaces produced:**
- `loadConfig(env)` returns a frozen object with these fields (all strings unless noted):
  - `port: number`, `nodeEnv`, `publicBaseUrl`
  - `twilio: { accountSid, authToken, conversationsServiceSid, whatsappSender }`
  - `flex: { workspaceSid, workflowSid, taskChannelUniqueName }`
  - `elevenlabs: { apiKey, agentId, wsUrl, idleTimeoutMs: number, escalateOnMedia: boolean }`
  - `handoffToken`
  - `botIdentity`
  - `stateStore: 'file'`, `stateFile`
  - `logLevel`
  - Presence flags: `hasTwilio`, `hasElevenLabs`, `hasFlex`
- Throws `ConfigError` on missing required keys when `nodeEnv !== 'development'`. In development, missing keys produce `hasX=false` flags but do not throw.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/config.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../../src/config.js';

const fullEnv = {
  NODE_ENV: 'production',
  PORT: '4000',
  PUBLIC_BASE_URL: 'https://example.ngrok-free.app',
  TWILIO_ACCOUNT_SID: 'ACxxx',
  TWILIO_AUTH_TOKEN: 'tok',
  TWILIO_CONVERSATIONS_SERVICE_SID: 'ISxxx',
  TWILIO_WHATSAPP_SENDER: 'whatsapp:+14155238886',
  FLEX_WORKSPACE_SID: 'WSxxx',
  FLEX_WORKFLOW_SID: 'WWxxx',
  FLEX_TASK_CHANNEL_UNIQUE_NAME: 'chat',
  ELEVENLABS_API_KEY: 'xi',
  ELEVENLABS_AGENT_ID: 'agent',
  ELEVENLABS_WS_URL: 'wss://api.elevenlabs.io/v1/convai/conversation',
  HANDOFF_TOKEN: 'secret',
  BOT_IDENTITY: 'bot',
  ELEVENLABS_IDLE_TIMEOUT_MS: '600000',
  ESCALATE_ON_MEDIA: 'true',
  STATE_STORE: 'file',
  STATE_FILE: '.data/state.json',
  LOG_LEVEL: 'debug',
};

describe('loadConfig', () => {
  it('parses a fully populated environment', () => {
    const cfg = loadConfig(fullEnv);
    expect(cfg.port).toBe(4000);
    expect(cfg.twilio.accountSid).toBe('ACxxx');
    expect(cfg.flex.workflowSid).toBe('WWxxx');
    expect(cfg.elevenlabs.idleTimeoutMs).toBe(600000);
    expect(cfg.elevenlabs.escalateOnMedia).toBe(true);
    expect(cfg.hasTwilio).toBe(true);
    expect(cfg.hasElevenLabs).toBe(true);
    expect(cfg.hasFlex).toBe(true);
  });

  it('throws in non-development when required keys are missing', () => {
    const partial = { ...fullEnv, TWILIO_AUTH_TOKEN: '' };
    expect(() => loadConfig(partial)).toThrow(ConfigError);
  });

  it('does not throw in development when keys are missing, but reports presence flags', () => {
    const cfg = loadConfig({ NODE_ENV: 'development' });
    expect(cfg.hasTwilio).toBe(false);
    expect(cfg.hasElevenLabs).toBe(false);
    expect(cfg.hasFlex).toBe(false);
    expect(cfg.botIdentity).toBe('bot');
    expect(cfg.elevenlabs.idleTimeoutMs).toBe(900000);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm test -- config`
Expected: FAIL — `ConfigError` is not exported.

- [ ] **Step 3: Implement config**

Replace `src/config.js`:

```js
export class ConfigError extends Error {
  constructor(missing) {
    super(`Missing required config keys: ${missing.join(', ')}`);
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

const REQUIRED = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_CONVERSATIONS_SERVICE_SID',
  'TWILIO_WHATSAPP_SENDER',
  'FLEX_WORKSPACE_SID',
  'FLEX_WORKFLOW_SID',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_AGENT_ID',
  'ELEVENLABS_WS_URL',
  'HANDOFF_TOKEN',
];

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0 && nodeEnv !== 'development') {
    throw new ConfigError(missing);
  }

  const cfg = {
    port: Number(env.PORT ?? 3000),
    nodeEnv,
    publicBaseUrl: env.PUBLIC_BASE_URL ?? '',
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID ?? '',
      authToken: env.TWILIO_AUTH_TOKEN ?? '',
      conversationsServiceSid: env.TWILIO_CONVERSATIONS_SERVICE_SID ?? '',
      whatsappSender: env.TWILIO_WHATSAPP_SENDER ?? '',
    },
    flex: {
      workspaceSid: env.FLEX_WORKSPACE_SID ?? '',
      workflowSid: env.FLEX_WORKFLOW_SID ?? '',
      taskChannelUniqueName: env.FLEX_TASK_CHANNEL_UNIQUE_NAME ?? 'chat',
    },
    elevenlabs: {
      apiKey: env.ELEVENLABS_API_KEY ?? '',
      agentId: env.ELEVENLABS_AGENT_ID ?? '',
      wsUrl: env.ELEVENLABS_WS_URL ?? 'wss://api.elevenlabs.io/v1/convai/conversation',
      idleTimeoutMs: Number(env.ELEVENLABS_IDLE_TIMEOUT_MS ?? 900000),
      escalateOnMedia: env.ESCALATE_ON_MEDIA === 'true',
    },
    handoffToken: env.HANDOFF_TOKEN ?? '',
    botIdentity: env.BOT_IDENTITY ?? 'bot',
    stateStore: env.STATE_STORE ?? 'file',
    stateFile: env.STATE_FILE ?? '.data/conversation-state.json',
    logLevel: env.LOG_LEVEL ?? 'info',
  };

  cfg.hasTwilio = Boolean(cfg.twilio.accountSid && cfg.twilio.authToken);
  cfg.hasElevenLabs = Boolean(cfg.elevenlabs.apiKey && cfg.elevenlabs.agentId);
  cfg.hasFlex = Boolean(cfg.flex.workspaceSid && cfg.flex.workflowSid);

  return Object.freeze(cfg);
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/config.js tests/unit/config.test.js
git commit -m "feat: config loader with dev/prod validation"
```

---

## Task 3: File-backed state store with atomic mode transitions

**Files:**
- Create: `src/state/file-store.js`
- Create: `src/state/store.js`
- Test: `tests/unit/state/file-store.test.js`

**Interfaces consumed:** none.

**Interfaces produced:**
- `createFileStore({ path }): Store` — an object with these async methods:
  - `get(conversationSid): Promise<State | null>`
  - `upsert(conversationSid, mutator: (prev|null) => State): Promise<State>` — reads, applies mutator, writes atomically. Mutator is called under a per-key lock.
  - `transitionMode(conversationSid, from: Mode | Mode[], to: Mode, patch?: Partial<State>): Promise<State>` — throws `InvalidTransition` if the current mode isn't in `from`.
- `State` shape:
  ```
  {
    conversationSid, customerAddress, businessAddress,
    mode: 'bot' | 'human_pending' | 'human' | 'closed',
    elevenlabsConversationId, elevenlabsSessionStatus,
    handoffId, flexInteractionSid, taskSid,
    lastInboundMessageSid, lastCustomerMessageAt,
    createdAt, updatedAt
  }
  ```
- `createStore(config): Store` in `src/state/store.js` — factory that returns the file store for `stateStore === 'file'`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/state/file-store.test.js`:

```js
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
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm test -- file-store`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement the file store**

Create `src/state/file-store.js`:

```js
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
```

Create `src/state/store.js`:

```js
import { createFileStore } from './file-store.js';

export function createStore(config) {
  if (config.stateStore !== 'file') {
    throw new Error(`Unsupported STATE_STORE: ${config.stateStore}`);
  }
  return createFileStore({ path: config.stateFile });
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/state tests/unit/state
git commit -m "feat: file-backed state store with atomic mode transitions"
```

---

## Task 4: Idempotency cache

**Files:**
- Create: `src/idempotency/cache.js`
- Test: `tests/unit/idempotency/cache.test.js`

**Interfaces produced:**
- `createIdempotencyCache({ ttlMs = 24*60*60*1000, now? }): { seen(key): boolean; remember(key, value): void; recall(key): value | undefined }`
- `seen(key)` returns true if `key` was remembered within TTL.
- `remember(key, value)` stores the value under `key`.
- `recall(key)` returns the stored value (used by escalation dedup to return the existing `flexInteractionSid`).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/idempotency/cache.test.js`:

```js
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
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm test -- cache`

- [ ] **Step 3: Implement**

Create `src/idempotency/cache.js`:

```js
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
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add src/idempotency tests/unit/idempotency
git commit -m "feat: in-memory idempotency cache with TTL"
```

---

## Task 5: WhatsApp address normalization + Twilio signature middleware

**Files:**
- Create: `src/twilio/address.js`
- Create: `src/twilio/signature.js`
- Test: `tests/unit/twilio/address.test.js`
- Test: `tests/unit/twilio/signature.test.js`

**Interfaces produced:**
- `normalizeAddress(addr): string` — trims, lowercases scheme, keeps `whatsapp:+E164` format. Throws on missing `whatsapp:` prefix.
- `verifyTwilioSignature({ authToken }): express middleware` — validates `X-Twilio-Signature` using `twilio.validateRequest` against `req.originalUrl` and the parsed form body. On mismatch, responds `403`.

- [ ] **Step 1: Write the address test**

Create `tests/unit/twilio/address.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { normalizeAddress } from '../../../src/twilio/address.js';

describe('normalizeAddress', () => {
  it('normalizes valid whatsapp addresses', () => {
    expect(normalizeAddress('WhatsApp:+15551234567')).toBe('whatsapp:+15551234567');
    expect(normalizeAddress(' whatsapp:+15551234567 ')).toBe('whatsapp:+15551234567');
  });

  it('rejects addresses missing the whatsapp scheme', () => {
    expect(() => normalizeAddress('+15551234567')).toThrow();
    expect(() => normalizeAddress('sms:+15551234567')).toThrow();
  });
});
```

- [ ] **Step 2: Implement `normalizeAddress`**

Create `src/twilio/address.js`:

```js
export function normalizeAddress(input) {
  if (typeof input !== 'string') {
    throw new Error(`Address must be a string, got ${typeof input}`);
  }
  const trimmed = input.trim();
  const match = /^whatsapp:(\+\d{7,15})$/i.exec(trimmed);
  if (!match) {
    throw new Error(`Not a WhatsApp address: ${input}`);
  }
  return `whatsapp:${match[1]}`;
}
```

- [ ] **Step 3: Write the signature test**

Create `tests/unit/twilio/signature.test.js`:

```js
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { verifyTwilioSignature } from '../../../src/twilio/signature.js';

const authToken = 'test-token';

function buildApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.post(
    '/webhooks/twilio/conversation',
    verifyTwilioSignature({ authToken }),
    (_req, res) => res.status(200).send('ok'),
  );
  return app;
}

function sign(url, body) {
  return twilio.getExpectedTwilioSignature(authToken, url, body);
}

describe('verifyTwilioSignature', () => {
  it('accepts a correctly signed form-encoded request', async () => {
    const app = buildApp();
    const body = { ConversationSid: 'CH1', Body: 'hi' };
    const url = 'http://127.0.0.1/webhooks/twilio/conversation';
    const sig = sign(url, body);
    const res = await request(app)
      .post('/webhooks/twilio/conversation')
      .set('Host', '127.0.0.1')
      .set('X-Forwarded-Proto', 'http')
      .set('X-Twilio-Signature', sig)
      .type('form')
      .send(body);
    expect(res.status).toBe(200);
  });

  it('rejects an unsigned or wrongly signed request', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/webhooks/twilio/conversation')
      .set('X-Twilio-Signature', 'not-a-valid-signature')
      .type('form')
      .send({ ConversationSid: 'CH1' });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 4: Run — expect FAIL**

Run: `npm test -- signature`

- [ ] **Step 5: Implement middleware**

Create `src/twilio/signature.js`:

```js
import twilio from 'twilio';

export function verifyTwilioSignature({ authToken }) {
  return function (req, res, next) {
    const sig = req.get('X-Twilio-Signature') ?? '';
    const proto = req.get('X-Forwarded-Proto') ?? req.protocol;
    const host = req.get('X-Forwarded-Host') ?? req.get('Host');
    const url = `${proto}://${host}${req.originalUrl}`;
    const ok = twilio.validateRequest(authToken, sig, url, req.body ?? {});
    if (!ok) {
      res.status(403).json({ error: 'invalid_twilio_signature' });
      return;
    }
    next();
  };
}
```

- [ ] **Step 6: Run — expect PASS**

Run: `npm test`

- [ ] **Step 7: Commit**

```bash
git add src/twilio tests/unit/twilio
git commit -m "feat: address normalization and Twilio signature middleware"
```

---

## Task 6: Twilio Conversations client (bot participant + write message)

**Files:**
- Create: `src/twilio/conversations.js`
- Test: `tests/unit/twilio/conversations.test.js`

**Interfaces consumed:**
- `twilio` SDK v5.

**Interfaces produced:**
- `createConversationsClient({ twilioClient, botIdentity }): { ensureBotParticipant(conversationSid), writeBotMessage({ conversationSid, body, correlationId }) }`
- `ensureBotParticipant` is idempotent — swallows the SDK's `Participant already exists` (HTTP 409, code 50433) error.
- `writeBotMessage` returns the created Twilio Message SID and always sets `Author = botIdentity` and an `X-Twilio-Webhook-Enabled=true` attribute is NOT set (avoid re-triggering our own webhook).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/twilio/conversations.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { createConversationsClient } from '../../../src/twilio/conversations.js';

function mockTwilio({ participantsCreate, messagesCreate }) {
  return {
    conversations: {
      v1: {
        conversations: (sid) => ({
          participants: { create: participantsCreate },
          messages: { create: messagesCreate },
          _sid: sid,
        }),
      },
    },
  };
}

describe('conversations client', () => {
  it('ensures the bot participant once and swallows 409', async () => {
    const err = Object.assign(new Error('exists'), { status: 409, code: 50433 });
    const participantsCreate = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ sid: 'MB1' });
    const client = createConversationsClient({
      twilioClient: mockTwilio({ participantsCreate, messagesCreate: vi.fn() }),
      botIdentity: 'bot',
    });

    await client.ensureBotParticipant('CH1');
    await client.ensureBotParticipant('CH2');
    expect(participantsCreate).toHaveBeenCalledTimes(2);
    expect(participantsCreate.mock.calls[0][0]).toEqual({ identity: 'bot' });
  });

  it('writes a bot message with the bot identity as author', async () => {
    const messagesCreate = vi.fn().mockResolvedValue({ sid: 'IM1' });
    const client = createConversationsClient({
      twilioClient: mockTwilio({
        participantsCreate: vi.fn().mockResolvedValue({}),
        messagesCreate,
      }),
      botIdentity: 'bot',
    });

    const sid = await client.writeBotMessage({
      conversationSid: 'CH1',
      body: 'hello',
      correlationId: 'c1',
    });

    expect(sid).toBe('IM1');
    expect(messagesCreate).toHaveBeenCalledWith({
      author: 'bot',
      body: 'hello',
    });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm test -- conversations`

- [ ] **Step 3: Implement**

Create `src/twilio/conversations.js`:

```js
const PARTICIPANT_EXISTS = new Set([50433, 50438]);

export function createConversationsClient({ twilioClient, botIdentity }) {
  function conv(sid) {
    return twilioClient.conversations.v1.conversations(sid);
  }

  return {
    async ensureBotParticipant(conversationSid) {
      try {
        await conv(conversationSid).participants.create({ identity: botIdentity });
      } catch (err) {
        if (err.status === 409 || PARTICIPANT_EXISTS.has(err.code)) return;
        throw err;
      }
    },

    async writeBotMessage({ conversationSid, body }) {
      const message = await conv(conversationSid).messages.create({
        author: botIdentity,
        body,
      });
      return message.sid;
    },
  };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add src/twilio/conversations.js tests/unit/twilio/conversations.test.js
git commit -m "feat: Twilio Conversations client for bot participant and messages"
```

---

## Task 7: `handoffId` generator + ElevenLabs session

**Files:**
- Create: `src/elevenlabs/handoff-id.js`
- Create: `src/elevenlabs/session.js`
- Test: `tests/unit/elevenlabs/handoff-id.test.js`
- Test: `tests/unit/elevenlabs/session.test.js`

**Interfaces produced:**
- `mintHandoffId(conversationSid, now = Date.now()): string` — returns `handoff_<conversationSid>_<epoch_ms>`.
- `createSession({ url, apiKey, agentId, wsFactory }): Session` where `Session` has:
  - `open(dynamicVariables): Promise<{ elevenlabsConversationId }>`
  - `sendUserMessage(text): void`
  - `onAgentResponse(handler)` — subscribe.
  - `onToolCall(handler)` — subscribe.
  - `close(): void`
- `wsFactory(url, opts)` returns a WebSocket-compatible object; injected for testability.

- [ ] **Step 1: handoff-id test**

Create `tests/unit/elevenlabs/handoff-id.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { mintHandoffId } from '../../../src/elevenlabs/handoff-id.js';

describe('mintHandoffId', () => {
  it('formats handoff_<sid>_<epoch>', () => {
    expect(mintHandoffId('CHabc', 1700000000000)).toBe('handoff_CHabc_1700000000000');
  });
});
```

- [ ] **Step 2: Implement `mintHandoffId`**

Create `src/elevenlabs/handoff-id.js`:

```js
export function mintHandoffId(conversationSid, now = Date.now()) {
  return `handoff_${conversationSid}_${now}`;
}
```

- [ ] **Step 3: Write session test with a fake WebSocket**

Create `tests/unit/elevenlabs/session.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSession } from '../../../src/elevenlabs/session.js';

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
  }
  send(msg) { this.sent.push(msg); }
  close() { this.emit('close'); }
  simulateOpen() { this.readyState = 1; this.emit('open'); }
  simulateMessage(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}

describe('elevenlabs session', () => {
  it('sends conversation_initiation_client_data on open and resolves with conversation id', async () => {
    const ws = new FakeWs();
    const session = createSession({
      url: 'wss://example',
      apiKey: 'xi',
      agentId: 'a1',
      wsFactory: () => ws,
    });

    const openPromise = session.open({ twilioConversationSid: 'CH1' });
    ws.simulateOpen();
    ws.simulateMessage({ type: 'conversation_initiation_metadata', conversation_id: 'conv_1' });

    const result = await openPromise;
    expect(result.elevenlabsConversationId).toBe('conv_1');

    const init = JSON.parse(ws.sent[0]);
    expect(init.type).toBe('conversation_initiation_client_data');
    expect(init.dynamic_variables.twilioConversationSid).toBe('CH1');
  });

  it('routes agent_response and tool_call events to subscribers', async () => {
    const ws = new FakeWs();
    const session = createSession({
      url: 'wss://example', apiKey: 'xi', agentId: 'a1', wsFactory: () => ws,
    });
    const openPromise = session.open({});
    ws.simulateOpen();
    ws.simulateMessage({ type: 'conversation_initiation_metadata', conversation_id: 'conv_1' });
    await openPromise;

    const responses = [];
    const tools = [];
    session.onAgentResponse((r) => responses.push(r));
    session.onToolCall((t) => tools.push(t));

    ws.simulateMessage({ type: 'agent_response', agent_response_event: { agent_response: 'hi' } });
    ws.simulateMessage({ type: 'client_tool_call', client_tool_call: { tool_name: 'escalate_to_flex', tool_call_id: 't1', parameters: {} } });

    expect(responses).toEqual(['hi']);
    expect(tools[0].tool_name).toBe('escalate_to_flex');
  });

  it('replies to ping frames with pong', async () => {
    const ws = new FakeWs();
    const session = createSession({
      url: 'wss://example', apiKey: 'xi', agentId: 'a1', wsFactory: () => ws,
    });
    const openPromise = session.open({});
    ws.simulateOpen();
    ws.simulateMessage({ type: 'conversation_initiation_metadata', conversation_id: 'conv_1' });
    await openPromise;
    ws.sent.length = 0;

    ws.simulateMessage({ type: 'ping', ping_event: { event_id: 42 } });
    const reply = JSON.parse(ws.sent[0]);
    expect(reply).toEqual({ type: 'pong', event_id: 42 });
  });
});
```

- [ ] **Step 4: Run — expect FAIL**

Run: `npm test -- elevenlabs`

- [ ] **Step 5: Implement session**

Create `src/elevenlabs/session.js`:

```js
export function createSession({ url, apiKey, agentId, wsFactory }) {
  const listeners = { agentResponse: [], toolCall: [], close: [] };
  let ws = null;
  let elevenlabsConversationId = null;

  function emit(kind, payload) {
    for (const l of listeners[kind]) l(payload);
  }

  return {
    open(dynamicVariables = {}) {
      const target = `${url}?agent_id=${encodeURIComponent(agentId)}`;
      ws = wsFactory(target, { headers: { 'xi-api-key': apiKey } });

      return new Promise((resolve, reject) => {
        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              type: 'conversation_initiation_client_data',
              dynamic_variables: dynamicVariables,
            }),
          );
        });

        ws.on('message', (raw) => {
          let msg;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }
          switch (msg.type) {
            case 'conversation_initiation_metadata':
              elevenlabsConversationId = msg.conversation_id;
              resolve({ elevenlabsConversationId });
              return;
            case 'ping':
              ws.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event.event_id }));
              return;
            case 'agent_response':
              emit('agentResponse', msg.agent_response_event.agent_response);
              return;
            case 'client_tool_call':
              emit('toolCall', msg.client_tool_call);
              return;
          }
        });

        ws.on('close', () => emit('close'));
        ws.on('error', (err) => reject(err));
      });
    },

    sendUserMessage(text) {
      if (!ws) throw new Error('session not open');
      ws.send(JSON.stringify({ type: 'user_message', text }));
    },

    onAgentResponse(fn) { listeners.agentResponse.push(fn); },
    onToolCall(fn) { listeners.toolCall.push(fn); },
    onClose(fn) { listeners.close.push(fn); },
    close() { ws?.close(); },
    get conversationId() { return elevenlabsConversationId; },
  };
}
```

- [ ] **Step 6: Run — expect PASS**

Run: `npm test`

- [ ] **Step 7: Commit**

```bash
git add src/elevenlabs tests/unit/elevenlabs
git commit -m "feat: ElevenLabs WebSocket session with agent_response and tool_call routing"
```

---

## Task 8: ElevenLabs session manager

**Files:**
- Create: `src/elevenlabs/session-manager.js`
- Test: `tests/unit/elevenlabs/session-manager.test.js`

**Interfaces produced:**
- `createSessionManager({ sessionFactory, idleTimeoutMs, timerFactory? }): Manager`
- `manager.getOrOpen({ conversationSid, dynamicVariables }): Promise<Session>` — returns an existing session or opens a new one via `sessionFactory({ conversationSid })`.
- `manager.close(conversationSid): void` — closes and removes the session immediately (called on mode change and escalation).
- `manager.size(): number` — visible for tests.
- Idle sessions closed automatically after `idleTimeoutMs` of inactivity. `sendUserMessage` on a managed session resets the idle timer.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/elevenlabs/session-manager.test.js`:

```js
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
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm test -- session-manager`

- [ ] **Step 3: Implement**

Create `src/elevenlabs/session-manager.js`:

```js
export function createSessionManager({ sessionFactory, idleTimeoutMs }) {
  const sessions = new Map();
  const timers = new Map();

  function armIdleTimer(sid) {
    clearTimeout(timers.get(sid));
    const t = setTimeout(() => {
      const s = sessions.get(sid);
      if (s) {
        s.close();
        sessions.delete(sid);
      }
      timers.delete(sid);
    }, idleTimeoutMs);
    timers.set(sid, t);
  }

  return {
    async getOrOpen({ conversationSid, dynamicVariables }) {
      let session = sessions.get(conversationSid);
      if (session) {
        armIdleTimer(conversationSid);
        return session;
      }
      session = sessionFactory({ conversationSid });
      await session.open(dynamicVariables);
      const wrappedSend = session.sendUserMessage.bind(session);
      session.sendUserMessage = (text) => {
        armIdleTimer(conversationSid);
        wrappedSend(text);
      };
      sessions.set(conversationSid, session);
      armIdleTimer(conversationSid);
      return session;
    },

    close(conversationSid) {
      const s = sessions.get(conversationSid);
      if (s) {
        s.close();
        sessions.delete(conversationSid);
      }
      clearTimeout(timers.get(conversationSid));
      timers.delete(conversationSid);
    },

    size() { return sessions.size; },
  };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add src/elevenlabs/session-manager.js tests/unit/elevenlabs/session-manager.test.js
git commit -m "feat: ElevenLabs session manager with idle timeout"
```

---

## Task 9: Media detection + Twilio conversation webhook route

**Files:**
- Create: `src/media/detect.js`
- Create: `src/routes/twilio-conversation.js`
- Test: `tests/unit/media/detect.test.js`
- Test: `tests/integration/inbound-message.test.js`
- Modify: `src/server.js` (wire the route)

**Interfaces consumed:**
- `store` from Task 3, `cache` from Task 4, `conversationsClient` from Task 6, `sessionManager` from Task 8, `mintHandoffId` from Task 7.

**Interfaces produced:**
- `detectMedia(webhookBody): { hasMedia: boolean, count: number }` — looks at `Media` field on the Conversations `onMessageAdded` payload.
- `createConversationRoute({ store, cache, conversationsClient, sessionManager, config, logger }): express.Router` — POST `/webhooks/twilio/conversation`.

Behavior:
1. Ignore events where `EventType !== 'onMessageAdded'`.
2. Ignore messages where `Author === config.botIdentity`.
3. Dedup on `MessageSid`.
4. Load or create state; if state is not in `bot` mode, log and return 200 without relaying.
5. If message has non-text media and `escalateOnMedia === false`: reply with a fallback message and return.
6. Ensure the bot participant, open/reuse the ElevenLabs session, send `user_message`, wait for the next `agent_response`, write it as a bot message, return 200.

- [ ] **Step 1: Media detection test**

Create `tests/unit/media/detect.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { detectMedia } from '../../../src/media/detect.js';

describe('detectMedia', () => {
  it('returns hasMedia=false for a plain text body', () => {
    expect(detectMedia({ Body: 'hi' })).toEqual({ hasMedia: false, count: 0 });
  });

  it('parses Media as a JSON array', () => {
    const body = { Media: JSON.stringify([{ Sid: 'MEabc' }]) };
    expect(detectMedia(body)).toEqual({ hasMedia: true, count: 1 });
  });
});
```

- [ ] **Step 2: Implement `detectMedia`**

Create `src/media/detect.js`:

```js
export function detectMedia(webhookBody) {
  const raw = webhookBody?.Media;
  if (!raw) return { hasMedia: false, count: 0 };
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const arr = Array.isArray(parsed) ? parsed : [];
    return { hasMedia: arr.length > 0, count: arr.length };
  } catch {
    return { hasMedia: true, count: 1 };
  }
}
```

- [ ] **Step 3: Write the integration test**

Create `tests/integration/inbound-message.test.js`:

```js
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
```

- [ ] **Step 4: Implement the route**

Create `src/routes/twilio-conversation.js`:

```js
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { verifyTwilioSignature } from '../twilio/signature.js';
import { detectMedia } from '../media/detect.js';
import { mintHandoffId } from '../elevenlabs/handoff-id.js';

const MEDIA_FALLBACK =
  'I can only read text on WhatsApp right now — please describe your request in text and I will help.';
const AGENT_RESPONSE_TIMEOUT_MS = 20_000;

export function createConversationRoute({
  store,
  cache,
  conversationsClient,
  sessionManager,
  config,
  logger,
  skipSignatureVerification = false,
}) {
  const router = Router();
  const middlewares = [];
  if (!skipSignatureVerification) {
    middlewares.push(verifyTwilioSignature({ authToken: config.twilio?.authToken ?? '' }));
  }

  router.post('/webhooks/twilio/conversation', ...middlewares, async (req, res) => {
    const body = req.body ?? {};
    if (body.EventType !== 'onMessageAdded') return res.status(200).end();
    if (body.Author === config.botIdentity) return res.status(200).end();

    const conversationSid = body.ConversationSid;
    const messageSid = body.MessageSid;
    if (!conversationSid || !messageSid) return res.status(400).end();

    const correlationId = randomUUID();
    const log = logger.child({ correlationId, conversationSid, messageSid });

    const key = `twilio:msg:${messageSid}`;
    if (cache.seen(key)) {
      log.info('duplicate_message_ignored');
      return res.status(200).end();
    }
    cache.remember(key, true);

    const state = await store.upsert(conversationSid, (prev) => ({
      conversationSid,
      customerAddress: body.Author,
      businessAddress: body.ProxyAddress ?? prev?.businessAddress ?? '',
      mode: prev?.mode ?? 'bot',
      elevenlabsConversationId: prev?.elevenlabsConversationId ?? null,
      elevenlabsSessionStatus: prev?.elevenlabsSessionStatus ?? 'idle',
      handoffId: prev?.handoffId ?? mintHandoffId(conversationSid),
      flexInteractionSid: prev?.flexInteractionSid ?? null,
      taskSid: prev?.taskSid ?? null,
      lastInboundMessageSid: messageSid,
      lastCustomerMessageAt: new Date().toISOString(),
    }));

    if (state.mode !== 'bot') {
      log.info({ mode: state.mode }, 'not_in_bot_mode');
      return res.status(200).end();
    }

    const media = detectMedia(body);
    if (media.hasMedia && !config.elevenlabs?.escalateOnMedia) {
      await conversationsClient.ensureBotParticipant(conversationSid);
      await conversationsClient.writeBotMessage({ conversationSid, body: MEDIA_FALLBACK, correlationId });
      return res.status(200).end();
    }

    try {
      await conversationsClient.ensureBotParticipant(conversationSid);
      const session = await sessionManager.getOrOpen({
        conversationSid,
        dynamicVariables: {
          twilioConversationSid: conversationSid,
          customerAddress: state.customerAddress,
          businessAddress: state.businessAddress,
          handoffId: state.handoffId,
        },
      });

      const agentReply = await waitForAgentResponse(session, AGENT_RESPONSE_TIMEOUT_MS);
      session.sendUserMessage(body.Body ?? '');
      const reply = await agentReply;
      await conversationsClient.writeBotMessage({ conversationSid, body: reply, correlationId });
      res.status(200).end();
    } catch (err) {
      log.error({ err }, 'bot_reply_failed');
      await conversationsClient
        .writeBotMessage({
          conversationSid,
          body: "I'm having trouble responding right now. Please try again in a moment.",
          correlationId,
        })
        .catch(() => {});
      res.status(200).end();
    }
  });

  return router;
}

function waitForAgentResponse(session, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('agent_response_timeout')), timeoutMs);
    session.onAgentResponse((text) => {
      clearTimeout(timer);
      resolve(text);
    });
  });
}
```

Wire it in `src/server.js`:

```js
import express from 'express';
import { healthRouter } from './routes/health.js';
import { createConversationRoute } from './routes/twilio-conversation.js';
import { loadConfig } from './config.js';

export function createServer(config, deps = {}) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(healthRouter(config));

  if (deps.store && deps.cache && deps.conversationsClient && deps.sessionManager && deps.logger) {
    app.use(
      createConversationRoute({
        store: deps.store,
        cache: deps.cache,
        conversationsClient: deps.conversationsClient,
        sessionManager: deps.sessionManager,
        config,
        logger: deps.logger,
      }),
    );
  }

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = createServer(config);
  app.listen(config.port, () => console.log(`relay listening on :${config.port}`));
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/media src/routes/twilio-conversation.js src/server.js tests/unit/media tests/integration/inbound-message.test.js
git commit -m "feat: inbound Twilio conversation webhook with ElevenLabs relay and media fallback"
```

---

## Task 10: Message-status webhook

**Files:**
- Create: `src/routes/twilio-message-status.js`
- Test: `tests/unit/routes/twilio-message-status.test.js`
- Modify: `src/server.js` (wire the route)

**Interfaces consumed:** `store`, `cache`, `logger`.

**Interfaces produced:**
- `createMessageStatusRoute({ store, cache, config, logger }): Router` — POST `/webhooks/twilio/message-status`. Validates Twilio signature, dedups on `MessageSid + MessageStatus`, records `{ status, updatedAt }` under `state.deliveryStatuses[MessageSid]`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/routes/twilio-message-status.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore } from '../../../src/state/file-store.js';
import { createIdempotencyCache } from '../../../src/idempotency/cache.js';
import { createMessageStatusRoute } from '../../../src/routes/twilio-message-status.js';

let dir, store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ms-'));
  store = createFileStore({ path: join(dir, 'state.json') });
  await store.upsert('CH1', () => ({ conversationSid: 'CH1', mode: 'bot' }));
  return () => rm(dir, { recursive: true, force: true });
});

describe('POST /webhooks/twilio/message-status', () => {
  it('records the status against the conversation state', async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(
      createMessageStatusRoute({
        store,
        cache: createIdempotencyCache(),
        config: {},
        logger: { info() {}, warn() {}, error() {}, child: () => ({ info() {}, warn() {}, error() {} }) },
        skipSignatureVerification: true,
      }),
    );

    const res = await request(app)
      .post('/webhooks/twilio/message-status')
      .type('form')
      .send({ MessageSid: 'IM1', MessageStatus: 'delivered', ConversationSid: 'CH1' });

    expect(res.status).toBe(200);
    const s = await store.get('CH1');
    expect(s.deliveryStatuses.IM1.status).toBe('delivered');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm test -- message-status`

- [ ] **Step 3: Implement**

Create `src/routes/twilio-message-status.js`:

```js
import { Router } from 'express';
import { verifyTwilioSignature } from '../twilio/signature.js';

export function createMessageStatusRoute({
  store,
  cache,
  config,
  logger,
  skipSignatureVerification = false,
}) {
  const router = Router();
  const middlewares = [];
  if (!skipSignatureVerification) {
    middlewares.push(verifyTwilioSignature({ authToken: config.twilio?.authToken ?? '' }));
  }

  router.post('/webhooks/twilio/message-status', ...middlewares, async (req, res) => {
    const { MessageSid, MessageStatus, ConversationSid } = req.body ?? {};
    if (!MessageSid || !MessageStatus || !ConversationSid) return res.status(400).end();

    const key = `twilio:status:${MessageSid}:${MessageStatus}`;
    if (cache.seen(key)) return res.status(200).end();
    cache.remember(key, true);

    await store.upsert(ConversationSid, (prev) => ({
      ...(prev ?? { conversationSid: ConversationSid, mode: 'bot' }),
      deliveryStatuses: {
        ...(prev?.deliveryStatuses ?? {}),
        [MessageSid]: { status: MessageStatus, updatedAt: new Date().toISOString() },
      },
    }));

    res.status(200).end();
  });

  return router;
}
```

Wire it in `src/server.js` alongside the conversation route.

- [ ] **Step 4: Run — expect PASS**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add src/routes/twilio-message-status.js src/server.js tests/unit/routes/twilio-message-status.test.js
git commit -m "feat: message-status webhook records delivery state"
```

---

## Task 11: Bearer auth middleware + escalation payload validator

**Files:**
- Create: `src/handoff/auth.js`
- Create: `src/handoff/validate.js`
- Test: `tests/unit/handoff/auth.test.js`
- Test: `tests/unit/handoff/validate.test.js`

**Interfaces produced:**
- `bearerAuth({ token }): middleware` — checks `Authorization: Bearer <token>` with `crypto.timingSafeEqual`. Rejects with `401` on mismatch. Does not log the token.
- `validateEscalationPayload(body): { ok: true, value } | { ok: false, error }` where required fields (`conversationSid`, `handoffId`, `customerAddress`, `businessAddress`, `intent`, `reason`, `summary`) are all non-empty strings, `conversationSid` starts with `CH`, addresses start with `whatsapp:`, `summary` <= 500 chars, `intent`/`reason` <= 64 chars. `priority` and `elevenlabsConversationId` are optional.

- [ ] **Step 1: Write auth test**

Create `tests/unit/handoff/auth.test.js`:

```js
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { bearerAuth } from '../../../src/handoff/auth.js';

function buildApp() {
  const app = express();
  app.post('/x', bearerAuth({ token: 'secret' }), (_req, res) => res.status(204).end());
  return app;
}

describe('bearerAuth', () => {
  it('accepts a matching bearer token', async () => {
    const res = await request(buildApp()).post('/x').set('Authorization', 'Bearer secret');
    expect(res.status).toBe(204);
  });
  it('rejects a missing or wrong bearer token', async () => {
    const res = await request(buildApp()).post('/x');
    expect(res.status).toBe(401);
    const wrong = await request(buildApp()).post('/x').set('Authorization', 'Bearer nope');
    expect(wrong.status).toBe(401);
  });
});
```

- [ ] **Step 2: Implement auth**

Create `src/handoff/auth.js`:

```js
import { timingSafeEqual } from 'node:crypto';

export function bearerAuth({ token }) {
  const expected = Buffer.from(token ?? '');
  return function (req, res, next) {
    const header = req.get('Authorization') ?? '';
    const prefix = 'Bearer ';
    if (!header.startsWith(prefix)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const provided = Buffer.from(header.slice(prefix.length));
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}
```

- [ ] **Step 3: Write validator test**

Create `tests/unit/handoff/validate.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { validateEscalationPayload } from '../../../src/handoff/validate.js';

const good = {
  conversationSid: 'CHabc',
  handoffId: 'handoff_CHabc_1',
  customerAddress: 'whatsapp:+15551234567',
  businessAddress: 'whatsapp:+14155238886',
  intent: 'billing_dispute',
  reason: 'explicit_human_request',
  summary: 'Customer disputes charge.',
};

describe('validateEscalationPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(validateEscalationPayload(good).ok).toBe(true);
  });
  it('rejects a non-CH conversation sid', () => {
    const r = validateEscalationPayload({ ...good, conversationSid: 'IMabc' });
    expect(r.ok).toBe(false);
  });
  it('rejects addresses without whatsapp: scheme', () => {
    const r = validateEscalationPayload({ ...good, customerAddress: '+15551234567' });
    expect(r.ok).toBe(false);
  });
  it('rejects a summary over 500 characters', () => {
    const r = validateEscalationPayload({ ...good, summary: 'a'.repeat(501) });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 4: Implement validator**

Create `src/handoff/validate.js`:

```js
const REQUIRED = ['conversationSid', 'handoffId', 'customerAddress', 'businessAddress', 'intent', 'reason', 'summary'];

export function validateEscalationPayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  for (const key of REQUIRED) {
    if (typeof body[key] !== 'string' || body[key].length === 0) {
      return { ok: false, error: `missing or empty field: ${key}` };
    }
  }
  if (!body.conversationSid.startsWith('CH')) return { ok: false, error: 'conversationSid must start with CH' };
  if (!body.customerAddress.startsWith('whatsapp:')) return { ok: false, error: 'customerAddress must start with whatsapp:' };
  if (!body.businessAddress.startsWith('whatsapp:')) return { ok: false, error: 'businessAddress must start with whatsapp:' };
  if (body.summary.length > 500) return { ok: false, error: 'summary exceeds 500 characters' };
  if (body.intent.length > 64) return { ok: false, error: 'intent exceeds 64 characters' };
  if (body.reason.length > 64) return { ok: false, error: 'reason exceeds 64 characters' };
  const value = { ...body };
  if (typeof body.priority === 'number') value.priority = body.priority;
  return { ok: true, value };
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/handoff/auth.js src/handoff/validate.js tests/unit/handoff
git commit -m "feat: bearer auth middleware and escalation payload validator"
```

---

## Task 12: Flex Interactions client + escalation controller

**Files:**
- Create: `src/handoff/flex.js`
- Create: `src/handoff/controller.js`
- Create: `src/routes/elevenlabs-escalate.js`
- Test: `tests/unit/handoff/flex.test.js`
- Test: `tests/integration/escalation.test.js`
- Modify: `src/server.js` (wire the route)

**Interfaces consumed:**
- `twilio` SDK, `store`, `cache`, `validateEscalationPayload`, `sessionManager`.

**Interfaces produced:**
- `createFlexClient({ twilioClient, flexConfig }): { createInteraction({ conversationSid, from, customerAddress, businessAddress, intent, reason, summary, elevenlabsConversationId, handoffId, priority }): Promise<{ interactionSid, taskSid }> }`
- `createHandoffController({ store, cache, sessionManager, flexClient, logger }): (req, res) => Promise<void>` — orchestrates: validate → dedup (`handoffId`) → `bot -> human_pending` transition → create Interaction → persist Flex IDs → close ElevenLabs session. Duplicate handoffs (same `handoffId` OR conversation already has `flexInteractionSid`) return the stored IDs.
- `createEscalateRoute({ controller, config, logger })` wires the POST route with bearer auth.

Attribute shape sent to Flex:

```
{
  channel: {
    type: 'whatsapp',
    initiated_by: 'customer',
    properties: { media_channel_sid: '<CH...>' }
  },
  routing: {
    properties: {
      workspace_sid, workflow_sid, task_channel_unique_name,
      attributes: { channelType, direction, name, from, customerAddress,
                    customerName, businessAddress, conversationSid,
                    elevenlabsConversationId, handoffId, reason, intent,
                    summary, ...(priority ? { priority } : {}) }
    }
  }
}
```

- [ ] **Step 1: Write the Flex client test**

Create `tests/unit/handoff/flex.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { createFlexClient } from '../../../src/handoff/flex.js';

describe('flex client', () => {
  it('POSTs the canonical Interaction shape and returns interaction+task sids', async () => {
    const create = vi.fn().mockResolvedValue({
      sid: 'KDinteraction',
      routing: { properties: { sid: 'WTtaskSid' } },
    });
    const twilioClient = { flexApi: { v1: { interaction: { create } } } };
    const client = createFlexClient({
      twilioClient,
      flexConfig: {
        workspaceSid: 'WSx',
        workflowSid: 'WWx',
        taskChannelUniqueName: 'chat',
      },
    });

    const result = await client.createInteraction({
      conversationSid: 'CH1',
      customerAddress: 'whatsapp:+15551234567',
      businessAddress: 'whatsapp:+14155238886',
      intent: 'billing_dispute',
      reason: 'explicit_human_request',
      summary: 'Customer disputes charge.',
      elevenlabsConversationId: 'conv_1',
      handoffId: 'handoff_CH1_1',
    });

    expect(result).toEqual({ interactionSid: 'KDinteraction', taskSid: 'WTtaskSid' });
    const [args] = create.mock.calls[0];
    expect(args.channel.type).toBe('whatsapp');
    expect(args.channel.initiated_by).toBe('customer');
    expect(args.channel.properties.media_channel_sid).toBe('CH1');
    const attrs = args.routing.properties.attributes;
    expect(attrs).toEqual({
      channelType: 'whatsapp',
      direction: 'inbound',
      name: 'whatsapp:+15551234567',
      from: 'whatsapp:+15551234567',
      customerAddress: 'whatsapp:+15551234567',
      customerName: 'whatsapp:+15551234567',
      businessAddress: 'whatsapp:+14155238886',
      conversationSid: 'CH1',
      elevenlabsConversationId: 'conv_1',
      handoffId: 'handoff_CH1_1',
      reason: 'explicit_human_request',
      intent: 'billing_dispute',
      summary: 'Customer disputes charge.',
    });
  });
});
```

- [ ] **Step 2: Implement `createFlexClient`**

Create `src/handoff/flex.js`:

```js
export function createFlexClient({ twilioClient, flexConfig }) {
  return {
    async createInteraction({
      conversationSid,
      customerAddress,
      businessAddress,
      intent,
      reason,
      summary,
      elevenlabsConversationId,
      handoffId,
      priority,
    }) {
      const attributes = {
        channelType: 'whatsapp',
        direction: 'inbound',
        name: customerAddress,
        from: customerAddress,
        customerAddress,
        customerName: customerAddress,
        businessAddress,
        conversationSid,
        elevenlabsConversationId,
        handoffId,
        reason,
        intent,
        summary,
      };
      if (typeof priority === 'number') attributes.priority = priority;

      const created = await twilioClient.flexApi.v1.interaction.create({
        channel: {
          type: 'whatsapp',
          initiated_by: 'customer',
          properties: { media_channel_sid: conversationSid },
        },
        routing: {
          properties: {
            workspace_sid: flexConfig.workspaceSid,
            workflow_sid: flexConfig.workflowSid,
            task_channel_unique_name: flexConfig.taskChannelUniqueName,
            attributes,
          },
        },
      });

      return {
        interactionSid: created.sid,
        taskSid: created.routing?.properties?.sid ?? null,
      };
    },
  };
}
```

- [ ] **Step 3: Write the controller integration test**

Create `tests/integration/escalation.test.js`:

```js
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
});
```

- [ ] **Step 4: Implement controller and route**

Create `src/handoff/controller.js`:

```js
import { validateEscalationPayload } from './validate.js';
import { InvalidTransition } from '../state/file-store.js';

export function createHandoffController({ store, cache, sessionManager, flexClient, logger }) {
  return async function handle(req, res) {
    const validation = validateEscalationPayload(req.body);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
    const payload = validation.value;
    const log = logger.child({
      conversationSid: payload.conversationSid,
      handoffId: payload.handoffId,
    });

    const dedupKey = `handoff:${payload.conversationSid}:${payload.handoffId}`;
    const remembered = cache.recall(dedupKey);
    if (remembered) {
      return res.status(200).json(remembered);
    }

    const existing = await store.get(payload.conversationSid);
    if (existing?.flexInteractionSid) {
      const response = {
        interactionSid: existing.flexInteractionSid,
        taskSid: existing.taskSid,
        handoffId: existing.handoffId,
      };
      cache.remember(dedupKey, response);
      return res.status(200).json(response);
    }

    try {
      await store.transitionMode(payload.conversationSid, 'bot', 'human_pending', {
        handoffId: payload.handoffId,
        elevenlabsConversationId: payload.elevenlabsConversationId ?? existing?.elevenlabsConversationId ?? null,
      });
    } catch (err) {
      if (err instanceof InvalidTransition) {
        return res.status(409).json({ error: 'invalid_state_transition' });
      }
      throw err;
    }

    let interactionSid, taskSid;
    try {
      ({ interactionSid, taskSid } = await flexClient.createInteraction(payload));
    } catch (err) {
      log.error({ err }, 'flex_interaction_create_failed');
      return res.status(502).json({ error: 'flex_interaction_create_failed' });
    }

    await store.upsert(payload.conversationSid, (prev) => ({
      ...prev,
      flexInteractionSid: interactionSid,
      taskSid,
    }));

    sessionManager.close(payload.conversationSid);

    const response = { interactionSid, taskSid, handoffId: payload.handoffId };
    cache.remember(dedupKey, response);
    return res.status(200).json(response);
  };
}
```

Create `src/routes/elevenlabs-escalate.js`:

```js
import { Router } from 'express';
import { bearerAuth } from '../handoff/auth.js';

export function createEscalateRoute({ controller, config }) {
  const router = Router();
  router.post(
    '/webhooks/elevenlabs/escalate-to-flex',
    bearerAuth({ token: config.handoffToken ?? '' }),
    controller,
  );
  return router;
}
```

Wire in `src/server.js`:

```js
// inside createServer, after the conversation route
if (deps.handoffController) {
  app.use(createEscalateRoute({ controller: deps.handoffController, config }));
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/handoff/flex.js src/handoff/controller.js src/routes/elevenlabs-escalate.js src/server.js tests/unit/handoff/flex.test.js tests/integration/escalation.test.js
git commit -m "feat: Flex Interactions client and escalation controller with idempotency"
```

---

## Task 13: TaskRouter event handler for `human_pending → human → closed`

**Files:**
- Create: `src/taskrouter/event-handler.js`
- Create: `src/routes/taskrouter-events.js`
- Test: `tests/integration/mode-transitions.test.js`
- Modify: `src/server.js`

**Interfaces consumed:**
- `store`, `cache`, `logger`.

**Interfaces produced:**
- `createTaskRouterHandler({ store, cache, logger }): (req, res) => Promise<void>` — reads form-encoded body with `EventType`, `TaskSid`, and `TaskAttributes` (a JSON string containing `conversationSid`).
- `createTaskRouterRoute({ handler, config })` wires signature verification and the POST route.

Behavior:
- `EventType === 'reservation.accepted'` → `human_pending -> human`.
- `EventType === 'task.completed' | 'task.canceled'` → `human -> closed`.
- Other events return 200 with no state change.
- Dedup on `EventSid` (unique per TaskRouter event).
- `TaskSid` mismatch with stored `taskSid` logs a warning and returns 200 (idempotent).

- [ ] **Step 1: Write the failing test**

Create `tests/integration/mode-transitions.test.js`:

```js
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
```

- [ ] **Step 2: Implement handler and route**

Create `src/taskrouter/event-handler.js`:

```js
import { InvalidTransition } from '../state/file-store.js';

const ACCEPT = 'reservation.accepted';
const COMPLETE = new Set(['task.completed', 'task.canceled']);

function parseAttributes(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export function createTaskRouterHandler({ store, cache, logger }) {
  return async function handle(req, res) {
    const body = req.body ?? {};
    const eventSid = body.EventSid;
    if (!eventSid) return res.status(400).end();

    const key = `taskrouter:${eventSid}`;
    if (cache.seen(key)) return res.status(200).end();
    cache.remember(key, true);

    const attrs = parseAttributes(body.TaskAttributes);
    const conversationSid = attrs.conversationSid;
    if (!conversationSid) return res.status(200).end();

    const log = logger.child({ conversationSid, eventSid, eventType: body.EventType });

    try {
      if (body.EventType === ACCEPT) {
        await store.transitionMode(conversationSid, 'human_pending', 'human', { taskSid: body.TaskSid });
      } else if (COMPLETE.has(body.EventType)) {
        await store.transitionMode(conversationSid, ['human', 'human_pending'], 'closed');
      }
    } catch (err) {
      if (err instanceof InvalidTransition) {
        log.warn({ err }, 'ignored_invalid_transition');
      } else {
        throw err;
      }
    }

    res.status(200).end();
  };
}
```

Create `src/routes/taskrouter-events.js`:

```js
import { Router } from 'express';
import { verifyTwilioSignature } from '../twilio/signature.js';

export function createTaskRouterRoute({ handler, config, skipSignatureVerification = false }) {
  const router = Router();
  const middlewares = [];
  if (!skipSignatureVerification) {
    middlewares.push(verifyTwilioSignature({ authToken: config.twilio?.authToken ?? '' }));
  }
  router.post('/webhooks/taskrouter/events', ...middlewares, handler);
  return router;
}
```

Wire in `src/server.js` alongside the other routes.

- [ ] **Step 3: Run — expect PASS**

Run: `npm test`

- [ ] **Step 4: Commit**

```bash
git add src/taskrouter src/routes/taskrouter-events.js src/server.js tests/integration/mode-transitions.test.js
git commit -m "feat: TaskRouter event handler for human_pending/human/closed transitions"
```

---

## Task 14: Observability, wiring in `src/server.js`, and README updates

**Files:**
- Create: `src/logger.js`
- Modify: `src/server.js`
- Modify: `README.md`
- Test: `tests/integration/duplicates.test.js`

**Interfaces produced:**
- `createLogger({ level }): pino.Logger` — a `pino` instance. All log lines include correlation ids passed via `logger.child({ correlationId, conversationSid })`.
- `src/server.js` exports a fully wired `bootstrap({ config })` that constructs the Twilio SDK client, store, cache, session manager, Flex client, handoff controller, and TaskRouter handler and returns `{ app, sessionManager, store, cache }`.

- [ ] **Step 1: Write duplicates integration test**

Create `tests/integration/duplicates.test.js`:

```js
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
```

- [ ] **Step 2: Implement `createLogger` and full bootstrap**

Create `src/logger.js`:

```js
import pino from 'pino';

export function createLogger({ level = 'info' } = {}) {
  return pino({ level, base: { service: 'twilio-elevenlabs-whatsapp-flex-relay' } });
}
```

Rewrite `src/server.js`:

```js
import express from 'express';
import twilio from 'twilio';
import { WebSocket } from 'ws';

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createStore } from './state/store.js';
import { createIdempotencyCache } from './idempotency/cache.js';
import { createConversationsClient } from './twilio/conversations.js';
import { createSession } from './elevenlabs/session.js';
import { createSessionManager } from './elevenlabs/session-manager.js';
import { createFlexClient } from './handoff/flex.js';
import { createHandoffController } from './handoff/controller.js';
import { createTaskRouterHandler } from './taskrouter/event-handler.js';

import { healthRouter } from './routes/health.js';
import { createConversationRoute } from './routes/twilio-conversation.js';
import { createMessageStatusRoute } from './routes/twilio-message-status.js';
import { createEscalateRoute } from './routes/elevenlabs-escalate.js';
import { createTaskRouterRoute } from './routes/taskrouter-events.js';

export function bootstrap({ config = loadConfig() } = {}) {
  const logger = createLogger({ level: config.logLevel });
  const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);
  const store = createStore(config);
  const cache = createIdempotencyCache();
  const conversationsClient = createConversationsClient({ twilioClient, botIdentity: config.botIdentity });
  const flexClient = createFlexClient({ twilioClient, flexConfig: config.flex });
  const sessionManager = createSessionManager({
    idleTimeoutMs: config.elevenlabs.idleTimeoutMs,
    sessionFactory: () =>
      createSession({
        url: config.elevenlabs.wsUrl,
        apiKey: config.elevenlabs.apiKey,
        agentId: config.elevenlabs.agentId,
        wsFactory: (url, opts) => new WebSocket(url, opts),
      }),
  });
  const handoffController = createHandoffController({ store, cache, sessionManager, flexClient, logger });
  const taskRouterHandler = createTaskRouterHandler({ store, cache, logger });

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(healthRouter(config));
  app.use(createConversationRoute({ store, cache, conversationsClient, sessionManager, config, logger }));
  app.use(createMessageStatusRoute({ store, cache, config, logger }));
  app.use(createEscalateRoute({ controller: handoffController, config }));
  app.use(createTaskRouterRoute({ handler: taskRouterHandler, config }));

  return { app, store, cache, sessionManager, logger };
}

export function createServer(config, deps = {}) {
  // retained for tests: builds an app with only /health and any deps callers wire
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(healthRouter(config));
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const { app, logger } = bootstrap({ config });
  app.listen(config.port, () => logger.info({ port: config.port }, 'relay_listening'));
}
```

- [ ] **Step 3: Update README wiring section**

Modify `README.md` (append a new "Running the Relay" section before "## Next Steps"):

```markdown
## Running the Relay

Install and start:

```bash
npm install
cp examples/env.example .env
# fill in TWILIO_*, FLEX_*, ELEVENLABS_*, HANDOFF_TOKEN, BOT_IDENTITY
npm run dev
```

Expose it and configure webhooks:

```bash
ngrok http 3000
```

Set these URLs in Twilio and ElevenLabs:

| Consumer | URL |
| --- | --- |
| Twilio Conversations (`onMessageAdded`, form-encoded) | `https://<ngrok>/webhooks/twilio/conversation` |
| Twilio Conversations status callback | `https://<ngrok>/webhooks/twilio/message-status` |
| Twilio TaskRouter Event Callback | `https://<ngrok>/webhooks/taskrouter/events` |
| ElevenLabs `escalate_to_flex` tool | `https://<ngrok>/webhooks/elevenlabs/escalate-to-flex` |
```

- [ ] **Step 4: Run everything — expect PASS**

Run: `npm test`
Expected: all unit and integration tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/logger.js src/server.js README.md tests/integration/duplicates.test.js
git commit -m "feat: full server wiring, structured logging, duplicate-handling tests"
```

---

## Self-Review Notes

- **Spec coverage:** Every spec section has a task —
  - Twilio Conversations Adapter → Tasks 5, 6, 9
  - ElevenLabs Session Manager → Tasks 7, 8
  - Conversation State Store → Task 3 (all listed fields including `elevenlabsSessionStatus`)
  - Handoff Controller → Tasks 11, 12
  - TaskRouter Event Handler → Task 13
  - Agent Control (stop relaying, close session on escalation) → Task 12 (session close), Task 9 (mode gate)
  - Observability → Task 14
  - State machine transitions → Tasks 3 (transitionMode), 12 (bot→human_pending), 13 (→human, →closed)
  - Data contracts (dynamic variables, escalation request, Flex Interaction attributes) → Tasks 9, 11, 12
  - Local development (ngrok, `/health`) → Tasks 1, 14
  - Error handling (invalid signature, duplicate events, ElevenLabs unavailable, invalid payload, duplicate escalation, Flex creation failure) → Tasks 5, 9, 10, 11, 12
  - Testing strategy (unit + integration) → tests attached to every task; integration files cover the five scenarios called out in the spec.
  - `handoffId`, bot author identity, session lifecycle, media handling → Tasks 7, 6, 8, 9
- **Type consistency:** `state.mode`, `state.flexInteractionSid`, `state.taskSid`, `state.handoffId`, `state.elevenlabsConversationId`, `state.elevenlabsSessionStatus`, `state.deliveryStatuses` — used consistently across Tasks 3, 9, 10, 12, 13.
- **No placeholders:** every step includes runnable code or an exact command.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-12-whatsapp-elevenlabs-flex-relay-implementation.md`.
