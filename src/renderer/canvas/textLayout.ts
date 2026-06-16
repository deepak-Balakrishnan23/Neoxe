import { Shape, TextParagraph, TextStyle, TextTransform } from '../../shared/types';

// Shared text measurement + wrapping, used by the renderer (drawing), the editor
// (commit sizing) and resize. Keeping one implementation guarantees the on-canvas
// text, the selection box and the auto-grow all agree.

export function applyTransform(text: string, transform: TextTransform | undefined): string {
  switch (transform) {
    case 'uppercase':  return text.toUpperCase();
    case 'lowercase':  return text.toLowerCase();
    case 'capitalize': return text.replace(/\b\w/g, c => c.toUpperCase());
    default:           return text;
  }
}

let _ctx: CanvasRenderingContext2D | null = null;
function measureCtx(): CanvasRenderingContext2D | null {
  if (!_ctx) _ctx = document.createElement('canvas').getContext('2d');
  return _ctx;
}

function applyFont(ctx: CanvasRenderingContext2D, style: TextStyle) {
  ctx.font = `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
  // letterSpacing is supported on modern canvases; guarded for older ones.
  try { (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${style.letterSpacing}px`; } catch { /* ignore */ }
}

// Greedy word-wrap to a max width (px). Words wider than the box are broken by
// character (CSS overflow-wrap: anywhere) so a long unbroken string still wraps.
export function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (text === '') return [''];
  const fits = (s: string) => ctx.measureText(s).width <= maxWidth;
  const lines: string[] = [];
  for (const rawLine of text.split('\n')) {
    let current = '';
    const place = (word: string) => {
      const candidate = current === '' ? word : current + ' ' + word;
      if (fits(candidate)) { current = candidate; return; }
      if (current !== '') { lines.push(current); current = ''; }
      if (fits(word)) { current = word; return; }
      let chunk = '';
      for (const ch of word) {
        const next = chunk + ch;
        if (fits(next) || chunk === '') chunk = next;
        else { lines.push(chunk); chunk = ch; }
      }
      current = chunk;
    };
    for (const word of rawLine.split(' ')) place(word);
    lines.push(current);
  }
  return lines;
}

// The visual lines a text shape renders: one line per paragraph when auto-width,
// word/char-wrapped to the box width when fixed-width.
export function layoutTextLines(shape: Shape): { align: TextParagraph['align']; text: string }[] {
  const paras = shape.paragraphs ?? [{ align: 'left' as const, spans: [{ text: shape.name }] }];
  const autoWidth = shape.textAutoWidth === true;
  const ctx = measureCtx();
  const style = shape.textStyle;
  if (ctx && style) applyFont(ctx, style);
  const transform = style?.textTransform;
  const out: { align: TextParagraph['align']; text: string }[] = [];
  for (const para of paras) {
    const raw = para.spans.map(s => s.text).join('');
    const text = applyTransform(raw, transform);
    if (autoWidth || !ctx) {
      for (const ln of text.split('\n')) out.push({ align: para.align, text: ln });
    } else {
      for (const ln of wrapLines(ctx, text, shape.width)) out.push({ align: para.align, text: ln });
    }
  }
  return out;
}

// Compute the box size a text shape should have for its content + style + mode.
// - Auto-width: width hugs the longest line; height fits all lines.
// - Fixed-width (auto-height): width is preserved; height fits the wrapped lines.
export function fitTextSize(shape: Shape): { width: number; height: number } {
  const style = shape.textStyle;
  const ctx = measureCtx();
  if (!style || !ctx) return { width: shape.width, height: shape.height };
  applyFont(ctx, style);
  const lineH = style.fontSize * style.lineHeight;
  const paras = shape.paragraphs ?? [{ align: 'left' as const, spans: [{ text: '' }] }];

  const transform = style.textTransform;

  if (shape.textAutoWidth === true) {
    let maxW = 0;
    let lineCount = 0;
    for (const para of paras) {
      const text = applyTransform(para.spans.map(s => s.text).join(''), transform);
      const splits = text.split('\n');
      for (const ln of splits) maxW = Math.max(maxW, ctx.measureText(ln === '' ? ' ' : ln).width);
      lineCount += splits.length;
    }
    return {
      width: Math.max(1, Math.ceil(maxW) + 1),
      height: Math.max(Math.round(lineH), Math.round(lineH * Math.max(1, lineCount))),
    };
  }

  // fixed width → wrap, height fits
  let lineCount = 0;
  for (const para of paras) {
    const text = applyTransform(para.spans.map(s => s.text).join(''), transform);
    lineCount += wrapLines(ctx, text, shape.width).length;
  }
  return {
    width: shape.width,
    height: Math.max(Math.round(lineH), Math.round(lineH * Math.max(1, lineCount))),
  };
}
