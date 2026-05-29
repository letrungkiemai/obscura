/**
 * Full-stack smoke test on a throwaway Postgres db: real HTTP signup + login,
 * then WebSocket push/pull, asserting the encrypted update actually persists to
 * the doc_updates table. Proves createApp's store injection composes the Phase 3
 * sync protocol with the Phase 4 Postgres backing end to end.
 *
 * Run: ./apps/server/node_modules/.bin/tsx apps/server/src/verify-stack.ts
 */
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { sql } from 'kysely';
import { WebSocket } from 'ws';
import { DEFAULT_DOC_ID, SyncMessageSchema } from '@obscura/shared';
import type { SyncMessage } from '@obscura/shared';
import { createApp } from './app.js';
import { createDb, getDatabaseUrl } from './db/db.js';
import { migrateToLatest } from './db/migrator.js';
import { PostgresAccountStore } from './db/accounts.js';
import { PostgresUpdateStore } from './db/updates.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const b64 = (n = 32) => crypto.randomBytes(n).toString('base64url');

function next(ws: WebSocket, pred: (m: SyncMessage) => boolean, ms = 2000): Promise<SyncMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    ws.on('message', (data: Buffer) => {
      const parsed = SyncMessageSchema.safeParse(JSON.parse(data.toString()));
      if (parsed.success && pred(parsed.data)) {
        clearTimeout(timer);
        resolve(parsed.data);
      }
    });
  });
}
const open = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

async function main() {
  const baseUrl = getDatabaseUrl();
  const dbName = `obscura_stack_${crypto.randomBytes(4).toString('hex')}`;
  const admin = createDb(baseUrl);
  await admin.executeQuery({ sql: `CREATE DATABASE ${dbName}`, parameters: [] } as never);
  await admin.destroy();
  const url = baseUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  const db = createDb(url);

  try {
    await migrateToLatest(db);
    const { app, injectWebSocket } = createApp({
      accounts: new PostgresAccountStore(db),
      updates: new PostgresUpdateStore(db),
    });
    const port: number = await new Promise((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0 }, (info: AddressInfo) => resolve(info.port));
      injectWebSocket(server);
    });
    const http = `http://localhost:${port}/api/auth`;

    // --- real signup over HTTP (persists a users row) ---
    const email = 'sync-user@example.com';
    const authVerifier = b64();
    const signup = await fetch(`${http}/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        kdfSalt: b64(16),
        kdfParams: { opsLimit: 2, memLimit: 67108864, algorithm: 2 },
        authVerifier,
        wrappedDek: b64(),
        wrappedDekRecovery: b64(),
      }),
    });
    assert(signup.status === 201, `signup → 201 (got ${signup.status})`);

    const usersCount = await sql<{ count: string }>`SELECT count(*)::text FROM users`.execute(db);
    assert(usersCount.rows[0].count === '1', 'users row persisted to Postgres');

    // --- login → session token ---
    const login = await fetch(`${http}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, authVerifier }),
    });
    assert(login.status === 200, `login → 200 (got ${login.status})`);
    const { sessionToken } = (await login.json()) as { sessionToken: string };
    assert(typeof sessionToken === 'string' && sessionToken.length > 0, 'got a session token');

    // --- WS push, then confirm it persisted to doc_updates ---
    const wsBase = `ws://localhost:${port}/api/sync?token=${encodeURIComponent(sessionToken)}`;
    const a1 = await open(wsBase);
    const blob = b64(60);
    a1.send(JSON.stringify({ type: 'push', docId: DEFAULT_DOC_ID, encryptedUpdate: blob, originClient: 'devA' }));
    const ack = await next(a1, (m) => m.type === 'ack');
    assert(ack.type === 'ack' && ack.seq === 1, `push ack seq 1 (got ${JSON.stringify(ack)})`);

    const stored = await sql<{ encrypted_update: Buffer }>`SELECT encrypted_update FROM doc_updates`.execute(db);
    assert(stored.rows.length === 1, 'one row in doc_updates');
    assert(stored.rows[0].encrypted_update.toString('base64url') === blob, 'persisted ciphertext matches what was pushed');

    // --- a second device pulls it back out of Postgres ---
    const a2 = await open(wsBase);
    a2.send(JSON.stringify({ type: 'pull', docId: DEFAULT_DOC_ID, fromSeq: 0 }));
    const pulled = await next(a2, (m) => m.type === 'updates');
    assert(pulled.type === 'updates' && pulled.updates.length === 1, 'pull returns the one update');
    if (pulled.type === 'updates') assert(pulled.updates[0].encryptedUpdate === blob, 'pulled blob matches');

    a1.close();
    a2.close();
    console.log('OK — HTTP signup/login + WS push/pull against Postgres: user persisted, ciphertext stored in doc_updates and pulled back intact.');
  } finally {
    await db.destroy();
    const cleanup = createDb(baseUrl);
    await cleanup.executeQuery({ sql: `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`, parameters: [] } as never);
    await cleanup.destroy();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
