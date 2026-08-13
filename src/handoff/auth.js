import { timingSafeEqual } from 'node:crypto';

export function bearerAuth({ token }) {
  const expected = Buffer.from(token ?? '');
  return function (req, res, next) {
    if (expected.length === 0) {
      // No token configured — refuse all requests
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const header = req.get('Authorization') ?? '';
    const prefix = 'Bearer ';
    if (!header.startsWith(prefix)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const provided = Buffer.from(header.slice(prefix.length));
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}
