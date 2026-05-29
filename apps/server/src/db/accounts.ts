import type { KdfParams } from '@obscura/shared';

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
