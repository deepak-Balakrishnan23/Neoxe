import { describe, it, expect } from 'vitest';
import { shapeToSegments, toLocal, segmentsBounds } from './flatten';
import { Shape, makeDefaultShape } from './types';

const rect = (over: Partial<Shape> = {}) => makeDefaultShape({
  id: 'r', type: 'rect', name: 'r', frameId: 'f', x: 10, y: 20, width: 100, height: 50, ...over,
});

describe('flatten geometry', () => {
  it('emits a square-cornered rect as four lines in absolute coordinates', () => {
    const segs = shapeToSegments(rect(), {});
    expect(segs.map(s => s.verb)).toEqual(['M', 'L', 'L', 'L', 'Z']);
    expect(segs[0].coords).toEqual([10, 20]);
    expect(segs[2].coords).toEqual([110, 70]);
  });

  it('rounds corners with cubics when a radius is set', () => {
    const segs = shapeToSegments(rect({ cornerRadii: { tl: 8, tr: 8, br: 8, bl: 8 } }), {});
    expect(segs.filter(s => s.verb === 'C')).toHaveLength(4);
    expect(segs[0].coords).toEqual([18, 20]); // starts after the top-left radius
  });

  it('emits an ellipse as four cubics', () => {
    const segs = shapeToSegments(rect({ type: 'circle' }), {});
    expect(segs.filter(s => s.verb === 'C')).toHaveLength(4);
  });

  it('lifts a path\'s local content into absolute coordinates', () => {
    const p = rect({ type: 'path', content: [{ verb: 'M', coords: [0, 0] }, { verb: 'L', coords: [5, 5] }] });
    expect(shapeToSegments(p, {}).map(s => s.coords)).toEqual([[10, 20], [15, 25]]);
  });

  it('gathers a group\'s children', () => {
    const child = rect({ id: 'c', x: 0, y: 0, width: 10, height: 10 });
    const group = rect({ id: 'g', type: 'group', childIds: ['c'] });
    const segs = shapeToSegments(group, { c: child });
    expect(segs[0].coords).toEqual([0, 0]);
  });

  it('skips shapes with no path form', () => {
    expect(shapeToSegments(rect({ type: 'text' }), {})).toEqual([]);
    expect(shapeToSegments(rect({ type: 'image' }), {})).toEqual([]);
  });

  it('bounds and local translation round-trip', () => {
    const segs = shapeToSegments(rect(), {});
    const b = segmentsBounds(segs)!;
    expect(b).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(toLocal(segs, b.x, b.y)[0].coords).toEqual([0, 0]);
  });
});
