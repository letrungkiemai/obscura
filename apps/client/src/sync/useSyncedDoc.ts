import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { encryptLocalUpdates } from '../doc/encryptedUpdates';
import { SyncClient } from './syncClient';
import type { Session } from '../auth/flows';

export interface SyncedDoc {
  doc: Y.Doc;
  persistence: IndexeddbPersistence;
  /** Local IndexedDB state has finished loading. */
  synced: boolean;
  /** The encrypted sync WebSocket is currently connected. */
  online: boolean;
}

/**
 * Back a Yjs doc with local persistence + the encrypted sync pipeline: every
 * local change is encrypted with the session DEK and pushed; remote changes are
 * pulled, decrypted, and merged. The cursor + offline outbox live in this doc's
 * own IndexedDB, so each doc (workspace tree or an individual page) syncs
 * independently through the same machinery.
 *
 * `docId` addresses the doc on the server (must be a UUID); `dbKey` namespaces
 * its local IndexedDB. Call this from a component that is stable for the life of
 * the doc (e.g. keyed by page id), since the doc is created once per mount.
 */
export function useSyncedDoc(session: Session, docId: string, dbKey: string): SyncedDoc {
  const note = useMemo(() => {
    const doc = new Y.Doc();
    const persistence = new IndexeddbPersistence(dbKey, doc);
    return { doc, persistence };
  }, [dbKey]);

  const [synced, setSynced] = useState(false);
  const [online, setOnline] = useState(false);

  useEffect(() => {
    const cursorKey = `lastSeq:${docId}`;
    const outboxKey = `outbox:${docId}`;

    const sync = new SyncClient({
      doc: note.doc,
      dek: session.dek,
      token: session.sessionToken,
      docId,
      clientId: crypto.randomUUID(),
      loadCursor: async () => {
        const v = await note.persistence.get(cursorKey);
        return typeof v === 'number' ? v : 0;
      },
      saveCursor: (seq) => void note.persistence.set(cursorKey, seq),
      loadOutbox: async () => {
        const v = await note.persistence.get(outboxKey);
        if (typeof v !== 'string') return [];
        try {
          const parsed = JSON.parse(v);
          return Array.isArray(parsed) ? (parsed as string[]) : [];
        } catch {
          return [];
        }
      },
      saveOutbox: (blobs) => void note.persistence.set(outboxKey, JSON.stringify(blobs)),
      onStatus: setOnline,
    });

    // Encrypt every local change before it leaves the client; ignore the
    // IndexedDB replay so a reload doesn't re-ship the whole doc as a new edit.
    const stopEncrypting = encryptLocalUpdates(
      note.doc,
      session.dek,
      (blob) => sync.pushEncrypted(blob),
      { ignoreOrigins: [note.persistence] },
    );

    // Load local state first, then connect so the on-connect pull merges on top.
    note.persistence.whenSynced.then(() => {
      setSynced(true);
      void sync.connect();
    });

    return () => {
      stopEncrypting();
      sync.close();
      note.persistence.destroy();
      note.doc.destroy();
    };
  }, [note, docId, session]);

  return { doc: note.doc, persistence: note.persistence, synced, online };
}
