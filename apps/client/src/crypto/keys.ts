import type { KdfParams } from '@obscura/shared';
import { getSodium, toB64, fromB64 } from './sodium';

// crypto_kdf contexts must be exactly 8 bytes. Distinct contexts + subkey ids
// guarantee the master key and auth verifier are cryptographically independent,
// even though both are derived from the same Argon2id root key.
const MASTER_CTX = 'obscMast';
const AUTH_CTX = 'obscAuth';
const RECOVERY_CTX = 'obscReco';
const MASTER_SUBKEY_ID = 1;
const AUTH_SUBKEY_ID = 2;
const RECOVERY_SUBKEY_ID = 3;

/**
 * KDF parameters used for new accounts. The resolved numeric values are stored
 * server-side so old accounts keep deriving the same key even if these defaults
 * change. INTERACTIVE (~64 MiB, ops 2) is a good balance for browser logins.
 */
export function defaultKdfParams(): KdfParams {
  const s = getSodium();
  return {
    opsLimit: s.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    memLimit: s.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    algorithm: s.crypto_pwhash_ALG_ARGON2ID13,
  };
}

export function genSalt(): Uint8Array {
  const s = getSodium();
  return s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
}

/** Expensive: stretch the passphrase into a 32-byte root key via Argon2id. */
export function deriveRootKey(passphrase: string, salt: Uint8Array, params: KdfParams): Uint8Array {
  const s = getSodium();
  return s.crypto_pwhash(
    s.crypto_kdf_KEYBYTES,
    passphrase,
    salt,
    params.opsLimit,
    params.memLimit,
    params.algorithm,
  );
}

/** Cheap: the master key never leaves the client. */
export function deriveMasterKey(rootKey: Uint8Array): Uint8Array {
  const s = getSodium();
  return s.crypto_kdf_derive_from_key(
    s.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
    MASTER_SUBKEY_ID,
    MASTER_CTX,
    rootKey,
  );
}

/** Cheap: the auth verifier is the only key-derived secret sent to the server. */
export function deriveAuthVerifier(rootKey: Uint8Array): Uint8Array {
  const s = getSodium();
  return s.crypto_kdf_derive_from_key(32, AUTH_SUBKEY_ID, AUTH_CTX, rootKey);
}

/**
 * The recovery analogue of the auth verifier: a secret derived from the recovery
 * key (already a 32-byte high-entropy KDF key) and sent to the server as proof
 * of recovery-key possession. The server stores only its hash and demands it to
 * authorize a passphrase reset. A distinct context keeps it cryptographically
 * independent from the recovery-key *wrapping* of the DEK.
 */
export function deriveRecoveryVerifier(recoveryKeyBytes: Uint8Array): Uint8Array {
  const s = getSodium();
  return s.crypto_kdf_derive_from_key(32, RECOVERY_SUBKEY_ID, RECOVERY_CTX, recoveryKeyBytes);
}

/** Fresh random Data Encryption Key — the key that actually encrypts content. */
export function genDek(): Uint8Array {
  const s = getSodium();
  return s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
}

/**
 * XChaCha20-Poly1305 AEAD. Output is a fresh 24-byte nonce prefixed onto the
 * ciphertext+tag, so each call is self-describing and safe to store as-is.
 */
export function aeadEncrypt(plaintext: Uint8Array, key: Uint8Array, aad: Uint8Array | null = null): Uint8Array {
  const s = getSodium();
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

/** Inverse of aeadEncrypt. Throws if authentication fails (wrong key / tampered). */
export function aeadDecrypt(blob: Uint8Array, key: Uint8Array, aad: Uint8Array | null = null): Uint8Array {
  const s = getSodium();
  const n = s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const nonce = blob.subarray(0, n);
  const ct = blob.subarray(n);
  return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, aad, nonce, key);
}

// Key wrapping is just AEAD over key bytes.
export const wrapKey = aeadEncrypt;
export const unwrapKey = aeadDecrypt;

/** High-entropy recovery key (256 bits). Shown to the user once; never stored. */
export function genRecoveryKey(): { recoveryKey: string; recoveryKeyBytes: Uint8Array } {
  const s = getSodium();
  const recoveryKeyBytes = s.randombytes_buf(32);
  return { recoveryKey: toB64(recoveryKeyBytes), recoveryKeyBytes };
}

export function recoveryKeyToBytes(recoveryKey: string): Uint8Array {
  return fromB64(recoveryKey);
}
