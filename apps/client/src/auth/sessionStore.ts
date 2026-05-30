import { toB64, fromB64 } from '../crypto/sodium';
import type { Session } from './flows';

/**
 * Persists the in-memory session to sessionStorage so a page reload doesn't log
 * the user out. sessionStorage (not localStorage) is deliberate: the keys live
 * only for the life of the tab and are wiped when it closes, keeping the keys
 * off long-term disk storage. Crypto keys are base64-encoded for transport.
 */
const KEY = 'obscura:session';

interface StoredSession {
  email: string;
  sessionToken: string;
  masterKey: string; // base64
  dek: string; // base64
}

export function saveSession(session: Session): void {
  const stored: StoredSession = {
    email: session.email,
    sessionToken: session.sessionToken,
    masterKey: toB64(session.masterKey),
    dek: toB64(session.dek),
  };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Ignore quota/availability errors — persistence is best-effort.
  }
}

/** Restore a session saved earlier this tab session, or null if none/invalid. */
export function loadSession(): Session | null {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as StoredSession;
    return {
      email: stored.email,
      sessionToken: stored.sessionToken,
      masterKey: fromB64(stored.masterKey),
      dek: fromB64(stored.dek),
    };
  } catch {
    clearSession();
    return null;
  }
}

export function clearSession(): void {
  sessionStorage.removeItem(KEY);
}
