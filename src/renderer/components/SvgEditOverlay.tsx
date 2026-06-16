/**
 * SvgEditOverlay — vector anchor-point editor (re-engineered).
 *
 * Renders on top of VectorOverlay when svgEditShapeId is set.
 * Self-contained: manages its own PathItem[][] state parsed from shape.svgInnerHTML.
 * Pushes livePreviewSvg on every mousemove; clears + commits on mouseUp.
 * No hatch, no bounding box, no selection chrome — just anchor points.
 *
 * Coordinate transform: viewBox (vx, vy) → screen (sx, sy)
 *   sx = (vx * (shape.width / origW) + shape.x) * zoom + vpX
 *
 * Anchor handles model:
 *   For anchor at items[ii]:
 *     - incoming handle = incomingHandle(items[ii])  (cp2 of a C command)
 *     - outgoing handle = items[ii+1].data[0,1]      (cp1 of the next C command)
 *   Dragging an anchor moves: endpoint + cp2 of same item + cp1 of next item.
 *   Dragging a handle moves: only that control point.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Shape } from '../../shared/types';
import { Viewport } from '../canvas/renderer';
import {
  parseAndNormalize, serializePath, endpointOf, incomingHandle, PathItem,
} from '../canvas/pathDataParser';
import { useDesignStore } from '../store/useDesignStore';

const ACCENT    = '#1a73e8';
const ANCHOR_R  = 4.5;  // anchor circle radius (px)
const HANDLE_SZ = 4.5;  // handle diamond half-diagonal (px)
const SW        = 1.5;  // stroke width

interface Props {
  shape:          Shape;
  viewport:       Viewport;
  /** Called on every mouseUp with the new full svgInnerHTML. */
  onCommit:       (newInnerHTML: string) => void;
  /** Called when the user deletes all remaining anchor points. */
  onDeleteShape?: () => Promise<void>;
  /** Called when the user clicks empty canvas (no drag) — exit path-edit mode. */
  onExit?: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract inner HTML from shape (svgInnerHTML preferred; fall back to svgContent body). */
function getEditingHTML(shape: Shape): string {
  if (shape.svgInnerHTML) return shape.svgInnerHTML;
  if (shape.svgContent) {
    try {
      const doc = new DOMParser().parseFromString(shape.svgContent, 'image/svg+xml');
      return doc.documentElement.innerHTML;
    } catch { /* fall through */ }
  }
  return '';
}

/** Parse all <path d="..."> from inner HTML → PathItem[][] (one per <path>). */
function parseSvgPaths(shape: Shape): PathItem[][] {
  const html = getEditingHTML(shape);
  if (!html) return [];
  try {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${html}</svg>`,
      'image/svg+xml',
    );
    return Array.from(doc.querySelectorAll('path')).map(el =>
      parseAndNormalize(el.getAttribute('d') ?? ''),
    );
  } catch {
    return [];
  }
}

/** Swap d attributes in inner HTML to match the current PathItem[][] state. */
function rebuildInnerHTML(html: string, paths: PathItem[][]): string {
  try {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${html}</svg>`,
      'image/svg+xml',
    );
    const els = Array.from(doc.querySelectorAll('path'));
    paths.forEach((items, i) => {
      if (els[i]) els[i].setAttribute('d', serializePath(items));
    });
    return doc.documentElement.innerHTML;
  } catch {
    return html;
  }
}

// Selection key: "pathIdx:itemIdx"
type SelKey = string;
const sk = (pi: number, ii: number): SelKey => `${pi}:${ii}`;

type DragTarget =
  | { kind: 'anchor';   selection: Set<SelKey> }
  | { kind: 'inHandle'; pi: number; ii: number }
  | { kind: 'outHandle'; pi: number; ii: number }; // ii = index of the NEXT C item

// ── Component ─────────────────────────────────────────────────────────────────

export default function SvgEditOverlay({ shape, viewport, onCommit, onDeleteShape, onExit }: Props) {
  const setLivePreviewSvg = useDesignStore(s => s.setLivePreviewSvg);

  const origW = shape.svgOriginalWidth  ?? shape.width;
  const origH = shape.svgOriginalHeight ?? shape.height;
  const scaleX = shape.width  / origW;
  const scaleY = shape.height / origH;

  // ViewBox → screen
  const toSX = (vx: number) => (vx * scaleX + shape.x) * viewport.zoom + viewport.x;
  const toSY = (vy: number) => (vy * scaleY + shape.y) * viewport.zoom + viewport.y;

  // Stable refs so drag handler never reads stale closures
  const vpRef    = useRef(viewport);
  const shapeRef = useRef(shape);
  vpRef.current    = viewport;
  shapeRef.current = shape;

  const [paths, setPaths]       = useState<PathItem[][]>(() => parseSvgPaths(shape));
  const pathsRef                = useRef<PathItem[][]>(paths);
  pathsRef.current              = paths;

  const [selection, setSelection] = useState<Set<SelKey>>(new Set());
  const selectionRef = useRef<Set<SelKey>>(selection);
  selectionRef.current = selection;

  const svgRef = useRef<SVGSVGElement>(null);

  type MarqueeDrag = { startSvgX: number; startSvgY: number; preSelection: Set<SelKey>; moved: boolean };
  const marqueeRef = useRef<MarqueeDrag | null>(null);
  // Keep latest onExit in a ref — the global mouseup handler is bound once via useEffect.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const [marqueeBox, setMarqueeBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const dragRef = useRef<{
    target: DragTarget;
    lastX: number;
    lastY: number;
  } | null>(null);

  // Re-parse when the shape changes (shape switch, undo/redo, external commit)
  useEffect(() => {
    setPaths(parseSvgPaths(shape));
    setSelection(new Set());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape.id, shape.svgInnerHTML]);

  // ── Delete selected anchors ───────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const sel = selectionRef.current;
      if (sel.size === 0) return;

      e.stopImmediatePropagation();
      e.preventDefault();

      const newPaths = pathsRef.current.map((items, pi) =>
        items.filter((item, ii) => {
          if (!endpointOf(item)) return true; // always keep Z
          return !sel.has(sk(pi, ii));
        }),
      );

      // Drop paths that have no anchor left
      const cleaned = newPaths.filter(items => items.some(item => endpointOf(item) !== null));

      // No paths remain → delete the shape entirely
      if (cleaned.length === 0) {
        onDeleteShape?.();
        return;
      }

      // Ensure first non-Z item per path is M (re-key L→M if needed)
      const fixed = cleaned.map(items => {
        const fi = items.findIndex(item => endpointOf(item) !== null);
        if (fi >= 0 && items[fi].key !== 'M') {
          const copy = [...items];
          copy[fi] = { ...copy[fi], key: 'M' };
          return copy;
        }
        return items;
      });

      pathsRef.current = fixed;
      setPaths(fixed);
      setSelection(new Set());
      setLivePreviewSvg(null);

      const html = shapeRef.current.svgInnerHTML ?? getEditingHTML(shapeRef.current);
      if (html) onCommit(rebuildInnerHTML(html, fixed));
    };

    const onKeyAll = (e: KeyboardEvent) => {
      onKey(e);
      // Cmd+A — select all anchors
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.stopImmediatePropagation();
        e.preventDefault();
        const all = new Set<SelKey>();
        pathsRef.current.forEach((items, pi) => {
          items.forEach((item, ii) => { if (endpointOf(item)) all.add(sk(pi, ii)); });
        });
        setSelection(all);
      }
    };

    window.addEventListener('keydown', onKeyAll, true); // capture: fires before Canvas bubble handler
    return () => window.removeEventListener('keydown', onKeyAll, true);
  }, [onCommit, setLivePreviewSvg]);

  // ── Mouse handlers (on elements) ─────────────────────────────────────────

  const onAnchorDown = useCallback((e: React.MouseEvent, pi: number, ii: number) => {
    e.stopPropagation();
    const k = sk(pi, ii);
    const newSel = e.shiftKey
      ? selection.has(k)
        ? new Set([...selection].filter(s => s !== k))
        : new Set([...selection, k])
      : new Set([k]);
    setSelection(newSel);
    dragRef.current = { target: { kind: 'anchor', selection: newSel }, lastX: e.clientX, lastY: e.clientY };
  }, [selection]);

  const onHandleDown = useCallback((e: React.MouseEvent, pi: number, ii: number, kind: 'inHandle' | 'outHandle') => {
    e.stopPropagation();
    dragRef.current = { target: { kind, pi, ii }, lastX: e.clientX, lastY: e.clientY };
  }, []);

  const onBackgroundMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const preSelection = e.shiftKey ? new Set(selectionRef.current) : new Set<SelKey>();
    if (!e.shiftKey) setSelection(new Set());
    // Store client coords; marqueeBox uses SVG-local for rendering
    marqueeRef.current = { startSvgX: e.clientX, startSvgY: e.clientY, preSelection, moved: false };
    const r = svgRef.current?.getBoundingClientRect();
    setMarqueeBox({ x: r ? e.clientX - r.left : e.clientX, y: r ? e.clientY - r.top : e.clientY, w: 0, h: 0 });
  }, []);

  // ── Global drag effect ────────────────────────────────────────────────────

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      // ── Marquee drag ───────────────────────────────────────────────────────
      if (marqueeRef.current) {
        const { startSvgX: startCX, startSvgY: startCY, preSelection } = marqueeRef.current;
        const r = svgRef.current?.getBoundingClientRect();
        // Render rect in SVG-local coords
        const rx = Math.min(startCX, e.clientX) - (r?.left ?? 0);
        const ry = Math.min(startCY, e.clientY) - (r?.top  ?? 0);
        const rw = Math.abs(e.clientX - startCX);
        const rh = Math.abs(e.clientY - startCY);
        if (rw > 3 || rh > 3) marqueeRef.current.moved = true;
        setMarqueeBox({ x: rx, y: ry, w: rw, h: rh });
        // Hit-test anchors — both ax/ay and rx/ry are in SVG-element-local coords
        const sh  = shapeRef.current, vp = vpRef.current;
        const oW  = sh.svgOriginalWidth  ?? sh.width;
        const oH  = sh.svgOriginalHeight ?? sh.height;
        const scX = sh.width / oW, scY = sh.height / oH;
        const inside = new Set<SelKey>();
        pathsRef.current.forEach((items, pi) => {
          items.forEach((item, ii) => {
            const ep = endpointOf(item);
            if (!ep) return;
            const [vx, vy] = ep;
            const ax = (vx * scX + sh.x) * vp.zoom + vp.x;
            const ay = (vy * scY + sh.y) * vp.zoom + vp.y;
            if (ax >= rx && ax <= rx + rw && ay >= ry && ay <= ry + rh) inside.add(sk(pi, ii));
          });
        });
        setSelection(new Set([...preSelection, ...inside]));
        return;
      }

      const drag = dragRef.current;
      if (!drag) return;

      const sh   = shapeRef.current;
      const zoom = vpRef.current.zoom;
      const sdx  = e.clientX - drag.lastX;
      const sdy  = e.clientY - drag.lastY;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;

      // Screen delta → viewBox delta
      const oW = sh.svgOriginalWidth  ?? sh.width;
      const oH = sh.svgOriginalHeight ?? sh.height;
      const dvx = (sdx / zoom) / (sh.width  / oW);
      const dvy = (sdy / zoom) / (sh.height / oH);

      const t = drag.target;

      const newPaths = pathsRef.current.map((items, pi) =>
        items.map((item, ii): PathItem => {
          const d = [...item.data];

          if (t.kind === 'anchor') {
            const isSel     = t.selection.has(sk(pi, ii));
            const prevIsSel = ii > 0 && t.selection.has(sk(pi, ii - 1));

            if (isSel) {
              // Move endpoint + incoming handle together
              if (item.key === 'M' || item.key === 'L') {
                d[0] += dvx; d[1] += dvy;
              } else if (item.key === 'C') {
                d[2] += dvx; d[3] += dvy; // cp2 (incoming handle)
                d[4] += dvx; d[5] += dvy; // endpoint
              }
              return { key: item.key, data: d };
            }
            if (prevIsSel && item.key === 'C') {
              // Move outgoing handle (cp1) of this item, which belongs to the prev anchor
              d[0] += dvx; d[1] += dvy;
              return { key: 'C', data: d };
            }
            return item;
          }

          // Handle drag: target specific item
          if ('pi' in t && (pi !== t.pi || ii !== t.ii)) return item;
          if (t.kind === 'inHandle'  && item.key === 'C') { d[2] += dvx; d[3] += dvy; return { key: 'C', data: d }; }
          if (t.kind === 'outHandle' && item.key === 'C') { d[0] += dvx; d[1] += dvy; return { key: 'C', data: d }; }
          return item;
        }),
      );

      setPaths(newPaths);
      pathsRef.current = newPaths;

      // Live preview: update VectorOverlay without committing to the store
      const html = shapeRef.current.svgInnerHTML ?? getEditingHTML(shapeRef.current);
      if (html) setLivePreviewSvg(rebuildInnerHTML(html, newPaths));
    };

    const onUp = () => {
      if (marqueeRef.current) {
        const wasClick = !marqueeRef.current.moved;
        marqueeRef.current = null;
        setMarqueeBox(null);
        // A click (no drag) on empty canvas exits path-edit mode (Figma behaviour);
        // a drag is a marquee anchor-selection and stays in edit mode.
        if (wasClick) onExitRef.current?.();
        return;
      }
      if (!dragRef.current) return;
      dragRef.current = null;
      setLivePreviewSvg(null);
      // Commit: write updated d-strings into a fresh copy of the inner HTML
      const html = shapeRef.current.svgInnerHTML ?? getEditingHTML(shapeRef.current);
      if (html) onCommit(rebuildInnerHTML(html, pathsRef.current));
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, [onCommit, setLivePreviewSvg]);

  // ── Rendering helpers ─────────────────────────────────────────────────────

  const buildOutlineD = (items: PathItem[]): string =>
    items.map(item => {
      switch (item.key) {
        case 'M': return `M ${toSX(item.data[0])} ${toSY(item.data[1])}`;
        case 'L': return `L ${toSX(item.data[0])} ${toSY(item.data[1])}`;
        case 'C': return `C ${toSX(item.data[0])} ${toSY(item.data[1])} ${toSX(item.data[2])} ${toSY(item.data[3])} ${toSX(item.data[4])} ${toSY(item.data[5])}`;
        case 'Z': return 'Z';
        default:  return '';
      }
    }).join(' ');

  // ── JSX ──────────────────────────────────────────────────────────────────

  return (
    <svg ref={svgRef} style={{
      position: 'absolute', inset: 0,
      width: '100%', height: '100%',
      pointerEvents: 'none',
      zIndex: 21, overflow: 'visible',
      fontSize: 0, lineHeight: 0,
    }}>
      {/* Transparent background — catches mousedown for marquee selection */}
      <rect
        x={0} y={0} width="100%" height="100%"
        fill="transparent"
        style={{ pointerEvents: 'all', cursor: 'default' }}
        onMouseDown={onBackgroundMouseDown}
      />
      {paths.map((items, pi) => (
        <g key={pi}>
          {/* Path outline — always visible in edit mode */}
          <path d={buildOutlineD(items)} fill="none" stroke={ACCENT} strokeWidth={1} opacity={0.4} />

          {items.map((item, ii) => {
            const ep = endpointOf(item);
            if (!ep) return null;

            const [vx, vy] = ep;
            const sx = toSX(vx), sy = toSY(vy);
            const isSel = selection.has(sk(pi, ii));

            // Incoming handle (cp2 of this C item)
            const inH = incomingHandle(item);
            // Outgoing handle = cp1 of the NEXT C item
            const nextItem = items[ii + 1];
            const outH: [number, number] | undefined =
              nextItem?.key === 'C' ? [nextItem.data[0], nextItem.data[1]] : undefined;

            return (
              <g key={ii}>
                {/* Incoming bezier handle — shown only when anchor is selected */}
                {isSel && inH && (() => {
                  const hx = toSX(inH[0]), hy = toSY(inH[1]);
                  return (
                    <>
                      <line x1={sx} y1={sy} x2={hx} y2={hy} stroke={ACCENT} strokeWidth={1} opacity={0.6} />
                      <rect
                        transform={`rotate(45, ${hx}, ${hy})`}
                        x={hx - HANDLE_SZ} y={hy - HANDLE_SZ}
                        width={HANDLE_SZ * 2} height={HANDLE_SZ * 2}
                        fill="white" stroke={ACCENT} strokeWidth={SW}
                        style={{ cursor: 'pointer', pointerEvents: 'all' }}
                        onMouseDown={e => onHandleDown(e, pi, ii, 'inHandle')}
                      />
                    </>
                  );
                })()}

                {/* Outgoing bezier handle — shown only when anchor is selected */}
                {isSel && outH && (() => {
                  const hx = toSX(outH[0]), hy = toSY(outH[1]);
                  return (
                    <>
                      <line x1={sx} y1={sy} x2={hx} y2={hy} stroke={ACCENT} strokeWidth={1} opacity={0.6} />
                      <rect
                        transform={`rotate(45, ${hx}, ${hy})`}
                        x={hx - HANDLE_SZ} y={hy - HANDLE_SZ}
                        width={HANDLE_SZ * 2} height={HANDLE_SZ * 2}
                        fill="white" stroke={ACCENT} strokeWidth={SW}
                        style={{ cursor: 'pointer', pointerEvents: 'all' }}
                        onMouseDown={e => onHandleDown(e, pi, ii + 1, 'outHandle')}
                      />
                    </>
                  );
                })()}

                {/* Anchor — large transparent hit area + visible circle */}
                <circle
                  cx={sx} cy={sy} r={ANCHOR_R + 5}
                  fill="transparent"
                  style={{ cursor: 'default', pointerEvents: 'all' }}
                  onMouseDown={e => onAnchorDown(e, pi, ii)}
                />
                <circle
                  cx={sx} cy={sy} r={ANCHOR_R}
                  fill={isSel ? ACCENT : 'white'}
                  stroke={ACCENT} strokeWidth={SW}
                  style={{ cursor: 'default', pointerEvents: 'all' }}
                  onMouseDown={e => onAnchorDown(e, pi, ii)}
                />
              </g>
            );
          })}
        </g>
      ))}
      {/* Marquee selection rectangle */}
      {marqueeBox && marqueeBox.w > 1 && marqueeBox.h > 1 && (
        <rect
          x={marqueeBox.x} y={marqueeBox.y}
          width={marqueeBox.w} height={marqueeBox.h}
          fill="rgba(26,115,232,0.08)"
          stroke={ACCENT} strokeWidth={1}
          strokeDasharray="4 2"
          style={{ pointerEvents: 'none' }}
        />
      )}
    </svg>
  );
}
