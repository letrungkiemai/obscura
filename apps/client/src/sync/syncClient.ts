import type * as Y from 'yjs';
import { SyncMessageSchema } from '@obscura/shared';
import type { SyncMessage } from '@obscura/shared';
import { toB64, fromB64 } from '../crypto/sodium';
import { applyEncryptedUpdate } from '../doc/encryptedUpdates';

export interface SyncClientOptions {
  doc: Y.Doc;
  /** The unlocked DEK from the session; used to decrypt incoming updates. */
  dek: Uint8Array;
  /** Opaque session token, sent in the WS query string to authenticate. */
  token: string;
  docId: string;
  /** Identifies this client as the author of its pushes (metadata only). */
  clientId: string;
  /** Namespaces the persisted last-seq cursor (e.g. user email). */
  cursorNamespace: string;
  onStatus?: (connected: boolean) => void;
}

/**
 * Client end of the encrypted sync protocol. Streams locally-encrypted updates
 * to the server, applies updates relayed from the user's other devices, and on
 * every (re)connect pulls just the updates it's missing since its last seq.
 *
 * The DEK never leaves the client: we send/receive only opaque ciphertext.
 */
export class SyncClient {
  private ws: WebSocket | null = null;
  private closed = false;
  /** Encrypted-update JSON messages queued while the socket is down. */
  private outbox: string[] = [];
  private lastSeq: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 1000;

  constructor(private readonly opts: SyncClientOptions) {
    this.lastSeq = this.readCursor();
  }

  // --- last-seq cursor (incremental pull across reloads) ---
  private get cursorKey(): string {
    return `obscura:lastseq:${this.opts.cursorNamespace}:${this.opts.docId}`;
  }
  private readCursor(): number {
    const raw = localStorage.getItem(this.cursorKey);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  private advanceCursor(seq: number): void {
    if (seq <= this.lastSeq) return;
    this.lastSeq = seq;
    localStorage.setItem(this.cursorKey, String(seq));
  }

  connect(): void {
    if (this.closed || this.ws) return;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/api/sync?token=${encodeURIComponent(this.opts.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelayMs = 1000;
      this.opts.onStatus?.(true);
      // Ask for everything we missed, then flush edits queued while offline.
      this.send({ type: 'pull', docId: this.opts.docId, fromSeq: this.lastSeq });
      for (const queued of this.outbox.splice(0)) ws.send(queued);
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
    if (msg.type === 'updates') {
      for (const u of msg.updates) {
        // Decrypt + merge. REMOTE_ORIGIN (inside applyEncryptedUpdate) keeps the
        // local hook from re-pushing what we just received. Yjs is idempotent,
        // so re-applying an update we already have is a harmless no-op.
        applyEncryptedUpdate(this.opts.doc, this.opts.dek, fromB64(u.encryptedUpdate));
        this.advanceCursor(u.seq);
      }
      return;
    }
    if (msg.type === 'ack') {
      this.advanceCursor(msg.seq);
      return;
    }
    // 'push' / 'pull' are client→server only.
  }

  /** Encrypt-then-send a local Yjs update. Wired to the encryptLocalUpdates sink. */
  pushEncrypted(blob: Uint8Array): void {
    this.send({
      type: 'push',
      docId: this.opts.docId,
      encryptedUpdate: toB64(blob),
      originClient: this.opts.clientId,
    });
  }

  private send(msg: SyncMessage): void {
    const payload = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
    } else {
      // Queue until the socket (re)opens so brief drops don't lose edits.
      this.outbox.push(payload);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
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
