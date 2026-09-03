// Browser-parity tests. Each case states what CSS flexbox would do, because the product
// goal is "feels like a browser". Where Figma deliberately differs from CSS (fixed items
// never shrink) that difference is asserted too, so the divergence stays intentional.
import { describe, it, expect } from 'vitest';
import { calculateLayout, AutoLayoutNode } from './autoLayout';

const ROOT = { x: 0, y: 0, width: 0, height: 0 };
const box = (o: Partial<AutoLayoutNode>): AutoLayoutNode =>
  ({ width: 0, height: 0, ...o }) as AutoLayoutNode;
const widths = (n: AutoLayoutNode) => calculateLayout(n, ROOT).children.map(c => c.bounds.width);
const xs = (n: AutoLayoutNode) => calculateLayout(n, ROOT).children.map(c => c.bounds.x);

describe('hug measurement respects child min/max', () => {
  it('min-width on a fixed child widens the hug parent', () => {
    // CSS: <div style="width:fit-content"><div style="width:100px;min-width:200px">
    // → parent is 200 wide. Engine must not measure the pre-clamp 100.
    const parent = box({
      autoLayout: true, direction: 'horizontal', widthMode: 'hug', heightMode: 'hug',
      children: [box({ width: 100, height: 50, minWidth: 200 })],
    });
    expect(calculateLayout(parent, ROOT).bounds.width).toBe(200);
  });

  it('max-width on a fixed child narrows the hug parent', () => {
    const parent = box({
      autoLayout: true, direction: 'horizontal', widthMode: 'hug', heightMode: 'hug',
      children: [box({ width: 300, height: 50, maxWidth: 120 })],
    });
    expect(calculateLayout(parent, ROOT).bounds.width).toBe(120);
  });

  it('min-height on a fixed child heightens the hug parent', () => {
    const parent = box({
      autoLayout: true, direction: 'vertical', widthMode: 'hug', heightMode: 'hug',
      children: [box({ width: 50, height: 10, minHeight: 90 })],
    });
    expect(calculateLayout(parent, ROOT).bounds.height).toBe(90);
  });
});

describe('fill redistribution when a sibling clamps', () => {
  it('leftover from a maxed fill child goes to the other fill child', () => {
    // CSS: two flex:1 items in 400px, first has max-width:100px
    // → 100 / 300. Flexbox re-runs distribution after freezing the clamped item.
    const parent = box({
      autoLayout: true, direction: 'horizontal', width: 400, height: 50,
      children: [
        box({ width: 0, height: 50, widthMode: 'fill', maxWidth: 100 }),
        box({ width: 0, height: 50, widthMode: 'fill' }),
      ],
    });
    expect(widths(parent)).toEqual([100, 300]);
  });

  it('a min-clamped fill child takes space from the other fill child', () => {
    // CSS: 200px row, two flex:1 1 0 items, first min-width:150px → 150 / 50.
    const parent = box({
      autoLayout: true, direction: 'horizontal', width: 200, height: 50,
      children: [
        box({ width: 0, height: 50, widthMode: 'fill', minWidth: 150 }),
        box({ width: 0, height: 50, widthMode: 'fill' }),
      ],
    });
    expect(widths(parent)).toEqual([150, 50]);
  });

  it('three fill children, one maxed, split the rest evenly', () => {
    const parent = box({
      autoLayout: true, direction: 'horizontal', width: 600, height: 50,
      children: [
        box({ width: 0, height: 50, widthMode: 'fill', maxWidth: 100 }),
        box({ width: 0, height: 50, widthMode: 'fill' }),
        box({ width: 0, height: 50, widthMode: 'fill' }),
      ],
    });
    expect(widths(parent)).toEqual([100, 250, 250]);
  });
});

describe('justifyContent still applies to slack a clamped fill leaves behind', () => {
  it('centers a fill child that cannot grow past its max', () => {
    // CSS: justify-content:center on a row whose only flex:1 item is capped at 100
    // → 300px of free space, item centred at x=150.
    const parent = box({
      autoLayout: true, direction: 'horizontal', width: 400, height: 50,
      justifyContent: 'center',
      children: [box({ width: 0, height: 50, widthMode: 'fill', maxWidth: 100 })],
    });
    expect(xs(parent)).toEqual([150]);
  });
});

describe('fill inside a wrap container grows within its row', () => {
  it('a fill child takes the rest of the row', () => {
    // CSS: flex-wrap:wrap row of 300px, gap 0, child A 100px fixed, child B flex:1
    // → B is 200 wide. Fill has meaning inside wrap: it fills the ROW.
    const parent = box({
      autoLayout: true, direction: 'wrap', width: 300, height: 100, spacing: 0,
      children: [
        box({ width: 100, height: 50 }),
        box({ width: 20, height: 50, widthMode: 'fill' }),
      ],
    });
    expect(widths(parent)).toEqual([100, 200]);
  });
});

describe('width-dependent hug height is measured at the resolved width', () => {
  it('a fill-width wrap child hugs to the height its real width produces', () => {
    // A wrap container 300 wide holding four 100x40 items wraps to 2 rows → 80 tall.
    // Its parent is 300 wide, so the child resolves to 300 — the hug height must be
    // measured against that, not against the child's declared width.
    const inner = box({
      autoLayout: true, direction: 'wrap', width: 500, height: 40, spacing: 0,
      widthMode: 'fill', heightMode: 'hug',
      children: [
        box({ width: 100, height: 40 }), box({ width: 100, height: 40 }),
        box({ width: 100, height: 40 }), box({ width: 100, height: 40 }),
      ],
    });
    const parent = box({
      autoLayout: true, direction: 'vertical', width: 300, height: 400,
      children: [inner],
    });
    const child = calculateLayout(parent, ROOT).children[0];
    expect(child.bounds.width).toBe(300);
    expect(child.bounds.height).toBe(80);
  });
});

describe('Figma-intentional divergences from CSS', () => {
  it('fixed children overflow rather than shrink', () => {
    // CSS default flex-shrink:1 would squeeze these to 100 each. Figma does not.
    const parent = box({
      autoLayout: true, direction: 'horizontal', width: 200, height: 50,
      children: [box({ width: 150, height: 50 }), box({ width: 150, height: 50 })],
    });
    expect(widths(parent)).toEqual([150, 150]);
  });
});

describe('wrap sizing follows from the resolved width', () => {
  it('a max-width that cuts a hug wrap container short adds rows', () => {
    // Intrinsic width would be 6+13 + 42+77 + 16 gap = 154, but max-width 83 narrows it
    // to an inner 64 — only one item fits per row, so the hug height is two rows.
    const node = box({
      autoLayout: true, direction: 'wrap', spacing: 16,
      padding: { top: 2, right: 13, bottom: 4, left: 6 },
      widthMode: 'hug', heightMode: 'hug', maxWidth: 83,
      width: 157, height: 41,
      children: [box({ width: 42, height: 50 }), box({ width: 77, height: 78 })],
    });
    const r = calculateLayout(node, ROOT);
    expect(r.bounds.width).toBe(83);
    expect(r.bounds.height).toBe(2 + 4 + 50 + 16 + 78);
  });

  it('a hugging ancestor measures a fixed-width wrap child at that width', () => {
    const inner = box({
      autoLayout: true, direction: 'wrap', spacing: 0, width: 200, height: 10,
      heightMode: 'hug',
      children: [
        box({ width: 100, height: 30 }), box({ width: 100, height: 30 }),
        box({ width: 100, height: 30 }),
      ],
    });
    // 200 wide → 2 per row → 2 rows → 60 tall, and the parent hugs to that.
    const parent = box({
      autoLayout: true, direction: 'vertical', widthMode: 'hug', heightMode: 'hug',
      children: [inner],
    });
    expect(calculateLayout(parent, ROOT).bounds.height).toBe(60);
  });

  it('cross-axis fill stretches to the row, without inflating it', () => {
    const parent = box({
      autoLayout: true, direction: 'wrap', spacing: 0, width: 200, height: 300,
      children: [
        box({ width: 100, height: 80 }),
        box({ width: 100, height: 999, heightMode: 'fill', autoLayout: true,
             children: [box({ width: 10, height: 20 })] }),
      ],
    });
    const kids = calculateLayout(parent, ROOT).children;
    expect(kids.map(k => k.bounds.height)).toEqual([80, 80]);
  });
});

describe('grid cells re-measure a hug child at its column width', () => {
  it('a hug-height wrap child in a fill-width cell is as tall as the column makes it', () => {
    const cell = box({
      autoLayout: true, direction: 'wrap', spacing: 0, width: 400, height: 25,
      widthMode: 'fill', heightMode: 'hug',
      children: [
        box({ width: 100, height: 25 }), box({ width: 100, height: 25 }),
        box({ width: 100, height: 25 }),
      ],
    });
    // 2 columns in 400 → each column 200 wide → 2 items per row → 2 rows → 50 tall.
    const grid = box({
      autoLayout: true, direction: 'grid', columns: 2, spacing: 0,
      width: 400, height: 200,
      children: [cell],
    });
    expect(calculateLayout(grid, ROOT).children[0].bounds.height).toBe(50);
  });
});

// ── Deliberate departures from CSS ────────────────────────────────────────────────
// Each of these is a place where matching a browser exactly would make the editor worse.
describe('Figma-intentional divergences from CSS', () => {
  it('centred overflow stays inside the parent instead of hanging off both edges', () => {
    // A browser would put the first child at a negative offset. Children leaving the
    // frame on the left is worse in an editor than overflowing on one side only.
    const parent = box({
      autoLayout: true, direction: 'horizontal', width: 100, height: 50,
      justifyContent: 'center',
      children: [box({ width: 120, height: 50 }), box({ width: 120, height: 50 })],
    });
    expect(xs(parent)).toEqual([0, 120]);
  });

  it('a max-capped cross-axis fill still obeys alignItems', () => {
    // CSS start-aligns a stretch item that max-height cut short; obeying the container's
    // alignment is what the properties panel says will happen, so the engine does that.
    const parent = box({
      autoLayout: true, direction: 'horizontal', width: 200, height: 100,
      alignItems: 'end',
      children: [box({ width: 50, height: 999, heightMode: 'fill', maxHeight: 40 })],
    });
    expect(calculateLayout(parent, ROOT).children[0].bounds.y).toBe(60);
  });

  it('two fills in one wrap row split the leftover equally', () => {
    // CSS would grow each from its own declared basis, handing the wider item more.
    // Two cards both set to Fill should come out the same width.
    const parent = box({
      autoLayout: true, direction: 'wrap', spacing: 0, width: 300, height: 100,
      children: [
        box({ width: 40, height: 50, widthMode: 'fill' }),
        box({ width: 120, height: 50, widthMode: 'fill' }),
      ],
    });
    expect(widths(parent)).toEqual([150, 150]);
  });
});

describe('a hugging ancestor measures a fill-width child at its real width', () => {
  // The structure that exposed this: artboard → column → [wrapping card row, nav row].
  // The card row fills the column's width and hugs its own height; the column hugs the
  // total. Measure the card row at its DECLARED width and it reports one row, the column
  // hugs to that, and the nav row underneath gets overlapped by the rows that appear.
  const cards = (declaredWidth: number) => box({
    autoLayout: true, direction: 'wrap', spacing: 32,
    widthMode: 'fill', heightMode: 'hug',
    width: declaredWidth, height: 256,
    children: [
      box({ width: 286, height: 256 }), box({ width: 286, height: 256 }),
      box({ width: 286, height: 256 }),
    ],
  });
  const column = (width: number) => box({
    autoLayout: true, direction: 'vertical', spacing: 100,
    widthMode: 'fixed', heightMode: 'hug',
    width, height: 0,
    children: [cards(1000), box({ width: 100, height: 55, widthMode: 'fill' })],
  });

  it('the column grows when the row inside it wraps', () => {
    // 704 inner → 286+32+286 = 604 fits, third card wraps → 2 rows → 256+32+256 = 544.
    const at704 = calculateLayout(column(704), ROOT);
    expect(at704.children[0].bounds.height).toBe(544);
    expect(at704.bounds.height).toBe(544 + 100 + 55);
  });

  it('the nav row below never overlaps the wrapped cards', () => {
    const at704 = calculateLayout(column(704), ROOT);
    const [cardRow, nav] = at704.children;
    expect(nav.bounds.y).toBeGreaterThanOrEqual(cardRow.bounds.y + cardRow.bounds.height);
    expect(nav.bounds.y + nav.bounds.height).toBeLessThanOrEqual(at704.bounds.y + at704.bounds.height);
  });

  it('and collapses back to one row at desktop width', () => {
    const at1376 = calculateLayout(column(1376), ROOT);
    expect(at1376.children[0].bounds.height).toBe(256);
    expect(at1376.bounds.height).toBe(256 + 100 + 55);
  });
});
