/**
 * Phase 5 part 1 — incremental pull. Drives SyncClient with a fake WebSocket and
 * asserts the "remember last seq, fetch only newer" contract:
 *   - first connect pulls fromSeq = the persisted cursor (NOT 0),
 *   - applied updates advance + persist the cursor,
 *   - a reconnect pulls fromSeq = the advanced cursor.
 * Also confirms decrypted updates actually merge into the doc.
 *
 * Run: ./apps/server/node_modules/.bin/tsx apps/client/src/sync/verify-incremental-pull.ts
 */
import crypto from 'node:crypto';
import * as Y from 'yjs';
import { DEFAULT_DOC_ID } from '@obscura/shared';
import type { SyncMessage } from '@obscura/shared';
import { initCrypto, toB64 } from '../crypto/sodium';
import { genDek, aeadEncrypt } from '../crypto/keys';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// --- minimal browser-global stubs (node has no location; override WebSocket) ---
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  // test helpers
  fireOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  deliver(msg: SyncMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  lastSent(): SyncMessage {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}
(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'localhost:3000' };

async function main() {
  await initCrypto();
  const dek = genDek();

  // Import after globals are stubbed (SyncClient references WebSocket/location).
  const { SyncClient } = await import('./syncClient.js');

  // Two real, causally-ordered encrypted updates from one source doc, so they
  // merge into the target deterministically.
  const captured: Uint8Array[] = [];
  const src = new Y.Doc();
  src.on('update', (u: Uint8Array) => captured.push(u));
  src.getText('t').insert(0, 'hello');
  src.getText('t').insert(5, ' world');
  const blob8 = toB64(aeadEncrypt(captured[0], dek));
  const blob9 = toB64(aeadEncrypt(captured[1], dek));

  const doc = new Y.Doc();
  let savedCursor = -1;
  const sync = new SyncClient({
    doc,
    dek,
    getTicket: async () => 'tok',
    docId: DEFAULT_DOC_ID,
    clientId: 'client-1',
    // Pretend this device already has up to seq 7.
    loadCursor: async () => 7,
    saveCursor: (seq) => {
      savedCursor = seq;
    },
    loadOutbox: async () => [],
    saveOutbox: () => {},
  });

  // --- first connect: must pull fromSeq = 7 (only newer), not 0 ---
  void sync.connect();
  await tick();
  const ws1 = FakeWebSocket.instances[0];
  assert(!!ws1, 'a socket was opened');
  ws1.fireOpen();
  const pull1 = ws1.lastSent();
  assert(pull1.type === 'pull' && pull1.fromSeq === 7, `first pull fromSeq is the cursor 7 (got ${JSON.stringify(pull1)})`);

  // --- server returns updates 8 & 9; they apply and advance the cursor ---
  ws1.deliver({
    type: 'updates',
    docId: DEFAULT_DOC_ID,
    updates: [
      { id: crypto.randomUUID(), docId: DEFAULT_DOC_ID, seq: 8, encryptedUpdate: blob8, originClient: 'other', createdAt: new Date().toISOString() as unknown as Date },
      { id: crypto.randomUUID(), docId: DEFAULT_DOC_ID, seq: 9, encryptedUpdate: blob9, originClient: 'other', createdAt: new Date().toISOString() as unknown as Date },
    ],
  });
  assert(doc.getText('t').toString() === 'hello world', `updates merged into doc (got "${doc.getText('t').toString()}")`);
  assert(savedCursor === 9, `cursor advanced + persisted to 9 (got ${savedCursor})`);

  // --- an ack for our own later push advances the cursor too ---
  ws1.deliver({ type: 'ack', docId: DEFAULT_DOC_ID, seq: 10 });
  assert(savedCursor === 10, `ack advanced cursor to 10 (got ${savedCursor})`);

  // --- reconnect: must pull fromSeq = 10 (the advanced cursor), not 7 or 0 ---
  ws1.close();
  void sync.connect();
  await tick();
  const ws2 = FakeWebSocket.instances[1];
  assert(!!ws2 && ws2 !== ws1, 'a fresh socket was opened on reconnect');
  ws2.fireOpen();
  const pull2 = ws2.lastSent();
  assert(pull2.type === 'pull' && pull2.fromSeq === 10, `reconnect pull fromSeq is the advanced cursor 10 (got ${JSON.stringify(pull2)})`);

  sync.close();
  console.log('OK — incremental pull verified: pulls from the persisted cursor, advances + persists on updates/ack, and re-pulls from the advanced cursor after reconnect.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
