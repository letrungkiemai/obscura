/**
 * Phase 5 — offline queue. Drives SyncClient with a fake WebSocket and a fake
 * persistent store, asserting that edits made while offline:
 *   - accumulate in the persisted outbox (survive across a simulated reload),
 *   - are (re)pushed in order on reconnect,
 *   - are removed from the outbox only when the server acks them.
 *
 * Run: ./apps/server/node_modules/.bin/tsx apps/client/src/sync/verify-offline-queue.ts
 */
import * as Y from 'yjs';
import { DEFAULT_DOC_ID } from '@obscura/shared';
import type { SyncMessage } from '@obscura/shared';
import { initCrypto } from '../crypto/sodium';
import { genDek, aeadEncrypt } from '../crypto/keys';

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
  pushes(): SyncMessage[] {
    return this.sent.filter((m) => m.type === 'push');
  }
}
(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'localhost:3000' };

async function main() {
  await initCrypto();
  const dek = genDek();
  const { SyncClient } = await import('./syncClient.js');

  const blob = (text: string): Uint8Array => {
    const d = new Y.Doc();
    let u: Uint8Array | null = null;
    d.on('update', (up: Uint8Array) => (u = up));
    d.getText('t').insert(0, text);
    return aeadEncrypt(u!, dek);
  };

  // A fake persistent store shared across "reloads" (like the doc's IndexedDB).
  const store = new Map<string, unknown>();
  const makeOpts = (doc: Y.Doc) => ({
    doc,
    dek,
    token: 'tok',
    docId: DEFAULT_DOC_ID,
    clientId: 'client-1',
    loadCursor: async () => (store.get('cursor') as number) ?? 0,
    saveCursor: (seq: number) => void store.set('cursor', seq),
    loadOutbox: async () => {
      const v = store.get('outbox');
      return typeof v === 'string' ? (JSON.parse(v) as string[]) : [];
    },
    saveOutbox: (blobs: string[]) => void store.set('outbox', JSON.stringify(blobs)),
  });

  // === Session 1: make two edits while OFFLINE (never connect) ===
  const s1 = new SyncClient(makeOpts(new Y.Doc()));
  s1.pushEncrypted(blob('hello'));
  s1.pushEncrypted(blob(' world'));
  await tick(); // let the deferred (post-init) enqueues run

  const persisted = JSON.parse(store.get('outbox') as string) as string[];
  assert(persisted.length === 2, `2 offline edits persisted to the outbox (got ${persisted.length})`);
  assert(FakeWebSocket.instances.length === 0, 'nothing was sent while offline');
  s1.close();

  // === Session 2: simulate a RELOAD — fresh client, same store, then connect ===
  const s2 = new SyncClient(makeOpts(new Y.Doc()));
  void s2.connect();
  await tick();
  const ws = FakeWebSocket.instances[0];
  assert(!!ws, 'reconnect opened a socket');
  ws.fireOpen();

  const firstPull = ws.sent.find((m) => m.type === 'pull');
  assert(!!firstPull, 'sent a pull on connect');
  const pushed = ws.pushes();
  assert(pushed.length === 2, `both offline edits were flushed on reconnect (got ${pushed.length})`);
  assert(
    pushed[0].type === 'push' && pushed[1].type === 'push' &&
      pushed[0].encryptedUpdate === persisted[0] && pushed[1].encryptedUpdate === persisted[1],
    'flushed in original FIFO order',
  );

  // Server acks the first push → only the first item leaves the outbox.
  ws.deliver({ type: 'ack', docId: DEFAULT_DOC_ID, seq: 1 });
  assert((JSON.parse(store.get('outbox') as string) as string[]).length === 1, 'one ack removes one outbox entry');

  // A new ONLINE edit sends immediately and is also tracked until acked.
  s2.pushEncrypted(blob('!'));
  await tick();
  assert(ws.pushes().length === 3, 'online edit sent immediately');
  assert((JSON.parse(store.get('outbox') as string) as string[]).length === 2, 'online edit also queued pending its ack');

  // Ack the remaining two → outbox drains to empty.
  ws.deliver({ type: 'ack', docId: DEFAULT_DOC_ID, seq: 2 });
  ws.deliver({ type: 'ack', docId: DEFAULT_DOC_ID, seq: 3 });
  assert((JSON.parse(store.get('outbox') as string) as string[]).length === 0, 'outbox empties once everything is acked');

  s2.close();
  console.log('OK — offline queue verified: edits persist while offline, survive a reload, flush in order on reconnect, and clear only on ack.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
