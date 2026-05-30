import { useEffect, useMemo, useState } from 'react';
import { useSyncedDoc } from '../sync/useSyncedDoc';
import { useWorkspaceTree } from './useWorkspaceTree';
import { Sidebar } from './Sidebar';
import { PageEditor } from '../editor/PageEditor';
import {
  WORKSPACE_DOC_ID,
  createPage,
  deletePage,
  indentPage,
  movePage,
  outdentPage,
  renamePage,
} from './workspaceDoc';
import type { PageTreeNode } from './workspaceDoc';
import type { Session } from '../auth/flows';

function flattenIds(tree: PageTreeNode[]): string[] {
  return tree.flatMap((n) => [n.id, ...flattenIds(n.children)]);
}
function findNode(tree: PageTreeNode[], id: string | null): PageTreeNode | null {
  if (!id) return null;
  for (const n of tree) {
    if (n.id === id) return n;
    const found = findNode(n.children, id);
    if (found) return found;
  }
  return null;
}

export function Workspace({ session, onLogout }: { session: Session; onLogout: () => void }) {
  // The page tree is its own synced, encrypted Yjs doc.
  const { doc, online } = useSyncedDoc(
    session,
    WORKSPACE_DOC_ID,
    `obscura:${session.email}:workspace`,
  );
  const tree = useWorkspaceTree(doc);
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);

  const ids = useMemo(() => flattenIds(tree), [tree]);

  // Keep a valid selection: pick the first page when none is selected, and
  // recover if the open page is deleted (here or on another device).
  useEffect(() => {
    if (currentPageId && ids.includes(currentPageId)) return;
    setCurrentPageId(tree[0]?.id ?? null);
  }, [ids, currentPageId, tree]);

  const currentTitle = findNode(tree, currentPageId)?.title ?? '';

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0.6rem 1.25rem',
          borderBottom: '1px solid #eee',
        }}
      >
        <strong>Obscura</strong>
        <span style={{ display: 'flex', alignItems: 'center', gap: '1rem', fontSize: 14, color: '#666' }}>
          <span title="Workspace sync status">{online ? '🛰️ Synced' : '📡 Offline'}</span>
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

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Sidebar
          tree={tree}
          currentPageId={currentPageId}
          onSelect={setCurrentPageId}
          onCreate={(parentId) => setCurrentPageId(createPage(doc, parentId))}
          onRename={(id, title) => renamePage(doc, id, title)}
          onDelete={(id) => deletePage(doc, id)}
          onMove={(id, dir) => movePage(doc, id, dir)}
          onIndent={(id) => indentPage(doc, id)}
          onOutdent={(id) => outdentPage(doc, id)}
        />

        <main style={{ flex: 1, overflowY: 'auto', display: 'flex' }}>
          {currentPageId ? (
            <PageEditor
              key={currentPageId}
              session={session}
              pageId={currentPageId}
              title={currentTitle}
              onTitleChange={(title) => renamePage(doc, currentPageId, title)}
            />
          ) : (
            <div style={{ margin: 'auto', textAlign: 'center', color: '#999' }}>
              <p style={{ fontSize: 16 }}>No page open.</p>
              <button
                type="button"
                onClick={() => setCurrentPageId(createPage(doc, null))}
                style={{ border: '1px solid #ddd', borderRadius: 6, padding: '0.5rem 1rem', cursor: 'pointer', background: '#fff' }}
              >
                ＋ Create your first page
              </button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
