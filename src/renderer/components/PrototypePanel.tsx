import React from 'react';
import { Shape, Interaction } from '../../shared/types';
import { useDesignStore } from '../store/useDesignStore';
import { api } from '../ipc/api';
import { generatePrototypeHtml } from '../../shared/prototype';
import { exportTextFile } from '../io/fileIO';
import Icon from './Icon';

// Whole-flow prototype controls: pick the start screen, see every connection in one
// place, and export/present. Arrows are drawn directly on the canvas (prototype mode).
export default function PrototypePanel() {
  const { file, activePage, setFile, setSelectedIds, showToast } = useDesignStore();
  const page = activePage();
  if (!page || !file) return null;

  const frames = page.childIds.map(id => page.objects[id]).filter((s): s is Shape => s?.type === 'frame');

  // All connections on the page (any shape → frame)
  const links: { source: Shape; it: Interaction }[] = [];
  const walk = (id: string) => {
    const s = page.objects[id];
    if (!s) return;
    for (const it of (s.interactions ?? [])) {
      if (it.action === 'navigate' && it.targetFrameId) links.push({ source: s, it });
    }
    s.childIds.forEach(walk);
  };
  page.childIds.forEach(walk);

  const setStart = async (id: string) => {
    const res = await api.setPrototypeStart(id);
    if (res.ok && res.data) setFile(res.data);
  };

  const removeLink = async (source: Shape, itId: string) => {
    const next = (source.interactions ?? []).filter(i => i.id !== itId);
    const res = await api.applyChanges({ pageId: page.id, ops: [{ op: 'set', id: source.id, attr: 'interactions', val: next }] });
    if (res.ok && res.data) setFile(res.data);
  };

  const present = () => {
    const html = generatePrototypeHtml(file, page);
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    window.open(url, '_blank');
  };

  const exportHtml = async () => {
    const res = await exportTextFile({
      content: generatePrototypeHtml(file, page),
      suggestedName: file.name || 'prototype',
      extension: 'html', description: 'HTML Prototype', mime: 'text/html',
    });
    if (res.saved) showToast('Prototype exported');
    else if (res.unsupported) showToast('Saving not supported in this browser');
  };

  return (
    <div style={s.panel}>
      <div style={s.section}>
        <div style={s.label}>Start screen</div>
        <select style={s.select} value={file.prototypeStartFrameId ?? frames[0]?.id ?? ''}
          onChange={e => setStart(e.target.value)}>
          {frames.length === 0 && <option value="">No frames</option>}
          {frames.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </div>

      <div style={s.section}>
        <div style={s.label}>Connections ({links.length})</div>
        {links.length === 0 ? (
          <div style={s.empty}>
            No connections yet. Drag the <span style={s.inlineDot}>◗</span> handle from a selected layer
            onto a frame to link them — or add one from the Design tab.
          </div>
        ) : (
          <div style={s.list}>
            {links.map(({ source, it }) => {
              const target = it.targetFrameId ? page.objects[it.targetFrameId] : null;
              return (
                <div key={source.id + it.id} style={s.row} onClick={() => setSelectedIds([source.id])} title="Select source layer">
                  <div style={s.rowMain}>
                    <span style={s.src}>{source.name}</span>
                    <Icon name="chevron-right" size={12} />
                    <span style={s.dst}>{target?.name ?? '—'}</span>
                  </div>
                  <div style={s.rowMeta}>
                    <span style={s.badge}>{it.trigger}</span>
                    <span style={s.badge}>{it.transition}</span>
                    <button style={s.del} title="Remove connection"
                      onClick={e => { e.stopPropagation(); removeLink(source, it.id); }}>×</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={s.actions}>
        <button style={s.present} onClick={present}><Icon name="play" size={13} /> Present</button>
        <button style={s.export} onClick={exportHtml}><Icon name="export" size={13} color="#fff" /> Export HTML</button>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  panel: { display: 'flex', flexDirection: 'column', gap: 14, padding: 14, overflowY: 'auto' },
  section: { display: 'flex', flexDirection: 'column', gap: 7 },
  label: { fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.06em', textTransform: 'uppercase' },
  select: {
    background: 'var(--bg-inset)', border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--text)', fontSize: 12, padding: '7px 8px', outline: 'none', cursor: 'pointer',
  },
  empty: { fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, background: 'var(--border)', borderRadius: 6, padding: '10px' },
  inlineDot: { color: 'var(--accent)', fontWeight: 700 },
  list: { display: 'flex', flexDirection: 'column', gap: 6 },
  row: {
    display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--row-hover)',
    borderRadius: 6, padding: '8px 9px', cursor: 'pointer',
  },
  rowMain: { display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text)', fontSize: 12 },
  src: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 },
  dst: { color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 },
  rowMeta: { display: 'flex', alignItems: 'center', gap: 6 },
  badge: {
    fontSize: 10, color: 'var(--text-secondary)', background: 'var(--bg-inset)',
    borderRadius: 4, padding: '2px 6px', textTransform: 'capitalize',
  },
  del: { marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 15, cursor: 'pointer', lineHeight: 1 },
  actions: { display: 'flex', gap: 8, marginTop: 4 },
  present: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--text)', fontSize: 12, padding: '8px', cursor: 'pointer', fontWeight: 500,
  },
  export: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    background: 'var(--accent)', border: 'none', borderRadius: 6,
    color: '#fff', fontSize: 12, padding: '8px', cursor: 'pointer', fontWeight: 600,
  },
};
