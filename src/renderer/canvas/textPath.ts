import { Shape, TextStyle, TextParagraph } from '../../shared/types';
import { flattenPath, pointAtDistance, textBaseline, Polyline } from '../../shared/pathMetrics';
import { ensureFontLoaded } from './fontLoader';

/**
 * Where every glyph of a text-on-path sits along its baseline.
 *
 * The renderer draws from this and the editor hit-tests against it, so a click always
 * lands on the same character the user can see. Computing it in two places was the bug
 * that made clicking into curved text impossible.
 */
export interface GlyphLayout {
  pl: Polyline;
  chars: string[];
  /** Advance width of each glyph, including tracking. */
  widths: number[];
  /** Distance along the path at which each glyph starts; length is chars.length + 1. */
  starts: number[];
  /** Wraps a distance into the path for closed baselines; identity for open ones. */
  at: (d: number) => number;
  style: TextStyle;
}

const FALLBACK: TextStyle = {
  fontFamily: 'system-ui, sans-serif', fontWeight: 400, fontSize: 16, lineHeight: 1.2,
  letterSpacing: 0, textDecoration: 'none', textTransform: 'none', color: '#000000', opacity: 1,
};

let _ctx: CanvasRenderingContext2D | null = null;
function measureCtx(): CanvasRenderingContext2D | null {
  if (!_ctx && typeof document !== 'undefined') _ctx = document.createElement('canvas').getContext('2d');
  return _ctx;
}

/** The string a text shape renders, with its transform applied. */
export function textPathString(shape: Shape, override?: string): string {
  const paragraphs: TextParagraph[] = shape.paragraphs ?? [];
  const raw = override ?? paragraphs.map(p => p.spans.map(s => s.text).join('')).join(' ');
  const t = (shape.textStyle ?? FALLBACK).textTransform;
  if (t === 'uppercase') return raw.toUpperCase();
  if (t === 'lowercase') return raw.toLowerCase();
  if (t === 'capitalize') return raw.replace(/(^|\s)(\p{L})/gu, (_m, sp, ch) => sp + ch.toUpperCase());
  return raw;
}

/**
 * Lay `text` out along the shape's baseline. Returns null when there is no baseline or no
 * canvas to measure with (e.g. a non-browser environment).
 */
export function textPathGlyphs(shape: Shape, text: string, ctx?: CanvasRenderingContext2D): GlyphLayout | null {
  const baseline = textBaseline(shape);
  if (!baseline) return null;
  const pl = flattenPath(baseline);
  if (pl.length <= 0) return null;

  const span = shape.paragraphs?.[0]?.spans?.[0];
  const style: TextStyle = { ...FALLBACK, ...(shape.textStyle ?? {}), ...(span?.style ?? {}) };

  const m = ctx ?? measureCtx();
  if (!m) return null;
  ensureFontLoaded(style.fontFamily, style.fontWeight);
  const prevFont = m.font;
  m.font = `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
  // Tracking is added per advance below, so the context must not apply it as well.
  const prevSpacing = (m as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing;
  try { (m as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px'; } catch { /* older canvas */ }

  const tracking = style.letterSpacing ?? 0;
  const chars = [...text];
  const widths = chars.map(c => m.measureText(c).width + tracking);
  const total = widths.reduce((a, b) => a + b, 0);

  m.font = prevFont;
  if (prevSpacing !== undefined) {
    try { (m as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = prevSpacing; } catch { /* ignore */ }
  }

  // Alignment runs ALONG the path. A closed outline centres on its START (the top of an
  // ellipse); centring by arc length would land on the far side, upside down.
  const closed = baseline.some(s => s.verb === 'Z');
  const align = shape.paragraphs?.[0]?.align ?? 'left';
  let dist = shape.textPathOffset ?? 0;
  if (align === 'center') dist += closed ? -total / 2 : (pl.length - total) / 2;
  else if (align === 'right') dist += pl.length - total;

  const starts: number[] = [];
  for (let i = 0; i < chars.length; i++) { starts.push(dist); dist += widths[i]; }
  starts.push(dist);

  const at = (d: number) => (closed ? ((d % pl.length) + pl.length) % pl.length : d);
  return { pl, chars, widths, starts, at, style };
}

/**
 * The caret index nearest a point in the shape's local space.
 *
 * Picks the closest glyph, then puts the caret before or after it depending on which side
 * of the glyph's midpoint the click fell - the same rule a straight text box uses, just
 * measured along the curve.
 */
export function caretIndexAt(shape: Shape, text: string, localX: number, localY: number): number {
  const g = textPathGlyphs(shape, text);
  if (!g || g.chars.length === 0) return 0;

  let best = 0, bestDist = Infinity;
  for (let i = 0; i < g.chars.length; i++) {
    const p = pointAtDistance(g.pl, g.at(g.starts[i] + g.widths[i] / 2));
    if (!p) continue;
    const d = Math.hypot(p.x - localX, p.y - localY);
    if (d < bestDist) { bestDist = d; best = i; }
  }

  // Before or after that glyph: project the click onto the glyph's own tangent.
  const mid = pointAtDistance(g.pl, g.at(g.starts[best] + g.widths[best] / 2));
  if (!mid) return best;
  const along = (localX - mid.x) * Math.cos(mid.angle) + (localY - mid.y) * Math.sin(mid.angle);
  return along > 0 ? best + 1 : best;
}
