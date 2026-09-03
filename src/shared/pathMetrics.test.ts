import { describe, it, expect } from 'vitest';
import { flattenPath, pointAtDistance, simplifyPoints, pointsToSmoothPath, arrowHead, ellipsePath, textBaseline } from './pathMetrics';
import { PathSegment } from './types';

const line = (x1: number, y1: number, x2: number, y2: number): PathSegment[] => [
  { verb: 'M', coords: [x1, y1] },
  { verb: 'L', coords: [x2, y2] },
];

describe('flattenPath', () => {
  it('measures a straight line exactly', () => {
    const pl = flattenPath(line(0, 0, 100, 0));
    expect(pl.length).toBeCloseTo(100, 6);
    expect(pl.cum[0]).toBe(0);
  });

  it('measures a 3-4-5 diagonal', () => {
    expect(flattenPath(line(0, 0, 30, 40)).length).toBeCloseTo(50, 6);
  });

  it('approximates a quarter-circle cubic to within 0.1%', () => {
    // Standard circle approximation constant.
    const k = 0.5522847498;
    const r = 100;
    const segs: PathSegment[] = [
      { verb: 'M', coords: [r, 0] },
      { verb: 'C', coords: [r, r * k, r * k, r, 0, r] },
    ];
    const expected = (Math.PI * r) / 2;
    expect(flattenPath(segs).length).toBeCloseTo(expected, 0);
    expect(Math.abs(flattenPath(segs).length - expected) / expected).toBeLessThan(0.001);
  });

  it('closes the subpath on Z', () => {
    const segs: PathSegment[] = [
      { verb: 'M', coords: [0, 0] },
      { verb: 'L', coords: [10, 0] },
      { verb: 'L', coords: [10, 10] },
      { verb: 'Z', coords: [] },
    ];
    // 10 across + 10 down + hypotenuse back to origin.
    expect(flattenPath(segs).length).toBeCloseTo(20 + Math.hypot(10, 10), 6);
  });

  it('drops duplicate vertices so a zero-length step cannot make a NaN tangent', () => {
    const segs: PathSegment[] = [
      { verb: 'M', coords: [5, 5] },
      { verb: 'L', coords: [5, 5] },
      { verb: 'L', coords: [15, 5] },
    ];
    const pl = flattenPath(segs);
    expect(pl.pts).toEqual([5, 5, 15, 5]);
    expect(pl.length).toBeCloseTo(10, 6);
  });
});

describe('pointAtDistance', () => {
  it('walks a horizontal line and reports a zero tangent', () => {
    const pl = flattenPath(line(0, 0, 100, 0));
    const p = pointAtDistance(pl, 25)!;
    expect(p.x).toBeCloseTo(25, 6);
    expect(p.y).toBeCloseTo(0, 6);
    expect(p.angle).toBeCloseTo(0, 6);
  });

  it('reports a quarter-turn tangent on a vertical line', () => {
    const p = pointAtDistance(flattenPath(line(0, 0, 0, 50)), 10)!;
    expect(p.angle).toBeCloseTo(Math.PI / 2, 6);
  });

  it('extends past the end along the final tangent rather than piling up', () => {
    const pl = flattenPath(line(0, 0, 100, 0));
    const p = pointAtDistance(pl, 140)!;
    expect(p.x).toBeCloseTo(140, 6);
    expect(p.y).toBeCloseTo(0, 6);
  });

  it('extends before the start too', () => {
    const p = pointAtDistance(flattenPath(line(0, 0, 100, 0)), -20)!;
    expect(p.x).toBeCloseTo(-20, 6);
  });

  it('is monotonic in x along a left-to-right curve', () => {
    const segs: PathSegment[] = [
      { verb: 'M', coords: [0, 0] },
      { verb: 'C', coords: [50, -60, 150, 60, 200, 0] },
    ];
    const pl = flattenPath(segs);
    let prev = -Infinity;
    for (let d = 0; d <= pl.length; d += pl.length / 40) {
      const p = pointAtDistance(pl, d)!;
      expect(p.x).toBeGreaterThan(prev);
      prev = p.x;
    }
  });

  it('returns null for an empty path', () => {
    expect(pointAtDistance(flattenPath([]), 0)).toBeNull();
  });
});

describe('simplifyPoints', () => {
  it('reduces a straight run to its endpoints', () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i * 2, y: 0 }));
    expect(simplifyPoints(pts, 1)).toEqual([{ x: 0, y: 0 }, { x: 98, y: 0 }]);
  });

  it('keeps a corner that exceeds the tolerance', () => {
    const pts = [{ x: 0, y: 0 }, { x: 50, y: 40 }, { x: 100, y: 0 }];
    expect(simplifyPoints(pts, 2)).toHaveLength(3);
  });

  it('drops a wobble that stays inside the tolerance', () => {
    const pts = [{ x: 0, y: 0 }, { x: 50, y: 0.5 }, { x: 100, y: 0 }];
    expect(simplifyPoints(pts, 2)).toHaveLength(2);
  });

  it('survives a long stroke without blowing the call stack', () => {
    const pts = Array.from({ length: 60000 }, (_, i) => ({ x: i, y: Math.sin(i / 25) * 60 }));
    expect(() => simplifyPoints(pts, 1)).not.toThrow();
    expect(simplifyPoints(pts, 1).length).toBeLessThan(pts.length);
  });

  it('always preserves the first and last point', () => {
    const pts = [{ x: 3, y: 4 }, { x: 10, y: 4.2 }, { x: 20, y: 4 }];
    const out = simplifyPoints(pts, 50);
    expect(out[0]).toEqual({ x: 3, y: 4 });
    expect(out[out.length - 1]).toEqual({ x: 20, y: 4 });
  });
});

describe('pointsToSmoothPath', () => {
  it('emits a bare move for a single point', () => {
    expect(pointsToSmoothPath([{ x: 1, y: 2 }])).toEqual([{ verb: 'M', coords: [1, 2] }]);
  });

  it('emits a straight line for two points', () => {
    const out = pointsToSmoothPath([{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    expect(out.map(s => s.verb)).toEqual(['M', 'L']);
  });

  it('emits one cubic per gap for three or more points', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }, { x: 30, y: 10 }];
    const out = pointsToSmoothPath(pts);
    expect(out.map(s => s.verb)).toEqual(['M', 'C', 'C', 'C']);
  });

  it('passes through every input point', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }];
    const out = pointsToSmoothPath(pts);
    // Each cubic ends on the next input point.
    expect(out[1].coords.slice(4)).toEqual([10, 10]);
    expect(out[2].coords.slice(4)).toEqual([20, 0]);
  });

  it('produces a path the flattener can measure', () => {
    const pts = [{ x: 0, y: 0 }, { x: 50, y: 20 }, { x: 100, y: 0 }];
    const len = flattenPath(pointsToSmoothPath(pts)).length;
    expect(len).toBeGreaterThan(100);
    expect(Number.isFinite(len)).toBe(true);
  });
});

describe('arrowHead', () => {
  const horiz = flattenPath(line(0, 0, 100, 0));

  it('puts the tip on the path end and both corners behind it', () => {
    const tri = arrowHead(horiz, true, 10)!;
    expect(tri).toHaveLength(3);
    expect(tri[0].x).toBeCloseTo(100, 6);
    expect(tri[0].y).toBeCloseTo(0, 6);
    // Corners sit back along -x, symmetric about the axis.
    expect(tri[1].x).toBeLessThan(100);
    expect(tri[2].x).toBeLessThan(100);
    expect(tri[1].y).toBeCloseTo(-tri[2].y, 6);
  });

  it('points the start head the opposite way', () => {
    const tri = arrowHead(horiz, false, 10)!;
    expect(tri[0].x).toBeCloseTo(0, 6);
    // Head at the start points back along -x, so its corners are to the RIGHT of the tip.
    expect(tri[1].x).toBeGreaterThan(0);
    expect(tri[2].x).toBeGreaterThan(0);
  });

  it('scales with size', () => {
    const small = arrowHead(horiz, true, 10)!;
    const big = arrowHead(horiz, true, 40)!;
    const spread = (t: ReturnType<typeof arrowHead>) => Math.abs(t![1].y - t![2].y);
    expect(spread(big)).toBeCloseTo(spread(small) * 4, 4);
  });

  it('follows the tangent of a vertical path', () => {
    const tri = arrowHead(flattenPath(line(0, 0, 0, 100)), true, 10)!;
    expect(tri[0].y).toBeCloseTo(100, 6);
    // Both corners sit above the tip (smaller y) for a downward path.
    expect(tri[1].y).toBeLessThan(100);
    expect(tri[2].y).toBeLessThan(100);
  });

  it('has non-zero area, so it renders as a visible triangle', () => {
    const [a, b, c] = arrowHead(horiz, true, 10)!;
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    expect(area).toBeGreaterThan(20);
  });

  it('returns null for a degenerate path or non-positive size', () => {
    expect(arrowHead(flattenPath([]), true, 10)).toBeNull();
    expect(arrowHead(horiz, true, 0)).toBeNull();
  });
});

describe('ellipsePath / textBaseline', () => {
  it('starts at top-centre and closes', () => {
    const p = ellipsePath(200, 100);
    expect(p[0]).toEqual({ verb: 'M', coords: [100, 0] });
    expect(p[p.length - 1].verb).toBe('Z');
  });

  it('runs clockwise: the first curve heads right', () => {
    // Clockwise from the top means x increases before y does.
    const p = ellipsePath(200, 100);
    const firstCurveEnd = p[1].coords.slice(4);
    expect(firstCurveEnd[0]).toBeCloseTo(200, 6); // right edge
    expect(firstCurveEnd[1]).toBeCloseTo(50, 6);  // vertical middle
  });

  it('approximates the circumference of a circle', () => {
    const r = 100;
    const len = flattenPath(ellipsePath(2 * r, 2 * r)).length;
    expect(Math.abs(len - 2 * Math.PI * r) / (2 * Math.PI * r)).toBeLessThan(0.001);
  });

  it('scales with the box, so resizing reflows the text', () => {
    const small = flattenPath(ellipsePath(100, 100)).length;
    const big = flattenPath(ellipsePath(200, 200)).length;
    expect(big).toBeCloseTo(small * 2, 3);
  });

  it('textBaseline generates from the box when textPathShape is set', () => {
    const segs = textBaseline({ width: 120, height: 80, textPathShape: 'ellipse' })!;
    expect(segs[0].coords).toEqual([60, 0]);
    // An explicit textPath is ignored while the generated shape is in play.
    const both = textBaseline({ width: 120, height: 80, textPathShape: 'ellipse', textPath: [{ verb: 'M', coords: [9, 9] }, { verb: 'L', coords: [1, 1] }] })!;
    expect(both[0].coords).toEqual([60, 0]);
  });

  it('textBaseline falls back to an explicit path', () => {
    const explicit = [{ verb: 'M' as const, coords: [0, 0] }, { verb: 'L' as const, coords: [10, 0] }];
    expect(textBaseline({ width: 10, height: 0, textPath: explicit })).toBe(explicit);
  });

  it('textBaseline returns null when there is nothing to lay text on', () => {
    expect(textBaseline({ width: 0, height: 0, textPathShape: 'ellipse' })).toBeNull();
    expect(textBaseline({ width: 10, height: 10 })).toBeNull();
    expect(textBaseline({ width: 10, height: 10, textPath: [{ verb: 'M', coords: [0, 0] }] })).toBeNull();
  });
});
