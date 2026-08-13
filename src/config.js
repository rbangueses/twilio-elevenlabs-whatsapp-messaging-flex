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
