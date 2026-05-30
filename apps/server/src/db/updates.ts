import crypto from 'node:crypto';
import { sql } from 'kysely';
import type { DocUpdate } from '@obscura/shared';
import type { DB } from './db.js';

/** A stored encrypted snapshot: the full doc state as of `upToSeq`. */
export interface Snapshot {
  encryptedSnapshot: string;
  upToSeq: number;
}

/**
 * Append-only log of encrypted CRDT updates — the sync substrate. The server
 * treats `encryptedUpdate` / `encryptedSnapshot` as opaque bytes; it only
 * assigns a monotonic `seq` per (user, doc), relays, and compacts. Scoping by
 * user email gives strict per-user isolation: a client can only ever read/write
 * within its own namespace.
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
  /**
   * Store a snapshot covering [1..upToSeq] and prune the now-redundant updates
   * (seq ≤ upToSeq). Only the latest snapshot is kept; a stale snapshot (upToSeq
   * not beyond the current one) is ignored. Pruning is safe because pull serves
   * the snapshot to any device still behind it.
   */
  saveSnapshot(email: string, docId: string, encryptedSnapshot: string, upToSeq: number): Promise<void>;
  /** The most recent snapshot for (email, docId), or null if none. */
  getLatestSnapshot(email: string, docId: string): Promise<Snapshot | null>;
}

interface DocLog {
  updates: DocUpdate[];
  nextSeq: number; // independent of the array so pruning can't corrupt numbering
  snapshot: Snapshot | null;
}

/**
 * In-memory store for Phase 3. Phase 4 provides a Kysely/Postgres implementation
 * behind the same interface; this stays the default for tests / no-DB mode.
 */
export class InMemoryUpdateStore implements UpdateStore {
  private logs = new Map<string, Map<string, DocLog>>();

  private logFor(email: string, docId: string): DocLog {
    let byDoc = this.logs.get(email);
    if (!byDoc) {
      byDoc = new Map();
      this.logs.set(email, byDoc);
    }
    let log = byDoc.get(docId);
    if (!log) {
      log = { updates: [], nextSeq: 1, snapshot: null };
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
      seq: log.nextSeq++, // monotonic per (email, docId), never reused
      encryptedUpdate,
      originClient,
      createdAt: new Date(),
    };
    log.updates.push(update);
    return update;
  }

  async listSince(email: string, docId: string, fromSeq: number): Promise<DocUpdate[]> {
    return this.logFor(email, docId).updates.filter((u) => u.seq > fromSeq);
  }

  async saveSnapshot(email: string, docId: string, encryptedSnapshot: string, upToSeq: number): Promise<void> {
    const log = this.logFor(email, docId);
    if (log.snapshot && upToSeq <= log.snapshot.upToSeq) return; // stale, ignore
    log.snapshot = { encryptedSnapshot, upToSeq };
    log.updates = log.updates.filter((u) => u.seq > upToSeq); // prune covered updates
  }

  async getLatestSnapshot(email: string, docId: string): Promise<Snapshot | null> {
    return this.logFor(email, docId).snapshot;
  }
}

interface UpdateRow {
  id: string;
  doc_id: string;
  seq: number;
  encrypted_update: Buffer;
  origin_client: string;
  created_at: Date;
}

function toDocUpdate(r: UpdateRow): DocUpdate {
  return {
    id: r.id,
    docId: r.doc_id,
    seq: r.seq,
    // bytea ⇄ the base64url string the wire protocol uses (matches libsodium's
    // URLSAFE_NO_PADDING on the client, so blobs round-trip byte-for-byte).
    encryptedUpdate: r.encrypted_update.toString('base64url'),
    originClient: r.origin_client,
    createdAt: r.created_at,
  };
}

/**
 * Postgres-backed append log (the `doc_updates` + `snapshots` tables). Scoped by
 * (owner, doc): the owner is resolved from the session email, giving strict
 * per-user data isolation — a client can never read or write outside its rows.
 */
export class PostgresUpdateStore implements UpdateStore {
  constructor(private readonly db: DB) {}

  async append(
    email: string,
    docId: string,
    encryptedUpdate: string,
    originClient: string,
  ): Promise<DocUpdate> {
    const bytes = Buffer.from(encryptedUpdate, 'base64url');

    // Compute the next seq atomically inside the INSERT. The unique index on
    // (owner_id, doc_id, seq) makes a concurrent collision a 23505 error; we
    // just retry, so seq stays gap-free and monotonic without table locks.
    // MAX(seq) keeps climbing even after pruning, so seqs are never reused.
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await sql<UpdateRow>`
          INSERT INTO doc_updates (owner_id, doc_id, seq, encrypted_update, origin_client)
          SELECT
            u.id,
            ${docId}::uuid,
            COALESCE(
              (SELECT MAX(d.seq) FROM doc_updates d WHERE d.owner_id = u.id AND d.doc_id = ${docId}::uuid),
              (SELECT MAX(s.up_to_seq) FROM snapshots s WHERE s.owner_id = u.id AND s.doc_id = ${docId}::uuid),
              0
            ) + 1,
            ${bytes},
            ${originClient}
          FROM users u
          WHERE u.email = ${email}
          RETURNING id, doc_id, seq, encrypted_update, origin_client, created_at
        `.execute(this.db);

        const row = result.rows[0];
        if (!row) throw new Error(`append: no account for ${email}`);
        return toDocUpdate(row);
      } catch (err) {
        // 23505 = unique_violation: another append took our seq; retry.
        if ((err as { code?: string }).code === '23505' && attempt < 5) continue;
        throw err;
      }
    }
  }

  async listSince(email: string, docId: string, fromSeq: number): Promise<DocUpdate[]> {
    const rows = await this.db
      .selectFrom('doc_updates as d')
      .innerJoin('users as u', 'u.id', 'd.owner_id')
      .select(['d.id', 'd.doc_id', 'd.seq', 'd.encrypted_update', 'd.origin_client', 'd.created_at'])
      .where('u.email', '=', email)
      .where('d.doc_id', '=', docId)
      .where('d.seq', '>', fromSeq)
      .orderBy('d.seq', 'asc')
      .execute();
    return rows.map(toDocUpdate);
  }

  async saveSnapshot(email: string, docId: string, encryptedSnapshot: string, upToSeq: number): Promise<void> {
    const bytes = Buffer.from(encryptedSnapshot, 'base64url');
    await this.db.transaction().execute(async (tx) => {
      const user = await tx
        .selectFrom('users')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirst();
      if (!user) return;

      // Ignore a stale snapshot that doesn't advance past the current one.
      const current = await tx
        .selectFrom('snapshots')
        .select((eb) => eb.fn.max('up_to_seq').as('max'))
        .where('owner_id', '=', user.id)
        .where('doc_id', '=', docId)
        .executeTakeFirst();
      if (current?.max != null && upToSeq <= current.max) return;

      // Keep exactly one snapshot per (owner, doc), and prune covered updates.
      await tx.deleteFrom('snapshots').where('owner_id', '=', user.id).where('doc_id', '=', docId).execute();
      await tx
        .insertInto('snapshots')
        .values({ owner_id: user.id, doc_id: docId, encrypted_snapshot: bytes, up_to_seq: upToSeq })
        .execute();
      await tx
        .deleteFrom('doc_updates')
        .where('owner_id', '=', user.id)
        .where('doc_id', '=', docId)
        .where('seq', '<=', upToSeq)
        .execute();
    });
  }

  async getLatestSnapshot(email: string, docId: string): Promise<Snapshot | null> {
    const row = await this.db
      .selectFrom('snapshots as s')
      .innerJoin('users as u', 'u.id', 's.owner_id')
      .select(['s.encrypted_snapshot', 's.up_to_seq'])
      .where('u.email', '=', email)
      .where('s.doc_id', '=', docId)
      .orderBy('s.up_to_seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    return { encryptedSnapshot: row.encrypted_snapshot.toString('base64url'), upToSeq: row.up_to_seq };
  }
}
