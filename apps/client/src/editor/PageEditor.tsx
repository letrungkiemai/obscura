import { useMemo } from 'react';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { useSyncedDoc } from '../sync/useSyncedDoc';
import { theme, fontStack } from '../theme';
import type { Session } from '../auth/flows';

interface PageEditorProps {
  session: Session;
  pageId: string;
  title: string;
  onTitleChange: (title: string) => void;
}

/**
 * Edits one page. Its body is a per-page Yjs doc (docId = pageId) synced through
 * the encrypted pipeline; its title lives in the workspace doc (passed in / out
 * via props). Mount this with `key={pageId}` so it fully remounts per page.
 */
export function PageEditor({ session, pageId, title, onTitleChange }: PageEditorProps) {
  const { doc, synced, online } = useSyncedDoc(session, pageId, `obscura:${session.email}:${pageId}`);

  // BlockNote binds to a named fragment of the page's Yjs doc — the CRDT body.
  const fragment = useMemo(() => doc.getXmlFragment('document-store'), [doc]);
  const editor = useCreateBlockNote({
    collaboration: { fragment, user: { name: session.email, color: theme.accent }, provider: undefined },
  });

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: theme.bg }}>
      {/* <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', padding: '0.5rem 1.5rem', fontSize: 13, color: theme.textMuted }}>
        <span title="Saved in this browser; survives reload">{synced ? '💾 Saved locally' : '⏳ Restoring…'}</span>
        <span title="End-to-end encrypted sync">{online ? '🛰️ Synced' : '📡 Offline'}</span>
      </div> */}
      <div style={{ maxWidth: '100%', width: '100%', margin: '0 auto', padding: '1rem 2rem 4rem', boxSizing: 'border-box' }}>
          <input
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="Untitled"
            style={{
              width: '100%',
              border: 'none',
              outline: 'none',
              fontSize: 36,
              fontWeight: 700,
              fontFamily: fontStack,
              marginBottom: '0.5rem',
              color: theme.text,
              background: 'transparent',
            }}
          />
        <BlockNoteView editor={editor} theme="dark" />
      </div>
    </div>
  );
}
