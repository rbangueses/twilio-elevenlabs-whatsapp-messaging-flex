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
