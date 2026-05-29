import crypto from 'node:crypto';
import type { DocUpdate } from '@obscura/shared';

/**
 * Append-only log of encrypted CRDT updates — the sync substrate. The server
 * treats `encryptedUpdate` as opaque bytes; it only assigns a monotonic `seq`
 * per (user, doc) and relays. Scoping by user email gives strict per-user data
 * isolation: a client can only ever read/write within its own namespace.
 */
export interface UpdateStore {
  /** Append one encrypted update, assigning the next seq for (email, docId). */
  append(
    email: string,
    docId: string,
    encryptedUpdate: string,
    originClient: string,
  ): Promise<DocUpdate>;
  /** Updates for (email, docId) with seq strictly greater than `fromSeq`, in order. */
  listSince(email: string, docId: string, fromSeq: number): Promise<DocUpdate[]>;
}

/**
 * In-memory store for Phase 3. Phase 4 replaces this with a Kysely/Postgres
 * implementation behind the same interface — the `doc_updates` table with a
 * monotonic seq per doc and an index on (doc_id, seq) — no route changes needed.
 */
export class InMemoryUpdateStore implements UpdateStore {
  // email → docId → ordered updates (index in array == seq - 1).
  private logs = new Map<string, Map<string, DocUpdate[]>>();

  private logFor(email: string, docId: string): DocUpdate[] {
    let byDoc = this.logs.get(email);
    if (!byDoc) {
      byDoc = new Map();
      this.logs.set(email, byDoc);
    }
    let log = byDoc.get(docId);
    if (!log) {
      log = [];
      byDoc.set(docId, log);
    }
    return log;
  }

  async append(
    email: string,
    docId: string,
    encryptedUpdate: string,
    originClient: string,
  ): Promise<DocUpdate> {
    const log = this.logFor(email, docId);
    const update: DocUpdate = {
      id: crypto.randomUUID(),
      docId,
      seq: log.length + 1, // 1-based, monotonic per (email, docId)
      encryptedUpdate,
      originClient,
      createdAt: new Date(),
    };
    log.push(update);
    return update;
  }

  async listSince(email: string, docId: string, fromSeq: number): Promise<DocUpdate[]> {
    const log = this.logFor(email, docId);
    // seq is 1-based and contiguous, so everything after index `fromSeq`.
    return log.slice(Math.max(0, fromSeq));
  }
}
