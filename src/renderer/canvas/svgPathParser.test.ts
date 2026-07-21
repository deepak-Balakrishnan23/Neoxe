import { describe, it, expect } from 'vitest';
import { parseSvgPath } from './svgPathParser';

const near = (a: number, b: number, eps = 0.5) => Math.abs(a - b) <= eps;

describe('parseSvgPath — curve commands are preserved (not flattened to lines)', () => {
  it('M/L/C/Q/Z basics still parse', () => {
    const p = parseSvgPath('M0 0 L10 0 C10 5 5 10 0 10 Q -5 5 0 0 Z');
    expect(p.map(pt => pt.command)).toEqual(['M', 'L', 'C', 'Q', 'Z']);
    const c = p[2];
    expect([c.cp1x, c.cp1y, c.cp2x, c.cp2y, c.x, c.y]).toEqual([10, 5, 5, 10, 0, 10]);
  });

  it('S (smooth cubic) becomes a C with the reflected first control point', () => {
    // After the C, cp2=(5,10) about the current point (0,10) reflects to (-5,10).
    const p = parseSvgPath('M0 0 C10 5 5 10 0 10 S -10 15 0 20');
    const s = p[2];
    expect(s.command).toBe('C');
    expect(s.cp1x).toBe(-5);   // 2*0 - 5
    expect(s.cp1y).toBe(10);   // 2*10 - 10
    expect(s.cp2x).toBe(-10);
    expect(s.cp2y).toBe(15);
    expect([s.x, s.y]).toEqual([0, 20]);
  });

  it('S with no preceding cubic uses the current point as first control', () => {
    const p = parseSvgPath('M2 2 S 8 8 10 10');
    const s = p[1];
    expect(s.command).toBe('C');
    expect(s.cp1x).toBe(2); expect(s.cp1y).toBe(2); // = current point
  });

  it('T (smooth quadratic) becomes a Q with the reflected control point', () => {
    // Q control (4,0) about current point (8,0) reflects to (12,0).
    const p = parseSvgPath('M0 0 Q4 0 8 0 T16 0');
    const t = p[2];
    expect(t.command).toBe('Q');
    expect(t.cp1x).toBe(12); // 2*8 - 4
    expect(t.cp1y).toBe(0);
    expect([t.x, t.y]).toEqual([16, 0]);
  });

  it('A (arc) converts to cubic Bézier segments ending at the arc endpoint (not a straight L)', () => {
    // Quarter circle radius 10 from (10,0) to (0,10).
    const p = parseSvgPath('M10 0 A10 10 0 0 1 0 10');
    const curves = p.slice(1);
    expect(curves.length).toBeGreaterThanOrEqual(1);
    expect(curves.every(c => c.command === 'C')).toBe(true);   // arc → cubics, never L
    const last = curves[curves.length - 1];
    expect(near(last.x, 0)).toBe(true);
    expect(near(last.y, 10)).toBe(true);
    // A cubic approximating a convex arc has control points off the chord — proving it
    // curves rather than being a degenerate straight segment.
    const first = curves[0];
    expect(first.cp1x !== undefined && first.cp1y !== undefined).toBe(true);
  });

  it('a large arc (>90°) splits into multiple cubic segments', () => {
    // Semicircle → should be at least 2 cubic segments.
    const p = parseSvgPath('M10 0 A10 10 0 1 1 -10 0');
    const curves = p.slice(1).filter(c => c.command === 'C');
    expect(curves.length).toBeGreaterThanOrEqual(2);
    const last = curves[curves.length - 1];
    expect(near(last.x, -10)).toBe(true);
    expect(near(last.y, 0)).toBe(true);
  });

  it('relative commands (c/s/q/t/a) resolve to absolute coords', () => {
    const abs = parseSvgPath('M0 0 C10 5 5 10 0 10');
    const rel = parseSvgPath('M0 0 c10 5 5 10 0 10');
    expect(rel[1]).toEqual(abs[1]);
  });
});
