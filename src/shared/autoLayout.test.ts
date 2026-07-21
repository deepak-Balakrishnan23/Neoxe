import { describe, it, expect } from 'vitest';
import {
  calculateLayout, applyAutoLayoutToPage, AutoLayoutNode, Bounds, AutoLayoutPadding,
} from './autoLayout';
import { makeDefaultShape, Page } from './types';

// Tiny factory so each test reads as a layout, not boilerplate.
const node = (n: Partial<AutoLayoutNode> = {}): AutoLayoutNode => ({
  width: 0, height: 0, ...n,
});
const leaf = (w: number, h: number, id?: string): AutoLayoutNode =>
  ({ width: w, height: h, id });

const PARENT: Bounds = { x: 0, y: 0, width: 1000, height: 800 };
const pad = (top: number, right: number, bottom: number, left: number): AutoLayoutPadding =>
  ({ top, right, bottom, left });

describe('hug contents', () => {
  it('horizontal hug: width = sum(children) + spacing + padding; height = max(children) + padding', () => {
    const container = node({
      autoLayout: true,
      direction: 'horizontal',
      widthMode: 'hug',
      heightMode: 'hug',
      spacing: 8,
      padding: pad(10, 12, 10, 12),
      children: [leaf(40, 50), leaf(60, 30), leaf(20, 70)],
    });

    const r = calculateLayout(container, PARENT);

    // width: 12 + 40 + 8 + 60 + 8 + 20 + 12 = 160
    expect(r.bounds.width).toBe(160);
    // height: 10 + max(50,30,70) + 10 = 90
    expect(r.bounds.height).toBe(90);
    // children laid out sequentially with spacing, starting at padding.left
    expect(r.children.map(c => c.bounds.x)).toEqual([12, 60, 128]);
    // children all sit at y = padding.top (start cross alignment)
    expect(r.children.map(c => c.bounds.y)).toEqual([10, 10, 10]);
  });

  it('vertical hug: height = sum + spacing + padding; width = max + padding', () => {
    const container = node({
      autoLayout: true,
      direction: 'vertical',
      widthMode: 'hug',
      heightMode: 'hug',
      spacing: 4,
      padding: pad(5, 5, 5, 5),
      children: [leaf(100, 40), leaf(60, 20)],
    });

    const r = calculateLayout(container, PARENT);

    // height: 5 + 40 + 4 + 20 + 5 = 74
    expect(r.bounds.height).toBe(74);
    // width: 5 + max(100,60) + 5 = 110
    expect(r.bounds.width).toBe(110);
    expect(r.children.map(c => c.bounds.y)).toEqual([5, 49]);
  });

  it('empty hug container collapses to just its padding', () => {
    const container = node({
      autoLayout: true,
      widthMode: 'hug',
      heightMode: 'hug',
      padding: pad(8, 16, 8, 16),
      children: [],
    });
    const r = calculateLayout(container, PARENT);
    expect(r.bounds.width).toBe(0);   // no children, hug returns declared (0)
    expect(r.bounds.height).toBe(0);
  });
});

describe('fill container', () => {
  it('fill on both axes expands to parent bounds', () => {
    const container = node({
      autoLayout: true,
      widthMode: 'fill',
      heightMode: 'fill',
      width: 100, height: 50, // intentionally ignored
      children: [leaf(20, 20)],
    });
    const r = calculateLayout(container, PARENT);
    expect(r.bounds.width).toBe(1000);
    expect(r.bounds.height).toBe(800);
  });

  it('fill children share remaining space along the primary axis', () => {
    const container = node({
      autoLayout: true,
      direction: 'horizontal',
      widthMode: 'fixed',
      heightMode: 'fixed',
      width: 400, height: 100,
      spacing: 10,
      padding: pad(0, 20, 0, 20),
      children: [
        leaf(80, 60),                                       // fixed 80
        { width: 0, height: 60, widthMode: 'fill' },       // fill — gets remainder
        { width: 0, height: 60, widthMode: 'fill' },       // fill — gets remainder
      ],
    });
    const r = calculateLayout(container, PARENT);
    // inner main = 400 - 40 = 360; minus fixed(80) and 2 gaps(20) = 260; /2 fills = 130 each
    expect(r.children.map(c => c.bounds.width)).toEqual([80, 130, 130]);
    expect(r.children.map(c => c.bounds.x)).toEqual([20, 110, 250]);
  });

  it('fill child inside hug parent collapses to its declared size', () => {
    const container = node({
      autoLayout: true,
      direction: 'horizontal',
      widthMode: 'hug',
      heightMode: 'hug',
      padding: pad(5, 5, 5, 5),
      spacing: 0,
      children: [
        leaf(40, 20),
        { width: 30, height: 20, widthMode: 'fill' },
      ],
    });
    const r = calculateLayout(container, PARENT);
    // hug width = 5 + 40 + 30 + 5 = 80 (the fill child falls back to its declared 30)
    expect(r.bounds.width).toBe(80);
    expect(r.children[1].bounds.width).toBe(30);
  });
});

describe('fixed container', () => {
  it('keeps explicit width/height unchanged regardless of children', () => {
    const container = node({
      autoLayout: true,
      widthMode: 'fixed',
      heightMode: 'fixed',
      width: 250, height: 120,
      padding: pad(0, 0, 0, 0),
      spacing: 0,
      children: [leaf(999, 999), leaf(50, 50)],
    });
    const r = calculateLayout(container, PARENT);
    expect(r.bounds.width).toBe(250);
    expect(r.bounds.height).toBe(120);
  });
});

describe('nested auto layout', () => {
  it('outer hug measures the inner hug, which in turn measures its leaves', () => {
    const inner = node({
      autoLayout: true,
      direction: 'horizontal',
      widthMode: 'hug',
      heightMode: 'hug',
      spacing: 4,
      padding: pad(2, 2, 2, 2),
      children: [leaf(20, 30), leaf(20, 30)],
    });
    // inner natural: 2 + 20 + 4 + 20 + 2 = 48 × (2+30+2) = 34

    const outer = node({
      autoLayout: true,
      direction: 'vertical',
      widthMode: 'hug',
      heightMode: 'hug',
      spacing: 6,
      padding: pad(10, 10, 10, 10),
      children: [inner, leaf(100, 10)],
    });
    const r = calculateLayout(outer, PARENT);

    // outer width = 10 + max(48, 100) + 10 = 120
    expect(r.bounds.width).toBe(120);
    // outer height = 10 + 34 + 6 + 10 + 10 = 70
    expect(r.bounds.height).toBe(70);

    // inner is placed at padding (10, 10) with width 48, height 34
    expect(r.children[0].bounds).toEqual({ x: 10, y: 10, width: 48, height: 34 });
    // inner's own children placed inside it (absolute coords)
    expect(r.children[0].children[0].bounds.x).toBe(12);   // 10 + 2 padding
    expect(r.children[0].children[1].bounds.x).toBe(36);   // 12 + 20 + 4
  });

  it('nested fill resolves against the placed parent, not the page', () => {
    // outer fixed 500×300, inner fills outer, inner's children divide the inner.
    const inner = node({
      autoLayout: true,
      direction: 'horizontal',
      widthMode: 'fill',
      heightMode: 'fill',
      width: 0, height: 0,
      padding: pad(0, 50, 0, 50),
      spacing: 20,
      children: [
        { width: 0, height: 0, widthMode: 'fill', heightMode: 'fill' },
        { width: 0, height: 0, widthMode: 'fill', heightMode: 'fill' },
      ],
    });
    const outer = node({
      autoLayout: true,
      widthMode: 'fixed',
      heightMode: 'fixed',
      width: 500, height: 300,
      children: [inner],
    });
    const r = calculateLayout(outer, PARENT);

    // inner fills outer → 500×300
    expect(r.children[0].bounds).toEqual({ x: 0, y: 0, width: 500, height: 300 });
    // inner's two fills share inner_width - 100 padding - 20 spacing = 380, half each = 190
    const gc = r.children[0].children.map(c => c.bounds);
    expect(gc[0]).toEqual({ x: 50, y: 0, width: 190, height: 300 });
    expect(gc[1]).toEqual({ x: 260, y: 0, width: 190, height: 300 });
  });
});

describe('spacing changes', () => {
  it('increasing spacing increases hug width and shifts children right (horizontal)', () => {
    const base = node({
      autoLayout: true, direction: 'horizontal',
      widthMode: 'hug', heightMode: 'hug',
      padding: pad(0, 0, 0, 0),
      children: [leaf(10, 10), leaf(10, 10), leaf(10, 10)],
    });
    const spacing0 = calculateLayout({ ...base, spacing: 0 }, PARENT);
    const spacing20 = calculateLayout({ ...base, spacing: 20 }, PARENT);

    expect(spacing0.bounds.width).toBe(30);
    expect(spacing20.bounds.width).toBe(70); // 10 + 20 + 10 + 20 + 10
    expect(spacing0.children.map(c => c.bounds.x)).toEqual([0, 10, 20]);
    expect(spacing20.children.map(c => c.bounds.x)).toEqual([0, 30, 60]);
  });

  it('spacing does not affect cross-axis size or position', () => {
    const r = calculateLayout(node({
      autoLayout: true, direction: 'horizontal',
      widthMode: 'hug', heightMode: 'hug',
      spacing: 50,
      children: [leaf(10, 30), leaf(10, 30)],
    }), PARENT);
    expect(r.bounds.height).toBe(30);
    expect(r.children.map(c => c.bounds.y)).toEqual([0, 0]);
  });
});

describe('padding changes', () => {
  it('padding insets the content box and grows the hug container by exactly that much', () => {
    const base: AutoLayoutNode = {
      width: 0, height: 0,
      autoLayout: true, direction: 'horizontal',
      widthMode: 'hug', heightMode: 'hug',
      spacing: 0,
      children: [leaf(40, 20)],
    };
    const p0 = calculateLayout({ ...base, padding: pad(0, 0, 0, 0) }, PARENT);
    const p10 = calculateLayout({ ...base, padding: pad(10, 10, 10, 10) }, PARENT);

    expect(p0.bounds.width).toBe(40);
    expect(p0.bounds.height).toBe(20);
    expect(p10.bounds.width).toBe(60);   // +10 +10
    expect(p10.bounds.height).toBe(40);  // +10 +10
    expect(p10.children[0].bounds).toEqual({ x: 10, y: 10, width: 40, height: 20 });
  });

  it('asymmetric padding shifts content correctly', () => {
    const r = calculateLayout(node({
      autoLayout: true, direction: 'horizontal',
      widthMode: 'fixed', heightMode: 'fixed',
      width: 200, height: 100,
      padding: pad(5, 0, 0, 35),
      children: [leaf(50, 50)],
    }), PARENT);
    expect(r.children[0].bounds.x).toBe(35); // shifted by padding.left
    expect(r.children[0].bounds.y).toBe(5);  // shifted by padding.top
  });
});

describe('alignment', () => {
  it('center aligns the content block in the leftover space (no fills)', () => {
    const r = calculateLayout(node({
      autoLayout: true, direction: 'horizontal',
      widthMode: 'fixed', heightMode: 'fixed',
      width: 300, height: 50,
      spacing: 0, padding: pad(0, 0, 0, 0),
      justifyContent: 'center',
      children: [leaf(50, 50), leaf(50, 50)], // total 100, slack 200
    }), PARENT);
    expect(r.children[0].bounds.x).toBe(100); // (300-100)/2
    expect(r.children[1].bounds.x).toBe(150);
  });

  it('end aligns to the trailing edge of the content box', () => {
    const r = calculateLayout(node({
      autoLayout: true, direction: 'horizontal',
      widthMode: 'fixed', heightMode: 'fixed',
      width: 200, height: 50, spacing: 0,
      padding: pad(0, 10, 0, 10),
      justifyContent: 'end',
      children: [leaf(50, 50)],
    }), PARENT);
    // inner main = 180; slack = 130; child starts at 10 + 130 = 140
    expect(r.children[0].bounds.x).toBe(140);
  });

  it('space-between distributes remaining space evenly between children', () => {
    const r = calculateLayout(node({
      autoLayout: true, direction: 'horizontal',
      widthMode: 'fixed', heightMode: 'fixed',
      width: 300, height: 50, spacing: 0,
      padding: pad(0, 0, 0, 0),
      justifyContent: 'space-between',
      children: [leaf(50, 50), leaf(50, 50), leaf(50, 50)],
    }), PARENT);
    // total children = 150, slack = 150, between = 75 between 2 gaps
    expect(r.children.map(c => c.bounds.x)).toEqual([0, 125, 250]);
  });

  it('space-around: half-slot leading + full slot between each pair', () => {
    const r = calculateLayout(node({
      autoLayout: true, direction: 'horizontal',
      widthMode: 'fixed', heightMode: 'fixed',
      width: 300, height: 50, spacing: 0,
      padding: pad(0, 0, 0, 0),
      justifyContent: 'space-around',
      children: [leaf(50, 50), leaf(50, 50), leaf(50, 50)],
    }), PARENT);
    // total children = 150, slack = 150, around = 50; leading = 25, between = 50
    // positions: 25, 25 + 50 + 50 = 125, 125 + 50 + 50 = 225
    expect(r.children.map(c => c.bounds.x)).toEqual([25, 125, 225]);
  });

  it('space-evenly: equal slot at the ends and between each pair', () => {
    const r = calculateLayout(node({
      autoLayout: true, direction: 'horizontal',
      widthMode: 'fixed', heightMode: 'fixed',
      width: 300, height: 50, spacing: 0,
      padding: pad(0, 0, 0, 0),
      justifyContent: 'space-evenly',
      children: [leaf(50, 50), leaf(50, 50), leaf(50, 50)],
    }), PARENT);
    // slack = 150, evenly = 150/4 = 37.5; positions = 37.5, 37.5 + 50 + 37.5 = 125,
    // 125 + 50 + 37.5 = 212.5
    expect(r.children.map(c => c.bounds.x)).toEqual([37.5, 125, 212.5]);
  });

  it('configured spacing is preserved as a minimum and added on top of the distribution', () => {
    // spacing: 10 with space-evenly should give leading = (slack - 0)/(n+1) but also push
    // adjacent children apart by spacing on top of the distributed slot.
    const r = calculateLayout(node({
      autoLayout: true, direction: 'horizontal',
      widthMode: 'fixed', heightMode: 'fixed',
      width: 400, height: 50, spacing: 10,
      padding: pad(0, 0, 0, 0),
      justifyContent: 'space-evenly',
      children: [leaf(50, 50), leaf(50, 50), leaf(50, 50)],
    }), PARENT);
    // fixed = 150, gaps (3-1)*10 = 20, slack = 230, evenly slot = 230/4 = 57.5
    // leading = 57.5, between = 10 + 57.5 = 67.5
    // positions: 57.5, 57.5 + 50 + 67.5 = 175, 175 + 50 + 67.5 = 292.5
    expect(r.children.map(c => c.bounds.x)).toEqual([57.5, 175, 292.5]);
  });
});

describe('alignItems', () => {
  it('horizontal: center cross-aligns each child vertically in the content box', () => {
    const r = calculateLayout(node({
      autoLayout: true, direction: 'horizontal',
      widthMode: 'fixed', heightMode: 'fixed',
      width: 300, height: 100, spacing: 0, padding: pad(0, 0, 0, 0),
      alignItems: 'center',
      children: [leaf(30, 30), leaf(30, 50)],
    }), PARENT);
    // 30-tall child centered in 100 → y=35; 50-tall child centered → y=25
    expect(r.children.map(c => c.bounds.y)).toEqual([35, 25]);
  });

  it('vertical: end cross-aligns each child to the right edge', () => {
    const r = calculateLayout(node({
      autoLayout: true, direction: 'vertical',
      widthMode: 'fixed', heightMode: 'fixed',
      width: 200, height: 300, spacing: 0, padding: pad(0, 0, 0, 0),
      alignItems: 'end',
      children: [leaf(40, 50), leaf(80, 50)],
    }), PARENT);
    expect(r.children.map(c => c.bounds.x)).toEqual([160, 120]); // 200-40, 200-80
  });
});

describe('leaf passthrough', () => {
  it('a node without autoLayout keeps its declared box and has no children', () => {
    const r = calculateLayout(node({ width: 80, height: 40, children: [leaf(10, 10)] }), PARENT);
    expect(r.bounds).toEqual({ x: 0, y: 0, width: 80, height: 40 });
    expect(r.children).toEqual([]);
  });
});

// ── Regression: the scenarios reported broken (container grow, nested propagation).
// These prove the pure engine resolves the whole tree in ONE calculateLayout call —
// no fixpoint loop required — so the real fixes were the dual-model + selection work.
describe('regression: grow + nested propagation', () => {
  const hug = (extra: Partial<AutoLayoutNode>) =>
    node({ autoLayout: true, widthMode: 'hug', heightMode: 'hug', padding: pad(0, 0, 0, 0), ...extra });

  it('hug container grows when a child is added', () => {
    const two = hug({ direction: 'horizontal', spacing: 10, children: [leaf(50, 20), leaf(50, 20)] });
    expect(calculateLayout(two, PARENT).bounds.width).toBe(110); // 50 + 10 + 50

    const three = hug({ direction: 'horizontal', spacing: 10, children: [leaf(50, 20), leaf(50, 20), leaf(50, 20)] });
    expect(calculateLayout(three, PARENT).bounds.width).toBe(170); // 50+10+50+10+50
  });

  it('nested hug cascades the inner container size up to the outer (single pass)', () => {
    const inner = hug({ direction: 'vertical', spacing: 0, children: [leaf(30, 10), leaf(50, 10)] });
    // inner natural: width = max(30,50) = 50, height = 10 + 10 = 20
    const outer = hug({ direction: 'horizontal', spacing: 5, children: [leaf(40, 40), inner] });
    const r = calculateLayout(outer, PARENT);
    expect(r.bounds.width).toBe(95);  // 40 + 5 + 50
    expect(r.bounds.height).toBe(40); // max(40, 20)
    expect(r.children[1].bounds.width).toBe(50);
    expect(r.children[1].bounds.height).toBe(20);
  });

  it('deeply nested hug (3 levels) resolves in one pass', () => {
    const l3 = hug({ direction: 'horizontal', spacing: 0, children: [leaf(20, 20), leaf(20, 20)] }); // 40×20
    const l2 = hug({ direction: 'horizontal', spacing: 0, children: [l3] });
    const l1 = hug({ direction: 'horizontal', spacing: 0, children: [l2] });
    const r = calculateLayout(l1, PARENT);
    expect(r.bounds.width).toBe(40);
    expect(r.bounds.height).toBe(20);
  });

  it('fill child inside a hug parent collapses to its declared size', () => {
    const container = hug({
      direction: 'horizontal', spacing: 0,
      children: [{ ...leaf(30, 20), widthMode: 'fill' }],
    });
    expect(calculateLayout(container, PARENT).bounds.width).toBe(30);
  });
});

describe('wrap', () => {
  it('breaks to a new row when items exceed the fixed inner width', () => {
    const c = node({
      autoLayout: true, direction: 'wrap',
      widthMode: 'fixed', heightMode: 'hug',
      width: 100, spacing: 10, padding: pad(0, 0, 0, 0),
      children: [leaf(40, 20), leaf(40, 20), leaf(40, 20)],
    });
    const r = calculateLayout(c, PARENT);
    // row1: x0, x50 (both fit in 100); item3 wraps to row2 at y=30 (20 + 10 gap)
    expect(r.children.map(ch => ch.bounds.x)).toEqual([0, 50, 0]);
    expect(r.children.map(ch => ch.bounds.y)).toEqual([0, 0, 30]);
    // hug height = 2 rows: 20 + 10 + 20 = 50
    expect(r.bounds.height).toBe(50);
  });

  it('with hug width does not wrap (single row, like horizontal)', () => {
    const c = node({
      autoLayout: true, direction: 'wrap',
      widthMode: 'hug', heightMode: 'hug',
      spacing: 10, padding: pad(0, 0, 0, 0),
      children: [leaf(40, 20), leaf(40, 20), leaf(40, 20)],
    });
    const r = calculateLayout(c, PARENT);
    expect(r.bounds.width).toBe(140);  // 40*3 + 10*2
    expect(r.bounds.height).toBe(20);
    expect(r.children.map(ch => ch.bounds.x)).toEqual([0, 50, 100]);
  });
});

describe('reversed (via applyAutoLayoutToPage)', () => {
  it('lays children in reverse visual order', () => {
    const c = makeDefaultShape({
      id: 'c', type: 'frame', name: 'AL', frameId: 'c', parentId: null,
      x: 100, y: 100, width: 0, height: 0, childIds: ['a', 'b'],
      autoLayout: { direction: 'horizontal', reversed: true, spacing: 0,
        padding: { top: 0, right: 0, bottom: 0, left: 0 }, justifyContent: 'start', alignItems: 'start' },
      widthMode: 'hug', heightMode: 'hug',
    });
    const a = makeDefaultShape({ id: 'a', type: 'rect', name: 'a', frameId: 'c', parentId: 'c', x: 100, y: 100, width: 40, height: 20 });
    const b = makeDefaultShape({ id: 'b', type: 'rect', name: 'b', frameId: 'c', parentId: 'c', x: 140, y: 100, width: 60, height: 20 });
    const page: Page = { id: 'p', name: 'P', background: '#fff', childIds: ['c'], objects: { c, a, b } };

    applyAutoLayoutToPage(page);
    // reversed → b (last) is placed first at the container origin, a after it
    expect(page.objects.b.x).toBe(100);
    expect(page.objects.a.x).toBe(160); // 100 + b.width(60)
  });
});

describe('negative gap (overlap)', () => {
  it('places children overlapping and shrinks a hug container', () => {
    const c = node({
      autoLayout: true, direction: 'horizontal', widthMode: 'hug', heightMode: 'hug',
      spacing: -10, padding: pad(0, 0, 0, 0),
      children: [leaf(40, 20), leaf(40, 20)],
    });
    const r = calculateLayout(c, PARENT);
    expect(r.bounds.width).toBe(70);                 // 40 + 40 + (-10)
    expect(r.children.map(ch => ch.bounds.x)).toEqual([0, 30]); // second overlaps first by 10
  });
});

describe('min/max constraints', () => {
  it('clamps a hug container to maxWidth', () => {
    const c = node({
      autoLayout: true, direction: 'horizontal', widthMode: 'hug', heightMode: 'hug',
      spacing: 0, padding: pad(0, 0, 0, 0), maxWidth: 100,
      children: [leaf(80, 20), leaf(80, 20)],   // natural 160
    });
    expect(calculateLayout(c, PARENT).bounds.width).toBe(100);
  });

  it('clamps a fill child to maxWidth so it does not consume all leftover', () => {
    const c = node({
      autoLayout: true, direction: 'horizontal', widthMode: 'fixed', heightMode: 'fixed',
      width: 500, height: 100, spacing: 0, padding: pad(0, 0, 0, 0),
      children: [{ ...leaf(0, 40), widthMode: 'fill', maxWidth: 120 }],
    });
    expect(calculateLayout(c, PARENT).children[0].bounds.width).toBe(120);
  });

  it('clamps a fill child up to minWidth', () => {
    const c = node({
      autoLayout: true, direction: 'horizontal', widthMode: 'fixed', heightMode: 'fixed',
      width: 50, height: 100, spacing: 0, padding: pad(0, 0, 0, 0),
      children: [{ ...leaf(0, 40), widthMode: 'fill', minWidth: 200 }],
    });
    expect(calculateLayout(c, PARENT).children[0].bounds.width).toBe(200);
  });
});

describe('wrap alignment', () => {
  it('centres items on the main axis within each row (justifyContent center)', () => {
    const c = node({
      autoLayout: true, direction: 'wrap', widthMode: 'fixed', heightMode: 'hug',
      width: 100, height: 0, spacing: 0, padding: pad(0, 0, 0, 0),
      justifyContent: 'center', alignItems: 'start',
      children: [leaf(40, 20)],   // one 40-wide item in a 100-wide row → slack 60 → leading 30
    });
    expect(calculateLayout(c, PARENT).children[0].bounds.x).toBe(30);
  });

  it('aligns items to the bottom of their row (alignItems end)', () => {
    const c = node({
      autoLayout: true, direction: 'wrap', widthMode: 'fixed', heightMode: 'hug',
      width: 200, height: 0, spacing: 0, padding: pad(0, 0, 0, 0),
      justifyContent: 'start', alignItems: 'end',
      children: [leaf(40, 40), leaf(40, 20)],   // row height 40; second item (h20) drops to y=20
    });
    expect(calculateLayout(c, PARENT).children.map(ch => ch.bounds.y)).toEqual([0, 20]);
  });
});

describe('grid', () => {
  it('flows children row-major into equal columns; keeps their own box top-left', () => {
    const c = node({
      autoLayout: true, direction: 'grid', columns: 2, widthMode: 'fixed', heightMode: 'fixed',
      width: 200, height: 200, spacing: 0, padding: pad(0, 0, 0, 0),
      children: [leaf(40, 20), leaf(40, 20), leaf(40, 20), leaf(40, 20)],
    });
    const r = calculateLayout(c, PARENT);
    // colW = 200/2 = 100; row height 20
    expect(r.children.map(ch => ch.bounds.x)).toEqual([0, 100, 0, 100]);
    expect(r.children.map(ch => ch.bounds.y)).toEqual([0, 0, 20, 20]);
    expect(r.children.map(ch => ch.bounds.width)).toEqual([40, 40, 40, 40]); // not fill → own width
  });

  it('fill child stretches to the column width', () => {
    const c = node({
      autoLayout: true, direction: 'grid', columns: 2, widthMode: 'fixed', heightMode: 'fixed',
      width: 200, height: 200, spacing: 0, padding: pad(0, 0, 0, 0),
      children: [{ ...leaf(40, 20), widthMode: 'fill' }, leaf(40, 20)],
    });
    expect(calculateLayout(c, PARENT).children[0].bounds.width).toBe(100);
  });

  it('hug height = sum of row heights (2 rows of 20)', () => {
    const c = node({
      autoLayout: true, direction: 'grid', columns: 2, widthMode: 'fixed', heightMode: 'hug',
      width: 200, height: 0, spacing: 0, padding: pad(0, 0, 0, 0),
      children: [leaf(40, 20), leaf(40, 20), leaf(40, 20)],   // 3 items / 2 cols → 2 rows
    });
    expect(calculateLayout(c, PARENT).bounds.height).toBe(40);
  });

  it('respects column + row gap (spacing) on both axes', () => {
    const c = node({
      autoLayout: true, direction: 'grid', columns: 2, widthMode: 'fixed', heightMode: 'fixed',
      width: 210, height: 200, spacing: 10, padding: pad(0, 0, 0, 0),
      children: [leaf(40, 20), leaf(40, 20), leaf(40, 20), leaf(40, 20)],
    });
    const r = calculateLayout(c, PARENT);
    // colW = (210 - 10)/2 = 100; second column starts at 100 + 10 = 110; second row at 20 + 10 = 30
    expect(r.children.map(ch => ch.bounds.x)).toEqual([0, 110, 0, 110]);
    expect(r.children.map(ch => ch.bounds.y)).toEqual([0, 0, 30, 30]);
  });
});

describe('wrap alignContent (row distribution)', () => {
  const twoRows = (alignContent: 'start' | 'center' | 'end' | 'space-between'): AutoLayoutNode => node({
    autoLayout: true, direction: 'wrap', widthMode: 'fixed', heightMode: 'fixed',
    width: 100, height: 100, spacing: 0, padding: pad(0, 0, 0, 0), alignContent,
    // three 40-wide × 20-tall items in a 100-wide container → row1=[i1,i2], row2=[i3].
    // Two rows of height 20 → content 40, container 100 → cross slack 60.
    children: [leaf(40, 20), leaf(40, 20), leaf(40, 20)],
  });
  it('start: rows packed at the top', () => {
    expect(calculateLayout(twoRows('start'), PARENT).children.map(c => c.bounds.y)).toEqual([0, 0, 20]);
  });
  it('center: rows centred (slack 60 → +30)', () => {
    expect(calculateLayout(twoRows('center'), PARENT).children.map(c => c.bounds.y)).toEqual([30, 30, 50]);
  });
  it('end: rows pushed to the bottom (slack 60)', () => {
    expect(calculateLayout(twoRows('end'), PARENT).children.map(c => c.bounds.y)).toEqual([60, 60, 80]);
  });
});

describe('stroke included in layout', () => {
  const withStroke = (strokeInLayout: boolean): AutoLayoutNode => node({
    autoLayout: true, direction: 'horizontal', widthMode: 'hug', heightMode: 'hug',
    spacing: 0, padding: pad(0, 0, 0, 0), strokeInLayout,
    children: [
      { ...leaf(40, 40), strokeExtent: 8 },   // e.g. 4px outer stroke → 8 total
      leaf(40, 40),
    ],
  });
  it('off (default): stroke ignored — siblings touch, hug = 80', () => {
    const r = calculateLayout(withStroke(false), PARENT);
    expect(r.bounds.width).toBe(80);
    expect(r.children.map(c => c.bounds.x)).toEqual([0, 40]);
  });
  it('on: stroke reserves space — second child pushed by 8, hug = 88', () => {
    const r = calculateLayout(withStroke(true), PARENT);
    expect(r.bounds.width).toBe(88);            // 40 + 8(stroke) + 40
    // geometric box centred in its occupancy → first child offset by half-ext (4)
    expect(r.children.map(c => c.bounds.x)).toEqual([4, 48]);
  });
});

describe('rotated children use their AABB footprint (via applyAutoLayoutToPage)', () => {
  const alFrame = (childIds: string[]) => makeDefaultShape({
    id: 'c', type: 'frame', name: 'AL', frameId: 'c', parentId: null,
    x: 0, y: 0, width: 0, height: 0, childIds,
    autoLayout: { direction: 'horizontal', spacing: 10,
      padding: { top: 0, right: 0, bottom: 0, left: 0 }, justifyContent: 'start', alignItems: 'start' },
    widthMode: 'hug', heightMode: 'hug',
  });

  it('90°-rotated child contributes swapped dims; siblings do not overlap', () => {
    const c = alFrame(['a', 'b']);
    // a: 100×40 rotated 90° → AABB 40×100
    const a = makeDefaultShape({ id: 'a', type: 'rect', name: 'a', frameId: 'c', parentId: 'c', x: 0, y: 0, width: 100, height: 40, rotation: 90 });
    const b = makeDefaultShape({ id: 'b', type: 'rect', name: 'b', frameId: 'c', parentId: 'c', x: 0, y: 0, width: 50, height: 50 });
    const page: Page = { id: 'p', name: 'P', background: '#fff', childIds: ['c'], objects: { c, a, b } };

    applyAutoLayoutToPage(page);
    // hug: width = 40 (AABB) + 10 + 50 = 100; height = max(100, 50) = 100
    expect(page.objects.c.width).toBe(100);
    expect(page.objects.c.height).toBe(100);
    // a keeps its own size + rotation; centred in its 40×100 slot at (0,0)
    expect(page.objects.a.width).toBe(100);
    expect(page.objects.a.height).toBe(40);
    expect(page.objects.a.rotation).toBe(90);
    expect(page.objects.a.x).toBe(Math.round(0 + 40 / 2 - 100 / 2));  // -30 (AABB centred)
    expect(page.objects.a.y).toBe(Math.round(0 + 100 / 2 - 40 / 2));  // 30
    // b starts after a's AABB + spacing: 40 + 10 = 50
    expect(page.objects.b.x).toBe(50);
  });

  it('45°-rotated square: AABB = side·√2 pushes the sibling out', () => {
    const c = alFrame(['a', 'b']);
    const a = makeDefaultShape({ id: 'a', type: 'rect', name: 'a', frameId: 'c', parentId: 'c', x: 0, y: 0, width: 100, height: 100, rotation: 45 });
    const b = makeDefaultShape({ id: 'b', type: 'rect', name: 'b', frameId: 'c', parentId: 'c', x: 0, y: 0, width: 50, height: 50 });
    const page: Page = { id: 'p', name: 'P', background: '#fff', childIds: ['c'], objects: { c, a, b } };

    applyAutoLayoutToPage(page);
    const aabb = Math.round(100 * Math.SQRT2);   // ≈ 141
    // b sits after the AABB + spacing, so the rotated square never overlaps it
    expect(page.objects.b.x).toBe(aabb + 10);
    expect(page.objects.c.width).toBe(aabb + 10 + 50);
    expect(page.objects.c.height).toBe(aabb);
  });
});

describe('rotated AL container (flat model: children carry the same rotation)', () => {
  it('children with rel-rotation 0 keep exact footprints; placements rotate about the container centre; rotation is never written', () => {
    const c = makeDefaultShape({
      id: 'c', type: 'frame', name: 'AL', frameId: 'c', parentId: null,
      x: 0, y: 0, width: 0, height: 0, rotation: 90, childIds: ['a', 'b'],
      autoLayout: { direction: 'horizontal', spacing: 10,
        padding: { top: 0, right: 0, bottom: 0, left: 0 }, justifyContent: 'start', alignItems: 'start' },
      widthMode: 'hug', heightMode: 'hug',
    });
    // Cascade state: children rotated WITH the container (rotation 90 each).
    const a = makeDefaultShape({ id: 'a', type: 'rect', name: 'a', frameId: 'c', parentId: 'c', x: 0, y: 0, width: 40, height: 20, rotation: 90 });
    const b = makeDefaultShape({ id: 'b', type: 'rect', name: 'b', frameId: 'c', parentId: 'c', x: 0, y: 0, width: 60, height: 20, rotation: 90 });
    const page: Page = { id: 'p', name: 'P', background: '#fff', childIds: ['c'], objects: { c, a, b } };

    applyAutoLayoutToPage(page);

    // rel = 90 − 90 = 0 → EXACT footprints (no AABB): local slots a(0,0,40,20), b(50,0,60,20)
    // → hug 110×20 (container box stays unrotated dims).
    expect(page.objects.c.width).toBe(110);
    expect(page.objects.c.height).toBe(20);
    // Placements rotate about the container centre (55,10) by 90°:
    // a: local centre (20,10) → (55,−25) → x = 55−20 = 35, y = −25−10 = −35
    expect(page.objects.a.x).toBe(35);
    expect(page.objects.a.y).toBe(-35);
    // b: local centre (80,10) → (55,35) → x = 55−30 = 25, y = 35−10 = 25
    expect(page.objects.b.x).toBe(25);
    expect(page.objects.b.y).toBe(25);
    // The engine must NEVER write rotation.
    expect(page.objects.a.rotation).toBe(90);
    expect(page.objects.b.rotation).toBe(90);
    expect(page.objects.c.rotation).toBe(90);
    // Sizes untouched (rel 0 slots are exact).
    expect(page.objects.a.width).toBe(40);
    expect(page.objects.a.height).toBe(20);
  });
});

describe('absolute-positioned children', () => {
  it('excludes absolute children from flow and from hug measurement', () => {
    const c = makeDefaultShape({
      id: 'c', type: 'frame', name: 'AL', frameId: 'c', parentId: null,
      x: 0, y: 0, width: 0, height: 0, childIds: ['flow', 'abs'],
      autoLayout: { direction: 'horizontal', spacing: 0,
        padding: { top: 0, right: 0, bottom: 0, left: 0 }, justifyContent: 'start', alignItems: 'start' },
      widthMode: 'hug', heightMode: 'hug',
    });
    const flow = makeDefaultShape({ id: 'flow', type: 'rect', name: 'flow', frameId: 'c', parentId: 'c', x: 0, y: 0, width: 40, height: 30 });
    const abs = makeDefaultShape({ id: 'abs', type: 'rect', name: 'abs', frameId: 'c', parentId: 'c', x: 999, y: 999, width: 500, height: 500, layoutPositioning: 'absolute' });
    const page: Page = { id: 'p', name: 'P', background: '#fff', childIds: ['c'], objects: { c, flow, abs } };

    applyAutoLayoutToPage(page);
    // hug ignores the absolute child → container is just the flow child
    expect(page.objects.c.width).toBe(40);
    expect(page.objects.c.height).toBe(30);
    // absolute child keeps its manual position (not placed into the flow)
    expect(page.objects.abs.x).toBe(999);
    expect(page.objects.abs.y).toBe(999);
  });
});
