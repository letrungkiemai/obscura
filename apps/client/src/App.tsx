import { useEffect, useState } from 'react';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { initCrypto } from './crypto/sodium';
import { AuthScreen } from './auth/AuthScreen';
import { RecoveryKeyScreen } from './auth/RecoveryKeyScreen';
import type { Session } from './auth/flows';

/** The editor is its own component so the BlockNote hook only runs once logged in. */
function Editor({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const editor = useCreateBlockNote();
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
