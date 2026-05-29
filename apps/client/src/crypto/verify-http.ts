/**
 * End-to-end auth flow against a live server (http://localhost:3000).
 * Run with the server already started:
 *   tsx apps/client/src/crypto/verify-http.ts
 */
import { initCrypto } from './sodium';
import { registerAccount, deriveLoginCredentials, unwrapDek } from './account';

const BASE = 'http://localhost:3000/api/auth';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) } as const;
}

async function main() {
  await initCrypto();
  const email = `e2e-${Date.now()}@example.com`;
  const passphrase = 'correct horse battery staple';

  // Signup
  const reg = registerAccount(email, passphrase);
  const signup = await post('/signup', reg.payload);
  console.log('[signup]', signup.status, JSON.stringify(signup.json));
  if (signup.status !== 201) throw new Error('signup failed');

  // Duplicate signup should 409
  const dup = await post('/signup', reg.payload);
  console.log('[signup dup]', dup.status, JSON.stringify(dup.json));
  if (dup.status !== 409) throw new Error('expected 409 on duplicate');

  // Login challenge -> get salt + params (fresh device knows only the passphrase)
  const challenge = await post('/login/challenge', { email });
  console.log('[challenge]', challenge.status, JSON.stringify(challenge.json));
  if (challenge.status !== 200) throw new Error('challenge failed');

  // Derive credentials and log in
  const creds = deriveLoginCredentials(passphrase, challenge.json.kdfSalt, challenge.json.kdfParams);
  const login = await post('/login', { email, authVerifier: creds.authVerifier });
  console.log('[login]', login.status, 'token len', login.json?.sessionToken?.length);
  if (login.status !== 200) throw new Error('login failed');

  // Unwrap the DEK returned by the server and confirm it matches the original
  const dek = unwrapDek(login.json.wrappedDek, creds.masterKey);
  if (!bytesEqual(dek, reg.keys.dek)) throw new Error('unwrapped DEK mismatch');
  console.log('[verify] DEK from server login matches original DEK ✔');

  // Wrong passphrase should 401
  const wrong = deriveLoginCredentials('nope', challenge.json.kdfSalt, challenge.json.kdfParams);
  const badLogin = await post('/login', { email, authVerifier: wrong.authVerifier });
  console.log('[login wrong-pass]', badLogin.status, JSON.stringify(badLogin.json));
  if (badLogin.status !== 401) throw new Error('expected 401 for wrong passphrase');

  console.log('\nAll HTTP auth flows passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
