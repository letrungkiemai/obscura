import { Hono } from 'hono';
import crypto from 'node:crypto';
import {
  LoginChallengeRequestSchema,
  LoginRequestSchema,
  ResetRequestSchema,
  SignupRequestSchema,
} from '@obscura/shared';
import type { KdfParams } from '@obscura/shared';
import type { AccountStore } from '../db/accounts.js';
import { rateLimit } from './rateLimit.js';

/**
 * The auth verifier arriving from the client is already a 256-bit high-entropy
 * key (Argon2id was done client-side), so a single fast hash is enough to avoid
 * storing it raw — a read-only DB leak then can't be replayed as a login. The
 * recovery verifier is hashed the same way.
 */
function hashVerifier(verifierB64: string): string {
  return crypto.createHash('sha256').update(Buffer.from(verifierB64, 'base64url')).digest('base64url');
}

/** Constant-time compare of a client-provided verifier against a stored hash. */
function verifierMatches(providedB64: string, storedHashB64: string): boolean {
  const provided = Buffer.from(hashVerifier(providedB64), 'base64url');
  const stored = Buffer.from(storedHashB64, 'base64url');
  return provided.length === stored.length && crypto.timingSafeEqual(provided, stored);
}

/**
 * Secret used only to synthesize *decoy* challenge responses for unknown
 * accounts, so /login/challenge and /recover/challenge can't be used to probe
 * which emails exist. Stable across restarts when AUTH_DECOY_SECRET is set;
 * otherwise random per-boot (a weak distinguisher across restarts, hence the
 * warning). It never touches real account data.
 */
const DECOY_SECRET = process.env.AUTH_DECOY_SECRET
  ? Buffer.from(process.env.AUTH_DECOY_SECRET)
  : (console.warn('⚠ AUTH_DECOY_SECRET not set — using a random per-boot decoy secret.'), crypto.randomBytes(32));

// Mirror the client's INTERACTIVE Argon2id defaults (libsodium constants) so a
// decoy challenge is byte-shaped identically to a real one.
const SALT_BYTES = 16; // crypto_pwhash_SALTBYTES
const RECOVERY_BLOB_BYTES = 72; // 24B nonce + 32B key + 16B AEAD tag
const DECOY_KDF_PARAMS: KdfParams = { opsLimit: 2, memLimit: 67108864, algorithm: 2 };

/** Deterministic per-email pseudo-random bytes — same email always decoys alike. */
function decoyBytes(label: string, email: string, len: number): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', DECOY_SECRET, Buffer.from(email), label, len));
}

export function authRoutes(store: AccountStore, sessions: Map<string, string>) {
  const app = new Hono();

  // Coarse ceiling on auth traffic (brute-force / enumeration spam). The
  // endpoints are independently non-enumerating; this is defense in depth.
  app.use('*', rateLimit({ windowMs: 60_000, max: 60 }));

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
      recoveryVerifierHash: hashVerifier(d.recoveryVerifier),
      wrappedDek: d.wrappedDek,
      wrappedDekRecovery: d.wrappedDekRecovery,
    });
    return c.json({ ok: true }, 201);
  });

  // Returns the KDF salt+params so a fresh device can derive the keys. For an
  // unknown email we return a deterministic decoy (same shape, stable per email)
  // instead of 404, so the response can't be used to enumerate accounts.
  app.post('/login/challenge', async (c) => {
    const parsed = LoginChallengeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const email = parsed.data.email;
    const acc = await store.findByEmail(email);
    if (!acc) {
      return c.json({ kdfSalt: decoyBytes('login-salt', email, SALT_BYTES).toString('base64url'), kdfParams: DECOY_KDF_PARAMS });
    }
    return c.json({ kdfSalt: acc.kdfSalt, kdfParams: acc.kdfParams });
  });

  app.post('/login', async (c) => {
    const parsed = LoginRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const acc = await store.findByEmail(parsed.data.email);
    // For an unknown account, still spend a constant-time compare against a
    // decoy so timing doesn't reveal whether the email exists.
    if (!acc) {
      verifierMatches(parsed.data.authVerifier, decoyBytes('login-hash', parsed.data.email, 32).toString('base64url'));
      return c.json({ error: 'invalid_credentials' }, 401);
    }
    if (!verifierMatches(parsed.data.authVerifier, acc.authVerifierHash)) {
      return c.json({ error: 'invalid_credentials' }, 401);
    }

    const sessionToken = crypto.randomBytes(32).toString('base64url');
    sessions.set(sessionToken, acc.email);
    return c.json({ sessionToken, wrappedDek: acc.wrappedDek });
  });

  // Recovery: hand back the recovery-wrapped DEK so a client holding the
  // recovery key can unwrap it locally and then reset the passphrase. Unknown
  // emails get a deterministic decoy blob (same length) rather than a 404, so
  // this endpoint can't enumerate accounts either. (A decoy can't actually be
  // unwrapped — only a real recovery-key holder gets a usable DEK.)
  app.post('/recover/challenge', async (c) => {
    const parsed = LoginChallengeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const email = parsed.data.email;
    const acc = await store.findByEmail(email);
    if (!acc) {
      return c.json({ wrappedDekRecovery: decoyBytes('recovery-blob', email, RECOVERY_BLOB_BYTES).toString('base64url') });
    }
    return c.json({ wrappedDekRecovery: acc.wrappedDekRecovery });
  });

  // Reset is authorized by proof-of-recovery-key: the client presents the
  // recovery verifier, which must match the stored hash. Without it, anyone
  // could overwrite an account's credentials (account-takeover / lockout). The
  // recovery key is unchanged by a reset, so its stored hash stays valid and is
  // left untouched. Unknown account, missing hash, and mismatch all return the
  // same 401 so reset can't enumerate accounts.
  app.post('/reset', async (c) => {
    const parsed = ResetRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const d = parsed.data;
    const acc = await store.findByEmail(d.email);
    if (!acc || !acc.recoveryVerifierHash || !verifierMatches(d.recoveryVerifier, acc.recoveryVerifierHash)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

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
