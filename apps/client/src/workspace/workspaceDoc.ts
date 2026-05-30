import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';

/**
 * The workspace structure (page tree + ordering) is its own small Yjs doc, synced
 * through the same encrypted pipeline as note content — so structural changes
 * (create/rename/delete/reorder/nest) merge across devices like any other edit.
 *
 * Fixed UUID: each user has exactly one workspace doc. Distinct from the nil
 * DEFAULT_DOC_ID so it gets its own server-side append log.
 */
export const WORKSPACE_DOC_ID = '11111111-1111-1111-1111-111111111111';

/** Yjs key for the page map: pageId → Y.Map({ title, parentId, order }). */
const PAGES_KEY = 'pages';

export type PagesMap = Y.Map<Y.Map<string | null>>;

export interface PageNode {
  id: string;
  title: string;
  /** null for a top-level page. */
  parentId: string | null;
  /** Fractional index — sorts a page among its siblings; subdivisible forever. */
  order: string;
}

export interface PageTreeNode extends PageNode {
  depth: number;
  children: PageTreeNode[];
}

export function getPagesMap(doc: Y.Doc): PagesMap {
  return doc.getMap(PAGES_KEY) as PagesMap;
}

/** Snapshot every page node out of the CRDT into plain objects. */
export function readPages(pages: PagesMap): PageNode[] {
  const out: PageNode[] = [];
  pages.forEach((node, id) => {
    out.push({
      id,
      title: (node.get('title') as string) ?? 'Untitled',
      parentId: (node.get('parentId') as string | null) ?? null,
      order: (node.get('order') as string) ?? '',
    });
  });
  return out;
}

const byOrder = (a: PageNode, b: PageNode): number =>
  a.order < b.order ? -1 : a.order > b.order ? 1 : 0;

/** Build the nested, order-sorted tree from a flat page list. */
export function buildTree(flat: PageNode[]): PageTreeNode[] {
  const byParent = new Map<string | null, PageNode[]>();
  for (const p of flat) {
    const siblings = byParent.get(p.parentId) ?? [];
    siblings.push(p);
    byParent.set(p.parentId, siblings);
  }

  const build = (parentId: string | null, depth: number): PageTreeNode[] =>
    (byParent.get(parentId) ?? [])
      .sort(byOrder)
      .map((p) => ({ ...p, depth, children: build(p.id, depth + 1) }));

  // Orphans (parent deleted concurrently) surface at the root so nothing is lost.
  const known = new Set(flat.map((p) => p.id));
  const roots = build(null, 0);
  const orphans = flat
    .filter((p) => p.parentId !== null && !known.has(p.parentId))
    .sort(byOrder)
    .map((p) => ({ ...p, depth: 0, children: build(p.id, 1) }));
  return [...roots, ...orphans];
}

function siblingsOf(pages: PagesMap, parentId: string | null): PageNode[] {
  return readPages(pages)
    .filter((p) => p.parentId === parentId)
    .sort(byOrder);
}

// --- mutations (all wrapped in a transaction so they're one atomic update) ---

/** Create a page at the end of `parentId`'s children. Returns the new page id. */
export function createPage(
  doc: Y.Doc,
  parentId: string | null = null,
  title = 'Untitled',
): string {
  const pages = getPagesMap(doc);
  const id = crypto.randomUUID();
  const siblings = siblingsOf(pages, parentId);
  const last = siblings[siblings.length - 1];
  const order = generateKeyBetween(last?.order ?? null, null);
  doc.transact(() => {
    const node = new Y.Map<string | null>();
    node.set('title', title);
    node.set('parentId', parentId);
    node.set('order', order);
    pages.set(id, node);
  });
  return id;
}

export function renamePage(doc: Y.Doc, id: string, title: string): void {
  const node = getPagesMap(doc).get(id);
  if (node) node.set('title', title);
}

/** Delete a page and all of its descendants. Returns the deleted ids. */
export function deletePage(doc: Y.Doc, id: string): string[] {
  const pages = getPagesMap(doc);
  const flat = readPages(pages);
  const toDelete: string[] = [];
  const collect = (pid: string) => {
    toDelete.push(pid);
    for (const child of flat.filter((p) => p.parentId === pid)) collect(child.id);
  };
  collect(id);
  doc.transact(() => {
    for (const pid of toDelete) pages.delete(pid);
  });
  return toDelete;
}

/** Reorder a page up or down among its siblings. */
export function movePage(doc: Y.Doc, id: string, direction: 'up' | 'down'): void {
  const pages = getPagesMap(doc);
  const node = pages.get(id);
  if (!node) return;
  const parentId = (node.get('parentId') as string | null) ?? null;
  const siblings = siblingsOf(pages, parentId);
  const idx = siblings.findIndex((p) => p.id === id);
  if (idx < 0) return;

  let order: string | null = null;
  if (direction === 'up' && idx > 0) {
    order = generateKeyBetween(siblings[idx - 2]?.order ?? null, siblings[idx - 1].order);
  } else if (direction === 'down' && idx < siblings.length - 1) {
    order = generateKeyBetween(siblings[idx + 1].order, siblings[idx + 2]?.order ?? null);
  }
  if (order !== null) node.set('order', order);
}

/** Nest a page under its immediately-preceding sibling. */
export function indentPage(doc: Y.Doc, id: string): void {
  const pages = getPagesMap(doc);
  const node = pages.get(id);
  if (!node) return;
  const parentId = (node.get('parentId') as string | null) ?? null;
  const siblings = siblingsOf(pages, parentId);
  const idx = siblings.findIndex((p) => p.id === id);
  if (idx <= 0) return; // no preceding sibling to nest under
  const newParent = siblings[idx - 1].id;
  const newSiblings = siblingsOf(pages, newParent);
  const last = newSiblings[newSiblings.length - 1];
  doc.transact(() => {
    node.set('parentId', newParent);
    node.set('order', generateKeyBetween(last?.order ?? null, null));
  });
}

/** Move a page out to become a sibling of its current parent. */
export function outdentPage(doc: Y.Doc, id: string): void {
  const pages = getPagesMap(doc);
  const node = pages.get(id);
  if (!node) return;
  const parentId = (node.get('parentId') as string | null) ?? null;
  if (parentId === null) return; // already at root
  const parentNode = pages.get(parentId);
  const grandParentId = (parentNode?.get('parentId') as string | null) ?? null;

  // Place it right after its old parent among the grandparent's children.
  const uncles = siblingsOf(pages, grandParentId);
  const parentIdx = uncles.findIndex((p) => p.id === parentId);
  const after = uncles[parentIdx]?.order ?? null;
  const before = uncles[parentIdx + 1]?.order ?? null;
  doc.transact(() => {
    node.set('parentId', grandParentId);
    node.set('order', generateKeyBetween(after, before));
  });
}
