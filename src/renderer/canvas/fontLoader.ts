// ── Canvas font loading ──────────────────────────────────────────────────────
// Canvas2D silently falls back to a default font when the requested family isn't
// loaded yet — and never re-renders when it arrives. This module makes font use
// explicit: every text draw/measure calls ensureFontLoaded(); the first call per
// family kicks off document.fonts.load() and, when the font becomes available,
// fires FONT_LOADED_EVENT so the canvas can redraw with the real glyphs. Families
// that remain unavailable after a load attempt are tracked so the UI (FontPicker)
// can show a clear "not available" indicator instead of a silent fallback.

export const FONT_LOADED_EVENT = 'neouxe:font-loaded';
export const FONT_FAILED_EVENT = 'neouxe:font-failed';

const requested = new Set<string>(); // families with a load() already in flight/done
const unavailable = new Set<string>(); // families confirmed missing after load()

// First family token of a CSS stack, unquoted: '"Font Awesome 6 Free", sans-serif'
// → 'Font Awesome 6 Free'.
export function primaryFamily(fontFamily: string): string {
  return fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
}

// A canonical shorthand for availability checks. Size is irrelevant to whether a
// family resolves, so it's fixed to keep the cache small; weight matters (e.g.
// Font Awesome ships its solid style at weight 900 only).
function shorthand(family: string, weight: number): string {
  return `${weight} 16px "${family}"`;
}

// Generic keyword families always resolve — checking them is meaningless.
const GENERIC = new Set(['system-ui', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'ui-monospace', '-apple-system']);

/**
 * Make sure `fontFamily` (a CSS stack) is usable for canvas drawing. Non-blocking:
 * returns immediately; if the font needs loading, a FONT_LOADED_EVENT fires on
 * window once it's ready so callers can redraw.
 */
export function ensureFontLoaded(fontFamily: string, fontWeight = 400): void {
  const family = primaryFamily(fontFamily);
  if (!family || GENERIC.has(family)) return;
  const key = `${fontWeight}|${family}`;
  if (requested.has(key)) return;
  requested.add(key);

  const sh = shorthand(family, fontWeight);
  try {
    if (document.fonts.check(sh)) return; // already usable (system font or loaded face)
    document.fonts.load(sh).then(() => {
      if (document.fonts.check(sh)) {
        unavailable.delete(family);
        window.dispatchEvent(new CustomEvent(FONT_LOADED_EVENT, { detail: { family } }));
      } else {
        unavailable.add(family);
        window.dispatchEvent(new CustomEvent(FONT_FAILED_EVENT, { detail: { family } }));
      }
    }).catch(() => {
      unavailable.add(family);
      window.dispatchEvent(new CustomEvent(FONT_FAILED_EVENT, { detail: { family } }));
    });
  } catch {
    // document.fonts unsupported — nothing to do, canvas falls back as before.
  }
}

/** True when the stack's primary family currently resolves for drawing. */
export function isFontAvailable(fontFamily: string, fontWeight = 400): boolean {
  const family = primaryFamily(fontFamily);
  if (!family || GENERIC.has(family)) return true;
  if (unavailable.has(family)) return false;
  try { return document.fonts.check(shorthand(family, fontWeight)); }
  catch { return true; }
}
