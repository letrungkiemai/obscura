import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from './schema.js';

export type DB = Kysely<Database>;

/**
 * Resolve the Postgres connection string. Defaults to a local `obscura` db; the
 * user falls back to PGUSER / the OS user, which matches a default Homebrew
 * Postgres install (peer auth, no password).
 */
export function getDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://localhost:5432/obscura';
}

export function createDb(connectionString: string = getDatabaseUrl()): DB {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString }) }),
  });
}
