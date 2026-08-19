import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('server environment bootstrap', () => {
  it('loads HANDOFF_TOKEN from .env before routes are configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-env-'));
    try {
      writeFileSync(join(dir, '.env'), 'HANDOFF_TOKEN=from_dotenv\n');
      const serverPath = resolve('src/server.js');
      const output = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `await import(${JSON.stringify(serverPath)}); console.log(process.env.HANDOFF_TOKEN ?? '')`,
        ],
        {
          cwd: dir,
          env: { PATH: process.env.PATH },
          encoding: 'utf8',
        },
      );

      expect(output.trim()).toBe('from_dotenv');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
