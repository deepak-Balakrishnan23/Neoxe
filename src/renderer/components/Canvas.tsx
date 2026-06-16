import React, { useRef, useEffect, useCallback, useState } from 'react';
import { renderPage, Viewport, ShapePreview, invalidateSvgCache, externalDragPreview } from '../canvas/renderer';
import { fitTextSize } from '../canvas/textLayout';
import { hitTestPoint, screenToDoc, getHandleAt, hitTestMarquee } from '../canvas/hitTest';
import { applyResizeDelta, applyRotateDelta, handleCursor, shapeCenterDoc, ROTATE_HANDLE } from '../canvas/transform';
import { useDesignStore, ToolType } from '../store/useDesignStore';
import { usePrefs } from '../store/usePrefs';
import Ruler from './Ruler';
import PrototypeOverlay from './PrototypeOverlay';
import FrameLabels from './FrameLabels';
import { api } from '../ipc/api';
import { makeDefaultShape, Shape, PathSegment, Page, AnchorPoint } from '../../shared/types';
import { createAutoLayoutFromSelection } from '../../shared/createAutoLayout';
import TextEditor from './TextEditor';
import VectorOverlay from './VectorOverlay';
import VectorEditOverlay from './VectorEditOverlay';
import SvgEditOverlay from './SvgEditOverlay';
import { segmentsToPoints, pointsToSegments } from '../canvas/pathPoints';
import { parseSvgPath, svgPathToString } from '../canvas/svgPathParser';
import { imageCache, loadImage } from '../canvas/imageCache';
import { importImageFiles, ImportedImage } from '../io/imageImport';
import { syncViewport } from '../canvas/viewportBridge';

const MIN_ZOOM = 0.01;  // 1%
const MAX_ZOOM = 256;   // 25600%
const CANVAS_BOUNDS = 10000;        // ±doc units from origin (hard pan/zoom limit)
const SNAP_ENGAGE_PX = 8;           // screen pixels — snap engage threshold
const SNAP_RELEASE_PX = 12;         // screen pixels — snap release threshold
const SNAP_COLOR = '#E040FB';       // magenta snap lines
const ZOOM_STEPS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.25, 0.5, 1, 2, 4, 8, 16, 256];
const PEN_CLOSE_PX = 10; // screen-px radius around first anchor that closes the path

const PEN_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
  '<path d="M16.3594 2.74927C17.1797 1.88989 18.5859 1.88989 19.4453 2.74927L21.2422 4.54614C22.1016 5.40552 22.1016 6.81177 21.2422 7.67114L18.4688 10.4446L18.0391 10.8352L16.4766 16.6555C16.2812 17.3586 15.7734 17.9055 15.0703 18.1399L4.75781 21.7727C4.05469 22.0461 3.23438 21.8508 2.6875 21.304C2.14062 20.7571 1.98438 19.9758 2.21875 19.2336L5.85156 8.92114C6.08594 8.25708 6.63281 7.71021 7.33594 7.51489L13.1562 5.95239L13.5469 5.52271L16.3203 2.74927H16.3594ZM13.5469 7.78833L7.84375 9.35083C7.72656 9.35083 7.64844 9.42896 7.60938 9.54614L4.52344 18.3743L8.3125 14.5852C8.23438 14.3899 8.19531 14.1555 8.19531 13.9211C8.19531 12.9055 9.05469 12.0461 10.0703 12.0461C11.125 12.0461 11.9453 12.9055 11.9453 13.9211C11.9453 14.9758 11.125 15.7961 10.0703 15.7961C9.83594 15.7961 9.64062 15.7571 9.40625 15.679L5.61719 19.5071L14.4453 16.3821C14.5625 16.343 14.6406 16.2649 14.6406 16.1868L16.2031 10.4446L13.5469 7.78833Z" fill="black"/>' +
  '</svg>'
)}") 2 21, default`;
const DEFAULT_TEXT_WIDTH = 180;
const DEFAULT_TEXT_HEIGHT = 44;
const DEFAULT_TEXT_STYLE = {
  fontFamily: 'Inter, system-ui, sans-serif',
  fontWeight: 400,
  fontSize: 24,
  lineHeight: 1.25,
  letterSpacing: 0,
  textDecoration: 'none' as const,
  textTransform: 'none' as const,
  color: '#1A1A2E',
  opacity: 1,
};

// ── Drag state ────────────────────────────────────────────────────────────────
type DragMode =
  | { mode: 'none' }
  | { mode: 'pan'; lastScreenX: number; lastScreenY: number }
  | { mode: 'move'; startDocX: number; startDocY: number; originals: Record<string, { x: number; y: number }> }
  | { mode: 'resize'; shapeId: string; handleIndex: number; original: Shape; startDocX: number; startDocY: number }
  | { mode: 'rotate'; shapeId: string; original: Shape; cx: number; cy: number; startDocX: number; startDocY: number }
  | {
      mode: 'marquee'; startScreenX: number; startScreenY: number; currentScreenX: number; currentScreenY: number;
      // When the marquee was started inside a frame, selection is constrained to that
      // frame's direct children. clickSelectId: if the marquee never moves (it was a
      // click), select this id instead (used so a click on a frame body selects the frame).
      frameId?: string | null;
      clickSelectId?: string | null;
    }
  | { mode: 'create'; tool: 'rect' | 'ellipse' | 'frame'; startDocX: number; startDocY: number; currentDocX: number; currentDocY: number }
  | { mode: 'text-create'; startDocX: number; startDocY: number; currentDocX: number; currentDocY: number }
  | {
      // Reordering a single child within its auto-layout parent. The engine snaps
      // the dragged shape's position on commit; we only need to choose an insertion
      // index. `insertionIndex` is the position in the parent's childIds AFTER the
      // dragged child has been removed — same convention as the `move` op.
      mode: 'al-reorder';
      childId: string;
      containerId: string;
      startDocX: number; startDocY: number;
      currentDocX: number; currentDocY: number;
      originalIndex: number;
      insertionIndex: number;
    };

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

// Expand a set of ids to include all descendants (so moving a frame/group
// carries its children — which store absolute coordinates).
function withDescendants(page: { objects: Record<string, Shape> }, ids: string[]): string[] {
  const out = new Set<string>();
  const visit = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    const s = page.objects[id];
    if (s) for (const c of s.childIds) visit(c);
  };
  ids.forEach(visit);
  return [...out];
}

function topLevelSelection(page: { objects: Record<string, Shape> }, ids: string[]): string[] {
  const selected = new Set(ids);
  return ids.filter(id => {
    let parentId = page.objects[id]?.parentId ?? null;
    while (parentId) {
      if (selected.has(parentId)) return false;
      parentId = page.objects[parentId]?.parentId ?? null;
    }
    return true;
  });
}

// Ancestor chain from a shape up to the root: [id, parent, grandparent, ...].
function ancestorChain(page: { objects: Record<string, Shape> }, id: string): string[] {
  const chain: string[] = [];
  let cur: string | null = id;
  while (cur) { chain.push(cur); cur = page.objects[cur]?.parentId ?? null; }
  return chain;
}

// True when the point is within the shape's bounds (absolute doc coords).
function pointInShape(s: Shape, x: number, y: number): boolean {
  return x >= s.x && x <= s.x + s.width && y >= s.y && y <= s.y + s.height;
}

// Is this shape a drillable container?
// Container-first selection applies to GROUPS and NESTED frames/AL/SVG-import containers:
// a single click selects the outermost such container, double-click enters it, repeat to
// drill deeper. The ROOT frame (parentId === null) is deliberately EXCLUDED — it's the
// workspace, so its children are directly single-click selectable (no double-click needed).
// The root frame itself is grabbed via its name label (primary) or by clicking its empty
// body (secondary); see onMouseDown / FrameLabels.
function isDrillableContainer(s: Shape | undefined): boolean {
  if (!s) return false;
  if (s.type === 'group') return true;
  return s.type === 'frame' && s.parentId != null;
}

// The nearest drillable-container ancestor of a shape (one level up the hierarchy).
function parentGroupOf(page: { objects: Record<string, Shape> }, id: string): string | null {
  let cur: string | null = page.objects[id]?.parentId ?? null;
  while (cur) {
    const s = page.objects[cur];
    if (!s) break;
    if (isDrillableContainer(s)) return cur;
    cur = s.parentId ?? null;
  }
  return null;
}

// The OUTERMOST drillable-container ancestor (group / AL-frame / SVG-import-frame), stopping
// before any top-level frame. A click resolves to this — so clicking inside an imported SVG
// selects the whole SVG asset, and clicking a child of a screen selects that child (Figma),
// never the screen itself. Returns null when there's no such container (→ select the leaf).
function outermostGroup(page: { objects: Record<string, Shape> }, id: string): string | null {
  let top: string | null = null;
  let cur: string | null = page.objects[id]?.parentId ?? null;
  while (cur) {
    const s = page.objects[cur];
    if (!s) break;
    if (isDrillableContainer(s)) top = cur;
    cur = s.parentId ?? null;
  }
  return top;
}

// Figma group-selection resolution. Given the deepest shape under the cursor and the
// currently-entered group (groupEditId), return the id that should actually be selected:
//  • Not in edit mode  → the outermost group ancestor (whole group), else the shape.
//  • Inside groupEditId → the direct child of that group on the path to the hit (so you
//    select one level deep; nested groups select as a sub-group until you drill in).
//  • Hit is outside groupEditId → resolve as top-level (caller also exits edit mode).
function resolveSelectionTarget(
  page: { objects: Record<string, Shape> },
  hitId: string,
  groupEditId: string | null,
): string {
  if (groupEditId && page.objects[groupEditId]) {
    const chain = ancestorChain(page, hitId);
    const idx = chain.indexOf(groupEditId);
    if (idx > 0) return chain[idx - 1]; // direct child of the entered group on the path
  }
  // Not inside a container → select the outermost group/asset, else the element itself.
  // (Top-level frames are click-through; their children select directly — Figma behaviour.)
  return outermostGroup(page, hitId) ?? hitId;
}

// Compute the insertion slot for a drag-to-reorder inside an auto-layout container.
// Walks the OTHER siblings' midpoints along the container's primary axis (the dragged
// child is removed from the slot list so we don't snap onto our own current slot).
// Returns the index INSIDE the post-removal list (matches the `move` op's contract)
// plus the indicator line position in doc coords.
function alReorderSlot(
  container: Shape,
  draggingId: string,
  page: { objects: Record<string, Shape> },
  cursorDocX: number,
  cursorDocY: number,
): { index: number; indicator: { x1: number; y1: number; x2: number; y2: number } } {
  const direction = container.autoLayout!.direction;
  const isH = direction === 'horizontal';
  const siblings = container.childIds
    .filter(id => id !== draggingId)
    .map(id => page.objects[id])
    .filter((s): s is Shape => !!s);

  const cursor = isH ? cursorDocX : cursorDocY;
  let index = siblings.length;
  for (let i = 0; i < siblings.length; i++) {
    const s = siblings[i];
    const mid = isH ? s.x + s.width / 2 : s.y + s.height / 2;
    if (cursor < mid) { index = i; break; }
  }

  // Indicator: halfway between the prev sibling's trailing edge and the next sibling's
  // leading edge. At the boundaries, snap to the container's inner edge so the line
  // sits inside the padding box.
  const al = container.autoLayout!;
  const innerStart = isH
    ? container.x + al.padding.left
    : container.y + al.padding.top;
  const innerEnd = isH
    ? container.x + container.width - al.padding.right
    : container.y + container.height - al.padding.bottom;
  const prev = index > 0 ? siblings[index - 1] : null;
  const next = index < siblings.length ? siblings[index] : null;
  const prevEdge = prev ? (isH ? prev.x + prev.width : prev.y + prev.height) : innerStart;
  const nextEdge = next ? (isH ? next.x : next.y) : innerEnd;
  const primaryPos = (prevEdge + nextEdge) / 2;

  // Cross-axis extent of the indicator line — span the inner content box.
  const crossStart = isH
    ? container.y + al.padding.top
    : container.x + al.padding.left;
  const crossEnd = isH
    ? container.y + container.height - al.padding.bottom
    : container.x + container.width - al.padding.right;

  const indicator = isH
    ? { x1: primaryPos, y1: crossStart, x2: primaryPos, y2: crossEnd }
    : { x1: crossStart, y1: primaryPos, x2: crossEnd, y2: primaryPos };

  return { index, indicator };
}

// The deepest frame whose absolute bounds contain the point, excluding a set of shapes
// (the ones being dragged, so a shape never re-parents into itself/its own subtree).
// Returns null when the point is over empty canvas → caller re-homes to the page root.
function frameUnderPoint(
  page: { objects: Record<string, Shape> },
  x: number,
  y: number,
  exclude: Set<string>,
): Shape | null {
  let best: Shape | null = null;
  let bestDepth = -1;
  for (const id of Object.keys(page.objects)) {
    if (exclude.has(id)) continue;
    const s = page.objects[id];
    if (!s || s.type !== 'frame' || s.hidden) continue;
    const r = s.selrect;
    if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) {
      // Depth = length of the ancestor chain; deeper = more specific target.
      let depth = 0;
      let p = s.parentId ?? null;
      while (p) { depth++; p = page.objects[p]?.parentId ?? null; }
      if (depth > bestDepth) { best = s; bestDepth = depth; }
    }
  }
  return best;
}

function frameAtPoint(page: { objects: Record<string, Shape>; childIds: string[] }, docX: number, docY: number): Shape | null {
  const hitId = hitTestPoint(page, docX, docY);
  let current = hitId ? page.objects[hitId] : null;
  while (current) {
    if (current.type === 'frame') return current;
    current = current.parentId ? page.objects[current.parentId] : null;
  }
  // Fallback when the hit-test finds nothing (e.g. empty area of a fill-less frame): pick the
  // DEEPEST frame whose box contains the point — across ALL frames, not just top-level ones.
  // Scanning only page.childIds here would parent a shape dropped inside a NESTED frame to the
  // top-level frame, so its smart guides would align to the wrong container. Depth = ancestor
  // count; deeper wins so the innermost (immediate) frame is chosen.
  let best: Shape | null = null;
  let bestDepth = -1;
  for (const id of Object.keys(page.objects)) {
    const s = page.objects[id];
    if (!s || s.type !== 'frame' || s.hidden) continue;
    if (docX >= s.x && docX <= s.x + s.width && docY >= s.y && docY <= s.y + s.height) {
      let depth = 0;
      let p = s.parentId ?? null;
      while (p) { depth++; p = page.objects[p]?.parentId ?? null; }
      if (depth > bestDepth) { best = s; bestDepth = depth; }
    }
  }
  return best;
}

// ── Clipboard & deep-clone ────────────────────────────────────────────────────

interface ClipboardData {
  rootIds: string[];
  objects: Record<string, Shape>;
}
let canvasClipboard: ClipboardData | null = null;

// Deep-clone a shape and its entire subtree, generating fresh IDs for every node.
function deepCloneSubtree(
  page: { objects: Record<string, Shape> },
  rootId: string,
): { ops: { op: 'add'; shape: Shape }[]; newRootId: string } {
  const allIds = withDescendants(page, [rootId]);
  const idMap = new Map<string, string>();
  for (const id of allIds) idMap.set(id, genId());

  const ops: { op: 'add'; shape: Shape }[] = [];
  for (const id of allIds) {
    const s = page.objects[id];
    if (!s) continue;
    ops.push({
      op: 'add' as const,
      shape: {
        ...s,
        id: idMap.get(id)!,
        parentId: s.parentId ? (idMap.get(s.parentId) ?? s.parentId) : null,
        frameId: idMap.get(s.frameId) ?? s.frameId,
        childIds: s.childIds.map(c => idMap.get(c) ?? c),
      },
    });
  }
  return { ops, newRootId: idMap.get(rootId)! };
}

function placementForPoint(
  page: { objects: Record<string, Shape>; childIds: string[]; id: string },
  docX: number,
  docY: number,
  shapeType: Shape['type'],
): { parentId: string | null; frameId: string } {
  const frame = frameAtPoint(page, docX, docY);
  if (shapeType === 'frame') {
    return { parentId: frame?.id ?? null, frameId: '' };
  }
  return { parentId: frame?.id ?? null, frameId: frame?.id ?? page.id };
}

function localizePath(segs: PathSegment[], offsetX: number, offsetY: number): PathSegment[] {
  return segs.map(seg => ({
    ...seg,
    coords: seg.coords.map((coord, index) => coord - (index % 2 === 0 ? offsetX : offsetY)),
  }));
}

/** Reverse a PathSegment[] (open path), correctly swapping Bezier control points. */
function reversePath(segs: PathSegment[]): PathSegment[] {
  const pts = segmentsToPoints(segs).filter(p => p.command !== 'Z');
  if (pts.length < 2) return segs;
  const rev = [...pts].reverse();
  return rev.map((p, i): PathSegment => {
    if (i === 0) return { verb: 'M', coords: [p.x, p.y] };
    const from = rev[i - 1]; // FROM point in reversed order = the original segment's endpoint
    if (from.command === 'C') {
      // cp1 was outgoing from from's predecessor; cp2 was incoming to from.
      // Reversed: cp1=old_cp2 (outgoing from from), cp2=old_cp1 (incoming to p).
      return { verb: 'C', coords: [
        from.cp2x ?? from.x, from.cp2y ?? from.y,
        from.cp1x ?? from.x, from.cp1y ?? from.y,
        p.x, p.y,
      ]};
    }
    return { verb: 'L', coords: [p.x, p.y] };
  });
}

/** Find an open-path endpoint within PEN_CLOSE_PX of (docX, docY). */
function findOpenPathEndpoint(
  page: { objects: Record<string, Shape> },
  docX: number, docY: number, zoom: number,
): { shapeId: string; isFirst: boolean; x: number; y: number } | null {
  const threshold = PEN_CLOSE_PX / zoom;
  for (const shape of Object.values(page.objects)) {
    if (shape.type !== 'path' || !shape.content?.length) continue;
    if (shape.content.some(s => s.verb === 'Z')) continue; // closed path — skip
    const anchors = segmentsToPoints(shape.content).filter(p => p.command !== 'Z');
    if (anchors.length < 1) continue;
    const first = anchors[0];
    const last  = anchors[anchors.length - 1];
    const absLastX  = shape.x + last.x,  absLastY  = shape.y + last.y;
    const absFirstX = shape.x + first.x, absFirstY = shape.y + first.y;
    if (Math.hypot(docX - absLastX,  docY - absLastY)  <= threshold)
      return { shapeId: shape.id, isFirst: false, x: absLastX,  y: absLastY };
    if (Math.hypot(docX - absFirstX, docY - absFirstY) <= threshold)
      return { shapeId: shape.id, isFirst: true,  x: absFirstX, y: absFirstY };
  }
  return null;
}

function makeTextShape(
  page: { objects: Record<string, Shape>; childIds: string[]; id: string },
  x: number,
  y: number,
  fixedWidth?: number,
): Shape {
  const placement = placementForPoint(page, x, y, 'text');
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);
  const width = fixedWidth !== undefined ? fixedWidth : DEFAULT_TEXT_WIDTH;
  return makeDefaultShape({
    id: genId(),
    type: 'text',
    name: 'Text',
    frameId: placement.frameId,
    parentId: placement.parentId,
    x: roundedX,
    y: roundedY,
    width,
    height: DEFAULT_TEXT_HEIGHT,
    fills: [],
    textStyle: DEFAULT_TEXT_STYLE,
    textAutoWidth: fixedWidth === undefined,
    // Figma: a freshly-created text box starts EMPTY with a blinking caret — no
    // "Text" placeholder string. You type into it; an empty box is discarded on blur.
    paragraphs: [{ align: 'left', spans: [{ text: '' }] }],
    selrect: { x: roundedX, y: roundedY, width, height: DEFAULT_TEXT_HEIGHT },
  });
}

// Snap helpers ────────────────────────────────────────────────────────────────

function getSnapTargets(page: Page, movedIds: Set<string>): { x: number[]; y: number[] } {
  const xs = new Set<number>([0]);
  const ys = new Set<number>([0]);
  const addX = (v: number) => xs.add(Math.round(v));
  const addY = (v: number) => ys.add(Math.round(v));
  for (const id of movedIds) {
    const shape = page.objects[id];
    if (!shape) continue;
    const sibIds = shape.parentId ? (page.objects[shape.parentId]?.childIds ?? []) : page.childIds;
    for (const sid of sibIds) {
      if (movedIds.has(sid)) continue;
      const s = page.objects[sid];
      if (!s) continue;
      addX(s.x); addX(s.x + s.width); addX(s.x + s.width / 2);
      addY(s.y); addY(s.y + s.height); addY(s.y + s.height / 2);
    }
    const parent = shape.parentId ? page.objects[shape.parentId] : null;
    if (parent) {
      addX(parent.x); addX(parent.x + parent.width); addX(parent.x + parent.width / 2);
      addY(parent.y); addY(parent.y + parent.height); addY(parent.y + parent.height / 2);
    }
  }
  return { x: [...xs], y: [...ys] };
}

function findBestSnap(
  edges: number[],
  targets: number[],
  threshold: number,
): { offset: number; snapPos: number } | null {
  let best: { offset: number; snapPos: number } | null = null;
  for (const t of targets) {
    for (const e of edges) {
      const d = t - e;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.offset))) {
        best = { offset: d, snapPos: t };
      }
    }
  }
  return best;
}

// ── SVG import helpers ────────────────────────────────────────────────────────

const SVG_SKIP_TAGS = new Set([
  'defs','title','desc','metadata','style','script',
  'clippath','mask','lineargradient','radialgradient','filter','symbol','pattern',
]);

// Parse an element's `transform` attribute into an affine approximation {tx, ty, sx, sy}.
// Covers the common cases (translate, scale, matrix) — enough for faithful bounds, and
// exactly what this editor's own SVG export emits (`translate(...) scale(...)`). Skew /
// rotation are ignored for bounds purposes. translate is composed BEFORE scale (SVG order
// translate(...) scale(...) means point → translate + scale·point).
function parseElementTransform(el: Element): { tx: number; ty: number; sx: number; sy: number } {
  const t = el.getAttribute('transform');
  let tx = 0, ty = 0, sx = 1, sy = 1;
  if (!t) return { tx, ty, sx, sy };
  const num = '(-?[\\d.eE+]+)';
  const sep = '[\\s,]+';
  const mTrans = new RegExp(`translate\\(\\s*${num}(?:${sep}${num})?\\s*\\)`).exec(t);
  if (mTrans) { tx = parseFloat(mTrans[1]) || 0; ty = mTrans[2] != null ? (parseFloat(mTrans[2]) || 0) : 0; }
  const mScale = new RegExp(`scale\\(\\s*${num}(?:${sep}${num})?\\s*\\)`).exec(t);
  if (mScale) { sx = parseFloat(mScale[1]) || 1; sy = mScale[2] != null ? (parseFloat(mScale[2]) || 1) : sx; }
  const mMat = new RegExp(`matrix\\(\\s*${num}${sep}${num}${sep}${num}${sep}${num}${sep}${num}${sep}${num}\\s*\\)`).exec(t);
  if (mMat) { sx = parseFloat(mMat[1]) || 1; sy = parseFloat(mMat[4]) || 1; tx = parseFloat(mMat[5]) || 0; ty = parseFloat(mMat[6]) || 0; }
  return { tx, ty, sx, sy };
}

// Element bounds in its PARENT's coordinate space: local geometry bounds with the element's
// own `transform` applied. Honouring transform is what makes the import → export → re-import
// roundtrip faithful (export wraps each child in `<g transform="translate scale">`), and also
// fixes real-world SVGs whose groups carry transforms.
function getSVGElementBounds(
  el: Element, fallbackW: number, fallbackH: number,
): { x: number; y: number; width: number; height: number } {
  const lb = getLocalBounds(el, fallbackW, fallbackH);
  const { tx, ty, sx, sy } = parseElementTransform(el);
  return {
    x: tx + lb.x * sx,
    y: ty + lb.y * sy,
    width: Math.max(1, lb.width * sx),
    height: Math.max(1, lb.height * sy),
  };
}

// Local geometry bounds (the element's own coordinate space, before its `transform`).
function getLocalBounds(
  el: Element, fallbackW: number, fallbackH: number,
): { x: number; y: number; width: number; height: number } {
  const tag = el.tagName.toLowerCase();
  const getF = (attr: string, def = 0) => { const v = parseFloat(el.getAttribute(attr) ?? ''); return isNaN(v) ? def : v; };
  switch (tag) {
    case 'rect':
      return { x: getF('x'), y: getF('y'), width: Math.max(1, getF('width', fallbackW)), height: Math.max(1, getF('height', fallbackH)) };
    case 'circle': { const r = getF('r', 1), cx = getF('cx'), cy = getF('cy'); return { x: cx - r, y: cy - r, width: Math.max(1, r * 2), height: Math.max(1, r * 2) }; }
    case 'ellipse': { const rx = getF('rx', 1), ry = getF('ry', 1), cx = getF('cx'), cy = getF('cy'); return { x: cx - rx, y: cy - ry, width: Math.max(1, rx * 2), height: Math.max(1, ry * 2) }; }
    case 'line': { const x1=getF('x1'),y1=getF('y1'),x2=getF('x2'),y2=getF('y2'); return { x: Math.min(x1,x2), y: Math.min(y1,y2), width: Math.max(1,Math.abs(x2-x1)), height: Math.max(1,Math.abs(y2-y1)) }; }
    case 'polygon': case 'polyline': {
      const pts = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number).filter(v => !isNaN(v));
      if (pts.length < 2) return { x: 0, y: 0, width: fallbackW, height: fallbackH };
      let mnX=Infinity,mnY=Infinity,mxX=-Infinity,mxY=-Infinity;
      for (let i=0;i+1<pts.length;i+=2) { mnX=Math.min(mnX,pts[i]); mnY=Math.min(mnY,pts[i+1]); mxX=Math.max(mxX,pts[i]); mxY=Math.max(mxY,pts[i+1]); }
      return { x: mnX, y: mnY, width: Math.max(1,mxX-mnX), height: Math.max(1,mxY-mnY) };
    }
    case 'path': {
      const d = el.getAttribute('d') ?? '';
      if (!d.trim()) return { x: 0, y: 0, width: fallbackW, height: fallbackH };
      const anchors = parseSvgPath(d);
      let mnX=Infinity,mnY=Infinity,mxX=-Infinity,mxY=-Infinity;
      for (const pt of anchors) {
        if (pt.command === 'Z') continue;
        ([pt.x, pt.cp1x, pt.cp2x] as (number | undefined)[]).forEach(v => { if (v !== undefined) { mnX=Math.min(mnX,v); mxX=Math.max(mxX,v); } });
        ([pt.y, pt.cp1y, pt.cp2y] as (number | undefined)[]).forEach(v => { if (v !== undefined) { mnY=Math.min(mnY,v); mxY=Math.max(mxY,v); } });
      }
      if (!isFinite(mnX)) return { x: 0, y: 0, width: fallbackW, height: fallbackH };
      return { x: mnX, y: mnY, width: Math.max(1,mxX-mnX), height: Math.max(1,mxY-mnY) };
    }
    case 'text': case 'tspan': {
      const tx = getF('x', 0);
      const ty = getF('y', 0);
      const fontSize = getF('font-size', 12);
      const anchor = el.getAttribute('text-anchor') ?? 'start';
      const text = el.textContent ?? '';
      const estW = Math.max(10, text.length * fontSize * 0.55);
      const estH = Math.max(fontSize * 1.2, 10);
      // SVG text y is baseline; shift up to top
      const bx = anchor === 'middle' ? tx - estW / 2 : anchor === 'end' ? tx - estW : tx;
      return { x: bx, y: ty - estH, width: estW, height: estH };
    }
    case 'g': case 'svg': {
      const kids = Array.from(el.children).filter(c => !SVG_SKIP_TAGS.has(c.tagName.toLowerCase()));
      if (kids.length === 0) return { x: 0, y: 0, width: fallbackW, height: fallbackH };
      const bs = kids.map(c => getSVGElementBounds(c, fallbackW, fallbackH));
      const mnX=Math.min(...bs.map(b=>b.x)), mnY=Math.min(...bs.map(b=>b.y));
      return { x: mnX, y: mnY, width: Math.max(1, Math.max(...bs.map(b=>b.x+b.width))-mnX), height: Math.max(1, Math.max(...bs.map(b=>b.y+b.height))-mnY) };
    }
    default: return { x: 0, y: 0, width: fallbackW, height: fallbackH };
  }
}

function parseSVGChildrenToShapes(
  elements: Element[],
  origW: number, origH: number,
  parentX: number, parentY: number, parentW: number, parentH: number,
  frameId: string, parentId: string,
): Shape[] {
  const scaleX = parentW / origW;
  const scaleY = parentH / origH;
  const shapes: Shape[] = [];
  let counter = 0;
  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    if (SVG_SKIP_TAGS.has(tag)) continue;
    counter++;
    const id = genId();
    const name = el.getAttribute('id') || `${tag} ${counter}`;
    const b = getSVGElementBounds(el, origW, origH);
    const absX = Math.round(parentX + b.x * scaleX);
    const absY = Math.round(parentY + b.y * scaleY);
    const absW = Math.max(1, Math.round(b.width * scaleX));
    const absH = Math.max(1, Math.round(b.height * scaleY));
    // Text elements → type: 'text' node, not vector
    if (tag === 'text' || tag === 'tspan') {
      const textContent = el.textContent?.trim() ?? '';
      const fontSize = parseFloat(el.getAttribute('font-size') ?? '') || 12;
      const fillAttr = el.getAttribute('fill') ?? '#000000';
      const color = fillAttr === 'none' ? '#000000' : fillAttr;
      shapes.push(makeDefaultShape({
        id, type: 'text' as const,
        name: textContent || name,
        frameId, parentId,
        x: absX, y: absY, width: absW, height: absH,
        fills: [{ type: 'solid' as const, color, opacity: 1 }],
        strokes: [],
        paragraphs: [{ align: 'left' as const, spans: [{ text: textContent }] }],
        textStyle: {
          fontFamily: el.getAttribute('font-family') ?? 'system-ui, sans-serif',
          fontWeight: parseInt(el.getAttribute('font-weight') ?? '400') || 400,
          fontSize,
          lineHeight: 1.2,
          letterSpacing: 0,
          textDecoration: 'none',
          textTransform: 'none',
          color,
          opacity: 1,
        },
        selrect: { x: absX, y: absY, width: absW, height: absH },
      }));
      continue;
    }

    // For <path> elements: shift coordinates to 0-based viewBox space so SvgEditOverlay
    // can use them directly without a translate wrapper. Other elements keep the wrapper.
    let innerHTML: string;
    if (tag === 'path') {
      const d = el.getAttribute('d') ?? '';
      const pts = parseSvgPath(d);
      const shiftedPts = pts.map(pt => {
        if (pt.command === 'Z') return pt;
        return {
          ...pt,
          x: pt.x - b.x, y: pt.y - b.y,
          ...(pt.cp1x !== undefined ? { cp1x: pt.cp1x - b.x, cp1y: (pt.cp1y ?? 0) - b.y } : {}),
          ...(pt.cp2x !== undefined ? { cp2x: pt.cp2x - b.x, cp2y: (pt.cp2y ?? 0) - b.y } : {}),
        };
      });
      const shiftedD = svgPathToString(shiftedPts);
      const otherAttrs = Array.from(el.attributes)
        .filter(a => a.name !== 'd')
        .map(a => `${a.name}="${a.value}"`)
        .join(' ');
      innerHTML = `<path d="${shiftedD}" ${otherAttrs}/>`;
    } else {
      innerHTML = `<g transform="translate(${-b.x}, ${-b.y})">${el.outerHTML}</g>`;
    }
    shapes.push(makeDefaultShape({
      id, type: 'vector' as const, name, frameId, parentId,
      x: absX, y: absY, width: absW, height: absH,
      fills: [], strokes: [],
      svgInnerHTML: innerHTML,
      svgOriginalWidth: b.width,
      svgOriginalHeight: b.height,
      selrect: { x: absX, y: absY, width: absW, height: absH },
    }));
  }
  return shapes;
}

export default function Canvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    file, selectedIds, toggleSelected, setSelectedIds, clearSelection, activePage, setFile,
    activeTool, setActiveTool,
    editingTextId, setEditingTextId,
    groupEditId, setGroupEditId,
    vectorEditShapeId, vectorEditChildId, setVectorEditShapeId, setVectorEditChildId,
    pathEditShapeId, setPathEditShapeId,
    editingPoints, setEditingPoints,
    selectedPointIndices, setSelectedPointIndices,
    svgEditShapeId, setSvgEditShapeId,
    livePreviewSvg, setLivePreviewSvg,
    penSegments, setPenSegments, penCurrentDoc, setPenCurrentDoc,
    penContinueShapeId, setPenContinueShapeId, penContinueIsFirst, setPenContinueIsFirst,
    clearGuides, guidesPerPage,
    showToast, rightMode,
  } = useDesignStore();

  const { showRulers, showGuides, snapToGuides, set: setPrefs } = usePrefs();

  const [viewport, setViewport] = useState<Viewport>({ x: 40, y: 60, zoom: 1 });
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const vpRef = useRef(viewport);
  vpRef.current = viewport;

  // Hard canvas limits (Figma-style): clamp pan + zoom so the viewport can never travel
  // past the ±CANVAS_BOUNDS working area. Zoom-out is floored at the point where the whole
  // bounds just fill the viewport (can't zoom out to reveal empty space beyond the canvas),
  // and pan is clamped so the visible region stays inside the bounds.
  const clampVp = useCallback((vp: Viewport): Viewport => {
    const cw = containerRef.current?.clientWidth ?? 800;
    const ch = containerRef.current?.clientHeight ?? 600;
    const span = 2 * CANVAS_BOUNDS;
    const zMin = Math.max(MIN_ZOOM, cw / span, ch / span);
    const zoom = Math.max(zMin, Math.min(MAX_ZOOM, vp.zoom));
    // Pan range keeping [docL,docR]×[docT,docB] within [-BOUNDS, BOUNDS].
    const x = Math.min(CANVAS_BOUNDS * zoom, Math.max(cw - CANVAS_BOUNDS * zoom, vp.x));
    const y = Math.min(CANVAS_BOUNDS * zoom, Math.max(ch - CANVAS_BOUNDS * zoom, vp.y));
    return { x, y, zoom };
  }, []);
  useEffect(() => { syncViewport(viewport); }, [viewport]);
  const groupEditIdRef = useRef(groupEditId);
  groupEditIdRef.current = groupEditId;
  const svgEditShapeIdRef = useRef(svgEditShapeId);
  svgEditShapeIdRef.current = svgEditShapeId;
  const pathEditShapeIdRef = useRef(pathEditShapeId);
  pathEditShapeIdRef.current = pathEditShapeId;
  const vectorEditShapeIdRef = useRef(vectorEditShapeId);
  vectorEditShapeIdRef.current = vectorEditShapeId;

  const dragRef = useRef<DragMode>({ mode: 'none' });
  const previewRef = useRef<Map<string, ShapePreview>>(new Map());
  const images = useRef<Record<string, HTMLImageElement>>(imageCache);
  const didFit = useRef(false);
  const snapLinesRef = useRef<{ axis: 'x' | 'y'; pos: number }[]>([]);
  const snapStateRef = useRef<{ x: number | null; y: number | null }>({ x: null, y: null });
  const snapOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  const guideSnapRef = useRef<{
    x: { id: string; pos: number; edgeOffset: number } | null;
    y: { id: string; pos: number; edgeOffset: number } | null;
  }>({ x: null, y: null });
  const [showPixelGrid, setShowPixelGrid] = useState(true);
  const resizeSnapRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const showRulersRef = useRef(showRulers);
  showRulersRef.current = showRulers;
  const showGuidesRef = useRef(showGuides);
  showGuidesRef.current = showGuides;
  const snapToGuidesRef = useRef(snapToGuides);
  snapToGuidesRef.current = snapToGuides;
  const guidesPerPageRef = useRef(guidesPerPage);
  guidesPerPageRef.current = guidesPerPage;

  // ── Image loading ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!file) return;
    for (const [id, dataUrl] of Object.entries(file.images)) {
      loadImage(id, dataUrl);
    }
  }, [file]);

  // ── Place imported images ─────────────────────────────────────────────────
  // Shared by the image tool (centered) and drag-drop (at the drop point). Accepts
  // multiple images and cascades them so a multi-file drop doesn't fully overlap.
  const placeImages = useCallback(async (imgs: ImportedImage[], at?: { x: number; y: number }) => {
    const page = activePage();
    if (!page || imgs.length === 0) return;

    const ops: Parameters<typeof api.applyChanges>[0]['ops'] = [];
    const newIds: string[] = [];

    imgs.forEach((img, i) => {
      // Scale down very large images so they fit the canvas (preserve aspect ratio).
      const maxDim = 400;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));

      let x: number, y: number;
      if (at) {
        // Place centered on the drop point, cascading subsequent images by 20px.
        x = Math.round(at.x - w / 2) + i * 20;
        y = Math.round(at.y - h / 2) + i * 20;
      } else {
        const frame = page.childIds.map(id => page.objects[id]).find(s => s?.type === 'frame');
        if (frame) {
          x = Math.round(frame.x + (frame.width - w) / 2) + i * 20;
          y = Math.round(frame.y + (frame.height - h) / 2) + i * 20;
        } else {
          const vp = vpRef.current;
          x = Math.round((-vp.x + (canvasRef.current?.width ?? 800) / 2) / vp.zoom - w / 2) + i * 20;
          y = Math.round((-vp.y + (canvasRef.current?.height ?? 600) / 2) / vp.zoom - h / 2) + i * 20;
        }
      }

      const placement = placementForPoint(page, x + w / 2, y + h / 2, img.svgContent ? 'vector' : 'image');
      if (img.svgContent) {
        // SVG import: one transparent frame container + one child shape per top-level SVG element.
        // This makes each element individually selectable and deletable.
        const svgParser = new DOMParser();
        const svgDoc = svgParser.parseFromString(img.svgContent, 'image/svg+xml');
        const svgRootEl = svgDoc.querySelector('svg');
        const origW = img.svgOriginalWidth ?? w;
        const origH = img.svgOriginalHeight ?? h;
        const frameId = genId();
        ops.push({ op: 'add', shape: makeDefaultShape({
          id: frameId, type: 'frame', name: img.name || 'Image',
          frameId: placement.frameId, parentId: placement.parentId,
          x, y, width: w, height: h,
          fills: [], strokes: [],
          isSVGImport: true,
          aspectRatioLocked: true,
          lockedAspectRatio: w / h,
          selrect: { x, y, width: w, height: h },
        })});
        if (svgRootEl) {
          for (const child of parseSVGChildrenToShapes(
            Array.from(svgRootEl.children), origW, origH,
            x, y, w, h, frameId, frameId,
          )) {
            ops.push({ op: 'add', shape: child });
          }
        }
        newIds.push(frameId);
      } else {
        const newId = genId();
        const imgId = genId();
        const shape = makeDefaultShape({
          id: newId, type: 'image', name: img.name || 'Image',
          frameId: placement.frameId, parentId: placement.parentId,
          x, y, width: w, height: h,
          fills: [],
          imageId: imgId,
          aspectRatioLocked: true,
          lockedAspectRatio: w / h,
          selrect: { x, y, width: w, height: h },
        });
        ops.push({ op: 'setImage', id: imgId, dataUrl: img.dataUrl }, { op: 'add', shape });
        newIds.push(newId);
      }
    });

    const res = await api.applyChanges({ pageId: page.id, ops });
    if (res.ok && res.data) {
      setFile(res.data);
      setSelectedIds(newIds);
    }
    setActiveTool('select');
  }, [activePage, setFile, setSelectedIds, setActiveTool]);

  // ── Image tool: listen for imported images ────────────────────────────────
  useEffect(() => {
    const handler = (e: Event) => {
      const imgs = (e as CustomEvent<ImportedImage[]>).detail;
      if (Array.isArray(imgs)) placeImages(imgs);
    };
    window.addEventListener('tool:images-loaded', handler);
    return () => window.removeEventListener('tool:images-loaded', handler);
  }, [placeImages]);

  const createTextAt = useCallback(async (docX: number, docY: number, fixedWidth?: number) => {
    const page = activePage();
    if (!page) return;
    const shape = makeTextShape(page, docX, docY, fixedWidth);
    const res = await api.applyChanges({ pageId: page.id, ops: [{ op: 'add', shape }] });
    if (res.ok && res.data) {
      setFile(res.data);
      setSelectedIds([shape.id]);
      setEditingTextId(shape.id);
      // Text tool stays active — do NOT revert to select
    }
  }, [activePage, setFile, setSelectedIds, setEditingTextId]);


  // ── Canvas resize ─────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ro = new ResizeObserver(() => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      draw();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // ── Fit to page ───────────────────────────────────────────────────────────
  const fitToPage = useCallback(() => {
    const container = containerRef.current;
    const page = activePage();
    if (!container || !page || page.childIds.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of page.childIds) {
      const s = page.objects[id];
      if (!s) continue;
      minX = Math.min(minX, s.selrect.x); minY = Math.min(minY, s.selrect.y);
      maxX = Math.max(maxX, s.selrect.x + s.selrect.width);
      maxY = Math.max(maxY, s.selrect.y + s.selrect.height);
    }
    const PADDING = 48;
    const cw = container.clientWidth - PADDING * 2;
    const ch = container.clientHeight - PADDING * 2;
    const dw = maxX - minX; const dh = maxY - minY;
    if (dw <= 0 || dh <= 0 || cw <= 0 || ch <= 0) return;
    const zoom = Math.min(1, Math.min(cw / dw, ch / dh));
    setViewport({ x: PADDING + (cw - dw * zoom) / 2 - minX * zoom, y: PADDING + (ch - dh * zoom) / 2 - minY * zoom, zoom });
  }, [activePage]);

  useEffect(() => {
    if (file && !didFit.current) {
      requestAnimationFrame(() => { fitToPage(); didFit.current = true; });
    }
    if (!file) didFit.current = false;
  }, [file, fitToPage]);

  // ── Draw ─────────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const page = activePage();
    const vp = vpRef.current;
    const drag = dragRef.current;

    const marquee = drag.mode === 'marquee'
      ? normalizeRect(drag.startScreenX, drag.startScreenY, drag.currentScreenX, drag.currentScreenY)
      : null;

    if (!page) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#0f0f12';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const hiddenOverlayIds = new Set<string>();
    if (svgEditShapeIdRef.current) hiddenOverlayIds.add(svgEditShapeIdRef.current);
    if (pathEditShapeIdRef.current) hiddenOverlayIds.add(pathEditShapeIdRef.current);
    if (vectorEditShapeIdRef.current) hiddenOverlayIds.add(vectorEditShapeIdRef.current);
    const combinedPreview = externalDragPreview.size > 0
      ? new Map([...previewRef.current, ...externalDragPreview])
      : previewRef.current;
    renderPage(ctx, page, vp, selectedIds, images.current, combinedPreview, marquee, file ?? undefined, editingTextId, undefined, hiddenOverlayIds);

    // ── Creation ghost ────────────────────────────────────────────────────
    if (drag.mode === 'text-create') {
      const dx = drag.currentDocX - drag.startDocX;
      if (Math.abs(dx) >= 4) {
        const x = Math.min(drag.startDocX, drag.currentDocX);
        const y = drag.startDocY;
        const w = Math.abs(dx);
        const h = DEFAULT_TEXT_STYLE.fontSize * DEFAULT_TEXT_STYLE.lineHeight * 1.8;
        ctx.save();
        ctx.translate(vp.x, vp.y);
        ctx.scale(vp.zoom, vp.zoom);
        ctx.strokeStyle = '#6E72F5';
        ctx.lineWidth = 1.5 / vp.zoom;
        ctx.setLineDash([5 / vp.zoom, 3 / vp.zoom]);
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
      }
    }

    if (drag.mode === 'create') {
      const { startDocX, startDocY, currentDocX, currentDocY } = drag;
      const x = Math.min(startDocX, currentDocX);
      const y = Math.min(startDocY, currentDocY);
      const w = Math.abs(currentDocX - startDocX);
      const h = Math.abs(currentDocY - startDocY);
      if (w > 2 && h > 2) {
        ctx.save();
        ctx.translate(vp.x, vp.y);
        ctx.scale(vp.zoom, vp.zoom);
        ctx.strokeStyle = '#6E72F5';
        ctx.lineWidth = 1.5 / vp.zoom;
        ctx.setLineDash([5 / vp.zoom, 3 / vp.zoom]);
        ctx.fillStyle = 'rgba(110,114,245,0.08)';
        if (drag.tool === 'ellipse') {
          ctx.beginPath();
          ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
          ctx.fill(); ctx.stroke();
        } else {
          ctx.fillRect(x, y, w, h);
          ctx.strokeRect(x, y, w, h);
        }
        ctx.restore();
      }
    }

    // ── Auto-layout reorder indicator ─────────────────────────────────────
    if (drag.mode === 'al-reorder' && page) {
      const container = page.objects[drag.containerId];
      if (container?.autoLayout) {
        const { indicator } = alReorderSlot(container, drag.childId, page, drag.currentDocX, drag.currentDocY);
        ctx.save();
        ctx.translate(vp.x, vp.y);
        ctx.scale(vp.zoom, vp.zoom);
        ctx.strokeStyle = '#6E72F5';
        ctx.lineWidth = 2.5 / vp.zoom;
        ctx.setLineDash([]);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(indicator.x1, indicator.y1);
        ctx.lineTo(indicator.x2, indicator.y2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // ── Snap lines ────────────────────────────────────────────────────────
    const snapLines = snapLinesRef.current;
    if (snapLines.length > 0) {
      ctx.save();
      ctx.strokeStyle = SNAP_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      for (const line of snapLines) {
        ctx.beginPath();
        if (line.axis === 'x') {
          const screenX = line.pos * vp.zoom + vp.x;
          ctx.moveTo(screenX, 0); ctx.lineTo(screenX, canvas.height);
        } else {
          const screenY = line.pos * vp.zoom + vp.y;
          ctx.moveTo(0, screenY); ctx.lineTo(canvas.width, screenY);
        }
        ctx.stroke();
      }
      ctx.restore();
    }


    // ── Pen ghost ─────────────────────────────────────────────────────────
    const segs = penSegments;
    const cur = penCurrentDoc;
    if (segs && segs.length > 0) {
      ctx.save();
      ctx.translate(vp.x, vp.y);
      ctx.scale(vp.zoom, vp.zoom);
      ctx.strokeStyle = '#6E72F5';
      ctx.lineWidth = 1.5 / vp.zoom;
      ctx.setLineDash([]);
      ctx.beginPath();
      for (const seg of segs) {
        if (seg.verb === 'M') ctx.moveTo(seg.coords[0], seg.coords[1]);
        else if (seg.verb === 'L') ctx.lineTo(seg.coords[0], seg.coords[1]);
        else if (seg.verb === 'C') ctx.bezierCurveTo(seg.coords[0], seg.coords[1], seg.coords[2], seg.coords[3], seg.coords[4], seg.coords[5]);
      }
      if (cur) ctx.lineTo(cur.x, cur.y);
      ctx.stroke();

      // Is cursor hovering the first anchor (within close radius)? → "close" affordance
      const first = anchorPoint(segs[0]);
      const nearFirst = !!(cur && first && segs.length >= 2 &&
        Math.hypot(cur.x - first.x, cur.y - first.y) <= PEN_CLOSE_PX / vp.zoom);

      // Anchor dots
      for (let i = 0; i < segs.length; i++) {
        const pt = anchorPoint(segs[i]);
        if (!pt) continue;
        const isCloseTarget = i === 0 && nearFirst;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, (isCloseTarget ? 6.5 : 4) / vp.zoom, 0, Math.PI * 2);
        ctx.fillStyle = isCloseTarget ? '#6E72F5' : '#fff';
        ctx.strokeStyle = '#6E72F5';
        ctx.lineWidth = 1.5 / vp.zoom;
        ctx.fill(); ctx.stroke();
        // ring around close target
        if (isCloseTarget) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 10 / vp.zoom, 0, Math.PI * 2);
          ctx.strokeStyle = '#6E72F5';
          ctx.lineWidth = 1 / vp.zoom;
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }, [activePage, selectedIds, penSegments, penCurrentDoc]);

  useEffect(() => { draw(); }, [draw, file, selectedIds, viewport, penSegments, penCurrentDoc]);
  useEffect(() => {
    let raf: number;
    const loop = () => { draw(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      const meta = e.metaKey || e.ctrlKey;

      // Tool shortcuts
      const toolKeys: Record<string, ToolType> = { v: 'select', f: 'frame', r: 'rect', o: 'ellipse', t: 'text', p: 'pen', i: 'image' };
      if (!e.metaKey && !e.ctrlKey && !e.altKey && toolKeys[e.key.toLowerCase()]) {
        setActiveTool(toolKeys[e.key.toLowerCase()]);
        if (penSegments) { setPenSegments(null); setPenContinueShapeId(null); }
        return;
      }

      // Undo / Redo
      if (meta && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const res = await api.undo();
        if (res.ok && res.data) setFile(res.data);
        return;
      }
      if (meta && e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const res = await api.redo();
        if (res.ok && res.data) setFile(res.data);
        return;
      }

      if (e.key === 'Escape') {
        if (penSegments) { setPenSegments(null); setPenCurrentDoc(null); setPenContinueShapeId(null); }
        if (svgEditShapeId) {
          // SvgEditOverlay commits its own state on mouseUp — just close the overlay.
          setLivePreviewSvg(null);
          setSvgEditShapeId(null);
          return;
        }
        if (pathEditShapeId) {
          const page = activePage();
          const shape = page?.objects[pathEditShapeId];
          if (page && shape && editingPoints.length > 0) {
            const newContent = pointsToSegments(editingPoints);
            api.applyChanges({ pageId: page.id, ops: [{ op: 'set', id: pathEditShapeId, attr: 'content', val: newContent }] })
              .then(r => { if (r.ok && r.data) setFile(r.data); });
          }
          setPathEditShapeId(null);
          setEditingPoints([]);
          setSelectedPointIndices([]);
          return;
        }
        if (vectorEditShapeId) {
          setVectorEditShapeId(null);
          setVectorEditChildId(null);
          return;
        }
        // Inside a frame/group → step out one level: reselect that container, exit it.
        if (groupEditIdRef.current) {
          const gid = groupEditIdRef.current;
          const page = activePage();
          const parentGroup = page ? parentGroupOf(page, gid) : null;
          setGroupEditId(parentGroup);
          setSelectedIds([gid]);
          setActiveTool('select');
          return;
        }
        // Otherwise: a node is selected but we're not inside a container → deselect.
        if (selectedIds.size > 0) { clearSelection(); setActiveTool('select'); return; }
        setActiveTool('select');
        return;
      }

      // Create component (Cmd+K)
      if (meta && e.key === 'k') {
        e.preventDefault();
        const page = activePage();
        if (!page || selectedIds.size !== 1) return;
        const [shapeId] = selectedIds;
        const res = await api.createComponent(shapeId, page.id);
        if (res.ok && res.data) setFile(res.data);
        return;
      }

      // Auto Layout (Shift+A) — wrap selection in an auto-layout frame
      if (!meta && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const page = activePage();
        if (!page || selectedIds.size === 0) return;
        const plan = createAutoLayoutFromSelection(page, [...selectedIds], genId);
        if (!plan) return;
        const res = await api.applyChanges({ pageId: page.id, ops: plan.ops });
        if (res.ok && res.data) {
          setFile(res.data);
          setSelectedIds([plan.containerId]);
        }
        return;
      }

      // Group (Cmd+G)
      if (meta && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        const page = activePage();
        if (!page || selectedIds.size < 2) return;
        const shapes = [...selectedIds].map(id => page.objects[id]).filter(Boolean);
        const minX = Math.min(...shapes.map(s => s.selrect.x));
        const minY = Math.min(...shapes.map(s => s.selrect.y));
        const maxX = Math.max(...shapes.map(s => s.selrect.x + s.selrect.width));
        const maxY = Math.max(...shapes.map(s => s.selrect.y + s.selrect.height));
        const groupId = genId();
        // The group must live inside the same parent frame as the selected shapes —
        // otherwise it (and its children) jump out to the page root, leaving the frame.
        const commonParent = shapes.every(s => s.parentId === shapes[0].parentId)
          ? shapes[0].parentId ?? null
          : null;
        const group = makeDefaultShape({
          id: groupId, type: 'group', name: 'Group',
          frameId: shapes[0].frameId,
          parentId: commonParent,
          x: minX, y: minY, width: maxX - minX, height: maxY - minY,
          fills: [], strokes: [],
          selrect: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
        });
        const ops = [
          { op: 'add' as const, shape: group },
          ...[...selectedIds].map((id, i) => ({ op: 'move' as const, id, parentId: groupId, index: i })),
        ];
        const res = await api.applyChanges({ pageId: page.id, ops });
        if (res.ok && res.data) { setFile(res.data); setSelectedIds([groupId]); setGroupEditId(null); }
        return;
      }

      // Group as Frame (Cmd+Option+G)
      if (meta && e.altKey && e.code === 'KeyG') {
        e.preventDefault();
        const page = activePage();
        if (!page || selectedIds.size === 0) return;
        const shapes = [...selectedIds].map(id => page.objects[id]).filter(Boolean);
        const minX = Math.min(...shapes.map(s => s.selrect.x));
        const minY = Math.min(...shapes.map(s => s.selrect.y));
        const maxX = Math.max(...shapes.map(s => s.selrect.x + s.selrect.width));
        const maxY = Math.max(...shapes.map(s => s.selrect.y + s.selrect.height));
        const frameId = genId();
        const commonParent = shapes.every(s => s.parentId === shapes[0].parentId) ? shapes[0].parentId ?? null : null;
        const frame = makeDefaultShape({
          id: frameId, type: 'frame', name: 'Frame',
          frameId,
          parentId: commonParent,
          x: minX, y: minY, width: maxX - minX, height: maxY - minY,
          fills: [{ type: 'solid' as const, color: '#FFFFFF', opacity: 1 }],
          strokes: [],
          clipContent: true,
          selrect: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
        });
        const ops = [
          { op: 'add' as const, shape: frame },
          ...[...selectedIds].map((id, i) => ({ op: 'move' as const, id, parentId: frameId, index: i })),
        ];
        const res = await api.applyChanges({ pageId: page.id, ops });
        if (res.ok && res.data) { setFile(res.data); setSelectedIds([frameId]); setGroupEditId(null); }
        return;
      }

      // Ungroup (Cmd+Shift+G)
      if (meta && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        const page = activePage();
        if (!page) return;
        const groups = [...selectedIds].map(id => page.objects[id]).filter(s => s?.type === 'group' || s?.type === 'frame');
        if (groups.length === 0) return;
        const newSel: string[] = [];
        const ops: Parameters<typeof api.applyChanges>[0]['ops'] = [];
        for (const group of groups) {
          const siblings = group.parentId ? (page.objects[group.parentId]?.childIds ?? []) : page.childIds;
          const gIdx = siblings.indexOf(group.id);
          group.childIds.forEach((childId, i) => {
            ops.push({ op: 'move', id: childId, parentId: group.parentId, index: gIdx + i });
            newSel.push(childId);
          });
          ops.push({ op: 'del', id: group.id });
        }
        const res = await api.applyChanges({ pageId: page.id, ops });
        if (res.ok && res.data) { setFile(res.data); setSelectedIds(newSel); setGroupEditId(null); }
        return;
      }

      // Z-order shortcuts (Cmd+] / Cmd+[ / Cmd+Option+] / Cmd+Option+[)
      if (meta && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
        e.preventDefault();
        const page = activePage();
        if (!page || selectedIds.size === 0) return;
        const toFront = e.altKey && e.code === 'BracketRight';
        const toBack  = e.altKey && e.code === 'BracketLeft';
        const fwd     = !e.altKey && e.code === 'BracketRight';
        // back is the default fallback
        const zOps: Parameters<typeof api.applyChanges>[0]['ops'] = [];
        for (const id of selectedIds) {
          const s = page.objects[id];
          if (!s) continue;
          const siblings = s.parentId ? (page.objects[s.parentId]?.childIds ?? []) : page.childIds;
          const idx = siblings.indexOf(id);
          if (idx === -1) continue;
          const parentId = s.parentId ?? null;
          let newIdx: number;
          if (toFront) newIdx = siblings.length - 1;
          else if (toBack) newIdx = 0;
          else if (fwd) newIdx = Math.min(idx + 1, siblings.length - 1);
          else newIdx = Math.max(idx - 1, 0);
          if (newIdx !== idx) zOps.push({ op: 'move', id, parentId, index: newIdx });
        }
        if (zOps.length > 0) {
          const res = await api.applyChanges({ pageId: page.id, ops: zOps });
          if (res.ok && res.data) setFile(res.data);
        }
        return;
      }

      // Toggle left panel (⌘\ — Figma).
      if (meta && e.key === '\\') {
        e.preventDefault();
        const p = usePrefs.getState();
        p.set({ leftPanelCollapsed: !p.leftPanelCollapsed });
        return;
      }

      // Zoom keyboard shortcuts
      if (meta && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        const c = canvasRef.current;
        if (c) setViewport(vp => {
          const next = ZOOM_STEPS.find(z => z > vp.zoom + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
          const cx = c.width / 2; const cy = c.height / 2;
          const s = next / vp.zoom;
          return clampVp({ zoom: next, x: cx - s * (cx - vp.x), y: cy - s * (cy - vp.y) });
        });
        return;
      }
      if (meta && e.key === '-') {
        e.preventDefault();
        const c = canvasRef.current;
        if (c) setViewport(vp => {
          const prev = [...ZOOM_STEPS].reverse().find(z => z < vp.zoom - 0.001) ?? ZOOM_STEPS[0];
          const cx = c.width / 2; const cy = c.height / 2;
          const s = prev / vp.zoom;
          return clampVp({ zoom: prev, x: cx - s * (cx - vp.x), y: cy - s * (cy - vp.y) });
        });
        return;
      }
      if (meta && e.key === '0') {
        e.preventDefault();
        const c = canvasRef.current;
        if (c) setViewport({ zoom: 1, x: c.width / 2 - 400, y: 60 });
        return;
      }
      if (!meta && e.key === '0') { fitToPage(); return; }
      if (e.key === '1') {
        const c = canvasRef.current;
        if (c) setViewport({ x: c.width / 2 - 400, y: 60, zoom: 1 });
        return;
      }

      // Pixel grid toggle (Shift+')
      if (!meta && e.shiftKey && e.code === 'Quote') {
        e.preventDefault();
        setShowPixelGrid(v => !v);
        return;
      }

      // Ruler/guide shortcuts
      // Cmd+Option+; — clear all guides (most specific, check before Cmd+Shift+;)
      if (meta && e.altKey && e.code === 'Semicolon') {
        e.preventDefault();
        const pg = activePage();
        if (pg) { clearGuides(pg.id); showToast('All guides cleared'); }
        return;
      }
      // Cmd+Shift+R — toggle rulers
      if (meta && e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        setPrefs({ showRulers: !showRulersRef.current });
        return;
      }
      // Cmd+Shift+; — toggle guide visibility
      if (meta && e.shiftKey && e.code === 'Semicolon') {
        e.preventDefault();
        const nextShow = !showGuidesRef.current;
        setPrefs({ showGuides: nextShow });
        showToast(nextShow ? 'Guides visible' : 'Guides hidden');
        return;
      }
      // Cmd+; — toggle snap to guides
      if (meta && !e.shiftKey && !e.altKey && e.code === 'Semicolon') {
        e.preventDefault();
        setPrefs({ snapToGuides: !snapToGuidesRef.current });
        return;
      }

      // Enter = finish pen path
      if (e.key === 'Enter' && penSegments && penSegments.length >= 2) {
        await finishPenPath();
        return;
      }

      const page = activePage();

      // Cmd+A: select all / Cmd+Shift+A: deselect
      if (meta && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        clearSelection();
        return;
      }
      if (meta && !e.shiftKey && e.key === 'a') {
        e.preventDefault();
        const gid = groupEditIdRef.current;
        if (gid && page) {
          const grp = page.objects[gid];
          if (grp?.childIds.length) { setSelectedIds([...grp.childIds]); return; }
        }
        if (page) { setSelectedIds([...page.childIds]); return; }
      }

      // Copy (Cmd+C)
      if (meta && !e.shiftKey && e.key === 'c') {
        e.preventDefault();
        if (page && selectedIds.size > 0) {
          const roots = topLevelSelection(page, [...selectedIds]);
          const allIds = withDescendants(page, roots);
          const objects: Record<string, Shape> = {};
          for (const id of allIds) { if (page.objects[id]) objects[id] = page.objects[id]; }
          canvasClipboard = { rootIds: roots, objects };
        }
        return;
      }

      // Cut (Cmd+X)
      if (meta && e.key === 'x') {
        e.preventDefault();
        if (page && selectedIds.size > 0) {
          const roots = topLevelSelection(page, [...selectedIds]);
          const allIds = withDescendants(page, roots);
          const objects: Record<string, Shape> = {};
          for (const id of allIds) { if (page.objects[id]) objects[id] = page.objects[id]; }
          canvasClipboard = { rootIds: roots, objects };
          const delOps = roots.map(id => ({ op: 'del' as const, id }));
          const res = await api.applyChanges({ pageId: page.id, ops: delOps });
          if (res.ok && res.data) { setFile(res.data); clearSelection(); }
        }
        return;
      }

      // Paste at viewport center (Cmd+V) / Paste in place (Cmd+Shift+V)
      if (meta && e.key.toLowerCase() === 'v' && !e.altKey) {
        e.preventDefault();
        if (page && canvasClipboard) {
          const cb = canvasClipboard;
          const rShapes = cb.rootIds.map(id => cb.objects[id]).filter(Boolean);
          const idMap = new Map<string, string>();
          for (const id of Object.keys(cb.objects)) idMap.set(id, genId());
          let dx = 0, dy = 0;
          if (!e.shiftKey && rShapes.length > 0 && canvasRef.current) {
            const vp = vpRef.current;
            const cw = canvasRef.current.width; const ch = canvasRef.current.height;
            const vpCx = (cw / 2 - vp.x) / vp.zoom;
            const vpCy = (ch / 2 - vp.y) / vp.zoom;
            const minX = Math.min(...rShapes.map(s => s.x));
            const minY = Math.min(...rShapes.map(s => s.y));
            const maxX = Math.max(...rShapes.map(s => s.x + s.width));
            const maxY = Math.max(...rShapes.map(s => s.y + s.height));
            dx = Math.round(vpCx - (minX + maxX) / 2);
            dy = Math.round(vpCy - (minY + maxY) / 2);
          }
          const ops: Parameters<typeof api.applyChanges>[0]['ops'] = [];
          for (const [origId, shape] of Object.entries(cb.objects)) {
            const newId = idMap.get(origId)!;
            const isRoot = cb.rootIds.includes(origId);
            ops.push({ op: 'add' as const, shape: {
              ...shape,
              id: newId,
              x: isRoot ? shape.x + dx : shape.x + dx,
              y: isRoot ? shape.y + dy : shape.y + dy,
              parentId: shape.parentId ? (idMap.get(shape.parentId) ?? null) : null,
              frameId: idMap.get(shape.frameId) ?? shape.frameId,
              childIds: shape.childIds.map(c => idMap.get(c) ?? c),
            }});
          }
          const res = await api.applyChanges({ pageId: page.id, ops });
          if (res.ok && res.data) {
            setFile(res.data);
            setSelectedIds(cb.rootIds.map(id => idMap.get(id)!));
          }
        }
        return;
      }

      // Duplicate (Cmd+D) — clone selection + offset by 10,10
      if (meta && e.key === 'd') {
        e.preventDefault();
        if (page && selectedIds.size > 0) {
          const roots = topLevelSelection(page, [...selectedIds]);
          const allOps: { op: 'add'; shape: Shape }[] = [];
          const rootCloneIds: string[] = [];
          for (const rootId of roots) {
            const { ops, newRootId } = deepCloneSubtree(page, rootId);
            // Offset root clone by +10,+10
            const rootOp = ops.find(op => op.shape.id === newRootId);
            if (rootOp) { rootOp.shape.x += 10; rootOp.shape.y += 10; }
            allOps.push(...ops);
            rootCloneIds.push(newRootId);
          }
          const res = await api.applyChanges({ pageId: page.id, ops: allOps });
          if (res.ok && res.data) { setFile(res.data); setSelectedIds(rootCloneIds); }
        }
        return;
      }

      // ── Bug 1: path-point edit — delete selected anchors, NOT the whole shape ──
      if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target instanceof HTMLInputElement)) {
        if (pathEditShapeId && selectedPointIndices.length > 0) {
          e.preventDefault();
          const page2 = activePage();
          if (!page2) return;
          const remaining = editingPoints.filter((_, i) => !selectedPointIndices.includes(i));
          const nonZ = remaining.filter(p => p.command !== 'Z');
          if (nonZ.length < 2) {
            // Path degenerate → delete the shape entirely
            setPathEditShapeId(null); setEditingPoints([]); setSelectedPointIndices([]);
            const res = await api.applyChanges({ pageId: page2.id, ops: [{ op: 'del', id: pathEditShapeId }] });
            if (res.ok && res.data) { setFile(res.data); clearSelection(); }
          } else {
            const reindexed = remaining.map((p, i) => ({ ...p, index: i }));
            // Ensure first non-Z is M
            const fi = reindexed.findIndex(p => p.command !== 'Z');
            if (fi >= 0 && reindexed[fi].command !== 'M') reindexed[fi] = { ...reindexed[fi], command: 'M' as const };
            setSelectedPointIndices([]);
            setEditingPoints(reindexed);
            // Commit inline (same logic as commitPathPoints)
            const shape = page2.objects[pathEditShapeId];
            if (shape) {
              const validPts = reindexed.filter(p => p.command !== 'Z');
              let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
              for (const p of validPts) {
                minX = Math.min(minX, p.x, p.cp1x ?? p.x, p.cp2x ?? p.x);
                minY = Math.min(minY, p.y, p.cp1y ?? p.y, p.cp2y ?? p.y);
                maxX = Math.max(maxX, p.x, p.cp1x ?? p.x, p.cp2x ?? p.x);
                maxY = Math.max(maxY, p.y, p.cp1y ?? p.y, p.cp2y ?? p.y);
              }
              if (!isFinite(minX)) { minX = 0; minY = 0; maxX = shape.width; maxY = shape.height; }
              const relocated = reindexed.map(p => ({
                ...p,
                x: p.x - minX, y: p.y - minY,
                cp1x: p.cp1x !== undefined ? p.cp1x - minX : undefined,
                cp1y: p.cp1y !== undefined ? p.cp1y - minY : undefined,
                cp2x: p.cp2x !== undefined ? p.cp2x - minX : undefined,
                cp2y: p.cp2y !== undefined ? p.cp2y - minY : undefined,
              }));
              const newContent = pointsToSegments(relocated);
              const newX = Math.round(shape.x + minX), newY = Math.round(shape.y + minY);
              const newW = Math.max(1, Math.round(maxX - minX)), newH = Math.max(1, Math.round(maxY - minY));
              const res = await api.applyChanges({ pageId: page2.id, ops: [
                { op: 'set', id: pathEditShapeId, attr: 'content', val: newContent },
                { op: 'set', id: pathEditShapeId, attr: 'x', val: newX },
                { op: 'set', id: pathEditShapeId, attr: 'y', val: newY },
                { op: 'set', id: pathEditShapeId, attr: 'width', val: newW },
                { op: 'set', id: pathEditShapeId, attr: 'height', val: newH },
                { op: 'set', id: pathEditShapeId, attr: 'selrect', val: { x: newX, y: newY, width: newW, height: newH } },
              ]});
              if (res.ok && res.data) { setFile(res.data); setEditingPoints(relocated); }
            }
          }
          return;
        }
      }

      if (!page || selectedIds.size === 0) return;

      // Enter on a single selection: text → edit; frame/group → enter it (Figma)
      if (e.key === 'Enter' && selectedIds.size === 1) {
        const id = [...selectedIds][0];
        const s = page.objects[id];
        if (s?.type === 'text') { e.preventDefault(); setEditingTextId(id); return; }
        if (s?.type === 'frame' || s?.type === 'group') {
          e.preventDefault(); setGroupEditId(id); setSelectedIds([]); return;
        }
      }

      // Tab / Shift+Tab → select next/previous sibling at the same level
      if (e.key === 'Tab' && selectedIds.size === 1) {
        e.preventDefault();
        const id = [...selectedIds][0];
        const s = page.objects[id];
        const siblings = s?.parentId ? (page.objects[s.parentId]?.childIds ?? []) : page.childIds;
        const idx = siblings.indexOf(id);
        if (idx !== -1 && siblings.length > 1) {
          const nextIdx = (idx + (e.shiftKey ? -1 : 1) + siblings.length) % siblings.length;
          setSelectedIds([siblings[nextIdx]]);
        }
        return;
      }
      const nudge = e.shiftKey ? 10 : 1;
      let dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') { dx = -nudge; e.preventDefault(); }
      if (e.key === 'ArrowRight') { dx = nudge; e.preventDefault(); }
      if (e.key === 'ArrowUp') { dy = -nudge; e.preventDefault(); }
      if (e.key === 'ArrowDown') { dy = nudge; e.preventDefault(); }
      if (dx !== 0 || dy !== 0) {
        const ops = withDescendants(page, topLevelSelection(page, [...selectedIds])).flatMap(id => {
          const s = page.objects[id];
          if (!s) return [];
          return [
            { op: 'set' as const, id, attr: 'x', val: s.x + dx },
            { op: 'set' as const, id, attr: 'y', val: s.y + dy },
          ];
        });
        const res = await api.applyChanges({ pageId: page.id, ops });
        if (res.ok && res.data) setFile(res.data);
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target instanceof HTMLInputElement)) {
        // SvgEditOverlay handles its own Delete in capture phase — never delete the node here
        if (svgEditShapeId || vectorEditShapeId) return;
        e.preventDefault();
        const gid = groupEditIdRef.current;
        let ops: { op: 'del'; id: string }[];
        if (gid) {
          // Inside a group: only delete shapes that are direct children of the entered group.
          // Never delete the group itself from this mode.
          ops = [...selectedIds]
            .filter(id => page.objects[id]?.parentId === gid)
            .map(id => ({ op: 'del' as const, id }));
        } else {
          ops = topLevelSelection(page, [...selectedIds]).map(id => ({ op: 'del' as const, id }));
        }
        if (ops.length === 0) return;
        const res = await api.applyChanges({ pageId: page.id, ops });
        if (res.ok && res.data) { setFile(res.data); clearSelection(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitToPage, activePage, selectedIds, setFile, clearSelection, penSegments, setActiveTool, setPenSegments, setPenCurrentDoc, setPenContinueShapeId, setEditingTextId, setGroupEditId, setSelectedIds, vectorEditShapeId, setVectorEditShapeId, setVectorEditChildId, pathEditShapeId, editingPoints, setPathEditShapeId, setEditingPoints, setSelectedPointIndices, svgEditShapeId, setSvgEditShapeId, setLivePreviewSvg, groupEditId]);

  // ── Pen path commit ───────────────────────────────────────────────────────
  const finishPenPath = useCallback(async (closed = false) => {
    const segs = penSegments;
    if (!segs || segs.length < 2) {
      setPenSegments(null); setPenCurrentDoc(null); setPenContinueShapeId(null);
      return;
    }
    const page = activePage();
    if (!page) return;

    // ── Continuation: append to an existing open path ─────────────────────────
    if (penContinueShapeId) {
      const target = page.objects[penContinueShapeId];
      if (target?.content) {
        const existingContent = penContinueIsFirst ? reversePath(target.content) : target.content;
        // segs[0] is M at the continuation endpoint — drop it, localize the rest
        const newLocal = localizePath(segs.slice(1), target.x, target.y);
        const combined: PathSegment[] = [
          ...existingContent,
          ...newLocal,
          ...(closed ? [{ verb: 'Z' as const, coords: [] as number[] }] : []),
        ];
        // Recompute tight bounds of combined (all in shape-local coords)
        const validSegs = combined.filter(s => s.verb !== 'Z');
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const s of validSegs) {
          for (const [cx, cy] of coordPairs(s)) {
            minX = Math.min(minX, cx); minY = Math.min(minY, cy);
            maxX = Math.max(maxX, cx); maxY = Math.max(maxY, cy);
          }
        }
        if (!isFinite(minX)) { minX = 0; minY = 0; maxX = target.width; maxY = target.height; }
        const nonZCombined = combined.filter(s => s.verb !== 'Z');
        const rebased = localizePath(nonZCombined, minX, minY);
        if (closed) rebased.push({ verb: 'Z', coords: [] });
        const newX = Math.round(target.x + minX), newY = Math.round(target.y + minY);
        const newW = Math.max(1, Math.round(maxX - minX)), newH = Math.max(1, Math.round(maxY - minY));
        const res = await api.applyChanges({ pageId: page.id, ops: [
          { op: 'set', id: penContinueShapeId, attr: 'content', val: rebased },
          { op: 'set', id: penContinueShapeId, attr: 'x', val: newX },
          { op: 'set', id: penContinueShapeId, attr: 'y', val: newY },
          { op: 'set', id: penContinueShapeId, attr: 'width', val: newW },
          { op: 'set', id: penContinueShapeId, attr: 'height', val: newH },
          { op: 'set', id: penContinueShapeId, attr: 'selrect', val: { x: newX, y: newY, width: newW, height: newH } },
        ]});
        if (res.ok && res.data) { setFile(res.data); setSelectedIds([penContinueShapeId]); }
      }
      setPenSegments(null); setPenCurrentDoc(null); setPenContinueShapeId(null);
      setActiveTool('select');
      return;
    }

    // ── New path ───────────────────────────────────────────────────────────────
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const seg of segs) {
      for (const [px, py] of coordPairs(seg)) {
        minX = Math.min(minX, px); minY = Math.min(minY, py);
        maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
      }
    }
    const localizedSegments = localizePath(segs, minX, minY);
    const content = closed ? [...localizedSegments, { verb: 'Z' as const, coords: [] }] : localizedSegments;
    const newId = genId();
    const placement = placementForPoint(page, minX, minY, 'path');
    const shape = makeDefaultShape({
      id: newId, type: 'path', name: closed ? 'Polygon' : 'Path',
      frameId: placement.frameId,
      parentId: placement.parentId,
      x: minX, y: minY, width: maxX - minX || 10, height: maxY - minY || 10,
      fills: closed ? [{ type: 'solid', color: '#5C7CFA', opacity: 1 }] : [],
      strokes: closed ? [] : [{ color: '#1A1A2E', opacity: 1, width: 2, align: 'center', cap: 'round', style: 'solid' }],
      content,
      selrect: { x: minX, y: minY, width: maxX - minX || 10, height: maxY - minY || 10 },
    });
    const res = await api.applyChanges({ pageId: page.id, ops: [{ op: 'add', shape }] });
    if (res.ok && res.data) { setFile(res.data); setSelectedIds([newId]); }
    setPenSegments(null); setPenCurrentDoc(null);
    setActiveTool('select');
  }, [penSegments, penContinueShapeId, penContinueIsFirst, activePage, setFile, setSelectedIds, setPenSegments, setPenCurrentDoc, setPenContinueShapeId, setActiveTool]);

  // ── Wheel ─────────────────────────────────────────────────────────────────
  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    if (e.ctrlKey) {
      // Trackpad pinch-to-zoom (macOS sends ctrlKey=true for pinch gestures).
      // Continuous, no stepping — keep the point under the cursor fixed.
      setViewport(vp => {
        const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, vp.zoom * (1 + (-e.deltaY * 0.01))));
        const s = z / vp.zoom;
        return clampVp({ zoom: z, x: mouseX - s * (mouseX - vp.x), y: mouseY - s * (mouseY - vp.y) });
      });
    } else {
      // Two-finger pan (or regular scroll wheel).
      setViewport(vp => clampVp({ ...vp, x: vp.x - e.deltaX, y: vp.y - e.deltaY }));
    }
  }, [clampVp]);

  useEffect(() => {
    // Bind to the CONTAINER, not the canvas: in vector/path/SVG edit mode an anchor-point
    // overlay sits on top of the canvas with pointer-events, so a canvas-only listener never
    // sees the wheel (zoom appeared dead in edit mode). The container wraps every overlay and
    // wheel events bubble to it, so zoom/pan work regardless of what's under the cursor.
    const c = containerRef.current;
    if (!c) return;
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  // ── Mouse ─────────────────────────────────────────────────────────────────
  const [cursor, setCursor] = useState<string>('default');
  const [isDragging, setIsDragging] = useState(false);
  const [isLabelDragging, setIsLabelDragging] = useState(false);

  // Keep base cursor in sync with tool changes (mouse events only update it on interaction)
  useEffect(() => {
    if (activeTool === 'pen') setCursor(PEN_CURSOR);
    else if (activeTool === 'text') setCursor('text');
    else if (activeTool === 'select') setCursor('default');
    else setCursor('crosshair');
  }, [activeTool]);

  const getScreenPoint = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  };

  const startResizeHandle = useCallback((shapeId: string, handleIndex: number, e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    const page = activePage(); const shape = page?.objects[shapeId]; if (!shape) return;
    const { sx, sy } = getScreenPoint(e);
    const doc = screenToDoc(sx, sy, vpRef.current);
    dragRef.current = { mode: 'resize', shapeId, handleIndex, original: structuredClone(shape), startDocX: doc.x, startDocY: doc.y };
    setIsDragging(true);
  }, [activePage]); // eslint-disable-line react-hooks/exhaustive-deps

  const startRotateHandle = useCallback((shapeId: string, e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    const page = activePage(); const shape = page?.objects[shapeId]; if (!shape) return;
    const { sx, sy } = getScreenPoint(e);
    const doc = screenToDoc(sx, sy, vpRef.current);
    const cx = shape.x + shape.width / 2; const cy = shape.y + shape.height / 2;
    dragRef.current = { mode: 'rotate', shapeId, original: structuredClone(shape), cx, cy, startDocX: doc.x, startDocY: doc.y };
    setIsDragging(true);
  }, [activePage]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMouseDown = useCallback(async (e: React.MouseEvent) => {
    // While editing text, a click anywhere on the canvas finishes editing (Figma
    // behaviour) and is consumed — it must NOT start creating a new text box. Blurring
    // the textarea triggers its commit (which reverts the tool to select).
    if (editingTextId) {
      const ta = containerRef.current?.querySelector('textarea');
      if (ta) (ta as HTMLTextAreaElement).blur();
      return;
    }

    const { sx, sy } = getScreenPoint(e);
    const vp = vpRef.current;
    const doc = screenToDoc(sx, sy, vp);
    const page = activePage();

    // Middle-click = pan
    if (e.button === 1) {
      dragRef.current = { mode: 'pan', lastScreenX: sx, lastScreenY: sy };
      setCursor('grabbing');
      return;
    }
    if (e.button !== 0) return;

    // Alt + left-click on a selected node = duplicate-drag; alt + click elsewhere = pan
    if (e.altKey) {
      const altHit = page ? hitTestPoint(page, doc.x, doc.y) : null;
      const altTarget = altHit && page ? resolveSelectionTarget(page, altHit, groupEditId) : null;
      if (altTarget && selectedIds.has(altTarget) && page) {
        const roots = topLevelSelection(page, [...selectedIds]);
        const allOps: { op: 'add'; shape: Shape }[] = [];
        const cloneOriginals: Record<string, { x: number; y: number }> = {};
        const rootCloneIds: string[] = [];
        for (const rootId of roots) {
          const { ops, newRootId } = deepCloneSubtree(page, rootId);
          allOps.push(...ops);
          rootCloneIds.push(newRootId);
          for (const op of ops) cloneOriginals[op.shape.id] = { x: op.shape.x, y: op.shape.y };
        }
        const res = await api.applyChanges({ pageId: page.id, ops: allOps });
        if (res.ok && res.data) { setFile(res.data); setSelectedIds(rootCloneIds); }
        dragRef.current = { mode: 'move', startDocX: doc.x, startDocY: doc.y, originals: cloneOriginals };
        e.preventDefault(); return;
      }
      dragRef.current = { mode: 'pan', lastScreenX: sx, lastScreenY: sy };
      setCursor('grabbing');
      return;
    }

    // ── Pen tool ────────────────────────────────────────────────────────────
    if (activeTool === 'pen') {
      const segs = penSegments ?? [];
      // Closure: click on/near the FIRST anchor (≥2 pts) → close + finalize.
      if (segs.length >= 2) {
        const first = anchorPoint(segs[0]);
        if (first) {
          const closeRadiusDoc = PEN_CLOSE_PX / vp.zoom;
          if (Math.hypot(doc.x - first.x, doc.y - first.y) <= closeRadiusDoc) {
            await finishPenPath(true);
            return;
          }
        }
      }
      // No active path yet → check for an open-path endpoint to continue from
      if (segs.length === 0 && page) {
        const hit = findOpenPathEndpoint(page, doc.x, doc.y, vp.zoom);
        if (hit) {
          setPenContinueShapeId(hit.shapeId);
          setPenContinueIsFirst(hit.isFirst);
          setPenSegments([{ verb: 'M', coords: [hit.x, hit.y] }]);
          return;
        }
      }
      if (segs.length === 0) setPenSegments([{ verb: 'M', coords: [doc.x, doc.y] }]);
      else setPenSegments([...segs, { verb: 'L', coords: [doc.x, doc.y] }]);
      return;
    }

    // ── Text tool ───────────────────────────────────────────────────────────
    if (activeTool === 'text') {
      if (!page) return;
      // Clicking an existing text layer → select it and enter edit mode
      const hitId = hitTestPoint(page, doc.x, doc.y);
      if (hitId && page.objects[hitId]?.type === 'text') {
        setSelectedIds([hitId]);
        setEditingTextId(hitId);
        return;
      }
      // Otherwise start drag tracking: click = auto-width, drag = fixed-width
      dragRef.current = { mode: 'text-create', startDocX: doc.x, startDocY: doc.y, currentDocX: doc.x, currentDocY: doc.y };
      setCursor('text');
      return;
    }

    // ── Shape creation tools ────────────────────────────────────────────────
    if (activeTool === 'rect' || activeTool === 'ellipse' || activeTool === 'frame') {
      let startDocX = doc.x, startDocY = doc.y;
      if (page) {
        const frame = frameAtPoint(page, doc.x, doc.y);
        if (frame) {
          const engageDoc = SNAP_ENGAGE_PX / vp.zoom;
          const targetsX = [frame.x, frame.x + frame.width, frame.x + frame.width / 2].map(Math.round);
          const targetsY = [frame.y, frame.y + frame.height, frame.y + frame.height / 2].map(Math.round);
          for (const sibId of (frame.childIds ?? [])) {
            const sib = page.objects[sibId];
            if (!sib) continue;
            targetsX.push(Math.round(sib.x), Math.round(sib.x + sib.width), Math.round(sib.x + sib.width / 2));
            targetsY.push(Math.round(sib.y), Math.round(sib.y + sib.height), Math.round(sib.y + sib.height / 2));
          }
          const bx = findBestSnap([doc.x], targetsX, engageDoc);
          const by = findBestSnap([doc.y], targetsY, engageDoc);
          if (bx) startDocX = bx.snapPos;
          if (by) startDocY = by.snapPos;
        }
      }
      dragRef.current = { mode: 'create', tool: activeTool, startDocX, startDocY, currentDocX: startDocX, currentDocY: startDocY };
      setCursor('crosshair');
      return;
    }

    // ── Exit vector / SVG edit when clicking outside the editing shape ────────
    if ((vectorEditShapeId || svgEditShapeId) && page) {
      const editId = vectorEditShapeId ?? svgEditShapeId!;
      const editShape = page.objects[editId];
      if (editShape) {
        const inside = doc.x >= editShape.x && doc.x <= editShape.x + editShape.width
                    && doc.y >= editShape.y && doc.y <= editShape.y + editShape.height;
        if (!inside) {
          setVectorEditShapeId(null);
          setVectorEditChildId(null);
          setSvgEditShapeId(null);
          setLivePreviewSvg(null);
        }
      }
    }

    // ── Select tool ─────────────────────────────────────────────────────────

    // Double-clicks drill into groups / edit text — handled by onDoubleClick. Don't
    // start a resize/move/marquee on the second mousedown.
    if (e.detail >= 2) { e.preventDefault(); return; }

    const handleHit = page ? getHandleAt(sx, sy, selectedIds, page, vp) : null;
    if (handleHit && page) {
      const shape = page.objects[handleHit.shapeId];
      if (!shape) return;
      if (handleHit.handleIndex === ROTATE_HANDLE) {
        const { cx, cy } = shapeCenterDoc(shape);
        dragRef.current = { mode: 'rotate', shapeId: shape.id, original: structuredClone(shape), cx, cy, startDocX: doc.x, startDocY: doc.y };
      } else {
        dragRef.current = { mode: 'resize', shapeId: shape.id, handleIndex: handleHit.handleIndex, original: structuredClone(shape), startDocX: doc.x, startDocY: doc.y };
      }
      setIsDragging(true);
      e.preventDefault(); return;
    }

    const hitId = page ? hitTestPoint(page, doc.x, doc.y) : null;
    const meta = e.metaKey || e.ctrlKey;
    const shift = e.shiftKey;

    // Start a move drag on a selection set (moves the whole subtree — children store
    // absolute coords). Shared by the branches below.
    const beginMove = (sel: Set<string>) => {
      const moveIds = withDescendants(page!, topLevelSelection(page!, [...sel]));
      const originals: Record<string, { x: number; y: number }> = {};
      for (const id of moveIds) { const s = page!.objects[id]; if (s) originals[id] = { x: s.x, y: s.y }; }
      guideSnapRef.current = { x: null, y: null };
      dragRef.current = { mode: 'move', startDocX: doc.x, startDocY: doc.y, originals };
      setIsDragging(true);
      setCursor('move'); // consistent move cursor for layer manipulation — never the pan hand
    };
    // Select `target`, then either reorder (if it's an AL child) or move it.
    const selectAndDrag = (target: string) => {
      if (!selectedIds.has(target)) toggleSelected(target, shift);
      const sel = shift ? new Set([...selectedIds, target]) : (selectedIds.has(target) ? selectedIds : new Set([target]));
      const ts = page!.objects[target];
      const parent = ts?.parentId ? page!.objects[ts.parentId] : null;
      if (sel.size === 1 && parent?.autoLayout && parent.childIds.length > 1) {
        const originalIndex = parent.childIds.indexOf(target);
        dragRef.current = { mode: 'al-reorder', childId: target, containerId: parent.id,
          startDocX: doc.x, startDocY: doc.y, currentDocX: doc.x, currentDocY: doc.y, originalIndex, insertionIndex: originalIndex };
        setIsDragging(true);
        setCursor('move');
        return;
      }
      beginMove(sel);
    };

    if (page) {
      // ── Cmd/Ctrl+click: deep-select the exact node under the cursor (bypass hierarchy) ──
      if (meta && !shift && hitId) {
        setSelectedIds([hitId]);
        beginMove(new Set([hitId]));
        e.preventDefault(); return;
      }

      const editing = groupEditId && page.objects[groupEditId] ? groupEditId : null;

      // ── Inside a frame the user has entered ──────────────────────────────────
      if (editing) {
        const frame = page.objects[editing]!;
        if (!pointInShape(frame, doc.x, doc.y)) {
          // Clicked outside the entered frame → exit it and select the frame (draggable).
          setGroupEditId(null);
          setSelectedIds([editing]);
          beginMove(new Set([editing]));
          e.preventDefault(); return;
        }
        // Inside the frame: a hit on a real descendant selects that child; empty space marquees.
        const isChild = !!hitId && hitId !== editing && ancestorChain(page, hitId).includes(editing);
        if (isChild) {
          selectAndDrag(resolveSelectionTarget(page, hitId, editing));
          e.preventDefault(); return;
        }
        if (!shift) clearSelection();
        dragRef.current = { mode: 'marquee', startScreenX: sx, startScreenY: sy, currentScreenX: sx, currentScreenY: sy, frameId: editing };
        e.preventDefault(); return;
      }

      // ── Not inside any frame ─────────────────────────────────────────────────
      if (!hitId) {
        if (!shift) clearSelection();
        dragRef.current = { mode: 'marquee', startScreenX: sx, startScreenY: sy, currentScreenX: sx, currentScreenY: sy };
        e.preventDefault(); return;
      }

      // Container-first: a click resolves to the outermost frame/group container (or the
      // shape itself when it has no container ancestor). Select it and allow dragging it —
      // from its label OR anywhere on its body. To marquee-select children or grab a child
      // directly, double-click to enter the container first (handled by the editing branch).
      const target = resolveSelectionTarget(page, hitId, null);
      selectAndDrag(target);
      e.preventDefault(); return;
    }

    // No page — fall back to a plain marquee.
    if (!shift) clearSelection();
    dragRef.current = { mode: 'marquee', startScreenX: sx, startScreenY: sy, currentScreenX: sx, currentScreenY: sy };
  }, [activePage, activeTool, selectedIds, toggleSelected, clearSelection, setSelectedIds, penSegments, setPenSegments, setPenContinueShapeId, setPenContinueIsFirst, setActiveTool, setEditingTextId, finishPenPath, createTextAt, editingTextId, groupEditId, setGroupEditId, vectorEditShapeId, setVectorEditShapeId, setVectorEditChildId, svgEditShapeId, setSvgEditShapeId, setLivePreviewSvg, setFile]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const { sx, sy } = getScreenPoint(e);
    const drag = dragRef.current;
    const vp = vpRef.current;
    const doc = screenToDoc(sx, sy, vp);
    const page = activePage();

    // Update pen cursor position
    if (activeTool === 'pen') { setPenCurrentDoc({ x: doc.x, y: doc.y }); }

    switch (drag.mode) {
      case 'pan':
        setViewport(v => clampVp({ ...v, x: v.x + (sx - drag.lastScreenX), y: v.y + (sy - drag.lastScreenY) }));
        dragRef.current = { ...drag, lastScreenX: sx, lastScreenY: sy };
        break;
      case 'move': {
        const dx = doc.x - drag.startDocX; const dy = doc.y - drag.startDocY;
        const noSnap = e.metaKey || e.ctrlKey;
        const next = new Map<string, ShapePreview>();
        let snapDx = 0, snapDy = 0;

        if (!noSnap && page) {
          const movedIds = new Set(Object.keys(drag.originals));
          const targets = getSnapTargets(page, movedIds);
          // guides handled separately with their own thresholds below
          const [firstId, firstOrig] = Object.entries(drag.originals)[0] ?? [];
          const refShape = firstId ? page.objects[firstId] : null;
          const newLines: { axis: 'x' | 'y'; pos: number }[] = [];
          if (refShape && firstOrig) {
            const engageDoc = SNAP_ENGAGE_PX / vp.zoom;
            const releaseDoc = SNAP_RELEASE_PX / vp.zoom;
            const GUIDE_ENGAGE_PX = 6; const GUIDE_RELEASE_PX = 6;
            const guideEngageDoc = GUIDE_ENGAGE_PX / vp.zoom;
            const guideReleaseDoc = GUIDE_RELEASE_PX / vp.zoom;
            const px = firstOrig.x + dx; const py = firstOrig.y + dy;
            const edgesX = [px, px + refShape.width, px + refShape.width / 2];
            const edgesY = [py, py + refShape.height, py + refShape.height / 2];
            const snapState = snapStateRef.current;
            const guideSnap = guideSnapRef.current;

            // ── Guide snap (per-guide hysteresis, 6/14px, locked edge offset) ──
            let guideSnapXActive = false, guideSnapYActive = false;
            if (snapToGuidesRef.current) {
              const pageGuides = guidesPerPageRef.current[page.id] ?? [];
              // X axis (vertical guides) — edgeOffset = locked edge pos relative to px
              if (guideSnap.x !== null) {
                const snappedEdge = px + guideSnap.x.edgeOffset;
                const dist = Math.abs(snappedEdge - guideSnap.x.pos);
                if (dist <= guideReleaseDoc) {
                  snapDx = guideSnap.x.pos - snappedEdge;
                  newLines.push({ axis: 'x', pos: guideSnap.x.pos });
                  guideSnapXActive = true;
                } else { guideSnap.x = null; }
              }
              if (!guideSnapXActive) {
                let bestDist = guideEngageDoc;
                let best: { id: string; pos: number; edgeOffset: number; snapDx: number } | null = null;
                for (const g of pageGuides) {
                  if (g.type !== 'vertical') continue;
                  for (const edge of edgesX) {
                    const dist = Math.abs(edge - g.position);
                    if (dist < bestDist) { bestDist = dist; best = { id: g.id, pos: g.position, edgeOffset: edge - px, snapDx: g.position - edge }; }
                  }
                }
                if (best) { guideSnap.x = { id: best.id, pos: best.pos, edgeOffset: best.edgeOffset }; snapDx = best.snapDx; newLines.push({ axis: 'x', pos: best.pos }); guideSnapXActive = true; }
              }
              // Y axis (horizontal guides) — edgeOffset = locked edge pos relative to py
              if (guideSnap.y !== null) {
                const snappedEdge = py + guideSnap.y.edgeOffset;
                const dist = Math.abs(snappedEdge - guideSnap.y.pos);
                if (dist <= guideReleaseDoc) {
                  snapDy = guideSnap.y.pos - snappedEdge;
                  newLines.push({ axis: 'y', pos: guideSnap.y.pos });
                  guideSnapYActive = true;
                } else { guideSnap.y = null; }
              }
              if (!guideSnapYActive) {
                let bestDist = guideEngageDoc;
                let best: { id: string; pos: number; edgeOffset: number; snapDy: number } | null = null;
                for (const g of pageGuides) {
                  if (g.type !== 'horizontal') continue;
                  for (const edge of edgesY) {
                    const dist = Math.abs(edge - g.position);
                    if (dist < bestDist) { bestDist = dist; best = { id: g.id, pos: g.position, edgeOffset: edge - py, snapDy: g.position - edge }; }
                  }
                }
                if (best) { guideSnap.y = { id: best.id, pos: best.pos, edgeOffset: best.edgeOffset }; snapDy = best.snapDy; newLines.push({ axis: 'y', pos: best.pos }); guideSnapYActive = true; }
              }
            }

            // ── Object-edge snap (existing hysteresis) — skip axes already guide-snapped ──
            let snapX: { offset: number; snapPos: number } | null = null;
            if (!guideSnapXActive) {
              if (snapState.x !== null) {
                const minDistX = Math.min(...edgesX.map(ex => Math.abs(ex - snapState.x!)));
                if (minDistX <= releaseDoc) {
                  const nearestX = edgesX.reduce((a, b) => Math.abs(a - snapState.x!) <= Math.abs(b - snapState.x!) ? a : b);
                  snapX = { offset: snapState.x - nearestX, snapPos: snapState.x };
                } else {
                  snapState.x = null;
                  snapX = findBestSnap(edgesX, targets.x, engageDoc);
                  if (snapX) snapState.x = snapX.snapPos;
                }
              } else {
                snapX = findBestSnap(edgesX, targets.x, engageDoc);
                if (snapX) snapState.x = snapX.snapPos;
              }
            } else { snapState.x = null; }

            let snapY: { offset: number; snapPos: number } | null = null;
            if (!guideSnapYActive) {
              if (snapState.y !== null) {
                const minDistY = Math.min(...edgesY.map(ey => Math.abs(ey - snapState.y!)));
                if (minDistY <= releaseDoc) {
                  const nearestY = edgesY.reduce((a, b) => Math.abs(a - snapState.y!) <= Math.abs(b - snapState.y!) ? a : b);
                  snapY = { offset: snapState.y - nearestY, snapPos: snapState.y };
                } else {
                  snapState.y = null;
                  snapY = findBestSnap(edgesY, targets.y, engageDoc);
                  if (snapY) snapState.y = snapY.snapPos;
                }
              } else {
                snapY = findBestSnap(edgesY, targets.y, engageDoc);
                if (snapY) snapState.y = snapY.snapPos;
              }
            } else { snapState.y = null; }

            if (snapX) { snapDx = snapX.offset; newLines.push({ axis: 'x', pos: snapX.snapPos }); }
            if (snapY) { snapDy = snapY.offset; newLines.push({ axis: 'y', pos: snapY.snapPos }); }
          }
          snapLinesRef.current = newLines;
          snapOffsetRef.current = (snapDx !== 0 || snapDy !== 0) ? { dx: snapDx, dy: snapDy } : null;
        } else {
          snapLinesRef.current = [];
          snapStateRef.current = { x: null, y: null };
          guideSnapRef.current = { x: null, y: null };
          snapOffsetRef.current = null;
        }

        for (const [id, orig] of Object.entries(drag.originals)) {
          next.set(id, { x: orig.x + dx + snapDx, y: orig.y + dy + snapDy });
        }
        previewRef.current = next;

        // Tooltip: current X, Y of primary shape
        if (tooltipRef.current) {
          const [firstId, firstOrig] = Object.entries(drag.originals)[0] ?? [];
          if (firstId && firstOrig) {
            const pos = next.get(firstId);
            const tx = pos?.x ?? firstOrig.x; const ty = pos?.y ?? firstOrig.y;
            tooltipRef.current.textContent = `${Math.round(tx)}, ${Math.round(ty)}`;
            tooltipRef.current.style.left = `${tx * vp.zoom + vp.x}px`;
            tooltipRef.current.style.top = `${ty * vp.zoom + vp.y - 28}px`;
            tooltipRef.current.style.display = 'block';
          }
        }
        break;
      }
      case 'resize': {
        const dx = doc.x - drag.startDocX; const dy = doc.y - drag.startDocY;
        const lock = drag.original.aspectRatioLocked || e.shiftKey;
        let nb = applyResizeDelta(drag.original, drag.handleIndex, dx, dy, lock);

        const noSnapResize = e.metaKey || e.ctrlKey;
        if (!noSnapResize && page) {
          const shape = page.objects[drag.shapeId];
          const pf = shape?.parentId ? page.objects[shape.parentId] : null;
          if (pf && pf.type === 'frame') {
            const engageDoc = SNAP_ENGAGE_PX / vp.zoom;
            const tX = [pf.x, pf.x + pf.width, pf.x + pf.width / 2].map(Math.round);
            const tY = [pf.y, pf.y + pf.height, pf.y + pf.height / 2].map(Math.round);
            for (const sid of (pf.childIds ?? [])) {
              if (sid === drag.shapeId) continue;
              const s = page.objects[sid]; if (!s) continue;
              tX.push(Math.round(s.x), Math.round(s.x + s.width), Math.round(s.x + s.width / 2));
              tY.push(Math.round(s.y), Math.round(s.y + s.height), Math.round(s.y + s.height / 2));
            }
            const hi = drag.handleIndex;
            const movesLeft  = hi === 0 || hi === 6 || hi === 7;
            const movesRight = hi === 2 || hi === 3 || hi === 4;
            const movesTop   = hi === 0 || hi === 1 || hi === 2;
            const movesBot   = hi === 4 || hi === 5 || hi === 6;
            const newLines: { axis: 'x' | 'y'; pos: number }[] = [];
            if (movesLeft) {
              const sx = findBestSnap([nb.x], tX, engageDoc);
              if (sx) { nb = { ...nb, x: sx.snapPos, width: Math.max(1, Math.round(nb.width - (sx.snapPos - nb.x))) }; newLines.push({ axis: 'x', pos: sx.snapPos }); }
            } else if (movesRight) {
              const sx = findBestSnap([nb.x + nb.width], tX, engageDoc);
              if (sx) { nb = { ...nb, width: Math.max(1, Math.round(sx.snapPos - nb.x)) }; newLines.push({ axis: 'x', pos: sx.snapPos }); }
            }
            if (movesTop) {
              const sy = findBestSnap([nb.y], tY, engageDoc);
              if (sy) { nb = { ...nb, y: sy.snapPos, height: Math.max(1, Math.round(nb.height - (sy.snapPos - nb.y))) }; newLines.push({ axis: 'y', pos: sy.snapPos }); }
            } else if (movesBot) {
              const sy = findBestSnap([nb.y + nb.height], tY, engageDoc);
              if (sy) { nb = { ...nb, height: Math.max(1, Math.round(sy.snapPos - nb.y)) }; newLines.push({ axis: 'y', pos: sy.snapPos }); }
            }
            snapLinesRef.current = newLines;
          } else { snapLinesRef.current = []; }
          resizeSnapRef.current = { x: nb.x, y: nb.y, width: nb.width, height: nb.height };
        } else {
          snapLinesRef.current = [];
          resizeSnapRef.current = null;
        }

        previewRef.current = new Map([[drag.shapeId, nb]]);

        // Tooltip: W × H
        if (tooltipRef.current) {
          const cx = (nb.x + nb.width / 2) * vp.zoom + vp.x;
          const by = (nb.y + nb.height) * vp.zoom + vp.y;
          tooltipRef.current.textContent = `${Math.round(nb.width)} × ${Math.round(nb.height)}`;
          tooltipRef.current.style.left = `${cx}px`;
          tooltipRef.current.style.top = `${by + 8}px`;
          tooltipRef.current.style.display = 'block';
        }
        break;
      }
      case 'rotate': {
        const r = applyRotateDelta(drag.original, drag.cx, drag.cy, drag.startDocX, drag.startDocY, doc.x, doc.y);
        previewRef.current = new Map([[drag.shapeId, { rotation: r }]]);
        break;
      }
      case 'marquee':
        dragRef.current = { ...drag, currentScreenX: sx, currentScreenY: sy };
        break;
      case 'create': {
        const noSnapCreate = e.metaKey || e.ctrlKey;
        let snapDocX = doc.x, snapDocY = doc.y;
        if (!noSnapCreate && page) {
          const frame = frameAtPoint(page, drag.startDocX, drag.startDocY);
          if (frame) {
            const engageDoc = SNAP_ENGAGE_PX / vp.zoom;
            const targetsX = [frame.x, frame.x + frame.width, frame.x + frame.width / 2].map(Math.round);
            const targetsY = [frame.y, frame.y + frame.height, frame.y + frame.height / 2].map(Math.round);
            for (const sibId of (frame.childIds ?? [])) {
              const sib = page.objects[sibId];
              if (!sib) continue;
              targetsX.push(Math.round(sib.x), Math.round(sib.x + sib.width), Math.round(sib.x + sib.width / 2));
              targetsY.push(Math.round(sib.y), Math.round(sib.y + sib.height), Math.round(sib.y + sib.height / 2));
            }
            const newLines: { axis: 'x' | 'y'; pos: number }[] = [];
            const bx = findBestSnap([doc.x], targetsX, engageDoc);
            const by = findBestSnap([doc.y], targetsY, engageDoc);
            if (bx) { snapDocX = bx.snapPos; newLines.push({ axis: 'x', pos: bx.snapPos }); }
            if (by) { snapDocY = by.snapPos; newLines.push({ axis: 'y', pos: by.snapPos }); }
            snapLinesRef.current = newLines;
          } else {
            snapLinesRef.current = [];
          }
        } else {
          snapLinesRef.current = [];
        }
        dragRef.current = { ...drag, currentDocX: snapDocX, currentDocY: snapDocY };
        break;
      }
      case 'text-create':
        dragRef.current = { ...drag, currentDocX: doc.x, currentDocY: doc.y };
        break;
      case 'al-reorder': {
        if (!page) break;
        const container = page.objects[drag.containerId];
        if (!container?.autoLayout) break;
        const { index } = alReorderSlot(container, drag.childId, page, doc.x, doc.y);
        dragRef.current = { ...drag, currentDocX: doc.x, currentDocY: doc.y, insertionIndex: index };
        break;
      }
      case 'none': {
        if (!page) break;
        // In SVG / vector edit mode keep cursor as default arrow
        if (svgEditShapeIdRef.current || vectorEditShapeIdRef.current) {
          setCursor('default');
          break;
        }
        const handleHit = getHandleAt(sx, sy, selectedIds, page, vp);
        if (handleHit) {
          const shape = page.objects[handleHit.shapeId];
          setCursor(handleCursor(handleHit.handleIndex, shape?.rotation ?? 0));
        } else if (activeTool === 'text') {
          setCursor('text');
        } else {
          const hitId = hitTestPoint(page, doc.x, doc.y);
          setCursor(activeTool === 'pen' ? PEN_CURSOR : 'default');
        }
        break;
      }
    }
  }, [activePage, selectedIds, activeTool, setPenCurrentDoc, clampVp]);

  const onMouseUp = useCallback(async (e: React.MouseEvent) => {
    const drag = dragRef.current;
    const page = activePage();
    previewRef.current = new Map();
    dragRef.current = { mode: 'none' };
    setIsDragging(false);
    snapLinesRef.current = [];
    snapStateRef.current = { x: null, y: null };
    guideSnapRef.current = { x: null, y: null };
    const committedSnapOffset = snapOffsetRef.current;
    snapOffsetRef.current = null;
    // resizeSnapRef captured inside 'resize' case before clearing
    if (tooltipRef.current) tooltipRef.current.style.display = 'none';
    setCursor(activeTool === 'text' ? 'text' : activeTool === 'pen' ? PEN_CURSOR : activeTool === 'select' ? 'default' : 'crosshair');

    if (!page) return;
    const { sx, sy } = getScreenPoint(e);
    const doc = screenToDoc(sx, sy, vpRef.current);

    switch (drag.mode) {
      case 'move': {
        const dx = doc.x - drag.startDocX; const dy = doc.y - drag.startDocY;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) break;
        const snapDxCommit = committedSnapOffset?.dx ?? 0;
        const snapDyCommit = committedSnapOffset?.dy ?? 0;
        const ops: Parameters<typeof api.applyChanges>[0]['ops'] = Object.entries(drag.originals).flatMap(([id, orig]) => [
          { op: 'set' as const, id, attr: 'x', val: Math.round(orig.x + dx + snapDxCommit) },
          { op: 'set' as const, id, attr: 'y', val: Math.round(orig.y + dy + snapDyCommit) },
        ]);

        // Figma-style re-parenting: each dragged root is re-homed into whatever frame it
        // lands over (by its new center), or the page root when dropped on empty canvas.
        // Suppressed when dragging children inside an isSVGImport group — those children
        // should stay locked to their parent.
        const gid = groupEditIdRef.current;
        const inSvgGroup = !!(gid && page.objects[gid]?.isSVGImport);
        if (!inSvgGroup) {
          const movedIds = new Set(Object.keys(drag.originals));
          const roots = topLevelSelection(page, [...movedIds]);
          for (const id of roots) {
            const s = page.objects[id];
            if (!s) continue;
            const cx = s.x + dx + snapDxCommit + s.width / 2;
            const cy = s.y + dy + snapDyCommit + s.height / 2;
            const target = frameUnderPoint(page, cx, cy, movedIds);
            const targetParentId = target ? target.id : null;
            if (targetParentId !== (s.parentId ?? null)) {
              if (target?.autoLayout) {
                // Dropping into an auto-layout container: insert at the cursor's slot
                // (not the end) and lock the incoming child to fixed sizing so the
                // container doesn't squeeze it. Mirrors Shift+A child handling.
                const { index } = alReorderSlot(target, id, page, cx, cy);
                ops.push({ op: 'move', id, parentId: targetParentId, index });
                ops.push({ op: 'set', id, attr: 'widthMode', val: 'fixed' });
                ops.push({ op: 'set', id, attr: 'heightMode', val: 'fixed' });
              } else {
                const siblings = targetParentId ? (page.objects[targetParentId]?.childIds ?? []) : page.childIds;
                ops.push({ op: 'move', id, parentId: targetParentId, index: siblings.length });
              }
            }
          }
        }

        const res = await api.applyChanges({ pageId: page.id, ops });
        if (res.ok && res.data) setFile(res.data);
        break;
      }
      case 'resize': {
        const committedResize = resizeSnapRef.current;
        resizeSnapRef.current = null;
        let nb: { x: number; y: number; width: number; height: number };
        if (committedResize) {
          nb = committedResize;
        } else {
          const dx = doc.x - drag.startDocX; const dy = doc.y - drag.startDocY;
          const lock = drag.original.aspectRatioLocked || e.shiftKey;
          nb = applyResizeDelta(drag.original, drag.handleIndex, dx, dy, lock);
        }
        const ops: Parameters<typeof api.applyChanges>[0]['ops'] =
          (['x', 'y', 'width', 'height'] as const).map(attr => ({ op: 'set' as const, id: drag.shapeId, attr, val: Math.round(nb[attr]) }));

        // Container resize cascades to descendants: when the frame/group origin shifts
        // (e.g. dragging the top/left handles), every descendant translates by the same
        // delta so it keeps its position relative to the container. Auto-layout containers
        // are skipped — the layout engine repositions their children on reflow.
        {
          const rs = page.objects[drag.shapeId];
          if (rs && rs.childIds.length > 0 && !rs.autoLayout) {
            const odx = Math.round(nb.x) - drag.original.x;
            const ody = Math.round(nb.y) - drag.original.y;
            if (odx !== 0 || ody !== 0) {
              for (const id of withDescendants(page, [drag.shapeId])) {
                if (id === drag.shapeId) continue;
                const c = page.objects[id];
                if (!c) continue;
                ops.push({ op: 'set', id, attr: 'x', val: Math.round(c.x + odx) });
                ops.push({ op: 'set', id, attr: 'y', val: Math.round(c.y + ody) });
              }
            }
          }
        }

        // Text: resizing the WIDTH switches it to fixed-width and the text wraps
        // (Figma behaviour). Height then auto-grows to fit the wrapped lines instead of
        // overflowing the box. Vertical-only handles (TC=1, BC=5) don't change width.
        if (drag.original.type === 'text') {
          const widthChanged = ![1, 5].includes(drag.handleIndex);
          if (widthChanged) {
            const newWidth = Math.round(nb.width);
            const fitted = fitTextSize({ ...drag.original, width: newWidth, textAutoWidth: false });
            ops.push({ op: 'set', id: drag.shapeId, attr: 'textAutoWidth', val: false });
            ops.push({ op: 'set', id: drag.shapeId, attr: 'height', val: fitted.height });
          }
        }

        // Auto-layout: dragging a resize handle pins that axis to a fixed size (Figma).
        // Without this, the reflow snaps a hug container back / reverts a fill|hug child.
        {
          const rs = page.objects[drag.shapeId];
          const parent = rs?.parentId ? page.objects[rs.parentId] : null;
          if (rs?.autoLayout || parent?.autoLayout) {
            const widthChanged = ![1, 5].includes(drag.handleIndex);
            const heightChanged = ![3, 7].includes(drag.handleIndex);
            if (widthChanged) ops.push({ op: 'set', id: drag.shapeId, attr: 'widthMode', val: 'fixed' });
            if (heightChanged) ops.push({ op: 'set', id: drag.shapeId, attr: 'heightMode', val: 'fixed' });
          }
        }

        const res = await api.applyChanges({ pageId: page.id, ops });
        if (res.ok && res.data) setFile(res.data);
        break;
      }
      case 'rotate': {
        const r = applyRotateDelta(drag.original, drag.cx, drag.cy, drag.startDocX, drag.startDocY, doc.x, doc.y);
        const ops: Parameters<typeof api.applyChanges>[0]['ops'] =
          [{ op: 'set', id: drag.shapeId, attr: 'rotation', val: Math.round(r) }];

        // Container rotation cascades to descendants: each child rotates about the
        // container's center (the pivot) and gains the same delta to its own rotation, so
        // the whole subtree turns as one rigid body — matching Figma frame/group rotation.
        const rs = page.objects[drag.shapeId];
        if (rs && rs.childIds.length > 0) {
          const deltaDeg = Math.round(r) - drag.original.rotation;
          if (deltaDeg !== 0) {
            const rad = (deltaDeg * Math.PI) / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            for (const id of withDescendants(page, [drag.shapeId])) {
              if (id === drag.shapeId) continue;
              const c = page.objects[id];
              if (!c) continue;
              const ccx = c.x + c.width / 2, ccy = c.y + c.height / 2;
              const nx = drag.cx + (ccx - drag.cx) * cos - (ccy - drag.cy) * sin;
              const ny = drag.cy + (ccx - drag.cx) * sin + (ccy - drag.cy) * cos;
              ops.push({ op: 'set', id, attr: 'x', val: Math.round(nx - c.width / 2) });
              ops.push({ op: 'set', id, attr: 'y', val: Math.round(ny - c.height / 2) });
              ops.push({ op: 'set', id, attr: 'rotation', val: Math.round((c.rotation + deltaDeg) % 360) });
            }
          }
        }

        const res = await api.applyChanges({ pageId: page.id, ops });
        if (res.ok && res.data) setFile(res.data);
        break;
      }
      case 'marquee': {
        const ms = normalizeRect(drag.startScreenX, drag.startScreenY, drag.currentScreenX, drag.currentScreenY);
        const vp = vpRef.current;
        const dm = { x: (ms.x - vp.x) / vp.zoom, y: (ms.y - vp.y) / vp.zoom, width: ms.width / vp.zoom, height: ms.height / vp.zoom };
        const moved = dm.width > 4 || dm.height > 4;
        if (moved) {
          // Candidates: direct children of the frame the marquee began in, else top-level nodes.
          const candidates = drag.frameId
            ? (page.objects[drag.frameId]?.childIds ?? [])
            : page.childIds;
          setSelectedIds(hitTestMarquee(page, dm, candidates));
        } else if (drag.clickSelectId) {
          // It was a click (no drag) on a frame body → select the frame.
          setSelectedIds([drag.clickSelectId]);
        }
        break;
      }
      case 'text-create': {
        const dx = Math.abs(drag.currentDocX - drag.startDocX);
        if (dx >= 4) {
          // Drag → fixed-width text box
          const x = Math.round(Math.min(drag.startDocX, drag.currentDocX));
          const y = Math.round(drag.startDocY);
          await createTextAt(x, y, Math.round(dx));
        } else {
          // Click → auto-width text
          await createTextAt(drag.startDocX, drag.startDocY);
        }
        break;
      }
      case 'al-reorder': {
        if (drag.insertionIndex === drag.originalIndex) break;
        const res = await api.applyChanges({
          pageId: page.id,
          ops: [{ op: 'move', id: drag.childId, parentId: drag.containerId, index: drag.insertionIndex }],
        });
        if (res.ok && res.data) setFile(res.data);
        break;
      }
      case 'create': {
        const x = Math.round(Math.min(drag.startDocX, drag.currentDocX));
        const y = Math.round(Math.min(drag.startDocY, drag.currentDocY));
        const w = Math.round(Math.abs(drag.currentDocX - drag.startDocX));
        const h = Math.round(Math.abs(drag.currentDocY - drag.startDocY));
        if (w < 4 || h < 4) break; // too small, ignore

        const type = drag.tool === 'frame' ? 'frame' : drag.tool === 'ellipse' ? 'circle' : 'rect';
        const newId = genId();
        const placement = placementForPoint(page, x, y, type);
        const shape = makeDefaultShape({
          id: newId,
          type,
          name: drag.tool === 'frame' ? 'Frame' : drag.tool === 'ellipse' ? 'Ellipse' : 'Rectangle',
          frameId: type === 'frame' ? newId : placement.frameId,
          parentId: placement.parentId,
          x, y, width: w, height: h,
          fills: drag.tool === 'frame'
            ? [{ type: 'solid', color: '#FFFFFF', opacity: 1 }]
            : [{ type: 'solid', color: '#5C7CFA', opacity: 1 }],
          clipContent: drag.tool === 'frame',
          selrect: { x, y, width: w, height: h },
        });
        const res = await api.applyChanges({ pageId: page.id, ops: [{ op: 'add', shape }] });
        if (res.ok && res.data) {
          setFile(res.data);
          // Frames deselect on creation (Figma behavior); rects/ellipses stay selected.
          if (drag.tool !== 'frame') setSelectedIds([newId]);
        }
        setActiveTool('select');
        break;
      }
    }
  }, [activePage, setFile, setSelectedIds, activeTool, setActiveTool, createTextAt]);

  // ── Double-click → drill one level into groups, or edit text at the leaf ───
  // Figma model: double-clicking a group enters it and selects the direct child under
  // the cursor; double-clicking again drills into nested groups; double-clicking a text
  // leaf opens it for editing.
  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    const { sx, sy } = getScreenPoint(e);
    const doc = screenToDoc(sx, sy, vpRef.current);
    const page = activePage();
    if (!page) return;
    const hitId = hitTestPoint(page, doc.x, doc.y);
    if (!hitId) return;

    const chain = ancestorChain(page, hitId); // [hit, parent, ..., root]
    // The thing currently selectable at this level: the direct child of the entered
    // group on the path, or (at the top) the outermost group / the shape itself.
    const insideEdit = !!(groupEditId && page.objects[groupEditId] && chain.includes(groupEditId));
    // Not yet inside a container → enter the outermost group/asset under the cursor;
    // already inside one → drill one more level (the direct child on the path).
    const selectable = insideEdit
      ? (chain[chain.indexOf(groupEditId!) - 1] ?? hitId)
      : (outermostGroup(page, hitId) ?? hitId);

    const s = page.objects[selectable];
    if (s?.type === 'vector') {
      if (s.svgContent || s.svgInnerHTML) {
        // SvgEditOverlay is self-contained — just activate it.
        setSelectedIds([selectable]);
        setSvgEditShapeId(selectable);
        return;
      }
      setSelectedIds([selectable]);
      setVectorEditShapeId(selectable);
      setVectorEditChildId(null);
      return;
    }
    if (s?.type === 'svg' && s.svgContent) {
      setSelectedIds([selectable]);
      setSvgEditShapeId(selectable);
      return;
    }
    if (s?.type === 'path') {
      const pts = segmentsToPoints(s.content ?? []);
      setSelectedIds([selectable]);
      setPathEditShapeId(selectable);
      setEditingPoints(pts);
      setSelectedPointIndices([]);
      return;
    }
    if (s?.type === 'group' || s?.type === 'frame') {
      // Enter this frame/group; select the direct child on the path (the thing under the cursor).
      setGroupEditId(selectable);
      const next = chain[chain.indexOf(selectable) - 1] ?? hitId;
      setSelectedIds(next === selectable ? [] : [next]);
    } else if (s?.type === 'text') {
      setSelectedIds([selectable]);
      setEditingTextId(selectable);
    } else {
      setSelectedIds([selectable]);
    }
  }, [activePage, setSelectedIds, setEditingTextId, groupEditId, setGroupEditId, setVectorEditShapeId, setVectorEditChildId, setPathEditShapeId, setEditingPoints, setSelectedPointIndices, setSvgEditShapeId]);

  // ── Right-click context menu ──────────────────────────────────────────────
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const { sx, sy } = getScreenPoint(e);
    const doc = screenToDoc(sx, sy, vpRef.current);
    const page = activePage();
    if (!page) return;
    const hitId = hitTestPoint(page, doc.x, doc.y);
    if (hitId) {
      const target = resolveSelectionTarget(page, hitId, groupEditId);
      if (!selectedIds.has(target)) setSelectedIds([target]);
    }
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, [activePage, groupEditId, selectedIds, setSelectedIds]);

  // ── Commit path anchor-point edits back to the document ──────────────────
  const commitPathPoints = useCallback(async (pts: AnchorPoint[]) => {
    if (!pathEditShapeId) return;
    const page = activePage();
    const shape = page?.objects[pathEditShapeId];
    if (!page || !shape) return;

    // Compute tight bounds in local (shape-relative) space
    const validPts = pts.filter(p => p.command !== 'Z');
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of validPts) {
      minX = Math.min(minX, p.x, p.cp1x ?? p.x, p.cp2x ?? p.x);
      minY = Math.min(minY, p.y, p.cp1y ?? p.y, p.cp2y ?? p.y);
      maxX = Math.max(maxX, p.x, p.cp1x ?? p.x, p.cp2x ?? p.x);
      maxY = Math.max(maxY, p.y, p.cp1y ?? p.y, p.cp2y ?? p.y);
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = shape.width; maxY = shape.height; }

    // Re-localize points so (0,0) = new tight top-left
    const shift = (v: number | undefined, base: number) => v !== undefined ? v - base : undefined;
    const relocated = pts.map(p => ({
      ...p,
      x: p.x - minX, y: p.y - minY,
      cp1x: shift(p.cp1x, minX), cp1y: shift(p.cp1y, minY),
      cp2x: shift(p.cp2x, minX), cp2y: shift(p.cp2y, minY),
    }));

    const newContent = pointsToSegments(relocated);
    const newX = Math.round(shape.x + minX);
    const newY = Math.round(shape.y + minY);
    const newW = Math.max(1, Math.round(maxX - minX));
    const newH = Math.max(1, Math.round(maxY - minY));

    const ops: Parameters<typeof api.applyChanges>[0]['ops'] = [
      { op: 'set', id: pathEditShapeId, attr: 'content', val: newContent },
      { op: 'set', id: pathEditShapeId, attr: 'x', val: newX },
      { op: 'set', id: pathEditShapeId, attr: 'y', val: newY },
      { op: 'set', id: pathEditShapeId, attr: 'width', val: newW },
      { op: 'set', id: pathEditShapeId, attr: 'height', val: newH },
      { op: 'set', id: pathEditShapeId, attr: 'selrect', val: { x: newX, y: newY, width: newW, height: newH } },
    ];
    const res = await api.applyChanges({ pageId: page.id, ops });
    if (res.ok && res.data) {
      setFile(res.data);
      setEditingPoints(relocated);
    }
  }, [pathEditShapeId, activePage, setFile, setEditingPoints]);

  // ── Commit SVG path edits back to the document ───────────────────────────
  const commitSvgEdit = useCallback(async (newInnerHTML: string) => {
    if (!svgEditShapeId) return;
    const page = activePage();
    const shape = page?.objects[svgEditShapeId];
    if (!page || !shape) return;

    if (shape.svgContent) {
      // Rebuild full svgContent from the new inner HTML.
      const svgDoc = new DOMParser().parseFromString(shape.svgContent, 'image/svg+xml');
      svgDoc.documentElement.innerHTML = newInnerHTML;
      const newSvgContent = new XMLSerializer().serializeToString(svgDoc.documentElement);
      invalidateSvgCache(svgEditShapeId);
      const res = await api.applyChanges({ pageId: page.id, ops: [
        { op: 'set', id: svgEditShapeId, attr: 'svgContent', val: newSvgContent },
        { op: 'set', id: svgEditShapeId, attr: 'svgInnerHTML', val: newInnerHTML },
      ]});
      if (res.ok && res.data) setFile(res.data);
      return;
    }

    // svgInnerHTML-only shape (SVG import child).
    const res = await api.applyChanges({ pageId: page.id, ops: [
      { op: 'set', id: svgEditShapeId, attr: 'svgInnerHTML', val: newInnerHTML },
    ]});
    if (res.ok && res.data) setFile(res.data);
  }, [svgEditShapeId, activePage, setFile]);

  // ── Delete SVG shape (called from SvgEditOverlay when all paths removed) ──
  const deleteSvgShape = useCallback(async () => {
    const page = activePage();
    if (!page) return;
    const shapeId = svgEditShapeId;
    if (!shapeId) return;
    const shape = page.objects[shapeId];
    if (!shape) return;
    clearSelection(); // exit SVG edit mode before removing the node
    const parentId = (shape as Shape & { parentId?: string }).parentId;
    let deleteId = shapeId;
    if (parentId && page.objects[parentId]) {
      const hasSiblings = Object.values(page.objects).some(
        s => (s as Shape & { parentId?: string }).parentId === parentId && s.id !== shapeId,
      );
      if (!hasSiblings) deleteId = parentId;
    }
    const res = await api.applyChanges({ pageId: page.id, ops: [{ op: 'del', id: deleteId }] });
    if (res.ok && res.data) setFile(res.data);
  }, [svgEditShapeId, activePage, clearSelection, setFile]);

  // ── Editing text shape (for TextEditor overlay) ───────────────────────────
  const editingShape = editingTextId
    ? activePage()?.objects[editingTextId] ?? null
    : null;

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    const page = activePage();
    if (!page) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const doc = screenToDoc(e.clientX - rect.left, e.clientY - rect.top, vpRef.current);

    // 1) OS files dropped from Finder/Explorer → import any images at the drop point.
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) {
      const imgs = await importImageFiles(files);
      if (imgs.length > 0) {
        await placeImages(imgs, { x: doc.x, y: doc.y });
      } else {
        alert('No supported image files in the drop. Supported: PNG, JPG, GIF, WEBP, BMP, SVG, HEIC.');
      }
      return;
    }

    // 2) Internal component drag → create an instance at the drop point.
    const componentId = e.dataTransfer.getData('component-id');
    if (!componentId) return;
    const res = await api.createInstance(componentId, page.id, Math.round(doc.x), Math.round(doc.y));
    if (res.ok && res.data) {
      setFile(res.data);
      // Select the new instance (it's the last in childIds)
      const newPage = res.data.pages.find(p => p.id === page.id);
      if (newPage) {
        const newId = newPage.childIds[newPage.childIds.length - 1];
        if (newId) setSelectedIds([newId]);
      }
    }
  }, [activePage, setFile, setSelectedIds, placeImages]);

  return (
    <div ref={containerRef} style={styles.container}
      onDragOver={e => e.preventDefault()}
      onDrop={onDrop}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', cursor: editingTextId ? 'default' : cursor }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
      {showPixelGrid && viewport.zoom >= 4 && (() => {
        const cellSize = viewport.zoom;
        const offsetX = ((viewport.x % cellSize) + cellSize) % cellSize;
        const offsetY = ((viewport.y % cellSize) + cellSize) % cellSize;
        return (
          <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 10 }}>
            <defs>
              <pattern id="pixel-grid" width={cellSize} height={cellSize} patternUnits="userSpaceOnUse" x={offsetX} y={offsetY}>
                <path d={`M ${cellSize} 0 L 0 0 L 0 ${cellSize}`} fill="none" stroke="rgba(150,150,170,0.6)" strokeWidth={0.5} />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#pixel-grid)" />
          </svg>
        );
      })()}
      {!isDragging && <FrameLabels viewport={viewport} onDragChange={setIsLabelDragging} />}
      <Ruler viewport={viewport} />
      {rightMode === 'prototype' && <PrototypeOverlay viewport={viewport} />}
      {/* SVG selection handles — hidden during drag so they stay in sync with preview */}
      {!isDragging && !isLabelDragging && (() => {
        const page = activePage();
        if (!page || selectedIds.size === 0) return null;
        const { zoom, x: panX, y: panY } = viewport;
        const ACCENT = '#1a73e8';
        const elements: React.ReactNode[] = [];
        for (const shapeId of selectedIds) {
          if (shapeId === editingTextId) continue;
          if (shapeId === vectorEditShapeId || shapeId === svgEditShapeId || shapeId === pathEditShapeId) continue;
          const shape = page.objects[shapeId];
          if (!shape) continue;
          const L = shape.x * zoom + panX;
          const T = shape.y * zoom + panY;
          const R = (shape.x + shape.width) * zoom + panX;
          const B = (shape.y + shape.height) * zoom + panY;
          const MX = (L + R) / 2;
          const MY = (T + B) / 2;
          const handles = [
            { id: 'nw', x: L,  y: T,  cursor: 'nwse-resize', index: 0 },
            { id: 'n',  x: MX, y: T,  cursor: 'ns-resize',   index: 1 },
            { id: 'ne', x: R,  y: T,  cursor: 'nesw-resize', index: 2 },
            { id: 'e',  x: R,  y: MY, cursor: 'ew-resize',   index: 3 },
            { id: 'se', x: R,  y: B,  cursor: 'nwse-resize', index: 4 },
            { id: 's',  x: MX, y: B,  cursor: 'ns-resize',   index: 5 },
            { id: 'sw', x: L,  y: B,  cursor: 'nesw-resize', index: 6 },
            { id: 'w',  x: L,  y: MY, cursor: 'ew-resize',   index: 7 },
          ];
          elements.push(
            <rect key={`${shapeId}-box`} x={L} y={T} width={R - L} height={B - T}
              fill="none" stroke={ACCENT} strokeWidth={1} style={{ pointerEvents: 'none' }} />,
            <line key={`${shapeId}-rotline`} x1={MX} y1={T - 20} x2={MX} y2={T}
              stroke={ACCENT} strokeWidth={1} style={{ pointerEvents: 'none' }} />,
            ...handles.map(h => (
              <rect key={`${shapeId}-${h.id}`} x={h.x - 4} y={h.y - 4} width={8} height={8}
                fill="white" stroke={ACCENT} strokeWidth={1.5} rx={1}
                style={{ cursor: h.cursor, pointerEvents: 'all' }}
                onMouseDown={e => { startResizeHandle(shapeId, h.index, e); }} />
            )),
            <circle key={`${shapeId}-rotate`} cx={MX} cy={T - 20} r={5}
              fill="white" stroke={ACCENT} strokeWidth={1.5}
              style={{ cursor: 'grab', pointerEvents: 'all' }}
              onMouseDown={e => { startRotateHandle(shapeId, e); }} />,
          );
        }
        if (elements.length === 0) return null;
        return (
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 15, overflow: 'visible' }}>
            {elements}
          </svg>
        );
      })()}
      {editingShape && <TextEditor shape={editingShape} viewport={viewport} />}
      {activePage() && (
        <VectorOverlay
          page={activePage()!}
          viewport={viewport}
          vectorEditShapeId={vectorEditShapeId}
          vectorEditChildId={vectorEditChildId}
          svgEditShapeId={svgEditShapeId}
          livePreviewSvg={livePreviewSvg}
          onSelectChild={(shapeId, childId) => {
            setVectorEditShapeId(shapeId);
            setVectorEditChildId(childId);
          }}
        />
      )}
      {groupEditId && (() => {
        const gPage = activePage();
        const gShape = gPage?.objects[groupEditId];
        if (!gShape?.isSVGImport) return null;
        const gsx = gShape.x * viewport.zoom + viewport.x;
        const gsy = gShape.y * viewport.zoom + viewport.y;
        const gsw = gShape.width * viewport.zoom;
        const gsh = gShape.height * viewport.zoom;
        return (
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            <div style={{
              position: 'absolute',
              left: gsx, top: gsy, width: gsw, height: gsh,
              border: '2px dashed #1a73e8',
              boxSizing: 'border-box',
            }} />
          </div>
        );
      })()}
      {pathEditShapeId && (() => {
        const shape = activePage()?.objects[pathEditShapeId];
        if (!shape) return null;
        return (
          <VectorEditOverlay
            shapeId={pathEditShapeId}
            shapeX={shape.x}
            shapeY={shape.y}
            viewport={viewport}
            initialPoints={editingPoints}
            selectedIndices={selectedPointIndices}
            onSelectPoints={setSelectedPointIndices}
            onCommit={commitPathPoints}
          />
        );
      })()}
      {svgEditShapeId && (() => {
        const shape = activePage()?.objects[svgEditShapeId];
        if (!shape) return null;
        return (
          <SvgEditOverlay
            shape={shape}
            viewport={viewport}
            onCommit={commitSvgEdit}
            onDeleteShape={deleteSvgShape}
            onExit={() => { setLivePreviewSvg(null); setSvgEditShapeId(null); }}
          />
        );
      })()}
      <div ref={tooltipRef} style={styles.dragTooltip} />
      <ZoomIndicator zoom={viewport.zoom} />
      {ctxMenu && (
        <CanvasContextMenu
          x={ctxMenu.x} y={ctxMenu.y}
          hasSelection={selectedIds.size > 0}
          onClose={() => setCtxMenu(null)}
          onCopy={() => {
            const page = activePage();
            if (!page || selectedIds.size === 0) return;
            const roots = topLevelSelection(page, [...selectedIds]);
            const allIds = withDescendants(page, roots);
            const objects: Record<string, Shape> = {};
            for (const id of allIds) { if (page.objects[id]) objects[id] = page.objects[id]; }
            canvasClipboard = { rootIds: roots, objects };
          }}
          onCut={async () => {
            const page = activePage();
            if (!page || selectedIds.size === 0) return;
            const roots = topLevelSelection(page, [...selectedIds]);
            const allIds = withDescendants(page, roots);
            const objects: Record<string, Shape> = {};
            for (const id of allIds) { if (page.objects[id]) objects[id] = page.objects[id]; }
            canvasClipboard = { rootIds: roots, objects };
            const res = await api.applyChanges({ pageId: page.id, ops: roots.map(id => ({ op: 'del' as const, id })) });
            if (res.ok && res.data) { setFile(res.data); clearSelection(); }
          }}
          onPaste={async () => {
            const page = activePage();
            if (!page || !canvasClipboard) return;
            const cb = canvasClipboard;
            const idMap = new Map<string, string>();
            for (const id of Object.keys(cb.objects)) idMap.set(id, genId());
            const ops: Parameters<typeof api.applyChanges>[0]['ops'] = [];
            for (const [origId, shape] of Object.entries(cb.objects)) {
              ops.push({ op: 'add' as const, shape: {
                ...shape, id: idMap.get(origId)!, x: shape.x + 10, y: shape.y + 10,
                parentId: shape.parentId ? (idMap.get(shape.parentId) ?? null) : null,
                frameId: idMap.get(shape.frameId) ?? shape.frameId,
                childIds: shape.childIds.map(c => idMap.get(c) ?? c),
              }});
            }
            const res = await api.applyChanges({ pageId: page.id, ops });
            if (res.ok && res.data) { setFile(res.data); setSelectedIds(cb.rootIds.map(id => idMap.get(id)!)); }
          }}
          onDuplicate={async () => {
            const page = activePage();
            if (!page || selectedIds.size === 0) return;
            const roots = topLevelSelection(page, [...selectedIds]);
            const allOps: { op: 'add'; shape: Shape }[] = [];
            const rootCloneIds: string[] = [];
            for (const rootId of roots) {
              const { ops, newRootId } = deepCloneSubtree(page, rootId);
              const rootOp = ops.find(op => op.shape.id === newRootId);
              if (rootOp) { rootOp.shape.x += 10; rootOp.shape.y += 10; }
              allOps.push(...ops);
              rootCloneIds.push(newRootId);
            }
            const res = await api.applyChanges({ pageId: page.id, ops: allOps });
            if (res.ok && res.data) { setFile(res.data); setSelectedIds(rootCloneIds); }
          }}
          onGroup={async () => {
            const page = activePage();
            if (!page || selectedIds.size < 2) return;
            const shapes = [...selectedIds].map(id => page.objects[id]).filter(Boolean);
            const minX = Math.min(...shapes.map(s => s.selrect.x));
            const minY = Math.min(...shapes.map(s => s.selrect.y));
            const maxX = Math.max(...shapes.map(s => s.selrect.x + s.selrect.width));
            const maxY = Math.max(...shapes.map(s => s.selrect.y + s.selrect.height));
            const groupId = genId();
            const commonParent = shapes.every(s => s.parentId === shapes[0].parentId) ? shapes[0].parentId ?? null : null;
            const group = makeDefaultShape({ id: groupId, type: 'group', name: 'Group', frameId: shapes[0].frameId, parentId: commonParent, x: minX, y: minY, width: maxX - minX, height: maxY - minY, fills: [], strokes: [], selrect: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } });
            const res = await api.applyChanges({ pageId: page.id, ops: [{ op: 'add', shape: group }, ...[...selectedIds].map((id, i) => ({ op: 'move' as const, id, parentId: groupId, index: i }))] });
            if (res.ok && res.data) { setFile(res.data); setSelectedIds([groupId]); setGroupEditId(null); }
          }}
          onUngroup={async () => {
            const page = activePage();
            if (!page) return;
            const groups = [...selectedIds].map(id => page.objects[id]).filter(s => s?.type === 'group' || s?.type === 'frame');
            if (groups.length === 0) return;
            const newSel: string[] = [];
            const ops: Parameters<typeof api.applyChanges>[0]['ops'] = [];
            for (const group of groups) {
              const siblings = group.parentId ? (page.objects[group.parentId]?.childIds ?? []) : page.childIds;
              const gIdx = siblings.indexOf(group.id);
              group.childIds.forEach((childId, i) => { ops.push({ op: 'move', id: childId, parentId: group.parentId, index: gIdx + i }); newSel.push(childId); });
              ops.push({ op: 'del', id: group.id });
            }
            const res = await api.applyChanges({ pageId: page.id, ops });
            if (res.ok && res.data) { setFile(res.data); setSelectedIds(newSel); setGroupEditId(null); }
          }}
          onBringToFront={async () => {
            const page = activePage();
            if (!page || selectedIds.size === 0) return;
            const ops: Parameters<typeof api.applyChanges>[0]['ops'] = [];
            for (const id of selectedIds) {
              const s = page.objects[id]; if (!s) continue;
              const siblings = s.parentId ? (page.objects[s.parentId]?.childIds ?? []) : page.childIds;
              ops.push({ op: 'move', id, parentId: s.parentId ?? null, index: siblings.length - 1 });
            }
            const res = await api.applyChanges({ pageId: page.id, ops });
            if (res.ok && res.data) setFile(res.data);
          }}
          onBringForward={async () => {
            const page = activePage();
            if (!page || selectedIds.size === 0) return;
            const ops: Parameters<typeof api.applyChanges>[0]['ops'] = [];
            for (const id of selectedIds) {
              const s = page.objects[id]; if (!s) continue;
              const siblings = s.parentId ? (page.objects[s.parentId]?.childIds ?? []) : page.childIds;
              const idx = siblings.indexOf(id);
              if (idx < siblings.length - 1) ops.push({ op: 'move', id, parentId: s.parentId ?? null, index: idx + 1 });
            }
            const res = await api.applyChanges({ pageId: page.id, ops });
            if (res.ok && res.data) setFile(res.data);
          }}
          onSendBackward={async () => {
            const page = activePage();
            if (!page || selectedIds.size === 0) return;
            const ops: Parameters<typeof api.applyChanges>[0]['ops'] = [];
            for (const id of selectedIds) {
              const s = page.objects[id]; if (!s) continue;
              const siblings = s.parentId ? (page.objects[s.parentId]?.childIds ?? []) : page.childIds;
              const idx = siblings.indexOf(id);
              if (idx > 0) ops.push({ op: 'move', id, parentId: s.parentId ?? null, index: idx - 1 });
            }
            const res = await api.applyChanges({ pageId: page.id, ops });
            if (res.ok && res.data) setFile(res.data);
          }}
          onSendToBack={async () => {
            const page = activePage();
            if (!page || selectedIds.size === 0) return;
            const ops: Parameters<typeof api.applyChanges>[0]['ops'] = [];
            for (const id of selectedIds) {
              const s = page.objects[id]; if (!s) continue;
              ops.push({ op: 'move', id, parentId: s.parentId ?? null, index: 0 });
            }
            const res = await api.applyChanges({ pageId: page.id, ops });
            if (res.ok && res.data) setFile(res.data);
          }}
          onDelete={async () => {
            const page = activePage();
            if (!page || selectedIds.size === 0) return;
            const gid = groupEditIdRef.current;
            let ops: { op: 'del'; id: string }[];
            if (gid) {
              ops = [...selectedIds].filter(id => page.objects[id]?.parentId === gid).map(id => ({ op: 'del' as const, id }));
            } else {
              ops = topLevelSelection(page, [...selectedIds]).map(id => ({ op: 'del' as const, id }));
            }
            if (ops.length === 0) return;
            const res = await api.applyChanges({ pageId: page.id, ops });
            if (res.ok && res.data) { setFile(res.data); clearSelection(); }
          }}
        />
      )}
    </div>
  );
}

// ── CanvasContextMenu ─────────────────────────────────────────────────────────

interface CtxMenuProps {
  x: number; y: number; hasSelection: boolean; onClose: () => void;
  onCopy: () => void; onCut: () => void; onPaste: () => Promise<void>;
  onDuplicate: () => Promise<void>; onGroup: () => Promise<void>;
  onUngroup: () => Promise<void>; onBringToFront: () => Promise<void>;
  onBringForward: () => Promise<void>; onSendBackward: () => Promise<void>;
  onSendToBack: () => Promise<void>; onDelete: () => Promise<void>;
}

function CanvasContextMenu(props: CtxMenuProps) {
  const { x, y, hasSelection, onClose } = props;
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const W = 220;
  const left = Math.min(x, window.innerWidth - W - 8);
  const estH = 340;
  const top = y + estH > window.innerHeight - 8 ? Math.max(8, y - estH) : y;

  const item = (label: string, hint: string, action: () => void, disabled = false) => (
    <button
      key={label}
      style={{ ...ctxStyles.item, opacity: disabled ? 0.35 : 1, cursor: disabled ? 'default' : 'pointer' }}
      disabled={disabled}
      onMouseDown={e => { e.preventDefault(); if (!disabled) { action(); onClose(); } }}
    >
      <span style={ctxStyles.label}>{label}</span>
      <span style={ctxStyles.hint}>{hint}</span>
    </button>
  );

  const sep = () => <div style={ctxStyles.sep} />;

  return (
    <div ref={ref} style={{ ...ctxStyles.menu, left, top, width: W }}>
      {item('Copy',      '⌘C',        props.onCopy,        !hasSelection)}
      {item('Cut',       '⌘X',        props.onCut,         !hasSelection)}
      {item('Paste',     '⌘V',        () => void props.onPaste())}
      {item('Duplicate', '⌘D',        () => void props.onDuplicate(), !hasSelection)}
      {sep()}
      {item('Group',           '⌘G',    () => void props.onGroup(),        !hasSelection)}
      {item('Frame selection', '⌘⌥G',  () => void props.onGroup(),        !hasSelection)}
      {item('Ungroup',         '⌘⇧G',  () => void props.onUngroup(),       !hasSelection)}
      {sep()}
      {item('Bring to front',  '⌘⌥]',  () => void props.onBringToFront(),  !hasSelection)}
      {item('Bring forward',   '⌘]',   () => void props.onBringForward(),  !hasSelection)}
      {item('Send backward',   '⌘[',   () => void props.onSendBackward(),  !hasSelection)}
      {item('Send to back',    '⌘⌥[',  () => void props.onSendToBack(),    !hasSelection)}
      {sep()}
      {item('Delete', '⌫', () => void props.onDelete(), !hasSelection)}
    </div>
  );
}

const ctxStyles: Record<string, React.CSSProperties> = {
  menu: {
    position: 'fixed', zIndex: 9999,
    background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8, padding: '4px 0',
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    display: 'flex', flexDirection: 'column',
  },
  item: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    background: 'transparent', border: 'none', color: '#ececef',
    fontSize: 12, padding: '7px 12px', fontFamily: 'system-ui',
    textAlign: 'left', gap: 16,
  },
  label: { flex: 1 },
  hint: { color: 'rgba(255,255,255,0.38)', fontSize: 11, flexShrink: 0 },
  sep: { height: 1, background: 'rgba(255,255,255,0.1)', margin: '3px 0' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeRect(x1: number, y1: number, x2: number, y2: number) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

function anchorPoint(seg: PathSegment): { x: number; y: number } | null {
  if (seg.verb === 'M' || seg.verb === 'L') return { x: seg.coords[0], y: seg.coords[1] };
  if (seg.verb === 'C') return { x: seg.coords[4], y: seg.coords[5] };
  return null;
}

function coordPairs(seg: PathSegment): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < seg.coords.length; i += 2) out.push([seg.coords[i], seg.coords[i + 1]]);
  return out;
}

function ZoomIndicator({ zoom }: { zoom: number }) {
  return <div style={styles.zoomBadge}>{Math.round(zoom * 100)}%</div>;
}

const TOOL_HINTS: Partial<Record<ToolType, string>> = {
  select: 'Click · Drag to move · Handle to resize/rotate · 0 = fit',
  rect: 'Drag to draw rectangle · Esc = cancel',
  ellipse: 'Drag to draw ellipse · Esc = cancel',
  frame: 'Drag to draw frame · Esc = cancel',
  text: 'Click to place text · Double-click existing to edit',
  pen: 'Click to add points · Enter to finish · Esc to cancel',
  image: 'Choose an image file…',
};

function ToolHint({ activeTool, penActive }: { activeTool: ToolType; penActive: boolean }) {
  const hint = penActive && activeTool === 'pen'
    ? 'Click to add points · Enter to finish · Esc to cancel'
    : TOOL_HINTS[activeTool] ?? '';
  return <div style={styles.helpHint}>{hint}</div>;
}

const styles: Record<string, React.CSSProperties> = {
  container: { flex: 1, overflow: 'hidden', position: 'relative', background: '#0f0f12' },
  dragTooltip: {
    display: 'none', position: 'absolute', pointerEvents: 'none', zIndex: 9999,
    background: '#1a73e8', color: '#fff', padding: '2px 7px', borderRadius: 4,
    fontSize: 11, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
    transform: 'translateX(-50%)', fontFamily: 'system-ui',
  },
  zoomBadge: {
    position: 'absolute', bottom: 16, right: 16,
    background: 'rgba(20,20,23,0.9)', color: '#ECECEF',
    padding: '4px 10px', borderRadius: 6, fontSize: 12, fontFamily: 'system-ui',
    pointerEvents: 'none', border: '1px solid rgba(255,255,255,0.08)',
  },
  helpHint: {
    position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
    background: 'rgba(20,20,23,0.8)', color: '#9B9BA6',
    padding: '4px 12px', borderRadius: 6, fontSize: 11, fontFamily: 'system-ui',
    pointerEvents: 'none', whiteSpace: 'nowrap',
  },
};
