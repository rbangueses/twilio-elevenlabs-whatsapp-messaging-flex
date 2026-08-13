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
