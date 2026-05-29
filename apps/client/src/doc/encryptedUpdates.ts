import * as Y from 'yjs';
import { aeadEncrypt, aeadDecrypt } from '../crypto/keys';

/**
 * Origin tag for updates that the sync layer applied to the doc after decrypting
 * them (i.e. changes that came FROM another device). The local update hook must
 * skip these — re-encrypting and re-shipping a remote update would make two
 * devices ping-pong the same change forever.
 *
 * `applyEncryptedUpdate` stamps every remote apply with this symbol;
 * `encryptLocalUpdates` filters on it.
 */
export const REMOTE_ORIGIN = Symbol('obscura:remote-update');

/** Receives one encrypted update blob. Phase 3 part 2 wires this to a WebSocket. */
export type EncryptedUpdateSink = (blob: Uint8Array) => void;

export interface EncryptLocalUpdatesOptions {
  /**
   * Yjs update origins to ignore in addition to {@link REMOTE_ORIGIN}. Pass the
   * note's IndexeddbPersistence so the full-state replay it emits on reload is
   * not mistaken for a fresh local edit and re-shipped to the server.
   */
  ignoreOrigins?: readonly unknown[];
}

/**
 * Subscribe to a Y.Doc's update stream and hand every genuine local change to
 * `sink` as an encrypted blob, before it ever leaves the client.
 *
 * Each Yjs change emits a compact binary update. We seal it with the DEK using
 * XChaCha20-Poly1305 (fresh random nonce per call, via {@link aeadEncrypt}), so
 * the server only ever sees opaque ciphertext.
 *
 * Returns a disposer that unsubscribes the hook.
 */
export function encryptLocalUpdates(
  doc: Y.Doc,
  dek: Uint8Array,
  sink: EncryptedUpdateSink,
  options: EncryptLocalUpdatesOptions = {},
): () => void {
  const ignored = options.ignoreOrigins ?? [];

  const handler = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE_ORIGIN) return;
    if (ignored.includes(origin)) return;
    sink(aeadEncrypt(update, dek));
  };

  doc.on('update', handler);
  return () => doc.off('update', handler);
}

/**
 * Inverse of the local hook: decrypt an update blob received from the sync layer
 * and merge it into the doc. Stamped with {@link REMOTE_ORIGIN} so the local
 * hook does not echo it back. Throws if authentication fails (wrong DEK /
 * tampered ciphertext).
 */
export function applyEncryptedUpdate(doc: Y.Doc, dek: Uint8Array, blob: Uint8Array): void {
  const update = aeadDecrypt(blob, dek);
  Y.applyUpdate(doc, update, REMOTE_ORIGIN);
}
