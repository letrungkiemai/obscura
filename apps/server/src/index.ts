import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import type { CreateAppOptions } from './app.js';
import { createDb, getDatabaseUrl } from './db/db.js';
import { migrateToLatest } from './db/migrator.js';
import { PostgresAccountStore } from './db/accounts.js';
import { PostgresUpdateStore } from './db/updates.js';

/**
 * Connect to Postgres and run migrations. Falls back to in-memory stores (with a
 * loud warning) if the DB is unreachable, so the app still boots for quick local
 * hacking without a database. Data is only persisted on the Postgres path.
 */
async function resolveStores(): Promise<CreateAppOptions> {
  const url = getDatabaseUrl();
  try {
    const db = createDb(url);
    await migrateToLatest(db);
    console.log(`Database ready: ${url.replace(/:\/\/[^@/]*@/, '://***@')}`);
    return { accounts: new PostgresAccountStore(db), updates: new PostgresUpdateStore(db) };
  } catch (err) {
    console.warn(
      `⚠ Postgres unavailable (${(err as Error).message}). Using in-memory stores — data will NOT persist.`,
    );
    return {};
  }
}

async function main() {
  const { app, injectWebSocket } = createApp(await resolveStores());

  const port = parseInt(process.env.PORT ?? '3000', 10);
  const server = serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running at http://localhost:${port}`);
  });

  // Handle WebSocket upgrades on the same http server (the /api/sync endpoint).
  injectWebSocket(server);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
