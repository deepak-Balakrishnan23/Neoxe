import { Shape, Page, Fill, GradientStop, TextStyle, TextParagraph, DesignFile, ImageFill } from '../../shared/types';
import { gridTracks } from '../../shared/layoutGrid';
import { canvasColors as CC } from '../theme';
import { wrapLines } from './textLayout';
import { ensureFontLoaded } from './fontLoader';

// Module-level editing id — set per render frame so drawText can see it without
// threading the value through every function signature.
let _editingTextId: string | null = null;
// Shapes currently owned by a DOM edit overlay (vector/svg/path edit) — the canvas skips
// drawing these so the crisp editable overlay shows instead. Everything else (including
// non-edited vectors) draws on the canvas so the drag preview moves it live.
let _overlayHiddenIds: Set<string> = new Set();
// Suppresses the layout-grid overlay for export renders.
let _hideLayoutGrids = false;
// Decoded images for the current render, so image FILLS can be painted without threading
// the map through every fill call site.
let _fillImages: Record<string, HTMLImageElement> = {};

// External drag preview — written by FrameLabels during label-initiated drag, read on
// every rAF tick by draw(). Keyed by shape id; values override the stored position.
export const externalDragPreview: Map<string, ShapePreview> = new Map();

// Visible document rect for viewport culling — set per render frame by renderPage.
// Shapes whose (rotated, effect-padded) AABB misses this rect are skipped, so a frame's
// cost scales with what's on screen instead of the whole document. Derived from device-px
// canvas dims, so in the app it's ~dpr× larger than the true viewport — conservative:
// never wrongly culls, and exports (exact-size canvas, no DPR transform) stay exact.
let _cullRect: { x: number; y: number; w: number; h: number } | null = null;

function isOffscreen(shape: Shape): boolean {
  const r = _cullRect;
  if (!r) return false;
  // Pad by everything that can paint outside the shape's box.
  let pad = 0;
  for (const s of shape.shadows) {
    if (!s.hidden) pad = Math.max(pad, Math.abs(s.offsetX) + s.blur + (s.spread ?? 0), Math.abs(s.offsetY) + s.blur + (s.spread ?? 0));
  }
  for (const st of shape.strokes) pad = Math.max(pad, st.width);
  if (shape.blur && !shape.blur.hidden) pad = Math.max(pad, shape.blur.value * 2);
  // Rotated AABB half-extents about the shape's center.
  const cx = shape.x + shape.width / 2, cy = shape.y + shape.height / 2;
  let hw = shape.width / 2, hh = shape.height / 2;
  if (shape.rotation) {
    const rad = (shape.rotation * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    [hw, hh] = [hw * cos + hh * sin, hw * sin + hh * cos];
  }
  hw += pad; hh += pad;
  return cx + hw < r.x || cx - hw > r.x + r.w || cy + hh < r.y || cy - hh > r.y + r.h;
}

// A shape can be skipped wholesale only when nothing outside its own box depends on it:
// leaves always; clipping frames (children can't escape the clip). Groups and non-clipping
// frames still recurse so each child gets its own cull test.
function canCullSubtree(shape: Shape): boolean {
  return shape.childIds.length === 0 || (shape.type === 'frame' && shape.clipContent);
}

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
  // Layout grids are an editing aid — exports pass true so they never reach the output.
  hideLayoutGrids?: boolean,
) {
  _editingTextId = editingTextId ?? null;
  _overlayHiddenIds = hiddenOverlayIds ?? new Set();
  _hideLayoutGrids = hideLayoutGrids ?? false;
  _fillImages = images;
  const { width, height } = ctx.canvas;

  // Opaque background fill already overwrites the whole canvas, so clearRect is only needed
  // for the transparent (export) path.
  if (skipBackground) {
    ctx.clearRect(0, 0, width, height);
  } else {
    ctx.fillStyle = page.background || CC.backdrop;
    ctx.fillRect(0, 0, width, height);
  }

  ctx.save();
  ctx.translate(viewport.x, viewport.y);
  ctx.scale(viewport.zoom, viewport.zoom);

  // Visible doc rect (device-px dims → conservative in the app, exact for exports).
  _cullRect = {
    x: -viewport.x / viewport.zoom,
    y: -viewport.y / viewport.zoom,
    w: width / viewport.zoom,
    h: height / viewport.zoom,
  };

  // Draw root shapes in order (with preview overrides + instance resolution)
  drawChildList(ctx, page.childIds, page, images, preview, file);

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
  _hideLayoutGrids = false;
  _fillImages = {};
  _cullRect = null;
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  page: Page,
  images: Record<string, HTMLImageElement>,
  preview?: Map<string, ShapePreview>,
  file?: DesignFile,
) {
  // Viewport culling: skip everything the viewport can't see. Groups/non-clipping
  // frames fall through even when their own box is off-screen — their children carry
  // absolute coords and are culled individually on recursion.
  if (isOffscreen(shape) && canCullSubtree(shape)) return;
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
  // Mirror the shape's own drawing. A container's descendants are mirrored positionally
  // by the flip command, and each carries its own flag, so this must not cascade.
  if (shape.flipH || shape.flipV) ctx.scale(shape.flipH ? -1 : 1, shape.flipV ? -1 : 1);
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
      drawPath(ctx, shape);
      break;
    case 'bool':
      drawBool(ctx, shape, page, images, preview, file);
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

  // A non-clipping frame reaches here with its own box off-screen (children may still be
  // visible) — skip its fill/stroke, which can't be seen, and only recurse.
  if (!isOffscreen(shape)) {
    applyFills(ctx, shape.fills, 0, 0, width, height, radii);
    for (const stroke of shape.strokes) {
      applyStroke(ctx, stroke, 0, 0, width, height, 'rect', radii);
    }
  }

  // Draw frame children. FLAT coordinate model: children carry absolute document coords
  // and their OWN rotation (a parent rotation is baked into each child by the engine's
  // rotation cascade). So escape this frame's full local transform — translation AND
  // rotation — before drawing them; staying inside the parent's rotation would rotate
  // them twice. (The clip path above intentionally stays in the frame's rotated space.)
  const drawChildren = () => {
    ctx.save();
    // Inverse of drawShape's translate(cx,cy)·rotate(θ)·scale(flip)·translate(-w/2,-h/2)
    // — back to document space, where children's absolute coordinates make sense.
    ctx.translate(shape.width / 2, shape.height / 2);
    if (shape.flipH || shape.flipV) ctx.scale(shape.flipH ? -1 : 1, shape.flipV ? -1 : 1);
    if (shape.rotation) ctx.rotate((-shape.rotation * Math.PI) / 180);
    ctx.translate(-(shape.x + shape.width / 2), -(shape.y + shape.height / 2));
    drawChildList(ctx, shape.childIds, page, images, preview, file);
    ctx.restore();
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

  // Layout grids overlay the frame's contents (Figma) — they're an alignment aid, so
  // they have to stay visible over whatever sits on top of them.
  if (shape.type === 'frame' && !_hideLayoutGrids && shape.layoutGrids?.length && !isOffscreen(shape)) {
    ctx.save();
    boxPath(ctx, 0, 0, width, height, radii);
    ctx.clip();
    for (const g of shape.layoutGrids) {
      if (!g.visible) continue;
      ctx.globalAlpha = g.opacity;
      ctx.fillStyle = g.color;
      if (g.type === 'grid') {
        const step = Math.max(1, g.size);
        // Hairlines rather than filled cells — a filled uniform grid would be a solid wash.
        for (let x = step; x < width; x += step) ctx.fillRect(x, 0, 1, height);
        for (let y = step; y < height; y += step) ctx.fillRect(0, y, width, 1);
      } else if (g.type === 'columns') {
        for (const t of gridTracks(g, width)) ctx.fillRect(t.start, 0, t.size, height);
      } else {
        for (const t of gridTracks(g, height)) ctx.fillRect(0, t.start, width, t.size);
      }
    }
    ctx.restore();
  }
}

/**
 * Paint a fill stack into the path currently on `ctx`. Used by the shapes that build
 * their own outline (ellipses, paths) so image paints work there too — a plain
 * `fillStyle` can't express one, it has to be clipped and drawn.
 */
function fillCurrentPath(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  rule: CanvasFillRule = 'nonzero',
) {
  const { width: w, height: h } = shape;
  for (let i = shape.fills.length - 1; i >= 0; i--) {
    const fill = shape.fills[i];
    ctx.save();
    ctx.globalAlpha = fill.opacity ?? 1;
    if (fill.type === 'image') {
      ctx.clip(rule);
      paintImageFill(ctx, fill, w, h);
    } else {
      ctx.fillStyle = buildFillStyle(ctx, fill, 0, 0, w, h);
      ctx.fill(rule);
    }
    ctx.restore();
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

  fillCurrentPath(ctx, shape);

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

  // Vertical placement: measure the block first so 'middle'/'bottom' can offset it.
  // (Figma's vertical alignment — 'top' needs no measurement pass.)
  const vAlign = shape.textVerticalAlign ?? 'top';
  let lineTop = 0; // top of current visual line, in shape-local coords
  if (vAlign !== 'top') {
    let total = 0;
    for (const para of paragraphs) {
      const span = para.spans[0] ?? { text: '' };
      const s: TextStyle = { ...style, ...(span.style ?? {}) };
      ctx.font = `${s.fontWeight} ${s.fontSize}px ${s.fontFamily}`;
      ctx.letterSpacing = `${s.letterSpacing ?? 0}px`;
      const text = para.spans.map(sp => sp.text).join('');
      const count = autoWidth ? 1 : wrapLines(ctx, text, shape.width).length;
      total += count * s.fontSize * s.lineHeight;
    }
    const slack = shape.height - total;
    lineTop = vAlign === 'middle' ? slack / 2 : slack;
  }
  for (const para of paragraphs) {
    ctx.textAlign = para.align as CanvasTextAlign;
    // Combine the paragraph's spans under the base style (these text shapes carry a
    // single span; per-span overrides only affect color/transform, applied below).
    const span = para.spans[0] ?? { text: '' };
    const s: TextStyle = { ...style, ...(span.style ?? {}) };
    // Kick off loading for not-yet-available fonts; when one arrives, the canvas
    // redraws via FONT_LOADED_EVENT (see Canvas.tsx) instead of staying on fallback.
    ensureFontLoaded(s.fontFamily, s.fontWeight);
    ctx.font = `${s.fontWeight} ${s.fontSize}px ${s.fontFamily}`;
    ctx.fillStyle = s.color;
    ctx.letterSpacing = `${s.letterSpacing ?? 0}px`;

    let text = para.spans.map(sp => sp.text).join('');
    if (s.textTransform === 'uppercase') text = text.toUpperCase();
    else if (s.textTransform === 'lowercase') text = text.toLowerCase();
    else if (s.textTransform === 'capitalize') text = text.replace(/(^|\s)(\p{L})/gu, (_m, sp, ch) => sp + ch.toUpperCase());

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

// Fired when a lazily-rasterized SVG/vector image finishes decoding. Canvas listens and
// requests one repaint — otherwise a freshly-cached image (first draw, or after
// invalidateSvgCache) draws blank until some unrelated repaint happens, which is why an
// imported SVG could "vanish" until the next click.
export const SVG_DECODED_EVENT = 'neouxe:svg-decoded';
function newSvgImage(markup: string): HTMLImageElement {
  const img = new Image();
  img.onload = () => { try { window.dispatchEvent(new Event(SVG_DECODED_EVENT)); } catch { /* SSR/no window */ } };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
  return img;
}

export function invalidateSvgCache(id: string) {
  svgImageCache.delete(id);
}

function drawSVG(ctx: CanvasRenderingContext2D, shape: Shape) {
  if (!shape.svgContent) return;
  let img = svgImageCache.get(shape.id);
  if (!img) {
    img = newSvgImage(shape.svgContent);
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
    img = newSvgImage(markup);
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

  fillCurrentPath(ctx, shape, 'evenodd');

  for (const stroke of shape.strokes) {
    ctx.save();
    ctx.strokeStyle = stroke.color;
    ctx.globalAlpha = stroke.opacity;
    ctx.lineWidth = stroke.width;
    ctx.stroke();
    ctx.restore();
  }
}

// Canvas composite op implementing each boolean, applied to every operand after the first.
const BOOL_COMPOSITE: Record<NonNullable<Shape['boolType']>, GlobalCompositeOperation> = {
  union: 'source-over',
  difference: 'destination-out',
  intersection: 'destination-in',
  exclusion: 'xor',
};

// An offscreen canvas covering `box` at the current device scale, with its own context
// pre-transformed into DOCUMENT space so shapes can be drawn by absolute coordinates.
// Returns null when the box is degenerate or absurdly large.
//
// Composites are done by combining whole LAYERS, never by setting a composite mode and
// then calling drawShape — drawShape sets its own composite from the shape's blend mode
// and would wipe it out.
function layerCanvas(
  ctx: CanvasRenderingContext2D,
  box: { x: number; y: number; width: number; height: number },
  paint: (octx: CanvasRenderingContext2D) => void,
): HTMLCanvasElement | null {
  const t = ctx.getTransform();
  const sx = Math.hypot(t.a, t.b) || 1;
  const sy = Math.hypot(t.c, t.d) || 1;
  const w = Math.ceil(box.width * sx);
  const h = Math.ceil(box.height * sy);
  if (w < 1 || h < 1 || w * h > 32e6) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const octx = canvas.getContext('2d');
  if (!octx) return null;
  octx.scale(sx, sy);
  octx.translate(-box.x, -box.y);
  paint(octx);
  return canvas;
}

/**
 * Draw a container's children in order, honouring mask layers: a child with `isMask`
 * clips every later sibling to its own alpha (Figma's "Use as mask"). The mask and the
 * layers it covers are composed offscreen so the clip can't touch anything already on
 * the canvas beneath the container.
 *
 * `ctx` must already be in DOCUMENT space — children carry absolute coordinates.
 */
function drawChildList(
  ctx: CanvasRenderingContext2D,
  childIds: string[],
  page: Page,
  images: Record<string, HTMLImageElement>,
  preview?: Map<string, ShapePreview>,
  file?: DesignFile,
) {
  const resolve = (id: string): Shape | null => {
    let child = page.objects[id];
    if (!child || child.hidden) return null;
    if (preview?.has(id)) child = { ...child, ...preview.get(id) };
    if (file && child.masterId) child = resolveInstance(child, file);
    return child;
  };

  for (let i = 0; i < childIds.length; i++) {
    const child = resolve(childIds[i]);
    if (!child) continue;

    if (!child.isMask) { drawShape(ctx, child, page, images, preview, file); continue; }

    // Mask: everything from here to the end of the list is clipped to this layer.
    const masked = childIds.slice(i + 1).map(resolve).filter((s): s is Shape => !!s);
    if (masked.length === 0) return;
    const box = { x: child.x, y: child.y, width: child.width, height: child.height };
    const content = layerCanvas(ctx, box, octx => {
      for (const m of masked) drawShape(octx, m, page, images, preview, file);
    });
    const maskLayer = layerCanvas(ctx, box, octx => {
      drawShape(octx, { ...child, opacity: 1, blendMode: 'normal' }, page, images, preview, file);
    });
    if (!content || !maskLayer) {
      for (const m of masked) drawShape(ctx, m, page, images, preview, file);
      return;
    }
    const cctx = content.getContext('2d')!;
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.globalCompositeOperation = 'destination-in';
    cctx.drawImage(maskLayer, 0, 0);
    ctx.drawImage(content, box.x, box.y, box.width, box.height);
    return;
  }
}

// Boolean group: compose the operands as separate layers with the op's composite mode,
// then tint the result with the group's own fill (Figma gives the result one style).
function drawBool(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  page: Page,
  images: Record<string, HTMLImageElement>,
  preview?: Map<string, ShapePreview>,
  file?: DesignFile,
) {
  // The engine computes the real outline for boolean groups; draw that when it's there —
  // it's exact, exportable, and far cheaper than compositing layers. The per-pixel path
  // below is the fallback for geometry the clipper couldn't resolve.
  if (shape.content && shape.content.length > 0) { drawPath(ctx, shape); return; }
  if (shape.childIds.length === 0) { drawPath(ctx, shape); return; }
  const box = { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
  const operands: Shape[] = [];
  for (const childId of shape.childIds) {
    let child = page.objects[childId];
    if (!child || child.hidden) continue;
    if (preview?.has(childId)) child = { ...child, ...preview.get(childId) };
    operands.push(child);
  }
  if (operands.length === 0) return;

  const base = layerCanvas(ctx, box, octx => {
    drawShape(octx, operands[0], page, images, preview, file);
  });
  if (!base) return;
  const bctx = base.getContext('2d')!;
  const composite = BOOL_COMPOSITE[shape.boolType ?? 'union'];

  for (let i = 1; i < operands.length; i++) {
    const layer = layerCanvas(ctx, box, octx => {
      drawShape(octx, operands[i], page, images, preview, file);
    });
    if (!layer) continue;
    bctx.save();
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.globalCompositeOperation = composite;
    bctx.drawImage(layer, 0, 0);
    bctx.restore();
  }

  if (shape.fills.length > 0) {
    const tint = layerCanvas(ctx, box, octx => {
      applyFills(octx, shape.fills, box.x, box.y, box.width, box.height);
    });
    if (tint) {
      bctx.save();
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.globalCompositeOperation = 'source-in';
      bctx.drawImage(tint, 0, 0);
      bctx.restore();
    }
  }
  // ctx sits at the shape's top-left (drawShape's transform), so the box starts at 0,0.
  ctx.drawImage(base, 0, 0, shape.width, shape.height);
}

function drawGroup(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  page: Page,
  images: Record<string, HTMLImageElement>,
  preview?: Map<string, ShapePreview>,
  file?: DesignFile,
) {
  ctx.save();
  // Flat model: escape the group's full local transform (see drawRect.drawChildren).
  ctx.translate(shape.width / 2, shape.height / 2);
  if (shape.flipH || shape.flipV) ctx.scale(shape.flipH ? -1 : 1, shape.flipV ? -1 : 1);
  if (shape.rotation) ctx.rotate((-shape.rotation * Math.PI) / 180);
  ctx.translate(-(shape.x + shape.width / 2), -(shape.y + shape.height / 2));
  drawChildList(ctx, shape.childIds, page, images, preview, file);
  ctx.restore();
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
    ctx.globalAlpha = fill.opacity ?? 1;
    if (fill.type === 'image') {
      // An image paint has to be clipped to the box — 'fill' and 'tile' both overflow it.
      ctx.beginPath();
      if (radii) boxPath(ctx, 0, 0, w, h, radii);
      else ctx.rect(0, 0, w, h);
      ctx.clip();
      paintImageFill(ctx, fill, w, h);
    } else {
      ctx.fillStyle = buildFillStyle(ctx, fill, x, y, w, h);
      if (radii) {
        boxPath(ctx, 0, 0, w, h, radii);
        ctx.fill();
      } else {
        ctx.fillRect(0, 0, w, h);
      }
    }
    ctx.restore();
  }
}

// Paint an image paint into the box at (0,0,w,h). The caller has already clipped.
function paintImageFill(ctx: CanvasRenderingContext2D, fill: ImageFill, w: number, h: number) {
  const img = _fillImages[fill.imageId];
  if (!img || !img.complete || img.naturalWidth === 0) return;
  const iw = img.naturalWidth, ih = img.naturalHeight;

  if (fill.scaleMode === 'tile') {
    const pattern = ctx.createPattern(img, 'repeat');
    if (!pattern) return;
    const scale = fill.tileScale && fill.tileScale > 0 ? fill.tileScale : 1;
    // setTransform isn't universally available on CanvasPattern; falling back to an
    // untransformed pattern still tiles, just at the image's natural size.
    pattern.setTransform?.(new DOMMatrix().scaleSelf(scale, scale));
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  if (fill.scaleMode === 'stretch') { ctx.drawImage(img, 0, 0, w, h); return; }

  // 'fill' covers the box (cropping the overflow); 'fit' contains the whole image.
  const scale = fill.scaleMode === 'fit' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
  const dw = iw * scale, dh = ih * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function buildFillStyle(
  ctx: CanvasRenderingContext2D,
  fill: Fill,
  x: number,
  y: number,
  w: number,
  h: number,
): string | CanvasGradient {
  // Image paints are drawn by paintImageFill — they never reach here.
  if (fill.type === 'image') return 'transparent';
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

// Hoisted to module scope — this was re-allocated once per shape per frame in the draw loop.
const BLEND_COMPOSITE: Partial<Record<Shape['blendMode'], GlobalCompositeOperation>> = {
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
function blendModeToComposite(mode: Shape['blendMode']): GlobalCompositeOperation {
  return BLEND_COMPOSITE[mode] ?? 'source-over';
}
