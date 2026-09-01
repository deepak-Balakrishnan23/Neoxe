import { Shape, Page, Fill, Shadow } from './types';
import { sanitizeSvgMarkup } from './sanitizeSvg';

// ── Code generation: shape → CSS / SVG / HTML / React / Tailwind ───────────────

// Convert a hex + opacity to a CSS color string.
function cssColor(hex: string, opacity = 1): string {
  if (opacity >= 1) return hex;
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${round(opacity, 2)})`;
}

function round(n: number, d = 0): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function fillToCss(fill: Fill): string {
  if (fill.type === 'solid') return cssColor(fill.color, fill.opacity);
  if (fill.type === 'linear-gradient') {
    const angle = Math.round(Math.atan2(fill.endY - fill.startY, fill.endX - fill.startX) * 180 / Math.PI + 90);
    const stops = fill.stops.map(s => `${cssColor(s.color, s.opacity)} ${round(s.offset * 100)}%`).join(', ');
    return `linear-gradient(${angle}deg, ${stops})`;
  }
  if (fill.type === 'radial-gradient') {
    const stops = fill.stops.map(s => `${cssColor(s.color, s.opacity)} ${round(s.offset * 100)}%`).join(', ');
    return `radial-gradient(circle, ${stops})`;
  }
  // Image paints need the data-url, which fillToCss doesn't receive — callers with the
  // image map handle them (see shapeToCss); here they read as no paint.
  return 'transparent';
}

function shadowToCss(s: Shadow): string {
  const inset = s.type === 'inner' ? 'inset ' : '';
  return `${inset}${s.offsetX}px ${s.offsetY}px ${s.blur}px ${s.spread}px ${cssColor(s.color, s.opacity)}`;
}

// ── CSS generation ────────────────────────────────────────────────────────────

export function shapeToCssProps(shape: Shape, page?: Page): Record<string, string> {
  const props: Record<string, string> = {};

  // Position relative to the PARENT container (what you'd paste into real CSS),
  // not the page-absolute canvas coordinate — matching Figma's inspect output.
  const parent = page && shape.parentId ? page.objects[shape.parentId] : null;
  props['position'] = 'absolute';
  props['left'] = `${round(shape.x - (parent?.x ?? 0))}px`;
  props['top'] = `${round(shape.y - (parent?.y ?? 0))}px`;
  props['width'] = `${round(shape.width)}px`;
  props['height'] = `${round(shape.height)}px`;

  if (shape.rotation) props['transform'] = `rotate(${shape.rotation}deg)`;
  if (shape.opacity < 1) props['opacity'] = String(round(shape.opacity, 2));
  if (shape.blendMode !== 'normal') props['mix-blend-mode'] = shape.blendMode;

  // Background
  if (shape.fills.length > 0) {
    const solid = shape.fills.find(f => f.type === 'solid');
    // Image paints carry no colour — they're emitted as background-image by the HTML
    // exporter, which has the data-urls. Only gradients belong in `background` here.
    const grad = shape.fills.find(f => f.type === 'linear-gradient' || f.type === 'radial-gradient');
    if (grad) props['background'] = fillToCss(grad);
    else if (solid) props['background'] = fillToCss(solid);
  }

  // Border (single stroke → border)
  if (shape.strokes.length > 0) {
    const st = shape.strokes[0];
    props['border'] = `${st.width}px ${st.style} ${cssColor(st.color, st.opacity)}`;
  }

  if (shape.type === 'circle') props['border-radius'] = '50%';

  // Shadows. text-shadow has no inset concept, so inner shadows are dropped there (emitting
  // them produced invalid CSS); box-shadow keeps them (shadowToCss adds `inset`).
  const drops = shape.shadows.filter(s => !s.hidden);
  if (drops.length > 0) {
    if (shape.type === 'text') {
      const outer = drops.filter(s => s.type !== 'inner');
      if (outer.length > 0) props['text-shadow'] = outer.map(shadowToCss).join(', ');
    } else {
      props['box-shadow'] = drops.map(shadowToCss).join(', ');
    }
  }

  // Blur
  if (shape.blur && !shape.blur.hidden) {
    if (shape.blur.type === 'layer-blur') props['filter'] = `blur(${shape.blur.value}px)`;
    else props['backdrop-filter'] = `blur(${shape.blur.value}px)`;
  }

  // Layout — emitted from the Figma-style Auto Layout settings (the app's single
  // layout model). horizontal/vertical/wrap map to flexbox, grid to CSS grid.
  if (shape.type === 'frame' && shape.autoLayout) {
    const al = shape.autoLayout;
    if (al.direction === 'grid') {
      props['display'] = 'grid';
      props['grid-template-columns'] = `repeat(${Math.max(1, Math.floor(al.columns ?? 2))}, 1fr)`;
      props['gap'] = `${al.spacing ?? 0}px`;
    } else {
      props['display'] = 'flex';
      const base = al.direction === 'vertical' ? 'column' : 'row';
      props['flex-direction'] = al.reversed ? `${base}-reverse` : base;
      if (al.direction === 'wrap') props['flex-wrap'] = 'wrap';
      props['justify-content'] = mapJustify(al.justifyContent);
      props['align-items'] = mapAlign(al.alignItems);
      props['gap'] = `${al.spacing ?? 0}px`;
    }
    props['padding'] = `${al.padding.top}px ${al.padding.right}px ${al.padding.bottom}px ${al.padding.left}px`;
    // W/H already include padding (Figma bakes them in), so the box must size border-box or
    // the emitted padding inflates the element beyond its declared width/height.
    props['box-sizing'] = 'border-box';
    // flex/grid children are positioned by the browser, not absolutely
    delete props['position'];
    props['position'] = 'relative';
  }

  // Typography
  if (shape.type === 'text' && shape.textStyle) {
    const ts = shape.textStyle;
    props['font-family'] = ts.fontFamily;
    props['font-size'] = `${ts.fontSize}px`;
    props['font-weight'] = String(ts.fontWeight);
    props['line-height'] = String(ts.lineHeight);
    if (ts.letterSpacing) props['letter-spacing'] = `${ts.letterSpacing}px`;
    props['color'] = cssColor(ts.color, ts.opacity);
    if (ts.textDecoration !== 'none') props['text-decoration'] = ts.textDecoration;
    if (ts.textTransform !== 'none') props['text-transform'] = ts.textTransform;
    const align = shape.paragraphs?.[0]?.align;
    if (align && align !== 'left') props['text-align'] = align;
  }

  return props;
}

function mapJustify(j: string): string {
  const m: Record<string, string> = { start: 'flex-start', end: 'flex-end', center: 'center', 'space-between': 'space-between', 'space-around': 'space-around', 'space-evenly': 'space-evenly' };
  return m[j] ?? j;
}
function mapAlign(a: string): string {
  const m: Record<string, string> = { start: 'flex-start', end: 'flex-end', center: 'center', stretch: 'stretch' };
  return m[a] ?? a;
}

export function shapeToCss(shape: Shape, selector?: string, page?: Page): string {
  const props = shapeToCssProps(shape, page);
  const body = Object.entries(props).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  const sel = selector ?? `.${cssClassName(shape)}`;
  return `${sel} {\n${body}\n}`;
}

export function cssClassName(shape: Shape): string {
  return shape.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || shape.type;
}

// ── SVG generation ────────────────────────────────────────────────────────────

export function shapeToSvg(shape: Shape, page: Page): string {
  return renderSvgShape(shape, page);
}

// `images` (imageId → base64 data-url) lets image / imported-SVG nodes embed inline so the
// exported SVG is fully self-contained — no file paths, no external URLs.
function renderSvgShape(shape: Shape, page: Page, images?: Record<string, string>): string {
  const transform = shape.rotation
    ? ` transform="rotate(${shape.rotation} ${round(shape.x + shape.width / 2)} ${round(shape.y + shape.height / 2)})"`
    : '';
  const opacity = shape.opacity < 1 ? ` opacity="${round(shape.opacity, 2)}"` : '';

  // An image paint becomes a <pattern> holding the embedded picture; anything else falls
  // back to the topmost solid fill (SVG has no stacked-paint equivalent).
  const imageFill = shape.fills.find(f => f.type === 'image');
  const imageHref = imageFill && imageFill.type === 'image' ? images?.[imageFill.imageId] : undefined;
  let defs = '';
  let fillAttr: string;
  let fillOp = '';
  if (imageFill && imageFill.type === 'image' && imageHref) {
    const patternId = `paint-${shape.id}`;
    // 'fit' letterboxes, 'stretch' distorts, 'fill'/'tile' cover — SVG expresses the first
    // three directly; 'tile' is approximated as cover, since a tiled pattern would need
    // the image's natural size, which isn't stored.
    const aspect = imageFill.scaleMode === 'fit' ? 'xMidYMid meet'
      : imageFill.scaleMode === 'stretch' ? 'none'
      : 'xMidYMid slice';
    defs = `<defs><pattern id="${patternId}" patternUnits="userSpaceOnUse" x="${round(shape.x)}" y="${round(shape.y)}" width="${round(shape.width)}" height="${round(shape.height)}">`
      + `<image href="${imageHref}" width="${round(shape.width)}" height="${round(shape.height)}" preserveAspectRatio="${aspect}" />`
      + `</pattern></defs>`;
    fillAttr = ` fill="url(#${patternId})"`;
    if (imageFill.opacity < 1) fillOp = ` fill-opacity="${round(imageFill.opacity, 2)}"`;
  } else {
    const fill = shape.fills.find(f => f.type === 'solid');
    fillAttr = fill && fill.type === 'solid' ? ` fill="${fill.color}"` : ' fill="none"';
    fillOp = fill && fill.opacity < 1 ? ` fill-opacity="${round(fill.opacity, 2)}"` : '';
  }

  const stroke = shape.strokes[0];
  const strokeAttr = stroke ? ` stroke="${stroke.color}" stroke-width="${stroke.width}"` : '';

  const common = `${fillAttr}${fillOp}${strokeAttr}${opacity}${transform}`;

  switch (shape.type) {
    case 'rect':
    case 'frame': {
      const r = shape.cornerRadii;
      const radius = r && (r.tl || r.tr || r.br || r.bl)
        ? ` rx="${round(Math.max(r.tl, r.tr, r.br, r.bl))}"` : '';
      return `${defs}<rect x="${round(shape.x)}" y="${round(shape.y)}" width="${round(shape.width)}" height="${round(shape.height)}"${radius}${common} />`;
    }
    case 'circle':
      return `${defs}<ellipse cx="${round(shape.x + shape.width / 2)}" cy="${round(shape.y + shape.height / 2)}" rx="${round(shape.width / 2)}" ry="${round(shape.height / 2)}"${common} />`;
    case 'text': {
      const ts = shape.textStyle;
      const text = (shape.paragraphs ?? []).flatMap(p => p.spans.map(s => s.text)).join('');
      const fontAttr = ts ? ` font-family="${ts.fontFamily}" font-size="${ts.fontSize}" font-weight="${ts.fontWeight}" fill="${ts.color}"` : '';
      return `<text x="${round(shape.x)}" y="${round(shape.y + (ts?.fontSize ?? 16))}"${fontAttr}${opacity}${transform}>${escapeXml(text)}</text>`;
    }
    case 'path':
    case 'bool': {
      // Path content is SHAPE-LOCAL (that's how the canvas draws it), while this SVG is in
      // page coordinates — so the node's origin has to be applied as a transform, after any
      // rotation (which is already expressed about the absolute centre).
      const place = `${shape.rotation ? ` transform="rotate(${round(shape.rotation)} ${round(shape.x + shape.width / 2)} ${round(shape.y + shape.height / 2)}) translate(${round(shape.x)} ${round(shape.y)})"` : ` transform="translate(${round(shape.x)} ${round(shape.y)})"`}`;
      const localCommon = `${fillAttr}${fillOp}${strokeAttr}${opacity}${place}`;
      const d = (shape.content ?? []).map(seg => {
        return seg.verb + seg.coords.map(c => round(c, 1)).join(' ');
      }).join(' ');
      if (d) return `${defs}<path d="${d}"${localCommon} />`;
      // A non-destructive boolean group holds no geometry of its own — its operands are
      // real children. Emit them so the node doesn't vanish from the export; SVG has no
      // direct equivalent of the canvas composite, so the result reads as a union.
      if (shape.type === 'bool') {
        const kids = shape.childIds
          .map(id => page.objects[id])
          .filter((c): c is Shape => !!c && !c.hidden)
          .map(c => renderSvgShape(c, page, images))
          .join('');
        return kids ? `<g${opacity}>${kids}</g>` : '';
      }
      return '';
    }
    // Imported SVG / vector group: embed the stored inner markup, scaled from its original
    // viewBox to the node's current box and translated to the node's position.
    case 'svg':
    case 'vector': {
      const inner = shape.svgInnerHTML;
      if (inner) {
        const ow = shape.svgOriginalWidth || shape.width || 1;
        const oh = shape.svgOriginalHeight || shape.height || 1;
        const sx = round(shape.width / ow, 4), sy = round(shape.height / oh, 4);
        return `<g transform="translate(${round(shape.x)} ${round(shape.y)}) scale(${sx} ${sy})"${opacity}>${inner}</g>`;
      }
      if (shape.content && shape.content.length) {
        const d = shape.content.map(seg => seg.verb + seg.coords.map(c => round(c, 1)).join(' ')).join(' ');
        return `<path d="${d}"${common} />`;
      }
      return '';
    }
    // Raster image: embed as a base64 data-url (self-contained). Never a file path.
    case 'image': {
      const href = shape.imageId ? images?.[shape.imageId] : undefined;
      if (!href) return '';
      return `<image x="${round(shape.x)}" y="${round(shape.y)}" width="${round(shape.width)}" height="${round(shape.height)}" href="${href}" preserveAspectRatio="none"${opacity}${transform} />`;
    }
    default:
      return '';
  }
}

// Export ONE node to a standalone, self-contained SVG. For an imported SVG node with full
// stored markup, the markup is used directly (most faithful); otherwise the node's subtree
// is rendered. viewBox is the node's own bounds, so the file matches the node's W/H exactly.
export function exportShapeSvg(shape: Shape, page: Page, images?: Record<string, string>): string {
  const w = Math.round(shape.width), h = Math.round(shape.height);
  // CASE 1 — imported SVG: reuse the stored markup directly (most faithful). Prefer the
  // inner markup (clean viewBox control); fall back to the full <svg> content, re-sized.
  if (shape.type === 'svg' && (shape.svgInnerHTML || shape.svgContent)) {
    const ow = shape.svgOriginalWidth || shape.width || w;
    const oh = shape.svgOriginalHeight || shape.height || h;
    if (shape.svgInnerHTML) {
      return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${round(ow)} ${round(oh)}">\n  ${shape.svgInnerHTML}\n</svg>`;
    }
    // Full content fallback: force the outer <svg> to the node's W/H, add a viewBox if missing.
    let s = shape.svgContent!
      .replace(/(<svg\b[^>]*?)\swidth="[^"]*"/i, '$1')
      .replace(/(<svg\b[^>]*?)\sheight="[^"]*"/i, '$1')
      .replace(/<svg\b/i, `<svg width="${w}" height="${h}"`);
    if (!/viewBox=/i.test(s)) s = s.replace(/<svg\b/i, `<svg viewBox="0 0 ${round(ow)} ${round(oh)}"`);
    return s;
  }
  // CASE 2 — frame/group/other: render the node's subtree (images embedded as base64).
  return frameToSvg(shape, page, images);
}

// A boolean group's computed outline stands in for its operands, so exporters must not
// also emit the children — they'd draw on top and undo the subtraction.
function exportChildIds(shape: Shape): string[] {
  if (shape.type === 'bool' && shape.content && shape.content.length > 0) return [];
  return shape.childIds;
}

/**
 * Render a node and its subtree to SVG. Unlike the flat collectors this nests, which is
 * what lets mask layers become a real `<mask>` rather than being drawn unmasked.
 */
function renderNodeSvg(id: string, page: Page, images?: Record<string, string>): string {
  const shape = page.objects[id];
  if (!shape || shape.hidden) return '';
  const self = renderSvgShape(shape, page, images);
  const kids = renderChildListSvg(exportChildIds(shape), page, images);
  return kids ? `${self}${kids}` : self;
}

/**
 * Render a sibling list, honouring mask layers: a child with `isMask` clips every later
 * sibling. Emitted as a luminance `<mask>` painted white, which matches an opaque mask
 * shape; a semi-transparent mask exports as fully opaque.
 */
function renderChildListSvg(childIds: string[], page: Page, images?: Record<string, string>): string {
  let out = '';
  for (let i = 0; i < childIds.length; i++) {
    const shape = page.objects[childIds[i]];
    if (!shape || shape.hidden) continue;
    if (!shape.isMask) { out += renderNodeSvg(childIds[i], page, images); continue; }

    const masked = childIds.slice(i + 1);
    if (masked.length === 0) return out;
    const body = renderChildListSvg(masked, page, images);
    if (!body) return out;
    const white = { ...shape, fills: [{ type: 'solid' as const, color: '#ffffff', opacity: 1 }], strokes: [], isMask: false };
    const maskId = `mask-${shape.id}`;
    out += `<defs><mask id="${maskId}" maskUnits="userSpaceOnUse">`
      + `<rect x="${round(shape.x)}" y="${round(shape.y)}" width="${round(shape.width)}" height="${round(shape.height)}" fill="#000000" />`
      + `${renderSvgShape(white, page, images)}${renderChildListSvg(exportChildIds(white), page, images)}`
      + `</mask></defs><g mask="url(#${maskId})">${body}</g>`;
    return out;
  }
  return out;
}

// Render a single frame + its descendants to a self-contained SVG, with the
// viewBox set to the frame's bounds (coordinates stay absolute/page-space).
// images: imageId → base64 data-url, embedded inline for portability.
export function frameToSvg(frame: Shape, page: Page, images?: Record<string, string>): string {
  // Frame's own fill draws as the screen background; then its subtree, nested so masks
  // and boolean groups export the way they render.
  const body = renderSvgShape(frame, page, images)
    + renderChildListSvg(exportChildIds(frame), page, images);

  // Emit a FRAME-LOCAL, 0-based SVG: viewBox starts at 0,0 and a single translate group
  // shifts the frame's absolute child coords into frame space. This renders identically in
  // any viewer (browser/Figma/Illustrator) AND re-imports faithfully — the importer keys off
  // the viewBox size and element transforms, so a negative/offset viewBox (the old absolute
  // form) made re-imported content land outside the box and appear empty.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${round(frame.width)}" height="${round(frame.height)}" viewBox="0 0 ${round(frame.width)} ${round(frame.height)}">\n  <g transform="translate(${round(-frame.x)} ${round(-frame.y)})">\n    ${body}\n  </g>\n</svg>`;
}

// ── DOM-hybrid frame renderer (for the HTML prototype) ─────────────────────────
// Renders a frame and its descendants as absolutely-positioned HTML so a developer
// can open DevTools and inspect the REAL CSS (gradients, shadows, typography…).
// Boxes/text/images become <div>; vector/path/bool/svg nodes embed inline <svg>.
// Coordinates are made frame-relative so the whole thing drops into a sized container.

function propsToInline(props: Record<string, string>): string {
  return Object.entries(props).map(([k, v]) => `${k}:${v}`).join(';');
}

function cornerRadiusCss(shape: Shape): string | null {
  const c = shape.cornerRadii;
  if (!c) return null;
  if (c.tl === c.tr && c.tr === c.br && c.br === c.bl) return c.tl ? `${round(c.tl)}px` : null;
  return `${round(c.tl)}px ${round(c.tr)}px ${round(c.br)}px ${round(c.bl)}px`;
}

function textToHtml(shape: Shape): string {
  const paras = shape.paragraphs ?? [];
  if (paras.length === 0) return '';
  return paras.map(p => {
    const inner = p.spans.map(sp => {
      const st = sp.style;
      const text = escapeXml(sp.text).replace(/\n/g, '<br>');
      if (!st) return text;
      const parts: string[] = [];
      if (st.fontFamily) parts.push(`font-family:${st.fontFamily}`);
      if (st.fontSize) parts.push(`font-size:${round(st.fontSize)}px`);
      if (st.fontWeight) parts.push(`font-weight:${st.fontWeight}`);
      if (st.color) parts.push(`color:${cssColor(st.color, st.opacity ?? 1)}`);
      if (st.letterSpacing) parts.push(`letter-spacing:${st.letterSpacing}px`);
      if (st.textDecoration && st.textDecoration !== 'none') parts.push(`text-decoration:${st.textDecoration}`);
      if (st.textTransform && st.textTransform !== 'none') parts.push(`text-transform:${st.textTransform}`);
      return parts.length ? `<span style="${parts.join(';')}">${text}</span>` : text;
    }).join('');
    const align = p.align && p.align !== 'left' ? `text-align:${p.align}` : '';
    return `<div${align ? ` style="${align}"` : ''}>${inner || '<br>'}</div>`;
  }).join('');
}

function shapeToHtmlEl(s: Shape, page: Page, images: Record<string, string> | undefined, ox: number, oy: number): string {
  const left = round(s.x - ox), top = round(s.y - oy);
  const w = round(s.width), h = round(s.height);
  // Identity for the prototype runtime: `data-layer` is what Smart Animate matches
  // between two screens, exactly as Figma matches on layer name.
  const ident = ` data-id="${escapeXml(s.id)}" data-layer="${escapeXml(s.name)}"`;

  // Vector / path / bool → inline SVG positioned over the box (viewBox = page coords).
  if (s.type === 'path' || s.type === 'bool' || s.type === 'vector') {
    const style = `position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;overflow:visible`;
    return `<svg${ident} style="${style}" viewBox="${round(s.x)} ${round(s.y)} ${w} ${h}">${renderSvgShape(s, page)}</svg>`;
  }
  // Imported SVG markup → embed, scaled into the box.
  if (s.type === 'svg' && (s.svgInnerHTML || s.svgContent)) {
    const style = `position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px`;
    if (s.svgInnerHTML) {
      const vb = s.svgOriginalWidth && s.svgOriginalHeight ? `0 0 ${s.svgOriginalWidth} ${s.svgOriginalHeight}` : `0 0 ${w} ${h}`;
      return `<svg${ident} style="${style}" viewBox="${vb}" preserveAspectRatio="none">${s.svgInnerHTML}</svg>`;
    }
    // svgContent is RAW imported file text (unlike svgInnerHTML, which was sanitized on
    // import) — sanitize before embedding in the exported/presented HTML or a crafted SVG
    // could run script when the prototype is opened.
    return `<div${ident} style="${style};overflow:hidden">${sanitizeSvgMarkup(s.svgContent!)}</div>`;
  }

  const props = shapeToCssProps(s);
  props['left'] = `${left}px`;
  props['top'] = `${top}px`;
  // The prototype flattens the subtree: every descendant is emitted as an
  // absolutely-positioned SIBLING with the engine's final x/y already baked in
  // (flat coordinate model). Re-emitting the auto-layout CSS here would apply
  // layout twice — position:relative puts the div back into block flow (each
  // auto-layout frame pushes the next one down by its own height) and padding
  // inflates the painted box — so strip every flow property and pin absolute.
  delete props['display'];
  delete props['flex-direction'];
  delete props['flex-wrap'];
  delete props['justify-content'];
  delete props['align-items'];
  delete props['gap'];
  delete props['grid-template-columns'];
  delete props['padding'];
  props['position'] = 'absolute';
  // Borders must not grow the box beyond the shape's stored width/height.
  if (props['border']) props['box-sizing'] = 'border-box';
  // The canvas never paints fills behind text glyphs — don't paint them here either.
  if (s.type === 'text') delete props['background'];
  const cr = cornerRadiusCss(s);
  if (cr && s.type !== 'circle') props['border-radius'] = cr;
  if (s.clipContent) props['overflow'] = 'hidden';

  // An image PAINT on any shape (Figma's image fill) — same treatment as an image node.
  const imgPaint = s.fills.find(f => f.type === 'image');
  if (imgPaint && imgPaint.type === 'image' && images?.[imgPaint.imageId]) {
    props['background-image'] = `url(${images[imgPaint.imageId]})`;
    props['background-size'] = imgPaint.scaleMode === 'fit' ? 'contain'
      : imgPaint.scaleMode === 'stretch' ? '100% 100%'
      : imgPaint.scaleMode === 'tile' ? 'auto'
      : 'cover';
    props['background-position'] = 'center';
    props['background-repeat'] = imgPaint.scaleMode === 'tile' ? 'repeat' : 'no-repeat';
    return `<div${ident} style="${propsToInline(props)}"></div>`;
  }
  if (s.type === 'image' && s.imageId && images?.[s.imageId]) {
    props['background-image'] = `url(${images[s.imageId]})`;
    props['background-size'] = '100% 100%';
    props['background-repeat'] = 'no-repeat';
    return `<div${ident} style="${propsToInline(props)}"></div>`;
  }
  if (s.type === 'text') {
    return `<div${ident} style="${propsToInline(props)}">${textToHtml(s)}</div>`;
  }
  // rect / frame / group / circle / fallback
  return `<div${ident} style="${propsToInline(props)}"></div>`;
}

export function frameToHtml(frame: Shape, page: Page, images?: Record<string, string>): string {
  const ox = frame.x, oy = frame.y;
  const flat: Shape[] = [];
  const seen = new Set<string>();
  const collect = (id: string) => {
    if (seen.has(id)) return;
    const s = page.objects[id];
    if (!s || s.hidden) return;
    seen.add(id);
    flat.push(s);
    exportChildIds(s).forEach(collect);
  };
  flat.push(frame); seen.add(frame.id);   // frame fill = screen backdrop
  exportChildIds(frame).forEach(collect);

  // Adopt loose top-level shapes that visually sit inside this frame. A shape can look
  // like it's "in" a frame while actually being a page-level sibling (drawn before the
  // frame existed, dropped from another frame, etc.). Without this, Present renders those
  // frames blank even though the editor shows content — the "click → blank white screen"
  // report. Other top-level frames are excluded (they're their own screens); the frame's
  // overflow:hidden clips anything that pokes past the edge.
  const cx0 = frame.x, cy0 = frame.y, cx1 = frame.x + frame.width, cy1 = frame.y + frame.height;
  for (const id of page.childIds) {
    const s = page.objects[id];
    if (!s || s.hidden || s.type === 'frame' || seen.has(id)) continue;
    const scx = s.x + s.width / 2, scy = s.y + s.height / 2;
    if (scx >= cx0 && scx <= cx1 && scy >= cy0 && scy <= cy1) collect(id);
  }

  const body = flat.map(s => shapeToHtmlEl(s, page, images, ox, oy)).join('\n        ');
  return `<div class="frame-root" style="position:relative;width:${round(frame.width)}px;height:${round(frame.height)}px;overflow:hidden">\n        ${body}\n      </div>`;
}

// Full-page SVG export
export function pageToSvg(page: Page, images?: Record<string, string>): string {
  // Compute bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const flat: Shape[] = [];
  const collect = (id: string) => {
    const s = page.objects[id];
    if (!s || s.hidden) return;
    flat.push(s);
    minX = Math.min(minX, s.selrect.x); minY = Math.min(minY, s.selrect.y);
    maxX = Math.max(maxX, s.selrect.x + s.selrect.width);
    maxY = Math.max(maxY, s.selrect.y + s.selrect.height);
    exportChildIds(s).forEach(collect);
  };
  page.childIds.forEach(collect);
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }

  const w = maxX - minX, h = maxY - minY;
  // `flat` measures the bounds; the markup itself is rendered nested so masks and
  // boolean groups export the way they render.
  const body = renderChildListSvg(page.childIds, page, images);
  // 0-based viewBox + translate group (see frameToSvg) so the file round-trips on re-import.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${round(w)}" height="${round(h)}" viewBox="0 0 ${round(w)} ${round(h)}">\n  <g transform="translate(${round(-minX)} ${round(-minY)})">\n    ${body}\n  </g>\n</svg>`;
}

// ── HTML generation ───────────────────────────────────────────────────────────

export function shapeToHtml(shape: Shape, page: Page): string {
  const cls = cssClassName(shape);
  if (shape.type === 'text') {
    const text = (shape.paragraphs ?? []).flatMap(p => p.spans.map(s => s.text)).join('');
    return `<div class="${cls}">${escapeXml(text)}</div>`;
  }
  const children = shape.childIds.map(id => {
    const c = page.objects[id];
    return c ? shapeToHtml(c, page) : '';
  }).join('\n  ');
  return children
    ? `<div class="${cls}">\n  ${children}\n</div>`
    : `<div class="${cls}"></div>`;
}

// ── React + Tailwind generation (the "better than Penpot" extra) ────────────────

export function shapeToReact(shape: Shape, page: Page): string {
  const compName = pascalCase(shape.name);
  const styleObj = cssToReactStyle(shapeToCssProps(shape, page));
  const text = shape.type === 'text'
    ? (shape.paragraphs ?? []).flatMap(p => p.spans.map(s => s.text)).join('')
    : '';
  return `function ${compName}() {
  return (
    <div style={${styleObj}}>${text ? `\n      ${escapeXml(text)}\n    ` : ''}</div>
  );
}`;
}

export function shapeToTailwind(shape: Shape): string {
  const classes: string[] = ['absolute'];
  classes.push(`left-[${round(shape.x)}px]`, `top-[${round(shape.y)}px]`);
  classes.push(`w-[${round(shape.width)}px]`, `h-[${round(shape.height)}px]`);

  const fill = shape.fills.find(f => f.type === 'solid');
  if (fill && fill.type === 'solid') classes.push(`bg-[${fill.color}]`);
  if (shape.type === 'circle') classes.push('rounded-full');
  if (shape.opacity < 1) classes.push(`opacity-[${round(shape.opacity, 2)}]`);
  if (shape.rotation) classes.push(`rotate-[${shape.rotation}deg]`);

  if (shape.type === 'frame' && shape.autoLayout && shape.autoLayout.direction !== 'grid') {
    const al = shape.autoLayout;
    classes.push('flex');
    if (al.direction === 'vertical') classes.push(al.reversed ? 'flex-col-reverse' : 'flex-col');
    else if (al.reversed) classes.push('flex-row-reverse');
    if (al.direction === 'wrap') classes.push('flex-wrap');
    classes.push(`gap-[${al.spacing ?? 0}px]`);
    const jmap: Record<string, string> = { start: 'justify-start', center: 'justify-center', end: 'justify-end', 'space-between': 'justify-between', 'space-around': 'justify-around', 'space-evenly': 'justify-evenly' };
    classes.push(jmap[al.justifyContent] ?? '');
    const amap: Record<string, string> = { start: 'items-start', center: 'items-center', end: 'items-end' };
    classes.push(amap[al.alignItems] ?? '');
  }

  const text = shape.type === 'text'
    ? (shape.paragraphs ?? []).flatMap(p => p.spans.map(s => s.text)).join('')
    : '';
  return `<div className="${classes.filter(Boolean).join(' ')}">${escapeXml(text)}</div>`;
}

function cssToReactStyle(props: Record<string, string>): string {
  const entries = Object.entries(props).map(([k, v]) => {
    const camelKey = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const val = /^\d+$/.test(v) ? v : `'${v}'`;
    return `      ${camelKey}: ${val}`;
  });
  return `{\n${entries.join(',\n')}\n    }`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pascalCase(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/^[a-z]/, c => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '') || 'Component';
}

export type CodeFormat = 'css' | 'svg' | 'html' | 'react' | 'tailwind';

export function generateCode(shape: Shape, page: Page, format: CodeFormat): string {
  switch (format) {
    case 'css': return shapeToCss(shape, undefined, page);
    case 'svg': return shapeToSvg(shape, page);
    case 'html': return shapeToHtml(shape, page);
    case 'react': return shapeToReact(shape, page);
    case 'tailwind': return shapeToTailwind(shape);
  }
}
