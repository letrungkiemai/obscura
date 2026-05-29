import { Kysely, sql } from 'kysely';

/**
 * Phase 4 schema. Four tables:
 *  - users        — auth material only; nothing here can decrypt content.
 *  - documents    — per-user notes; the title is encrypted (it's content).
 *  - doc_updates  — the append-only encrypted CRDT log (the sync substrate).
 *  - snapshots    — periodic encrypted compaction so fresh devices don't replay
 *                   the whole history (used in Phase 5).
 *
 * NOTE: doc_updates / snapshots carry their own owner_id and are scoped by
 * (owner_id, doc_id) rather than FK'd to documents.id. Today the client
 * addresses its single note with a shared constant id (DEFAULT_DOC_ID), so
 * doc_id is not globally unique. Phase 6 (real per-document ids) can tighten
 * this into a documents FK.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('email', 'text', (c) => c.notNull().unique())
    .addColumn('auth_verifier_hash', 'text', (c) => c.notNull())
    .addColumn('kdf_salt', 'text', (c) => c.notNull())
    .addColumn('kdf_params', 'jsonb', (c) => c.notNull())
    .addColumn('wrapped_dek', 'text', (c) => c.notNull())
    .addColumn('wrapped_dek_recovery', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('documents')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('owner_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('encrypted_title', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('documents_owner_idx').on('documents').column('owner_id').execute();

  await db.schema
    .createTable('doc_updates')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('owner_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('doc_id', 'uuid', (c) => c.notNull())
    .addColumn('seq', 'integer', (c) => c.notNull())
    .addColumn('encrypted_update', 'bytea', (c) => c.notNull())
    .addColumn('origin_client', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  // Enforces a monotonic seq per (owner, doc) AND indexes fast incremental pulls
  // (WHERE owner_id=? AND doc_id=? AND seq>? ORDER BY seq).
  await db.schema
    .createIndex('doc_updates_owner_doc_seq_uniq')
    .on('doc_updates')
    .columns(['owner_id', 'doc_id', 'seq'])
    .unique()
    .execute();

  await db.schema
    .createTable('snapshots')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('owner_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('doc_id', 'uuid', (c) => c.notNull())
    .addColumn('encrypted_snapshot', 'bytea', (c) => c.notNull())
    .addColumn('up_to_seq', 'integer', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createIndex('snapshots_owner_doc_idx')
    .on('snapshots')
    .columns(['owner_id', 'doc_id', 'up_to_seq'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('snapshots').ifExists().execute();
  await db.schema.dropTable('doc_updates').ifExists().execute();
  await db.schema.dropTable('documents').ifExists().execute();
  await db.schema.dropTable('users').ifExists().execute();
}
