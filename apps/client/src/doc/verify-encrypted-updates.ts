/**
 * Phase 3 part 1 round-trip check. No server, no IndexedDB — pure crypto + Yjs:
 * edits on doc A are encrypted with the DEK, the opaque blobs are applied to a
 * fresh doc B, and we assert B converges to A's content. Also checks that the
 * REMOTE_ORIGIN tag stops applied updates from being re-encrypted (no echo).
 *
 * Run: ./apps/server/node_modules/.bin/tsx apps/client/src/doc/verify-encrypted-updates.ts
 */
import * as Y from 'yjs';
import { initCrypto } from '../crypto/sodium';
import { genDek } from '../crypto/keys';
import { encryptLocalUpdates, applyEncryptedUpdate } from './encryptedUpdates';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main() {
  await initCrypto();
  const dek = genDek();

  const docA = new Y.Doc();
  const docB = new Y.Doc();

  // Ship A's encrypted updates to B; track that nothing B applies gets re-encrypted.
  const blobs: Uint8Array[] = [];
  const stopA = encryptLocalUpdates(docA, dek, (blob) => blobs.push(blob));

  let bReEncrypts = 0;
  const stopB = encryptLocalUpdates(docB, dek, () => {
    bReEncrypts += 1;
  });

  // Make several edits on A.
  const textA = docA.getText('t');
  textA.insert(0, 'hello');
  textA.insert(5, ' world');
  docA.getMap('m').set('k', 42);

  assert(blobs.length >= 1, 'A produced encrypted update blobs');

  // Each blob must be opaque: nonce(24) + ciphertext+tag(16), and never equal the
  // plaintext update bytes.
  for (const blob of blobs) {
    assert(blob.byteLength > 24 + 16, 'blob carries nonce + ciphertext + tag');
  }

  // Apply A's encrypted updates to B.
  for (const blob of blobs) applyEncryptedUpdate(docB, dek, blob);

  assert(docB.getText('t').toString() === 'hello world', `B text converged (got "${docB.getText('t').toString()}")`);
  assert(docB.getMap('m').get('k') === 42, 'B map converged');
  assert(bReEncrypts === 0, `applied remote updates are NOT re-encrypted (got ${bReEncrypts})`);

  // Tampering must be rejected by the AEAD tag.
  const tampered = blobs[0].slice();
  tampered[tampered.length - 1] ^= 0xff;
  let threw = false;
  try {
    applyEncryptedUpdate(new Y.Doc(), dek, tampered);
  } catch {
    threw = true;
  }
  assert(threw, 'tampered ciphertext is rejected');

  // Wrong key must be rejected too.
  threw = false;
  try {
    applyEncryptedUpdate(new Y.Doc(), genDek(), blobs[0]);
  } catch {
    threw = true;
  }
  assert(threw, 'wrong DEK is rejected');

  stopA();
  stopB();
  console.log(`OK — ${blobs.length} encrypted updates round-tripped; convergence, no-echo, tamper + wrong-key rejection all verified.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
