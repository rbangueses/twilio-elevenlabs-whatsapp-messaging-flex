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
