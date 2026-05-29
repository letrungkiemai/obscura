import { Hono } from 'hono';
import crypto from 'node:crypto';
import {
  LoginChallengeRequestSchema,
  LoginRequestSchema,
  ResetRequestSchema,
  SignupRequestSchema,
} from '@obscura/shared';
import type { AccountStore } from '../db/accounts.js';

/**
 * The auth verifier arriving from the client is already a 256-bit high-entropy
 * key (Argon2id was done client-side), so a single fast hash is enough to avoid
 * storing it raw — a read-only DB leak then can't be replayed as a login.
 */
function hashVerifier(authVerifierB64: string): string {
  return crypto.createHash('sha256').update(Buffer.from(authVerifierB64, 'base64url')).digest('base64url');
}

export function authRoutes(store: AccountStore, sessions: Map<string, string>) {
  const app = new Hono();

  app.post('/signup', async (c) => {
    const parsed = SignupRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const d = parsed.data;

    if (await store.findByEmail(d.email)) return c.json({ error: 'email_taken' }, 409);

    await store.create({
      email: d.email,
      kdfSalt: d.kdfSalt,
      kdfParams: d.kdfParams,
      authVerifierHash: hashVerifier(d.authVerifier),
      wrappedDek: d.wrappedDek,
      wrappedDekRecovery: d.wrappedDekRecovery,
    });
    return c.json({ ok: true }, 201);
  });

  // Returns the KDF salt+params so a fresh device can derive the keys.
  // NOTE (Phase 7): this leaks account existence — add rate limiting / a
  // dummy-params response to prevent user enumeration before shipping.
  app.post('/login/challenge', async (c) => {
    const parsed = LoginChallengeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const acc = await store.findByEmail(parsed.data.email);
    if (!acc) return c.json({ error: 'not_found' }, 404);
    return c.json({ kdfSalt: acc.kdfSalt, kdfParams: acc.kdfParams });
  });

  app.post('/login', async (c) => {
    const parsed = LoginRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const acc = await store.findByEmail(parsed.data.email);
    if (!acc) return c.json({ error: 'invalid_credentials' }, 401);

    const provided = Buffer.from(hashVerifier(parsed.data.authVerifier), 'base64url');
    const stored = Buffer.from(acc.authVerifierHash, 'base64url');
    if (provided.length !== stored.length || !crypto.timingSafeEqual(provided, stored)) {
      return c.json({ error: 'invalid_credentials' }, 401);
    }

    const sessionToken = crypto.randomBytes(32).toString('base64url');
    sessions.set(sessionToken, acc.email);
    return c.json({ sessionToken, wrappedDek: acc.wrappedDek });
  });

  // Recovery: hand back the recovery-wrapped DEK so a client holding the
  // recovery key can unwrap it locally and then reset the passphrase.
  app.post('/recover/challenge', async (c) => {
    const parsed = LoginChallengeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const acc = await store.findByEmail(parsed.data.email);
    if (!acc) return c.json({ error: 'not_found' }, 404);
    return c.json({ wrappedDekRecovery: acc.wrappedDekRecovery });
  });

  // NOTE (Phase 7): this happy-path reset is NOT yet authorized — anyone could
  // overwrite an account's credentials (a lockout/DoS vector). Gate it behind
  // proof-of-recovery-key or an email round-trip before shipping.
  app.post('/reset', async (c) => {
    const parsed = ResetRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const d = parsed.data;
    const acc = await store.findByEmail(d.email);
    if (!acc) return c.json({ error: 'not_found' }, 404);

    await store.update(d.email, {
      kdfSalt: d.kdfSalt,
      kdfParams: d.kdfParams,
      authVerifierHash: hashVerifier(d.authVerifier),
      wrappedDek: d.wrappedDek,
      wrappedDekRecovery: d.wrappedDekRecovery,
    });
    return c.json({ ok: true });
  });

  return app;
}
