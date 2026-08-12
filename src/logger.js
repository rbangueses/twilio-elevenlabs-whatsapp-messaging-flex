import pino from 'pino';

export function createLogger({ level = 'info' } = {}) {
  return pino({ level, base: { service: 'twilio-elevenlabs-whatsapp-flex-relay' } });
}
