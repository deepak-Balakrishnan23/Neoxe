import React, { useState, useRef, useCallback } from 'react';
import { Shape, Page, VectorChildNode } from '../../shared/types';
import { useDesignStore } from '../store/useDesignStore';
import { api } from '../ipc/api';
import AssetsPanel from './AssetsPanel';
import TokensPanel from './TokensPanel';
import Icon, { IconName } from './Icon';

// ─────────────────────────────────────────────────────────────────────────────

type DropPos = 'before' | 'after' | 'inside';
interface DropTarget { id: string; pos: DropPos }

const TYPE_ICONS: Record<string, IconName> = {
  rect: 'rect', circle: 'ellipse', frame: 'frame', text: 'text',
  image: 'image', svg: 'code', vector: 'code', path: 'pen', bool: 'group', group: 'group',
};

// A plain frame and an auto-layout frame are different objects — one holds its children at
// fixed coordinates, the other lays them out — so they must not share the generic frame
// glyph. Figma identifies an auto-layout frame by its FLOW, which makes the direction part
// of the icon rather than a decoration next to it.
const AUTO_LAYOUT_ICONS: Record<NonNullable<Shape['autoLayout']>['direction'], IconName> = {
  horizontal: 'flex-row',   // bars side by side
  vertical: 'flex-col',     // bars stacked
  wrap: 'flex-wrap',        // bars wrapping to a second row
  grid: 'grid',             // 2×2 cells
};

function layerIcon(shape: Shape): IconName {
  // Component masters/instances keep their own identity — that outranks the container kind.
  if (shape.componentId || shape.masterId) return 'group';
  if (shape.type === 'frame' && shape.autoLayout) {
    return AUTO_LAYOUT_ICONS[shape.autoLayout.direction] ?? 'flex-row';
  }
  return TYPE_ICONS[shape.type] ?? 'rect';
}

export default function LayersPanel() {
  const [panelTab, setPanelTab] = useState<'layers' | 'assets' | 'tokens'>('layers');
  const { file, activePage, toggleSelected, setFile, clearSelection, vectorEditChildId, setVectorEditShapeId, setVectorEditChildId, groupEditId, setGroupEditId, setSvgEditShapeId, setLivePreviewSvg } = useDesignStore();
  const page = activePage();

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [renamingPageId, setRenamingPageId] = useState<string | null>(null);

  // useCallback so LayerRow (memoized) sees a stable handler reference across renders.
  const toggleCollapse = useCallback((id: string) =>
    setCollapsed(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }), []);

  // ── Visibility & lock ───────────────────────────────────────────────────────
  const toggleAttr = useCallback(async (shape: Shape, attr: 'hidden' | 'locked') => {
    if (!page) return;
    const res = await api.applyChanges({
      pageId: page.id,
      ops: [{ op: 'set', id: shape.id, attr, val: !shape[attr] }],
    });
    if (res.ok && res.data) setFile(res.data);
  }, [page, setFile]);

  // ── Rename layer ────────────────────────────────────────────────────────────
  const commitRename = useCallback(async (id: string, name: string) => {
    if (!page) return;
    const res = await api.applyChanges({
      pageId: page.id,
      ops: [{ op: 'set', id, attr: 'name', val: name.trim() || 'Layer' }],
    });
    if (res.ok && res.data) setFile(res.data);
    setRenamingId(null);
  }, [page, setFile]);

  // ── Drag-to-reorder ─────────────────────────────────────────────────────────
  const handleDragStart = useCallback((id: string) => { setDraggingId(id); }, []);

  const handleDragOver = useCallback((e: React.DragEvent, targetId: string, isContainer: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const { top, height } = el.getBoundingClientRect();
    const relY = e.clientY - top;
    let pos: DropPos;
    if (isContainer && relY > height * 0.25 && relY < height * 0.75) pos = 'inside';
    else if (relY < height / 2) pos = 'before';
    else pos = 'after';
    setDropTarget({ id: targetId, pos });
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    if (!draggingId || !dropTarget || !page || draggingId === dropTarget.id) {
      setDraggingId(null); setDropTarget(null); return;
    }
    const target = page.objects[dropTarget.id];
    const dragged = page.objects[draggingId];
    if (!target || !dragged) { setDraggingId(null); setDropTarget(null); return; }

    let newParentId: string | null;
    let index: number;

    if (dropTarget.pos === 'inside') {
      newParentId = dropTarget.id;
      index = 0;
    } else {
      newParentId = target.parentId;
      const siblings = newParentId ? (page.objects[newParentId]?.childIds ?? []) : page.childIds;
      // Panel shows reversed order, so 'before' in panel = higher index in childIds
      const targetIdx = siblings.indexOf(dropTarget.id);
      index = dropTarget.pos === 'before' ? targetIdx + 1 : targetIdx;
      // Adjust if dragged is in same parent and before target
      const dragSiblings = dragged.parentId ? (page.objects[dragged.parentId]?.childIds ?? []) : page.childIds;
      if (dragged.parentId === newParentId && dragSiblings.indexOf(draggingId) < targetIdx) index--;
    }

    const res = await api.applyChanges({
      pageId: page.id,
      ops: [{ op: 'move', id: draggingId, parentId: newParentId, index: Math.max(0, index) }],
    });
    if (res.ok && res.data) setFile(res.data);
    setDraggingId(null); setDropTarget(null);
  }, [draggingId, dropTarget, page, setFile]);

  const handleDragEnd = () => { setDraggingId(null); setDropTarget(null); };

  // Stable row callbacks so memoized LayerRows don't re-render just because the panel did.
  const onSelectRow = useCallback((id: string, multi: boolean) => {
    if (!page) return;
    // Exit any vector / SVG anchor edit mode when selecting a different layer
    setVectorEditShapeId(null);
    setVectorEditChildId(null);
    setSvgEditShapeId(null);
    setLivePreviewSvg(null);
    const s = page.objects[id];
    const par = s?.parentId ? page.objects[s.parentId] : null;
    if (par?.isSVGImport && groupEditId !== par.id) setGroupEditId(par.id);
    toggleSelected(id, multi);
  }, [page, groupEditId, setVectorEditShapeId, setVectorEditChildId, setSvgEditShapeId, setLivePreviewSvg, setGroupEditId, toggleSelected]);

  const onSelectVectorChildRow = useCallback((shapeId: string, childId: string) => {
    setVectorEditShapeId(shapeId);
    setVectorEditChildId(childId);
  }, [setVectorEditShapeId, setVectorEditChildId]);

  if (!page) return (
    <div style={styles.panel}>
      <TabBar tab={panelTab} onSwitch={setPanelTab} />
      <div style={styles.empty}>No file open</div>
    </div>
  );

  const rootIds = [...page.childIds].reverse();

  return (
    <div style={styles.panel}
      onDragOver={(e) => e.preventDefault()}
      onDrop={panelTab === 'layers' ? handleDrop : undefined}
    >
      <TabBar tab={panelTab} onSwitch={setPanelTab} />

      {/* Assets panel */}
      {panelTab === 'assets' && <AssetsPanel />}

      {/* Tokens panel */}
      {panelTab === 'tokens' && <TokensPanel />}

      {/* Layers panel */}
      {panelTab === 'layers' && <>
      <div style={styles.list} onDragEnd={handleDragEnd}>
        {rootIds.map(id => (
          <LayerRow
            key={id}
            id={id}
            depth={0}
            collapsed={collapsed}
            renamingId={renamingId}
            draggingId={draggingId}
            dropTarget={dropTarget}
            onSelect={onSelectRow}
            onToggleCollapse={toggleCollapse}
            onToggleAttr={toggleAttr}
            onStartRename={setRenamingId}
            onCommitRename={commitRename}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            vectorEditChildId={vectorEditChildId}
            onSelectVectorChild={onSelectVectorChildRow}
          />
        ))}
      </div>

      {/* ── Pages ────────────────────────────────────────────────────────── */}
      </> /* end layers tab */}
      <div style={styles.pageSection}>
        <div style={styles.pageSectionHeader}>
          <span>Pages</span>
          <button
            style={styles.addBtn}
            title="Add page"
            onClick={async () => {
              const res = await api.addPage();
              if (res.ok && res.data) { setFile(res.data); clearSelection(); }
            }}
          >＋</button>
        </div>
        {file!.pages.map(p => (
          <div
            key={p.id}
            className="layer-row"
            style={{
              ...styles.pageRow,
              background: p.id === file!.activePageId ? 'var(--accent-soft)' : undefined,
              color: p.id === file!.activePageId ? 'var(--text)' : 'var(--text-secondary)',
            }}
            onClick={async () => {
              if (p.id === file!.activePageId) return;
              const res = await api.switchPage(p.id);
              if (res.ok && res.data) { setFile(res.data); clearSelection(); }
            }}
          >
            {renamingPageId === p.id ? (
              <input
                autoFocus
                defaultValue={p.name}
                style={styles.renameInput}
                onBlur={async (e) => {
                  const res = await api.renamePage(p.id, e.target.value || p.name);
                  if (res.ok && res.data) setFile(res.data);
                  setRenamingPageId(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setRenamingPageId(null);
                  e.stopPropagation();
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                style={styles.pageName}
                onDoubleClick={(e) => { e.stopPropagation(); setRenamingPageId(p.id); }}
              >
                {p.name}
              </span>
            )}
            {file!.pages.length > 1 && (
              <button
                className="layer-action"
                style={styles.deletePageBtn}
                title="Delete page"
                onClick={async (e) => {
                  e.stopPropagation();
                  const res = await api.deletePage(p.id);
                  if (res.ok && res.data) { setFile(res.data); clearSelection(); }
                }}
              >×</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── TabBar ───────────────────────────────────────────────────────────────────

type PanelTab = 'layers' | 'assets' | 'tokens';
function TabBar({ tab, onSwitch }: { tab: PanelTab; onSwitch: (t: PanelTab) => void }) {
  return (
    <div style={tabStyles.bar}>
      <button style={{ ...tabStyles.btn, ...(tab === 'layers' ? tabStyles.active : {}) }} onClick={() => onSwitch('layers')}>Layers</button>
      <button style={{ ...tabStyles.btn, ...(tab === 'assets' ? tabStyles.active : {}) }} onClick={() => onSwitch('assets')}>Assets</button>
      <button style={{ ...tabStyles.btn, ...(tab === 'tokens' ? tabStyles.active : {}) }} onClick={() => onSwitch('tokens')}>Tokens</button>
    </div>
  );
}

const tabStyles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex', borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  btn: {
    flex: 1, background: 'transparent', borderWidth: 0, borderStyle: 'solid',
    borderBottomWidth: 2, borderBottomColor: 'transparent',
    color: 'var(--text-secondary)', fontSize: 12, padding: '0 4px', cursor: 'pointer',
    fontFamily: 'var(--font-ui)',
    height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  active: { color: 'var(--text)', borderBottomColor: 'var(--accent)' },
};

// ── LayerRow ────────────────────────────────────────────────────────────────

interface RowProps {
  id: string;
  depth: number;
  collapsed: Set<string>;
  renamingId: string | null;
  draggingId: string | null;
  dropTarget: DropTarget | null;
  onSelect: (id: string, multi: boolean) => void;
  onToggleCollapse: (id: string) => void;
  onToggleAttr: (shape: Shape, attr: 'hidden' | 'locked') => void;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, name: string) => void;
  onDragStart: (id: string) => void;
  onDragOver: (e: React.DragEvent, id: string, isContainer: boolean) => void;
  vectorEditChildId: string | null;
  onSelectVectorChild: (shapeId: string, childId: string) => void;
}

const LayerRow = React.memo(function LayerRow(props: RowProps) {
  const { id, depth, collapsed, renamingId, draggingId, dropTarget } = props;
  // Hooks must run before any early return (rules of hooks) — a shape toggling in/out of
  // existence would otherwise change hook order and corrupt React's hook state.
  const nameRef = useRef<HTMLInputElement>(null);
  // Per-row subscriptions to THIS shape + its selection. Combined with the engine's
  // structural-sharing snapshots (unchanged shapes keep their object identity), an edit to
  // one shape re-renders only its own row — not the whole tree. (The `page` object identity
  // changes every edit, so taking it as a prop would defeat the memo.)
  const selected = useDesignStore(s => s.selectedIds.has(id));
  const shape = useDesignStore(s => {
    const f = s.file;
    if (!f) return undefined;
    const p = f.pages.find(pg => pg.id === f.activePageId);
    return p?.objects[id];
  });
  if (!shape) return null;

  const isContainer = shape.type === 'frame' || shape.type === 'group' || shape.type === 'vector';
  const isCollapsed = collapsed.has(id);
  const isDragging = draggingId === id;
  const isDropBefore = dropTarget?.id === id && dropTarget.pos === 'before';
  const isDropAfter = dropTarget?.id === id && dropTarget.pos === 'after';
  const isDropInside = dropTarget?.id === id && dropTarget.pos === 'inside';
  const renaming = renamingId === id;

  return (
    <>
      {isDropBefore && <div style={styles.dropLine} />}
      <div
        draggable
        className="layer-row"
        onDragStart={(e) => { e.stopPropagation(); props.onDragStart(id); }}
        onDragOver={(e) => props.onDragOver(e, id, isContainer)}
        style={{
          ...styles.row,
          paddingLeft: 10 + depth * 16,
          background: isDropInside || selected ? 'var(--accent-soft)' : undefined,
          boxShadow: selected ? 'inset 2px 0 0 var(--accent)' : undefined,
          color: selected ? 'var(--text)' : shape.hidden ? 'var(--text-faint)' : 'var(--text-secondary)',
          opacity: isDragging ? 0.4 : 1,
        }}
        onClick={(e) => props.onSelect(id, e.shiftKey || e.metaKey)}
      >
        {/* Expand/collapse toggle */}
        <span
          style={{ ...styles.chevron, opacity: isContainer ? 1 : 0 }}
          onClick={(e) => { e.stopPropagation(); if (isContainer) props.onToggleCollapse(id); }}
        >
          {isContainer && <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={11} />}
        </span>

        {/* Type icon — accent tint for component master/instance */}
        <span style={{
          ...styles.typeIcon,
          color: shape.componentId || shape.masterId ? 'var(--accent-hover)' : undefined,
          opacity: shape.componentId || shape.masterId ? 1 : 0.75,
        }}>
          <Icon name={layerIcon(shape)} size={13} />
        </span>

        {/* Name */}
        {renaming ? (
          <input
            ref={nameRef}
            autoFocus
            defaultValue={shape.name}
            style={styles.renameInput}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => props.onCommitRename(id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') props.onCommitRename(id, (e.target as HTMLInputElement).value);
              if (e.key === 'Escape') props.onCommitRename(id, shape.name);
              e.stopPropagation();
            }}
          />
        ) : (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden', flex: 1 }}>
            <span
              style={styles.name}
              onDoubleClick={(e) => { e.stopPropagation(); props.onStartRename(id); }}
            >
              {shape.name}
            </span>
          </span>
        )}

        {/* Eye & lock icons (right side) */}
        <span
          style={{ ...styles.icon, opacity: shape.hidden ? 1 : 0, color: shape.hidden ? 'var(--text-secondary)' : undefined }}
          className="layer-action"
          title={shape.hidden ? 'Show' : 'Hide'}
          onClick={(e) => { e.stopPropagation(); props.onToggleAttr(shape, 'hidden'); }}
        >
          <Icon name={shape.hidden ? 'eye-off' : 'eye'} size={13} />
        </span>
        <span
          style={{ ...styles.icon, opacity: shape.locked ? 1 : 0, color: shape.locked ? 'var(--danger)' : undefined }}
          className="layer-action"
          title={shape.locked ? 'Unlock' : 'Lock'}
          onClick={(e) => { e.stopPropagation(); props.onToggleAttr(shape, 'locked'); }}
        >
          <Icon name={shape.locked ? 'lock' : 'unlock'} size={13} />
        </span>
      </div>
      {isDropAfter && <div style={styles.dropLine} />}

      {/* Children */}
      {isContainer && !isCollapsed && shape.type !== 'vector' && [...shape.childIds].reverse().map(childId => (
        <LayerRow key={childId} {...props} id={childId} depth={depth + 1} />
      ))}
      {shape.type === 'vector' && !isCollapsed && (shape.vectorChildren ?? []).map(child => (
        <VectorChildRow
          key={child.id}
          node={child}
          depth={depth + 1}
          selectedChildId={props.vectorEditChildId}
          shapeId={id}
          onSelectChild={props.onSelectVectorChild}
        />
      ))}
    </>
  );
});

// ── VectorChildRow ──────────────────────────────────────────────────────────

function VectorChildRow({ node, depth, selectedChildId, shapeId, onSelectChild }: {
  node: VectorChildNode;
  depth: number;
  selectedChildId: string | null;
  shapeId: string;
  onSelectChild: (shapeId: string, childId: string) => void;
}) {
  const CHILD_ICONS: Record<string, IconName> = {
    'vector-path': 'pen', 'vector-rect': 'rect', 'vector-circle': 'ellipse',
    'vector-ellipse': 'ellipse', 'vector-group': 'group', 'vector-line': 'pen',
    'vector-poly': 'pen', 'vector-raw': 'code',
  };
  const isSelected = node.id === selectedChildId;
  return (
    <>
      <div
        style={{
          ...styles.row,
          paddingLeft: 10 + depth * 16,
          background: isSelected ? 'var(--accent-soft)' : undefined,
          boxShadow: isSelected ? 'inset 2px 0 0 var(--accent)' : undefined,
          color: 'var(--text-secondary)',
        }}
        onClick={() => onSelectChild(shapeId, node.id)}
      >
        <span style={{ ...styles.chevron, opacity: 0 }}></span>
        <span style={{ ...styles.typeIcon, opacity: 0.75 }}>
          <Icon name={CHILD_ICONS[node.type] ?? 'rect'} size={13} />
        </span>
        <span style={styles.name}>{node.name}</span>
      </div>
      {node.type === 'vector-group' && (node.children ?? []).map(child => (
        <VectorChildRow
          key={child.id}
          node={child}
          depth={depth + 1}
          selectedChildId={selectedChildId}
          shapeId={shapeId}
          onSelectChild={onSelectChild}
        />
      ))}
    </>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 220,
    background: 'var(--bg-panel)',
    borderRight: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    overflow: 'hidden',
    fontFamily: 'var(--font-ui)',
    userSelect: 'none',
  },
  list: {
    flex: 1,
    overflowY: 'auto',
    padding: '6px 0',
    minHeight: 0,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    paddingTop: 0,
    paddingBottom: 0,
    paddingRight: 10,
    fontSize: 12,
    cursor: 'pointer',
    height: 28,
  },
  chevron: {
    width: 12,
    flexShrink: 0,
    cursor: 'pointer',
    color: 'var(--text-muted)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  typeIcon: {
    flexShrink: 0,
    opacity: 0.75,
    width: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 12,
  },
  renameInput: {
    flex: 1,
    background: 'var(--border)',
    border: '1px solid var(--accent)',
    borderRadius: 4,
    color: 'var(--text)',
    fontSize: 12,
    padding: '1px 4px',
    outline: 'none',
    fontFamily: 'var(--font-ui)',
  },
  icon: {
    fontSize: 11,
    flexShrink: 0,
    cursor: 'pointer',
    width: 14,
    textAlign: 'center',
  },
  dropLine: {
    height: 2,
    background: 'var(--accent)',
    margin: '0 8px',
    borderRadius: 2,
    pointerEvents: 'none',
  },
  empty: {
    padding: 16,
    color: 'var(--text-secondary)',
    fontSize: 13,
  },
  // ── Pages ──────────────────────────────────────────────────────────────────
  pageSection: {
    borderTop: '1px solid var(--border)',
    flexShrink: 0,
    maxHeight: 160,
    overflowY: 'auto',
  },
  pageSectionHeader: {
    padding: '8px 12px 4px',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  addBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
    fontSize: 16,
    cursor: 'pointer',
    lineHeight: 1,
    width: 24, height: 24, borderRadius: 4, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '0 4px',
  },
  pageRow: {
    display: 'flex',
    alignItems: 'center',
    padding: '4px 12px',
    fontSize: 12,
    cursor: 'pointer',
    borderRadius: 4,
    margin: '1px 4px',
    gap: 4,
  },
  pageName: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  deletePageBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
    fontSize: 13,
    cursor: 'pointer',
    opacity: 0,
    padding: '0 2px',
    lineHeight: 1,
    flexShrink: 0,
  },
};
