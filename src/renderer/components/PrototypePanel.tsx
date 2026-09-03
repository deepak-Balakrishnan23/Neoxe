import React, { useState } from 'react';
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
  // Fixed-size (the Figma default) presents each screen at its artboard size, scaled to
  // fit. Responsive hands layout back to the browser so a design built from Fill/Hug/Wrap
  // reflows in the window instead of being shrunk to fit it.
  const [responsive, setResponsive] = useState(false);
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

  // Only top-level FRAMES become screens (Figma model — content outside any frame can't
  // be presented). With none, generatePrototypeHtml silently returns an empty shell, which
  // reads as "the export is broken" rather than "there's nothing to export yet". Guard both
  // entry points so that never happens silently.
  const present = () => {
    if (frames.length === 0) { showToast('Add a frame before presenting: content outside a frame can’t be shown'); return; }
    const html = generatePrototypeHtml(file, page, { responsive });
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    window.open(url, '_blank');
  };

  const exportHtml = async () => {
    if (frames.length === 0) { showToast('Add a frame before exporting: content outside a frame can’t be shown'); return; }
    const res = await exportTextFile({
      content: generatePrototypeHtml(file, page, { responsive }),
      suggestedName: file.name || 'prototype',
      extension: 'html', description: 'HTML Prototype', mime: 'text/html',
    });
    if (res.saved) showToast('Prototype exported');
    // cancelled → no toast
  };

  return (
    <div style={s.panel}>
      <div style={s.section}>
        <div style={s.label}>Presentation</div>
        <label style={s.checkRow} title="Reflow each screen to the window instead of scaling the artboard to fit">
          <input type="checkbox" checked={responsive} style={{ margin: 0, cursor: 'pointer' }}
            onChange={e => setResponsive(e.target.checked)} />
          <span>Responsive (reflow to window)</span>
        </label>
      </div>

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
            No connections yet. Hover a frame's edge or corner to reveal its <span style={s.inlineDot}>⊕</span> connect
            handle, then drag it onto another frame to link them, or select a layer and add an interaction below.
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
                    <span style={s.dst}>{target?.name ?? 'None'}</span>
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
  checkRow: {
    display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
    color: 'var(--text-secondary)', fontSize: 12, minHeight: 24,
  },
  panel: { display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 16px' },
  section: { display: 'flex', flexDirection: 'column', gap: 8 },
  label: {
    fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)',
    letterSpacing: '0.06em', textTransform: 'uppercase',
    lineHeight: '16px', minHeight: 24, display: 'flex', alignItems: 'center',
  },
  select: {
    background: 'var(--bg-inset)', border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--text)', fontSize: 12, padding: '0 8px', height: 28, outline: 'none', cursor: 'pointer',
    minWidth: 0,
  },
  empty: { fontSize: 12, color: 'var(--text-secondary)', lineHeight: '20px', background: 'var(--border)', borderRadius: 6, padding: 12 },
  inlineDot: { color: 'var(--accent)', fontWeight: 700 },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  row: {
    display: 'flex', flexDirection: 'column', gap: 4, background: 'var(--row-hover)',
    borderRadius: 6, padding: 8, cursor: 'pointer',
  },
  rowMain: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)', fontSize: 12 },
  src: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 },
  dst: { color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 },
  rowMeta: { display: 'flex', alignItems: 'center', gap: 8 },
  badge: {
    fontSize: 10, color: 'var(--text-secondary)', background: 'var(--bg-inset)',
    borderRadius: 4, padding: '2px 8px', textTransform: 'capitalize',
  },
  del: {
    marginLeft: 'auto', width: 24, height: 24, borderRadius: 6, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', color: 'var(--text-muted)',
    fontSize: 16, lineHeight: 1, cursor: 'pointer', padding: 0,
  },
  actions: { display: 'flex', gap: 8 },
  present: {
    flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
    background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--text)', fontSize: 12, padding: '0 8px', height: 28, cursor: 'pointer', fontWeight: 500,
    whiteSpace: 'nowrap',
  },
  export: {
    flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
    background: 'var(--accent)', border: 'none', borderRadius: 6,
    color: '#fff', fontSize: 12, padding: '0 8px', height: 28, cursor: 'pointer', fontWeight: 600,
    whiteSpace: 'nowrap',
  },
};
