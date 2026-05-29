import type { KdfParams, SignupRequest } from '@obscura/shared';
import { toB64, fromB64 } from './sodium';
import {
  defaultKdfParams,
  deriveAuthVerifier,
  deriveMasterKey,
  deriveRootKey,
  genDek,
  genRecoveryKey,
  genSalt,
  recoveryKeyToBytes,
  unwrapKey,
  wrapKey,
} from './keys';

/** The secrets a logged-in client holds in memory. Never persisted in plaintext. */
export interface UnlockedKeys {
  masterKey: Uint8Array;
  dek: Uint8Array;
}

export interface RegistrationResult {
  keys: UnlockedKeys;
  /** Show this to the user exactly once, then forget it. */
  recoveryKey: string;
  /** JSON-safe blob to POST to the server. */
  payload: SignupRequest;
}

/**
 * Create a brand-new account from a passphrase. Generates the DEK, derives the
 * master key + auth verifier, and produces both wrapped copies of the DEK.
 */
export function registerAccount(email: string, passphrase: string): RegistrationResult {
  const salt = genSalt();
  const params = defaultKdfParams();
  const rootKey = deriveRootKey(passphrase, salt, params);
  const masterKey = deriveMasterKey(rootKey);
  const authVerifier = deriveAuthVerifier(rootKey);

  const dek = genDek();
  const wrappedDek = wrapKey(dek, masterKey);

  const { recoveryKey, recoveryKeyBytes } = genRecoveryKey();
  const wrappedDekRecovery = wrapKey(dek, recoveryKeyBytes);

  return {
    keys: { masterKey, dek },
    recoveryKey,
    payload: {
      email,
      kdfSalt: toB64(salt),
      kdfParams: params,
      authVerifier: toB64(authVerifier),
      wrappedDek: toB64(wrappedDek),
      wrappedDekRecovery: toB64(wrappedDekRecovery),
    },
  };
}

/**
 * Step 1 of login (after fetching salt+params via the challenge endpoint):
 * derive the master key locally and the auth verifier to send to the server.
 */
export function deriveLoginCredentials(
  passphrase: string,
  kdfSalt: string,
  kdfParams: KdfParams,
): { masterKey: Uint8Array; authVerifier: string } {
  const rootKey = deriveRootKey(passphrase, fromB64(kdfSalt), kdfParams);
  return {
    masterKey: deriveMasterKey(rootKey),
    authVerifier: toB64(deriveAuthVerifier(rootKey)),
  };
}

/** Step 2 of login: unwrap the DEK returned by the server with the master key. */
export function unwrapDek(wrappedDekB64: string, masterKey: Uint8Array): Uint8Array {
  return unwrapKey(fromB64(wrappedDekB64), masterKey);
}

/** Recovery path: recover the DEK from the recovery key when the passphrase is lost. */
export function unlockWithRecoveryKey(recoveryKey: string, wrappedDekRecoveryB64: string): Uint8Array {
  return unwrapKey(fromB64(wrappedDekRecoveryB64), recoveryKeyToBytes(recoveryKey));
}

/**
 * Rotate to a new passphrase while keeping the same DEK (so existing notes stay
 * decryptable). Re-wraps the DEK under a fresh master key; the recovery wrapping
 * is preserved unchanged.
 */
export function rotatePassphrase(
  email: string,
  newPassphrase: string,
  dek: Uint8Array,
  existingWrappedDekRecoveryB64: string,
): SignupRequest {
  const salt = genSalt();
  const params = defaultKdfParams();
  const rootKey = deriveRootKey(newPassphrase, salt, params);
  const masterKey = deriveMasterKey(rootKey);
  const authVerifier = deriveAuthVerifier(rootKey);
  const wrappedDek = wrapKey(dek, masterKey);

  return {
    email,
    kdfSalt: toB64(salt),
    kdfParams: params,
    authVerifier: toB64(authVerifier),
    wrappedDek: toB64(wrappedDek),
    wrappedDekRecovery: existingWrappedDekRecoveryB64,
  };
}
