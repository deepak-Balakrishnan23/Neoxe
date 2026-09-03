import { describe, it, expect } from 'vitest';
import { applyTokensToFile } from './tokens';
import { makeDefaultShape, DesignFile, Page, Shape } from './types';

function fileWith(shape: Shape, tokens: DesignFile['tokens']): DesignFile {
  const page: Page = {
    id: 'page-1', name: 'Page 1', background: '#fff',
    objects: { [shape.id]: shape }, childIds: [shape.id],
  };
  return {
    id: 'f', name: 'F', version: 1, pages: [page], activePageId: 'page-1',
    images: {}, components: {}, colors: [], typographies: [],
    tokens, themes: [], activeThemeId: 'default',
  };
}

const rect = (extra: Partial<Shape> = {}) => makeDefaultShape({
  id: 'r', type: 'rect', name: 'R', frameId: 'page-1',
  x: 0, y: 0, width: 100, height: 100, selrect: { x: 0, y: 0, width: 100, height: 100 },
  fills: [{ type: 'solid', color: '#000000', opacity: 1 }],
  ...extra,
});

describe('a radius token reaches a shape that has never been rounded', () => {
  it('creates cornerRadii and sets all four corners', () => {
    const shape = rect({ tokenBindings: {
      'cornerRadii.tl': 'radius.lg', 'cornerRadii.tr': 'radius.lg',
      'cornerRadii.br': 'radius.lg', 'cornerRadii.bl': 'radius.lg',
    } });
    expect(shape.cornerRadii).toBeUndefined();   // nothing to write into yet
    const file = fileWith(shape, [{ id: 't1', name: 'radius.lg', $type: 'borderRadius', $value: 24 }]);
    applyTokensToFile(file);
    expect(file.pages[0].objects.r.cornerRadii).toEqual({ tl: 24, tr: 24, br: 24, bl: 24 });
  });

  it('still refuses to invent a property on an existing object', () => {
    // The guard that stops `fills.0.color` from injecting `color` onto a gradient fill
    // (which has `stops`, not `color`) must survive the cornerRadii exception.
    const shape = rect({
      fills: [{ type: 'linear-gradient', startX: 0, startY: 0, endX: 1, endY: 1,
        stops: [{ color: '#fff', opacity: 1, offset: 0 }], opacity: 1 } as never],
      tokenBindings: { 'fills.0.color': 'color.brand' },
    });
    const file = fileWith(shape, [{ id: 't2', name: 'color.brand', $type: 'color', $value: '#FF3366' }]);
    applyTokensToFile(file);
    expect((file.pages[0].objects.r.fills[0] as Record<string, unknown>).color).toBeUndefined();
  });

  it('binds opacity, font and auto-layout gap too', () => {
    const frame = makeDefaultShape({
      id: 'r', type: 'frame', name: 'F', frameId: 'page-1',
      x: 0, y: 0, width: 100, height: 100, selrect: { x: 0, y: 0, width: 100, height: 100 },
      autoLayout: { direction: 'horizontal', spacing: 0,
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        justifyContent: 'start', alignItems: 'start' },
      tokenBindings: { 'opacity': 'o.half', 'autoLayout.spacing': 'space.md' },
    });
    const file = fileWith(frame, [
      { id: 'a', name: 'o.half', $type: 'opacity', $value: 0.5 },
      { id: 'b', name: 'space.md', $type: 'spacing', $value: 16 },
    ]);
    applyTokensToFile(file);
    expect(file.pages[0].objects.r.opacity).toBe(0.5);
    expect(file.pages[0].objects.r.autoLayout!.spacing).toBe(16);
  });
});
