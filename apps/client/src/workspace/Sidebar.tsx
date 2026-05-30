import { useState } from 'react';
import type { PageTreeNode } from './workspaceDoc';
import { theme } from '../theme';

export interface SidebarCallbacks {
  onSelect: (id: string) => void;
  onCreate: (parentId: string | null) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, direction: 'up' | 'down') => void;
  onIndent: (id: string) => void;
  onOutdent: (id: string) => void;
}

interface SidebarProps extends SidebarCallbacks {
  tree: PageTreeNode[];
  currentPageId: string | null;
  /** On mobile the sidebar is the whole screen rather than a fixed-width column. */
  fullWidth?: boolean;
}

const iconBtn: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  padding: '0 3px',
  fontSize: 12,
  lineHeight: 1,
  color: theme.textMuted,
};

export function Sidebar({ tree, currentPageId, fullWidth = false, ...cb }: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <aside
      style={{
        width: fullWidth ? '100%' : 260,
        borderRight: fullWidth ? 'none' : `1px solid ${theme.border}`,
        height: '100%',
        overflowY: 'auto',
        background: theme.bgElevated,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 0.75rem 0.5rem' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: theme.textFaint, letterSpacing: 0.4 }}>PAGES</span>
        <button type="button" title="New page" onClick={() => cb.onCreate(null)} style={{ ...iconBtn, fontSize: 16 }}>
          ＋
        </button>
      </div>

      <div style={{ flex: 1 }}>
        {tree.length === 0 ? (
          <p style={{ color: theme.textFaint, fontSize: 13, padding: '0.5rem 0.75rem' }}>No pages yet.</p>
        ) : (
          tree.map((node) => (
            <Row
              key={node.id}
              node={node}
              currentPageId={currentPageId}
              collapsed={collapsed}
              onToggle={toggle}
              {...cb}
            />
          ))
        )}
      </div>
    </aside>
  );
}

interface RowProps extends SidebarCallbacks {
  node: PageTreeNode;
  currentPageId: string | null;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
}

function Row({ node, currentPageId, collapsed, onToggle, ...cb }: RowProps) {
  const [hover, setHover] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(node.title);

  const isCurrent = node.id === currentPageId;
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);

  const commitRename = () => {
    const title = draft.trim() || 'Untitled';
    cb.onRename(node.id, title);
    setRenaming(false);
  };

  return (
    <>
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => cb.onSelect(node.id)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '3px 8px',
          paddingLeft: 8 + node.depth * 14,
          cursor: 'pointer',
          background: isCurrent ? theme.bgActive : hover ? theme.bgHover : 'transparent',
          fontSize: 14,
          color: theme.text,
          userSelect: 'none',
        }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(node.id);
          }}
          style={{ ...iconBtn, width: 14, visibility: hasChildren ? 'visible' : 'hidden' }}
          title={isCollapsed ? 'Expand' : 'Collapse'}
        >
          {isCollapsed ? '▸' : '▾'}
        </button>

        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
            style={{ flex: 1, fontSize: 14, border: `1px solid ${theme.borderStrong}`, borderRadius: 4, padding: '1px 4px', background: theme.bgInput, color: theme.text }}
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.stopPropagation();
              setDraft(node.title);
              setRenaming(true);
            }}
            style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={node.title}
          >
            {node.title || 'Untitled'}
          </span>
        )}

        {hover && !renaming && (
          <span style={{ display: 'flex', alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
            <button type="button" style={iconBtn} title="Move up" onClick={() => cb.onMove(node.id, 'up')}>↑</button>
            <button type="button" style={iconBtn} title="Move down" onClick={() => cb.onMove(node.id, 'down')}>↓</button>
            <button type="button" style={iconBtn} title="Outdent" onClick={() => cb.onOutdent(node.id)}>←</button>
            <button type="button" style={iconBtn} title="Indent" onClick={() => cb.onIndent(node.id)}>→</button>
            <button type="button" style={iconBtn} title="Add subpage" onClick={() => cb.onCreate(node.id)}>＋</button>
            <button type="button" style={iconBtn} title="Delete" onClick={() => cb.onDelete(node.id)}>🗑</button>
          </span>
        )}
      </div>

      {!isCollapsed &&
        node.children.map((child) => (
          <Row
            key={child.id}
            node={child}
            currentPageId={currentPageId}
            collapsed={collapsed}
            onToggle={onToggle}
            {...cb}
          />
        ))}
    </>
  );
}
