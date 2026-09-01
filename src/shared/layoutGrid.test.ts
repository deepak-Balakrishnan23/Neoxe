import { describe, it, expect } from 'vitest';
import { gridTracks, gridLines, gridSnapPositions } from './layoutGrid';
import { LayoutGrid, makeDefaultLayoutGrid } from './types';

const grid = (patch: Partial<LayoutGrid>): LayoutGrid => ({ ...makeDefaultLayoutGrid('columns', 'g'), ...patch });

describe('layout grid tracks', () => {
  it('stretch divides the frame minus margins and gutters', () => {
    // 800 − 2×40 margin − 3×20 gutter = 660 over 4 columns = 165 each
    const t = gridTracks(grid({ count: 4, gutter: 20, margin: 40, alignment: 'stretch' }), 800);
    expect(t).toHaveLength(4);
    expect(t[0]).toEqual({ start: 40, size: 165 });
    expect(t[3].start + t[3].size).toBe(760);
  });

  it('min lays fixed tracks from the start edge at the offset', () => {
    const t = gridTracks(grid({ count: 3, gutter: 10, sectionSize: 100, offset: 25, alignment: 'min' }), 800);
    expect(t.map(x => x.start)).toEqual([25, 135, 245]);
    expect(t.every(x => x.size === 100)).toBe(true);
  });

  it('max anchors the block to the end edge', () => {
    // block = 3×100 + 2×10 = 320; ends 25 short of 800 → starts at 455
    const t = gridTracks(grid({ count: 3, gutter: 10, sectionSize: 100, offset: 25, alignment: 'max' }), 800);
    expect(t[0].start).toBe(455);
    expect(t[2].start + t[2].size).toBe(775);
  });

  it('center balances the block in the frame', () => {
    const t = gridTracks(grid({ count: 2, gutter: 20, sectionSize: 100, alignment: 'center' }), 800);
    expect(t[0].start).toBe(290); // (800 − 220) / 2
  });

  it('degenerate settings produce no tracks instead of negative ones', () => {
    expect(gridTracks(grid({ count: 0 }), 800)).toEqual([]);
    expect(gridTracks(grid({ count: 4, margin: 500, alignment: 'stretch' }), 800)).toEqual([]);
    expect(gridTracks(makeDefaultLayoutGrid('grid', 'g'), 800)).toEqual([]);
  });

  it('a uniform grid emits interior lines only', () => {
    expect(gridLines(makeDefaultLayoutGrid('grid', 'g'), 24)).toEqual([8, 16]);
  });

  it('snap positions are absolute and skip hidden grids', () => {
    const g = grid({ count: 2, gutter: 20, sectionSize: 100, offset: 0, alignment: 'min' });
    expect(gridSnapPositions(g, 1000, 800)).toEqual([1000, 1100, 1120, 1220]);
    expect(gridSnapPositions({ ...g, visible: false }, 1000, 800)).toEqual([]);
  });
});
