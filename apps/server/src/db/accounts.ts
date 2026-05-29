import { sql } from 'kysely';
import type { KdfParams } from '@obscura/shared';
import type { DB } from './db.js';

/**
 * What the server stores per account. Note there is nothing here that can
 * decrypt the user's content: only KDF params, a *hash* of the auth verifier,
 * and the two opaque wrapped-DEK blobs.
 */
export interface Account {
  email: string;
  kdfSalt: string;
  kdfParams: KdfParams;
  authVerifierHash: string;
  wrappedDek: string;
  wrappedDekRecovery: string;
}

export interface AccountStore {
  create(account: Account): Promise<void>;
  findByEmail(email: string): Promise<Account | null>;
  update(email: string, patch: Partial<Account>): Promise<void>;
}

/**
 * In-memory store for Phase 1. Phase 4 replaces this with a Kysely/Postgres
 * implementation behind the same interface — no route changes required.
 */
export class InMemoryAccountStore implements AccountStore {
  private accounts = new Map<string, Account>();

  async create(account: Account): Promise<void> {
    this.accounts.set(account.email, account);
  }

  async findByEmail(email: string): Promise<Account | null> {
    return this.accounts.get(email) ?? null;
  }

  async update(email: string, patch: Partial<Account>): Promise<void> {
    const current = this.accounts.get(email);
    if (current) this.accounts.set(email, { ...current, ...patch });
  }
}

/** Postgres-backed account store (the `users` table). Same interface, no route changes. */
export class PostgresAccountStore implements AccountStore {
  constructor(private readonly db: DB) {}

  async create(account: Account): Promise<void> {
    await this.db
      .insertInto('users')
      .values({
        email: account.email,
        auth_verifier_hash: account.authVerifierHash,
        kdf_salt: account.kdfSalt,
        // jsonb column: bind a JSON string and cast, so any value (incl. one
        // that looks like a bare SQL token) is stored verbatim.
        kdf_params: sql`${JSON.stringify(account.kdfParams)}::jsonb`,
        wrapped_dek: account.wrappedDek,
        wrapped_dek_recovery: account.wrappedDekRecovery,
      })
      .execute();
  }

  async findByEmail(email: string): Promise<Account | null> {
    const row = await this.db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', email)
      .executeTakeFirst();
    if (!row) return null;
    return {
      email: row.email,
      kdfSalt: row.kdf_salt,
      kdfParams: row.kdf_params, // jsonb is parsed back to an object by pg
      authVerifierHash: row.auth_verifier_hash,
      wrappedDek: row.wrapped_dek,
      wrappedDekRecovery: row.wrapped_dek_recovery,
    };
  }

  async update(email: string, patch: Partial<Account>): Promise<void> {
    const set: Record<string, unknown> = { updated_at: sql`now()` };
    if (patch.kdfSalt !== undefined) set.kdf_salt = patch.kdfSalt;
    if (patch.kdfParams !== undefined) set.kdf_params = sql`${JSON.stringify(patch.kdfParams)}::jsonb`;
    if (patch.authVerifierHash !== undefined) set.auth_verifier_hash = patch.authVerifierHash;
    if (patch.wrappedDek !== undefined) set.wrapped_dek = patch.wrappedDek;
    if (patch.wrappedDekRecovery !== undefined) set.wrapped_dek_recovery = patch.wrappedDekRecovery;

    await this.db.updateTable('users').set(set).where('email', '=', email).execute();
  }
}
