import { registerAccount, deriveLoginCredentials, unwrapDek } from '../crypto/account';
import * as api from '../api';

/** The in-memory session a logged-in user holds. Keys never persist to disk. */
export interface Session {
  email: string;
  sessionToken: string;
  masterKey: Uint8Array;
  dek: Uint8Array;
}

/**
 * Sign up, then immediately log in to obtain a session token (signup itself
 * doesn't issue one). Returns the recovery key to show the user exactly once.
 */
export async function signupFlow(
  email: string,
  passphrase: string,
): Promise<{ session: Session; recoveryKey: string }> {
  const reg = registerAccount(email, passphrase);

  const created = await api.signup(reg.payload);
  if (created.status === 409) throw new Error('That email is already registered.');
  if (created.status !== 201) throw new Error('Signup failed. Please try again.');

  // Reuse the auth verifier we already derived to grab a session token.
  const loggedIn = await api.login(email, reg.payload.authVerifier);
  if (loggedIn.status !== 200 || !loggedIn.data) throw new Error('Signed up, but auto-login failed.');

  return {
    session: {
      email,
      sessionToken: loggedIn.data.sessionToken,
      masterKey: reg.keys.masterKey,
      dek: reg.keys.dek,
    },
    recoveryKey: reg.recoveryKey,
  };
}

/** Log in from any device knowing only email + passphrase. */
export async function loginFlow(email: string, passphrase: string): Promise<Session> {
  const challenge = await api.loginChallenge(email);
  if (challenge.status === 404) throw new Error('No account found for that email.');
  if (challenge.status !== 200 || !challenge.data) throw new Error('Login failed. Please try again.');

  const creds = deriveLoginCredentials(passphrase, challenge.data.kdfSalt, challenge.data.kdfParams);

  const res = await api.login(email, creds.authVerifier);
  if (res.status === 401) throw new Error('Incorrect passphrase.');
  if (res.status !== 200 || !res.data) throw new Error('Login failed. Please try again.');

  // Unwrap the DEK locally with the master key the server never saw.
  const dek = unwrapDek(res.data.wrappedDek, creds.masterKey);

  return { email, sessionToken: res.data.sessionToken, masterKey: creds.masterKey, dek };
}
