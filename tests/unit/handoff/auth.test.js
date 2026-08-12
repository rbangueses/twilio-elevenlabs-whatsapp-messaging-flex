import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { bearerAuth } from '../../../src/handoff/auth.js';

function buildApp() {
  const app = express();
  app.post('/x', bearerAuth({ token: 'secret' }), (_req, res) => res.status(204).end());
  return app;
}

describe('bearerAuth', () => {
  it('accepts a matching bearer token', async () => {
    const res = await request(buildApp()).post('/x').set('Authorization', 'Bearer secret');
    expect(res.status).toBe(204);
  });
  it('rejects a missing or wrong bearer token', async () => {
    const res = await request(buildApp()).post('/x');
    expect(res.status).toBe(401);
    const wrong = await request(buildApp()).post('/x').set('Authorization', 'Bearer nope');
    expect(wrong.status).toBe(401);
  });
  it('rejects a non-Bearer authorization scheme', async () => {
    const res = await request(buildApp()).post('/x').set('Authorization', 'Basic secret');
    expect(res.status).toBe(401);
  });
  it('rejects all requests when the configured token is empty', async () => {
    const app = express();
    app.post('/x', bearerAuth({ token: '' }), (_req, res) => res.status(204).end());

    const noHeader = await request(app).post('/x');
    expect(noHeader.status).toBe(401);

    const emptyBearer = await request(app).post('/x').set('Authorization', 'Bearer ');
    expect(emptyBearer.status).toBe(401);

    const someToken = await request(app).post('/x').set('Authorization', 'Bearer anything');
    expect(someToken.status).toBe(401);
  });
});
