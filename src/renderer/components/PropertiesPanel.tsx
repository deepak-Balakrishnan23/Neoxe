import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Shape, Fill, Stroke, Shadow, BlurEffect, TextStyle, BlendMode, makeDefaultShape, VectorChildNode } from '../../shared/types';
import { useDesignStore } from '../store/useDesignStore';
import { api } from '../ipc/api';
import ColorPicker from './ColorPicker';
import { fitTextSize } from '../canvas/textLayout';
import InspectPanel from './InspectPanel';
import PrototypePanel from './PrototypePanel';
import InteractionsSection from './InteractionsSection';
import Icon, { IconName } from './Icon';
import { FRAME_PRESETS, FramePreset } from '../constants/framePresets';
import FontPicker from './FontPicker';

// ── Drag-to-scrub (shared by every numeric field) ─────────────────────────────
// Figma-style scrubber: pointerdown on a field's label/icon captures the pointer,
// horizontal drag adjusts the value (step × 1px), release commits. Modifiers are
// read live from each move event so they can be pressed mid-drag: Shift = ×10
// (coarse), Alt/Option = ×0.1 (fine). The ew-resize cursor is forced on <body>
// for the whole drag so it doesn't flicker while crossing other elements.
function startScrub(
  e: React.PointerEvent,
  cfg: { value: number; step?: number; min?: number; max?: number; decimals?: number; onChange: (v: number) => void },
) {
  if (e.button !== 0) return;
  const el = e.currentTarget as HTMLElement;
  const { value: startVal, step = 1, min, max, decimals = 0, onChange } = cfg;
  const startX = e.clientX;
  try { el.setPointerCapture(e.pointerId); } catch { /* capture unsupported — window listeners still work */ }
  const prevCursor = document.body.style.cursor;
  document.body.style.cursor = 'ew-resize';

  const clamp = (v: number) => {
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    return parseFloat(v.toFixed(decimals));
  };
  const onMove = (me: PointerEvent) => {
    const mult = me.shiftKey ? 10 : me.altKey ? 0.1 : 1;
    onChange(clamp(startVal + (me.clientX - startX) * step * mult));
  };
  const end = (pe: PointerEvent) => {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', end);
    el.removeEventListener('pointercancel', end);
    try { el.releasePointerCapture(pe.pointerId); } catch { /* already released */ }
    document.body.style.cursor = prevCursor;
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  e.preventDefault();
}

// ── NumInput: scrub-label + editable input ────────────────────────────────────

interface NumInputProps {
  label: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  icon?: IconName;
  hideLabel?: boolean;
  onChange: (v: number) => void;
}

function NumInput({ label, value, unit, min, max, step = 1, decimals = 0, icon, hideLabel, onChange }: NumInputProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const clamp = (v: number) => {
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    return parseFloat(v.toFixed(decimals));
  };

  const commit = (raw: string) => {
    const n = parseFloat(raw);
    if (!isNaN(n)) onChange(clamp(n));
    setEditing(false);
  };

  return (
    <div style={hideLabel ? numStyles.wrapBare : numStyles.wrap}>
      {!hideLabel && (
        <span
          style={{ ...numStyles.label, ...(icon ? { display: 'flex', alignItems: 'center', justifyContent: 'center' } : {}) }}
          onPointerDown={e => startScrub(e, { value, step, min, max, decimals, onChange })}
          onDoubleClick={() => { setDraft(String(value)); setEditing(true); }}
          title={`${label} — drag to scrub (Shift = coarse, Alt = fine), double-click to type`}
        >{icon ? <Icon name={icon} size={14} /> : label}</span>
      )}
      {editing ? (
        <input
          autoFocus
          style={numStyles.input}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={e => commit(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') commit(draft);
            if (e.key === 'Escape') setEditing(false);
            if (e.key === 'ArrowUp') { const n = clamp(value + step); onChange(n); setDraft(String(n)); e.preventDefault(); }
            if (e.key === 'ArrowDown') { const n = clamp(value - step); onChange(n); setDraft(String(n)); e.preventDefault(); }
            e.stopPropagation();
          }}
        />
      ) : (
        <span
          style={numStyles.value}
          onClick={() => { setDraft(String(value)); setEditing(true); }}
          title="Click to edit"
        >{decimals > 0 ? value.toFixed(decimals) : Math.round(value)}{unit}</span>
      )}
    </div>
  );
}

// ── GapInput: auto-layout spacing field with an "Auto" (unset) state ─────────
// Figma-style: blank = Auto (spacing auto-distributed / treated as 0 by the engine),
// typing a number pins a fixed gap, clearing the field reverts to Auto. Disabled
// (greyed, non-editable) whenever the container's distribution mode already
// auto-distributes spacing (Space between / around / evenly).

function GapInput({ value, disabled, onChange }: {
  value: number | undefined;
  disabled?: boolean;
  onChange: (v: number | undefined) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') onChange(undefined);
    else {
      const n = parseFloat(trimmed);
      if (!isNaN(n)) onChange(Math.max(-9999, n));
    }
    setEditing(false);
  };

  const startEdit = () => {
    if (disabled) return;
    setDraft(value != null ? String(value) : '');
    setEditing(true);
  };

  const hint = disabled
    ? 'Spacing between items — auto-distributed in this mode'
    : 'Spacing between items — drag to scrub (Shift = coarse, Alt = fine), click to type, clear for Auto';

  return (
    <div style={{ ...numStyles.wrap, opacity: disabled ? 0.45 : 1 }}>
      <span
        style={{ ...numStyles.label, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: disabled ? 'default' : 'ew-resize' }}
        title={hint}
        // Scrubbing from Auto starts at 0 and pins a fixed gap (Figma behavior).
        onPointerDown={disabled ? undefined : e => startScrub(e, { value: value ?? 0, min: -9999, onChange })}
      >
        <Icon name="gap" size={14} />
      </span>
      {editing ? (
        <input
          autoFocus
          style={numStyles.input}
          value={draft}
          placeholder="Auto"
          onChange={e => setDraft(e.target.value)}
          onBlur={e => commit(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') commit(draft);
            if (e.key === 'Escape') setEditing(false);
            e.stopPropagation();
          }}
        />
      ) : (
        <span
          style={{ ...numStyles.value, color: value == null ? 'var(--text-muted)' : 'var(--text)', cursor: disabled ? 'default' : 'text' }}
          onClick={startEdit}
          title={hint}
        >{value != null ? `${value}px` : 'Auto'}</span>
      )}
    </div>
  );
}

const numStyles: Record<string, React.CSSProperties> = {
  wrap: { display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr)', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 },
  wrapBare: { display: 'block', minWidth: 0, flex: 1 },
  label: { color: 'var(--text-muted)', fontSize: 11, cursor: 'ew-resize', userSelect: 'none', flexShrink: 0, width: 22 },
  value: {
    color: 'var(--text)', fontSize: 12, cursor: 'text', fontVariantNumeric: 'tabular-nums',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    background: 'var(--bg-inset)', border: '1px solid transparent', borderRadius: 7,
    padding: '0 9px', minHeight: 30, display: 'flex', alignItems: 'center',
  },
  input: {
    background: 'var(--bg-inset)', border: '1px solid var(--accent)', borderRadius: 7,
    color: 'var(--text)', fontSize: 12, padding: '0 9px', outline: 'none', height: 30,
    width: '100%', minWidth: 0, fontFamily: 'system-ui', fontVariantNumeric: 'tabular-nums',
  },
};

// ── ColorSwatch: opens ColorPicker ───────────────────────────────────────────

interface SwatchProps {
  color: string;
  opacity?: number;
  onChange: (color: string, opacity: number) => void;
  // When provided, the picker can switch between Solid and Gradient and edits the whole fill.
  fill?: Fill;
  onFillChange?: (fill: Fill) => void;
}

function gradientCss(fill: Fill): string {
  if (fill.type === 'linear-gradient' || fill.type === 'radial-gradient') {
    const stops = [...fill.stops].sort((a, b) => a.offset - b.offset)
      .map(s => `${s.color} ${Math.round(s.offset * 100)}%`).join(', ');
    return fill.type === 'radial-gradient' ? `radial-gradient(circle, ${stops})` : `linear-gradient(90deg, ${stops})`;
  }
  return '';
}

function ColorSwatch({ color, opacity = 1, onChange, fill, onFillChange }: SwatchProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const bg = fill && (fill.type === 'linear-gradient' || fill.type === 'radial-gradient') ? gradientCss(fill) : color;

  return (
    <>
      <div
        ref={ref}
        style={{ ...swatchStyles.swatch, background: bg }}
        onClick={() => { setAnchor(ref.current!.getBoundingClientRect()); setOpen(o => !o); }}
        title="Click to edit colour"
      />
      {open && anchor && (
        <ColorPicker
          color={color}
          opacity={opacity}
          onChange={onChange}
          onClose={() => setOpen(false)}
          anchorRect={anchor}
          fill={fill}
          onFillChange={onFillChange}
        />
      )}
    </>
  );
}

const swatchStyles: Record<string, React.CSSProperties> = {
  swatch: {
    width: 20, height: 20, borderRadius: 5, flexShrink: 0,
    border: '1px solid var(--border-strong)', cursor: 'pointer',
    boxShadow: '0 1px 0 rgba(255,255,255,0.08) inset',
  },
};

// ── Section / Row helpers ─────────────────────────────────────────────────────

function Section({ label, children, action }: { label: string; children: React.ReactNode; action?: React.ReactNode }) {
  // Empty sections (e.g. "Fill" with no fills yet) collapse to a single header row —
  // no reserved body space (Figma density).
  // Children.toArray already drops null/undefined/boolean children.
  const hasContent = React.Children.toArray(children).length > 0;
  return (
    <div style={pStyles.section}>
      <div style={{ ...pStyles.sectionHeader, marginBottom: hasContent ? 10 : 0 }}>
        <span>{label}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={pStyles.row}>{children}</div>;
}

function AddBtn({ onClick, title }: { onClick: () => void; title?: string }) {
  return <button style={pStyles.iconAction} onClick={onClick} title={title}><Icon name="plus" size={14} /></button>;
}

function RemoveBtn({ onClick }: { onClick: () => void }) {
  return <button style={pStyles.iconActionMuted} onClick={onClick} title="Remove"><Icon name="trash" size={13} /></button>;
}

const BLEND_MODES: BlendMode[] = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference',
  'exclusion', 'hue', 'saturation', 'color', 'luminosity',
];

const BLEND_MODE_LABELS: Record<string, string> = {
  'normal': 'Normal', 'multiply': 'Multiply', 'screen': 'Screen',
  'overlay': 'Overlay', 'darken': 'Darken', 'lighten': 'Lighten',
  'color-dodge': 'Color Dodge', 'color-burn': 'Color Burn',
  'hard-light': 'Hard Light', 'soft-light': 'Soft Light',
  'difference': 'Difference', 'exclusion': 'Exclusion',
  'hue': 'Hue', 'saturation': 'Saturation', 'color': 'Color', 'luminosity': 'Luminosity',
};

// ── VectorChildPanel ──────────────────────────────────────────────────────────

function findVectorChild(children: VectorChildNode[], id: string): VectorChildNode | null {
  for (const c of children) {
    if (c.id === id) return c;
    if (c.type === 'vector-group' && c.children) {
      const f = findVectorChild(c.children, id);
      if (f) return f;
    }
  }
  return null;
}

function VectorChildPanel({ shapeId, childId, emit }: {
  shapeId: string;
  childId: string;
  emit: (ops: Parameters<typeof api.applyChanges>[0]['ops']) => void;
}) {
  const page = useDesignStore(s => s.activePage)();
  const shape = page?.objects[shapeId];
  const child = shape?.vectorChildren ? findVectorChild(shape.vectorChildren, childId) : null;
  if (!child || !shape) return null;

  const setAttr = (attr: string, val: unknown) =>
    emit([{ op: 'setVectorChild', id: shapeId, childId, attr, val }]);

  const fillHex = child.fill ?? '#000000';
  const strokeHex = child.stroke ?? '#000000';

  return (
    <div style={{ padding: '12px 14px' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>
        Vector · {child.name}
      </div>
      <Row>
        <span style={pStyles.fieldLabel}>Fill</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <ColorSwatch
            color={fillHex}
            opacity={child.opacity}
            onChange={(color) => setAttr('fill', color)}
          />
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {child.fill ? child.fill.replace('#', '').toUpperCase() : 'None'}
          </span>
        </div>
      </Row>
      <Row>
        <span style={pStyles.fieldLabel}>Stroke</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <ColorSwatch
            color={strokeHex}
            opacity={1}
            onChange={(color) => setAttr('stroke', color)}
          />
          <NumInput label="W" value={child.strokeWidth} min={0} step={0.5}
            onChange={v => setAttr('strokeWidth', v)} />
        </div>
      </Row>
      <Row>
        <span style={pStyles.fieldLabel}>Opacity</span>
        <NumInput label="" value={Math.round(child.opacity * 100)} unit="%" min={0} max={100}
          onChange={v => setAttr('opacity', v / 100)} />
      </Row>
    </div>
  );
}

// ── PropertiesPanel ───────────────────────────────────────────────────────────

export default function PropertiesPanel() {
  const { activePage, selectedIds, setFile, rightMode, setRightMode, activeTool, vectorEditShapeId, vectorEditChildId, pathEditShapeId, editingPoints, selectedPointIndices, setEditingPoints, svgEditShapeId, svgEditingPaths, svgSelectedPoints, setSvgEditingPaths } = useDesignStore();
  const page = activePage();

  const shapes: Shape[] = page
    ? [...selectedIds].map(id => page.objects[id]).filter(Boolean)
    : [];

  const emit = useCallback(async (ops: Parameters<typeof api.applyChanges>[0]['ops']) => {
    if (!page) return;
    const res = await api.applyChanges({ pageId: page.id, ops });
    if (res.ok && res.data) setFile(res.data);
  }, [page, setFile]);

  const set = useCallback((id: string, attr: string, val: unknown) =>
    emit([{ op: 'set', id, attr, val }]), [emit]);

  const setAll = useCallback((attr: string, val: unknown) =>
    emit(shapes.map(s => ({ op: 'set' as const, id: s.id, attr, val }))), [emit, shapes]);

  // Add Figma-style auto layout to an existing frame. The frame KEEPS its current size
  // (fixed/fixed) — unlike Shift+A wrapping, which hugs a brand-new wrapper. This avoids
  // a sized screen collapsing to its content the moment a child is added. Children lock
  // to fixed sizing (so they aren't squeezed) and any legacy flex/grid layout is cleared
  // so the two models can't collide.
  const addAutoLayout = useCallback((s: Shape) => {
    emit([
      { op: 'set', id: s.id, attr: 'autoLayout', val: {
        direction: 'horizontal', // spacing omitted — starts as Auto (Figma default)
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        justifyContent: 'start', alignItems: 'start',
      } },
      { op: 'set', id: s.id, attr: 'widthMode', val: 'fixed' },
      { op: 'set', id: s.id, attr: 'heightMode', val: 'fixed' },
      ...s.childIds.flatMap(cid => ([
        { op: 'set' as const, id: cid, attr: 'widthMode', val: 'fixed' },
        { op: 'set' as const, id: cid, attr: 'heightMode', val: 'fixed' },
      ])),
    ]);
  }, [emit]);

  const ModeToggle = (
    <div style={pStyles.modeToggle}>
      <button style={{ ...pStyles.modeBtn, ...(rightMode === 'design' ? pStyles.modeActive : {}) }}
        onClick={() => setRightMode('design')}>Design</button>
      <button style={{ ...pStyles.modeBtn, ...(rightMode === 'prototype' ? pStyles.modeActive : {}) }}
        onClick={() => setRightMode('prototype')}>Prototype</button>
      <button style={{ ...pStyles.modeBtn, ...(rightMode === 'inspect' ? pStyles.modeActive : {}) }}
        onClick={() => setRightMode('inspect')}>Inspect</button>
    </div>
  );

  if (rightMode === 'inspect') {
    return (
      <div style={pStyles.panel}>
        {ModeToggle}
        <InspectPanel />
      </div>
    );
  }

  if (rightMode === 'prototype') {
    // Per-layer interaction editing lives HERE, not in the Design tab (Figma model:
    // the Prototype tab owns everything prototype-related).
    const protoShape = shapes.length === 1 ? shapes[0] : null;
    return (
      <div style={pStyles.panel}>
        {ModeToggle}
        <PrototypePanel />
        {protoShape && <InteractionsSection shape={protoShape} />}
      </div>
    );
  }

  if (shapes.length === 0) {
    if (activeTool === 'frame') {
      return (
        <div style={pStyles.panel}>
          {ModeToggle}
          <FramePresetsPanel />
        </div>
      );
    }
    return (
      <div style={pStyles.panel}>
        {ModeToggle}
        <PageSettingsPanel />
      </div>
    );
  }

  const shape = shapes[0]; // primary shape
  const multi = shapes.length > 1;

  return (
    <div style={pStyles.panel}>
      {ModeToggle}
      {svgEditShapeId && svgSelectedPoints.length > 0 && (() => {
        const ref = svgSelectedPoints[0];
        const pt = svgEditingPaths[ref.pathIndex]?.points[ref.pointIndex];
        if (!pt || pt.command === 'Z') return null;
        return (
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>
              Point {ref.pointIndex + 1}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <NumInput label="X" value={Math.round(pt.x)} onChange={v => {
                const newPaths = svgEditingPaths.map((p, pi) => pi !== ref.pathIndex ? p : {
                  ...p,
                  points: p.points.map((pp, ppi) => ppi !== ref.pointIndex ? pp : { ...pp, x: v }),
                });
                setSvgEditingPaths(newPaths);
              }} />
              <NumInput label="Y" value={Math.round(pt.y)} onChange={v => {
                const newPaths = svgEditingPaths.map((p, pi) => pi !== ref.pathIndex ? p : {
                  ...p,
                  points: p.points.map((pp, ppi) => ppi !== ref.pointIndex ? pp : { ...pp, y: v }),
                });
                setSvgEditingPaths(newPaths);
              }} />
            </div>
          </div>
        );
      })()}
      {vectorEditShapeId && vectorEditChildId && (
        <VectorChildPanel shapeId={vectorEditShapeId} childId={vectorEditChildId} emit={emit} />
      )}
      {pathEditShapeId && selectedPointIndices.length > 0 && (() => {
        const pt = editingPoints[selectedPointIndices[0]];
        if (!pt || pt.command === 'Z') return null;
        return (
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>
              Anchor Point {selectedPointIndices[0] + 1}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <NumInput label="X" value={Math.round(pt.x)} onChange={v => {
                const next = editingPoints.map((p, i) => selectedPointIndices.includes(i) ? { ...p, x: v } : p);
                setEditingPoints(next);
              }} />
              <NumInput label="Y" value={Math.round(pt.y)} onChange={v => {
                const next = editingPoints.map((p, i) => selectedPointIndices.includes(i) ? { ...p, y: v } : p);
                setEditingPoints(next);
              }} />
            </div>
          </div>
        );
      })()}
      <div style={pStyles.header}>
        <span style={pStyles.headerTitle}>{multi ? `${shapes.length} shapes` : shape.name}</span>
        {!multi && <span style={pStyles.headerType}>{shape.type}</span>}
      </div>
      <div style={pStyles.scroll}>

        {/* ── Alignment (multi-selection) ──────────────────────────────── */}
        {multi && <AlignSection shapes={shapes} emit={emit} />}

        {/* ── Transform ─────────────────────────────────────────────────── */}
        {!multi && (
          <Section label="Transform">
            <div style={pStyles.fieldGrid}>
              <NumInput label="X" value={shape.x} onChange={v => set(shape.id, 'x', v)} />
              <NumInput label="Y" value={shape.y} onChange={v => set(shape.id, 'y', v)} />
            </div>
            {(() => {
              const locked = shape.aspectRatioLocked ?? (shape.type === 'image' || shape.type === 'svg');
              const ratio = shape.lockedAspectRatio ?? (shape.height > 0 ? shape.width / shape.height : 1);
              const onW = (v: number) => {
                if (locked) emit([{ op: 'set', id: shape.id, attr: 'width', val: v }, { op: 'set', id: shape.id, attr: 'height', val: Math.max(1, Math.round(v / ratio)) }]);
                else set(shape.id, 'width', v);
              };
              const onH = (v: number) => {
                if (locked) emit([{ op: 'set', id: shape.id, attr: 'height', val: v }, { op: 'set', id: shape.id, attr: 'width', val: Math.max(1, Math.round(v * ratio)) }]);
                else set(shape.id, 'height', v);
              };
              const toggleLock = () => {
                const nowLocked = !locked;
                const ops: Parameters<typeof emit>[0] = [{ op: 'set', id: shape.id, attr: 'aspectRatioLocked', val: nowLocked }];
                if (nowLocked) ops.push({ op: 'set', id: shape.id, attr: 'lockedAspectRatio', val: shape.height > 0 ? shape.width / shape.height : 1 });
                emit(ops);
              };
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
                  <div style={{ flex: 1 }}><NumInput label="W" value={shape.width} min={1} onChange={onW} /></div>
                  <button onClick={toggleLock} title={locked ? 'Unlock ratio' : 'Lock ratio'}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: locked ? 'var(--color-accent, #0d99ff)' : 'var(--color-text-tertiary, #888)', flexShrink: 0 }}>
                    <Icon name={locked ? 'lock' : 'unlock'} size={12} />
                  </button>
                  <div style={{ flex: 1 }}><NumInput label="H" value={shape.height} min={1} onChange={onH} /></div>
                </div>
              );
            })()}
            <div style={pStyles.fieldGrid}>
              {/* No min/max clamp — rotation wraps (scrubbing 350°→10° or past 0°), matching
                  the engine's own normalization; a hard 0–360 clamp trapped the value at the ends. */}
              <NumInput label="R" value={shape.rotation} unit="°" onChange={v => set(shape.id, 'rotation', ((v % 360) + 360) % 360)} />
              <NumInput label="O" value={Math.round(shape.opacity * 100)} unit="%" min={0} max={100}
                onChange={v => set(shape.id, 'opacity', v / 100)} />
            </div>
            <Row>
              <span style={pStyles.fieldLabel}>Blend</span>
              <select
                style={pStyles.select}
                value={shape.blendMode}
                onChange={e => set(shape.id, 'blendMode', e.target.value)}
              >
                {BLEND_MODES.map(m => <option key={m} value={m}>{BLEND_MODE_LABELS[m] ?? m}</option>)}
              </select>
            </Row>
          </Section>
        )}

        {/* ── Auto Layout (Figma-style, the single layout model) ──────────── */}
        {/* Frame without auto layout → offer to add it (hug contents, like Shift+A). */}
        {!multi && shape.type === 'frame' && !shape.autoLayout && (
          <Section label="Auto layout" action={<AddBtn onClick={() => addAutoLayout(shape)} title="Add auto layout" />}>
            <button style={pStyles.addRowBtn} onClick={() => addAutoLayout(shape)}>
              <Icon name="plus" size={13} /> Add auto layout
            </button>
          </Section>
        )}
        {/* Container with autoLayout set → full controls. */}
        {!multi && shape.autoLayout && <AutoLayoutSection shape={shape} set={set} setAll={setAll} />}

        {/* Sizing controls — visible whenever the SELECTED shape is itself inside an
            auto-layout container (so the user can pick how it sizes within the parent). */}
        {!multi && (() => {
          const parent = shape.parentId ? page?.objects[shape.parentId] : null;
          return parent?.autoLayout ? <ChildSizingSection shape={shape} set={set} /> : null;
        })()}

        {/* Multi-selection sizing — when every selected shape lives in an auto-layout parent,
            expose W/H sizing modes applied to all at once (Fixed / Hug / Fill). */}
        {multi && page && shapes.every(s => s.parentId && page.objects[s.parentId]?.autoLayout) && (
          <MultiSizingSection shapes={shapes} setAll={setAll} />
        )}

        {/* ── Appearance (frames, rects, groups) — opacity, stroke weight, corner radius */}
        {!multi && (shape.type === 'frame' || shape.type === 'rect' || shape.type === 'group') && (
          <AppearanceSection shape={shape} set={set} setAll={setAll} />
        )}

        {/* For text, the panel order mirrors Figma: Typography → Fill → Stroke →
            Effects. For everything else: Fill → Stroke → Effects. Empty sections
            collapse to just a header + "+" (no "No X" placeholder boxes). */}

        {/* ── Typography (text shapes, shown first) ─────────────────────── */}
        {shape.type === 'text' && shape.textStyle && !multi && (
          <TypographySection shape={shape} set={set} emit={emit} />
        )}

        {/* ── Fill ──────────────────────────────────────────────────────── */}
        {/* Text shapes: the Fill IS the text colour (Figma represents text colour as a
            fill). Read/write it straight from textStyle so the swatch reflects the
            selected element's current colour. */}
        {shape.type === 'text' && shape.textStyle ? (
          <Section label="Fill">
            <div style={pStyles.fillRow}>
              <ColorSwatch color={shape.textStyle.color} opacity={shape.textStyle.opacity ?? 1}
                onChange={(color, opacity) => set(shape.id, 'textStyle', { ...shape.textStyle, color, opacity })} />
              <span style={pStyles.fillType}>{shape.textStyle.color.toUpperCase().replace('#', '')}</span>
              <NumInput label="" value={Math.round((shape.textStyle.opacity ?? 1) * 100)} unit="%" min={0} max={100}
                onChange={v => set(shape.id, 'textStyle', { ...shape.textStyle, opacity: v / 100 })} />
            </div>
          </Section>
        ) : (
          <Section label="Fill" action={
            <AddBtn title="Add fill" onClick={() => {
              // New fill goes to the TOP of the list (front), like Figma, so it's visible.
              const newFill: Fill = { type: 'solid', color: '#AAAAAA', opacity: 1 };
              setAll('fills', [newFill, ...shape.fills]);
            }} />
          }>
            {shape.fills.map((fill, i) => (
              <FillRow key={i} fill={fill} index={i} shape={shape} setAll={setAll} />
            ))}
          </Section>
        )}

        {/* ── Stroke ────────────────────────────────────────────────────── */}
        <Section label="Stroke" action={
          <AddBtn title="Add stroke" onClick={() => {
            const newStroke: Stroke = { color: '#000000', opacity: 1, width: 1, align: 'center', cap: 'none', style: 'solid' };
            setAll('strokes', [...shape.strokes, newStroke]);
          }} />
        }>
          {shape.strokes.map((stroke, i) => (
            <StrokeRow key={i} stroke={stroke} index={i} shape={shape} setAll={setAll} />
          ))}
        </Section>

        {/* ── Effects (shadows + blur, Figma-style add menu + popover) ───── */}
        <EffectsSection shape={shape} setAll={setAll} />
        {/* (Prototype interactions intentionally NOT here — the Prototype tab owns them.) */}
      </div>
    </div>
  );
}

// ── FillRow ───────────────────────────────────────────────────────────────────

function FillRow({ fill, index, shape, setAll }: {
  fill: Fill; index: number; shape: Shape;
  setAll: (attr: string, val: unknown) => void;
}) {
  const updateFill = (patch: Partial<Fill>) => {
    const fills = shape.fills.map((f, i) => i === index ? { ...f, ...patch } as Fill : f);
    setAll('fills', fills);
  };
  const replaceFill = (next: Fill) => setAll('fills', shape.fills.map((f, i) => (i === index ? next : f)));
  const removeFill = () => setAll('fills', shape.fills.filter((_, i) => i !== index));

  // Fill = solid | linear-gradient | radial-gradient — the union is exhaustive here.
  const label = fill.type === 'solid'
    ? fill.color.replace('#', '').toUpperCase()
    : fill.type === 'linear-gradient' ? 'Linear' : 'Radial';

  return (
    <div style={pStyles.fillRow}>
      <ColorSwatch
        color={fill.type === 'solid' ? fill.color : '#888888'}
        opacity={fill.opacity}
        onChange={(color, opacity) => updateFill({ color, opacity } as Partial<Fill>)}
        fill={fill}
        onFillChange={replaceFill}
      />
      <span style={pStyles.fillType}>{label}</span>
      <NumInput label="" value={Math.round((fill.opacity ?? 1) * 100)} unit="%" min={0} max={100}
        onChange={v => updateFill({ opacity: v / 100 } as Partial<Fill>)} />
      <RemoveBtn onClick={removeFill} />
    </div>
  );
}

// ── StrokeRow ─────────────────────────────────────────────────────────────────

function StrokeRow({ stroke, index, shape, setAll }: {
  stroke: Stroke; index: number; shape: Shape;
  setAll: (attr: string, val: unknown) => void;
}) {
  const updateStroke = (patch: Partial<Stroke>) => {
    const strokes = shape.strokes.map((s, i) => i === index ? { ...s, ...patch } : s);
    setAll('strokes', strokes);
  };

  return (
    <div style={pStyles.fillRow}>
      <ColorSwatch color={stroke.color} opacity={stroke.opacity}
        onChange={(color, opacity) => updateStroke({ color, opacity })} />
      <NumInput label="W" value={stroke.width} min={0.5} step={0.5}
        onChange={v => updateStroke({ width: v })} />
      <select style={{ ...pStyles.select, flex: 1 }}
        value={stroke.align}
        onChange={e => updateStroke({ align: e.target.value as Stroke['align'] })}>
        <option value="center">Center</option>
        <option value="inner">Inner</option>
        <option value="outer">Outer</option>
      </select>
      <RemoveBtn onClick={() => setAll('strokes', shape.strokes.filter((_, i) => i !== index))} />
    </div>
  );
}

// ── Effects (Figma-style) ─────────────────────────────────────────────────────
// Unified "Effects" section over the data model (shadows[] + a single blur). The "+"
// opens a type menu; each effect is a row with a popover editor, like Figma.

type EffectKind = 'drop' | 'inner' | 'layer-blur' | 'background-blur';
const EFFECT_LABELS: Record<EffectKind, string> = {
  drop: 'Drop shadow',
  inner: 'Inner shadow',
  'layer-blur': 'Layer blur',
  'background-blur': 'Background blur',
};
const EFFECT_OPTIONS: EffectKind[] = ['drop', 'inner', 'layer-blur', 'background-blur'];
const isShadowKind = (k: EffectKind) => k === 'drop' || k === 'inner';
function newShadowOf(type: 'drop' | 'inner'): Shadow {
  return { type, offsetX: 0, offsetY: 4, blur: 4, spread: 0, color: '#000000', opacity: 0.25, hidden: false };
}

function EffectsSection({ shape, setAll }: { shape: Shape; setAll: (attr: string, val: unknown) => void }) {
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  const addEffect = (kind: EffectKind) => {
    if (isShadowKind(kind)) setAll('shadows', [...shape.shadows, newShadowOf(kind as 'drop' | 'inner')]);
    else setAll('blur', { type: kind, value: 4, hidden: false });
    setMenuAnchor(null);
  };

  return (
    <div style={pStyles.section}>
      <div style={pStyles.sectionHeader}>
        <span>Effects</span>
        <button ref={addRef} style={pStyles.iconAction} title="Add effect"
          onClick={e => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenuAnchor(a => (a ? null : r));
          }}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      {shape.shadows.map((_, i) => (
        <EffectRow key={`shadow-${i}`} shape={shape} setAll={setAll} shadowIndex={i} />
      ))}
      {shape.blur && <EffectRow key="blur" shape={shape} setAll={setAll} />}
      {menuAnchor && (
        <DropMenu anchor={menuAnchor} onClose={() => setMenuAnchor(null)}
          items={EFFECT_OPTIONS.map(k => ({ label: EFFECT_LABELS[k], onClick: () => addEffect(k) }))} />
      )}
    </div>
  );
}

function EffectRow({ shape, setAll, shadowIndex }: {
  shape: Shape; setAll: (attr: string, val: unknown) => void; shadowIndex?: number;
}) {
  const [popAnchor, setPopAnchor] = useState<DOMRect | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const isShadow = shadowIndex !== undefined;
  const shadow = isShadow ? shape.shadows[shadowIndex] : null;
  const blur = !isShadow ? shape.blur : null;
  const kind: EffectKind = isShadow ? shadow!.type : blur!.type;

  const updateShadow = (patch: Partial<Shadow>) =>
    setAll('shadows', shape.shadows.map((s, i) => (i === shadowIndex ? { ...s, ...patch } : s)));
  const updateBlur = (patch: Partial<BlurEffect>) => setAll('blur', { ...shape.blur, ...patch });
  const remove = () => (isShadow
    ? setAll('shadows', shape.shadows.filter((_, i) => i !== shadowIndex))
    : setAll('blur', null));

  const hidden = isShadow ? shadow!.hidden : blur!.hidden;
  const toggleHidden = () => (isShadow ? updateShadow({ hidden: !hidden }) : updateBlur({ hidden: !hidden }));

  // Convert effect type (Figma lets you switch type from the popover dropdown).
  const changeKind = (next: EffectKind) => {
    if (next === kind) return;
    if (isShadow && isShadowKind(next)) { updateShadow({ type: next as 'drop' | 'inner' }); return; }
    if (!isShadow && !isShadowKind(next)) { updateBlur({ type: next as BlurEffect['type'] }); return; }
    if (isShadow && !isShadowKind(next)) {
      setAll('shadows', shape.shadows.filter((_, i) => i !== shadowIndex));
      setAll('blur', { type: next, value: 4, hidden: false });
    } else {
      setAll('blur', null);
      setAll('shadows', [...shape.shadows, newShadowOf(next as 'drop' | 'inner')]);
    }
    setPopAnchor(null);
  };

  return (
    <>
      <div style={pStyles.effectRow} ref={rowRef}>
        {isShadow
          ? <ColorSwatch color={shadow!.color} opacity={shadow!.opacity}
              onChange={(c, o) => updateShadow({ color: c, opacity: o })} />
          : <span style={pStyles.effectGlyph}><Icon name="ellipse" size={12} /></span>}
        <button style={pStyles.effectChip}
          onClick={() => setPopAnchor(p => (p ? null : rowRef.current!.getBoundingClientRect()))}>
          <span style={{ flex: 1, textAlign: 'left', opacity: hidden ? 0.45 : 1 }}>{EFFECT_LABELS[kind]}</span>
          <Icon name="chevron-down" size={12} />
        </button>
        <button style={pStyles.iconGhost} onClick={toggleHidden} title={hidden ? 'Show' : 'Hide'}>
          <Icon name={hidden ? 'eye-off' : 'eye'} size={14} />
        </button>
        <button style={pStyles.iconGhost} onClick={remove} title="Remove"><Icon name="minus" size={14} /></button>
      </div>
      {popAnchor && (
        <EffectPopover anchor={popAnchor} kind={kind} shadow={shadow} blur={blur}
          onChangeKind={changeKind} onUpdateShadow={updateShadow} onUpdateBlur={updateBlur}
          onClose={() => setPopAnchor(null)} />
      )}
    </>
  );
}

function EffectPopover({ anchor, kind, shadow, blur, onChangeKind, onUpdateShadow, onUpdateBlur, onClose }: {
  anchor: DOMRect; kind: EffectKind; shadow: Shadow | null; blur: BlurEffect | null;
  onChangeKind: (k: EffectKind) => void;
  onUpdateShadow: (patch: Partial<Shadow>) => void;
  onUpdateBlur: (patch: Partial<BlurEffect>) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        // ignore clicks landing in a ColorPicker portal
        const t = e.target as HTMLElement;
        if (t.closest('[data-colorpicker]')) return;
        onClose();
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const width = 252;
  const left = Math.min(anchor.left - width - 10 < 8 ? anchor.right + 10 : anchor.left - width - 10, window.innerWidth - width - 8);
  const top = Math.min(anchor.top, window.innerHeight - 280);

  return (
    <div ref={ref} style={{ ...popStyles.panel, left: Math.max(8, left), top: Math.max(8, top), width }}>
      <div style={popStyles.head}>
        <select style={popStyles.typeSelect} value={kind}
          onChange={e => onChangeKind(e.target.value as EffectKind)}>
          {EFFECT_OPTIONS.map(k => <option key={k} value={k}>{EFFECT_LABELS[k]}</option>)}
        </select>
        <button style={pStyles.iconGhost} onClick={onClose} title="Close"><Icon name="close" size={14} /></button>
      </div>
      {shadow ? (
        <div style={popStyles.body}>
          <div style={popStyles.fieldRow}>
            <span style={popStyles.fieldLabel}>Position</span>
            <NumInput label="X" value={shadow.offsetX} onChange={v => onUpdateShadow({ offsetX: v })} />
            <NumInput label="Y" value={shadow.offsetY} onChange={v => onUpdateShadow({ offsetY: v })} />
          </div>
          <div style={popStyles.fieldRow}>
            <span style={popStyles.fieldLabel}>Blur</span>
            <NumInput label="" value={shadow.blur} min={0} onChange={v => onUpdateShadow({ blur: v })} />
          </div>
          <div style={popStyles.fieldRow}>
            <span style={popStyles.fieldLabel}>Spread</span>
            <NumInput label="" value={shadow.spread} onChange={v => onUpdateShadow({ spread: v })} />
          </div>
          <div style={popStyles.fieldRow}>
            <span style={popStyles.fieldLabel}>Color</span>
            <div style={pStyles.fillRow}>
              <ColorSwatch color={shadow.color} opacity={shadow.opacity}
                onChange={(c, o) => onUpdateShadow({ color: c, opacity: o })} />
              <span style={pStyles.fillType}>{shadow.color.toUpperCase().replace('#', '')}</span>
              <NumInput label="" value={Math.round(shadow.opacity * 100)} unit="%" min={0} max={100}
                onChange={v => onUpdateShadow({ opacity: v / 100 })} />
            </div>
          </div>
        </div>
      ) : blur ? (
        <div style={popStyles.body}>
          <div style={popStyles.fieldRow}>
            <span style={popStyles.fieldLabel}>Blur</span>
            <NumInput label="" value={blur.value} min={0} onChange={v => onUpdateBlur({ value: v })} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DropMenu({ anchor, items, onClose }: {
  anchor: DOMRect; items: { label: string; onClick: () => void }[]; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose]);
  const W = 184;
  const left = Math.max(8, Math.min(anchor.right - W, window.innerWidth - W - 8));
  const estH = items.length * 34 + 8;
  // flip above the anchor if it would overflow the bottom of the viewport
  const below = anchor.bottom + 6;
  const top = below + estH > window.innerHeight - 8 ? Math.max(8, anchor.top - estH - 6) : below;
  return (
    <div ref={ref} style={{ ...menuStyles.menu, left, top, width: W }}>
      {items.map((it, i) => (
        <button key={i} style={menuStyles.item}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-elevated-2)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          onMouseDown={e => { e.preventDefault(); it.onClick(); }}>{it.label}</button>
      ))}
    </div>
  );
}

const menuStyles: Record<string, React.CSSProperties> = {
  menu: {
    position: 'fixed', zIndex: 1000,
    background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)',
    borderRadius: 8, padding: 4, boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
    display: 'flex', flexDirection: 'column', gap: 1,
  },
  item: {
    textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer',
    color: 'var(--text)', fontSize: 12, padding: '7px 9px', borderRadius: 5, fontFamily: 'inherit',
  },
};

const popStyles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'fixed', zIndex: 1000,
    background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)',
    borderRadius: 10, boxShadow: '0 12px 36px rgba(0,0,0,0.5)', overflow: 'hidden',
  },
  head: {
    display: 'flex', alignItems: 'center', gap: 6, padding: 8,
    borderBottom: '1px solid var(--border)',
  },
  typeSelect: {
    flex: 1, minWidth: 0, background: 'var(--bg-inset)', border: '1px solid var(--border)',
    borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '6px 8px', outline: 'none',
    cursor: 'pointer', fontFamily: 'inherit',
  },
  body: { padding: 10, display: 'flex', flexDirection: 'column', gap: 8 },
  fieldRow: { display: 'flex', alignItems: 'center', gap: 8 },
  fieldLabel: { color: 'var(--text-secondary)', fontSize: 11, width: 56, flexShrink: 0 },
};

// ── Auto Layout section (Figma Shift+A panel) ─────────────────────────────────
// Direction toggle, spacing, padding (with link), 3×3 alignment grid + space-between
// toggle, sizing dropdowns. Every control writes through `set` so applyChanges runs
// calculateLayout on the page — the canvas reflows immediately.

type SizingMode = 'hug' | 'fill' | 'fixed';

// One W/H field: letter + (editable number when Fixed | mode word when Hug/Fill) + a slim
// mode dropdown. Matches Figma — the number only takes space when it's meaningful.
// Compact Figma-style dimension field: `W [ 486      Hug ⌄]` — the live number is always
// visible (editable when Fixed, muted when derived), the mode word shows for Hug/Fill,
// and a slim chevron opens the sizing menu.
function SizingField({ axis, value, mode, onValue, onMode }: {
  axis: 'W' | 'H';
  value: number;
  mode: SizingMode;
  onValue: (v: number) => void;
  onMode: (m: SizingMode) => void;
}) {
  const title = axis === 'W' ? 'Width' : 'Height';
  const modeWord = mode === 'hug' ? 'Hug' : mode === 'fill' ? 'Fill' : '';
  return (
    <div style={alStyles.dimField}>
      <span
        style={{ ...alStyles.dimLetter, cursor: 'ew-resize' }}
        title={`${title} — drag to scrub (Shift = coarse, Alt = fine)`}
        // Scrubbing a Hug/Fill axis pins it to Fixed at the scrubbed size (onValue
        // sets the mode), matching Figma.
        onPointerDown={e => startScrub(e, { value, min: 1, onChange: onValue })}
      >{axis}</span>
      {mode === 'fixed' ? (
        <div style={{ flex: 1, minWidth: 0 }}>
          <NumInput hideLabel label={title} value={value} min={1} onChange={onValue} />
        </div>
      ) : (
        <span style={alStyles.dimDerived} title={`${title} ${value} — ${modeWord === 'Hug' ? 'hugging contents' : 'filling the container'}`}>
          <span style={{ color: 'var(--text)' }}>{modeWord}</span>
        </span>
      )}
      <div style={alStyles.chevWrap}>
        <span style={alStyles.chev}>▾</span>
        <select
          style={alStyles.chevSelect}
          value={mode} title={`${title} sizing`}
          onChange={e => onMode(e.target.value as SizingMode)}
        >
          <option value="fixed">Fixed</option>
          <option value="hug">Hug contents</option>
          <option value="fill">Fill container</option>
        </select>
      </div>
    </div>
  );
}

function AutoLayoutSection({ shape, set, setAll }: {
  shape: Shape;
  set: (id: string, attr: string, val: unknown) => void;
  setAll: (attr: string, val: unknown) => void;
}) {
  const al = shape.autoLayout!;
  const updateAL = (patch: Partial<typeof al>) => set(shape.id, 'autoLayout', { ...al, ...patch });
  const updatePadding = (patch: Partial<typeof al.padding>) => updateAL({ padding: { ...al.padding, ...patch } });

  const distributed = al.justifyContent === 'space-between'
    || al.justifyContent === 'space-around'
    || al.justifyContent === 'space-evenly';

  // Padding: linked (H + V) vs expanded (4 individual)
  const hPad = (al.padding.left + al.padding.right) / 2;
  const vPad = (al.padding.top + al.padding.bottom) / 2;
  const [padExpanded, setPadExpanded] = useState(false);
  // Min/Max fields are tucked away by default (Figma-style) — auto-open when any is set.
  const hasMM = shape.minWidth != null || shape.maxWidth != null || shape.minHeight != null || shape.maxHeight != null;
  const [mmOpen, setMmOpen] = useState(hasMM);

  const wMode = shape.widthMode ?? 'fixed';
  const hMode = shape.heightMode ?? 'fixed';

  const DIRS: { key: 'horizontal' | 'vertical' | 'wrap' | 'grid'; icon: Parameters<typeof Icon>[0]['name']; title: string }[] = [
    { key: 'horizontal', icon: 'flex-row', title: 'Horizontal' },
    { key: 'vertical',   icon: 'flex-col', title: 'Vertical' },
    { key: 'wrap',       icon: 'flex-wrap', title: 'Wrap' },
    { key: 'grid',       icon: 'grid', title: 'Grid' },
  ];

  return (
    <Section label="Auto layout" action={
      <button style={pStyles.iconAction} title="Remove auto layout"
        onClick={() => setAll('autoLayout', null)}>
        <Icon name="minus" size={14} />
      </button>
    }>

      {/* Row 1: Direction toggle (4 modes) + Reverse */}
      <Row>
        <div style={pStyles.segGroup}>
          {DIRS.map(d => (
            <button key={d.key} title={d.title} style={segBtnStyle(al.direction === d.key)}
              onClick={() => updateAL({ direction: d.key })}>
              <Icon name={d.icon} size={15} />
            </button>
          ))}
        </div>
        <button title={al.reversed ? 'Reversed (click to unreverse)' : 'Reverse order'}
          style={{ ...segBtnStyle(!!al.reversed), width: 30, height: 30, flex: 'none' }}
          onClick={() => updateAL({ reversed: !al.reversed })}>
          <Icon name="reverse" size={14} />
        </button>
      </Row>

      {/* Row 2: two compact sizing fields. Number shows only when Fixed (so it has room);
          otherwise the mode (Hug/Fill) fills the field. */}
      <Row>
        <SizingField axis="W" value={Math.round(shape.width)} mode={wMode}
          onValue={v => { set(shape.id, 'width', v); set(shape.id, 'widthMode', 'fixed'); }}
          onMode={m => set(shape.id, 'widthMode', m)} />
        <SizingField axis="H" value={Math.round(shape.height)} mode={hMode}
          onValue={v => { set(shape.id, 'height', v); set(shape.id, 'heightMode', 'fixed'); }}
          onMode={m => set(shape.id, 'heightMode', m)} />
        <button style={alStyles.mmToggle} title="Min/max size" onClick={() => setMmOpen(o => !o)}>
          {mmOpen ? '−' : '+'}
        </button>
      </Row>

      {/* Min/Max clamps — collapsed by default (Figma-style); auto-open when any is set. */}
      {mmOpen && <MinMaxRows shape={shape} set={set} />}

      {/* Row 3: 3×3 alignment grid + gap field — gap gets the full remaining row so it's
          comfortably readable (previously squeezed next to the distribution dropdown too). */}
      <Row>
        <AlignmentGrid
          direction={al.direction === 'horizontal' || al.direction === 'wrap' ? 'horizontal' : 'vertical'}
          primary={distributed ? 'start' : (al.justifyContent as 'start' | 'center' | 'end')}
          cross={al.alignItems}
          distributed={distributed}
          onChange={(primary, cross) => updateAL({ justifyContent: primary, alignItems: cross })}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <GapInput value={al.spacing} disabled={distributed}
            onChange={v => updateAL({ spacing: v })} />
        </div>
      </Row>

      {/* Row 3b: distribution mode — own row so its full label text ("Space between", …)
          never truncates. Packed + a fixed gap = fixed spacing; any other mode auto-
          distributes and disables the gap field above (same as Figma). */}
      <Row>
        <select style={{ ...pStyles.select, flex: 1 }}
          value={distributed ? al.justifyContent : 'packed'} title="Distribution"
          onChange={e => {
            const v = e.target.value;
            updateAL({ justifyContent: v === 'packed' ? 'start' : (v as typeof al.justifyContent) });
          }}>
          <option value="packed">Packed</option>
          <option value="space-between">Space between</option>
          <option value="space-around">Space around</option>
          <option value="space-evenly">Space evenly</option>
        </select>
      </Row>

      {/* Row 4: Padding — linked (H + V) or expanded (4 values) */}
      {padExpanded ? (
        <>
          <Row>
            <NumInput icon="align-top"    label="Padding top"    value={al.padding.top}    min={0} onChange={v => updatePadding({ top: v })} />
            <NumInput icon="align-right"  label="Padding right"  value={al.padding.right}  min={0} onChange={v => updatePadding({ right: v })} />
          </Row>
          <Row>
            <NumInput icon="align-bottom" label="Padding bottom" value={al.padding.bottom} min={0} onChange={v => updatePadding({ bottom: v })} />
            <NumInput icon="align-left"   label="Padding left"   value={al.padding.left}   min={0} onChange={v => updatePadding({ left: v })} />
            <button title="Collapse padding" style={alStyles.mmToggle}
              onClick={() => setPadExpanded(false)}>
              <Icon name="minus" size={13} />
            </button>
          </Row>
        </>
      ) : (
        <Row>
          <div style={{ flex: 1, minWidth: 0 }}>
            <NumInput icon="pad-h" label="Horizontal padding" value={Math.round(hPad)} min={0}
              onChange={v => updatePadding({ left: v, right: v })} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <NumInput icon="pad-v" label="Vertical padding" value={Math.round(vPad)} min={0}
              onChange={v => updatePadding({ top: v, bottom: v })} />
          </div>
          <button title="Separate padding per side" style={alStyles.mmToggle}
            onClick={() => setPadExpanded(true)}>
            <Icon name="plus" size={13} />
          </button>
        </Row>
      )}

      {/* Grid only: number of equal columns. */}
      {al.direction === 'grid' && (
        <Row>
          <div style={{ flex: 1, minWidth: 0 }}>
            <NumInput icon="grid" label="Columns" value={al.columns ?? 2} min={1}
              onChange={v => updateAL({ columns: Math.max(1, Math.round(v)) })} />
          </div>
        </Row>
      )}

      {/* Wrap only: how rows are distributed on the cross axis. */}
      {al.direction === 'wrap' && (
        <Row>
          <span style={pStyles.fieldLabel}>Rows</span>
          <select style={{ ...pStyles.select, flex: 1 }}
            value={al.alignContent ?? 'start'} title="Row alignment (cross axis)"
            onChange={e => updateAL({ alignContent: e.target.value as NonNullable<typeof al.alignContent> })}>
            <option value="start">Top</option>
            <option value="center">Center</option>
            <option value="end">Bottom</option>
            <option value="space-between">Space between</option>
          </select>
        </Row>
      )}

      {/* Row 5: Clip content + stroke-in-layout checkboxes */}
      <div style={alStyles.checkRow}>
        <input
          type="checkbox"
          id={`clip-${shape.id}`}
          checked={!!shape.clipContent}
          onChange={e => set(shape.id, 'clipContent', e.target.checked)}
          style={{ margin: 0, cursor: 'pointer' }}
        />
        <label htmlFor={`clip-${shape.id}`} style={alStyles.checkLabel}>Clip content</label>
      </div>
      <div style={alStyles.checkRow}>
        <input
          type="checkbox"
          id={`stroke-lay-${shape.id}`}
          checked={!!al.strokeInLayout}
          onChange={e => updateAL({ strokeInLayout: e.target.checked })}
          style={{ margin: 0, cursor: 'pointer' }}
        />
        <label htmlFor={`stroke-lay-${shape.id}`} style={alStyles.checkLabel}>Include stroke in layout</label>
      </div>
    </Section>
  );
}

const alStyles: Record<string, React.CSSProperties> = {
  // One compact W/H field: letter + pill (number / mode word) + slim chevron menu.
  dimField: { display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 },
  dimLetter: { color: 'var(--text-muted)', fontSize: 11, flexShrink: 0, width: 10, textAlign: 'center' },
  dimDerived: {
    flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 4,
    height: 30, background: 'var(--bg-inset)', border: '1px solid transparent', borderRadius: 7,
    color: 'var(--text-secondary)', fontSize: 12, padding: '0 9px',
    overflow: 'hidden', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
  },
  chevWrap: { position: 'relative', width: 20, height: 28, flexShrink: 0 },
  chev: {
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--text-secondary)', fontSize: 9, pointerEvents: 'none',
  },
  chevSelect: { position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' },
  // Bare inline toggle (min/max, padding expand) — glyph only, consistent with iconAction.
  mmToggle: {
    width: 24, height: 24, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', padding: 0, borderRadius: 6,
    color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12,
  },
  checkRow: {
    display: 'flex', alignItems: 'center', gap: 8, marginTop: 2,
    padding: '2px 0',
  },
  checkLabel: {
    color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', userSelect: 'none',
  },
};

// Sizing for a multi-selection of auto-layout children. Applies one mode to all selected
// shapes; shows "Mixed" when they currently differ.
function MultiSizingSection({ shapes, setAll }: { shapes: Shape[]; setAll: (attr: string, val: unknown) => void }) {
  const common = (key: 'widthMode' | 'heightMode') => {
    const vals = new Set(shapes.map(s => s[key] ?? 'fixed'));
    return vals.size === 1 ? [...vals][0] : '';
  };
  const wv = common('widthMode');
  const hv = common('heightMode');
  return (
    <Section label="Sizing">
      <Row>
        <span style={pStyles.fieldLabel}>W</span>
        <select style={{ ...pStyles.select, flex: 1 }} value={wv}
          onChange={e => setAll('widthMode', e.target.value as SizingMode)}>
          {wv === '' && <option value="" disabled>Mixed</option>}
          <option value="hug">Hug contents</option>
          <option value="fill">Fill container</option>
          <option value="fixed">Fixed</option>
        </select>
        <span style={pStyles.fieldLabel}>H</span>
        <select style={{ ...pStyles.select, flex: 1 }} value={hv}
          onChange={e => setAll('heightMode', e.target.value as SizingMode)}>
          {hv === '' && <option value="" disabled>Mixed</option>}
          <option value="hug">Hug contents</option>
          <option value="fill">Fill container</option>
          <option value="fixed">Fixed</option>
        </select>
      </Row>
    </Section>
  );
}

function ChildSizingSection({ shape, set }: { shape: Shape; set: (id: string, attr: string, val: unknown) => void }) {
  const abs = shape.layoutPositioning === 'absolute';
  // Min/Max tucked away by default (Figma-style) — auto-open when any bound is set.
  const hasMM = shape.minWidth != null || shape.maxWidth != null || shape.minHeight != null || shape.maxHeight != null;
  const [mmOpen, setMmOpen] = useState(hasMM);
  return (
    <Section label="Sizing">
      <Row>
        <span style={pStyles.fieldLabel}>W</span>
        <select style={{ ...pStyles.select, flex: 1 }} disabled={abs}
          value={shape.widthMode ?? 'fixed'}
          onChange={e => set(shape.id, 'widthMode', e.target.value as SizingMode)}>
          <option value="hug">Hug contents</option>
          <option value="fill">Fill container</option>
          <option value="fixed">Fixed width</option>
        </select>
        <span style={pStyles.fieldLabel}>H</span>
        <select style={{ ...pStyles.select, flex: 1 }} disabled={abs}
          value={shape.heightMode ?? 'fixed'}
          onChange={e => set(shape.id, 'heightMode', e.target.value as SizingMode)}>
          <option value="hug">Hug contents</option>
          <option value="fill">Fill container</option>
          <option value="fixed">Fixed height</option>
        </select>
        {!abs && (
          <button style={alStyles.mmToggle} title="Min/max size" onClick={() => setMmOpen(o => !o)}>
            {mmOpen ? '−' : '+'}
          </button>
        )}
      </Row>
      {!abs && mmOpen && <MinMaxRows shape={shape} set={set} />}
      <div style={alStyles.checkRow}>
        <input type="checkbox" id={`abs-${shape.id}`} checked={abs}
          onChange={e => set(shape.id, 'layoutPositioning', e.target.checked ? 'absolute' : 'auto')}
          style={{ margin: 0, cursor: 'pointer' }} />
        <label htmlFor={`abs-${shape.id}`} style={alStyles.checkLabel}>Absolute position (ignore auto layout)</label>
      </div>
    </Section>
  );
}

// Compact Min/Max width & height inputs. Empty / 0 clears the bound (unbounded).
function MinMaxRows({ shape, set }: { shape: Shape; set: (id: string, attr: string, val: unknown) => void }) {
  type MMKey = 'minWidth' | 'maxWidth' | 'minHeight' | 'maxHeight';
  const setNum = (attr: MMKey, raw: string) => {
    const v = parseFloat(raw);
    set(shape.id, attr, Number.isFinite(v) && v > 0 ? v : undefined);
  };
  const cell = (label: string, attr: MMKey) => (
    <div style={mmStyles.cell}>
      <span style={mmStyles.label}>{label}</span>
      <input type="number" min={0} placeholder="–" style={mmStyles.input}
        value={shape[attr] ?? ''} onChange={e => setNum(attr, e.target.value)} />
    </div>
  );
  return (
    <>
      <Row>{cell('Min W', 'minWidth')}{cell('Max W', 'maxWidth')}</Row>
      <Row>{cell('Min H', 'minHeight')}{cell('Max H', 'maxHeight')}</Row>
    </>
  );
}

const mmStyles: Record<string, React.CSSProperties> = {
  cell: { display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 },
  label: { color: 'var(--text-muted)', fontSize: 11, flexShrink: 0, width: 34 },
  input: {
    flex: 1, minWidth: 0, background: 'var(--bg-inset)', border: '1px solid var(--border)',
    borderRadius: 7, color: 'var(--text)', fontSize: 12, padding: '0 8px', outline: 'none', height: 30,
  },
};

// ── AppearanceSection ─────────────────────────────────────────────────────────
// Shown for frame and rect shapes: opacity, stroke weight + align, corner radius.

function AppearanceSection({ shape, set, setAll }: {
  shape: Shape;
  set: (id: string, attr: string, val: unknown) => void;
  setAll: (attr: string, val: unknown) => void;
}) {
  const cr = shape.cornerRadii ?? { tl: 0, tr: 0, br: 0, bl: 0 };
  const allSame = cr.tl === cr.tr && cr.tr === cr.br && cr.br === cr.bl;
  const [cornersLinked, setCornersLinked] = useState(allSame);

  const setCorner = (patch: Partial<typeof cr>) => {
    const next = { ...cr, ...patch };
    set(shape.id, 'cornerRadii', (next.tl === 0 && next.tr === 0 && next.br === 0 && next.bl === 0) ? undefined : next);
  };
  const setAllCorners = (v: number) => {
    set(shape.id, 'cornerRadii', v === 0 ? undefined : { tl: v, tr: v, br: v, bl: v });
  };

  const firstStroke = shape.strokes[0];
  const strokeW = firstStroke?.width ?? 0;
  const strokeAlign = firstStroke?.align ?? 'center';
  const ALIGNS: { v: 'inner' | 'center' | 'outer'; label: string }[] = [
    { v: 'inner', label: 'In' }, { v: 'center', label: 'Ctr' }, { v: 'outer', label: 'Out' },
  ];
  const setStrokeW = (w: number) => {
    if (shape.strokes.length === 0) {
      setAll('strokes', [{ color: '#000000', opacity: 1, width: w, align: 'center', cap: 'none', style: 'solid' }]);
    } else {
      setAll('strokes', shape.strokes.map((s, i) => i === 0 ? { ...s, width: w } : s));
    }
  };
  const setStrokeAlign = (align: 'inner' | 'center' | 'outer') => {
    if (shape.strokes.length > 0) {
      setAll('strokes', shape.strokes.map((s, i) => i === 0 ? { ...s, align } : s));
    }
  };
  const smooth = shape.cornerSmoothing ?? 0;

  return (
    <Section label="Appearance">
      {/* Row 1: Opacity  |  Stroke weight  Stroke align */}
      <Row>
        <NumInput icon="eye" label="Opacity" value={Math.round(shape.opacity * 100)} unit="%" min={0} max={100}
          onChange={v => set(shape.id, 'opacity', v / 100)} />
        <NumInput icon="rect" label="Stroke" value={strokeW} min={0}
          onChange={setStrokeW} />
        <div style={pStyles.segGroup}>
          {ALIGNS.map(a => (
            <button key={a.v} title={`Stroke ${a.v}`}
              style={{ ...segBtnStyle(strokeAlign === a.v), fontSize: 10, minWidth: 24 }}
              onClick={() => setStrokeAlign(a.v)}>
              {a.label}
            </button>
          ))}
        </div>
      </Row>

      {/* Row 2: Corner radius — linked single value or 4-corner grid */}
      {cornersLinked ? (
        <Row>
          <NumInput icon="corner-all" label="Corner radius" value={cr.tl} min={0}
            onChange={setAllCorners} />
          <NumInput icon="smooth" label="Smoothing" value={smooth} min={0} max={100}
            onChange={v => set(shape.id, 'cornerSmoothing', v || undefined)} />
          <button title="Unlink corners"
            style={{ ...segBtnStyle(false), width: 30, height: 30, flex: 'none' }}
            onClick={() => setCornersLinked(false)}>
            <Icon name="unlink" size={13} />
          </button>
        </Row>
      ) : (
        <>
          <Row>
            <NumInput icon="corner-tl" label="Top left"     value={cr.tl} min={0} onChange={v => setCorner({ tl: v })} />
            <NumInput icon="corner-tr" label="Top right"    value={cr.tr} min={0} onChange={v => setCorner({ tr: v })} />
          </Row>
          <Row>
            <NumInput icon="corner-bl" label="Bottom left"  value={cr.bl} min={0} onChange={v => setCorner({ bl: v })} />
            <NumInput icon="corner-br" label="Bottom right" value={cr.br} min={0} onChange={v => setCorner({ br: v })} />
            <button title="Link corners"
              style={{ ...segBtnStyle(false), width: 30, height: 30, flex: 'none' }}
              onClick={() => { setAllCorners(cr.tl); setCornersLinked(true); }}>
              <Icon name="link" size={13} />
            </button>
          </Row>
        </>
      )}
    </Section>
  );
}

// 3×3 alignment dot grid. The visual grid is independent of direction; the mapping
// of (row, col) to (primary, cross) flips based on `direction`. The active cell is
// highlighted; when distributed=true, each row's 3 cells render as a single stretched
// bar (Figma's space-between look).
function AlignmentGrid({ direction, primary, cross, distributed, onChange }: {
  direction: 'horizontal' | 'vertical';
  primary: 'start' | 'center' | 'end';
  cross: 'start' | 'center' | 'end';
  distributed: boolean;
  onChange: (primary: 'start' | 'center' | 'end', cross: 'start' | 'center' | 'end') => void;
}) {
  const triad: ('start' | 'center' | 'end')[] = ['start', 'center', 'end'];
  // For horizontal direction: col = primary, row = cross. For vertical: row = primary, col = cross.
  // While distributed, the grid only controls cross-axis (the distribution dropdown owns primary).
  const cellActive = (row: number, col: number): boolean => {
    if (distributed) {
      return direction === 'horizontal' ? cross === triad[row] : cross === triad[col];
    }
    if (direction === 'horizontal') {
      return triad[col] === primary && triad[row] === cross;
    }
    return triad[row] === primary && triad[col] === cross;
  };
  const onClick = (row: number, col: number) => {
    if (distributed) {
      // Lock primary to whatever it is, only update cross.
      const nextCross = direction === 'horizontal' ? triad[row] : triad[col];
      onChange(primary, nextCross);
      return;
    }
    if (direction === 'horizontal') onChange(triad[col], triad[row]);
    else onChange(triad[row], triad[col]);
  };

  return (
    <div style={alignGridStyles.grid}>
      {[0, 1, 2].map(row => (
        <div key={row} style={alignGridStyles.gridRow}>
          {distributed ? (
            <button title="Distributed row" onClick={() => onClick(row, 1)}
              style={{ ...alignGridStyles.cell, ...alignGridStyles.distributedBar,
                background: cellActive(row, 1) ? 'var(--accent)' : 'var(--text-muted)' }}>
              <span style={alignGridStyles.bar} />
            </button>
          ) : (
            [0, 1, 2].map(col => (
              <button key={col} title="Alignment" onClick={() => onClick(row, col)}
                style={{ ...alignGridStyles.cell }}>
                <span style={{ ...alignGridStyles.dot,
                  background: cellActive(row, col) ? 'var(--accent)' : 'var(--text-muted)' }} />
              </button>
            ))
          )}
        </div>
      ))}
    </div>
  );
}

const alignGridStyles: Record<string, React.CSSProperties> = {
  grid: {
    display: 'flex', flexDirection: 'column', gap: 3, padding: 6,
    background: 'var(--bg-inset)', borderRadius: 8,
    width: 96, flexShrink: 0,
  },
  gridRow: { display: 'flex', gap: 3, flex: 1, height: 26 },
  cell: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', borderRadius: 5, cursor: 'pointer',
    padding: 0,
  },
  dot: { display: 'block', width: 6, height: 6, borderRadius: '50%' },
  distributedBar: { background: 'transparent', flex: 1 },
  bar: { display: 'block', height: 2, borderRadius: 1, width: '60%', background: 'inherit' },
};

// ── TypographySection ─────────────────────────────────────────────────────────

const WEIGHTS: { v: number; label: string }[] = [
  { v: 100, label: 'Thin' }, { v: 300, label: 'Light' }, { v: 400, label: 'Regular' },
  { v: 500, label: 'Medium' }, { v: 600, label: 'Semibold' }, { v: 700, label: 'Bold' },
  { v: 800, label: 'Extrabold' }, { v: 900, label: 'Black' },
];

function TypographySection({ shape, set, emit }: {
  shape: Shape;
  set: (id: string, attr: string, val: unknown) => void;
  emit: (ops: Parameters<typeof api.applyChanges>[0]['ops']) => void;
}) {
  const ts = shape.textStyle!;
  // Changing any type metric re-fits the box (Figma): auto-width grows width+height,
  // fixed-width keeps width and re-wraps to a new height.
  const updateTs = (patch: Partial<TextStyle>) => {
    const nextStyle = { ...ts, ...patch };
    const fitted = fitTextSize({ ...shape, textStyle: nextStyle });
    const ops: Parameters<typeof api.applyChanges>[0]['ops'] = [
      { op: 'set', id: shape.id, attr: 'textStyle', val: nextStyle },
      { op: 'set', id: shape.id, attr: 'height', val: fitted.height },
    ];
    if (shape.textAutoWidth) ops.push({ op: 'set', id: shape.id, attr: 'width', val: fitted.width });
    emit(ops);
  };
  const align = shape.paragraphs?.[0]?.align ?? 'left';
  const setAlign = (a: 'left' | 'center' | 'right' | 'justify') => {
    const paras = (shape.paragraphs ?? [{ spans: [{ text: '' }] }]).map(p => ({ ...p, align: a }));
    set(shape.id, 'paragraphs', paras);
  };

  return (
    <Section label="Typography">
      {/* Font family — full width, no label (Figma style) */}
      <Row>
        <FontPicker value={ts.fontFamily} onChange={fontFamily => updateTs({ fontFamily })} />
      </Row>
      {/* Weight (wide) + Size (narrow) — no labels */}
      <Row>
        <select style={{ ...pStyles.select, flex: 2 }} value={ts.fontWeight}
          onChange={e => updateTs({ fontWeight: Number(e.target.value) })}>
          {WEIGHTS.map(w => <option key={w.v} value={w.v}>{w.label}</option>)}
        </select>
        <div style={{ flex: 1 }}>
          <NumInput icon="text" label="Font size" value={ts.fontSize} min={1} onChange={v => updateTs({ fontSize: v })} />
        </div>
      </Row>
      {/* Line height + Letter spacing — icons (hover for full name) */}
      <Row>
        <NumInput icon="line-height" label="Line height" value={ts.lineHeight} min={0.5} max={4} step={0.1} decimals={2}
          onChange={v => updateTs({ lineHeight: v })} />
        <NumInput icon="letter-spacing" label="Letter spacing" value={ts.letterSpacing} step={0.5} decimals={1}
          onChange={v => updateTs({ letterSpacing: v })} />
      </Row>

      {/* Alignment (left/center/right/justify) + decoration & case (underline / TT / tt) */}
      <Row>
        <div style={pStyles.segGroup}>
          {([['left', 'text-left'], ['center', 'text-center'], ['right', 'text-right'], ['justify', 'text-justify']] as const).map(([a, icon]) => (
            <button key={a} title={`Align ${a}`} style={segBtnStyle(align === a)} onClick={() => setAlign(a)}>
              <Icon name={icon} size={15} />
            </button>
          ))}
        </div>
        <div style={pStyles.segGroup}>
          <button title="Underline" style={segBtnStyle(ts.textDecoration === 'underline')}
            onClick={() => updateTs({ textDecoration: ts.textDecoration === 'underline' ? 'none' : 'underline' })}>
            <Icon name="underline" size={15} />
          </button>
          <button title="Uppercase" style={segBtnStyle(ts.textTransform === 'uppercase')}
            onClick={() => updateTs({ textTransform: ts.textTransform === 'uppercase' ? 'none' : 'uppercase' })}>
            <Icon name="text-uppercase" size={15} />
          </button>
          <button title="Lowercase" style={segBtnStyle(ts.textTransform === 'lowercase')}
            onClick={() => updateTs({ textTransform: ts.textTransform === 'lowercase' ? 'none' : 'lowercase' })}>
            <Icon name="text-lowercase" size={15} />
          </button>
        </div>
      </Row>
    </Section>
  );
}

function segBtnStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: 28, borderRadius: 6, cursor: 'pointer', border: 'none',
    background: active ? 'var(--accent-soft)' : 'transparent',
    color: active ? 'var(--accent-hover)' : 'var(--text-secondary)',
  };
}

// ── AlignSection ──────────────────────────────────────────────────────────────

function AlignSection({ shapes, emit }: {
  shapes: Shape[];
  emit: (ops: Parameters<typeof api.applyChanges>[0]['ops']) => void;
}) {
  const bounds = shapes.map(s => s.selrect);
  const minX = Math.min(...bounds.map(r => r.x));
  const minY = Math.min(...bounds.map(r => r.y));
  const maxX = Math.max(...bounds.map(r => r.x + r.width));
  const maxY = Math.max(...bounds.map(r => r.y + r.height));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const align = (getVal: (s: Shape) => number, attr: string) =>
    emit(shapes.map(s => ({ op: 'set' as const, id: s.id, attr, val: getVal(s) })));

  const distributeH = () => {
    const sorted = [...shapes].sort((a, b) => a.selrect.x - b.selrect.x);
    const totalW = sorted.reduce((s, sh) => s + sh.selrect.width, 0);
    const gap = (maxX - minX - totalW) / (sorted.length - 1);
    let x = minX;
    emit(sorted.map(sh => {
      const val = x;
      x += sh.selrect.width + gap;
      return { op: 'set' as const, id: sh.id, attr: 'x', val };
    }));
  };

  const distributeV = () => {
    const sorted = [...shapes].sort((a, b) => a.selrect.y - b.selrect.y);
    const totalH = sorted.reduce((s, sh) => s + sh.selrect.height, 0);
    const gap = (maxY - minY - totalH) / (sorted.length - 1);
    let y = minY;
    emit(sorted.map(sh => {
      const val = y;
      y += sh.selrect.height + gap;
      return { op: 'set' as const, id: sh.id, attr: 'y', val };
    }));
  };

  return (
    <Section label="Align">
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <AlignBtn icon="align-left" title="Align left" onClick={() => align(() => minX, 'x')} />
        <AlignBtn icon="align-center-h" title="Align center H" onClick={() => align(s => cx - s.selrect.width / 2, 'x')} />
        <AlignBtn icon="align-right" title="Align right" onClick={() => align(s => maxX - s.selrect.width, 'x')} />
        <AlignBtn icon="align-top" title="Align top" onClick={() => align(() => minY, 'y')} />
        <AlignBtn icon="align-center-v" title="Align middle V" onClick={() => align(s => cy - s.selrect.height / 2, 'y')} />
        <AlignBtn icon="align-bottom" title="Align bottom" onClick={() => align(s => maxY - s.selrect.height, 'y')} />
        {shapes.length > 2 && <>
          <AlignBtn icon="distribute-h" title="Distribute H" onClick={distributeH} />
          <AlignBtn icon="distribute-v" title="Distribute V" onClick={distributeV} />
        </>}
      </div>
    </Section>
  );
}

function AlignBtn({ icon, onClick, title }: { icon: IconName; onClick: () => void; title?: string }) {
  return (
    <button style={pStyles.alignIconBtn} onClick={onClick} title={title}><Icon name={icon} size={15} /></button>
  );
}

// ── Page Settings Panel (shown when nothing is selected) ─────────────────────

function PageSettingsPanel() {
  const { activePage, setFile } = useDesignStore();
  const page = activePage();
  if (!page) return <div style={pStyles.empty}>No file open</div>;

  const bg = page.background || '#F0F0F4';

  const handleBgChange = async (color: string, opacity: number) => {
    const res = await api.setPageBackground(page.id, color);
    if (res.ok && res.data) setFile(res.data);
  };

  return (
    <div style={psStyles.root}>
      <div style={psStyles.header}>Page</div>
      <div style={psStyles.row}>
        <span style={psStyles.label}>Background</span>
        <div style={psStyles.control}>
          <ColorSwatch
            color={bg}
            opacity={1}
            onChange={handleBgChange}
          />
          <span style={psStyles.hexText}>{bg.replace('#', '').toUpperCase()}</span>
        </div>
      </div>
    </div>
  );
}

const psStyles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', padding: '12px 14px', gap: 10 },
  header: {
    fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)',
    textTransform: 'uppercase', letterSpacing: '0.06em',
  },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  label: { color: 'var(--text-secondary)', fontSize: 12 },
  control: { display: 'flex', alignItems: 'center', gap: 8 },
  hexText: {
    color: 'var(--text)', fontSize: 11, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    background: 'var(--bg-inset)', border: '1px solid var(--border)', borderRadius: 6,
    padding: '4px 7px',
  },
};

// ── Frame Presets Panel ───────────────────────────────────────────────────────

function FramePresetsPanel() {
  const { activePage, setFile, setActiveTool } = useDesignStore();
  // Phone is expanded by default; everything else collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['Phone']));

  const toggleCategory = (label: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });

  const handleSelect = useCallback(async (width: number, height: number) => {
    const page = activePage();
    if (!page) return;
    // Place to the right of all existing frames with a 100 px gap so new
    // frames never overlap existing content (Figma-style layout strip).
    const existingFrames = Object.values(page.objects).filter(s => s.type === 'frame');
    const x = existingFrames.length > 0
      ? Math.round(Math.max(...existingFrames.map(f => f.x + f.width)) + 100)
      : 0;
    const y = 0;
    const id = Math.random().toString(36).slice(2, 10);
    const shape = makeDefaultShape({
      id, type: 'frame', name: 'Frame', frameId: id, parentId: null,
      x, y, width, height,
      fills: [{ type: 'solid', color: '#FFFFFF', opacity: 1 }],
      clipContent: true,
      selrect: { x, y, width, height },
    });
    const res = await api.applyChanges({ pageId: page.id, ops: [{ op: 'add', shape }] });
    if (res.ok && res.data) setFile(res.data);
    // Do not select after creation — switch straight to select tool unselected.
    setActiveTool('select');
  }, [activePage, setFile, setActiveTool]);

  return (
    <div style={fpStyles.root}>
      <div style={fpStyles.sectionTitle}>Frame</div>
      <div style={fpStyles.list}>
        {FRAME_PRESETS.map(cat => {
          const open = expanded.has(cat.label);
          return (
            <div key={cat.label}>
              <button style={fpStyles.catHeader} onClick={() => toggleCategory(cat.label)}>
                <span style={fpStyles.chevron}>{open ? '▾' : '▸'}</span>
                {cat.label}
              </button>
              {open && cat.presets.map(p => (
                <PresetRow key={p.name} preset={p} onSelect={handleSelect} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PresetRow({ preset, onSelect }: {
  preset: FramePreset;
  onSelect: (w: number, h: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      style={{ ...fpStyles.presetRow, background: hovered ? 'var(--bg-elevated)' : 'transparent' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onSelect(preset.width, preset.height)}
    >
      <span style={fpStyles.presetName}>{preset.name}</span>
      <span style={fpStyles.presetDims}>{preset.width} × {preset.height}</span>
    </button>
  );
}

const fpStyles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' },
  sectionTitle: {
    padding: '11px 14px 9px',
    fontSize: 11, fontWeight: 700,
    color: 'var(--text-secondary)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  list: { flex: 1, overflowY: 'auto', paddingBottom: 12 },
  catHeader: {
    display: 'flex', alignItems: 'center', gap: 6,
    width: '100%', padding: '7px 14px',
    background: 'transparent', border: 'none',
    color: 'var(--text)', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
  },
  chevron: {
    color: 'var(--text-muted)', fontSize: 10, width: 10,
    flexShrink: 0, display: 'inline-block',
  },
  presetRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    width: '100%', padding: '0 14px 0 30px', height: 32,
    border: 'none', cursor: 'pointer', fontFamily: 'inherit',
    textAlign: 'left', transition: 'background .08s',
  },
  presetName: { color: 'var(--text)', fontSize: 12 },
  presetDims: {
    color: 'var(--text-muted)', fontSize: 11,
    fontVariantNumeric: 'tabular-nums', flexShrink: 0,
  },
};

// ── Styles ────────────────────────────────────────────────────────────────────

const pStyles: Record<string, React.CSSProperties> = {
  panel: {
    width: 286,
    background: 'var(--bg-panel)',
    borderLeft: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    overflow: 'hidden',
    fontFamily: 'system-ui',
  },
  header: {
    padding: '12px 14px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  headerTitle: {
    color: 'var(--text)', fontSize: 13, fontWeight: 600,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  headerType: {
    color: 'var(--text-muted)', fontSize: 11, textTransform: 'capitalize',
    background: 'var(--bg-inset)', border: '1px solid var(--border)',
    borderRadius: 999, padding: '3px 8px', flexShrink: 0,
  },
  modeToggle: {
    display: 'flex',
    gap: 4,
    padding: 8,
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  modeBtn: {
    flex: 1,
    background: 'transparent',
    border: '1px solid transparent',
    color: 'var(--text-secondary)',
    fontSize: 12,
    padding: '6px 8px',
    cursor: 'pointer',
    fontFamily: 'system-ui',
    borderRadius: 7,
    fontWeight: 600,
  },
  modeActive: {
    color: 'var(--text)',
    background: 'var(--bg-elevated)',
    // Full shorthand (not borderColor) — mixing shorthand + longhand across rerenders
    // triggers React's conflicting-style warning when the tab toggles.
    border: '1px solid var(--border-strong)',
  },
  scroll: { flex: 1, overflowY: 'auto', paddingBottom: 18 },
  // Tight vertical rhythm (Figma density): slim padding; empty sections are one short row.
  section: { padding: '9px 14px', borderTop: '1px solid var(--border)' },
  sectionHeader: {
    fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)',
    letterSpacing: '0.02em', minHeight: 24,
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  },
  fieldGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 8,
    marginBottom: 10,
  },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 10 },
  fillRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
    minHeight: 30,
  },
  fieldLabel: { color: 'var(--text-secondary)', fontSize: 12, flexShrink: 0, width: 44 },
  fillType: {
    flex: 1, color: 'var(--text)', fontSize: 11, overflow: 'hidden',
    textOverflow: 'ellipsis', fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    background: 'var(--bg-inset)', border: '1px solid var(--border)', borderRadius: 6,
    padding: '5px 7px', minWidth: 0,
  },
  empty: { padding: 14, color: 'var(--text-secondary)', fontSize: 12 },
  segGroup: { display: 'flex', gap: 3, flex: 1, background: 'var(--bg-inset)', borderRadius: 8, padding: 3 },
  effectRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' },
  effectGlyph: {
    width: 20, height: 20, borderRadius: 5, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-inset)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)',
  },
  effectChip: {
    flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 4,
    background: 'var(--bg-inset)', border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--text)', fontSize: 12, padding: '6px 8px', cursor: 'pointer',
    fontFamily: 'inherit', minHeight: 30,
  },
  iconGhost: {
    width: 26, height: 26, borderRadius: 6, flexShrink: 0,
    background: 'transparent', border: '1px solid transparent',
    color: 'var(--text-secondary)', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  // Bare icon action (section header + / − / etc.): no box chrome — just the glyph,
  // with a 24px hit area. Hover tint comes from the global button:hover brightness.
  iconAction: {
    width: 24, height: 24, borderRadius: 6,
    background: 'transparent', border: 'none', padding: 0,
    color: 'var(--text-secondary)', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  addRowBtn: {
    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, padding: '7px 8px',
  },
  iconActionMuted: {
    width: 26, height: 26, borderRadius: 6,
    background: 'transparent', border: '1px solid transparent',
    color: 'var(--text-muted)', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  select: {
    minWidth: 0,
    background: 'var(--bg-inset)', border: '1px solid var(--border)',
    borderRadius: 7, color: 'var(--text)', fontSize: 12, padding: '0 8px',
    outline: 'none', cursor: 'pointer', height: 30,
  },
  alignIconBtn: {
    background: 'var(--bg-inset)', border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--text-secondary)', cursor: 'pointer',
    width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
};
