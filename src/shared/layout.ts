import {
  Shape, Page, FlexLayout, GridLayout, GridTrack, Padding,
} from './types';

// ── Auto-layout engine ────────────────────────────────────────────────────────
// Pure-TS implementation of CSS flexbox + grid semantics. Computes child
// positions/sizes for any frame whose `layout` is set, writing back x/y/width/
// height into the page's shape map. Recurses so nested layouts resolve too.

export function layoutFile(page: Page): boolean {
  let changed = false;
  // Layout from the leaves up isn't required; we just process every layout frame.
  // Process roots first so parent sizes settle before children.
  for (const rootId of page.childIds) {
    if (layoutShape(page, rootId)) changed = true;
  }
  return changed;
}

function layoutShape(page: Page, shapeId: string): boolean {
  const shape = page.objects[shapeId];
  if (!shape) return false;
  let changed = false;

  if (shape.type === 'frame' && shape.layout) {
    if (shape.layout.type === 'flex') {
      changed = layoutFlex(page, shape, shape.layout) || changed;
    } else if (shape.layout.type === 'grid') {
      changed = layoutGrid(page, shape, shape.layout) || changed;
    }
  }

  // Recurse into children (nested layouts)
  for (const childId of shape.childIds) {
    if (layoutShape(page, childId)) changed = true;
  }
  return changed;
}

// ── Flexbox ─────────────────────────────────────────────────────────────────

function layoutFlex(page: Page, frame: Shape, layout: FlexLayout): boolean {
  const children = frame.childIds
    .map(id => page.objects[id])
    .filter((s): s is Shape => !!s && !s.hidden);
  if (children.length === 0) return false;

  const isRow = layout.direction === 'row' || layout.direction === 'row-reverse';
  const isReverse = layout.direction.endsWith('-reverse');
  const pad = layout.padding;

  // Content box (inside padding)
  const innerX = frame.x + pad.left;
  const innerY = frame.y + pad.top;
  const innerW = frame.width - pad.left - pad.right;
  const innerH = frame.height - pad.top - pad.bottom;

  // Main-axis available length
  const mainSize = isRow ? innerW : innerH;
  const crossSize = isRow ? innerH : innerW;

  const order = isReverse ? [...children].reverse() : children;

  // Compute total base main size + total grow
  const mainSizes = order.map(c => isRow ? c.width : c.height);
  const totalBase = mainSizes.reduce((a, b) => a + b, 0);
  const totalGap = layout.gap * (order.length - 1);
  const totalGrow = order.reduce((a, c) => a + (c.flexGrow ?? 0), 0);
  const freeSpace = mainSize - totalBase - totalGap;

  // Distribute grow
  const grownSizes = mainSizes.map((s, i) => {
    const g = order[i].flexGrow ?? 0;
    if (totalGrow > 0 && freeSpace > 0) return s + (freeSpace * g) / totalGrow;
    return s;
  });

  const grownTotal = grownSizes.reduce((a, b) => a + b, 0);
  const remaining = mainSize - grownTotal - totalGap;

  // Justify: starting offset + spacing between items
  let mainStart = 0;
  let between = layout.gap;
  if (totalGrow === 0) {
    switch (layout.justify) {
      case 'start': mainStart = 0; break;
      case 'center': mainStart = remaining / 2; break;
      case 'end': mainStart = remaining; break;
      case 'space-between':
        mainStart = 0;
        between = order.length > 1 ? layout.gap + remaining / (order.length - 1) : layout.gap;
        break;
      case 'space-around': {
        const unit = remaining / order.length;
        mainStart = unit / 2;
        between = layout.gap + unit;
        break;
      }
      case 'space-evenly': {
        const unit = remaining / (order.length + 1);
        mainStart = unit;
        between = layout.gap + unit;
        break;
      }
    }
  }

  let changed = false;
  let cursor = mainStart;

  for (let i = 0; i < order.length; i++) {
    const child = order[i];
    const mSize = grownSizes[i];
    const cSize = isRow ? child.height : child.width;

    // Cross-axis alignment
    let crossOffset = 0;
    let crossFinal = cSize;
    switch (layout.align) {
      case 'start': crossOffset = 0; break;
      case 'center': crossOffset = (crossSize - cSize) / 2; break;
      case 'end': crossOffset = crossSize - cSize; break;
      case 'stretch': crossOffset = 0; crossFinal = crossSize; break;
    }

    const newX = isRow ? innerX + cursor : innerX + crossOffset;
    const newY = isRow ? innerY + crossOffset : innerY + cursor;
    const newW = isRow ? mSize : crossFinal;
    const newH = isRow ? crossFinal : mSize;

    changed = setBounds(child, newX, newY, newW, newH) || changed;

    cursor += mSize + between;
  }
  return changed;
}

// ── Grid ──────────────────────────────────────────────────────────────────────

function layoutGrid(page: Page, frame: Shape, layout: GridLayout): boolean {
  const pad = layout.padding;
  const innerX = frame.x + pad.left;
  const innerY = frame.y + pad.top;
  const innerW = frame.width - pad.left - pad.right;
  const innerH = frame.height - pad.top - pad.bottom;

  const colSizes = resolveTracks(layout.columns, innerW, layout.columnGap);
  const rowSizes = resolveTracks(layout.rows, innerH, layout.rowGap);

  // Compute track start offsets
  const colStarts = trackStarts(colSizes, layout.columnGap, innerX);
  const rowStarts = trackStarts(rowSizes, layout.rowGap, innerY);

  let changed = false;
  // Auto-place children that have no explicit area
  let autoCol = 0, autoRow = 0;
  const numCols = layout.columns.length;

  for (const childId of frame.childIds) {
    const child = page.objects[childId];
    if (!child || child.hidden) continue;

    let placement = layout.areas[childId];
    if (!placement) {
      // Auto-place in next free cell (row-major)
      placement = { col: autoCol + 1, row: autoRow + 1, colSpan: 1, rowSpan: 1 };
      autoCol++;
      if (autoCol >= numCols) { autoCol = 0; autoRow++; }
    }

    const ci = Math.max(0, Math.min(placement.col - 1, colSizes.length - 1));
    const ri = Math.max(0, Math.min(placement.row - 1, rowSizes.length - 1));
    const cSpan = Math.max(1, placement.colSpan);
    const rSpan = Math.max(1, placement.rowSpan);

    const x = colStarts[ci];
    const y = rowStarts[ri];
    // Sum spanned tracks + internal gaps
    let w = 0;
    for (let k = ci; k < Math.min(ci + cSpan, colSizes.length); k++) w += colSizes[k];
    w += layout.columnGap * (Math.min(cSpan, colSizes.length - ci) - 1);
    let h = 0;
    for (let k = ri; k < Math.min(ri + rSpan, rowSizes.length); k++) h += rowSizes[k];
    h += layout.rowGap * (Math.min(rSpan, rowSizes.length - ri) - 1);

    changed = setBounds(child, x, y, w, h) || changed;
  }
  return changed;
}

// Resolve track list to pixel sizes given available length and gap.
function resolveTracks(tracks: GridTrack[], available: number, gap: number): number[] {
  const totalGap = gap * Math.max(0, tracks.length - 1);
  const space = available - totalGap;

  // First pass: fixed + auto (auto treated as content-min → 0 baseline, gets leftover via fr if none)
  let usedFixed = 0;
  let totalFr = 0;
  for (const t of tracks) {
    if (t.kind === 'fixed') usedFixed += t.value;
    else if (t.kind === 'fr') totalFr += t.value;
  }

  const autoCount = tracks.filter(t => t.kind === 'auto').length;
  let frRemaining = space - usedFixed;

  // If there are auto tracks but no fr, split remaining among autos
  let autoSize = 0;
  if (autoCount > 0 && totalFr === 0) {
    autoSize = Math.max(0, frRemaining / autoCount);
    frRemaining = 0;
  } else if (autoCount > 0) {
    // autos take a minimal share; give them an equal small slice, rest to fr
    autoSize = 0;
  }

  const frUnit = totalFr > 0 ? Math.max(0, frRemaining) / totalFr : 0;

  return tracks.map(t => {
    if (t.kind === 'fixed') return t.value;
    if (t.kind === 'fr') return frUnit * t.value;
    return autoSize;
  });
}

function trackStarts(sizes: number[], gap: number, origin: number): number[] {
  const starts: number[] = [];
  let cur = origin;
  for (const s of sizes) {
    starts.push(cur);
    cur += s + gap;
  }
  return starts;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function setBounds(shape: Shape, x: number, y: number, w: number, h: number): boolean {
  const rx = Math.round(x), ry = Math.round(y), rw = Math.round(w), rh = Math.round(h);
  if (shape.x === rx && shape.y === ry && shape.width === rw && shape.height === rh) return false;
  shape.x = rx; shape.y = ry; shape.width = rw; shape.height = rh;
  shape.selrect = { x: rx, y: ry, width: rw, height: rh };
  return true;
}

// Default layout factories
export function defaultFlexLayout(): FlexLayout {
  return {
    type: 'flex', direction: 'row', wrap: 'nowrap',
    justify: 'start', align: 'start', gap: 8,
    padding: { top: 16, right: 16, bottom: 16, left: 16 },
  };
}

export function defaultGridLayout(): GridLayout {
  return {
    type: 'grid',
    columns: [{ kind: 'fr', value: 1 }, { kind: 'fr', value: 1 }],
    rows: [{ kind: 'fr', value: 1 }, { kind: 'fr', value: 1 }],
    columnGap: 8, rowGap: 8,
    padding: { top: 16, right: 16, bottom: 16, left: 16 },
    areas: {},
  };
}

export function trackToString(t: GridTrack): string {
  if (t.kind === 'fixed') return `${t.value}px`;
  if (t.kind === 'fr') return `${t.value}fr`;
  return 'auto';
}

export function parseTrack(s: string): GridTrack {
  const trimmed = s.trim();
  if (trimmed === 'auto') return { kind: 'auto' };
  if (trimmed.endsWith('fr')) return { kind: 'fr', value: parseFloat(trimmed) || 1 };
  if (trimmed.endsWith('px')) return { kind: 'fixed', value: parseFloat(trimmed) || 0 };
  const n = parseFloat(trimmed);
  return isNaN(n) ? { kind: 'auto' } : { kind: 'fixed', value: n };
}
