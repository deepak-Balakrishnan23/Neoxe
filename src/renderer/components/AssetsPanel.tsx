import React, { useState } from 'react';
import { DesignFile, ChangeOp } from '../../shared/types';
import { useDesignStore } from '../store/useDesignStore';
import { api } from '../ipc/api';
import ColorPicker from './ColorPicker';

type Tab = 'components' | 'colors' | 'typography';

export default function AssetsPanel() {
  const [tab, setTab] = useState<Tab>('components');
  const { file } = useDesignStore();
  if (!file) return <div style={styles.empty}>No file open</div>;

  return (
    <div style={styles.panel}>
      {/* Tab bar */}
      <div style={styles.tabs}>
        {(['components', 'colors', 'typography'] as Tab[]).map(t => (
          <button
            key={t}
            style={{ ...styles.tab, ...(tab === t ? styles.tabActive : {}) }}
            onClick={() => setTab(t)}
          >
            {t === 'components' ? '⊞' : t === 'colors' ? '◉' : 'T'}
          </button>
        ))}
      </div>

      <div style={styles.content}>
        {tab === 'components' && <ComponentsTab />}
        {tab === 'colors' && <ColorsTab />}
        {tab === 'typography' && <TypographyTab />}
      </div>
    </div>
  );
}

// ── Components tab ────────────────────────────────────────────────────────────

function ComponentsTab() {
  const { file } = useDesignStore();
  const components = file ? Object.entries(file.components) : [];

  if (components.length === 0) {
    return (
      <div style={styles.emptySection}>
        <div style={styles.emptyIcon}>⊞</div>
        <div>No components yet</div>
        <div style={styles.emptyHint}>Select a shape and press Cmd+K to create a component</div>
      </div>
    );
  }

  return (
    <div style={styles.grid}>
      {components.map(([componentId, entry]) => (
        <ComponentCard
          key={componentId}
          componentId={componentId}
          name={entry.name}
          file={file!}
        />
      ))}
    </div>
  );
}

function ComponentCard({ componentId, name, file }: { componentId: string; name: string; file: DesignFile }) {
  const comp = file.components[componentId];
  const masterPage = file.pages.find(p => p.id === comp?.pageId);
  const master = masterPage?.objects[comp?.shapeId ?? ''];

  const mainColor = master?.fills[0]?.type === 'solid' ? (master.fills[0] as any).color : '#6E72F5';

  return (
    <div
      draggable
      onDragStart={e => {
        e.dataTransfer.setData('component-id', componentId);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      style={styles.compCard}
      title={`Drag to canvas to create an instance of "${name}"`}
    >
      <div style={{ ...styles.compPreview, background: mainColor }}>
        <span style={styles.compPreviewIcon}>{
          master?.type === 'text' ? 'T' :
          master?.type === 'circle' ? '◯' :
          master?.type === 'frame' ? '⬜' : '▭'
        }</span>
      </div>
      <div style={styles.compName}>{name}</div>
    </div>
  );
}

// ── Colors tab ────────────────────────────────────────────────────────────────

function ColorsTab() {
  const { file, setFile, selectedIds, activePage } = useDesignStore();
  const colors = file?.colors ?? [];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAnchor, setEditAnchor] = useState<DOMRect | null>(null);
  const editRef = React.useRef<HTMLDivElement>(null);

  const applyColor = async (hex: string, opacity: number) => {
    const page = activePage();
    if (!page || selectedIds.size === 0) return;
    const ops = [...selectedIds].flatMap((id): ChangeOp[] => {
      const s = page.objects[id];
      if (!s) return [];
      if (s.type === 'text' && s.textStyle)
        return [{ op: 'set', id, attr: 'textStyle', val: { ...s.textStyle, color: hex, opacity } }];
      return [{ op: 'set', id, attr: 'fills', val: [{ type: 'solid', color: hex, opacity }] }];
    });
    if (!ops.length) return;
    const res = await api.applyChanges({ pageId: page.id, ops });
    if (res.ok && res.data) setFile(res.data);
  };

  return (
    <div>
      <div style={styles.sectionHeader}>
        <span>Colors</span>
        <button style={styles.addBtn} title="Add color" onClick={async () => {
          const res = await api.addColor('New Color', '#6E72F5', 1);
          if (res.ok && res.data) setFile(res.data);
        }}>＋</button>
      </div>
      {colors.map(entry => (
        <div key={entry.id} style={styles.colorRow}>
          <div
            ref={editingId === entry.id ? editRef : undefined}
            style={{ ...styles.colorSwatch, background: entry.color }}
            onClick={e => {
              setEditingId(entry.id);
              setEditAnchor((e.target as HTMLElement).getBoundingClientRect());
            }}
          />
          <span style={{ ...styles.colorName, cursor: selectedIds.size ? 'pointer' : 'default' }}
            title={selectedIds.size ? 'Apply to selection' : undefined}
            onClick={() => applyColor(entry.color, entry.opacity)}>{entry.name}</span>
          <span style={styles.colorHex}>{entry.color.toUpperCase()}</span>
          <button style={styles.removeBtn} onClick={async () => {
            const res = await api.deleteColor(entry.id);
            if (res.ok && res.data) setFile(res.data);
          }}>×</button>
          {editingId === entry.id && editAnchor && (
            <ColorPicker
              color={entry.color}
              opacity={entry.opacity}
              onChange={async (color, opacity) => {
                const res = await api.updateColor(entry.id, { color, opacity });
                if (res.ok && res.data) setFile(res.data);
              }}
              onClose={() => setEditingId(null)}
              anchorRect={editAnchor}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Typography tab ────────────────────────────────────────────────────────────

function TypographyTab() {
  const { file, setFile, selectedIds, activePage } = useDesignStore();
  const typos = file?.typographies ?? [];

  const applyTypo = async (style: any) => {
    const page = activePage();
    if (!page || selectedIds.size === 0) return;
    const ops = [...selectedIds].flatMap(id => {
      const s = page.objects[id];
      if (s?.type !== 'text') return [];
      return [{ op: 'set' as const, id, attr: 'textStyle', val: { ...s.textStyle, ...style } }];
    });
    if (!ops.length) return;
    const res = await api.applyChanges({ pageId: page.id, ops });
    if (res.ok && res.data) setFile(res.data);
  };

  return (
    <div>
      <div style={styles.sectionHeader}>
        <span>Typographies</span>
        <button style={styles.addBtn} title="Add typography" onClick={async () => {
          const res = await api.addTypography('New Style', {
            fontFamily: 'system-ui, sans-serif',
            fontWeight: 400, fontSize: 16, lineHeight: 1.4, letterSpacing: 0,
          });
          if (res.ok && res.data) setFile(res.data);
        }}>＋</button>
      </div>
      {typos.map(entry => (
        <div key={entry.id} style={styles.typoRow}>
          <span
            style={{
              ...styles.typoName,
              fontFamily: (entry.style.fontFamily ?? 'system-ui').split(',')[0].trim(),
              fontWeight: entry.style.fontWeight ?? 400,
              fontSize: Math.min(entry.style.fontSize ?? 14, 20),
              cursor: selectedIds.size ? 'pointer' : 'default',
            }}
            title={selectedIds.size ? 'Apply to selected text' : undefined}
            onClick={() => applyTypo(entry.style)}
          >
            {entry.name}
          </span>
          <span style={styles.typoMeta}>
            {entry.style.fontSize}px · {entry.style.fontWeight}
          </span>
          <button style={styles.removeBtn} onClick={async () => {
            const res = await api.deleteTypography(entry.id);
            if (res.ok && res.data) setFile(res.data);
          }}>×</button>
        </div>
      ))}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  panel: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui' },
  tabs: { display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  tab: {
    flex: 1, background: 'transparent', borderWidth: 0, borderStyle: 'solid',
    borderBottomWidth: 2, borderBottomColor: 'transparent', color: 'var(--text-secondary)',
    fontSize: 16, padding: '8px 4px', cursor: 'pointer',
  },
  tabActive: { color: 'var(--text)', borderBottomColor: 'var(--accent)' },
  content: { flex: 1, overflowY: 'auto', padding: '8px 8px' },
  empty: { padding: 16, color: 'var(--text-secondary)', fontSize: 12 },
  emptySection: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: 8, padding: '24px 12px', color: 'var(--text-secondary)', fontSize: 12, textAlign: 'center',
  },
  emptyIcon: { fontSize: 32, opacity: 0.4 },
  emptyHint: { fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  compCard: {
    background: 'var(--row-hover)', border: '1px solid var(--border-strong)',
    borderRadius: 6, overflow: 'hidden', cursor: 'grab',
  },
  compPreview: {
    height: 60, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  compPreviewIcon: { fontSize: 20, color: 'rgba(255,255,255,0.7)' },
  compName: {
    padding: '4px 6px', fontSize: 11, color: 'var(--text-secondary)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  sectionHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)',
    letterSpacing: '0.06em', textTransform: 'uppercase',
    marginBottom: 8, paddingBottom: 4, borderBottom: '1px solid var(--border)',
  },
  addBtn: { background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 16, cursor: 'pointer' },
  colorRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', fontSize: 12 },
  colorSwatch: {
    width: 18, height: 18, borderRadius: 4, flexShrink: 0,
    border: '1px solid var(--border-strong)', cursor: 'pointer',
  },
  colorName: { flex: 1, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis' },
  colorHex: { color: 'var(--text-secondary)', fontSize: 11, fontFamily: 'monospace' },
  removeBtn: { background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer', padding: '0 2px' },
  typoRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 0', borderBottom: '1px solid var(--row-hover)' },
  typoName: { flex: 1, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  typoMeta: { color: 'var(--text-secondary)', fontSize: 10, flexShrink: 0 },
};
