import _sodium from 'libsodium-wrappers-sumo';

let initialized = false;

/**
 * Initialize libsodium. Must be awaited once before any other crypto call.
 * Safe to call repeatedly.
 */
export async function initCrypto(): Promise<typeof _sodium> {
  if (!initialized) {
    await _sodium.ready;
    initialized = true;
  }
  return _sodium;
}

/** Get the initialized sodium instance. Throws if initCrypto() was not awaited. */
export function getSodium(): typeof _sodium {
  if (!initialized) {
    throw new Error('Crypto not initialized — await initCrypto() first.');
  }
  return _sodium;
}

function variant() {
  return getSodium().base64_variants.URLSAFE_NO_PADDING;
}

export function toB64(bytes: Uint8Array): string {
  return getSodium().to_base64(bytes, variant());
}

export function fromB64(s: string): Uint8Array {
  return getSodium().from_base64(s.trim(), variant());
}
