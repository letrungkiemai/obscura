import { Migrator } from 'kysely';
import type { Migration, MigrationProvider } from 'kysely';
import type { DB } from './db.js';
import * as initial from './migrations/001_initial.js';
import * as recoveryVerifier from './migrations/002_recovery_verifier.js';

// Static provider (rather than FileMigrationProvider) so it works identically
// under tsx, compiled dist, and bundlers — no filesystem globbing.
const migrations: Record<string, Migration> = {
  '001_initial': initial,
  '002_recovery_verifier': recoveryVerifier,
};

const provider: MigrationProvider = {
  getMigrations: async () => migrations,
};

/** Apply all pending migrations. Throws on the first failure. */
export async function migrateToLatest(db: DB): Promise<void> {
  const migrator = new Migrator({ db, provider });
  const { error, results } = await migrator.migrateToLatest();

  for (const r of results ?? []) {
    if (r.status === 'Success') console.log(`✓ migration applied: ${r.migrationName}`);
    else if (r.status === 'Error') console.error(`✗ migration failed: ${r.migrationName}`);
  }

  if (error) throw error instanceof Error ? error : new Error(String(error));
}
