// Image import pipeline. Turns an arbitrary image File (incl. HEIC/HEIF) into a
// PNG/JPEG data-URL plus its natural pixel size, ready to drop onto the canvas.
//
// Browser-native formats (PNG, JPEG, GIF, WEBP, BMP, SVG) are read directly.
// HEIC/HEIF can't be decoded by <img>/canvas, so they're converted to PNG via
// heic2any (lazy-loaded only when a HEIC file actually appears).

import { VectorChildNode } from '../../shared/types';
import { sanitizeSvgMarkup } from '../../shared/sanitizeSvg';

export interface ImportedImage {
  dataUrl: string;
  width: number;
  height: number;
  name?: string;
  svgContent?: string;
  svgInnerHTML?: string;
  vectorChildren?: VectorChildNode[];
  svgOriginalWidth?: number;
  svgOriginalHeight?: number;
}

// Extensions we accept. `image/*` covers most; HEIC often arrives with an empty or
// non-standard MIME type, so we match on extension too.
export const ACCEPTED_IMAGE_EXTS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
  '.heic', '.heif', '.avif',
];

export const IMAGE_ACCEPT_ATTR = `image/*,${ACCEPTED_IMAGE_EXTS.join(',')}`;

function isHeic(file: File): boolean {
  const name = file.name.toLowerCase();
  return file.type === 'image/heic' || file.type === 'image/heif'
    || name.endsWith('.heic') || name.endsWith('.heif');
}

export function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  const name = file.name.toLowerCase();
  return ACCEPTED_IMAGE_EXTS.some(ext => name.endsWith(ext));
}

async function fileToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

function measure(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
    img.onerror = () => reject(new Error('Could not decode image'));
    img.src = dataUrl;
  });
}

function parseSVGColor(value: string | null | undefined): string | null {
  if (!value || value === 'none') return null;
  if (value === 'inherit' || value === 'currentColor') return null;
  return value;
}

let _vcCounter = 0;
function vcId() { return `vc_${++_vcCounter}_${Math.random().toString(36).slice(2, 6)}`; }

function parseSVGChildren(parentEl: Element): VectorChildNode[] {
  return Array.from(parentEl.children).flatMap((el): VectorChildNode[] => {
    const tag = el.tagName.toLowerCase();
    const get = (attr: string) => el.getAttribute(attr);
    const getF = (attr: string, def = 0) => parseFloat(get(attr) ?? String(def)) || def;
    const fillAttr = get('fill') ?? (el as HTMLElement).style?.fill ?? 'black';
    const strokeAttr = get('stroke') ?? (el as HTMLElement).style?.stroke;
    const base = {
      id: vcId(),
      name: get('id') || tag,
      fill: parseSVGColor(fillAttr),
      stroke: parseSVGColor(strokeAttr),
      strokeWidth: getF('stroke-width'),
      opacity: (v => Number.isFinite(v) ? v : 1)(parseFloat(get('opacity') ?? '1')),
      transform: get('transform') ?? undefined,
    };

    if (tag === 'rect') return [{ ...base, type: 'vector-rect' as const, x: getF('x'), y: getF('y'), width: getF('width'), height: getF('height'), rx: getF('rx') }];
    if (tag === 'circle') return [{ ...base, type: 'vector-circle' as const, cx: getF('cx'), cy: getF('cy'), r: getF('r') }];
    if (tag === 'ellipse') return [{ ...base, type: 'vector-ellipse' as const, cx: getF('cx'), cy: getF('cy'), rx: getF('rx'), ry: getF('ry') }];
    if (tag === 'path') { const d = get('d'); if (!d) return []; return [{ ...base, type: 'vector-path' as const, d }]; }
    if (tag === 'polygon') { const pts = get('points'); if (!pts) return []; return [{ ...base, type: 'vector-poly' as const, points: pts, closed: true }]; }
    if (tag === 'polyline') { const pts = get('points'); if (!pts) return []; return [{ ...base, type: 'vector-poly' as const, points: pts, closed: false }]; }
    if (tag === 'line') return [{ ...base, type: 'vector-line' as const, x1: getF('x1'), y1: getF('y1'), x2: getF('x2'), y2: getF('y2') }];
    if (tag === 'g' || tag === 'symbol') {
      const children = parseSVGChildren(el);
      if (children.length === 0) return [];
      return [{ ...base, type: 'vector-group' as const, children }];
    }
    // defs, title, desc, etc. — skip
    if (tag === 'defs' || tag === 'title' || tag === 'desc' || tag === 'metadata') return [];
    return [{ ...base, type: 'vector-raw' as const, outerHTML: el.outerHTML }];
  });
}

/**
 * Convert a File into a canvas-ready data-URL + natural size.
 * Throws with a friendly message if the format can't be decoded.
 */
export async function importImageFile(file: File): Promise<ImportedImage> {
  let dataUrl: string;

  if (isHeic(file)) {
    // Lazy-load the (heavy) decoder only on demand.
    const heic2any = (await import('heic2any')).default as (opts: {
      blob: Blob; toType?: string; quality?: number;
    }) => Promise<Blob | Blob[]>;
    const converted = await heic2any({ blob: file, toType: 'image/png' });
    const blob = Array.isArray(converted) ? converted[0] : converted;
    dataUrl = await fileToDataUrl(blob);
  } else {
    dataUrl = await fileToDataUrl(file);
  }

  const { width, height } = await measure(dataUrl);
  const name = file.name.replace(/\.[^/.]+$/, '') || undefined;
  const svgContent = isSVGFile(file) ? await file.text() : undefined;

  let vectorChildren: VectorChildNode[] | undefined;
  let svgOriginalWidth: number | undefined;
  let svgOriginalHeight: number | undefined;
  let svgInnerHTML: string | undefined;
  if (isSVGFile(file) && svgContent) {
    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(svgContent, 'image/svg+xml');
    const svgEl = svgDoc.querySelector('svg');
    vectorChildren = svgEl ? parseSVGChildren(svgEl) : [];
    if (svgEl) {
      // Strip script-capable content at the door (defense in depth — the overlay
      // sanitizes again at injection time).
      svgInnerHTML = sanitizeSvgMarkup(svgEl.innerHTML);
      const vb = svgEl.getAttribute('viewBox');
      if (vb) {
        const parts = vb.trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4) { svgOriginalWidth = parts[2]; svgOriginalHeight = parts[3]; }
      }
      if (!svgOriginalWidth) svgOriginalWidth = parseFloat(svgEl.getAttribute('width') ?? '') || width;
      if (!svgOriginalHeight) svgOriginalHeight = parseFloat(svgEl.getAttribute('height') ?? '') || height;
    }
  }

  return { dataUrl, width, height, name, svgContent, svgInnerHTML, vectorChildren, svgOriginalWidth, svgOriginalHeight };
}

export function isSVGFile(file: File): boolean {
  return file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
}

/** Filter + import a FileList/array of dropped files, skipping non-images. */
export async function importImageFiles(files: File[]): Promise<ImportedImage[]> {
  const imageFiles = files.filter(isImageFile);
  const out: ImportedImage[] = [];
  for (const f of imageFiles) {
    try {
      out.push(await importImageFile(f));
    } catch (e) {
      console.error('Image import failed for', f.name, e);
    }
  }
  return out;
}
