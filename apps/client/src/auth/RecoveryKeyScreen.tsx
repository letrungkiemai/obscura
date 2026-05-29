import { useState } from 'react';

interface Props {
  recoveryKey: string;
  onContinue: () => void;
}

/**
 * Shown once, immediately after signup. This is the user's only backup if they
 * forget their passphrase — so we force an explicit acknowledgement.
 */
export function RecoveryKeyScreen({ recoveryKey, onContinue }: Props) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard may be unavailable; user can select manually */
    }
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <h1 style={styles.title}>Save your recovery key</h1>
        <p style={styles.body}>
          This is the <strong>only</strong> way back into your notes if you forget your passphrase.
          We can’t recover it for you. Store it somewhere safe — a password manager is ideal.
        </p>

        <div style={styles.keyBox}>
          <code style={styles.key}>{recoveryKey}</code>
        </div>

        <button type="button" onClick={copy} style={styles.copy}>
          {copied ? 'Copied ✔' : 'Copy to clipboard'}
        </button>

        <label style={styles.ack}>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          I’ve saved my recovery key somewhere safe.
        </label>

        <button type="button" onClick={onContinue} disabled={!saved} style={styles.continue}>
          Continue to my notes
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#fafafa',
    fontFamily: 'Inter, system-ui, sans-serif',
  },
  card: {
    width: 440,
    padding: '2rem',
    background: '#fff',
    border: '1px solid #e5e5e5',
    borderRadius: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
  },
  title: { margin: 0, fontSize: 24 },
  body: { margin: 0, color: '#555', fontSize: 14, lineHeight: 1.5 },
  keyBox: {
    padding: '1rem',
    background: '#f5f5f5',
    border: '1px dashed #ccc',
    borderRadius: 8,
    wordBreak: 'break-all',
  },
  key: { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 15 },
  copy: {
    padding: '0.5rem',
    border: '1px solid #ddd',
    borderRadius: 8,
    background: '#fff',
    cursor: 'pointer',
    fontSize: 14,
  },
  ack: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, color: '#444' },
  continue: {
    padding: '0.7rem',
    border: 'none',
    borderRadius: 8,
    background: '#111',
    color: '#fff',
    fontSize: 15,
    cursor: 'pointer',
  },
};
