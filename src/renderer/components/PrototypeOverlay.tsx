import React, { useRef, useState, useEffect, useMemo } from 'react';
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

type EdgeSide = 'top' | 'bottom' | 'left' | 'right';

// Figma-style curved connector: a cubic bézier that exits the source horizontally (from
// its right-edge connect handle) and enters the target perpendicular to whichever edge it
// meets. Straight lines cross and tangle in dense flows; the curve reads as a clean cable.
function connectorPath(
  sx: number, sy: number,
  end: { x: number; y: number; side: EdgeSide },
): string {
  // Curvature scales with distance so short hops stay tight and long ones bow gently.
  const k = Math.max(40, Math.hypot(end.x - sx, end.y - sy) * 0.4);
  const normal: Record<EdgeSide, [number, number]> = {
    top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0],
  };
  const [nx, ny] = normal[end.side];
  const c1x = sx + k, c1y = sy;              // exit source rightward (the connect handle)
  const c2x = end.x + nx * k, c2y = end.y + ny * k; // approach target edge along its normal
  return `M ${sx} ${sy} C ${c1x} ${c1y} ${c2x} ${c2y} ${end.x} ${end.y}`;
}

// The 8 connection anchors of a shape (4 edge midpoints + 4 corners), in doc space, each
// with the outward direction the connection should leave from. Figma reveals only the one
// nearest the cursor as you approach an edge/corner.
type AnchorKey = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'se' | 'sw';
function shapeAnchorsDoc(s: Shape): { key: AnchorKey; x: number; y: number; dir: [number, number] }[] {
  const l = s.x, r = s.x + s.width, t = s.y, b = s.y + s.height;
  const cx = s.x + s.width / 2, cy = s.y + s.height / 2;
  const d = 1 / Math.SQRT2;
  return [
    { key: 'n', x: cx, y: t, dir: [0, -1] },
    { key: 's', x: cx, y: b, dir: [0, 1] },
    { key: 'w', x: l, y: cy, dir: [-1, 0] },
    { key: 'e', x: r, y: cy, dir: [1, 0] },
    { key: 'nw', x: l, y: t, dir: [-d, -d] },
    { key: 'ne', x: r, y: t, dir: [d, -d] },
    { key: 'sw', x: l, y: b, dir: [-d, d] },
    { key: 'se', x: r, y: b, dir: [d, d] },
  ];
}

export default function PrototypeOverlay({ viewport }: { viewport: Viewport }) {
  const { activePage, selectedIds, file, setFile } = useDesignStore();
  const svgRef = useRef<SVGSVGElement>(null);
  // ox/oy = the anchor point the drag started from (screen coords), so the ghost cable
  // leaves the exact anchor grabbed rather than the shape centre.
  const [drag, setDrag] = useState<{ fromId: string; ox: number; oy: number; x: number; y: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const [hoverFrame, setHoverFrame] = useState<string | null>(null);
  const hoverRef = useRef(hoverFrame);
  hoverRef.current = hoverFrame;

  // Cursor position (screen coords relative to this SVG), rAF-throttled. Drives which of a
  // shape's 8 anchors is revealed — only the one nearest the cursor shows.
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    let raf: number | null = null;
    let pending: { x: number; y: number } | null = null;
    const onMove = (e: MouseEvent) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      pending = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (raf == null) raf = requestAnimationFrame(() => { raf = null; setCursor(pending); });
    };
    // relatedTarget null ⇒ pointer left the window entirely (not just crossed an element).
    const onOut = (e: MouseEvent) => { if (!e.relatedTarget) setCursor(null); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseout', onOut);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseout', onOut);
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, []);

  const page = activePage();
  // Memoize the tree-derived data on `page` identity: this component re-renders on every
  // rAF-throttled cursor move (to reveal the nearest anchor), and without memoization each
  // of those ~60/sec re-renders re-walked the ENTIRE shape tree.
  const frames = useMemo(
    () => page ? page.childIds.map(id => page.objects[id]).filter((s): s is Shape => s?.type === 'frame') : [],
    [page]);
  const links = useMemo(() => {
    const out: { source: Shape; it: Interaction }[] = [];
    if (!page) return out;
    const walk = (id: string) => {
      const s = page.objects[id];
      if (!s) return;
      for (const it of (s.interactions ?? [])) {
        // Overlays are connections too — Figma draws a cable for those as well.
        const connects = it.action === 'navigate' || it.action === 'overlay' || it.action === 'swap-overlay';
        if (connects && it.targetFrameId && page.objects[it.targetFrameId]) out.push({ source: s, it });
      }
      s.childIds.forEach(walk);
    };
    page.childIds.forEach(walk);
    return out;
  }, [page]);
  if (!page || !file) return null;

  const { x: panX, y: panY, zoom } = viewport;
  const toScreenX = (d: number) => d * zoom + panX;
  const toScreenY = (d: number) => d * zoom + panY;

  const frameAtDoc = (dx: number, dy: number): Shape | null => {
    // topmost frame (later in childIds = on top) containing the point
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i];
      if (dx >= f.x && dx <= f.x + f.width && dy >= f.y && dy <= f.y + f.height) return f;
    }
    return null;
  };

  // Endpoint on a target frame's border nearest the source point (screen coords).
  const edgePoint = (frame: Shape, fromX: number, fromY: number) => {
    const l = toScreenX(frame.x), r = toScreenX(frame.x + frame.width);
    const t = toScreenY(frame.y), b = toScreenY(frame.y + frame.height);
    const cx = (l + r) / 2, cy = (t + b) / 2;
    const cands: { x: number; y: number; side: EdgeSide }[] = [
      { x: cx, y: t, side: 'top' }, { x: cx, y: b, side: 'bottom' },
      { x: l, y: cy, side: 'left' }, { x: r, y: cy, side: 'right' },
    ];
    let best = cands[0], bd = Infinity;
    for (const c of cands) {
      const d = (c.x - fromX) ** 2 + (c.y - fromY) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  };

  const startConnect = (source: Shape, ox: number, oy: number, e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    const rect = svgRef.current?.getBoundingClientRect();
    const toLocal = (ev: MouseEvent | React.MouseEvent) => ({
      x: ev.clientX - (rect?.left ?? 0), y: ev.clientY - (rect?.top ?? 0),
    });
    const init = toLocal(e);
    setDrag({ fromId: source.id, ox, oy, x: init.x, y: init.y });

    const onMove = (ev: MouseEvent) => {
      const p = toLocal(ev);
      setDrag({ fromId: source.id, ox, oy, x: p.x, y: p.y });
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
        { id: genId(), trigger: 'click', action: 'navigate', targetFrameId: target.id, transition: 'dissolve', duration: 300, easing: 'ease-out' },
      ];
      const res = await api.applyChanges({ pageId: page.id, ops: [{ op: 'set', id: src.id, attr: 'interactions', val: next }] });
      if (res.ok && res.data) setFile(res.data);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Hover-aware connection anchors: every frame (and any selected shape) has all 8 anchor
  // points, but only the ONE nearest the cursor is revealed — and only while the cursor is
  // near that shape. Approach an edge/corner and its node appears; move away and it hides.
  const REVEAL_MARGIN = 44; // screen px around the shape within which its anchor reveals
  const anchors: { shapeId: string; shape: Shape; key: AnchorKey; sx: number; sy: number }[] = [];
  if (cursor && !drag) {
    const candidates = new Map<string, Shape>();
    for (const f of frames) candidates.set(f.id, f);
    for (const id of selectedIds) { const s = page.objects[id]; if (s) candidates.set(id, s); }
    for (const s of candidates.values()) {
      const l = toScreenX(s.x), t = toScreenY(s.y), r = toScreenX(s.x + s.width), b = toScreenY(s.y + s.height);
      if (cursor.x < l - REVEAL_MARGIN || cursor.x > r + REVEAL_MARGIN ||
          cursor.y < t - REVEAL_MARGIN || cursor.y > b + REVEAL_MARGIN) continue;
      // Nearest of the 8 anchors to the cursor.
      let best: { key: AnchorKey; sx: number; sy: number } | null = null;
      let bd = Infinity;
      for (const a of shapeAnchorsDoc(s)) {
        const sx = toScreenX(a.x), sy = toScreenY(a.y);
        const d = (sx - cursor.x) ** 2 + (sy - cursor.y) ** 2;
        if (d < bd) { bd = d; best = { key: a.key, sx, sy }; }
      }
      if (best) anchors.push({ shapeId: s.id, shape: s, key: best.key, sx: best.sx, sy: best.sy });
    }
  }

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

      {/* existing connections — curved bézier cables (Figma-style) */}
      {links.map(({ source, it }) => {
        const target = page.objects[it.targetFrameId!]!;
        const sx = toScreenX(source.x + source.width / 2);
        const sy = toScreenY(source.y + source.height / 2);
        const end = edgePoint(target, sx, sy);
        return (
          <g key={source.id + it.id}>
            <path d={connectorPath(sx, sy, end)} fill="none" stroke={ACCENT} strokeWidth={2}
              markerEnd="url(#proto-arrow)" opacity={0.9} strokeLinecap="round" />
            <circle cx={sx} cy={sy} r={4} fill={ACCENT} />
          </g>
        );
      })}

      {/* live drag ghost — leaves the grabbed anchor, curves toward the hovered frame */}
      {drag && (() => {
        const sx = drag.ox, sy = drag.oy;
        const hf = hoverFrame ? page.objects[hoverFrame] : null;
        const d = hf
          ? connectorPath(sx, sy, edgePoint(hf, sx, sy))
          : `M ${sx} ${sy} C ${sx + Math.max(40, Math.abs(drag.x - sx) * 0.4)} ${sy} ${drag.x} ${drag.y} ${drag.x} ${drag.y}`;
        return (
          <g>
            <path d={d} fill="none" stroke={ACCENT} strokeWidth={2}
              strokeDasharray="6 4" markerEnd="url(#proto-arrow)" strokeLinecap="round" />
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

      {/* Hover-revealed connection anchor — the single node nearest the cursor. Sits ON the
          edge/corner (a solid accent dot with a white ring + "+"), signalling "drag to link".
          One per hovered shape; approaching a different side moves it to that edge/corner. */}
      {anchors.map(a => (
        <g key={a.shapeId + a.key} style={{ pointerEvents: 'all', cursor: 'crosshair' }}
          onMouseDown={e => startConnect(a.shape, a.sx, a.sy, e)}>
          {/* generous invisible hit target */}
          <circle cx={a.sx} cy={a.sy} r={12} fill="transparent" />
          <circle cx={a.sx} cy={a.sy} r={7} fill={ACCENT} stroke="#fff" strokeWidth={1.5} />
          {/* white + : "connect" */}
          <path d={`M ${a.sx - 3.2} ${a.sy} L ${a.sx + 3.2} ${a.sy} M ${a.sx} ${a.sy - 3.2} L ${a.sx} ${a.sy + 3.2}`}
            stroke="#fff" strokeWidth={1.5} fill="none" strokeLinecap="round" />
        </g>
      ))}
    </svg>
  );
}
