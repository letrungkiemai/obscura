/**
 * End-to-end check of the encrypted sync WebSocket. Boots the real app on an
 * ephemeral port and drives raw `ws` clients — the server treats updates as
 * opaque bytes, so this uses random blobs and asserts the append/relay/pull
 * semantics and per-user isolation. (The encrypt/decrypt + Yjs-convergence
 * round-trip is covered by apps/client/src/doc/verify-encrypted-updates.ts.)
 *
 * Run: ./apps/server/node_modules/.bin/tsx apps/server/src/sync/verify-sync.ts
 */
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { WebSocket } from 'ws';
import { DEFAULT_DOC_ID, SyncMessageSchema } from '@obscura/shared';
import type { SyncMessage } from '@obscura/shared';
import { createApp } from '../app.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const blob = () => crypto.randomBytes(48).toString('base64url');

function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Resolve with the next message matching `pred`, or reject after `ms`. */
function next(ws: WebSocket, pred: (m: SyncMessage) => boolean, ms = 2000): Promise<SyncMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('timed out waiting for message'));
    }, ms);
    const onMsg = (data: Buffer) => {
      const parsed = SyncMessageSchema.safeParse(JSON.parse(data.toString()));
      if (parsed.success && pred(parsed.data)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(parsed.data);
      }
    };
    ws.on('message', onMsg);
  });
}

/** Assert NO message arrives within `ms` (used for the isolation check). */
function silence(ws: WebSocket, ms = 300): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMsg = (data: Buffer) => {
      ws.off('message', onMsg);
      reject(new Error(`unexpected message: ${data.toString()}`));
    };
    ws.on('message', onMsg);
    setTimeout(() => {
      ws.off('message', onMsg);
      resolve();
    }, ms);
  });
}

const send = (ws: WebSocket, m: SyncMessage) => ws.send(JSON.stringify(m));

async function main() {
  const { app, injectWebSocket, sessions } = createApp();

  // Seed sessions directly: Alice has two devices; Eve is a different user.
  sessions.set('tok-alice', 'alice@example.com');
  sessions.set('tok-eve', 'eve@example.com');

  const port: number = await new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info: AddressInfo) => resolve(info.port));
    injectWebSocket(server);
  });
  const base = `ws://localhost:${port}/api/sync`;

  // --- auth: a bad token is rejected ---
  const bad = new WebSocket(`${base}?token=nope`);
  const closeCode: number = await new Promise((resolve, reject) => {
    bad.once('close', (code) => resolve(code));
    bad.once('error', reject);
  });
  assert(closeCode === 1008, `unauthorized socket closed with 1008 (got ${closeCode})`);

  // --- Alice's two devices connect ---
  const a1 = await open(`${base}?token=tok-alice`);
  const a2 = await open(`${base}?token=tok-alice`);

  // device A1 pushes; it should be ack'd with seq 1 and relayed to A2 (not back to A1).
  const u1 = blob();
  const a2gets1 = next(a2, (m) => m.type === 'updates');
  send(a1, { type: 'push', docId: DEFAULT_DOC_ID, encryptedUpdate: u1, originClient: 'A1' });

  const ack1 = await next(a1, (m) => m.type === 'ack');
  assert(ack1.type === 'ack' && ack1.seq === 1, `A1 ack seq 1 (got ${JSON.stringify(ack1)})`);

  const relay1 = await a2gets1;
  assert(relay1.type === 'updates' && relay1.updates.length === 1, 'A2 received one relayed update');
  if (relay1.type === 'updates') {
    assert(relay1.updates[0].encryptedUpdate === u1, 'A2 got the exact opaque blob A1 sent');
    assert(relay1.updates[0].seq === 1 && relay1.updates[0].originClient === 'A1', 'relay carries seq + originClient');
  }

  // A2 pushes seq 2; A1 should receive it.
  const u2 = blob();
  const a1gets2 = next(a1, (m) => m.type === 'updates');
  send(a2, { type: 'push', docId: DEFAULT_DOC_ID, encryptedUpdate: u2, originClient: 'A2' });
  const ack2 = await next(a2, (m) => m.type === 'ack');
  assert(ack2.type === 'ack' && ack2.seq === 2, `A2 ack seq 2 (got ${JSON.stringify(ack2)})`);
  await a1gets2;

  // --- incremental pull: a fresh device gets everything after its last seq ---
  const a3 = await open(`${base}?token=tok-alice`);
  send(a3, { type: 'pull', docId: DEFAULT_DOC_ID, fromSeq: 0 });
  const full = await next(a3, (m) => m.type === 'updates');
  assert(full.type === 'updates' && full.updates.length === 2, `pull fromSeq 0 returns 2 updates (got ${full.type === 'updates' ? full.updates.length : '?'})`);
  if (full.type === 'updates') {
    assert(full.updates[0].seq === 1 && full.updates[1].seq === 2, 'pulled updates are ordered by seq');
    assert(full.updates[0].encryptedUpdate === u1 && full.updates[1].encryptedUpdate === u2, 'pulled blobs match what was pushed');
  }

  send(a3, { type: 'pull', docId: DEFAULT_DOC_ID, fromSeq: 1 });
  const partial = await next(a3, (m) => m.type === 'updates');
  assert(partial.type === 'updates' && partial.updates.length === 1 && partial.updates[0].seq === 2, 'pull fromSeq 1 returns only seq 2');

  // --- per-user isolation: Eve never sees Alice's data ---
  const eve = await open(`${base}?token=tok-eve`);
  const eveSilent = silence(eve, 300);
  send(a1, { type: 'push', docId: DEFAULT_DOC_ID, encryptedUpdate: blob(), originClient: 'A1' });
  await next(a1, (m) => m.type === 'ack'); // Alice's push still works
  await eveSilent; // …but Eve got nothing

  send(eve, { type: 'pull', docId: DEFAULT_DOC_ID, fromSeq: 0 });
  const evePull = await next(eve, (m) => m.type === 'updates');
  assert(evePull.type === 'updates' && evePull.updates.length === 0, 'Eve pull returns empty (her own namespace)');

  for (const ws of [a1, a2, a3, eve]) ws.close();
  console.log('OK — auth, ack/seq, cross-device relay, ordered incremental pull, and per-user isolation all verified.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
