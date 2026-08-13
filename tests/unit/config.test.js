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
