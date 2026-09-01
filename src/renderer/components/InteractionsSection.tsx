import React from 'react';
import { Shape, Interaction, Transition, Easing, OverlayPosition, OverlaySettings, makeDefaultOverlaySettings } from '../../shared/types';
import { useDesignStore } from '../store/useDesignStore';
import { api } from '../ipc/api';

const TRIGGERS: { v: Interaction['trigger']; label: string }[] = [
  { v: 'click', label: 'Click' },
  { v: 'drag', label: 'Drag' },
  { v: 'hover', label: 'While hovering' },
  { v: 'press', label: 'While pressing' },
  { v: 'key', label: 'Key pressed' },
  { v: 'mouse-enter', label: 'Mouse enter' },
  { v: 'mouse-leave', label: 'Mouse leave' },
  { v: 'mouse-down', label: 'Mouse down' },
  { v: 'mouse-up', label: 'Mouse up' },
  { v: 'after-delay', label: 'After delay' },
];

const ACTIONS: { v: Interaction['action']; label: string }[] = [
  { v: 'navigate', label: 'Navigate to' },
  { v: 'back', label: 'Go back' },
  { v: 'overlay', label: 'Open overlay' },
  { v: 'swap-overlay', label: 'Swap overlay' },
  { v: 'close-overlay', label: 'Close overlay' },
  { v: 'scroll-to', label: 'Scroll to' },
  { v: 'url', label: 'Open URL' },
  { v: 'none', label: 'None' },
];

const TRANSITIONS: { v: Transition; label: string }[] = [
  { v: 'none', label: 'Instant' },
  { v: 'dissolve', label: 'Dissolve' },
  { v: 'smart', label: 'Smart animate' },
  { v: 'slide-left', label: 'Slide left' }, { v: 'slide-right', label: 'Slide right' },
  { v: 'slide-up', label: 'Slide up' }, { v: 'slide-down', label: 'Slide down' },
  { v: 'push-left', label: 'Push left' }, { v: 'push-right', label: 'Push right' },
  { v: 'push-up', label: 'Push up' }, { v: 'push-down', label: 'Push down' },
  { v: 'move-in-left', label: 'Move in left' }, { v: 'move-in-right', label: 'Move in right' },
  { v: 'move-in-up', label: 'Move in up' }, { v: 'move-in-down', label: 'Move in down' },
  { v: 'move-out-left', label: 'Move out left' }, { v: 'move-out-right', label: 'Move out right' },
  { v: 'move-out-up', label: 'Move out up' }, { v: 'move-out-down', label: 'Move out down' },
];

const EASINGS: { v: Easing; label: string }[] = [
  { v: 'ease-out', label: 'Ease out' }, { v: 'ease-in', label: 'Ease in' },
  { v: 'ease-in-out', label: 'Ease in and out' }, { v: 'linear', label: 'Linear' },
  { v: 'ease-out-back', label: 'Gentle overshoot' },
];

const OVERLAY_POSITIONS: { v: OverlayPosition; label: string }[] = [
  { v: 'center', label: 'Center' },
  { v: 'top-left', label: 'Top left' }, { v: 'top-center', label: 'Top center' }, { v: 'top-right', label: 'Top right' },
  { v: 'bottom-left', label: 'Bottom left' }, { v: 'bottom-center', label: 'Bottom center' }, { v: 'bottom-right', label: 'Bottom right' },
  { v: 'manual', label: 'Manual' },
];

// Actions whose animation the runtime can play. 'back' reuses the history transition and
// the rest change nothing on screen, so an animation control there would be a dead input.
const ANIMATED: Interaction['action'][] = ['navigate', 'overlay', 'swap-overlay'];

function genId() { return Math.random().toString(36).slice(2, 10); }

export default function InteractionsSection({ shape }: { shape: Shape }) {
  const { activePage, setFile, file } = useDesignStore();
  const page = activePage();
  if (!page || !file) return null;

  // Top-level frames on this page = navigable screens
  const frames = page.childIds
    .map(id => page.objects[id])
    .filter((s2): s2 is Shape => s2?.type === 'frame');

  // Scroll-to targets: everything inside the frame this shape belongs to.
  const scrollTargets: Shape[] = [];
  const collect = (id: string) => {
    const s2 = page.objects[id];
    if (!s2) return;
    if (s2.id !== shape.frameId) scrollTargets.push(s2);
    s2.childIds.forEach(collect);
  };
  if (page.objects[shape.frameId]) collect(shape.frameId);

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
      targetFrameId: firstOther, transition: 'dissolve', duration: 300, easing: 'ease-out',
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

  const isFrame = shape.type === 'frame';
  const parent = shape.parentId ? page.objects[shape.parentId] : null;
  const parentScrolls = !!parent && !!parent.scrollBehavior && parent.scrollBehavior !== 'none';

  const setAttr = async (attr: string, val: unknown) => {
    const res = await api.applyChanges({ pageId: page.id, ops: [{ op: 'set', id: shape.id, attr, val }] });
    if (res.ok && res.data) setFile(res.data);
  };

  return (
    <div style={s.section}>
      <div style={s.header}>
        <span>Prototype</span>
        <button style={s.add} onClick={addInteraction} title="Add interaction">＋</button>
      </div>

      {/* Start-frame toggle for frames */}
      {isFrame && (
        <button style={{ ...s.startBtn, ...(isStart ? s.startActive : {}) }} onClick={setStart}>
          {isStart ? '★ Start screen' : '☆ Set as start screen'}
        </button>
      )}

      {/* Scroll behaviour: which axes a frame scrolls on, and whether a child rides along. */}
      {isFrame && (
        <div style={s.iRow}>
          <span style={s.tag}>Scroll</span>
          <select style={s.select} value={shape.scrollBehavior ?? 'none'}
            onChange={e => setAttr('scrollBehavior', e.target.value)}>
            <option value="none">No scrolling</option>
            <option value="vertical">Vertical</option>
            <option value="horizontal">Horizontal</option>
            <option value="both">Both</option>
          </select>
        </div>
      )}
      {!isFrame && parentScrolls && (
        <div style={s.iRow}>
          <span style={s.tag}>Position</span>
          <select style={s.select} value={shape.scrollPosition ?? 'scrolls'}
            onChange={e => setAttr('scrollPosition', e.target.value)}>
            <option value="scrolls">Scrolls with content</option>
            <option value="fixed">Fixed (stays in place)</option>
          </select>
        </div>
      )}

      {interactions.length === 0 && (
        <div style={s.empty}>No interactions. Add a click → navigate.</div>
      )}

      {interactions.map(it => {
        const overlay = it.overlay ?? makeDefaultOverlaySettings();
        const setOverlay = (patch: Partial<OverlaySettings>) => update(it.id, { overlay: { ...overlay, ...patch } });
        return (
        <div key={it.id} style={s.interaction}>
          <div style={s.iRow}>
            <span style={s.tag}>On</span>
            <select style={s.select} value={it.trigger}
              onChange={e => update(it.id, { trigger: e.target.value as Interaction['trigger'] })}>
              {TRIGGERS.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
            </select>
            <button style={s.del} onClick={() => remove(it.id)}>×</button>
          </div>

          {it.trigger === 'key' && (
            <div style={s.iRow}>
              <span style={s.tag}>Key</span>
              <input style={s.select} value={it.keyCode ?? 'Enter'} placeholder="Enter"
                onKeyDown={e => { e.preventDefault(); update(it.id, { keyCode: e.key }); }}
                onChange={() => { /* set from the key press above */ }} />
            </div>
          )}
          {it.trigger === 'after-delay' && (
            <div style={s.iRow}>
              <span style={s.tag}>Delay</span>
              <input style={s.select} type="number" min={0} step={100} value={it.delay ?? 1000}
                onChange={e => update(it.id, { delay: Math.max(0, Number(e.target.value)) })} />
              <span style={s.unit}>ms</span>
            </div>
          )}

          <div style={s.iRow}>
            <span style={s.tag}>Do</span>
            <select style={s.select} value={it.action}
              onChange={e => {
                const action = e.target.value as Interaction['action'];
                update(it.id, (action === 'navigate' || action === 'overlay' || action === 'swap-overlay')
                  ? { action, targetFrameId: it.targetFrameId ?? frames[0]?.id }
                  : { action });
              }}>
              {ACTIONS.map(a => <option key={a.v} value={a.v}>{a.label}</option>)}
            </select>
          </div>

          {(it.action === 'navigate' || it.action === 'overlay' || it.action === 'swap-overlay') && (
            <div style={s.iRow}>
              <span style={s.tag}>{it.action === 'navigate' ? 'Go to' : 'Frame'}</span>
              <select style={s.select} value={it.targetFrameId ?? ''}
                onChange={e => update(it.id, { targetFrameId: e.target.value })}>
                {frames.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
          )}

          {(it.action === 'overlay' || it.action === 'swap-overlay') && (
            <>
              <div style={s.iRow}>
                <span style={s.tag}>Where</span>
                <select style={s.select} value={overlay.position}
                  onChange={e => setOverlay({ position: e.target.value as OverlayPosition })}>
                  {OVERLAY_POSITIONS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                </select>
              </div>
              {overlay.position === 'manual' && (
                <div style={s.iRow}>
                  <span style={s.tag}>X / Y</span>
                  <input style={s.select} type="number" value={overlay.x ?? 0}
                    onChange={e => setOverlay({ x: Number(e.target.value) })} />
                  <input style={s.select} type="number" value={overlay.y ?? 0}
                    onChange={e => setOverlay({ y: Number(e.target.value) })} />
                </div>
              )}
              <label style={s.check}>
                <input type="checkbox" checked={overlay.background === 'dim'}
                  onChange={e => setOverlay({ background: e.target.checked ? 'dim' : 'none' })} />
                Dim the screen behind
              </label>
              <label style={s.check}>
                <input type="checkbox" checked={overlay.closeOnClickOutside}
                  onChange={e => setOverlay({ closeOnClickOutside: e.target.checked })} />
                Close when clicking outside
              </label>
            </>
          )}

          {it.action === 'scroll-to' && (
            <div style={s.iRow}>
              <span style={s.tag}>Layer</span>
              <select style={s.select} value={it.scrollTargetId ?? ''}
                onChange={e => update(it.id, { scrollTargetId: e.target.value })}>
                <option value="">Choose a layer…</option>
                {scrollTargets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
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

          {ANIMATED.includes(it.action) && (
            <>
              <div style={s.iRow}>
                <span style={s.tag}>Anim</span>
                <select style={s.select} value={it.transition}
                  onChange={e => update(it.id, { transition: e.target.value as Transition })}>
                  {TRANSITIONS.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
                </select>
              </div>
              {it.transition !== 'none' && (
                <div style={s.iRow}>
                  <span style={s.tag}>Curve</span>
                  <select style={s.select} value={it.easing ?? 'ease-out'}
                    onChange={e => update(it.id, { easing: e.target.value as Easing })}>
                    {EASINGS.map(x => <option key={x.v} value={x.v}>{x.label}</option>)}
                  </select>
                  <input style={{ ...s.select, maxWidth: 62 }} type="number" min={0} step={50}
                    value={it.duration ?? 300}
                    onChange={e => update(it.id, { duration: Math.max(0, Number(e.target.value)) })} />
                  <span style={s.unit}>ms</span>
                </div>
              )}
            </>
          )}
        </div>
        );
      })}
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
  unit: { fontSize: 10, color: 'var(--text-secondary)', flexShrink: 0 },
  check: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer' },
};
