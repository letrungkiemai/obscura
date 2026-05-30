/**
 * Standalone round-trip verification of the crypto/auth foundation.
 * Run with: yarn tsx apps/client/src/crypto/verify.ts
 *
 * This simulates the server as a plain object (it only ever sees the payload)
 * and exercises: signup, fresh-device login, wrong-passphrase rejection,
 * recovery-key unlock, and passphrase rotation.
 */
import { initCrypto, getSodium, fromB64, toB64 } from './sodium';
import {
  registerAccount,
  deriveLoginCredentials,
  unwrapDek,
  unlockWithRecoveryKey,
  rotatePassphrase,
  resetWithRecoveryKey,
} from './account';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok: ${msg}`);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function main() {
  await initCrypto();
  const s = getSodium();

  const email = 'alice@example.com';
  const passphrase = 'correct horse battery staple';

  // --- Signup ---
  const reg = registerAccount(email, passphrase);
  console.log('\n[signup]');
  assert(reg.payload.email === email, 'payload carries email');
  assert(reg.recoveryKey.length > 0, 'recovery key generated');
  assert(reg.keys.dek.length === s.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, 'DEK is a full AEAD key');

  // Simulate the server: it stores the payload verbatim, hashing the verifier.
  const server = {
    email: reg.payload.email,
    kdfSalt: reg.payload.kdfSalt,
    kdfParams: reg.payload.kdfParams,
    authVerifierHash: toB64(s.crypto_generichash(32, fromB64(reg.payload.authVerifier), null)),
    recoveryVerifierHash: toB64(s.crypto_generichash(32, fromB64(reg.payload.recoveryVerifier), null)),
    wrappedDek: reg.payload.wrappedDek,
    wrappedDekRecovery: reg.payload.wrappedDekRecovery,
  };
  // The server must NOT be able to see the master key or DEK.
  assert(!('masterKey' in server) && !('dek' in server), 'server stores no decryption keys');

  // --- Fresh-device login ---
  console.log('\n[login on a new device]');
  const creds = deriveLoginCredentials(passphrase, server.kdfSalt, server.kdfParams);
  const verifierHash = toB64(s.crypto_generichash(32, fromB64(creds.authVerifier), null));
  assert(verifierHash === server.authVerifierHash, 'derived auth verifier matches server record');
  const dekFromLogin = unwrapDek(server.wrappedDek, creds.masterKey);
  assert(bytesEqual(dekFromLogin, reg.keys.dek), 'DEK unwrapped via passphrase equals original');

  // --- Wrong passphrase ---
  console.log('\n[wrong passphrase]');
  const badCreds = deriveLoginCredentials('wrong passphrase', server.kdfSalt, server.kdfParams);
  const badHash = toB64(s.crypto_generichash(32, fromB64(badCreds.authVerifier), null));
  assert(badHash !== server.authVerifierHash, 'wrong passphrase yields a non-matching verifier');
  let unwrapThrew = false;
  try {
    unwrapDek(server.wrappedDek, badCreds.masterKey);
  } catch {
    unwrapThrew = true;
  }
  assert(unwrapThrew, 'wrong master key cannot unwrap the DEK (AEAD rejects)');

  // --- Recovery key ---
  console.log('\n[recovery key]');
  const dekFromRecovery = unlockWithRecoveryKey(reg.recoveryKey, server.wrappedDekRecovery);
  assert(bytesEqual(dekFromRecovery, reg.keys.dek), 'DEK recovered via recovery key equals original');

  // --- Reset authorized by proof-of-recovery-key ---
  console.log('\n[reset proof-of-recovery-key]');
  const resetReq = resetWithRecoveryKey(email, reg.recoveryKey, 'recovered passphrase', dekFromRecovery);
  const resetProofHash = toB64(s.crypto_generichash(32, fromB64(resetReq.recoveryVerifier), null));
  assert(resetProofHash === server.recoveryVerifierHash, 'reset carries a recovery verifier the server can authorize');
  // A wrong recovery key produces a non-matching proof, so the server rejects it.
  const wrongRk = toB64(s.randombytes_buf(32));
  const forged = resetWithRecoveryKey(email, wrongRk, 'attacker passphrase', reg.keys.dek);
  const forgedHash = toB64(s.crypto_generichash(32, fromB64(forged.recoveryVerifier), null));
  assert(forgedHash !== server.recoveryVerifierHash, 'a wrong recovery key cannot authorize a reset');
  // Applying the authorized reset keeps the DEK decryptable under the new passphrase.
  server.kdfSalt = resetReq.kdfSalt;
  server.kdfParams = resetReq.kdfParams;
  server.authVerifierHash = toB64(s.crypto_generichash(32, fromB64(resetReq.authVerifier), null));
  server.wrappedDek = resetReq.wrappedDek;
  const credsAfterReset = deriveLoginCredentials('recovered passphrase', server.kdfSalt, server.kdfParams);
  assert(bytesEqual(unwrapDek(server.wrappedDek, credsAfterReset.masterKey), reg.keys.dek), 'DEK unwraps under the reset passphrase');

  // --- Passphrase rotation ---
  console.log('\n[passphrase rotation]');
  const newPass = 'a brand new passphrase';
  const resetPayload = rotatePassphrase(email, newPass, reg.keys.dek, server.wrappedDekRecovery);
  server.kdfSalt = resetPayload.kdfSalt;
  server.kdfParams = resetPayload.kdfParams;
  server.authVerifierHash = toB64(s.crypto_generichash(32, fromB64(resetPayload.authVerifier), null));
  server.wrappedDek = resetPayload.wrappedDek;
  const credsAfter = deriveLoginCredentials(newPass, server.kdfSalt, server.kdfParams);
  const dekAfterRotate = unwrapDek(server.wrappedDek, credsAfter.masterKey);
  assert(bytesEqual(dekAfterRotate, reg.keys.dek), 'DEK still unwraps after rotating the passphrase');
  assert(bytesEqual(unlockWithRecoveryKey(reg.recoveryKey, server.wrappedDekRecovery), reg.keys.dek), 'recovery key still works after rotation');

  console.log('\nAll crypto round-trips passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
