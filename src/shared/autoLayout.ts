// ── Auto Layout engine ────────────────────────────────────────────────────────
// Pure, Figma-style auto-layout. Operates on plain AutoLayoutNode trees (no Shape
// dependency) so it's trivial to unit-test and to plug into the document engine
// later. `calculateLayout(node, parentBounds)` is pure: it returns positioned
// bounds for the node and every descendant without mutating the input.

export type AutoLayoutDirection = 'horizontal' | 'vertical' | 'wrap' | 'grid';
export type JustifyContent =
  | 'start' | 'center' | 'end'
  | 'space-between' | 'space-around' | 'space-evenly';
export type AlignItems = 'start' | 'center' | 'end';
export type SizingMode = 'hug' | 'fill' | 'fixed';

export interface AutoLayoutPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AutoLayoutNode {
  id?: string;
  // Declared (intrinsic) box. Used as the placed size when the mode is 'fixed', and
  // as the fallback when 'fill' children appear inside a 'hug' parent.
  width: number;
  height: number;

  // Auto-layout properties — when autoLayout is true, children are positioned by the
  // engine. When false/undefined, the node is a leaf and keeps its declared box.
  autoLayout?: boolean;
  direction?: AutoLayoutDirection;       // default 'horizontal'
  spacing?: number;                       // default 0
  padding?: AutoLayoutPadding;            // default { 0, 0, 0, 0 }
  justifyContent?: JustifyContent;       // primary-axis distribution; default 'start'
  alignItems?: AlignItems;               // cross-axis alignment; default 'start'
  alignContent?: 'start' | 'center' | 'end' | 'space-between'; // wrap row distribution
  columns?: number;                      // grid: number of equal columns (default 2)
  strokeInLayout?: boolean;              // count children's stroke extent in spacing + hug
  // Extra size (both sides summed) this node's own stroke adds beyond its box. Consumed by
  // an ancestor only when that ancestor has strokeInLayout set.
  strokeExtent?: number;

  // Sizing modes (independent per axis, Figma-style)
  widthMode?: SizingMode;                // default 'fixed'
  heightMode?: SizingMode;               // default 'fixed'

  // Min/Max clamps per axis (Figma). undefined = unbounded.
  minWidth?: number; maxWidth?: number;
  minHeight?: number; maxHeight?: number;

  children?: AutoLayoutNode[];
}

// Clamp a resolved size to [min, max]. Either bound may be undefined (unbounded).
function clampAxis(v: number, min?: number, max?: number): number {
  if (min != null) v = Math.max(v, min);
  if (max != null) v = Math.min(v, max);
  return Math.max(0, v);
}

export interface LayoutResult {
  /** Final placed box for this node, in absolute coordinates. */
  bounds: Bounds;
  /** Recursive results, in declaration order. Empty for leaves. */
  children: LayoutResult[];
}

const ZERO_PAD: AutoLayoutPadding = { top: 0, right: 0, bottom: 0, left: 0 };

// ── Public entry ──────────────────────────────────────────────────────────────

export function calculateLayout(node: AutoLayoutNode, parentBounds: Bounds): LayoutResult {
  // Wrap flows on the main (horizontal) axis and breaks to new rows; its cross-size
  // (height) depends on its resolved main-size, so it can't use the per-axis path below.
  if (node.autoLayout && node.direction === 'wrap' && node.children && node.children.length > 0) {
    const width = resolveAxisSize('width', node, parentBounds);
    const pad = node.padding ?? ZERO_PAD;
    const innerW = Math.max(0, width - pad.left - pad.right);
    const hMode = node.heightMode ?? 'fixed';
    const height = hMode === 'hug' ? wrapContentHeight(node, innerW)
      : hMode === 'fill' ? parentBounds.height
      : node.height;
    const bounds: Bounds = { x: parentBounds.x, y: parentBounds.y, width, height };
    return { bounds, children: placeWrap(node, bounds) };
  }

  // Grid: equal-width columns, auto row heights. Like wrap, cross-size depends on the
  // resolved main-size, so it takes its own path.
  if (node.autoLayout && node.direction === 'grid' && node.children && node.children.length > 0) {
    const width = resolveAxisSize('width', node, parentBounds);
    const hMode = node.heightMode ?? 'fixed';
    const height = hMode === 'hug' ? gridContentHeight(node)
      : hMode === 'fill' ? parentBounds.height
      : node.height;
    const bounds: Bounds = { x: parentBounds.x, y: parentBounds.y, width, height };
    return { bounds, children: placeGrid(node, bounds) };
  }

  const width = resolveAxisSize('width', node, parentBounds);
  const height = resolveAxisSize('height', node, parentBounds);
  const bounds: Bounds = { x: parentBounds.x, y: parentBounds.y, width, height };

  if (!node.autoLayout || !node.children || node.children.length === 0) {
    return { bounds, children: [] };
  }
  return { bounds, children: placeChildren(node, bounds) };
}

// ── Container sizing ──────────────────────────────────────────────────────────

function resolveAxisSize(axis: 'width' | 'height', node: AutoLayoutNode, parent: Bounds): number {
  const sizing = (axis === 'width' ? node.widthMode : node.heightMode) ?? 'fixed';
  const min = axis === 'width' ? node.minWidth : node.minHeight;
  const max = axis === 'width' ? node.maxWidth : node.maxHeight;
  let raw: number;
  if (sizing === 'fixed') raw = axis === 'width' ? node.width : node.height;
  else if (sizing === 'fill') raw = axis === 'width' ? parent.width : parent.height;
  else {
    // 'hug' — measure from the children (or fall back to declared size on a leaf).
    const ns = naturalSize(node);
    raw = axis === 'width' ? ns.width : ns.height;
  }
  return clampAxis(raw, min, max);
}

/**
 * The size a node would have if its width and height were both 'hug'. Recurses so a
 * grandparent that hugs sees the natural size of every descendant.
 *
 * Rule for non-auto-layout leaves: their declared (width, height) is the natural size.
 * Rule for `fill` children inside a hug parent: they collapse to their declared size
 * (a hug parent has no remaining space to fill into).
 */
function naturalSize(node: AutoLayoutNode): { width: number; height: number } {
  if (!node.autoLayout || !node.children || node.children.length === 0) {
    return {
      width: clampAxis(node.width, node.minWidth, node.maxWidth),
      height: clampAxis(node.height, node.minHeight, node.maxHeight),
    };
  }
  const padding = node.padding ?? ZERO_PAD;
  const spacing = node.spacing ?? 0;
  const dir = node.direction ?? 'horizontal';

  const inclStroke = !!node.strokeInLayout;
  const childSizes = node.children.map(c => {
    const nc = naturalContribution(c);
    const ext = inclStroke ? (c.strokeExtent ?? 0) : 0;
    return { width: nc.width + ext, height: nc.height + ext };
  });
  const between = spacing * Math.max(0, node.children.length - 1);

  // Grid intrinsic: equal columns sized to the widest child, rows to their tallest child.
  if (dir === 'grid') {
    const cols = Math.max(1, Math.floor(node.columns ?? 2));
    const rows = Math.max(1, Math.ceil(childSizes.length / cols));
    const colW = max(childSizes.map(s => s.width));
    let hSum = 0;
    for (let r = 0; r < rows; r++) {
      let rh = 0;
      for (let c = 0; c < cols; c++) { const idx = r * cols + c; if (idx < childSizes.length) rh = Math.max(rh, childSizes[idx].height); }
      hSum += rh;
    }
    const gw = padding.left + padding.right + cols * colW + spacing * Math.max(0, cols - 1);
    const gh = padding.top + padding.bottom + hSum + spacing * Math.max(0, rows - 1);
    return {
      width: clampAxis(gw, node.minWidth, node.maxWidth),
      height: clampAxis(gh, node.minHeight, node.maxHeight),
    };
  }

  let w: number, h: number;
  // Intrinsic (hug both axes) of a wrap container = a single row, like horizontal.
  if (dir === 'horizontal' || dir === 'wrap') {
    w = padding.left + padding.right + sum(childSizes.map(s => s.width)) + between;
    h = padding.top + padding.bottom + max(childSizes.map(s => s.height));
  } else {
    w = padding.left + padding.right + max(childSizes.map(s => s.width));
    h = padding.top + padding.bottom + sum(childSizes.map(s => s.height)) + between;
  }
  return {
    width: clampAxis(w, node.minWidth, node.maxWidth),
    height: clampAxis(h, node.minHeight, node.maxHeight),
  };
}

/**
 * A child's contribution to its parent's hug measurement on each axis. Fill children
 * collapse to their declared size for this purpose (see naturalSize comment).
 */
function naturalContribution(child: AutoLayoutNode): { width: number; height: number } {
  const ns = naturalSize(child);
  const w = (child.widthMode ?? 'fixed') === 'hug' ? ns.width : child.width;
  const h = (child.heightMode ?? 'fixed') === 'hug' ? ns.height : child.height;
  return { width: w, height: h };
}

// ── Child placement ───────────────────────────────────────────────────────────

function placeChildren(node: AutoLayoutNode, bounds: Bounds): LayoutResult[] {
  const padding = node.padding ?? ZERO_PAD;
  const spacing = node.spacing ?? 0;
  const dir = node.direction ?? 'horizontal';
  const justify = node.justifyContent ?? 'start';
  const alignCross = node.alignItems ?? 'start';
  const children = node.children!;

  // Content box (inside padding) in absolute coordinates.
  const innerX = bounds.x + padding.left;
  const innerY = bounds.y + padding.top;
  const innerW = Math.max(0, bounds.width - padding.left - padding.right);
  const innerH = Math.max(0, bounds.height - padding.top - padding.bottom);
  const mainSize = dir === 'horizontal' ? innerW : innerH;
  const crossSize = dir === 'horizontal' ? innerH : innerW;

  // Stroke extent (per child) is added to occupancy — the space a child reserves for
  // spacing/positioning/hug — while its GEOMETRIC box stays its own size. `ext` is 0 unless
  // the container opts into strokeInLayout, so the default path is byte-for-byte unchanged.
  const inclStroke = !!node.strokeInLayout;

  // First pass — compute each child's primary-axis geometric size + stroke ext. Fill children
  // share whatever is left after fixed+hug occupancy and the spacing between them.
  type Slot = { primary: number; cross: number; fill: boolean; ext: number; minMain?: number; maxMain?: number };
  const slots: Slot[] = [];
  let fixedPrimary = 0;   // occupancy (geometric + stroke ext)
  let fillCount = 0;
  for (const c of children) {
    const primaryMode = (dir === 'horizontal' ? c.widthMode : c.heightMode) ?? 'fixed';
    const crossMode = (dir === 'horizontal' ? c.heightMode : c.widthMode) ?? 'fixed';
    const minMain = dir === 'horizontal' ? c.minWidth : c.minHeight;
    const maxMain = dir === 'horizontal' ? c.maxWidth : c.maxHeight;
    const minCross = dir === 'horizontal' ? c.minHeight : c.minWidth;
    const maxCross = dir === 'horizontal' ? c.maxHeight : c.maxWidth;
    const ext = inclStroke ? (c.strokeExtent ?? 0) : 0;

    let primary = 0;
    if (primaryMode === 'fill') { fillCount++; }
    else if (primaryMode === 'hug') {
      const ns = naturalSize(c);
      primary = clampAxis(dir === 'horizontal' ? ns.width : ns.height, minMain, maxMain);
      fixedPrimary += primary + ext;
    } else {
      primary = clampAxis(dir === 'horizontal' ? c.width : c.height, minMain, maxMain);
      fixedPrimary += primary + ext;
    }

    let cross = 0;
    if (crossMode === 'fill') cross = crossSize - ext;   // fill leaves room for its own stroke
    else if (crossMode === 'hug') {
      const ns = naturalSize(c);
      cross = dir === 'horizontal' ? ns.height : ns.width;
    } else {
      cross = dir === 'horizontal' ? c.height : c.width;
    }
    cross = clampAxis(cross, minCross, maxCross);
    slots.push({ primary, cross, fill: primaryMode === 'fill', ext, minMain, maxMain });
  }

  const totalSpacing = spacing * Math.max(0, children.length - 1);
  const remaining = Math.max(0, mainSize - fixedPrimary - totalSpacing);
  const fillEach = fillCount > 0 ? remaining / fillCount : 0;
  // Single-pass fill: equal share minus this child's stroke ext, then clamp to min/max.
  // (Clamping can leave minor slack when multiple fill children hit bounds — acceptable v1.)
  for (const s of slots) if (s.fill) s.primary = clampAxis(Math.max(0, fillEach - s.ext), s.minMain, s.maxMain);

  // Occupancy of a slot on the main axis = geometric primary + stroke ext.
  const occ = (s: Slot) => s.primary + s.ext;

  // Primary-axis distribution. When any fill children are present, they consume all
  // leftover space so a `justifyContent` other than start has no slack — start-like.
  const totalPrimary = slots.reduce((a, s) => a + occ(s), 0);
  const slack = Math.max(0, mainSize - totalPrimary - totalSpacing);
  const offsets = fillCount > 0
    ? { leading: 0, between: spacing }
    : computeJustifyOffsets(justify, children.length, slack, spacing);

  // Second pass — place each child and recurse. The geometric box is centred inside its
  // occupancy (stroke extends half-ext beyond each edge).
  const out: LayoutResult[] = [];
  let cursor = offsets.leading;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    const slot = slots[i];
    const half = slot.ext / 2;
    const occCross = slot.cross + slot.ext;
    // Cross-axis offset: each child positioned independently so a hug parent with
    // mixed-height children aligns each child to top/center/bottom of the content box.
    const crossOffset = alignCross === 'center' ? (crossSize - occCross) / 2
      : alignCross === 'end' ? crossSize - occCross
      : 0;
    const mainPos = cursor + half;
    const crossPos = crossOffset + half;
    const placed: Bounds = dir === 'horizontal'
      ? { x: innerX + mainPos, y: innerY + crossPos, width: slot.primary, height: slot.cross }
      : { x: innerX + crossPos, y: innerY + mainPos, width: slot.cross, height: slot.primary };

    // Recurse: feed the placed bounds back as parentBounds so descendant fills know
    // the resolved container. Override the child's declared size with the placed size
    // so a re-resolution still gives the same numbers.
    const childInput: AutoLayoutNode = {
      ...c,
      width: placed.width,
      height: placed.height,
      // Once placed, treat both axes as fixed for the recursive call's own size lookup.
      // (Its OWN children's fill calculations still see placed bounds via parentBounds.)
      widthMode: 'fixed',
      heightMode: 'fixed',
    };
    out.push(calculateLayout(childInput, placed));

    if (i < children.length - 1) cursor += occ(slot) + offsets.between;
  }
  return out;
}

// ── Wrap (flex-wrap) ────────────────────────────────────────────────────────────
// Items flow left→right and break to a new row when the next item would exceed the
// container's inner width. Row height = tallest item in that row; the same `spacing`
// is used between items and between rows. Items use their declared/hug box (fill on the
// main axis has no meaning when wrapping, so it collapses to declared).

function wrapBox(c: AutoLayoutNode): { w: number; h: number } {
  const ns = naturalSize(c);
  return {
    w: clampAxis((c.widthMode ?? 'fixed') === 'hug' ? ns.width : c.width, c.minWidth, c.maxWidth),
    h: clampAxis((c.heightMode ?? 'fixed') === 'hug' ? ns.height : c.height, c.minHeight, c.maxHeight),
  };
}

function wrapContentHeight(node: AutoLayoutNode, innerW: number): number {
  const padding = node.padding ?? ZERO_PAD;
  const spacing = node.spacing ?? 0;
  const children = node.children ?? [];
  let cx = 0, totalH = 0, rowH = 0, any = false;
  for (const c of children) {
    const { w, h } = wrapBox(c);
    if (cx > 0 && cx + w > innerW) { totalH += rowH + spacing; cx = 0; rowH = 0; }
    cx += w + spacing; rowH = Math.max(rowH, h); any = true;
  }
  return padding.top + padding.bottom + (any ? totalH + rowH : 0);
}

function placeWrap(node: AutoLayoutNode, bounds: Bounds): LayoutResult[] {
  const padding = node.padding ?? ZERO_PAD;
  const spacing = node.spacing ?? 0;
  const justify = node.justifyContent ?? 'start';
  const align = node.alignItems ?? 'start';
  const children = node.children!;
  const innerX = bounds.x + padding.left;
  const innerY = bounds.y + padding.top;
  const innerW = Math.max(0, bounds.width - padding.left - padding.right);

  // Pass 1 — group children into rows that each fit within innerW.
  type Item = { c: AutoLayoutNode; w: number; h: number };
  const rows: Item[][] = [];
  let row: Item[] = [];
  let cx = 0;
  for (const c of children) {
    const { w, h } = wrapBox(c);
    if (row.length > 0 && cx + w > innerW) { rows.push(row); row = []; cx = 0; }
    row.push({ c, w, h });
    cx += w + spacing;
  }
  if (row.length) rows.push(row);

  // alignContent — distribute the rows on the cross axis when the container is taller than
  // its content (only meaningful for a fixed/fill height; a hug container has no slack).
  const rowHeights = rows.map(r => r.reduce((m, it) => Math.max(m, it.h), 0));
  const innerH = Math.max(0, bounds.height - padding.top - padding.bottom);
  const rowsTotal = sum(rowHeights) + spacing * Math.max(0, rows.length - 1);
  const crossSlack = Math.max(0, innerH - rowsTotal);
  const alignContent = node.alignContent ?? 'start';
  let cy = alignContent === 'center' ? crossSlack / 2 : alignContent === 'end' ? crossSlack : 0;
  const rowGapExtra = alignContent === 'space-between' && rows.length > 1 ? crossSlack / (rows.length - 1) : 0;

  // Pass 2 — place each row: justifyContent distributes items on the main axis within
  // the row; alignItems aligns each item on the cross axis against the row's height.
  const out: LayoutResult[] = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    const rowH = rowHeights[ri];
    const contentW = r.reduce((a, it) => a + it.w, 0);
    const rowSpacing = spacing * Math.max(0, r.length - 1);
    const slack = Math.max(0, innerW - contentW - rowSpacing);
    const offs = computeJustifyOffsets(justify, r.length, slack, spacing);
    let x = offs.leading;
    for (const it of r) {
      const crossOffset = align === 'center' ? (rowH - it.h) / 2 : align === 'end' ? rowH - it.h : 0;
      const placed: Bounds = { x: innerX + x, y: innerY + cy + crossOffset, width: it.w, height: it.h };
      const childInput: AutoLayoutNode = { ...it.c, width: it.w, height: it.h, widthMode: 'fixed', heightMode: 'fixed' };
      out.push(calculateLayout(childInput, placed));
      x += it.w + offs.between;
    }
    cy += rowH + spacing + rowGapExtra;
  }
  return out;
}

// ── Grid ──────────────────────────────────────────────────────────────────────
// v1: `columns` equal-width columns; children flow row-major; each row's height is its
// tallest child; `spacing` is used for both column and row gaps. Deferred: per-track
// sizing, cell spans, separate row/column gaps, per-cell alignment.

function gridRowHeights(node: AutoLayoutNode): number[] {
  const cols = Math.max(1, Math.floor(node.columns ?? 2));
  const children = node.children ?? [];
  const rows = Math.max(1, Math.ceil(children.length / cols));
  const heights: number[] = [];
  for (let r = 0; r < rows; r++) {
    let h = 0;
    for (let c = 0; c < cols; c++) { const idx = r * cols + c; if (idx < children.length) h = Math.max(h, wrapBox(children[idx]).h); }
    heights.push(h);
  }
  return heights;
}

function gridContentHeight(node: AutoLayoutNode): number {
  const padding = node.padding ?? ZERO_PAD;
  const spacing = node.spacing ?? 0;
  const rh = gridRowHeights(node);
  return padding.top + padding.bottom + sum(rh) + spacing * Math.max(0, rh.length - 1);
}

function placeGrid(node: AutoLayoutNode, bounds: Bounds): LayoutResult[] {
  const padding = node.padding ?? ZERO_PAD;
  const gap = node.spacing ?? 0;
  const cols = Math.max(1, Math.floor(node.columns ?? 2));
  const children = node.children!;
  const innerX = bounds.x + padding.left;
  const innerY = bounds.y + padding.top;
  const innerW = Math.max(0, bounds.width - padding.left - padding.right);
  const colW = Math.max(0, (innerW - gap * (cols - 1)) / cols);

  const rowH = gridRowHeights(node);
  const rowY: number[] = [];
  let acc = 0;
  for (let r = 0; r < rowH.length; r++) { rowY.push(acc); acc += rowH[r] + gap; }

  const out: LayoutResult[] = [];
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const box = wrapBox(c);
    // Fill stretches to the cell; otherwise the child keeps its own box, pinned top-left.
    const w = (c.widthMode ?? 'fixed') === 'fill' ? colW : box.w;
    const h = (c.heightMode ?? 'fixed') === 'fill' ? rowH[row] : box.h;
    const placed: Bounds = { x: innerX + col * (colW + gap), y: innerY + rowY[row], width: w, height: h };
    const childInput: AutoLayoutNode = { ...c, width: w, height: h, widthMode: 'fixed', heightMode: 'fixed' };
    out.push(calculateLayout(childInput, placed));
  }
  return out;
}

/**
 * The leading offset (where the FIRST child starts inside the inner content box) and
 * the BETWEEN offset (gap between adjacent children, including the configured spacing).
 * `slack` is whatever's left after fixed/hug children + N-1 configured gaps.
 */
function computeJustifyOffsets(
  justify: JustifyContent,
  count: number,
  slack: number,
  spacing: number,
): { leading: number; between: number } {
  switch (justify) {
    case 'start':   return { leading: 0, between: spacing };
    case 'center':  return { leading: slack / 2, between: spacing };
    case 'end':     return { leading: slack, between: spacing };
    case 'space-between':
      return { leading: 0, between: count > 1 ? spacing + slack / (count - 1) : spacing };
    case 'space-around': {
      const around = slack / Math.max(1, count);
      return { leading: around / 2, between: spacing + around };
    }
    case 'space-evenly': {
      const even = slack / Math.max(1, count + 1);
      return { leading: even, between: spacing + even };
    }
  }
}

// ── tiny helpers ──────────────────────────────────────────────────────────────

function sum(xs: number[]): number { return xs.reduce((a, b) => a + b, 0); }
function max(xs: number[]): number { return xs.length === 0 ? 0 : Math.max(...xs); }

// ── Shape ↔ AutoLayoutNode adapter ────────────────────────────────────────────
// Lazy, lightweight bridge so the document engine can run the pure layout function
// over its shape map. We only import the Shape/Page types — no runtime dependency.
import type { Shape, Page } from './types';

// Extra size a shape's stroke adds beyond its box, summed over both sides of an axis.
// inner stroke → 0, center → weight/2 per side, outer → full weight per side. Uses the
// widest stroke (Figma renders strokes stacked, the thickest defines the extent).
function strokeExtent(shape: Shape): number {
  let side = 0;
  for (const s of shape.strokes ?? []) {
    if (!s || s.opacity === 0 || s.width <= 0) continue;
    const per = s.align === 'outer' ? s.width : s.align === 'center' ? s.width / 2 : 0;
    side = Math.max(side, per);
  }
  return side * 2;
}

// Axis-aligned bounding box of a w×h rectangle rotated by `deg` about its centre.
function rotatedAABB(w: number, h: number, deg: number): { width: number; height: number } {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  return { width: w * cos + h * sin, height: w * sin + h * cos };
}

const normDeg = (d: number) => ((d % 360) + 360) % 360;

function shapeToNode(shape: Shape, page: Page, isRoot = true, parentRotation = 0): AutoLayoutNode {
  const settings = shape.autoLayout ?? null;

  // Layout runs in the container's LOCAL space (Figma model). In the flat coordinate
  // model a parent's rotation is baked into each child, so what matters for a child's
  // footprint is its rotation RELATIVE to the container: rel = 0 means it just turns
  // with the frame (exact w×h footprint); rel ≠ 0 means it's independently rotated and
  // occupies its rotated axis-aligned bounding box in the flow — otherwise rotated
  // siblings overlap. Emitted as a fixed leaf; if it's an AL container itself, its own
  // subtree reflows in applyAutoLayoutToPage's second pass.
  const relRotation = isRoot ? 0 : normDeg(shape.rotation - parentRotation);
  if (relRotation) {
    const aabb = rotatedAABB(shape.width, shape.height, relRotation);
    return {
      id: shape.id,
      width: aabb.width,
      height: aabb.height,
      autoLayout: false,
      strokeExtent: strokeExtent(shape),
      // A rotated child can't hug/fill meaningfully inside the flow — fixed AABB.
      widthMode: 'fixed',
      heightMode: 'fixed',
      children: [],
    };
  }

  // Absolute-positioned children are excluded from the flow AND from hug measurement.
  // Their own subtree is laid out separately by applyAutoLayoutToPage.
  const visibleChildren = shape.childIds
    .map(id => page.objects[id])
    .filter((c): c is Shape => !!c && !c.hidden && c.layoutPositioning !== 'absolute');
  return {
    id: shape.id,
    // On a 'fill' axis, shape.width/height hold the size the ENGINE last resolved. Feed
    // the declared size instead so a hugging ancestor measures the intrinsic child.
    width: shape.widthMode === 'fill' ? (shape.baseWidth ?? shape.width) : shape.width,
    height: shape.heightMode === 'fill' ? (shape.baseHeight ?? shape.height) : shape.height,
    autoLayout: !!settings,
    direction: settings?.direction,
    spacing: settings?.spacing,
    padding: settings ? { ...settings.padding } : undefined,
    justifyContent: settings?.justifyContent,
    alignItems: settings?.alignItems,
    alignContent: settings?.alignContent,
    columns: settings?.columns,
    strokeInLayout: settings?.strokeInLayout,
    strokeExtent: strokeExtent(shape),
    widthMode: shape.widthMode,
    heightMode: shape.heightMode,
    minWidth: shape.minWidth,
    maxWidth: shape.maxWidth,
    minHeight: shape.minHeight,
    maxHeight: shape.maxHeight,
    // `reversed` flips the visual order — applied here so the engine and id-mapping stay
    // order-agnostic (each node carries its own shape id through placement).
    children: settings
      ? (() => {
          // Children of a rel==0 container share the ROOT's rotation frame, so the same
          // parentRotation propagates down for their own relative-rotation checks.
          const kids = visibleChildren.map(c => shapeToNode(c, page, false, isRoot ? shape.rotation : parentRotation));
          return settings.reversed ? kids.reverse() : kids;
        })()
      : [],
  };
}

/**
 * Run Figma-style auto-layout across the page. For every shape with `autoLayout` set,
 * compute placed bounds for it and its descendants and write them back. Returns true
 * if any shape's bounds changed.
 */
export function applyAutoLayoutToPage(page: Page): boolean {
  let changed = false;
  // Placement context: the root container's rotation + pivot. Layout is computed in the
  // container's local (unrotated) space; every placed bound's CENTRE is then rotated
  // about the container's centre so the arrangement turns with the frame (Figma model).
  type PlaceCtx = { theta: number; pcx: number; pcy: number };

  const writeBounds = (id: string, b: Bounds, ctx: PlaceCtx) => {
    const s = page.objects[id];
    if (!s) return;
    // A stretched axis is about to have its resolved size written over the declared one.
    // Remember the declared size the first time so Fixed can restore it and hug ancestors
    // keep measuring the intrinsic size (see Shape.baseWidth).
    if (s.widthMode === 'fill' && s.baseWidth === undefined) s.baseWidth = s.width;
    if (s.heightMode === 'fill' && s.baseHeight === undefined) s.baseHeight = s.height;
    const rel = normDeg(s.rotation - ctx.theta);

    // The child's local centre inside the layout slot. rel ≠ 0 children keep their own
    // size and centre inside their AABB slot; rel == 0 children take the slot exactly.
    const localCx = b.x + b.width / 2;
    const localCy = b.y + b.height / 2;
    let cx = localCx, cy = localCy;
    if (ctx.theta) {
      const rad = (ctx.theta * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
      cx = ctx.pcx + (localCx - ctx.pcx) * cos - (localCy - ctx.pcy) * sin;
      cy = ctx.pcy + (localCx - ctx.pcx) * sin + (localCy - ctx.pcy) * cos;
    }

    if (rel) {
      // Independently-rotated child: never touch its size or rotation — centre it in
      // its (rotated-about-pivot) AABB slot.
      const rx = Math.round(cx - s.width / 2);
      const ry = Math.round(cy - s.height / 2);
      if (s.x === rx && s.y === ry) return;
      s.x = rx; s.y = ry;
      s.selrect = { x: rx, y: ry, width: s.width, height: s.height };
      changed = true;
      return;
    }
    const rw = Math.max(0, Math.round(b.width)), rh = Math.max(0, Math.round(b.height));
    const rx = Math.round(cx - rw / 2), ry = Math.round(cy - rh / 2);
    if (s.x === rx && s.y === ry && s.width === rw && s.height === rh) return;
    s.x = rx; s.y = ry; s.width = rw; s.height = rh;
    s.selrect = { x: rx, y: ry, width: rw, height: rh };
    changed = true;
  };

  // Parallel traversal of the input AutoLayoutNode tree and the engine's LayoutResult
  // so we can map each placed result back to the source shape id.
  const tagAndWalk = (n: AutoLayoutNode, r: LayoutResult, isRoot: boolean, ctx: PlaceCtx) => {
    if (!isRoot && n.id) writeBounds(n.id, r.bounds, ctx);
    if (!n.children) return;
    for (let i = 0; i < n.children.length; i++) {
      const childResult = r.children[i];
      if (!childResult) continue;
      tagAndWalk(n.children[i], childResult, false, ctx);
    }
  };

  const visit = (id: string) => {
    const shape = page.objects[id];
    if (!shape) return;
    if (shape.autoLayout) {
      const node = shapeToNode(shape, page);
      const result = calculateLayout(node, { x: shape.x, y: shape.y, width: shape.width, height: shape.height });
      // Container: write only width/height (hug may have grown/shrunk it). Keep x/y.
      // The engine NEVER writes the container's (or any child's) rotation.
      const w = Math.max(0, Math.round(result.bounds.width));
      const h = Math.max(0, Math.round(result.bounds.height));
      if (shape.width !== w || shape.height !== h) {
        shape.width = w; shape.height = h;
        shape.selrect = { x: shape.x, y: shape.y, width: w, height: h };
        changed = true;
      }
      const ctx: PlaceCtx = { theta: normDeg(shape.rotation), pcx: shape.x + w / 2, pcy: shape.y + h / 2 };
      tagAndWalk(node, result, true, ctx);
      // Descendants were placed by the engine — don't revisit them as independent roots.
      return;
    }
    for (const c of shape.childIds) visit(c);
  };

  for (const rootId of page.childIds) visit(rootId);

  // Second pass: shapes the flow skipped still need their own subtrees laid out.
  //  - absolute-positioned shapes (excluded from the parent's flow entirely)
  //  - AL containers rotated RELATIVE to an AL parent (emitted as AABB leaves above)
  for (const id of Object.keys(page.objects)) {
    const s = page.objects[id];
    if (!s) continue;
    const parent = s.parentId ? page.objects[s.parentId] : null;
    const relToParent = parent?.autoLayout ? normDeg(s.rotation - parent.rotation) : 0;
    if (s.layoutPositioning === 'absolute' || (s.autoLayout && relToParent !== 0)) visit(id);
  }
  return changed;
}
