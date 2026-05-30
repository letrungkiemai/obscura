import { useEffect, useState } from 'react';
import { initCrypto } from './crypto/sodium';
import { AuthScreen } from './auth/AuthScreen';
import { RecoveryKeyScreen } from './auth/RecoveryKeyScreen';
import { Workspace } from './workspace/Workspace';
import { clearSession, loadSession, saveSession } from './auth/sessionStore';
import type { Session } from './auth/flows';

export default function App() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  // libsodium must be initialized before any crypto call. Once ready, restore a
  // session persisted earlier this tab (decoding keys needs sodium).
  useEffect(() => {
    initCrypto().then(() => {
      setSession(loadSession());
      setReady(true);
    });
  }, []);

  if (!ready) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', fontFamily: 'system-ui', color: '#9a9aa2' }}>
        Loading…
      </div>
    );
  }

  if (!session) {
    return (
      <AuthScreen
        onAuthed={(s, rk) => {
          saveSession(s);
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
    <Workspace
      session={session}
      onLogout={() => {
        clearSession();
        setSession(null);
        setRecoveryKey(null);
      }}
    />
  );
}
