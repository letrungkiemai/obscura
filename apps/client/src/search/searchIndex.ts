import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { xmlFragmentToText } from './extractText';

/** One searchable page: title (from the workspace doc) + decrypted body text. */
export interface SearchEntry {
  id: string;
  title: string;
  body: string;
}

export interface SearchResult {
  id: string;
  title: string;
  /** Where the query matched, for display. */
  matchedIn: 'title' | 'body';
  /** A short excerpt around the body match (empty for title-only matches). */
  snippet: string;
}

/**
 * Read one page's body text out of its locally-persisted Yjs doc. We already
 * have the plaintext on this device (it's synced + decrypted into IndexedDB), so
 * search stays fully client-side — the server only ever held ciphertext. Opens
 * the persisted doc read-only, extracts, then tears it down.
 */
export async function loadPageBody(email: string, pageId: string): Promise<string> {
  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(`obscura:${email}:${pageId}`, doc);
  try {
    await persistence.whenSynced;
    return xmlFragmentToText(doc.getXmlFragment('document-store'));
  } finally {
    await persistence.destroy();
    doc.destroy();
  }
}

/** Build the in-memory index over all pages (titles known; bodies loaded locally). */
export async function buildSearchIndex(
  email: string,
  pages: { id: string; title: string }[],
): Promise<SearchEntry[]> {
  return Promise.all(
    pages.map(async ({ id, title }) => ({ id, title, body: await loadPageBody(email, id) })),
  );
}

function makeSnippet(body: string, at: number, query: string): string {
  const radius = 30;
  const start = Math.max(0, at - radius);
  const end = Math.min(body.length, at + query.length + radius);
  const core = body.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${core}${end < body.length ? '…' : ''}`;
}

/**
 * Case-insensitive substring search over the index. Title matches rank above
 * body-only matches; results are otherwise in index (page) order.
 */
export function search(index: SearchEntry[], rawQuery: string): SearchResult[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];

  const titleHits: SearchResult[] = [];
  const bodyHits: SearchResult[] = [];

  for (const entry of index) {
    if (entry.title.toLowerCase().includes(query)) {
      titleHits.push({ id: entry.id, title: entry.title, matchedIn: 'title', snippet: '' });
      continue;
    }
    const at = entry.body.toLowerCase().indexOf(query);
    if (at >= 0) {
      bodyHits.push({
        id: entry.id,
        title: entry.title,
        matchedIn: 'body',
        snippet: makeSnippet(entry.body, at, query),
      });
    }
  }
  return [...titleHits, ...bodyHits];
}
