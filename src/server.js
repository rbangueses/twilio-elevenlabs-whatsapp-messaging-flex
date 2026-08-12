import express from 'express';
import { healthRouter } from './routes/health.js';
import { loadConfig } from './config.js';

export function createServer(config) {
  const app = express();
  app.use(healthRouter(config));
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = createServer(config);
  app.listen(config.port, () => {
    console.log(`relay listening on :${config.port}`);
  });
}
