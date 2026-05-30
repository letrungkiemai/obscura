/**
 * End-to-end check of compaction. Boots the real app and drives raw `ws`
 * clients with opaque blobs (the server never decrypts), asserting:
 *   - an uploaded snapshot prunes the updates it covers,
 *   - a behind device's pull is served the snapshot + only the tail,
 *   - a caught-up device's pull gets the tail with no snapshot,
 *   - seq numbering continues past the pruned range,
 *   - a stale snapshot (not advancing upToSeq) is ignored.
 *
 * Run: ./apps/server/node_modules/.bin/tsx apps/server/src/sync/verify-compaction.ts
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
const blob = () => crypto.randomBytes(40).toString('base64url');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = (ws: WebSocket, m: SyncMessage) => ws.send(JSON.stringify(m));

function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
function next(ws: WebSocket, pred: (m: SyncMessage) => boolean, ms = 2000): Promise<SyncMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('timed out'));
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

async function main() {
  const { app, injectWebSocket, sessions } = createApp();
  sessions.set('tok-alice', 'alice@example.com');
  const port: number = await new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info: AddressInfo) => resolve(info.port));
    injectWebSocket(server);
  });
  const base = `ws://localhost:${port}/api/sync?token=tok-alice`;

  // device A appends 5 updates (seq 1..5)
  const a1 = await open(base);
  const blobs: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const b = blob();
    blobs.push(b);
    send(a1, { type: 'push', docId: DEFAULT_DOC_ID, encryptedUpdate: b, originClient: 'A1' });
    const ack = await next(a1, (m) => m.type === 'ack');
    assert(ack.type === 'ack' && ack.seq === i, `push ${i} → seq ${i}`);
  }

  // upload a snapshot covering seq ≤ 3 → server stores it and prunes 1..3
  const snap = blob();
  send(a1, { type: 'snapshot', docId: DEFAULT_DOC_ID, encryptedSnapshot: snap, upToSeq: 3 });
  await sleep(50);

  // a stale snapshot (upToSeq 2) must be ignored
  send(a1, { type: 'snapshot', docId: DEFAULT_DOC_ID, encryptedSnapshot: blob(), upToSeq: 2 });
  await sleep(50);

  // a fresh device (fromSeq 0) is served the snapshot + only the tail (4,5)
  const fresh = await open(base);
  send(fresh, { type: 'pull', docId: DEFAULT_DOC_ID, fromSeq: 0 });
  const restored = await next(fresh, (m) => m.type === 'snapshot');
  assert(restored.type === 'snapshot' && restored.upToSeq === 3 && restored.encryptedSnapshot === snap, 'fresh device restored from the (non-stale) snapshot at upToSeq 3');
  const tail = await next(fresh, (m) => m.type === 'updates');
  assert(tail.type === 'updates' && tail.updates.length === 2, `fresh tail has 2 updates, not the pruned ones (got ${tail.type === 'updates' ? tail.updates.length : '?'})`);
  if (tail.type === 'updates') {
    assert(tail.updates[0].seq === 4 && tail.updates[1].seq === 5, 'tail is seq 4,5');
    assert(tail.updates[0].encryptedUpdate === blobs[3] && tail.updates[1].encryptedUpdate === blobs[4], 'tail blobs intact');
  }

  // a caught-up device (fromSeq 5) gets the tail with NO snapshot
  const caught = await open(base);
  send(caught, { type: 'pull', docId: DEFAULT_DOC_ID, fromSeq: 5 });
  const caughtRes = await next(caught, (m) => m.type === 'updates' || m.type === 'snapshot');
  assert(caughtRes.type === 'updates' && caughtRes.updates.length === 0, 'caught-up device gets empty updates, no snapshot');

  // a device exactly at the snapshot boundary (fromSeq 3) gets only the tail
  send(caught, { type: 'pull', docId: DEFAULT_DOC_ID, fromSeq: 3 });
  const boundary = await next(caught, (m) => m.type === 'updates' || m.type === 'snapshot');
  assert(boundary.type === 'updates' && boundary.updates.length === 2, 'fromSeq==upToSeq gets tail only, no snapshot');

  // seq numbering continues past the pruned range
  const b6 = blob();
  send(a1, { type: 'push', docId: DEFAULT_DOC_ID, encryptedUpdate: b6, originClient: 'A1' });
  const ack6 = await next(a1, (m) => m.type === 'ack');
  assert(ack6.type === 'ack' && ack6.seq === 6, `append after prune continues at seq 6 (got ${JSON.stringify(ack6)})`);

  for (const ws of [a1, fresh, caught]) ws.close();
  console.log('OK — compaction verified: snapshot prunes covered updates, behind devices restore snapshot+tail, caught-up devices get tail only, seq continues past the prune, stale snapshots ignored.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
