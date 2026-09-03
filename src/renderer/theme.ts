// CSS-variable-backed UI tokens. Every color resolves to a CSS custom property,
// so flipping document[data-theme] re-themes the whole app instantly with no
// React re-render. Dark + light values are defined in index.html.

export const T = {
  // Surfaces
  bgApp: 'var(--bg-app)',
  bgPanel: 'var(--bg-panel)',
  bgCanvas: 'var(--bg-canvas)',
  bgElevated: 'var(--bg-elevated)',
  bgElevated2: 'var(--bg-elevated-2)',
  bgInset: 'var(--bg-inset)',

  // Borders
  border: 'var(--border)',
  borderStrong: 'var(--border-strong)',

  // Text
  text: 'var(--text)',
  textSecondary: 'var(--text-secondary)',
  textMuted: 'var(--text-muted)',
  textFaint: 'var(--text-faint)',

  // Accent
  accent: 'var(--accent)',
  accentHover: 'var(--accent-hover)',
  accentSoft: 'var(--accent-soft)',
  accentSoftHover: 'var(--accent-soft-hover)',
  accentText: '#FFFFFF',

  teal: 'var(--teal)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
  comment: 'var(--comment)',

  // Radii - folded onto the 4px grid (was 5/7/10/14)
  rXs: 2, rSm: 4, rMd: 6, rLg: 8, rXl: 12, rPill: 999,

  // Elevation
  shadowPanel: 'var(--shadow-panel)',
  shadowPopover: 'var(--shadow-popover)',
  shadowDialog: 'var(--shadow-dialog)',
  shadowFloat: 'var(--shadow-float)',

  font: 'var(--font-ui)',
  mono: 'var(--font-mono)',
} as const;

// ── Geometry scale ────────────────────────────────────────────────────────────
// One 4px base grid. Every spacing, size and radius below is a multiple of 4
// (with a single 2px hairline for optical icon nudges). This mirrors Material's
// explicit 4dp subdivision grid and the 8pt rhythm Apple's own chrome follows,
// and it is what keeps panel columns landing on the same pixel instead of
// drifting 1-3px apart.

/** Spacing ladder. Use these for gap/padding/margin - nothing in between. */
export const SP = {
  hair: 2,   // optical nudge only (icon centring), never a layout gap
  xs: 4,     // inside a control: icon-to-label
  sm: 8,     // between controls in a row; panel gutter
  md: 12,    // between rows
  lg: 16,    // between groups
  xl: 24,    // between sections
  xxl: 32,   // page-level
} as const;

/** Control heights. Apple's rule: a control's height is fixed per tier, so
 *  there are only four here - not the nine the panels had grown. */
export const Z = {
  hXs: 20,   // micro toggle inside a segmented group
  hSm: 24,   // panel field: input, select, swatch  (3 x 8)
  hMd: 28,   // section button, tab, list row
  hLg: 32,   // top-bar action, panel tab
  hXl: 40,   // canvas tool palette - a deliberately larger pointer target
  /** Icon box sizes, kept square and on-grid. */
  iSm: 12, iMd: 16, iLg: 20,
  /** The label column in a property row. One value, so rows align. */
  labelW: 44,
} as const;

/** Type scale. 11px is the UI default - Apple's smallest standard label and
 *  Material's labelSmall floor - so nothing renders below it. Line heights are
 *  multiples of 4 so text baselines sit on the same grid as the spacing. */
export const F = {
  micro: 10, ui: 11, body: 12, title: 13, lead: 16, display: 26,
  lh: { micro: 12, ui: 16, body: 16, title: 20, lead: 24, display: 32 },
  wNormal: 400, wMed: 500, wSemi: 600, wBold: 700,
} as const;

// ── Canvas-2D colors (real hex; CSS vars can't be used in canvas fillStyle) ────
// These are mutated on theme switch so the rAF render loop picks them up.
export const canvasColors = {
  backdrop: '#0f0f12',
  accent: '#6E72F5',
  accentFill: 'rgba(110,114,245,0.07)',
  accentLine: 'rgba(110,114,245,0.6)',
  handleFill: '#FFFFFF',
};

export type ThemeMode = 'dark' | 'light';

export function setThemeMode(mode: ThemeMode) {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = mode;
  }
  if (mode === 'light') {
    canvasColors.backdrop = '#E6E6EC';
    canvasColors.handleFill = '#FFFFFF';
  } else {
    canvasColors.backdrop = '#0f0f12';
    canvasColors.handleFill = '#FFFFFF';
  }
}
