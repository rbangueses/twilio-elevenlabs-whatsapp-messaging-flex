export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 3000),
    nodeEnv: env.NODE_ENV ?? 'development',
    hasTwilio: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
    hasElevenLabs: Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID),
    hasFlex: Boolean(env.FLEX_WORKSPACE_SID && env.FLEX_WORKFLOW_SID),
  };
}
