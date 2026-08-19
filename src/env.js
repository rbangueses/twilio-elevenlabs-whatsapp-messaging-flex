import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseValue(raw) {
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function loadDotEnv({ path = '.env', env = process.env } = {}) {
  const filePath = resolve(process.cwd(), path);
  if (!existsSync(filePath)) return false;

  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = normalized.indexOf('=');
    if (eq <= 0) continue;

    const key = normalized.slice(0, eq).trim();
    if (!key || env[key]) continue;

    env[key] = parseValue(normalized.slice(eq + 1));
  }

  return true;
}

loadDotEnv();
