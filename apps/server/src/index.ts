import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const { app, injectWebSocket } = createApp();

const port = parseInt(process.env.PORT ?? '3000', 10);

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`Server running at http://localhost:${port}`);
});

// Handle WebSocket upgrades on the same http server (the /api/sync endpoint).
injectWebSocket(server);
