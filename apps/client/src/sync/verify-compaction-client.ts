/**
 * Phase 5 — compaction, client side. With a fake WebSocket + real crypto:
 *   - a 'snapshot' message restores full doc state and sets the cursor,
 *   - once snapshotInterval new seqs accrue, the client uploads its own
 *     encrypted snapshot tagged with the highest seq it has applied.
 *
 * Run: ./apps/server/node_modules/.bin/tsx apps/client/src/sync/verify-compaction-client.ts
 */
import crypto from 'node:crypto';
import * as Y from 'yjs';
import { DEFAULT_DOC_ID } from '@obscura/shared';
import type { SyncMessage } from '@obscura/shared';
import { initCrypto, toB64 } from '../crypto/sodium';
import { genDek, aeadEncrypt, aeadDecrypt } from '../crypto/keys';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const tick = () => new Promise((r) => setTimeout(r, 0));

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: SyncMessage[] = [];
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  fireOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  deliver(msg: SyncMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}
(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'localhost:3000' };

async function main() {
  await initCrypto();
  const dek = genDek();
  const { SyncClient } = await import('./syncClient.js');

  // Source doc → a full-state snapshot blob (what the server would relay).
  const src = new Y.Doc();
  src.getText('t').insert(0, 'restored content');
  const snapshotBlob = toB64(aeadEncrypt(Y.encodeStateAsUpdate(src), dek));

  // Two real tail updates to push lastSeq past the snapshot interval.
  const captured: Uint8Array[] = [];
  const tailSrc = new Y.Doc();
  tailSrc.on('update', (u: Uint8Array) => captured.push(u));
  tailSrc.getText('t').insert(0, 'a');
  tailSrc.getText('t').insert(1, 'b');

  const doc = new Y.Doc();
  let savedCursor = -1;
  const sync = new SyncClient({
    doc,
    dek,
    getTicket: async () => 'tok',
    docId: DEFAULT_DOC_ID,
    clientId: 'c1',
    loadCursor: async () => 0,
    saveCursor: (s) => (savedCursor = s),
    loadOutbox: async () => [],
    saveOutbox: () => {},
    snapshotInterval: 2, // compact after 2 new seqs, for the test
  });

  void sync.connect();
  await tick();
  const ws = FakeWebSocket.instances[0];
  ws.fireOpen();

  // --- restore from a snapshot at upToSeq 50 ---
  ws.deliver({ type: 'snapshot', docId: DEFAULT_DOC_ID, encryptedSnapshot: snapshotBlob, upToSeq: 50 });
  assert(doc.getText('t').toString() === 'restored content', `doc restored from snapshot (got "${doc.getText('t').toString()}")`);
  assert(savedCursor === 50, `cursor set to snapshot upToSeq 50 (got ${savedCursor})`);

  // --- two tail updates (seq 51, 52) → crosses snapshotInterval → client uploads a snapshot ---
  const u = (seq: number, b: Uint8Array): SyncMessage => ({
    type: 'updates',
    docId: DEFAULT_DOC_ID,
    updates: [{ id: crypto.randomUUID(), docId: DEFAULT_DOC_ID, seq, encryptedUpdate: toB64(aeadEncrypt(b, dek)), originClient: 'other', createdAt: new Date().toISOString() as unknown as Date }],
  });
  ws.deliver(u(51, captured[0]));
  ws.deliver(u(52, captured[1]));

  const uploaded = ws.sent.find((m) => m.type === 'snapshot');
  assert(!!uploaded, 'client uploaded a snapshot after crossing the interval');
  if (uploaded && uploaded.type === 'snapshot') {
    assert(uploaded.upToSeq === 52, `uploaded snapshot tagged with latest seq 52 (got ${uploaded.upToSeq})`);
    // It must be a valid encrypted full-state update of the current doc.
    const decoded = aeadDecrypt(
      Uint8Array.from(Buffer.from(uploaded.encryptedSnapshot, 'base64url')),
      dek,
    );
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, decoded);
    assert(rebuilt.getText('t').toString() === doc.getText('t').toString(), 'uploaded snapshot decrypts to the current doc state');
  }

  // No further snapshot until another `snapshotInterval` seqs accrue.
  const countBefore = ws.sent.filter((m) => m.type === 'snapshot').length;
  ws.deliver(u(53, captured[0]));
  const countAfter = ws.sent.filter((m) => m.type === 'snapshot').length;
  assert(countBefore === countAfter, 'no premature second snapshot before the next interval');

  sync.close();
  console.log('OK — client compaction verified: restores from a snapshot (state + cursor), and uploads its own snapshot once the interval is crossed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
