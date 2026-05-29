import { Hono } from 'hono';
import { createNodeWebSocket } from '@hono/node-ws';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { InMemoryAccountStore } from './db/accounts.js';
import type { AccountStore } from './db/accounts.js';
import { InMemoryUpdateStore } from './db/updates.js';
import type { UpdateStore } from './db/updates.js';
import { SyncHub } from './sync/hub.js';
import { authRoutes } from './routes/auth.js';
import { registerSyncRoutes } from './sync/routes.js';

export interface CreateAppOptions {
  /** Defaults to in-memory (used by tests); index.ts injects Postgres stores. */
  accounts?: AccountStore;
  updates?: UpdateStore;
}

export interface AppParts {
  app: Hono;
  /** Attach to the Node http server returned by `serve()` to handle WS upgrades. */
  injectWebSocket: ReturnType<typeof createNodeWebSocket>['injectWebSocket'];
  accounts: AccountStore;
  updates: UpdateStore;
  sessions: Map<string, string>;
  hub: SyncHub;
}

/**
 * Build the Hono app and its WebSocket plumbing. Stores are injected so the same
 * wiring serves Postgres in production and in-memory in tests; separated from
 * listening so tests can boot it on an ephemeral port and seed sessions.
 */
export function createApp(opts: CreateAppOptions = {}): AppParts {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.use('*', logger());
  app.use('*', cors({ origin: 'http://localhost:5173' }));

  app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

  const accounts = opts.accounts ?? new InMemoryAccountStore();
  const updates = opts.updates ?? new InMemoryUpdateStore();
  const sessions = new Map<string, string>(); // sessionToken → email
  const hub = new SyncHub();

  app.route('/api/auth', authRoutes(accounts, sessions));
  registerSyncRoutes(app, { upgradeWebSocket, sessions, updates, hub });

  return { app, injectWebSocket, accounts, updates, sessions, hub };
}
