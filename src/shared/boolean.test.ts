import { describe, it, expect } from 'vitest';
import { segmentsToRings, booleanSegments } from './boolean';
import { PathSegment } from './types';
import { shapeToSegments, segmentsBounds } from './flatten';
import { makeDefaultShape } from './types';

const box = (x: number, y: number, w: number, h: number): PathSegment[] => [
  { verb: 'M', coords: [x, y] },
  { verb: 'L', coords: [x + w, y] },
  { verb: 'L', coords: [x + w, y + h] },
  { verb: 'L', coords: [x, y + h] },
  { verb: 'Z', coords: [] },
];

// Shoelace area of the first ring, as a quick "is the result the right size" check.
function area(segments: PathSegment[]): number {
  const rings = segmentsToRings(segments);
  let total = 0;
  for (const ring of rings) {
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    total += Math.abs(a) / 2;
  }
  return total;
}

describe('boolean geometry', () => {
  const a = box(0, 0, 100, 100);
  const b = box(50, 50, 100, 100);

  it('union covers both squares minus the shared corner', () => {
    expect(area(booleanSegments('union', [a, b])!)).toBeCloseTo(100 * 100 * 2 - 50 * 50, 4);
  });

  it('intersection is just the overlap', () => {
    expect(area(booleanSegments('intersection', [a, b])!)).toBeCloseTo(50 * 50, 4);
  });

  it('difference removes the overlap from the first operand only', () => {
    expect(area(booleanSegments('difference', [a, b])!)).toBeCloseTo(100 * 100 - 50 * 50, 4);
  });

  it('exclusion drops the overlap from both', () => {
    expect(area(booleanSegments('exclusion', [a, b])!)).toBeCloseTo(100 * 100 * 2 - 2 * 50 * 50, 4);
  });

  it('non-overlapping shapes union into two separate rings', () => {
    const far = box(500, 500, 10, 10);
    const segs = booleanSegments('union', [a, far])!;
    expect(segmentsToRings(segs)).toHaveLength(2);
  });

  it('subtracting a covering shape leaves nothing', () => {
    expect(booleanSegments('difference', [a, box(-10, -10, 200, 200)])).toEqual([]);
  });

  it('flattens curves closely enough to measure an ellipse', () => {
    const ellipse = makeDefaultShape({ id: 'e', type: 'circle', name: 'e', frameId: 'e', x: 0, y: 0, width: 100, height: 100 });
    const segs = shapeToSegments(ellipse, {});
    // π·50² ≈ 7854; the flattened polygon is inscribed, so it comes in slightly under.
    expect(area(segs)).toBeGreaterThan(7800);
    expect(area(segs)).toBeLessThan(7860);
  });

  it('reports bounds of the combined result', () => {
    const segs = booleanSegments('union', [a, b])!;
    expect(segmentsBounds(segs)).toEqual({ x: 0, y: 0, width: 150, height: 150 });
  });

  it('returns null when there is nothing to combine', () => {
    expect(booleanSegments('union', [a])).toBeNull();
  });
});
