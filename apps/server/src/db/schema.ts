import type { ColumnType, Generated } from 'kysely';
import type { KdfParams } from '@obscura/shared';

/**
 * Kysely table types for the Phase 4 schema. Everything content-bearing is
 * opaque to the server: `kdf_params` + the wrapped-DEK blobs reveal nothing,
 * `encrypted_*` columns are ciphertext (bytea). The server only ever sorts,
 * counts, and relays.
 */

interface UsersTable {
  id: Generated<string>;
  email: string;
  auth_verifier_hash: string;
  kdf_salt: string;
  // jsonb: read back as a parsed object, written as a JSON string (see stores).
  kdf_params: ColumnType<KdfParams, string, string>;
  wrapped_dek: string;
  wrapped_dek_recovery: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

interface DocumentsTable {
  id: Generated<string>;
  owner_id: string;
  encrypted_title: string; // the title is content, so it's encrypted too
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

interface DocUpdatesTable {
  id: Generated<string>;
  owner_id: string;
  doc_id: string;
  seq: number; // monotonic per (owner_id, doc_id)
  encrypted_update: Buffer; // bytea — opaque XChaCha20-Poly1305 ciphertext
  origin_client: string;
  created_at: Generated<Date>;
}

interface SnapshotsTable {
  id: Generated<string>;
  owner_id: string;
  doc_id: string;
  encrypted_snapshot: Buffer; // bytea
  up_to_seq: number;
  created_at: Generated<Date>;
}

export interface Database {
  users: UsersTable;
  documents: DocumentsTable;
  doc_updates: DocUpdatesTable;
  snapshots: SnapshotsTable;
}
