import { DesignFile, Page, Shape, makeDefaultShape, makeDefaultPage, Fill } from './types';

// ── Importers: Figma / Penpot JSON → our DesignFile ───────────────────────────
// These map the common subset of each tool's export format to our model.
// They are intentionally tolerant: unknown node types become rects, missing
// fields fall back to defaults.

function uid() { return Math.random().toString(36).slice(2, 10); }

// Detect format and route. NATIVE is checked first: our files carry both `pages` and `id`,
// which also matches the Penpot signature — checking Penpot first misrouted every native
// file through the Penpot mapper.
export function importDesignJson(json: any): DesignFile {
  if (json && Array.isArray(json.pages) && json.activePageId !== undefined) return json as DesignFile;
  if (json && json.document && json.document.type === 'DOCUMENT') return importFigma(json);
  if (json && (json.data || json.pages) && json.id) return importPenpot(json);
  throw new Error('Unrecognized file format');
}

// ── Figma ─────────────────────────────────────────────────────────────────────
// Figma REST/plugin export: document → CANVAS[] → children tree.
// Coordinates come from absoluteBoundingBox.

function importFigma(json: any): DesignFile {
  const pages: Page[] = [];

  for (const canvas of json.document.children ?? []) {
    if (canvas.type !== 'CANVAS') continue;
    const page = makeDefaultPage(uid(), canvas.name ?? 'Page');
    const rootChildren: string[] = [];

    const walk = (node: any, parentId: string | null): string | null => {
      const shape = figmaNodeToShape(node, page.id, parentId);
      if (!shape) return null;
      page.objects[shape.id] = shape;
      const childIds: string[] = [];
      for (const child of node.children ?? []) {
        const cid = walk(child, shape.id);
        if (cid) childIds.push(cid);
      }
      shape.childIds = childIds;
      return shape.id;
    };

    for (const node of canvas.children ?? []) {
      const id = walk(node, null);
      if (id) rootChildren.push(id);
    }
    page.childIds = rootChildren;
    pages.push(page);
  }

  if (pages.length === 0) pages.push(makeDefaultPage(uid(), 'Page 1'));

  return baseFile(json.name ?? 'Imported from Figma', pages);
}

function figmaNodeToShape(node: any, pageId: string, parentId: string | null): Shape | null {
  const box = node.absoluteBoundingBox ?? { x: 0, y: 0, width: 100, height: 100 };
  const typeMap: Record<string, Shape['type']> = {
    FRAME: 'frame', GROUP: 'group', RECTANGLE: 'rect', ELLIPSE: 'circle',
    TEXT: 'text', VECTOR: 'path', COMPONENT: 'frame', INSTANCE: 'frame',
  };
  const type = typeMap[node.type] ?? 'rect';

  const fills: Fill[] = (node.fills ?? [])
    .filter((f: any) => f.visible !== false && f.type === 'SOLID')
    .map((f: any) => ({
      type: 'solid' as const,
      color: rgbaToHex(f.color),
      opacity: f.opacity ?? f.color?.a ?? 1,
    }));

  const shape = makeDefaultShape({
    id: node.id ? `fig-${node.id.replace(/[^a-zA-Z0-9]/g, '')}` : uid(),
    type,
    name: node.name ?? type,
    frameId: parentId ?? pageId,
    parentId,
    x: box.x, y: box.y, width: box.width, height: box.height,
    fills: fills.length ? fills : (type === 'text' ? [] : [{ type: 'solid', color: '#CCCCCC', opacity: 1 }]),
    selrect: { x: box.x, y: box.y, width: box.width, height: box.height },
    clipContent: node.clipsContent ?? false,
  });

  if (type === 'text') {
    shape.paragraphs = [{ align: (node.style?.textAlignHorizontal ?? 'left').toLowerCase(), spans: [{ text: node.characters ?? node.name ?? '' }] }];
    shape.textStyle = {
      fontFamily: node.style?.fontFamily ?? 'system-ui, sans-serif',
      fontWeight: node.style?.fontWeight ?? 400,
      fontSize: node.style?.fontSize ?? 16,
      lineHeight: node.style?.lineHeightPercentFontSize ? node.style.lineHeightPercentFontSize / 100 : 1.2,
      letterSpacing: node.style?.letterSpacing ?? 0,
      textDecoration: 'none', textTransform: 'none',
      color: fills[0] && fills[0].type === 'solid' ? fills[0].color : '#000000',
      opacity: 1,
    };
  }
  return shape;
}

// ── Penpot ──────────────────────────────────────────────────────────────────
// Penpot export: pages-index + objects map keyed by id, with selrect/fills.

function importPenpot(json: any): DesignFile {
  const pages: Page[] = [];
  const data = json.data ?? json;
  const pageList = data.pages ?? [];
  const pagesIndex = data['pages-index'] ?? data.pagesIndex ?? {};

  for (const pageId of pageList) {
    const pdata = pagesIndex[pageId];
    if (!pdata) continue;
    const page = makeDefaultPage(pageId, pdata.name ?? 'Page');
    const objects = pdata.objects ?? {};
    const rootChildren: string[] = [];

    for (const [id, obj] of Object.entries<any>(objects)) {
      if (id === '00000000-0000-0000-0000-000000000000') continue; // root frame sentinel
      const shape = penpotObjToShape(id, obj, page.id);
      page.objects[id] = shape;
    }
    // Build hierarchy from parent-id / shapes arrays
    for (const [id, obj] of Object.entries<any>(objects)) {
      if (id === '00000000-0000-0000-0000-000000000000') continue;
      const shape = page.objects[id];
      if (!shape) continue;
      shape.childIds = (obj.shapes ?? []).filter((c: string) => page.objects[c]);
      const parent = obj['parent-id'] ?? obj.parentId;
      if (!parent || parent === '00000000-0000-0000-0000-000000000000') rootChildren.push(id);
    }
    page.childIds = rootChildren;
    pages.push(page);
  }

  if (pages.length === 0) pages.push(makeDefaultPage(uid(), 'Page 1'));
  return baseFile(json.name ?? 'Imported from Penpot', pages);
}

function penpotObjToShape(id: string, obj: any, pageId: string): Shape {
  const sel = obj.selrect ?? { x: obj.x ?? 0, y: obj.y ?? 0, width: obj.width ?? 100, height: obj.height ?? 100 };
  const typeMap: Record<string, Shape['type']> = {
    frame: 'frame', group: 'group', rect: 'rect', circle: 'circle',
    text: 'text', path: 'path', image: 'image', bool: 'bool',
  };
  const type = typeMap[obj.type] ?? 'rect';

  const fills: Fill[] = (obj.fills ?? [])
    .filter((f: any) => f['fill-color'] || f.fillColor)
    .map((f: any) => ({
      type: 'solid' as const,
      color: f['fill-color'] ?? f.fillColor ?? '#cccccc',
      opacity: f['fill-opacity'] ?? f.fillOpacity ?? 1,
    }));

  return makeDefaultShape({
    id,
    type,
    name: obj.name ?? type,
    frameId: pageId,
    x: sel.x, y: sel.y, width: sel.width, height: sel.height,
    rotation: obj.rotation ?? 0,
    fills: fills.length ? fills : (type === 'text' ? [] : [{ type: 'solid', color: '#cccccc', opacity: 1 }]),
    selrect: { x: sel.x, y: sel.y, width: sel.width, height: sel.height },
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function rgbaToHex(c: { r: number; g: number; b: number } | undefined): string {
  if (!c) return '#000000';
  const to = (n: number) => Math.round((n ?? 0) * 255).toString(16).padStart(2, '0');
  return `#${to(c.r)}${to(c.g)}${to(c.b)}`;
}

function baseFile(name: string, pages: Page[]): DesignFile {
  return {
    id: uid(),
    name,
    version: 1,
    pages,
    activePageId: pages[0].id,
    images: {},
    components: {},
    colors: [],
    typographies: [],
    tokens: [],
    themes: [],
    activeThemeId: 'default',
  };
}
