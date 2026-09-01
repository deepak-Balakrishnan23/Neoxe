import { describe, it, expect } from 'vitest';
import { constraintOps, Constraints } from './constraints';
import { Shape, makeDefaultShape } from './types';

// A 400×300 frame at (0,0) with one child, positioned so both gaps are distinct:
// child at (40, 30), 100×50 → left gap 40, right gap 260, top gap 30, bottom gap 220.
function scene(constraints?: Constraints) {
  const frame = makeDefaultShape({ id: 'F', type: 'frame', name: 'F', frameId: 'F', width: 400, height: 300 });
  frame.childIds = ['C'];
  const child = makeDefaultShape({ id: 'C', type: 'rect', name: 'C', frameId: 'F', parentId: 'F', x: 40, y: 30, width: 100, height: 50 });
  if (constraints) child.constraints = constraints;
  const objects: Record<string, Shape> = { F: frame, C: child };
  return { objects };
}

// Fold the emitted ops into a box so assertions read as a rect.
function boxAfter(page: { objects: Record<string, Shape> }, before: { x: number; y: number; width: number; height: number }, after: { x: number; y: number; width: number; height: number }) {
  const c = page.objects['C'];
  const box = { x: c.x, y: c.y, width: c.width, height: c.height };
  for (const op of constraintOps(page, 'F', before, after)) {
    if (op.op === 'set' && op.id === 'C') (box as unknown as Record<string, number>)[op.attr] = op.val as number;
  }
  return box;
}

const BEFORE = { x: 0, y: 0, width: 400, height: 300 };
const WIDER = { x: 0, y: 0, width: 600, height: 300 };

describe('resize constraints', () => {
  it('defaults to pinning the left/top edges', () => {
    expect(boxAfter(scene(), BEFORE, WIDER)).toEqual({ x: 40, y: 30, width: 100, height: 50 });
  });

  it('max keeps the gap to the right edge', () => {
    // right gap 260 must survive: 600 - 260 - 100 = 240
    expect(boxAfter(scene({ horizontal: 'max', vertical: 'min' }), BEFORE, WIDER).x).toBe(240);
  });

  it('stretch keeps both gaps and resizes the child', () => {
    const b = boxAfter(scene({ horizontal: 'stretch', vertical: 'min' }), BEFORE, WIDER);
    expect(b.x).toBe(40);
    expect(b.width).toBe(300); // 600 - 40 - 260
  });

  it('center keeps the offset from the container centre', () => {
    // child centre 90, container centre 200 → offset -110; new centre 300 - 110 = 190
    const b = boxAfter(scene({ horizontal: 'center', vertical: 'min' }), BEFORE, WIDER);
    expect(b.x + b.width / 2).toBe(190);
    expect(b.width).toBe(100);
  });

  it('scale scales offset and size proportionally', () => {
    const b = boxAfter(scene({ horizontal: 'scale', vertical: 'min' }), BEFORE, WIDER);
    expect(b.x).toBe(60);     // 40 × 1.5
    expect(b.width).toBe(150); // 100 × 1.5
  });

  it('follows a moving edge — dragging the left handle carries left-pinned children', () => {
    // Left handle dragged 100px left: frame becomes x=-100, width=500.
    const b = boxAfter(scene(), BEFORE, { x: -100, y: 0, width: 500, height: 300 });
    expect(b.x).toBe(-60); // keeps its 40px gap to the (moved) left edge
  });

  it('vertical axis resolves independently of horizontal', () => {
    const b = boxAfter(scene({ horizontal: 'min', vertical: 'max' }), BEFORE, { x: 0, y: 0, width: 400, height: 500 });
    expect(b.y).toBe(230); // 500 - 220 - 50
    expect(b.x).toBe(40);
  });

  it('emits nothing when the container only moves', () => {
    expect(constraintOps(scene(), 'F', BEFORE, { x: 50, y: 50, width: 400, height: 300 })).toEqual([]);
  });

  it('skips children the auto-layout engine owns, but not absolute ones', () => {
    const page = scene({ horizontal: 'max', vertical: 'min' });
    page.objects['F'].autoLayout = {
      direction: 'horizontal', padding: { top: 0, right: 0, bottom: 0, left: 0 },
      justifyContent: 'start', alignItems: 'start',
    };
    expect(constraintOps(page, 'F', BEFORE, WIDER)).toEqual([]);
    page.objects['C'].layoutPositioning = 'absolute';
    expect(constraintOps(page, 'F', BEFORE, WIDER).length).toBeGreaterThan(0);
  });
});
