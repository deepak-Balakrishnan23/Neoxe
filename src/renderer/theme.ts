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

  // Radii
  rSm: 5, rMd: 7, rLg: 10, rXl: 14,

  // Elevation
  shadowPanel: 'var(--shadow-panel)',
  shadowPopover: 'var(--shadow-popover)',
  shadowDialog: 'var(--shadow-dialog)',
  shadowFloat: 'var(--shadow-float)',

  font: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
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
