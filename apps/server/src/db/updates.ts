import crypto from 'node:crypto';
import { sql } from 'kysely';
import type { DocUpdate } from '@obscura/shared';
import type { DB } from './db.js';

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
 * Postgres-backed append log (the `doc_updates` table). Scoped by (owner, doc):
 * the owner is resolved from the session email, giving strict per-user data
 * isolation — a client can never read or write outside its own rows.
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
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await sql<UpdateRow>`
          INSERT INTO doc_updates (owner_id, doc_id, seq, encrypted_update, origin_client)
          SELECT
            u.id,
            ${docId}::uuid,
            COALESCE(
              (SELECT MAX(d.seq) FROM doc_updates d WHERE d.owner_id = u.id AND d.doc_id = ${docId}::uuid),
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
}
