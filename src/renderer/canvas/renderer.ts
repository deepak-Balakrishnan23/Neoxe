import { Shape, Page, Fill, GradientStop, TextStyle, TextParagraph, DesignFile } from '../../shared/types';
import { canvasColors as CC } from '../theme';
import { wrapLines } from './textLayout';

// Module-level editing id — set per render frame so drawText can see it without
// threading the value through every function signature.
let _editingTextId: string | null = null;
// Shapes currently owned by a DOM edit overlay (vector/svg/path edit) — the canvas skips
// drawing these so the crisp editable overlay shows instead. Everything else (including
// non-edited vectors) draws on the canvas so the drag preview moves it live.
let _overlayHiddenIds: Set<string> = new Set();

// External drag preview — written by FrameLabels during label-initiated drag, read on
// every rAF tick by draw(). Keyed by shape id; values override the stored position.
export const externalDragPreview: Map<string, ShapePreview> = new Map();

export interface Viewport {
  x: number;      // canvas-space translation
  y: number;
  zoom: number;   // 1 = 100%
}

// preview: per-shape overrides applied during drag (position/size only)
export type ShapePreview = Partial<Pick<Shape, 'x' | 'y' | 'width' | 'height' | 'rotation'>>;

// Resolve an instance shape against its master component
function resolveInstance(shape: Shape, file: DesignFile): Shape {
  if (!shape.masterId) return shape;
  const comp = file.components[shape.masterId];
  if (!comp) return shape;
  const masterPage = file.pages.find(p => p.id === comp.pageId);
  if (!masterPage) return shape;
  const master = masterPage.objects[comp.shapeId];
  if (!master) return shape;
  // Merge: master appearance → instance overrides → instance position/identity
  return {
    ...master,
    ...(shape.overrides ?? {}),
    id: shape.id,
    name: shape.name,
    x: shape.x, y: shape.y,
    width: (shape.overrides as any)?.width ?? master.width,
    height: (shape.overrides as any)?.height ?? master.height,
    rotation: (shape.overrides as any)?.rotation ?? master.rotation,
    parentId: shape.parentId, frameId: shape.frameId,
    childIds: shape.childIds,
    hidden: shape.hidden, locked: shape.locked,
    masterId: shape.masterId, overrides: shape.overrides,
    selrect: shape.selrect,
  };
}

export function renderPage(
  ctx: CanvasRenderingContext2D,
  page: Page,
  viewport: Viewport,
  selectedIds: Set<string>,
  images: Record<string, HTMLImageElement>,
  preview?: Map<string, ShapePreview>,
  marquee?: { x: number; y: number; width: number; height: number } | null,
  file?: DesignFile,
  editingTextId?: string | null,
  skipBackground?: boolean,
  hiddenOverlayIds?: Set<string>,
) {
  _editingTextId = editingTextId ?? null;
  _overlayHiddenIds = hiddenOverlayIds ?? new Set();
  const { width, height } = ctx.canvas;

  ctx.clearRect(0, 0, width, height);

  if (!skipBackground) {
    ctx.fillStyle = page.background || CC.backdrop;
    ctx.fillRect(0, 0, width, height);
  }

  ctx.save();
  ctx.translate(viewport.x, viewport.y);
  ctx.scale(viewport.zoom, viewport.zoom);

  // Draw root shapes in order (with preview overrides + instance resolution)
  for (const id of page.childIds) {
    let shape = page.objects[id];
    if (!shape || shape.hidden) continue;
    if (preview?.has(id)) shape = { ...shape, ...preview.get(id) };
    if (file && shape.masterId) shape = resolveInstance(shape, file);
    drawShape(ctx, shape, page, images, preview, file);
  }

  ctx.restore();

  // Selection overlays are rendered as SVG in Canvas.tsx — no canvas drawing here.

  // Marquee
  if (marquee) {
    ctx.save();
    ctx.strokeStyle = CC.accent;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.fillStyle = CC.accentFill;
    ctx.fillRect(marquee.x, marquee.y, marquee.width, marquee.height);
    ctx.strokeRect(marquee.x, marquee.y, marquee.width, marquee.height);
    ctx.restore();
  }

  _editingTextId = null;
  _overlayHiddenIds = new Set();
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  page: Page,
  images: Record<string, HTMLImageElement>,
  preview?: Map<string, ShapePreview>,
  file?: DesignFile,
) {
  ctx.save();
  ctx.globalAlpha = shape.opacity;
  ctx.globalCompositeOperation = blendModeToComposite(shape.blendMode);

  // Shadows
  if (shape.shadows.length > 0) {
    const s = shape.shadows.find(sh => !sh.hidden && sh.type === 'drop');
    if (s) {
      const [r, g, b] = hexToRgb(s.color);
      ctx.shadowColor = `rgba(${r},${g},${b},${s.opacity})`;
      ctx.shadowOffsetX = s.offsetX;
      ctx.shadowOffsetY = s.offsetY;
      ctx.shadowBlur = s.blur;
    }
  }

  // Layer blur
  if (shape.blur && !shape.blur.hidden && shape.blur.type === 'layer-blur') {
    ctx.filter = `blur(${shape.blur.value}px)`;
  }

  // Move to shape's top-left in document space, rotating around its center
  ctx.translate(shape.x + shape.width / 2, shape.y + shape.height / 2);
  if (shape.rotation) ctx.rotate((shape.rotation * Math.PI) / 180);
  // Now (0,0) is the center; shift so top-left is (0,0) for drawing primitives
  ctx.translate(-shape.width / 2, -shape.height / 2);

  switch (shape.type) {
    case 'rect':
    case 'frame':
      drawRect(ctx, shape, page, images, preview, file);
      break;
    case 'circle':
      drawCircle(ctx, shape);
      break;
    case 'text':
      drawText(ctx, shape);
      break;
    case 'image':
      drawImage(ctx, shape, images);
      break;
    case 'svg':
      if (!_overlayHiddenIds.has(shape.id)) drawSVG(ctx, shape);
      break;
    case 'path':
    case 'bool':
      drawPath(ctx, shape);
      break;
    case 'vector':
      // Draw on the canvas so the drag preview moves it live (same as 'svg'). The DOM
      // VectorOverlay only takes over while this shape is being edited.
      if (!_overlayHiddenIds.has(shape.id)) drawVector(ctx, shape);
      break;
    case 'group':
      drawGroup(ctx, shape, page, images, preview, file);
      break;
  }

  ctx.restore();
}

function drawRect(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  page: Page,
  images: Record<string, HTMLImageElement>,
  preview?: Map<string, ShapePreview>,
  file?: DesignFile,
) {
  const { width, height } = shape;
  const radii = shape.cornerRadii ?? undefined;

  applyFills(ctx, shape.fills, 0, 0, width, height, radii);

  for (const stroke of shape.strokes) {
    applyStroke(ctx, stroke, 0, 0, width, height, 'rect', radii);
  }

  // Draw frame children — children use absolute document coords, so undo the frame's translation
  const drawChildren = () => {
    for (const childId of shape.childIds) {
      let child = page.objects[childId];
      if (!child || child.hidden) continue;
      if (preview?.has(childId)) child = { ...child, ...preview.get(childId) };
      if (file && child.masterId) child = resolveInstance(child, file);
      ctx.save();
      ctx.translate(-shape.x, -shape.y);
      drawShape(ctx, child, page, images, preview, file);
      ctx.restore();
    }
  };

  if (shape.type === 'frame' && shape.clipContent) {
    ctx.save();
    boxPath(ctx, 0, 0, width, height, radii);
    ctx.clip();
    drawChildren();
    ctx.restore();
  } else if (shape.type === 'frame') {
    drawChildren();
  }
}

function drawCircle(ctx: CanvasRenderingContext2D, shape: Shape) {
  const { width, height } = shape;
  const cx = width / 2;
  const cy = height / 2;
  const rx = width / 2;
  const ry = height / 2;

  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);

  for (let i = shape.fills.length - 1; i >= 0; i--) {
    const fill = shape.fills[i];
    ctx.save();
    ctx.fillStyle = buildFillStyle(ctx, fill, 0, 0, width, height);
    ctx.globalAlpha = fill.opacity ?? 1;
    ctx.fill();
    ctx.restore();
  }

  for (const stroke of shape.strokes) {
    applyStroke(ctx, stroke, 0, 0, width, height, 'ellipse');
  }
}

function drawText(ctx: CanvasRenderingContext2D, shape: Shape) {
  // The textarea overlay handles rendering while in edit mode
  if (shape.id === _editingTextId) return;

  const style: TextStyle = shape.textStyle ?? {
    fontFamily: 'system-ui, sans-serif',
    fontWeight: 400,
    fontSize: 16,
    lineHeight: 1.2,
    letterSpacing: 0,
    textDecoration: 'none',
    textTransform: 'none',
    color: '#000000',
    opacity: 1,
  };

  const paragraphs: TextParagraph[] = shape.paragraphs ?? [
    { align: 'left', spans: [{ text: shape.name }] },
  ];

  const autoWidth = shape.textAutoWidth === true;

  ctx.save();
  ctx.globalAlpha = style.opacity;
  ctx.textBaseline = 'alphabetic';

  // Anchor x within the box per alignment
  const anchorX = (align: TextParagraph['align']) =>
    align === 'center' ? shape.width / 2 : align === 'right' ? shape.width : 0;

  let lineTop = 0; // top of current visual line, in shape-local coords
  for (const para of paragraphs) {
    ctx.textAlign = para.align as CanvasTextAlign;
    // Combine the paragraph's spans under the base style (these text shapes carry a
    // single span; per-span overrides only affect color/transform, applied below).
    const span = para.spans[0] ?? { text: '' };
    const s: TextStyle = { ...style, ...(span.style ?? {}) };
    ctx.font = `${s.fontWeight} ${s.fontSize}px ${s.fontFamily}`;
    ctx.fillStyle = s.color;
    ctx.letterSpacing = `${s.letterSpacing}px`;

    let text = para.spans.map(sp => sp.text).join('');
    if (s.textTransform === 'uppercase') text = text.toUpperCase();
    else if (s.textTransform === 'lowercase') text = text.toLowerCase();
    else if (s.textTransform === 'capitalize') text = text.replace(/\b\w/g, c => c.toUpperCase());

    const lineH = s.fontSize * s.lineHeight;
    const ax = anchorX(para.align);
    // Auto-width = one visual line per paragraph. Fixed-width = word-wrap to box width.
    const lines = autoWidth ? [text] : wrapLines(ctx, text, shape.width);
    for (const line of lines) {
      // Baseline kept at fontSize below the line top so the overlay textarea
      // (which uses the same line-height) lands in the same place after commit.
      const baseline = lineTop + s.fontSize;

      // Fill the glyphs
      ctx.fillStyle = s.color;
      ctx.fillText(line, ax, baseline);

      // Stroke the glyph outlines (Figma strokes text just like any other shape)
      for (const stroke of shape.strokes) {
        ctx.save();
        ctx.globalAlpha = style.opacity * (stroke.opacity ?? 1);
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.width;
        ctx.lineJoin = 'round';
        if (stroke.style === 'dashed') ctx.setLineDash([stroke.width * 2, stroke.width]);
        else if (stroke.style === 'dotted') ctx.setLineDash([stroke.width, stroke.width * 1.6]);
        ctx.strokeText(line, ax, baseline);
        ctx.restore();
      }

      // Underline / strike-through
      if (s.textDecoration === 'underline' || s.textDecoration === 'line-through') {
        const lineW = ctx.measureText(line).width;
        const x0 = para.align === 'center' ? ax - lineW / 2 : para.align === 'right' ? ax - lineW : ax;
        const ly = s.textDecoration === 'underline'
          ? baseline + s.fontSize * 0.12
          : baseline - s.fontSize * 0.3;
        ctx.save();
        ctx.strokeStyle = s.color;
        ctx.lineWidth = Math.max(1, s.fontSize * 0.06);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x0, ly);
        ctx.lineTo(x0 + lineW, ly);
        ctx.stroke();
        ctx.restore();
      }

      lineTop += lineH;
    }
  }
  ctx.restore();
}

function drawImage(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  images: Record<string, HTMLImageElement>,
) {
  if (!shape.imageId) return;
  const img = images[shape.imageId];
  if (!img) return;
  ctx.drawImage(img, 0, 0, shape.width, shape.height);
}

// SVG nodes: cache HTMLImageElement by shape id to avoid re-creating per frame.
const svgImageCache = new Map<string, HTMLImageElement>();

export function invalidateSvgCache(id: string) {
  svgImageCache.delete(id);
}

function drawSVG(ctx: CanvasRenderingContext2D, shape: Shape) {
  if (!shape.svgContent) return;
  let img = svgImageCache.get(shape.id);
  if (!img) {
    img = new Image();
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(shape.svgContent);
    img.src = url;
    svgImageCache.set(shape.id, img);
  }
  if (img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, 0, 0, shape.width, shape.height);
  }
}

// Draw a vector node (imported SVG element/group) on the canvas. Wrap its stored inner
// markup in an <svg> sized to its original viewBox — mirrors VectorOverlay — and rasterize
// via the same cache so a move/drag preview repositions it in real time.
function drawVector(ctx: CanvasRenderingContext2D, shape: Shape) {
  const ow = shape.svgOriginalWidth || shape.width || 1;
  const oh = shape.svgOriginalHeight || shape.height || 1;
  const markup = shape.svgContent
    ?? (shape.svgInnerHTML
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ow} ${oh}">${shape.svgInnerHTML}</svg>`
      : null);
  if (!markup) return;
  let img = svgImageCache.get(shape.id);
  if (!img) {
    img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
    svgImageCache.set(shape.id, img);
  }
  if (img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, 0, 0, shape.width, shape.height);
  }
}

function drawPath(ctx: CanvasRenderingContext2D, shape: Shape) {
  if (!shape.content || shape.content.length === 0) return;

  ctx.beginPath();
  for (const seg of shape.content) {
    switch (seg.verb) {
      case 'M': ctx.moveTo(seg.coords[0], seg.coords[1]); break;
      case 'L': ctx.lineTo(seg.coords[0], seg.coords[1]); break;
      case 'C': ctx.bezierCurveTo(
        seg.coords[0], seg.coords[1],
        seg.coords[2], seg.coords[3],
        seg.coords[4], seg.coords[5],
      ); break;
      case 'Q': ctx.quadraticCurveTo(
        seg.coords[0], seg.coords[1],
        seg.coords[2], seg.coords[3],
      ); break;
      case 'Z': ctx.closePath(); break;
    }
  }

  for (let i = shape.fills.length - 1; i >= 0; i--) {
    const fill = shape.fills[i];
    ctx.save();
    ctx.fillStyle = buildFillStyle(ctx, fill, shape.x, shape.y, shape.width, shape.height);
    ctx.globalAlpha = fill.opacity ?? 1;
    ctx.fill('evenodd');
    ctx.restore();
  }

  for (const stroke of shape.strokes) {
    ctx.save();
    ctx.strokeStyle = stroke.color;
    ctx.globalAlpha = stroke.opacity;
    ctx.lineWidth = stroke.width;
    ctx.stroke();
    ctx.restore();
  }
}

function drawGroup(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  page: Page,
  images: Record<string, HTMLImageElement>,
  preview?: Map<string, ShapePreview>,
  file?: DesignFile,
) {
  for (const childId of shape.childIds) {
    let child = page.objects[childId];
    if (!child || child.hidden) continue;
    if (preview?.has(childId)) child = { ...child, ...preview.get(childId) };
    if (file && child.masterId) child = resolveInstance(child, file);
    ctx.save();
    ctx.translate(-shape.x, -shape.y);
    drawShape(ctx, child, page, images, preview, file);
    ctx.restore();
  }
}

type CornerRadii = { tl: number; tr: number; br: number; bl: number };

function boxPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radii?: CornerRadii) {
  ctx.beginPath();
  if (radii && (radii.tl || radii.tr || radii.br || radii.bl)) {
    ctx.roundRect(x, y, w, h, [radii.tl, radii.tr, radii.br, radii.bl]);
  } else {
    ctx.rect(x, y, w, h);
  }
}

function applyFills(
  ctx: CanvasRenderingContext2D,
  fills: Shape['fills'],
  x: number,
  y: number,
  w: number,
  h: number,
  radii?: CornerRadii,
) {
  // Figma stacks fills with index 0 on TOP (front). Paint back-to-front: last array
  // entry first, index 0 last — so lowering fill[0]'s opacity reveals the fills below.
  for (let i = fills.length - 1; i >= 0; i--) {
    const fill = fills[i];
    ctx.save();
    ctx.fillStyle = buildFillStyle(ctx, fill, x, y, w, h);
    ctx.globalAlpha = fill.opacity ?? 1;
    if (radii) {
      boxPath(ctx, 0, 0, w, h, radii);
      ctx.fill();
    } else {
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
  }
}

function buildFillStyle(
  ctx: CanvasRenderingContext2D,
  fill: Fill,
  x: number,
  y: number,
  w: number,
  h: number,
): string | CanvasGradient {
  if (fill.type === 'solid') return fill.color;

  if (fill.type === 'linear-gradient') {
    const grd = ctx.createLinearGradient(
      x + fill.startX * w,
      y + fill.startY * h,
      x + fill.endX * w,
      y + fill.endY * h,
    );
    addGradientStops(grd, fill.stops);
    return grd;
  }

  if (fill.type === 'radial-gradient') {
    const grd = ctx.createRadialGradient(
      x + fill.centerX * w,
      y + fill.centerY * h,
      0,
      x + fill.centerX * w,
      y + fill.centerY * h,
      fill.radius * Math.max(w, h),
    );
    addGradientStops(grd, fill.stops);
    return grd;
  }

  return '#000';
}

function addGradientStops(grd: CanvasGradient, stops: GradientStop[]) {
  for (const stop of stops) {
    const [r, g, b] = hexToRgb(stop.color);
    grd.addColorStop(stop.offset, `rgba(${r},${g},${b},${stop.opacity})`);
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full = clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function applyStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Shape['strokes'][0],
  x: number,
  y: number,
  w: number,
  h: number,
  shape: 'rect' | 'ellipse',
  radii?: CornerRadii,
) {
  ctx.save();
  ctx.strokeStyle = stroke.color;
  ctx.globalAlpha = stroke.opacity;
  ctx.lineWidth = stroke.width;

  if (stroke.style === 'dashed') ctx.setLineDash([stroke.width * 3, stroke.width * 2]);
  else if (stroke.style === 'dotted') ctx.setLineDash([stroke.width, stroke.width]);

  if (shape === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else {
    boxPath(ctx, x, y, w, h, radii);
  }
  ctx.stroke();
  ctx.restore();
}

// Draws selection overlay in SCREEN space so handles are always 8px regardless of zoom
function drawSelectionOverlay(ctx: CanvasRenderingContext2D, shape: Shape, viewport: Viewport) {
  // Use live x/y/w/h (preview overrides these during drag; selrect is not updated mid-drag)
  const sr = { x: shape.x, y: shape.y, width: shape.width, height: shape.height };

  // Convert to screen coords
  const sx = sr.x * viewport.zoom + viewport.x;
  const sy = sr.y * viewport.zoom + viewport.y;
  const sw = sr.width * viewport.zoom;
  const sh = sr.height * viewport.zoom;

  ctx.save();
  ctx.strokeStyle = CC.accent;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.strokeRect(sx, sy, sw, sh);

  // Rotate handle (line + circle above TC)
  const tcx = sx + sw / 2;
  const tcy = sy;
  ctx.beginPath();
  ctx.moveTo(tcx, tcy);
  ctx.lineTo(tcx, tcy - 24);
  ctx.strokeStyle = CC.accentLine;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(tcx, tcy - 28, 5, 0, Math.PI * 2);
  ctx.fillStyle = CC.handleFill;
  ctx.fill();
  ctx.strokeStyle = CC.accent;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 8 resize handles
  const screenSelrect = { x: sx, y: sy, width: sw, height: sh };
  const handles = getHandlePositions(screenSelrect);
  for (const [hx, hy] of handles) {
    ctx.fillStyle = CC.handleFill;
    ctx.strokeStyle = CC.accent;
    ctx.lineWidth = 1.5;
    ctx.fillRect(hx - 4, hy - 4, 8, 8);
    ctx.strokeRect(hx - 4, hy - 4, 8, 8);
  }

  ctx.restore();
}

export function getHandlePositions(r: { x: number; y: number; width: number; height: number }) {
  const { x, y, width: w, height: h } = r;
  return [
    [x, y],
    [x + w / 2, y],
    [x + w, y],
    [x + w, y + h / 2],
    [x + w, y + h],
    [x + w / 2, y + h],
    [x, y + h],
    [x, y + h / 2],
  ] as [number, number][];
}

function blendModeToComposite(mode: Shape['blendMode']): GlobalCompositeOperation {
  const map: Partial<Record<Shape['blendMode'], GlobalCompositeOperation>> = {
    normal: 'source-over',
    multiply: 'multiply',
    screen: 'screen',
    overlay: 'overlay',
    darken: 'darken',
    lighten: 'lighten',
    'color-dodge': 'color-dodge',
    'color-burn': 'color-burn',
    'hard-light': 'hard-light',
    'soft-light': 'soft-light',
    difference: 'difference',
    exclusion: 'exclusion',
    hue: 'hue',
    saturation: 'saturation',
    color: 'color',
    luminosity: 'luminosity',
  };
  return map[mode] ?? 'source-over';
}
