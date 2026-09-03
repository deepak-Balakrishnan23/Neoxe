import type { ChangeOp, Page, Shape, AutoLayoutSettings } from './types';
import { makeDefaultShape } from './types';

// Figma's Shift+A: detect direction from the spatial spread of the selection,
// detect spacing from the average gaps, and wrap the selection in a new auto-layout
// frame. Returns the change-ops to apply + the new frame's id (so the caller can
// select it). Returns null if the selection isn't auto-layoutable.

export interface CreateAutoLayoutPlan {
  ops: ChangeOp[];
  containerId: string;
}

export function createAutoLayoutFromSelection(
  page: Page,
  selectedIds: string[],
  genId: () => string,
): CreateAutoLayoutPlan | null {
  if (selectedIds.length < 1) return null;

  // Resolve to top-level shapes (drop descendants of other selected shapes) and require
  // a common parent. Figma also requires same parent — if they're not, return null and
  // the caller can fall back to grouping first.
  const tops = topLevelSelection(page, selectedIds);
  if (tops.length === 0) return null;
  const parentId = page.objects[tops[0]].parentId;
  if (!tops.every(id => page.objects[id].parentId === parentId)) return null;

  // Preserve z-order: use the order these shapes appear in their parent's childIds
  // (later = on top).
  const siblings = parentId ? page.objects[parentId]?.childIds ?? [] : page.childIds;
  const ordered = siblings.filter(id => tops.includes(id));

  const shapes = ordered.map(id => page.objects[id]).filter((s): s is Shape => !!s);
  if (shapes.length === 0) return null;

  // Spatial analysis: detect direction by which axis the centers spread along more.
  const { direction, spacing, padding, bounds } = analyzeSelection(shapes);

  // Detect cross alignment: if the centers cluster tightly on the cross axis, choose
  // center; otherwise start. This avoids surprising users whose layout looks centered.
  const alignItems = detectAlignItems(shapes, direction);

  const containerId = genId();
  const frameShape: Shape = makeDefaultShape({
    id: containerId,
    type: 'frame',
    name: 'Auto Layout',
    frameId: containerId,
    parentId: parentId ?? null,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    fills: [], // Figma's Shift+A frame is transparent
    strokes: [],
    clipContent: false,
    selrect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    autoLayout: {
      direction,
      spacing,
      padding,
      justifyContent: 'start',
      alignItems,
    } satisfies AutoLayoutSettings,
    // The container hugs its content by default — children are now its source of truth.
    widthMode: 'hug',
    heightMode: 'hug',
  });

  const ops: ChangeOp[] = [{ op: 'add', shape: frameShape }];
  // Move each shape into the new container, in z-order, then pin its size so the new
  // container doesn't squeeze it.
  //
  // 'hug' is the exception: it describes the child's relationship to its OWN content, not
  // to whatever parent it happens to sit in, so it stays meaningful after the move and
  // has to survive it. Overwriting it with 'fixed' freezes a container at the size it
  // happened to be — and it then overflows its own children the moment they reflow (a
  // hugging wrap row wrapped into a second line and spilled over the layer below it).
  // 'fill' does depend on the old parent, so it collapses to 'fixed' like an unset axis.
  ordered.forEach((id, index) => {
    const child = page.objects[id];
    ops.push({ op: 'move', id, parentId: containerId, index });
    if (child?.widthMode !== 'hug') ops.push({ op: 'set', id, attr: 'widthMode', val: 'fixed' });
    if (child?.heightMode !== 'hug') ops.push({ op: 'set', id, attr: 'heightMode', val: 'fixed' });
  });

  return { ops, containerId };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function topLevelSelection(page: Page, ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter(id => {
    let p = page.objects[id]?.parentId ?? null;
    while (p) {
      if (set.has(p)) return false;
      p = page.objects[p]?.parentId ?? null;
    }
    return true;
  });
}

function analyzeSelection(shapes: Shape[]): {
  direction: 'horizontal' | 'vertical';
  spacing: number;
  padding: { top: number; right: number; bottom: number; left: number };
  bounds: { x: number; y: number; width: number; height: number };
} {
  // Overall bounding box
  const minX = Math.min(...shapes.map(s => s.x));
  const minY = Math.min(...shapes.map(s => s.y));
  const maxX = Math.max(...shapes.map(s => s.x + s.width));
  const maxY = Math.max(...shapes.map(s => s.y + s.height));
  const bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };

  // Direction: a row is a set of shapes that DON'T overlap horizontally but do overlap
  // vertically, and a column is the reverse — so the layout axis is whichever axis the
  // shapes are separated along. Comparing the spread of centres instead gets this wrong
  // as soon as the shapes differ in size: a 185-wide nav sitting above an 875-wide card
  // row spreads further on X than on Y, and reads as a row despite the two never sharing
  // a single scanline.
  const overlapAlong = (axis: 'x' | 'y'): number => {
    const size = axis === 'x' ? 'width' : 'height';
    const sorted = [...shapes].sort((a, b) => a[axis] - b[axis]);
    let total = 0;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1], cur = sorted[i];
      total += Math.max(0, (prev[axis] + prev[size]) - cur[axis]);
    }
    return total;
  };
  const overlapX = overlapAlong('x');
  const overlapY = overlapAlong('y');
  // Tie (a single shape, or a diagonal spread where neither axis separates them) falls
  // back to whichever axis the centres spread along more.
  const cx = shapes.map(s => s.x + s.width / 2);
  const cy = shapes.map(s => s.y + s.height / 2);
  const xSpread = (Math.max(...cx) - Math.min(...cx));
  const ySpread = (Math.max(...cy) - Math.min(...cy));
  const direction: 'horizontal' | 'vertical' = overlapX === overlapY
    ? (xSpread >= ySpread ? 'horizontal' : 'vertical')
    : (overlapX < overlapY ? 'horizontal' : 'vertical');

  // Spacing: average of the GAPS between adjacent shapes along the primary axis.
  let spacing = 0;
  if (shapes.length >= 2) {
    const sorted = [...shapes].sort((a, b) => direction === 'horizontal' ? a.x - b.x : a.y - b.y);
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const gap = direction === 'horizontal'
        ? cur.x - (prev.x + prev.width)
        : cur.y - (prev.y + prev.height);
      gaps.push(Math.max(0, gap));
    }
    spacing = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
  }

  // Initial padding: Figma uses 0 on Shift+A. The frame hugs the content tightly.
  const padding = { top: 0, right: 0, bottom: 0, left: 0 };

  return { direction, spacing, padding, bounds };
}

function detectAlignItems(shapes: Shape[], direction: 'horizontal' | 'vertical'): 'start' | 'center' | 'end' {
  if (shapes.length < 2) return 'start';
  // Check whether children visually align to their start / center / end edges.
  // Use the smallest spread of edges across the cross axis.
  const startEdges = shapes.map(s => direction === 'horizontal' ? s.y : s.x);
  const endEdges = shapes.map(s => direction === 'horizontal' ? s.y + s.height : s.x + s.width);
  const centers = shapes.map((s, i) => (startEdges[i] + endEdges[i]) / 2);
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  const sStart = spread(startEdges);
  const sCenter = spread(centers);
  const sEnd = spread(endEdges);
  const min = Math.min(sStart, sCenter, sEnd);
  if (min === sCenter) return 'center';
  if (min === sEnd) return 'end';
  return 'start';
}
