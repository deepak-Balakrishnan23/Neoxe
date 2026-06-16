import { describe, it, expect } from 'vitest';
import { makeDefaultShape, Page, Shape } from './types';
import { pageToSvg, frameToSvg, exportShapeSvg } from './codegen';

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
