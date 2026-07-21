import React from 'react';
import { Shape, Interaction, Transition } from '../../shared/types';
import { useDesignStore } from '../store/useDesignStore';
import { api } from '../ipc/api';

const TRANSITIONS: Transition[] = ['none', 'dissolve', 'slide-left', 'slide-right', 'slide-up', 'smart'];

function genId() { return Math.random().toString(36).slice(2, 10); }

export default function InteractionsSection({ shape }: { shape: Shape }) {
  const { activePage, setFile, file } = useDesignStore();
  const page = activePage();
  if (!page || !file) return null;

  // Top-level frames on this page = navigable screens
  const frames = page.childIds
    .map(id => page.objects[id])
    .filter(s => s?.type === 'frame');

  const interactions = shape.interactions ?? [];

  const setInteractions = async (next: Interaction[]) => {
    const res = await api.applyChanges({
      pageId: page.id,
      ops: [{ op: 'set', id: shape.id, attr: 'interactions', val: next }],
    });
    if (res.ok && res.data) setFile(res.data);
  };

  const addInteraction = () => {
    const firstOther = frames.find(f => f.id !== shape.frameId)?.id ?? frames[0]?.id;
    setInteractions([...interactions, {
      id: genId(), trigger: 'click', action: 'navigate',
      targetFrameId: firstOther, transition: 'dissolve',
    }]);
  };

  const update = (id: string, patch: Partial<Interaction>) =>
    setInteractions(interactions.map(it => it.id === id ? { ...it, ...patch } : it));

  const remove = (id: string) =>
    setInteractions(interactions.filter(it => it.id !== id));

  const isStart = file.prototypeStartFrameId === shape.id;
  const setStart = async () => {
    const res = await api.setPrototypeStart(shape.id);
    if (res.ok && res.data) setFile(res.data);
  };

  return (
    <div style={s.section}>
      <div style={s.header}>
        <span>Prototype</span>
        <button style={s.add} onClick={addInteraction} title="Add interaction">＋</button>
      </div>

      {/* Start-frame toggle for frames */}
      {shape.type === 'frame' && (
        <button style={{ ...s.startBtn, ...(isStart ? s.startActive : {}) }} onClick={setStart}>
          {isStart ? '★ Start screen' : '☆ Set as start screen'}
        </button>
      )}

      {interactions.length === 0 && (
        <div style={s.empty}>No interactions. Add a click → navigate.</div>
      )}

      {interactions.map(it => (
        <div key={it.id} style={s.interaction}>
          <div style={s.iRow}>
            <span style={s.tag}>On</span>
            <select style={s.select} value={it.trigger}
              onChange={e => update(it.id, { trigger: e.target.value as any })}>
              <option value="click">Click</option>
              <option value="hover">Hover</option>
            </select>
            <button style={s.del} onClick={() => remove(it.id)}>×</button>
          </div>
          {/* Action — the runtime supports navigate / back / open-URL; expose all three
              (they were previously unreachable from the UI). */}
          <div style={s.iRow}>
            <span style={s.tag}>Do</span>
            <select style={s.select} value={it.action}
              onChange={e => {
                const action = e.target.value as Interaction['action'];
                update(it.id, action === 'navigate'
                  ? { action, targetFrameId: it.targetFrameId ?? frames[0]?.id }
                  : { action });
              }}>
              <option value="navigate">Navigate to</option>
              <option value="back">Go back</option>
              <option value="url">Open URL</option>
            </select>
          </div>
          {it.action === 'navigate' && (
            <div style={s.iRow}>
              <span style={s.tag}>Go to</span>
              <select style={s.select} value={it.targetFrameId ?? ''}
                onChange={e => update(it.id, { targetFrameId: e.target.value })}>
                {frames.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
          )}
          {it.action === 'url' && (
            <div style={s.iRow}>
              <span style={s.tag}>URL</span>
              <input style={s.select} type="url" placeholder="https://…"
                value={it.url ?? ''}
                onChange={e => update(it.id, { url: e.target.value })} />
            </div>
          )}
          {it.action !== 'back' && (
            <div style={s.iRow}>
              <span style={s.tag}>Anim</span>
              <select style={s.select} value={it.transition}
                onChange={e => update(it.id, { transition: e.target.value as Transition })}>
                {TRANSITIONS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  section: { padding: '8px 10px 6px', borderTop: '1px solid var(--border)' },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)',
    letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8,
  },
  add: { background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 16, cursor: 'pointer', lineHeight: 1 },
  startBtn: {
    width: '100%', background: 'var(--border)', border: '1px solid var(--border-strong)',
    borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '6px', cursor: 'pointer', marginBottom: 8,
  },
  startActive: { background: 'rgba(245,197,66,0.18)', border: '1px solid rgba(245,197,66,0.5)', color: 'var(--comment)' },
  empty: { fontSize: 11, color: 'var(--text-secondary)', padding: '2px 0 4px' },
  interaction: {
    background: 'var(--row-hover)', borderRadius: 6, padding: 8, marginBottom: 6,
    display: 'flex', flexDirection: 'column', gap: 5,
  },
  iRow: { display: 'flex', alignItems: 'center', gap: 6 },
  tag: { fontSize: 11, color: 'var(--text-secondary)', width: 38, flexShrink: 0 },
  select: {
    flex: 1, background: 'var(--border)', border: '1px solid var(--border-strong)',
    borderRadius: 4, color: 'var(--text)', fontSize: 11, padding: '2px 4px', outline: 'none', cursor: 'pointer',
  },
  del: { background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer', flexShrink: 0 },
};
