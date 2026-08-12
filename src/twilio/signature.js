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
