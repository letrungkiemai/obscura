import { useState, type FormEvent } from 'react';
import { signupFlow, loginFlow, type Session } from './flows';
import { theme } from '../theme';

interface Props {
  /** Called on success. recoveryKey is present only for fresh signups. */
  onAuthed: (session: Session, recoveryKey?: string) => void;
}

type Mode = 'login' | 'signup';

export function AuthScreen({ onAuthed }: Props) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signup') {
        const { session, recoveryKey } = await signupFlow(email.trim(), passphrase);
        onAuthed(session, recoveryKey);
      } else {
        const session = await loginFlow(email.trim(), passphrase);
        onAuthed(session);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.wrap}>
      <form onSubmit={handleSubmit} style={styles.card}>
        <img src="/logo.png" alt="Obscura" style={styles.logo} />
        {/* <h1 style={styles.title}>Obscura</h1> */}
        <p style={styles.subtitle}>
          {mode === 'login' ? 'Log in to your encrypted notes' : 'Create an encrypted account'}
        </p>

        <label style={styles.label}>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="username"
            style={styles.input}
          />
        </label>

        <label style={styles.label}>
          Passphrase
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            required
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            placeholder={mode === 'signup' ? 'Use several words you’ll remember' : undefined}
            style={styles.input}
          />
        </label>

        {mode === 'signup' && (
          <p style={styles.hint}>
            Your passphrase is the only key to your notes. We can’t reset it — choose something strong
            and memorable.
          </p>
        )}

        {error && <p style={styles.error}>{error}</p>}

        <button type="submit" disabled={busy} style={styles.button}>
          {busy ? 'Working…' : mode === 'login' ? 'Log in' : 'Sign up'}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode(mode === 'login' ? 'signup' : 'login');
            setError(null);
          }}
          style={styles.switch}
        >
          {mode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Log in'}
        </button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: theme.bg,
    fontFamily: 'Inter, system-ui, sans-serif',
  },
  card: {
    width: 360,
    padding: '2rem',
    background: theme.bgElevated,
    border: `1px solid ${theme.border}`,
    borderRadius: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
  },
  logo: { width: '100%', height: '100%', display: 'block' },
  title: { margin: 0, fontSize: 28, color: theme.text },
  subtitle: { margin: '0 0 0.5rem', color: theme.textMuted, fontSize: 14 },
  label: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: theme.textMuted },
  input: {
    padding: '0.6rem 0.7rem',
    border: `1px solid ${theme.border}`,
    borderRadius: 8,
    fontSize: 15,
    background: theme.bgInput,
    color: theme.text,
  },
  hint: { margin: 0, fontSize: 12, color: theme.textFaint, lineHeight: 1.4 },
  error: { margin: 0, color: theme.dangerText, fontSize: 13 },
  button: {
    marginTop: '0.5rem',
    padding: '0.7rem',
    border: 'none',
    borderRadius: 8,
    background: theme.accent,
    color: '#fff',
    fontSize: 15,
    cursor: 'pointer',
  },
  switch: {
    background: 'none',
    border: 'none',
    color: theme.textMuted,
    fontSize: 13,
    cursor: 'pointer',
    textDecoration: 'underline',
  },
};
