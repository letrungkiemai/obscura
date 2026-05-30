/**
 * Phase 6 — workspace model. Pure Yjs (no DOM): exercises the page-tree CRDT —
 * create/nest, ordered tree build, rename, recursive delete, reorder, indent/
 * outdent — and confirms concurrent structural edits on two docs merge cleanly.
 *
 * Run: ./apps/server/node_modules/.bin/tsx apps/client/src/workspace/verify-workspace.ts
 */
import * as Y from 'yjs';
import {
  buildTree,
  createPage,
  deletePage,
  getPagesMap,
  indentPage,
  movePage,
  outdentPage,
  readPages,
  renamePage,
} from './workspaceDoc';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const tree = (doc: Y.Doc) => buildTree(readPages(getPagesMap(doc)));
const rootTitles = (doc: Y.Doc) => tree(doc).map((n) => n.title);
const sync2 = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
};

function main() {
  const doc = new Y.Doc();

  // --- create + ordering ---
  const a = createPage(doc, null, 'A');
  const b = createPage(doc, null, 'B');
  createPage(doc, null, 'C');
  assert(JSON.stringify(rootTitles(doc)) === JSON.stringify(['A', 'B', 'C']), `root pages in creation order (got ${rootTitles(doc)})`);

  // --- nesting (subpage) ---
  const a1 = createPage(doc, a, 'A1');
  createPage(doc, a, 'A2');
  const aNode = tree(doc).find((n) => n.id === a)!;
  assert(aNode.children.map((c) => c.title).join(',') === 'A1,A2', `A has children A1,A2 (got ${aNode.children.map((c) => c.title)})`);
  assert(aNode.children[0].depth === 1, 'child depth is 1');

  // --- rename ---
  renamePage(doc, a1, 'A1-renamed');
  assert(tree(doc).find((n) => n.id === a)!.children[0].title === 'A1-renamed', 'rename applied');

  // --- reorder among siblings ---
  const c = tree(doc).find((n) => n.title === 'C')!.id;
  movePage(doc, c, 'up'); // C moves above B
  assert(JSON.stringify(rootTitles(doc)) === JSON.stringify(['A', 'C', 'B']), `move up reorders (got ${rootTitles(doc)})`);
  movePage(doc, c, 'down');
  assert(JSON.stringify(rootTitles(doc)) === JSON.stringify(['A', 'B', 'C']), `move down reorders back (got ${rootTitles(doc)})`);

  // --- indent / outdent ---
  indentPage(doc, b); // B nests under A (its preceding sibling)
  assert(rootTitles(doc).join(',') === 'A,C', `B left the root after indent (got ${rootTitles(doc)})`);
  assert(tree(doc).find((n) => n.id === a)!.children.some((ch) => ch.id === b), 'B is now a child of A');
  outdentPage(doc, b); // B back to root, right after A
  assert(JSON.stringify(rootTitles(doc)) === JSON.stringify(['A', 'B', 'C']), `outdent restores B to root after A (got ${rootTitles(doc)})`);

  // --- recursive delete ---
  const before = readPages(getPagesMap(doc)).length;
  deletePage(doc, a); // removes A and its children A1, A2
  assert(readPages(getPagesMap(doc)).length === before - 3, `delete removed A + 2 descendants (got ${readPages(getPagesMap(doc)).length}, was ${before})`);
  assert(JSON.stringify(rootTitles(doc)) === JSON.stringify(['B', 'C']), `roots after delete (got ${rootTitles(doc)})`);

  // --- concurrent structural edits on two devices merge cleanly ---
  const d1 = new Y.Doc();
  const d2 = new Y.Doc();
  createPage(d1, null, 'shared');
  sync2(d1, d2); // both start from the same base
  createPage(d1, null, 'from-d1');
  createPage(d2, null, 'from-d2');
  sync2(d1, d2);
  const t1 = rootTitles(d1).sort();
  const t2 = rootTitles(d2).sort();
  assert(JSON.stringify(t1) === JSON.stringify(t2), 'both docs converge to the same tree');
  assert(t1.length === 3 && t1.includes('from-d1') && t1.includes('from-d2'), `concurrent creates both survive (got ${t1})`);

  console.log('OK — workspace model verified: create/nest, ordered tree, rename, reorder, indent/outdent, recursive delete, and concurrent-merge all pass.');
}

main();
