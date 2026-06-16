import React, { useRef, useState } from 'react';
import { Shape, Interaction } from '../../shared/types';
import { useDesignStore } from '../store/useDesignStore';
import { api } from '../ipc/api';

// Canvas overlay for Prototype mode: draws an arrow for every navigate interaction
// (source layer → target frame) and lets the designer drag a connect handle from a
// selected layer onto a frame to create a new connection. Pure presentation + a thin
// drag — the connection itself is stored as a normal Interaction on the source shape.

interface Viewport { x: number; y: number; zoom: number; }
const ACCENT = '#6E72F5';

function genId() { return Math.random().toString(36).slice(2, 10); }

export default function PrototypeOverlay({ viewport }: { viewport: Viewport }) {
  const { activePage, selectedIds, file, setFile } = useDesignStore();
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ fromId: string; x: number; y: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const [hoverFrame, setHoverFrame] = useState<string | null>(null);
  const hoverRef = useRef(hoverFrame);
  hoverRef.current = hoverFrame;

  const page = activePage();
  if (!page || !file) return null;

  const { x: panX, y: panY, zoom } = viewport;
  const toScreenX = (d: number) => d * zoom + panX;
  const toScreenY = (d: number) => d * zoom + panY;

  const frames = page.childIds.map(id => page.objects[id]).filter((s): s is Shape => s?.type === 'frame');

  const frameAtDoc = (dx: number, dy: number): Shape | null => {
    // topmost frame (later in childIds = on top) containing the point
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i];
      if (dx >= f.x && dx <= f.x + f.width && dy >= f.y && dy <= f.y + f.height) return f;
    }
    return null;
  };

  // All navigate connections on the page
  const links: { source: Shape; it: Interaction }[] = [];
  const walk = (id: string) => {
    const s = page.objects[id];
    if (!s) return;
    for (const it of (s.interactions ?? [])) {
      if (it.action === 'navigate' && it.targetFrameId && page.objects[it.targetFrameId]) links.push({ source: s, it });
    }
    s.childIds.forEach(walk);
  };
  page.childIds.forEach(walk);

  // Endpoint on a target frame's border nearest the source point (screen coords).
  const edgePoint = (frame: Shape, fromX: number, fromY: number) => {
    const l = toScreenX(frame.x), r = toScreenX(frame.x + frame.width);
    const t = toScreenY(frame.y), b = toScreenY(frame.y + frame.height);
    const cx = (l + r) / 2, cy = (t + b) / 2;
    const cands = [
      { x: cx, y: t }, { x: cx, y: b }, { x: l, y: cy }, { x: r, y: cy },
    ];
    let best = cands[0], bd = Infinity;
    for (const c of cands) {
      const d = (c.x - fromX) ** 2 + (c.y - fromY) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  };

  const startConnect = (source: Shape, e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    const rect = svgRef.current?.getBoundingClientRect();
    const toLocal = (ev: MouseEvent | React.MouseEvent) => ({
      x: ev.clientX - (rect?.left ?? 0), y: ev.clientY - (rect?.top ?? 0),
    });
    const init = toLocal(e);
    setDrag({ fromId: source.id, x: init.x, y: init.y });

    const onMove = (ev: MouseEvent) => {
      const p = toLocal(ev);
      setDrag({ fromId: source.id, x: p.x, y: p.y });
      const dx = (p.x - panX) / zoom, dy = (p.y - panY) / zoom;
      setHoverFrame(frameAtDoc(dx, dy)?.id ?? null);
    };
    const onUp = async (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const p = toLocal(ev);
      const dx = (p.x - panX) / zoom, dy = (p.y - panY) / zoom;
      const target = frameAtDoc(dx, dy);
      setDrag(null); setHoverFrame(null);
      if (!target) return;
      const src = page.objects[source.id];
      if (!src) return;
      const next: Interaction[] = [
        ...(src.interactions ?? []),
        { id: genId(), trigger: 'click', action: 'navigate', targetFrameId: target.id, transition: 'dissolve' },
      ];
      const res = await api.applyChanges({ pageId: page.id, ops: [{ op: 'set', id: src.id, attr: 'interactions', val: next }] });
      if (res.ok && res.data) setFile(res.data);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Connect handles on each selected shape (right-edge midpoint, screen space)
  const handles = [...selectedIds]
    .map(id => page.objects[id])
    .filter((s): s is Shape => !!s)
    .map(s => ({ id: s.id, shape: s, x: toScreenX(s.x + s.width), y: toScreenY(s.y + s.height / 2) }));

  return (
    <svg
      ref={svgRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 18, overflow: 'visible' }}
    >
      <defs>
        <marker id="proto-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill={ACCENT} />
        </marker>
      </defs>

      {/* existing connections */}
      {links.map(({ source, it }) => {
        const target = page.objects[it.targetFrameId!]!;
        const sx = toScreenX(source.x + source.width / 2);
        const sy = toScreenY(source.y + source.height / 2);
        const end = edgePoint(target, sx, sy);
        return (
          <g key={source.id + it.id}>
            <line x1={sx} y1={sy} x2={end.x} y2={end.y} stroke={ACCENT} strokeWidth={2}
              markerEnd="url(#proto-arrow)" opacity={0.9} />
            <circle cx={sx} cy={sy} r={4} fill={ACCENT} />
          </g>
        );
      })}

      {/* live drag ghost */}
      {drag && (() => {
        const src = page.objects[drag.fromId];
        if (!src) return null;
        const sx = toScreenX(src.x + src.width / 2);
        const sy = toScreenY(src.y + src.height / 2);
        return (
          <g>
            <line x1={sx} y1={sy} x2={drag.x} y2={drag.y} stroke={ACCENT} strokeWidth={2}
              strokeDasharray="6 4" markerEnd="url(#proto-arrow)" />
            <circle cx={sx} cy={sy} r={4} fill={ACCENT} />
          </g>
        );
      })()}

      {/* highlight the frame under the cursor while connecting */}
      {hoverFrame && (() => {
        const f = page.objects[hoverFrame];
        if (!f) return null;
        return (
          <rect x={toScreenX(f.x)} y={toScreenY(f.y)} width={f.width * zoom} height={f.height * zoom}
            fill="none" stroke={ACCENT} strokeWidth={2} rx={2} opacity={0.9} />
        );
      })()}

      {/* connect handles on selected shapes */}
      {!drag && handles.map(h => (
        <g key={h.id} style={{ pointerEvents: 'all', cursor: 'crosshair' }}
          onMouseDown={e => startConnect(h.shape, e)}>
          <circle cx={h.x} cy={h.y} r={9} fill="transparent" />
          <circle cx={h.x} cy={h.y} r={6} fill="#fff" stroke={ACCENT} strokeWidth={2} />
          <circle cx={h.x} cy={h.y} r={2.5} fill={ACCENT} />
        </g>
      ))}
    </svg>
  );
}
