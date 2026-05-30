import { useEffect, useMemo, useState } from 'react';
import { buildSearchIndex, search } from './searchIndex';
import type { SearchEntry, SearchResult } from './searchIndex';
import { theme, fontStack } from '../theme';

interface SearchModalProps {
  email: string;
  /** Flat list of all pages (id + current title) to index. */
  pages: { id: string; title: string }[];
  onSelect: (pageId: string) => void;
  onClose: () => void;
}

/**
 * Client-side full-text search. The index is built once when the modal opens by
 * loading each page's locally-synced plaintext — the server never sees any of
 * this. Cmd/Ctrl+K opens it (wired in Workspace); Esc closes.
 */
export function SearchModal({ email, pages, onSelect, onClose }: SearchModalProps) {
  const [index, setIndex] = useState<SearchEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  useEffect(() => {
    let alive = true;
    buildSearchIndex(email, pages).then((idx) => {
      if (alive) setIndex(idx);
    });
    return () => {
      alive = false;
    };
  }, [email, pages]);

  const results: SearchResult[] = useMemo(
    () => (index ? search(index, query) : []),
    [index, query],
  );

  useEffect(() => setActive(0), [query]);

  const choose = (r: SearchResult | undefined) => {
    if (!r) return;
    onSelect(r.id);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(results[active]);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingTop: '12vh',
        zIndex: 50,
        fontFamily: fontStack,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{
          width: 560,
          maxWidth: '90vw',
          background: theme.bgElevated,
          border: `1px solid ${theme.border}`,
          borderRadius: 12,
          boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
          overflow: 'hidden',
        }}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={index ? 'Search pages…' : 'Indexing…'}
          disabled={!index}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '1rem 1.25rem',
            fontSize: 16,
            background: 'transparent',
            border: 'none',
            borderBottom: `1px solid ${theme.border}`,
            color: theme.text,
          }}
        />

        <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          {query && results.length === 0 && index && (
            <p style={{ padding: '1rem 1.25rem', color: theme.textMuted, fontSize: 14, margin: 0 }}>
              No matches.
            </p>
          )}
          {results.map((r, i) => (
            <div
              key={r.id}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(r)}
              style={{
                padding: '0.6rem 1.25rem',
                cursor: 'pointer',
                background: i === active ? theme.bgActive : 'transparent',
                borderBottom: `1px solid ${theme.bg}`,
              }}
            >
              <div style={{ fontSize: 14, color: theme.text, display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.title || 'Untitled'}
                </span>
                <span style={{ fontSize: 11, color: theme.textFaint, flexShrink: 0 }}>
                  {r.matchedIn === 'title' ? 'title' : 'body'}
                </span>
              </div>
              {r.snippet && (
                <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.snippet}
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ padding: '0.5rem 1.25rem', fontSize: 11, color: theme.textFaint, borderTop: `1px solid ${theme.border}` }}>
          ↑↓ navigate · ↵ open · esc close — searched locally, never sent to the server
        </div>
      </div>
    </div>
  );
}
