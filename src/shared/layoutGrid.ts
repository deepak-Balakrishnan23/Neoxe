// ── Layout grid geometry ──────────────────────────────────────────────────────
// Pure track math for Figma-style layout grids, shared by the canvas renderer (to
// paint the overlay) and by snapping (to snap edges to track boundaries).

import { LayoutGrid } from './types';

export interface GridTrack {
  /** Offset from the frame's start edge on the grid's axis. */
  start: number;
  size: number;
}

/**
 * Track rects for a column/row grid laid across `extent` px (the frame's width for
 * columns, its height for rows). Returns [] for a uniform 'grid', which has no tracks —
 * use `gridLines` for that.
 */
export function gridTracks(g: LayoutGrid, extent: number): GridTrack[] {
  if (g.type === 'grid') return [];
  const count = Math.max(0, Math.floor(g.count));
  if (count === 0 || extent <= 0) return [];
  const gutter = Math.max(0, g.gutter);
  const totalGutter = gutter * Math.max(0, count - 1);

  if (g.alignment === 'stretch') {
    const usable = extent - g.margin * 2 - totalGutter;
    if (usable <= 0) return [];
    const size = usable / count;
    return Array.from({ length: count }, (_, i) => ({ start: g.margin + i * (size + gutter), size }));
  }

  const size = Math.max(0, g.sectionSize);
  const block = size * count + totalGutter;
  const first =
    g.alignment === 'max' ? extent - g.offset - block
    : g.alignment === 'center' ? (extent - block) / 2
    : g.offset;
  return Array.from({ length: count }, (_, i) => ({ start: first + i * (size + gutter), size }));
}

/** Line offsets for a uniform square grid across `extent` px. */
export function gridLines(g: LayoutGrid, extent: number): number[] {
  const step = Math.max(1, g.size);
  const out: number[] = [];
  for (let v = step; v < extent; v += step) out.push(v);
  return out;
}

/**
 * Snap positions a layout grid contributes on its own axis, in absolute document
 * coordinates: both edges of every track (or every line of a uniform grid).
 */
export function gridSnapPositions(g: LayoutGrid, origin: number, extent: number): number[] {
  if (!g.visible) return [];
  if (g.type === 'grid') return gridLines(g, extent).map(v => origin + v);
  return gridTracks(g, extent).flatMap(t => [origin + t.start, origin + t.start + t.size]);
}
