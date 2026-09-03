import { describe, it, expect } from 'vitest';
import { makeDefaultShape, Page, Shape } from './types';
import { pageToSvg, frameToSvg, exportShapeSvg, shapeToCssProps, frameToHtml, frameToResponsiveHtml } from './codegen';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANS';

function build(): { page: Page; images: Record<string, string> } {
  const frame = makeDefaultShape({ id: 'f', type: 'frame', name: 'Card', frameId: 'f', parentId: null,
    x: 0, y: 0, width: 300, height: 200, selrect: { x: 0, y: 0, width: 300, height: 200 },
    fills: [{ type: 'solid', color: '#ffffff', opacity: 1 }], childIds: ['r', 'img', 'logo'] });
  const rect = makeDefaultShape({ id: 'r', type: 'rect', name: 'Box', frameId: 'f', parentId: 'f',
    x: 10, y: 10, width: 80, height: 40, selrect: { x: 10, y: 10, width: 80, height: 40 },
    fills: [{ type: 'solid', color: '#ff0000', opacity: 1 }] });
  const img = makeDefaultShape({ id: 'img', type: 'image', name: 'Photo', frameId: 'f', parentId: 'f',
    x: 100, y: 10, width: 120, height: 90, selrect: { x: 100, y: 10, width: 120, height: 90 }, imageId: 'i1' });
  const logo = makeDefaultShape({ id: 'logo', type: 'svg', name: 'Logo', frameId: 'f', parentId: 'f',
    x: 10, y: 120, width: 64, height: 64, selrect: { x: 10, y: 120, width: 64, height: 64 },
    svgInnerHTML: '<circle cx="32" cy="32" r="30" fill="#00f"/>', svgOriginalWidth: 64, svgOriginalHeight: 64 });
  const page: Page = { id: 'p', name: 'Page 1', background: '#fff', childIds: ['f'], objects: { f: frame, r: rect, img, logo } };
  return { page, images: { i1: PNG } };
}

describe('SVG export content (BUG 1) + self-contained images', () => {
  const { page, images } = build();

  it('frameToSvg renders all child types — not an empty wrapper', () => {
    const svg = frameToSvg(page.objects.f, page, images);
    expect(svg).toContain('<rect');               // the box
    expect(svg).toContain('#ff0000');             // its fill
    expect(svg).toContain('<image');              // the photo
    expect(svg).toContain('<circle');             // the imported-svg logo inner markup
  });

  it('embeds raster images as base64 data URLs (self-contained, no file paths)', () => {
    const svg = frameToSvg(page.objects.f, page, images);
    expect(svg).toContain(`href="${PNG}"`);
    expect(svg).not.toMatch(/href="(\/|file:|https?:)/); // never a path / external URL
  });

  it('pageToSvg also threads images through (was dropping them)', () => {
    const svg = pageToSvg(page, images);
    expect(svg).toContain(PNG);
    expect(svg).toContain('<circle');
  });

  it('exportShapeSvg of an imported SVG node uses its stored markup directly', () => {
    const svg = exportShapeSvg(page.objects.logo, page, images);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('<circle cx="32"');
    expect(svg).toContain('width="64"');
    expect(svg).toContain('height="64"');
    expect(svg).toContain('viewBox="0 0 64 64"');
  });

  it('exportShapeSvg of a frame renders its subtree (non-empty)', () => {
    const svg = exportShapeSvg(page.objects.f, page, images);
    expect(svg).toContain('<rect');
    expect(svg).toContain('<image');
    expect(svg).toContain('<circle');
  });
});

describe('prototype frameToHtml — flat model must not re-apply auto layout', () => {
  // Screen frame containing an auto-layout frame with two children whose final
  // positions are ALREADY baked into x/y by the layout engine (flat model).
  function buildAL(): Page {
    const screen = makeDefaultShape({ id: 'scr', type: 'frame', name: 'Screen', frameId: 'scr', parentId: null,
      x: 0, y: 0, width: 800, height: 600, selrect: { x: 0, y: 0, width: 800, height: 600 },
      fills: [{ type: 'solid', color: '#ffffff', opacity: 1 }], childIds: ['al', 'al2'] });
    const al = makeDefaultShape({ id: 'al', type: 'frame', name: 'Card', frameId: 'scr', parentId: 'scr',
      x: 40, y: 40, width: 300, height: 120, selrect: { x: 40, y: 40, width: 300, height: 120 },
      childIds: ['a'],
      autoLayout: { direction: 'horizontal', spacing: 8, padding: { top: 10, right: 10, bottom: 10, left: 10 }, justifyContent: 'start', alignItems: 'start' } });
    const al2 = makeDefaultShape({ id: 'al2', type: 'frame', name: 'Card2', frameId: 'scr', parentId: 'scr',
      x: 40, y: 200, width: 300, height: 120, selrect: { x: 40, y: 200, width: 300, height: 120 },
      childIds: [],
      autoLayout: { direction: 'vertical', spacing: 4, padding: { top: 0, right: 0, bottom: 0, left: 0 }, justifyContent: 'start', alignItems: 'start' } });
    const a = makeDefaultShape({ id: 'a', type: 'rect', name: 'Chip', frameId: 'scr', parentId: 'al',
      x: 50, y: 50, width: 80, height: 40, selrect: { x: 50, y: 50, width: 80, height: 40 },
      fills: [{ type: 'solid', color: '#ff0000', opacity: 1 }] });
    return { id: 'p', name: 'Page 1', background: '#fff', childIds: ['scr'], objects: { scr: screen, al, al2, a } };
  }

  it('emits every flattened element position:absolute — never flex/relative flow', () => {
    const page = buildAL();
    const html = frameToHtml(page.objects.scr, page, {});
    expect(html).not.toContain('display:flex');
    expect(html).not.toContain('display:grid');
    expect(html).not.toContain('position:relative;left'); // no flow-positioned shape divs
    expect(html).not.toContain('padding:');               // padding must not inflate boxes
    // Baked coordinates survive: the auto-layout frames sit at their stored spots…
    expect(html).toContain('left:40px;top:40px');
    expect(html).toContain('left:40px;top:200px');
    // …and the child keeps its engine-computed position, frame-relative.
    expect(html).toContain('left:50px;top:50px');
  });

  it('text shapes never paint their fills as a background (canvas parity)', () => {
    const page = buildAL();
    const t = makeDefaultShape({ id: 't', type: 'text', name: 'Hello', frameId: 'scr', parentId: 'scr',
      x: 10, y: 10, width: 100, height: 20, selrect: { x: 10, y: 10, width: 100, height: 20 },
      fills: [{ type: 'solid', color: '#00ff00', opacity: 1 }],
      textStyle: { fontFamily: 'Inter', fontWeight: 400, fontSize: 16, lineHeight: 1.2, letterSpacing: 0, textDecoration: 'none', textTransform: 'none', color: '#111111', opacity: 1 },
      paragraphs: [{ align: 'left', spans: [{ text: 'Hello' }] }] });
    page.objects.t = t;
    page.objects.scr.childIds = [...page.objects.scr.childIds, 't'];
    const html = frameToHtml(page.objects.scr, page, {});
    expect(html).toContain('Hello');
    expect(html).not.toContain('background:#00ff00');
  });
});

describe('CSS inspect output is parent-relative (Figma handoff model)', () => {
  const { page } = build();

  it('child left/top subtract the parent frame position', () => {
    // Frame at (0,0); move it to prove the subtraction actually happens.
    const moved: Page = structuredClone(page);
    moved.objects.f.x = 500; moved.objects.f.y = 300;
    moved.objects.r.x = 510; moved.objects.r.y = 310;   // 10px inset in the frame
    const props = shapeToCssProps(moved.objects.r, moved);
    expect(props['left']).toBe('10px');
    expect(props['top']).toBe('10px');
  });

  it('root shapes (no parent) keep absolute coordinates', () => {
    const props = shapeToCssProps(page.objects.f, page);
    expect(props['left']).toBe('0px');
    expect(props['top']).toBe('0px');
  });
});

describe('codegen — path placement', () => {
  it('places a path by its origin, since its content is shape-local', () => {
    const path = makeDefaultShape({
      id: 'p1', type: 'path', name: 'Vector', frameId: 'p1', parentId: null,
      x: 40, y: 25, width: 10, height: 10, selrect: { x: 40, y: 25, width: 10, height: 10 },
      content: [{ verb: 'M', coords: [0, 0] }, { verb: 'L', coords: [10, 10] }],
    });
    const page: Page = { id: 'p', name: 'P', background: '#fff', childIds: ['p1'], objects: { p1: path } };
    const svg = pageToSvg(page);
    expect(svg).toContain('translate(40 25)');
    expect(svg).toContain('d="M0 0 L10 10"');
  });

  it('exports a boolean group\'s operands rather than an empty path', () => {
    const bool = makeDefaultShape({
      id: 'b', type: 'bool', name: 'Subtract', frameId: 'b', parentId: null,
      x: 0, y: 0, width: 50, height: 50, selrect: { x: 0, y: 0, width: 50, height: 50 },
      boolType: 'difference', childIds: ['k'],
    });
    const kid = makeDefaultShape({
      id: 'k', type: 'rect', name: 'Box', frameId: 'b', parentId: 'b',
      x: 0, y: 0, width: 20, height: 20, selrect: { x: 0, y: 0, width: 20, height: 20 },
    });
    const page: Page = { id: 'p', name: 'P', background: '#fff', childIds: ['b'], objects: { b: bool, k: kid } };
    const svg = pageToSvg(page);
    expect(svg).toContain('<rect');
    expect(svg).not.toContain('d=""');
  });
});

describe('codegen — boolean groups and masks', () => {
  function boolScene() {
    const bool = makeDefaultShape({
      id: 'b', type: 'bool', name: 'Subtract', frameId: 'b', parentId: null,
      x: 0, y: 0, width: 100, height: 100, selrect: { x: 0, y: 0, width: 100, height: 100 },
      boolType: 'difference', childIds: ['sq', 'circ'],
      content: [{ verb: 'M', coords: [0, 0] }, { verb: 'L', coords: [100, 0] }, { verb: 'Z', coords: [] }],
    });
    const sq = makeDefaultShape({ id: 'sq', type: 'rect', name: 'sq', frameId: 'b', parentId: 'b',
      x: 0, y: 0, width: 100, height: 100, selrect: { x: 0, y: 0, width: 100, height: 100 } });
    const circ = makeDefaultShape({ id: 'circ', type: 'circle', name: 'circ', frameId: 'b', parentId: 'b',
      x: 50, y: 50, width: 100, height: 100, selrect: { x: 50, y: 50, width: 100, height: 100 } });
    const page: Page = { id: 'p', name: 'P', background: '#fff', childIds: ['b'], objects: { b: bool, sq, circ } };
    return page;
  }

  it('exports the computed outline instead of the operands', () => {
    const svg = pageToSvg(boolScene());
    expect(svg).toContain('<path');
    // The operands must not also be drawn — they would cover the subtraction.
    expect(svg).not.toContain('<ellipse');
    expect(svg.match(/<rect/g) ?? []).toHaveLength(0);
  });

  it('exports a mask layer as an SVG mask rather than drawing it flat', () => {
    const maskShape = makeDefaultShape({ id: 'm', type: 'circle', name: 'Mask', frameId: 'f', parentId: 'f',
      x: 0, y: 0, width: 50, height: 50, selrect: { x: 0, y: 0, width: 50, height: 50 }, isMask: true });
    const covered = makeDefaultShape({ id: 'c', type: 'rect', name: 'Covered', frameId: 'f', parentId: 'f',
      x: 0, y: 0, width: 200, height: 200, selrect: { x: 0, y: 0, width: 200, height: 200 } });
    const frame = makeDefaultShape({ id: 'f', type: 'frame', name: 'F', frameId: 'f', parentId: null,
      x: 0, y: 0, width: 200, height: 200, selrect: { x: 0, y: 0, width: 200, height: 200 }, childIds: ['m', 'c'] });
    const page: Page = { id: 'p', name: 'P', background: '#fff', childIds: ['f'], objects: { f: frame, m: maskShape, c: covered } };
    const svg = frameToSvg(frame, page);
    expect(svg).toContain('<mask id="mask-m"');
    expect(svg).toContain('mask="url(#mask-m)"');
  });
});

describe('codegen — image paints', () => {
  function imagePaintPage(scaleMode: 'fill' | 'fit' | 'stretch' | 'tile') {
    const rect = makeDefaultShape({
      id: 'r', type: 'rect', name: 'Card', frameId: 'r', parentId: null,
      x: 10, y: 20, width: 200, height: 100, selrect: { x: 10, y: 20, width: 200, height: 100 },
      fills: [{ type: 'image', imageId: 'i1', scaleMode, opacity: 1 }],
    });
    const page: Page = { id: 'p', name: 'P', background: '#fff', childIds: ['r'], objects: { r: rect } };
    return page;
  }

  it('emits an image paint as a pattern holding the embedded picture', () => {
    const svg = pageToSvg(imagePaintPage('fill'), { i1: PNG });
    expect(svg).toContain('<pattern id="paint-r"');
    expect(svg).toContain(`href="${PNG}"`);
    expect(svg).toContain('fill="url(#paint-r)"');
  });

  it('maps each scale mode onto preserveAspectRatio', () => {
    expect(pageToSvg(imagePaintPage('fit'), { i1: PNG })).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(pageToSvg(imagePaintPage('stretch'), { i1: PNG })).toContain('preserveAspectRatio="none"');
    expect(pageToSvg(imagePaintPage('fill'), { i1: PNG })).toContain('preserveAspectRatio="xMidYMid slice"');
  });

  it('falls back to no fill when the image is missing from the export', () => {
    const svg = pageToSvg(imagePaintPage('fill'));
    expect(svg).toContain('fill="none"');
    expect(svg).not.toContain('<pattern');
  });

  it('carries corner radius onto the exported rect', () => {
    const page = imagePaintPage('fill');
    page.objects['r'].cornerRadii = { tl: 12, tr: 12, br: 12, bl: 12 };
    expect(pageToSvg(page, { i1: PNG })).toContain('rx="12"');
  });
});

describe('auto-layout children emit responsive CSS, not fixed boxes', () => {
  const parentAndChild = (dir: 'horizontal' | 'vertical' | 'wrap', child: Partial<Shape>) => {
    const parent = makeDefaultShape({
      id: 'p', type: 'frame', name: 'Row', frameId: 'p', x: 0, y: 0, width: 800, height: 200,
      selrect: { x: 0, y: 0, width: 800, height: 200 },
      autoLayout: {
        direction: dir, spacing: 16, padding: { top: 0, right: 0, bottom: 0, left: 0 },
        justifyContent: 'start', alignItems: 'start',
      },
    });
    const c = makeDefaultShape({
      id: 'c', type: 'rect', name: 'Child', frameId: 'p', parentId: 'p',
      x: 0, y: 0, width: 300, height: 100, selrect: { x: 0, y: 0, width: 300, height: 100 },
      ...child,
    });
    const page: Page = {
      id: 'pg', name: 'Page 1', background: '#FFFFFF',
      objects: { p: parent, c }, childIds: ['p'],
    };
    return shapeToCssProps(c, page);
  };

  it('a flow child is not absolutely positioned', () => {
    const css = parentAndChild('horizontal', {});
    expect(css['position']).toBeUndefined();
    expect(css['left']).toBeUndefined();
    expect(css['top']).toBeUndefined();
  });

  it('Fill on the main axis becomes flex: 1 1 0 with the auto minimum defeated', () => {
    const css = parentAndChild('horizontal', { widthMode: 'fill' });
    expect(css['flex']).toBe('1 1 0');
    expect(css['min-width']).toBe('0');
    expect(css['width']).toBeUndefined();
  });

  it('Fill on the cross axis becomes align-self: stretch', () => {
    const css = parentAndChild('horizontal', { heightMode: 'fill' });
    expect(css['align-self']).toBe('stretch');
    expect(css['height']).toBeUndefined();
  });

  it('a vertical parent flips which axis is main', () => {
    const css = parentAndChild('vertical', { heightMode: 'fill', widthMode: 'fill' });
    expect(css['flex']).toBe('1 1 0');
    expect(css['min-height']).toBe('0');
    expect(css['align-self']).toBe('stretch');
  });

  it('Hug becomes fit-content', () => {
    const css = parentAndChild('horizontal', { widthMode: 'hug', heightMode: 'hug' });
    expect(css['width']).toBe('fit-content');
    expect(css['height']).toBe('fit-content');
  });

  it('a Fixed child gets flex-shrink: 0, matching the editor letting it overflow', () => {
    expect(parentAndChild('horizontal', {})['flex-shrink']).toBe('0');
    expect(parentAndChild('horizontal', { widthMode: 'fill' })['flex-shrink']).toBeUndefined();
  });

  it('a real min-width wins over the zero Fill needs', () => {
    const css = parentAndChild('horizontal', { widthMode: 'fill', minWidth: 240, maxWidth: 480 });
    expect(css['min-width']).toBe('240px');
    expect(css['max-width']).toBe('480px');
  });

  it('an absolutely-positioned child keeps its coordinates', () => {
    const css = parentAndChild('horizontal', { layoutPositioning: 'absolute' });
    expect(css['position']).toBe('absolute');
    expect(css['width']).toBe('300px');
  });
});

describe('frameToResponsiveHtml — nested flow model', () => {
  function build(): Page {
    const screen = makeDefaultShape({ id: 'scr', type: 'frame', name: 'Screen', frameId: 'scr', parentId: null,
      x: 0, y: 0, width: 1440, height: 900, selrect: { x: 0, y: 0, width: 1440, height: 900 },
      fills: [{ type: 'solid', color: '#ffffff', opacity: 1 }], clipContent: true, childIds: ['row'],
      widthMode: 'fixed', heightMode: 'fixed',
      autoLayout: { direction: 'vertical', spacing: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 }, justifyContent: 'start', alignItems: 'start' } });
    const row = makeDefaultShape({ id: 'row', type: 'frame', name: 'Row', frameId: 'scr', parentId: 'scr',
      x: 0, y: 0, width: 1440, height: 80, selrect: { x: 0, y: 0, width: 1440, height: 80 },
      childIds: ['link', 'grow'], widthMode: 'fill', heightMode: 'hug',
      autoLayout: { direction: 'wrap', spacing: 16, padding: { top: 8, right: 8, bottom: 8, left: 8 }, justifyContent: 'space-between', alignItems: 'center' } });
    const link = makeDefaultShape({ id: 'link', type: 'text', name: 'Pricing', frameId: 'scr', parentId: 'row',
      x: 8, y: 8, width: 60, height: 20, selrect: { x: 8, y: 8, width: 60, height: 20 },
      textStyle: { fontFamily: 'Inter', fontWeight: 500, fontSize: 15, lineHeight: 1.3, letterSpacing: 0, textDecoration: 'none', textTransform: 'none', color: '#111', opacity: 1 },
      paragraphs: [{ align: 'left', spans: [{ text: 'Pricing' }] }],
      interactions: [{ id: 'i1', trigger: 'click', action: 'navigate', targetFrameId: 'scr', transition: 'dissolve' }] });
    const grow = makeDefaultShape({ id: 'grow', type: 'rect', name: 'Grow', frameId: 'scr', parentId: 'row',
      x: 100, y: 8, width: 200, height: 40, selrect: { x: 100, y: 8, width: 200, height: 40 },
      widthMode: 'fill', heightMode: 'fixed' });
    return { id: 'p', name: 'Page 1', background: '#fff', childIds: ['scr'],
      objects: { scr: screen, row, link, grow } };
  }

  it('nests children instead of flattening them into siblings', () => {
    const html = frameToResponsiveHtml(build().objects.scr, build(), {});
    // The row is emitted INSIDE the screen, and the link inside the row.
    const scrAt = html.indexOf('data-id="scr"');
    const rowAt = html.indexOf('data-id="row"');
    const linkAt = html.indexOf('data-id="link"');
    expect(scrAt).toBeLessThan(rowAt);
    expect(rowAt).toBeLessThan(linkAt);
    // One root element, not a flat list of four.
    expect(html.trimStart().startsWith('<div data-id="scr"')).toBe(true);
  });

  it('emits real flexbox for the auto-layout containers', () => {
    const page = build();
    const html = frameToResponsiveHtml(page.objects.scr, page, {});
    expect(html).toContain('display:flex');
    expect(html).toContain('flex-wrap:wrap');
    expect(html).toContain('justify-content:space-between');
    expect(html).toContain('padding:8px 8px 8px 8px');
  });

  it('the screen fills the window rather than pinning to the artboard box', () => {
    const page = build();
    const html = frameToResponsiveHtml(page.objects.scr, page, {});
    // Root: full width, content-driven height, and no artboard-fold clipping.
    expect(html).toMatch(/^<div data-id="scr"[^>]*width:100%/);
    expect(html).not.toMatch(/^<div data-id="scr"[^>]*height:900px/);
    expect(html).not.toMatch(/^<div data-id="scr"[^>]*overflow:hidden/);
  });

  it('a Fill child grows with the window instead of carrying a pixel width', () => {
    const page = build();
    const html = frameToResponsiveHtml(page.objects.scr, page, {});
    const grow = html.slice(html.indexOf('data-id="grow"'));
    // The row wraps, so the basis is the declared width (that is what breaks rows) — the
    // point is that the element grows rather than being pinned at `width:200px`.
    expect(grow).toContain('flex:1 1 200px');
    expect(grow).not.toContain('width:200px');
  });

  it('carries injected hotspots INSIDE the layer — text layers included', () => {
    const page = build();
    const html = frameToResponsiveHtml(page.objects.scr, page, {},
      s => (s.interactions ?? []).length ? '<div class="hotspot"></div>' : '');
    // The link is a text layer; its hotspot has to survive, or the nav is dead.
    const link = html.slice(html.indexOf('data-id="link"'));
    expect(link).toContain('class="hotspot"');
    // …and it needs a positioned host to be inset against.
    expect(link.slice(0, link.indexOf('>'))).toContain('position:relative');
  });
});

describe('Fill inside a wrap container keeps the engine’s row-breaking basis', () => {
  const child = (mods: Partial<Shape>) => {
    const parent = makeDefaultShape({ id: 'p', type: 'frame', name: 'Row', frameId: 'p',
      x: 0, y: 0, width: 1440, height: 400, selrect: { x: 0, y: 0, width: 1440, height: 400 },
      autoLayout: { direction: 'wrap', spacing: 40, padding: { top: 0, right: 0, bottom: 0, left: 0 },
        justifyContent: 'start', alignItems: 'start' } });
    const c = makeDefaultShape({ id: 'c', type: 'frame', name: 'Col', frameId: 'p', parentId: 'p',
      x: 0, y: 0, width: 620, height: 380, selrect: { x: 0, y: 0, width: 620, height: 380 }, ...mods });
    const page: Page = { id: 'pg', name: 'Page 1', background: '#fff', objects: { p: parent, c }, childIds: ['p'] };
    return shapeToCssProps(c, page);
  };

  it('grows from the declared width so the row can break, unlike flex-basis 0', () => {
    const css = child({ widthMode: 'fill' });
    expect(css['flex']).toBe('1 1 620px');
    // A zero basis always fits its row, so the column would never stack on a phone.
    expect(css['flex']).not.toBe('1 1 0');
    // …and shrink stays on so a lone item on a 375px row doesn't overflow it.
    expect(css['min-width']).toBe('0');
  });

  it('a non-wrapping row still fills from a zero basis', () => {
    const parent = makeDefaultShape({ id: 'p', type: 'frame', name: 'Row', frameId: 'p',
      x: 0, y: 0, width: 800, height: 100, selrect: { x: 0, y: 0, width: 800, height: 100 },
      autoLayout: { direction: 'horizontal', spacing: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 },
        justifyContent: 'start', alignItems: 'start' } });
    const c = makeDefaultShape({ id: 'c', type: 'rect', name: 'Grow', frameId: 'p', parentId: 'p',
      x: 0, y: 0, width: 300, height: 40, selrect: { x: 0, y: 0, width: 300, height: 40 }, widthMode: 'fill' });
    const page: Page = { id: 'pg', name: 'Page 1', background: '#fff', objects: { p: parent, c }, childIds: ['p'] };
    expect(shapeToCssProps(c, page)['flex']).toBe('1 1 0');
  });
});
