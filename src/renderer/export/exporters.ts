import { Page, DesignFile } from '../../shared/types';
import { pageToSvg, exportShapeSvg } from '../../shared/codegen';
import { renderPage } from '../canvas/renderer';
import { saveExportFile } from '../io/fileIO';

// ── Export helpers ────────────────────────────────────────────────────────────

// Compute content bounds of selected shapes (or whole page).
// A SINGLE selected node uses its own W/H exactly (the values shown in the right panel) —
// never a recomputed bounding box — so the export matches the node's size to the pixel.
function computeBounds(page: Page, ids?: string[]): { x: number; y: number; w: number; h: number } {
  if (ids && ids.length === 1) {
    const s = page.objects[ids[0]];
    // Unrotated: use exact W/H (matches the right panel to the pixel). Rotated: fall back to
    // the AABB (selrect) so the export covers the whole rotated shape instead of clipping it.
    if (s && !s.rotation) return { x: s.x, y: s.y, w: Math.round(s.width), h: Math.round(s.height) };
    if (s) return { x: s.selrect.x, y: s.selrect.y, w: Math.round(s.selrect.width), h: Math.round(s.selrect.height) };
  }
  const shapes = ids && ids.length > 0
    ? ids.map(id => page.objects[id]).filter(Boolean)
    : page.childIds.map(id => page.objects[id]).filter(Boolean);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes) {
    minX = Math.min(minX, s.selrect.x); minY = Math.min(minY, s.selrect.y);
    maxX = Math.max(maxX, s.selrect.x + s.selrect.width);
    maxY = Math.max(maxY, s.selrect.y + s.selrect.height);
  }
  if (!isFinite(minX)) return { x: 0, y: 0, w: 100, h: 100 };
  return { x: minX, y: minY, w: Math.round(maxX - minX), h: Math.round(maxY - minY) };
}

// Filename base: a single selected node uses its layer name as-is (Figma); otherwise the
// page name. saveExportFile strips only path-illegal characters.
function exportBaseName(page: Page, ids?: string[]): string {
  if (ids && ids.length === 1) {
    const s = page.objects[ids[0]];
    if (s?.name) return s.name;
  }
  return page.name || 'export';
}

// ── Raster export (PNG / JPEG / WEBP) ─────────────────────────────────────────

export type RasterFormat = 'png' | 'jpeg' | 'webp';

const RASTER_MIME: Record<RasterFormat, string> = {
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp',
};
const RASTER_EXT: Record<RasterFormat, string> = {
  png: 'png', jpeg: 'jpg', webp: 'webp',
};

// Render the given target (page or selection) into an offscreen canvas at `scale`.
function rasterize(
  file: DesignFile,
  page: Page,
  scale: number,
  ids: string[] | undefined,
  images: Record<string, HTMLImageElement>,
  opaqueBg?: string,
): HTMLCanvasElement {
  const bounds = computeBounds(page, ids);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bounds.w * scale);
  canvas.height = Math.round(bounds.h * scale);
  const ctx = canvas.getContext('2d')!;

  // JPEG has no alpha — paint an opaque background first so transparent areas
  // don't turn black. PNG/WebP get a transparent canvas.
  if (opaqueBg) {
    ctx.fillStyle = opaqueBg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  const viewport = { x: -bounds.x * scale, y: -bounds.y * scale, zoom: scale };
  const renderTarget = ids && ids.length > 0 ? filteredPage(page, ids) : page;
  // skipBackground=true: the page background color is a canvas UI affordance only —
  // exported images show only the node's own fills, not the page canvas background.
  renderPage(ctx, renderTarget, viewport, new Set(), images, undefined, null, file, undefined, true, undefined, true);
  return canvas;
}

export async function exportRaster(
  file: DesignFile,
  page: Page,
  scale: number,
  ids: string[] | undefined,
  images: Record<string, HTMLImageElement>,
  format: RasterFormat,
  // Per-layer export settings supply their own suffix and skip the save dialog, since a
  // batch can only show one.
  opts?: { suffix?: string; forceDownload?: boolean },
) {
  const opaqueBg = format === 'jpeg' ? (page.background || '#FFFFFF') : undefined;
  const canvas = rasterize(file, page, scale, ids, images, opaqueBg);
  const suffix = opts?.suffix ?? (scale === 1 ? '' : `@${scale}x`);
  // Synchronous toDataURL (not the async toBlob): an await before the native save dialog
  // consumes the click's transient activation and makes showSaveFilePicker throw.
  const dataUrl = canvas.toDataURL(RASTER_MIME[format], 0.92);
  return saveExportFile({
    dataUrl,
    suggestedName: `${exportBaseName(page, ids)}${suffix}`,
    extension: RASTER_EXT[format],
    description: `${format.toUpperCase()} Image`,
    mime: RASTER_MIME[format],
    forceDownload: opts?.forceDownload,
  });
}

// Back-compat thin wrapper.
export function exportPng(
  file: DesignFile, page: Page, scale: number,
  ids: string[] | undefined, images: Record<string, HTMLImageElement>,
) {
  return exportRaster(file, page, scale, ids, images, 'png');
}

// Build a shallow page that renders exactly the selected shapes as roots — even when
// they're nested inside a frame/group. Children store absolute coords, so promoting a
// nested shape to a render root draws it at the right place (and without its frame's
// clip, so the full shape exports). Descendants of an already-selected shape are dropped
// to avoid double-drawing.
function filteredPage(page: Page, ids: string[]): Page {
  const set = new Set(ids);
  const isDescendantOfSelected = (id: string): boolean => {
    let p = page.objects[id]?.parentId ?? null;
    while (p) {
      if (set.has(p)) return true;
      p = page.objects[p]?.parentId ?? null;
    }
    return false;
  };
  const roots = ids.filter(id => page.objects[id] && !isDescendantOfSelected(id));
  return { ...page, childIds: roots };
}

// ── SVG export ────────────────────────────────────────────────────────────────

export function exportSvg(file: DesignFile, page: Page, ids?: string[], opts?: { suffix?: string; forceDownload?: boolean }) {
  const images = file.images;
  let svg: string;
  if (ids && ids.length === 1 && page.objects[ids[0]]) {
    // Single node: use stored SVG markup directly (imported SVG) or render its subtree —
    // either way images embed as base64 so the file is fully self-contained.
    svg = exportShapeSvg(page.objects[ids[0]], page, images);
  } else {
    const target = ids && ids.length > 0
      ? { ...page, childIds: page.childIds.filter(id => ids.includes(id)) }
      : page;
    svg = pageToSvg(target, images);
  }
  return saveExportFile({
    text: svg,
    suggestedName: `${exportBaseName(page, ids)}${opts?.suffix ?? ''}`,
    extension: 'svg',
    description: 'SVG Image',
    mime: 'image/svg+xml',
    forceDownload: opts?.forceDownload,
  });
}

// ── PDF export (via pdf-lib, embeds a rasterized PNG) ──────────────────────────

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  const dataUrl = canvas.toDataURL('image/png');
  return fetch(dataUrl).then(r => r.arrayBuffer());
}

/**
 * Single-page PDF: the selection (or whole page) flattened onto one page.
 */
export async function exportPdf(
  file: DesignFile,
  page: Page,
  ids: string[] | undefined,
  images: Record<string, HTMLImageElement>,
) {
  const { PDFDocument } = await import('pdf-lib');
  const bounds = computeBounds(page, ids);
  const scale = 2;
  const canvas = rasterize(file, page, scale, ids, images);

  const pdf = await PDFDocument.create();
  const pdfPage = pdf.addPage([bounds.w, bounds.h]);
  const png = await pdf.embedPng(await canvasToPngBytes(canvas));
  pdfPage.drawImage(png, { x: 0, y: 0, width: bounds.w, height: bounds.h });

  const bytes = await pdf.save();
  return saveExportFile({
    blob: new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }),
    suggestedName: exportBaseName(page, ids),
    extension: 'pdf', description: 'PDF Document', mime: 'application/pdf',
  });
}

/**
 * Multi-page PDF: one page per top-level frame (Figma-style "export frames to PDF").
 * Each frame is rasterized to its own PDF page sized to the frame's bounds.
 * Falls back to a single page of the whole canvas when there are no top-level frames.
 */
export async function exportPdfMultiPage(
  file: DesignFile,
  page: Page,
  images: Record<string, HTMLImageElement>,
) {
  const { PDFDocument } = await import('pdf-lib');
  const scale = 2;

  const frameIds = page.childIds.filter(id => page.objects[id]?.type === 'frame');
  // No frames → behave like the single-page export.
  if (frameIds.length === 0) {
    await exportPdf(file, page, undefined, images);
    return;
  }

  const pdf = await PDFDocument.create();
  for (const frameId of frameIds) {
    const ids = [frameId];
    const bounds = computeBounds(page, ids);
    const canvas = rasterize(file, page, scale, ids, images);
    const pdfPage = pdf.addPage([bounds.w, bounds.h]);
    const png = await pdf.embedPng(await canvasToPngBytes(canvas));
    pdfPage.drawImage(png, { x: 0, y: 0, width: bounds.w, height: bounds.h });
  }

  const bytes = await pdf.save();
  return saveExportFile({
    blob: new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }),
    suggestedName: `${page.name || 'export'}-frames`,
    extension: 'pdf', description: 'PDF Document', mime: 'application/pdf',
  });
}
