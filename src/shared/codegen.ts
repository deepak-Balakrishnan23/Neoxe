import { Shape, Page, Fill, Stroke, Shadow, TextStyle, DesignFile } from './types';

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
  return 'transparent';
}

function shadowToCss(s: Shadow): string {
  const inset = s.type === 'inner' ? 'inset ' : '';
  return `${inset}${s.offsetX}px ${s.offsetY}px ${s.blur}px ${s.spread}px ${cssColor(s.color, s.opacity)}`;
}

// ── CSS generation ────────────────────────────────────────────────────────────

export function shapeToCssProps(shape: Shape): Record<string, string> {
  const props: Record<string, string> = {};

  props['position'] = 'absolute';
  props['left'] = `${round(shape.x)}px`;
  props['top'] = `${round(shape.y)}px`;
  props['width'] = `${round(shape.width)}px`;
  props['height'] = `${round(shape.height)}px`;

  if (shape.rotation) props['transform'] = `rotate(${shape.rotation}deg)`;
  if (shape.opacity < 1) props['opacity'] = String(round(shape.opacity, 2));
  if (shape.blendMode !== 'normal') props['mix-blend-mode'] = shape.blendMode;

  // Background
  if (shape.fills.length > 0) {
    const solid = shape.fills.find(f => f.type === 'solid');
    const grad = shape.fills.find(f => f.type !== 'solid');
    if (grad) props['background'] = fillToCss(grad);
    else if (solid) props['background'] = fillToCss(solid);
  }

  // Border (single stroke → border)
  if (shape.strokes.length > 0) {
    const st = shape.strokes[0];
    props['border'] = `${st.width}px ${st.style} ${cssColor(st.color, st.opacity)}`;
  }

  if (shape.type === 'circle') props['border-radius'] = '50%';

  // Shadows
  const drops = shape.shadows.filter(s => !s.hidden);
  if (drops.length > 0) {
    const box = drops.filter(s => s.type !== 'inner' || true).map(shadowToCss).join(', ');
    if (shape.type === 'text') props['text-shadow'] = drops.map(shadowToCss).join(', ');
    else props['box-shadow'] = box;
  }

  // Blur
  if (shape.blur && !shape.blur.hidden) {
    if (shape.blur.type === 'layer-blur') props['filter'] = `blur(${shape.blur.value}px)`;
    else props['backdrop-filter'] = `blur(${shape.blur.value}px)`;
  }

  // Layout
  if (shape.type === 'frame' && shape.layout) {
    const L = shape.layout;
    if (L.type === 'flex') {
      props['display'] = 'flex';
      props['flex-direction'] = L.direction;
      props['flex-wrap'] = L.wrap;
      props['justify-content'] = mapJustify(L.justify);
      props['align-items'] = mapAlign(L.align);
      props['gap'] = `${L.gap}px`;
      props['padding'] = `${L.padding.top}px ${L.padding.right}px ${L.padding.bottom}px ${L.padding.left}px`;
      // override absolute positioning for flex children handled by browser
      delete props['position'];
      props['position'] = 'relative';
    } else if (L.type === 'grid') {
      props['display'] = 'grid';
      props['grid-template-columns'] = L.columns.map(t => t.kind === 'fr' ? `${t.value}fr` : t.kind === 'fixed' ? `${t.value}px` : 'auto').join(' ');
      props['grid-template-rows'] = L.rows.map(t => t.kind === 'fr' ? `${t.value}fr` : t.kind === 'fixed' ? `${t.value}px` : 'auto').join(' ');
      props['column-gap'] = `${L.columnGap}px`;
      props['row-gap'] = `${L.rowGap}px`;
      props['padding'] = `${L.padding.top}px ${L.padding.right}px ${L.padding.bottom}px ${L.padding.left}px`;
      props['position'] = 'relative';
    }
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

export function shapeToCss(shape: Shape, selector?: string): string {
  const props = shapeToCssProps(shape);
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

  const fill = shape.fills.find(f => f.type === 'solid');
  const fillAttr = fill && fill.type === 'solid' ? ` fill="${fill.color}"` : ' fill="none"';
  const fillOp = fill && fill.opacity < 1 ? ` fill-opacity="${round(fill.opacity, 2)}"` : '';

  const stroke = shape.strokes[0];
  const strokeAttr = stroke ? ` stroke="${stroke.color}" stroke-width="${stroke.width}"` : '';

  const common = `${fillAttr}${fillOp}${strokeAttr}${opacity}${transform}`;

  switch (shape.type) {
    case 'rect':
    case 'frame':
      return `<rect x="${round(shape.x)}" y="${round(shape.y)}" width="${round(shape.width)}" height="${round(shape.height)}"${common} />`;
    case 'circle':
      return `<ellipse cx="${round(shape.x + shape.width / 2)}" cy="${round(shape.y + shape.height / 2)}" rx="${round(shape.width / 2)}" ry="${round(shape.height / 2)}"${common} />`;
    case 'text': {
      const ts = shape.textStyle;
      const text = (shape.paragraphs ?? []).flatMap(p => p.spans.map(s => s.text)).join('');
      const fontAttr = ts ? ` font-family="${ts.fontFamily}" font-size="${ts.fontSize}" font-weight="${ts.fontWeight}" fill="${ts.color}"` : '';
      return `<text x="${round(shape.x)}" y="${round(shape.y + (ts?.fontSize ?? 16))}"${fontAttr}${opacity}${transform}>${escapeXml(text)}</text>`;
    }
    case 'path':
    case 'bool': {
      const d = (shape.content ?? []).map(seg => {
        return seg.verb + seg.coords.map(c => round(c, 1)).join(' ');
      }).join(' ');
      return `<path d="${d}"${common} />`;
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

// Render a single frame + its descendants to a self-contained SVG, with the
// viewBox set to the frame's bounds (coordinates stay absolute/page-space).
// images: imageId → base64 data-url, embedded inline for portability.
export function frameToSvg(frame: Shape, page: Page, images?: Record<string, string>): string {
  const flat: Shape[] = [];
  const collect = (id: string) => {
    const s = page.objects[id];
    if (!s || s.hidden) return;
    flat.push(s);
    s.childIds.forEach(collect);
  };
  // Frame's own fill draws as the screen background; include it then children
  flat.push(frame);
  frame.childIds.forEach(collect);

  const body = flat.map(s => renderSvgShape(s, page, images)).join('\n    ');

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

  // Vector / path / bool → inline SVG positioned over the box (viewBox = page coords).
  if (s.type === 'path' || s.type === 'bool' || s.type === 'vector') {
    const style = `position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;overflow:visible`;
    return `<svg style="${style}" viewBox="${round(s.x)} ${round(s.y)} ${w} ${h}">${renderSvgShape(s, page)}</svg>`;
  }
  // Imported SVG markup → embed, scaled into the box.
  if (s.type === 'svg' && (s.svgInnerHTML || s.svgContent)) {
    const style = `position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px`;
    if (s.svgInnerHTML) {
      const vb = s.svgOriginalWidth && s.svgOriginalHeight ? `0 0 ${s.svgOriginalWidth} ${s.svgOriginalHeight}` : `0 0 ${w} ${h}`;
      return `<svg style="${style}" viewBox="${vb}" preserveAspectRatio="none">${s.svgInnerHTML}</svg>`;
    }
    return `<div style="${style};overflow:hidden">${s.svgContent}</div>`;
  }

  const props = shapeToCssProps(s);
  props['left'] = `${left}px`;
  props['top'] = `${top}px`;
  const cr = cornerRadiusCss(s);
  if (cr && s.type !== 'circle') props['border-radius'] = cr;
  if (s.clipContent) props['overflow'] = 'hidden';

  if (s.type === 'image' && s.imageId && images?.[s.imageId]) {
    props['background-image'] = `url(${images[s.imageId]})`;
    props['background-size'] = '100% 100%';
    props['background-repeat'] = 'no-repeat';
    return `<div style="${propsToInline(props)}"></div>`;
  }
  if (s.type === 'text') {
    return `<div style="${propsToInline(props)}">${textToHtml(s)}</div>`;
  }
  // rect / frame / group / circle / fallback
  return `<div style="${propsToInline(props)}"></div>`;
}

export function frameToHtml(frame: Shape, page: Page, images?: Record<string, string>): string {
  const ox = frame.x, oy = frame.y;
  const flat: Shape[] = [];
  const collect = (id: string) => {
    const s = page.objects[id];
    if (!s || s.hidden) return;
    flat.push(s);
    s.childIds.forEach(collect);
  };
  flat.push(frame);                 // frame fill = screen backdrop
  frame.childIds.forEach(collect);

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
    s.childIds.forEach(collect);
  };
  page.childIds.forEach(collect);
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }

  const w = maxX - minX, h = maxY - minY;
  const body = flat.map(s => renderSvgShape(s, page, images)).join('\n    ');
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
  const styleObj = cssToReactStyle(shapeToCssProps(shape));
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

  if (shape.type === 'frame' && shape.layout?.type === 'flex') {
    const L = shape.layout;
    classes.push('flex');
    if (L.direction.startsWith('column')) classes.push('flex-col');
    classes.push(`gap-[${L.gap}px]`);
    const jmap: Record<string, string> = { start: 'justify-start', center: 'justify-center', end: 'justify-end', 'space-between': 'justify-between', 'space-around': 'justify-around', 'space-evenly': 'justify-evenly' };
    classes.push(jmap[L.justify] ?? '');
    const amap: Record<string, string> = { start: 'items-start', center: 'items-center', end: 'items-end', stretch: 'items-stretch' };
    classes.push(amap[L.align] ?? '');
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
    case 'css': return shapeToCss(shape);
    case 'svg': return shapeToSvg(shape, page);
    case 'html': return shapeToHtml(shape, page);
    case 'react': return shapeToReact(shape, page);
    case 'tailwind': return shapeToTailwind(shape);
  }
}
