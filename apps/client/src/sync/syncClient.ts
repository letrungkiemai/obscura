import * as Y from 'yjs';
import { SyncMessageSchema } from '@obscura/shared';
import type { SyncMessage } from '@obscura/shared';
import { toB64, fromB64 } from '../crypto/sodium';
import { aeadEncrypt } from '../crypto/keys';
import { applyEncryptedUpdate } from '../doc/encryptedUpdates';

export interface SyncClientOptions {
  doc: Y.Doc;
  /** The unlocked DEK from the session; used to decrypt incoming updates. */
  dek: Uint8Array;
  /**
   * Mint a fresh single-use ticket for opening the socket. Called on every
   * (re)connect; the long-lived session token stays in an Authorization header
   * inside this callback and never touches the WS URL. Returns null when auth
   * fails (e.g. expired session), in which case we back off and retry.
   */
  getTicket: () => Promise<string | null>;
  docId: string;
  /** Identifies this client as the author of its pushes (metadata only). */
  clientId: string;
  /**
   * Read the last seq this client has applied. Must be persisted in the SAME
   * storage as the Yjs doc (its IndexedDB) so the two share one lifecycle — if
   * the local doc is wiped the cursor goes with it, forcing a full re-pull
   * rather than silently skipping updates the doc no longer has. Returns 0 when
   * absent (pull everything).
   */
  loadCursor: () => Promise<number>;
  /** Persist the new high-water mark next to the doc. */
  saveCursor: (seq: number) => void;
  /**
   * Read the persisted outbox — encrypted updates produced locally that the
   * server has not acked yet. Stored next to the doc so edits made offline
   * survive a reload and still get pushed on reconnect. Returns [] when absent.
   */
  loadOutbox: () => Promise<string[]>;
  /** Persist the current outbox next to the doc. */
  saveOutbox: (blobs: string[]) => void;
  /**
   * Upload an encrypted full-state snapshot once this many new seqs have
   * accumulated since the last one, letting the server prune older updates so a
   * fresh device doesn't replay the whole history. Defaults to 200.
   */
  snapshotInterval?: number;
  onStatus?: (connected: boolean) => void;
}

/**
 * Client end of the encrypted sync protocol. Streams locally-encrypted updates
 * to the server, applies updates relayed from the user's other devices, and on
 * every (re)connect pulls just the updates it's missing since its last seq.
 *
 * Delivery is at-least-once: every local update is appended to a persistent
 * outbox, (re)sent on connect, and removed only when the server acks it. A blob
 * that's re-sent because its ack was lost is appended again server-side, but
 * decrypting+applying it elsewhere is an idempotent Yjs no-op — so duplicates
 * are harmless and offline edits are never lost.
 *
 * The DEK never leaves the client: we send/receive only opaque ciphertext.
 */
export class SyncClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private connecting = false;
  /** Encrypted blobs (base64) pushed but not yet acked, oldest first. */
  private outbox: string[] = [];
  /** Last seq applied. */
  private lastSeq = 0;
  /** Seq covered by the most recent snapshot we sent or restored from. */
  private lastSnapshotSeq = 0;
  private readonly snapshotInterval: number;
  /** Resolves once the persisted cursor + outbox have been loaded. */
  private readonly ready: Promise<void>;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 1000;

  constructor(private readonly opts: SyncClientOptions) {
    this.snapshotInterval = opts.snapshotInterval ?? 200;
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    try {
      this.lastSeq = await this.opts.loadCursor();
    } catch {
      this.lastSeq = 0; // unreadable cursor → safe full pull
    }
    try {
      // Persisted (prior-session) blobs are the oldest unacked; they go first.
      this.outbox = await this.opts.loadOutbox();
    } catch {
      this.outbox = [];
    }
  }

  private advanceCursor(seq: number): void {
    if (seq <= this.lastSeq) return;
    this.lastSeq = seq;
    // A late async write that lands out of order could at worst persist a lower
    // value, causing one redundant re-pull on reconnect (Yjs dedups) — never a
    // gap, because any seq we skip is one we authored and already hold locally.
    this.opts.saveCursor(this.lastSeq);
  }

  async connect(): Promise<void> {
    if (this.closed || this.ws || this.connecting) return;
    this.connecting = true;
    try {
      await this.ready; // cursor + outbox loaded before we pull / flush
      if (this.closed || this.ws) return; // state may have changed during await

      // Mint a fresh single-use ticket; only it (not the session token) rides
      // the URL. If auth fails or the network is down, back off and retry.
      const ticket = await this.opts.getTicket().catch(() => null);
      if (this.closed || this.ws) return; // state may have changed during await
      if (!ticket) {
        this.scheduleReconnect();
        return;
      }

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/api/sync?ticket=${encodeURIComponent(ticket)}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      this.wire(ws);
    } finally {
      this.connecting = false;
    }
  }

  private wire(ws: WebSocket): void {
    ws.onopen = () => {
      this.reconnectDelayMs = 1000;
      this.opts.onStatus?.(true);
      // Pull what we missed, then (re)send every still-unacked local update.
      this.sendIfOpen({ type: 'pull', docId: this.opts.docId, fromSeq: this.lastSeq });
      for (const blob of this.outbox) this.sendPush(blob);
    };

    ws.onmessage = (evt) => {
      if (typeof evt.data !== 'string') return;
      let json: unknown;
      try {
        json = JSON.parse(evt.data);
      } catch {
        return;
      }
      const parsed = SyncMessageSchema.safeParse(json);
      if (parsed.success) this.handle(parsed.data);
    };

    ws.onclose = () => {
      this.ws = null;
      this.opts.onStatus?.(false);
      this.scheduleReconnect();
    };

    // onerror is followed by onclose; let the close handler do the reconnect.
    ws.onerror = () => ws.close();
  }

  private handle(msg: SyncMessage): void {
    if (msg.type === 'snapshot') {
      // Restore from a compaction snapshot (sent before the tail on pull when we
      // were behind it). It's a full-state Yjs update, so applying it is a merge
      // — safe whether our doc is empty or partially populated.
      applyEncryptedUpdate(this.opts.doc, this.opts.dek, fromB64(msg.encryptedSnapshot));
      if (msg.upToSeq > this.lastSnapshotSeq) this.lastSnapshotSeq = msg.upToSeq;
      this.advanceCursor(msg.upToSeq);
      return;
    }
    if (msg.type === 'updates') {
      for (const u of msg.updates) {
        // Decrypt + merge. REMOTE_ORIGIN (inside applyEncryptedUpdate) keeps the
        // local hook from re-pushing what we just received. Yjs is idempotent,
        // so re-applying an update we already have is a harmless no-op.
        applyEncryptedUpdate(this.opts.doc, this.opts.dek, fromB64(u.encryptedUpdate));
        this.advanceCursor(u.seq);
      }
      this.maybeCompact();
      return;
    }
    if (msg.type === 'ack') {
      this.advanceCursor(msg.seq);
      // Acks arrive in push order over a connection, so the front of the outbox
      // is the one being acked — drop it. (Worst case after an odd reconnect we
      // drop a blob that gets re-sent anyway; idempotency keeps that safe.)
      if (this.outbox.length > 0) {
        this.outbox.shift();
        this.opts.saveOutbox(this.outbox);
      }
      this.maybeCompact();
      return;
    }
    // 'push' / 'pull' are client→server only.
  }

  /**
   * Periodically upload an encrypted full-state snapshot so the server can prune
   * the updates it covers. Tagged with the highest seq we've applied; the doc
   * always contains everything up to that seq (plus, harmlessly, any not-yet-
   * acked local edits), so the snapshot is a safe superset to prune against.
   */
  private maybeCompact(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.lastSeq - this.lastSnapshotSeq < this.snapshotInterval) return;
    const upToSeq = this.lastSeq;
    const snapshot = aeadEncrypt(Y.encodeStateAsUpdate(this.opts.doc), this.opts.dek);
    this.lastSnapshotSeq = upToSeq; // set before send so we don't re-trigger
    this.sendIfOpen({
      type: 'snapshot',
      docId: this.opts.docId,
      encryptedSnapshot: toB64(snapshot),
      upToSeq,
    });
  }

  /** Encrypt-then-queue a local Yjs update. Wired to the encryptLocalUpdates sink. */
  pushEncrypted(blob: Uint8Array): void {
    const b64 = toB64(blob);
    // Defer past init so we never persist on top of an outbox we haven't loaded.
    void this.ready.then(() => {
      this.outbox.push(b64);
      this.opts.saveOutbox(this.outbox);
      this.sendPush(b64); // sends now if online; otherwise it waits in the outbox
    });
  }

  private sendPush(blob: string): void {
    this.sendIfOpen({
      type: 'push',
      docId: this.opts.docId,
      encryptedUpdate: blob,
      originClient: this.opts.clientId,
    });
  }

  /** Send only if the socket is open; otherwise drop the wire message (the
   * durable state lives in the outbox + cursor, which drive the next connect). */
  private sendIfOpen(msg: SyncMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.reconnectDelayMs);
    // Exponential backoff, capped at 15s.
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 15000);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }
}
