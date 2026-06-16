import { DesignToken, ThemeSet, DesignFile } from './types';

// ── Token resolution ──────────────────────────────────────────────────────────
// Resolves a token's final value, following aliases ("{group.name}") and
// applying the active theme's overrides. Detects cycles.

const ALIAS_RE = /^\{([^}]+)\}$/;

export function isAlias(value: string | number): value is string {
  return typeof value === 'string' && ALIAS_RE.test(value);
}

export function aliasTarget(value: string): string | null {
  const m = ALIAS_RE.exec(value);
  return m ? m[1] : null;
}

// Build a fast lookup map of token name → token
function tokenMap(tokens: DesignToken[]): Map<string, DesignToken> {
  const m = new Map<string, DesignToken>();
  for (const t of tokens) m.set(t.name, t);
  return m;
}

// Get the raw value for a token under the active theme (before alias resolution).
function rawValue(
  token: DesignToken,
  theme: ThemeSet | null,
): string | number {
  if (theme && token.name in theme.values) {
    return theme.values[token.name];
  }
  return token.$value;
}

// Resolve a token name to its literal value, following aliases.
export function resolveToken(
  name: string,
  tokens: DesignToken[],
  theme: ThemeSet | null,
  _seen: Set<string> = new Set(),
): string | number | null {
  if (_seen.has(name)) return null; // cycle
  _seen.add(name);

  const map = tokenMap(tokens);
  const token = map.get(name);
  if (!token) return null;

  const raw = rawValue(token, theme);
  if (isAlias(raw)) {
    const target = aliasTarget(raw);
    if (!target) return null;
    return resolveToken(target, tokens, theme, _seen);
  }
  return raw;
}

// Resolve ALL tokens to a flat name→value map (for export / display).
export function resolveAll(
  tokens: DesignToken[],
  theme: ThemeSet | null,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const t of tokens) {
    const v = resolveToken(t.name, tokens, theme);
    if (v !== null) out[t.name] = v;
  }
  return out;
}

// Get the active theme object from a file (or null for default).
export function activeTheme(file: DesignFile): ThemeSet | null {
  if (file.activeThemeId === 'default') return null;
  return file.themes.find(t => t.id === file.activeThemeId) ?? null;
}

// ── Apply tokens to shapes ──────────────────────────────────────────────────
// Walk every shape with tokenBindings and write resolved values into the
// shape's properties. Returns true if anything changed.

export function applyTokensToFile(file: DesignFile): boolean {
  const theme = activeTheme(file);
  let changed = false;

  for (const page of file.pages) {
    for (const shape of Object.values(page.objects)) {
      if (!shape.tokenBindings) continue;
      for (const [path, tokenName] of Object.entries(shape.tokenBindings)) {
        const resolved = resolveToken(tokenName, file.tokens, theme);
        if (resolved === null) continue;
        if (setByPath(shape, path, resolved)) changed = true;
      }
      // Keep selrect in sync if x/y/width/height changed
      shape.selrect = { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
    }
  }
  return changed;
}

// Set a value at a dotted/indexed path: "fills.0.color", "textStyle.fontSize", "width"
function setByPath(obj: any, path: string, value: string | number): boolean {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cur[key] === undefined || cur[key] === null) return false;
    cur = cur[key];
  }
  const last = parts[parts.length - 1];
  if (cur[last] === value) return false;
  cur[last] = value;
  return true;
}

// ── Export to W3C JSON ──────────────────────────────────────────────────────
// Produces the standard nested { group: { token: { $type, $value } } } format.

export function exportTokensW3C(tokens: DesignToken[]): Record<string, unknown> {
  const root: Record<string, any> = {};
  for (const t of tokens) {
    const parts = t.name.split('.');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = cur[parts[i]] ?? {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = {
      $type: t.$type,
      $value: t.$value,
      ...(t.$description ? { $description: t.$description } : {}),
    };
  }
  return root;
}
