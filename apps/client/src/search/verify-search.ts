/**
 * Phase 6 — client-side search. Pure (no IndexedDB/DOM): checks XML-fragment
 * text extraction and the search matching/ranking/snippet logic.
 *
 * Run: ./apps/server/node_modules/.bin/tsx apps/client/src/search/verify-search.ts
 */
import * as Y from 'yjs';
import { xmlFragmentToText } from './extractText';
import { search } from './searchIndex';
import type { SearchEntry } from './searchIndex';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function main() {
  // --- text extraction from a BlockNote-style XML fragment ---
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('document-store');
  const p1 = new Y.XmlElement('paragraph');
  p1.insert(0, [new Y.XmlText('The quick brown fox')]);
  const p2 = new Y.XmlElement('paragraph');
  p2.insert(0, [new Y.XmlText('jumps over the lazy dog')]);
  frag.insert(0, [p1, p2]);

  const text = xmlFragmentToText(frag);
  assert(text.includes('quick brown fox'), `extracts first block (got "${text}")`);
  assert(text.includes('lazy dog'), 'extracts second block');
  assert(/fox\s+jumps/.test(text), 'separates adjacent blocks with whitespace');

  // --- search matching, ranking, snippets ---
  const index: SearchEntry[] = [
    { id: 'p1', title: 'Grocery list', body: 'milk eggs bread' },
    { id: 'p2', title: 'Recipes', body: 'how to bake fresh bread at home in the oven' },
    { id: 'p3', title: 'bread pudding', body: 'a dessert' },
  ];

  assert(search(index, '').length === 0, 'empty query → no results');
  assert(search(index, 'zzz').length === 0, 'no match → no results');

  const r = search(index, 'bread');
  assert(r.length === 3, `all three pages mention bread (got ${r.length})`);
  // Title matches rank first: p3 (title) before p1/p2 (body only).
  assert(r[0].id === 'p3' && r[0].matchedIn === 'title', `title match ranks first (got ${r[0].id}/${r[0].matchedIn})`);
  assert(r[1].matchedIn === 'body' && r[2].matchedIn === 'body', 'body matches follow');

  const bodyHit = r.find((x) => x.id === 'p2')!;
  assert(bodyHit.snippet.toLowerCase().includes('bread'), `snippet contains the term (got "${bodyHit.snippet}")`);

  assert(search(index, 'BREAD').length === 3, 'case-insensitive');

  console.log('OK — search verified: XML→text extraction, matching, title-over-body ranking, snippets, and case-insensitivity all pass.');
}

main();
