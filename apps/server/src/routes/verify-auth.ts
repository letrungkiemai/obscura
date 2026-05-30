/**
 * Auth-hardening checks (Phase 7): boots the real app on an ephemeral port with
 * in-memory stores and drives the auth endpoints over HTTP. Asserts the
 * anti-enumeration decoys, the proof-of-recovery-key gate on /reset, and the
 * per-IP rate limiter — none of which need Postgres.
 *
 * Run: ./apps/server/node_modules/.bin/tsx apps/server/src/routes/verify-auth.ts
 */
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { createApp } from '../app.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const b64 = (n = 32) => crypto.randomBytes(n).toString('base64url');

async function listen(app: Hono): Promise<{ base: string; close: () => void }> {
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { base: `http://localhost:${port}/api/auth`, close: () => server.close() };
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function main() {
  const { app } = createApp();
  const { base, close } = await listen(app);

  try {
    // Register a real account; remember its credentials + recovery verifier.
    const email = 'alice@example.com';
    const authVerifier = b64();
    const recoveryVerifier = b64();
    const signupBody = {
      email,
      kdfSalt: b64(16),
      kdfParams: { opsLimit: 2, memLimit: 67108864, algorithm: 2 },
      authVerifier,
      recoveryVerifier,
      wrappedDek: b64(),
      wrappedDekRecovery: b64(),
    };
    assert((await post(base, '/signup', signupBody)).status === 201, 'signup → 201');
    assert((await post(base, '/signup', signupBody)).status === 409, 'duplicate signup → 409');

    // --- enumeration: unknown email is indistinguishable from a real one ---
    const realCh = await post(base, '/login/challenge', { email });
    const unknownCh = await post(base, '/login/challenge', { email: 'ghost@example.com' });
    assert(realCh.status === 200 && unknownCh.status === 200, 'login/challenge → 200 for both real and unknown');
    const realBody = (await realCh.json()) as { kdfSalt: string; kdfParams: unknown };
    const unknownBody = (await unknownCh.json()) as { kdfSalt: string; kdfParams: unknown };
    assert(realBody.kdfSalt === signupBody.kdfSalt, 'real challenge returns the stored salt');
    assert(typeof unknownBody.kdfSalt === 'string' && unknownBody.kdfSalt.length === realBody.kdfSalt.length, 'decoy salt is the same shape as a real one');
    assert(JSON.stringify(unknownBody.kdfParams) === JSON.stringify(realBody.kdfParams), 'decoy params match the standard defaults');
    // Decoy is deterministic per email (a real account would be stable too).
    const unknownCh2 = (await (await post(base, '/login/challenge', { email: 'ghost@example.com' })).json()) as { kdfSalt: string };
    const otherGhost = (await (await post(base, '/login/challenge', { email: 'other@example.com' })).json()) as { kdfSalt: string };
    assert(unknownCh2.kdfSalt === unknownBody.kdfSalt, 'decoy salt is stable for the same email');
    assert(otherGhost.kdfSalt !== unknownBody.kdfSalt, 'decoy salt differs across emails');

    // recover/challenge also decoys unknown emails (same blob length).
    const realRec = (await (await post(base, '/recover/challenge', { email })).json()) as { wrappedDekRecovery: string };
    const ghostRec = (await (await post(base, '/recover/challenge', { email: 'ghost@example.com' })).json()) as { wrappedDekRecovery: string };
    assert(realRec.wrappedDekRecovery === signupBody.wrappedDekRecovery, 'recover/challenge returns the stored blob for a real account');
    // Decoy is a full-size (72-byte) recovery blob — shaped like a real wrapping
    // of a 32-byte DEK (24B nonce + 32B + 16B tag) — so length can't enumerate.
    assert(Buffer.from(ghostRec.wrappedDekRecovery, 'base64url').length === 72, 'decoy recovery blob is a realistic 72 bytes');

    // --- login: bad verifier and unknown account both 401 ---
    assert((await post(base, '/login', { email, authVerifier: b64() })).status === 401, 'wrong verifier → 401');
    assert((await post(base, '/login', { email: 'ghost@example.com', authVerifier: b64() })).status === 401, 'unknown account login → 401');
    assert((await post(base, '/login', { email, authVerifier })).status === 200, 'correct verifier → 200');

    // --- reset requires proof-of-recovery-key ---
    const newAuthVerifier = b64();
    const resetBody = (rv: string) => ({
      email,
      kdfSalt: b64(16),
      kdfParams: { opsLimit: 2, memLimit: 67108864, algorithm: 2 },
      authVerifier: newAuthVerifier,
      recoveryVerifier: rv,
      wrappedDek: b64(),
      wrappedDekRecovery: signupBody.wrappedDekRecovery,
    });
    assert((await post(base, '/reset', resetBody(b64()))).status === 401, 'reset with wrong recovery verifier → 401');
    assert((await post(base, '/reset', resetBody(recoveryVerifier))).status === 200, 'reset with correct recovery verifier → 200');
    assert((await post(base, '/reset', { ...resetBody(recoveryVerifier), email: 'ghost@example.com' })).status === 401, 'reset for unknown account → 401');

    // After reset: new verifier logs in, old one is rejected.
    assert((await post(base, '/login', { email, authVerifier: newAuthVerifier })).status === 200, 'login with the reset verifier → 200');
    assert((await post(base, '/login', { email, authVerifier })).status === 401, 'the pre-reset verifier no longer works');

    close();

    // --- rate limiter: isolated fresh app so its bucket starts empty ---
    const fresh = await listen(createApp().app);
    let limited = false;
    for (let i = 0; i < 65; i++) {
      const r = await post(fresh.base, '/login/challenge', { email });
      if (r.status === 429) { limited = true; break; }
    }
    fresh.close();
    assert(limited, 'auth routes return 429 once the per-window limit is exceeded');

    console.log('OK — anti-enumeration decoys (login + recover challenge), proof-of-recovery-key reset, and auth rate limiting all verified.');
    process.exit(0);
  } catch (err) {
    close();
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
