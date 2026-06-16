import { DesignFile, makeDefaultPage, makeDefaultShape } from './types';

// A blank document: one page with a single empty frame (Figma-style new file).
export function makeEmptyFile(): DesignFile {
  const pageId = 'page-1';
  const page = makeDefaultPage(pageId, 'Page 1');
  const frameId = 'frame-1';
  const frame = makeDefaultShape({
    id: frameId,
    type: 'frame',
    name: 'Frame 1',
    frameId,
    x: 0,
    y: 0,
    width: 1440,
    height: 1024,
    fills: [{ type: 'solid', color: '#FFFFFF', opacity: 1 }],
    clipContent: true,
    selrect: { x: 0, y: 0, width: 1440, height: 1024 },
  });
  page.objects = { [frame.id]: frame };
  page.childIds = [frame.id];
  return {
    // Unique per document so each tab / save target is distinguishable (the save
    // handle is cached by file id, so two untitled files mustn't collide).
    id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `untitled-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Untitled',
    version: 1,
    pages: [page],
    activePageId: pageId,
    images: {},
    components: {},
    colors: [],
    typographies: [],
    tokens: [],
    themes: [],
    activeThemeId: 'default',
  };
}

export function makeSampleFile(): DesignFile {
  const pageId = 'page-1';
  const page = makeDefaultPage(pageId, 'Page 1');

  const frameId = 'frame-root';

  const frame = makeDefaultShape({
    id: frameId,
    type: 'frame',
    name: 'Main Frame',
    frameId: frameId,
    x: 80,
    y: 80,
    width: 640,
    height: 480,
    fills: [{ type: 'solid', color: '#FFFFFF', opacity: 1 }],
    strokes: [{ color: '#CCCCCC', opacity: 1, width: 1, align: 'inner', cap: 'none', style: 'solid' }],
    clipContent: true,
    selrect: { x: 80, y: 80, width: 640, height: 480 },
  });

  const rect = makeDefaultShape({
    id: 'rect-1',
    type: 'rect',
    name: 'Blue Rectangle',
    frameId,
    parentId: frameId,
    x: 140,
    y: 140,
    width: 160,
    height: 100,
    fills: [{ type: 'solid', color: '#5C7CFA', opacity: 1 }],
    selrect: { x: 140, y: 140, width: 160, height: 100 },
  });

  const circle = makeDefaultShape({
    id: 'circle-1',
    type: 'circle',
    name: 'Coral Circle',
    frameId,
    parentId: frameId,
    x: 340,
    y: 140,
    width: 120,
    height: 120,
    fills: [{ type: 'solid', color: '#FF6B6B', opacity: 1 }],
    selrect: { x: 340, y: 140, width: 120, height: 120 },
  });

  const text = makeDefaultShape({
    id: 'text-1',
    type: 'text',
    name: 'Heading',
    frameId,
    parentId: frameId,
    x: 140,
    y: 280,
    width: 360,
    height: 48,
    fills: [],
    textStyle: {
      fontFamily: 'system-ui, sans-serif',
      fontWeight: 700,
      fontSize: 32,
      lineHeight: 1.2,
      letterSpacing: 0,
      textDecoration: 'none',
      textTransform: 'none',
      color: '#1A1A2E',
      opacity: 1,
    },
    paragraphs: [
      {
        align: 'left',
        spans: [{ text: 'Hello, Design Tool' }],
      },
    ],
    selrect: { x: 140, y: 280, width: 360, height: 48 },
  });

  const gradientRect = makeDefaultShape({
    id: 'grad-1',
    type: 'rect',
    name: 'Gradient Bar',
    frameId,
    parentId: frameId,
    x: 140,
    y: 360,
    width: 360,
    height: 24,
    fills: [
      {
        type: 'linear-gradient',
        startX: 0,
        startY: 0.5,
        endX: 1,
        endY: 0.5,
        opacity: 1,
        stops: [
          { color: '#5C7CFA', opacity: 1, offset: 0 },
          { color: '#FF6B6B', opacity: 1, offset: 1 },
        ],
      },
    ],
    selrect: { x: 140, y: 360, width: 360, height: 24 },
  });

  frame.childIds = [rect.id, circle.id, text.id, gradientRect.id];

  page.objects = {
    [frame.id]: frame,
    [rect.id]: rect,
    [circle.id]: circle,
    [text.id]: text,
    [gradientRect.id]: gradientRect,
  };
  page.childIds = [frame.id];

  return {
    id: 'sample-file-1',
    name: 'Sample Design',
    version: 1,
    pages: [page],
    activePageId: pageId,
    images: {},
    components: {},
    colors: [
      { id: 'col-1', name: 'Primary', color: '#5C7CFA', opacity: 1 },
      { id: 'col-2', name: 'Accent', color: '#FF6B6B', opacity: 1 },
      { id: 'col-3', name: 'Dark', color: '#1A1A2E', opacity: 1 },
    ],
    typographies: [
      { id: 'typ-1', name: 'Heading', style: { fontFamily: 'system-ui, sans-serif', fontWeight: 700, fontSize: 32, lineHeight: 1.2, letterSpacing: 0 } },
      { id: 'typ-2', name: 'Body', style: { fontFamily: 'system-ui, sans-serif', fontWeight: 400, fontSize: 14, lineHeight: 1.5, letterSpacing: 0 } },
    ],
    tokens: [
      { id: 'tok-1', name: 'color.brand', $type: 'color', $value: '#5C7CFA' },
      { id: 'tok-2', name: 'color.accent', $type: 'color', $value: '#FF6B6B' },
      { id: 'tok-3', name: 'color.surface', $type: 'color', $value: '#FFFFFF' },
      { id: 'tok-4', name: 'color.primary', $type: 'color', $value: '{color.brand}' }, // alias
      { id: 'tok-5', name: 'spacing.md', $type: 'spacing', $value: 16 },
      { id: 'tok-6', name: 'radius.sm', $type: 'borderRadius', $value: 4 },
    ],
    themes: [
      {
        id: 'theme-dark', name: 'Dark',
        values: { 'color.surface': '#1A1A2E', 'color.brand': '#7C9CFF' },
      },
    ],
    activeThemeId: 'default',
  };
}
