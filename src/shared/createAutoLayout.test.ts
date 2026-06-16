import { describe, it, expect } from 'vitest';
import { createAutoLayoutFromSelection } from './createAutoLayout';
import type { Page, Shape, ChangeOp } from './types';

const fixedIdSeq = () => { let n = 0; return () => `id-${++n}`; };

function rect(props: Partial<Shape> & { id: string; x: number; y: number; width: number; height: number; parentId?: string | null }): Shape {
  return {
    id: props.id,
    type: 'rect',
    name: 'Rect',
    x: props.x, y: props.y, width: props.width, height: props.height,
    rotation: 0,
    transform: [1, 0, 0, 1, 0, 0],
    parentId: props.parentId ?? null,
    frameId: '',
    childIds: [],
    hidden: false, locked: false, blocked: false, opacity: 1, blendMode: 'normal',
    fills: [], strokes: [], shadows: [], blur: null,
    clipContent: false,
    selrect: { x: props.x, y: props.y, width: props.width, height: props.height },
  };
}

function makePage(shapes: Shape[], rootIds?: string[]): Page {
  const objects: Record<string, Shape> = {};
  for (const s of shapes) objects[s.id] = s;
  return {
    id: 'p1', name: 'Page 1', background: '#FFFFFF',
    childIds: rootIds ?? shapes.filter(s => !s.parentId).map(s => s.id),
    objects,
  };
}

describe('createAutoLayoutFromSelection', () => {
  it('detects horizontal direction when shapes are spread along X', () => {
    const a = rect({ id: 'a', x: 0,   y: 50, width: 40, height: 40 });
    const b = rect({ id: 'b', x: 60,  y: 50, width: 40, height: 40 });
    const c = rect({ id: 'c', x: 120, y: 50, width: 40, height: 40 });
    const page = makePage([a, b, c]);
    const plan = createAutoLayoutFromSelection(page, ['a', 'b', 'c'], fixedIdSeq())!;
    const addOp = plan.ops[0] as ChangeOp & { op: 'add'; shape: Shape };
    expect(addOp.op).toBe('add');
    expect(addOp.shape.autoLayout!.direction).toBe('horizontal');
    // Gaps: 60-40 = 20 between A-B, 120-100 = 20 between B-C → avg 20
    expect(addOp.shape.autoLayout!.spacing).toBe(20);
  });

  it('detects vertical direction when shapes are spread along Y', () => {
    const a = rect({ id: 'a', x: 50, y: 0,   width: 40, height: 40 });
    const b = rect({ id: 'b', x: 50, y: 60,  width: 40, height: 40 });
    const c = rect({ id: 'c', x: 50, y: 120, width: 40, height: 40 });
    const plan = createAutoLayoutFromSelection(makePage([a, b, c]), ['a', 'b', 'c'], fixedIdSeq())!;
    const shape = (plan.ops[0] as ChangeOp & { op: 'add'; shape: Shape }).shape;
    expect(shape.autoLayout!.direction).toBe('vertical');
    expect(shape.autoLayout!.spacing).toBe(20);
  });

  it('uses the selection bounding box as the new frame bounds', () => {
    const a = rect({ id: 'a', x: 10, y: 20, width: 40, height: 30 });
    const b = rect({ id: 'b', x: 80, y: 20, width: 40, height: 50 });
    const plan = createAutoLayoutFromSelection(makePage([a, b]), ['a', 'b'], fixedIdSeq())!;
    const shape = (plan.ops[0] as ChangeOp & { op: 'add'; shape: Shape }).shape;
    expect(shape.x).toBe(10);
    expect(shape.y).toBe(20);
    expect(shape.width).toBe(110); // 80+40-10
    expect(shape.height).toBe(50); // 20+50-20
  });

  it('moves shapes in z-order (parent childIds order)', () => {
    const a = rect({ id: 'a', x: 0, y: 0, width: 40, height: 40 });
    const b = rect({ id: 'b', x: 60, y: 0, width: 40, height: 40 });
    const c = rect({ id: 'c', x: 120, y: 0, width: 40, height: 40 });
    // Selection given out of order: ['c', 'a', 'b']. Parent z-order = [a, b, c].
    const plan = createAutoLayoutFromSelection(makePage([a, b, c]), ['c', 'a', 'b'], fixedIdSeq())!;
    const moves = plan.ops.filter(o => o.op === 'move') as Extract<ChangeOp, { op: 'move' }>[];
    expect(moves.map(m => m.id)).toEqual(['a', 'b', 'c']);
    expect(moves.map(m => m.index)).toEqual([0, 1, 2]);
  });

  it('detects centered cross alignment when children share their centers', () => {
    // Horizontal layout, children with different heights but same vertical centers
    const a = rect({ id: 'a', x: 0,  y: 30, width: 40, height: 40 });   // center y=50
    const b = rect({ id: 'b', x: 60, y: 40, width: 40, height: 20 });   // center y=50
    const plan = createAutoLayoutFromSelection(makePage([a, b]), ['a', 'b'], fixedIdSeq())!;
    const shape = (plan.ops[0] as ChangeOp & { op: 'add'; shape: Shape }).shape;
    expect(shape.autoLayout!.alignItems).toBe('center');
  });

  it('returns null when shapes have different parents', () => {
    const outer = rect({ id: 'outer', x: 0, y: 0, width: 100, height: 100, parentId: null });
    outer.childIds = ['a'];
    const a = rect({ id: 'a', x: 0, y: 0, width: 40, height: 40, parentId: 'outer' });
    const b = rect({ id: 'b', x: 60, y: 0, width: 40, height: 40, parentId: null });
    const page = makePage([outer, a, b], ['outer', 'b']);
    const plan = createAutoLayoutFromSelection(page, ['a', 'b'], fixedIdSeq());
    expect(plan).toBeNull();
  });

  it('container is created with sizing=hug so it shrink-wraps the children', () => {
    const a = rect({ id: 'a', x: 0, y: 0, width: 40, height: 40 });
    const b = rect({ id: 'b', x: 60, y: 0, width: 40, height: 40 });
    const plan = createAutoLayoutFromSelection(makePage([a, b]), ['a', 'b'], fixedIdSeq())!;
    const shape = (plan.ops[0] as ChangeOp & { op: 'add'; shape: Shape }).shape;
    expect(shape.widthMode).toBe('hug');
    expect(shape.heightMode).toBe('hug');
    expect(shape.autoLayout!.justifyContent).toBe('start');
  });
});

