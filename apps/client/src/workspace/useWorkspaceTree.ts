import { useEffect, useMemo, useState } from 'react';
import type * as Y from 'yjs';
import { buildTree, getPagesMap, readPages } from './workspaceDoc';
import type { PageTreeNode } from './workspaceDoc';

/**
 * Subscribe to the workspace doc's page map and re-derive the nested tree on any
 * change (local or synced from another device). `observeDeep` catches both
 * page add/remove and per-field edits (title/parent/order).
 */
export function useWorkspaceTree(doc: Y.Doc): PageTreeNode[] {
  const pages = useMemo(() => getPagesMap(doc), [doc]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    pages.observeDeep(bump);
    return () => pages.unobserveDeep(bump);
  }, [pages]);

  // version is the dependency that forces a fresh snapshot after each change.
  return useMemo(() => buildTree(readPages(pages)), [pages, version]);
}
