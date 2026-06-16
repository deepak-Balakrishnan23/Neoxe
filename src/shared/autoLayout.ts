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

  // Sizing modes (independent per axis, Figma-style)
  widthMode?: SizingMode;                // default 'fixed'
  heightMode?: SizingMode;               // default 'fixed'

  children?: AutoLayoutNode[];
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
  if (sizing === 'fixed') return axis === 'width' ? node.width : node.height;
  if (sizing === 'fill') return axis === 'width' ? parent.width : parent.height;
  // 'hug' — measure from the children (or fall back to declared size on a leaf).
  const ns = naturalSize(node);
  return axis === 'width' ? ns.width : ns.height;
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
    return { width: node.width, height: node.height };
  }
  const padding = node.padding ?? ZERO_PAD;
  const spacing = node.spacing ?? 0;
  const dir = node.direction ?? 'horizontal';

  const childSizes = node.children.map(c => naturalContribution(c));
  const between = spacing * Math.max(0, node.children.length - 1);

  // Intrinsic (hug both axes) of a wrap container = a single row, like horizontal.
  if (dir === 'horizontal' || dir === 'wrap') {
    const w = padding.left + padding.right + sum(childSizes.map(s => s.width)) + between;
    const h = padding.top + padding.bottom + max(childSizes.map(s => s.height));
    return { width: w, height: h };
  }
  const w = padding.left + padding.right + max(childSizes.map(s => s.width));
  const h = padding.top + padding.bottom + sum(childSizes.map(s => s.height)) + between;
  return { width: w, height: h };
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

  // First pass — compute each child's primary-axis size. Fill children share whatever
  // is left after fixed+hug children and the spacing between them.
  type Slot = { primary: number; cross: number; fill: boolean };
  const slots: Slot[] = [];
  let fixedPrimary = 0;
  let fillCount = 0;
  for (const c of children) {
    const primaryMode = (dir === 'horizontal' ? c.widthMode : c.heightMode) ?? 'fixed';
    const crossMode = (dir === 'horizontal' ? c.heightMode : c.widthMode) ?? 'fixed';

    let primary = 0;
    if (primaryMode === 'fill') { fillCount++; }
    else if (primaryMode === 'hug') {
      const ns = naturalSize(c);
      primary = dir === 'horizontal' ? ns.width : ns.height;
      fixedPrimary += primary;
    } else {
      primary = dir === 'horizontal' ? c.width : c.height;
      fixedPrimary += primary;
    }

    let cross = 0;
    if (crossMode === 'fill') cross = crossSize;
    else if (crossMode === 'hug') {
      const ns = naturalSize(c);
      cross = dir === 'horizontal' ? ns.height : ns.width;
    } else {
      cross = dir === 'horizontal' ? c.height : c.width;
    }
    slots.push({ primary, cross, fill: primaryMode === 'fill' });
  }

  const totalSpacing = spacing * Math.max(0, children.length - 1);
  const remaining = Math.max(0, mainSize - fixedPrimary - totalSpacing);
  const fillEach = fillCount > 0 ? remaining / fillCount : 0;
  for (const s of slots) if (s.fill) s.primary = fillEach;

  // Primary-axis distribution. When any fill children are present, they consume all
  // leftover space so a `justifyContent` other than start has no slack — start-like.
  const totalPrimary = slots.reduce((a, s) => a + s.primary, 0);
  const slack = Math.max(0, mainSize - totalPrimary - totalSpacing);
  const offsets = fillCount > 0
    ? { leading: 0, between: spacing }
    : computeJustifyOffsets(justify, children.length, slack, spacing);

  // Second pass — place each child and recurse.
  const out: LayoutResult[] = [];
  let cursor = offsets.leading;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    const slot = slots[i];
    // Cross-axis offset: each child positioned independently so a hug parent with
    // mixed-height children aligns each child to top/center/bottom of the content box.
    const crossOffset = alignCross === 'center' ? (crossSize - slot.cross) / 2
      : alignCross === 'end' ? crossSize - slot.cross
      : 0;
    const placed: Bounds = dir === 'horizontal'
      ? { x: innerX + cursor, y: innerY + crossOffset, width: slot.primary, height: slot.cross }
      : { x: innerX + crossOffset, y: innerY + cursor, width: slot.cross, height: slot.primary };

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

    if (i < children.length - 1) cursor += slot.primary + offsets.between;
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
    w: (c.widthMode ?? 'fixed') === 'hug' ? ns.width : c.width,
    h: (c.heightMode ?? 'fixed') === 'hug' ? ns.height : c.height,
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
  const children = node.children!;
  const innerX = bounds.x + padding.left;
  const innerY = bounds.y + padding.top;
  const innerW = Math.max(0, bounds.width - padding.left - padding.right);

  const out: LayoutResult[] = [];
  let cx = 0, cy = 0, rowH = 0;
  for (let i = 0; i < children.length; i++) {
    const { w, h } = wrapBox(children[i]);
    if (cx > 0 && cx + w > innerW) { cy += rowH + spacing; cx = 0; rowH = 0; }
    const placed: Bounds = { x: innerX + cx, y: innerY + cy, width: w, height: h };
    const childInput: AutoLayoutNode = { ...children[i], width: w, height: h, widthMode: 'fixed', heightMode: 'fixed' };
    out.push(calculateLayout(childInput, placed));
    cx += w + spacing;
    rowH = Math.max(rowH, h);
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

function shapeToNode(shape: Shape, page: Page): AutoLayoutNode {
  const settings = shape.autoLayout ?? null;
  const visibleChildren = shape.childIds
    .map(id => page.objects[id])
    .filter((c): c is Shape => !!c && !c.hidden);
  return {
    id: shape.id,
    width: shape.width,
    height: shape.height,
    autoLayout: !!settings,
    direction: settings?.direction,
    spacing: settings?.spacing,
    padding: settings ? { ...settings.padding } : undefined,
    justifyContent: settings?.justifyContent,
    alignItems: settings?.alignItems,
    widthMode: shape.widthMode,
    heightMode: shape.heightMode,
    // `reversed` flips the visual order — applied here so the engine and id-mapping stay
    // order-agnostic (each node carries its own shape id through placement).
    children: settings
      ? (() => {
          const kids = visibleChildren.map(c => shapeToNode(c, page));
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
  const writeBounds = (id: string, b: Bounds) => {
    const s = page.objects[id];
    if (!s) return;
    const rx = Math.round(b.x), ry = Math.round(b.y);
    const rw = Math.max(0, Math.round(b.width)), rh = Math.max(0, Math.round(b.height));
    if (s.x === rx && s.y === ry && s.width === rw && s.height === rh) return;
    s.x = rx; s.y = ry; s.width = rw; s.height = rh;
    s.selrect = { x: rx, y: ry, width: rw, height: rh };
    changed = true;
  };

  // Parallel traversal of the input AutoLayoutNode tree and the engine's LayoutResult
  // so we can map each placed result back to the source shape id.
  const tagAndWalk = (n: AutoLayoutNode, r: LayoutResult, isRoot: boolean) => {
    if (!isRoot && n.id) writeBounds(n.id, r.bounds);
    if (!n.children) return;
    for (let i = 0; i < n.children.length; i++) {
      const childResult = r.children[i];
      if (!childResult) continue;
      tagAndWalk(n.children[i], childResult, false);
    }
  };

  const visit = (id: string) => {
    const shape = page.objects[id];
    if (!shape) return;
    if (shape.autoLayout) {
      const node = shapeToNode(shape, page);
      const result = calculateLayout(node, { x: shape.x, y: shape.y, width: shape.width, height: shape.height });
      // Container: write only width/height (hug may have grown/shrunk it). Keep x/y.
      const w = Math.max(0, Math.round(result.bounds.width));
      const h = Math.max(0, Math.round(result.bounds.height));
      if (shape.width !== w || shape.height !== h) {
        shape.width = w; shape.height = h;
        shape.selrect = { x: shape.x, y: shape.y, width: w, height: h };
        changed = true;
      }
      tagAndWalk(node, result, true);
      // Descendants were placed by the engine — don't revisit them as independent roots.
      return;
    }
    for (const c of shape.childIds) visit(c);
  };

  for (const rootId of page.childIds) visit(rootId);
  return changed;
}
