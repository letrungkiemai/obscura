import { Kysely } from 'kysely';

/**
 * Phase 7 hardening: add `recovery_verifier_hash` to users. This is the hash of
 * a verifier derived from the recovery key (the recovery analogue of
 * auth_verifier_hash). /reset demands the matching verifier as proof, so a
 * lost-passphrase reset can't be used to hijack an account.
 *
 * Nullable so existing rows migrate without a value; new signups always set it,
 * and a null leaves reset un-authorizable for that legacy account (fail-closed).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('users').addColumn('recovery_verifier_hash', 'text').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('users').dropColumn('recovery_verifier_hash').execute();
}
