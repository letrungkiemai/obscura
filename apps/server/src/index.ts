import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { InMemoryAccountStore } from './db/accounts.js';
import { authRoutes } from './routes/auth.js';

const app = new Hono();

app.use('*', logger());
app.use('*', cors({ origin: 'http://localhost:5173' }));

app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Phase 1: in-memory account + session stores. Swapped for Postgres in Phase 4.
const accounts = new InMemoryAccountStore();
const sessions = new Map<string, string>();
app.route('/api/auth', authRoutes(accounts, sessions));

const port = parseInt(process.env.PORT ?? '3000', 10);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Server running at http://localhost:${port}`);
});
