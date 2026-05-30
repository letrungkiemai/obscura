import { useEffect, useMemo, useState } from 'react';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { initCrypto } from './crypto/sodium';
import { AuthScreen } from './auth/AuthScreen';
import { RecoveryKeyScreen } from './auth/RecoveryKeyScreen';
import { DEFAULT_DOC_ID } from '@obscura/shared';
import { createLocalNote } from './doc/localNote';
import { encryptLocalUpdates } from './doc/encryptedUpdates';
import { SyncClient } from './sync/syncClient';
import type { Session } from './auth/flows';

/** The editor is its own component so the BlockNote hook only runs once logged in. */
function Editor({ session, onLogout }: { session: Session; onLogout: () => void }) {
  // One Yjs-backed note per user, persisted locally. Stable for this mount.
  const note = useMemo(() => createLocalNote(`obscura:${session.email}`), [session.email]);
  const [synced, setSynced] = useState(false);
  const [online, setOnline] = useState(false);

  useEffect(() => {
    // Encrypted sync. The client streams locally-encrypted updates to the server
    // and applies updates relayed from this user's other devices — the server
    // only ever handles opaque ciphertext.
    // The incremental-pull cursor AND the offline outbox both live in the note's
    // OWN IndexedDB (the 'custom' store y-indexeddb exposes), so they share the
    // doc's exact storage lifecycle: edits made offline survive a reload and
    // still get pushed, and wiping local data resets the cursor for a clean
    // full re-pull instead of silently skipping updates we no longer have.
    const cursorKey = `lastSeq:${DEFAULT_DOC_ID}`;
    const outboxKey = `outbox:${DEFAULT_DOC_ID}`;
    const sync = new SyncClient({
      doc: note.doc,
      dek: session.dek,
      token: session.sessionToken,
      docId: DEFAULT_DOC_ID,
      clientId: crypto.randomUUID(),
      loadCursor: async () => {
        const v = await note.persistence.get(cursorKey);
        return typeof v === 'number' ? v : 0;
      },
      saveCursor: (seq) => {
        void note.persistence.set(cursorKey, seq);
      },
      loadOutbox: async () => {
        // Stored as a JSON string (y-indexeddb's set() takes scalars, not arrays).
        const v = await note.persistence.get(outboxKey);
        if (typeof v !== 'string') return [];
        try {
          const parsed = JSON.parse(v);
          return Array.isArray(parsed) ? (parsed as string[]) : [];
        } catch {
          return [];
        }
      },
      saveOutbox: (blobs) => {
        void note.persistence.set(outboxKey, JSON.stringify(blobs));
      },
      onStatus: setOnline,
    });

    // Phase 3 part 1: encrypt every local change with the in-memory DEK before
    // it leaves the client. We ignore the IndexedDB replay so a reload doesn't
    // re-ship the entire doc as a "new" edit.
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
  }, [note, session]);

  const editor = useCreateBlockNote({
    collaboration: {
      fragment: note.fragment,
      user: { name: session.email, color: '#4f46e5' },
      // No network provider yet (Phase 3). Without awareness, BlockNote still
      // binds to the Yjs fragment but skips collaborative cursors.
      provider: undefined,
    },
  });

  return (
    <div style={{ minHeight: '100vh', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0.75rem 1.5rem',
          borderBottom: '1px solid #eee',
        }}
      >
        <strong>Obscura</strong>
        <span style={{ display: 'flex', alignItems: 'center', gap: '1rem', fontSize: 14, color: '#666' }}>
          <span title="Saved in this browser; survives reload">
            {synced ? '💾 Saved locally' : '⏳ Restoring…'}
          </span>
          <span title="End-to-end encrypted sync with the server">
            {online ? '🛰️ Synced' : '📡 Offline'}
          </span>
          <span title="Your data key is unlocked in memory">🔓 {session.email}</span>
          <button
            type="button"
            onClick={onLogout}
            style={{ border: '1px solid #ddd', borderRadius: 6, padding: '0.3rem 0.7rem', cursor: 'pointer', background: '#fff' }}
          >
            Log out
          </button>
        </span>
      </header>
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '2rem' }}>
        <BlockNoteView editor={editor} />
      </div>
    </div>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  // libsodium must be initialized before any crypto call.
  useEffect(() => {
    initCrypto().then(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', fontFamily: 'system-ui' }}>
        Loading…
      </div>
    );
  }

  if (!session) {
    return (
      <AuthScreen
        onAuthed={(s, rk) => {
          setSession(s);
          if (rk) setRecoveryKey(rk);
        }}
      />
    );
  }

  if (recoveryKey) {
    return <RecoveryKeyScreen recoveryKey={recoveryKey} onContinue={() => setRecoveryKey(null)} />;
  }

  return (
    <Editor
      session={session}
      onLogout={() => {
        setSession(null);
        setRecoveryKey(null);
      }}
    />
  );
}
