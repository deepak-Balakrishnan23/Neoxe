import React, { useState } from 'react';
import { DesignToken, TokenType, Shape } from '../../shared/types';
import { useDesignStore } from '../store/useDesignStore';
import { api } from '../ipc/api';
import { resolveToken, activeTheme, isAlias, exportTokensW3C } from '../../shared/tokens';

const TYPE_DOT: Record<TokenType, string> = {
  color: '◉', dimension: '↔', number: '#', fontFamily: 'T',
  fontWeight: 'B', spacing: '⊟', borderRadius: '⌜', opacity: '◐',
};

/**
 * The shape property each token type drives. A token type with nowhere to land returns an
 * explanation instead of an empty result, so the Apply button always says something.
 */
function bindingPaths(type: TokenType, shape: Shape): { paths: string[]; why: string } {
  const no = (why: string) => ({ paths: [], why });
  switch (type) {
    case 'color':
      if (shape.type === 'text') return { paths: ['textStyle.color'], why: '' };
      if (shape.fills.length > 0) return { paths: ['fills.0.color'], why: '' };
      return no('This layer has no fill to bind a colour to. Add a fill first.');
    case 'borderRadius':
      // Radius lives per corner; bind all four so the token drives the whole shape.
      return { paths: ['cornerRadii.tl', 'cornerRadii.tr', 'cornerRadii.br', 'cornerRadii.bl'], why: '' };
    case 'opacity':
      return { paths: ['opacity'], why: '' };
    case 'fontFamily':
      return shape.type === 'text'
        ? { paths: ['textStyle.fontFamily'], why: '' }
        : no('A font token applies to text layers only');
    case 'fontWeight':
      return shape.type === 'text'
        ? { paths: ['textStyle.fontWeight'], why: '' }
        : no('A font token applies to text layers only');
    case 'spacing':
      return shape.autoLayout
        ? { paths: ['autoLayout.spacing'], why: '' }
        : no('A spacing token drives auto-layout gap. Add auto layout to this frame first.');
    case 'dimension':
    case 'number':
      // Deliberately unmapped: a bare number could be width, height, gap or stroke weight,
      // and guessing would bind the wrong one. Alias it from a typed token instead.
      return no(`A ${type} token has no single property to bind to. Use a spacing, radius or opacity token.`);
  }
}

export default function TokensPanel() {
  const { file, setFile, selectedIds, activePage, showToast } = useDesignStore();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<TokenType>('color');
  const [newValue, setNewValue] = useState('#6E72F5');

  if (!file) return <div style={styles.empty}>No file open</div>;

  const theme = activeTheme(file);

  // Group tokens by their first path segment
  const groups: Record<string, DesignToken[]> = {};
  for (const t of file.tokens) {
    const g = t.name.split('.')[0];
    (groups[g] ??= []).push(t);
  }

  const selectedShape = selectedIds.size === 1
    ? activePage()?.objects[[...selectedIds][0]] ?? null
    : null;

  const addToken = async () => {
    const value = newType === 'color' ? newValue : (isAlias(newValue) ? newValue : Number(newValue) || newValue);
    const res = await api.addToken(newName, newType, value);
    if (res.ok && res.data) setFile(res.data);
    setAdding(false); setNewName(''); setNewValue(newType === 'color' ? '#6E72F5' : '0');
  };

  return (
    <div style={styles.panel}>
      {/* Theme switcher */}
      <div style={styles.themeBar}>
        <span style={styles.themeLabel}>Theme</span>
        <select
          style={styles.themeSelect}
          value={file.activeThemeId}
          onChange={async e => {
            const res = await api.switchTheme(e.target.value);
            if (res.ok && res.data) setFile(res.data);
          }}
        >
          <option value="default">Default</option>
          {file.themes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>

      <div style={styles.scroll}>
        {Object.entries(groups).map(([groupName, tokens]) => (
          <div key={groupName} style={styles.group}>
            <div style={styles.groupHeader}>{groupName}</div>
            {tokens.map(token => {
              const resolved = resolveToken(token.name, file.tokens, theme);
              const aliased = isAlias(token.$value);
              return (
                <TokenRow
                  key={token.id}
                  token={token}
                  resolved={resolved}
                  aliased={aliased}
                  shortName={token.name.split('.').slice(1).join('.') || token.name}
                  canApply={!!selectedShape}
                  onApply={async () => {
                    if (!selectedShape) return;
                    const page = activePage()!;
                    // Which property this token type drives, and WHY it can't be applied
                    // when it can't. Returning silently — as this did for every type
                    // except color — makes a working button look broken.
                    const { paths, why } = bindingPaths(token.$type, selectedShape);
                    if (paths.length === 0) { showToast(why); return; }
                    let updated = null;
                    for (const path of paths) {
                      const res = await api.bindToken(selectedShape.id, page.id, path, token.name);
                      if (res.ok && res.data) updated = res.data;
                    }
                    if (updated) setFile(updated);
                  }}
                  onDelete={async () => {
                    const res = await api.deleteToken(token.id);
                    if (res.ok && res.data) setFile(res.data);
                  }}
                  onValue={async (raw) => {
                    // A token exists to be changed once and followed everywhere. The
                    // engine re-resolves every binding on update, so editing here is what
                    // makes the whole system worth having — there was no way to do it.
                    const v: string | number = raw.trim();
                    let next: string | number;
                    if (token.$type === 'color' || isAlias(v)) next = v;
                    else if (v === '') next = token.$value;          // empty = leave as-is
                    else { const n = Number(v); next = Number.isFinite(n) ? n : v; }
                    if (next === token.$value) return;
                    const res = await api.updateToken(token.id, { $value: next });
                    if (res.ok && res.data) setFile(res.data);
                  }}
                />
              );
            })}
          </div>
        ))}

        {/* Add token */}
        {adding ? (
          <div style={styles.addForm}>
            <input style={styles.input} placeholder="name (e.g. color.primary)"
              value={newName} onChange={e => setNewName(e.target.value)} autoFocus
              onKeyDown={e => e.stopPropagation()} />
            <select style={styles.input} value={newType}
              onChange={e => setNewType(e.target.value as TokenType)}>
              {Object.keys(TYPE_DOT).map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input style={styles.input} placeholder="value or {alias}"
              value={newValue} onChange={e => setNewValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addToken(); e.stopPropagation(); }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={styles.primaryBtn} onClick={addToken}>Add</button>
              <button style={styles.ghostBtn} onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button style={styles.addTokenBtn} onClick={() => setAdding(true)}>＋ Add token</button>
        )}

        {/* Export */}
        <button style={styles.exportBtn} onClick={() => exportTokens(file)}>⤓ Export W3C JSON</button>

        {selectedShape && (
          <div style={styles.applyHint}>
            Click ⊕ on a token to apply it to "{selectedShape.name}"
          </div>
        )}
      </div>
    </div>
  );
}

// ── TokenRow ──────────────────────────────────────────────────────────────────

function TokenRow({ token, resolved, aliased, shortName, canApply, onApply, onDelete, onValue }: {
  token: DesignToken;
  resolved: string | number | null;
  aliased: boolean;
  shortName: string;
  canApply: boolean;
  onApply: () => void;
  onDelete: () => void;
  onValue: (raw: string) => void;
}) {
  const isColor = token.$type === 'color';
  return (
    <div style={styles.tokenRow}>
      {isColor ? (
        <div style={{ ...styles.swatch, background: String(resolved ?? '#000') }} />
      ) : (
        <span style={styles.typeDot}>{TYPE_DOT[token.$type]}</span>
      )}
      <span style={styles.tokenName}>{shortName}</span>
      <input
        style={{ ...styles.tokenValue, ...styles.valueInput }}
        defaultValue={String(token.$value)}
        key={String(token.$value)}
        title={aliased ? `alias → ${String(resolved)}` : 'Token value: edit to update every layer bound to it'}
        onBlur={e => onValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') { (e.target as HTMLInputElement).value = String(token.$value); (e.target as HTMLInputElement).blur(); }
          e.stopPropagation();
        }}
      />
      {canApply && (
        <button style={styles.applyBtn} title="Apply to selection" onClick={onApply}>⊕</button>
      )}
      <button style={styles.deleteBtn} title="Delete token" onClick={onDelete}>×</button>
    </div>
  );
}

// ── Export ────────────────────────────────────────────────────────────────────

function exportTokens(file: { tokens: DesignToken[] }) {
  const json = JSON.stringify(exportTokensW3C(file.tokens), null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'tokens.json';
  a.click();
  URL.revokeObjectURL(url);
}

const styles: Record<string, React.CSSProperties> = {
  panel: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'var(--font-ui)' },
  empty: { padding: 16, color: 'var(--text-secondary)', fontSize: 12 },
  themeBar: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
    borderBottom: '1px solid var(--border)', flexShrink: 0,
  },
  themeLabel: { fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' },
  themeSelect: {
    flex: 1, background: 'var(--border)', border: '1px solid var(--border-strong)',
    borderRadius: 4, color: 'var(--text)', fontSize: 12, padding: '0 6px', height: 24, cursor: 'pointer', outline: 'none',
  },
  scroll: { flex: 1, overflowY: 'auto', padding: '6px 8px' },
  group: { marginBottom: 8 },
  groupHeader: {
    fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)',
    textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4, paddingLeft: 2,
  },
  tokenRow: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '4px 4px',
    fontSize: 12, borderRadius: 4,
  },
  swatch: { width: 16, height: 16, borderRadius: 4, flexShrink: 0, border: '1px solid var(--border-strong)' },
  typeDot: { width: 16, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 11, flexShrink: 0 },
  tokenName: { flex: 1, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tokenValue: { color: 'var(--text-secondary)', fontSize: 10, fontFamily: 'var(--font-mono)', flexShrink: 0, maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis' },
  aliasTag: { color: 'var(--accent-hover)' },
  applyBtn: { background: 'transparent', border: 'none', color: 'var(--accent-hover)', fontSize: 13, cursor: 'pointer', padding: '0 2px', flexShrink: 0 },
  deleteBtn: { background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer', padding: '0 2px', flexShrink: 0 },
  addForm: { display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 4px' },
  valueInput: {
    background: 'transparent', border: '1px solid transparent', borderRadius: 4,
    color: 'var(--text-secondary)', font: 'inherit', textAlign: 'right',
    outline: 'none', padding: '1px 4px', minWidth: 0,
  },
  input: {
    background: 'var(--border)', border: '1px solid var(--border-strong)',
    borderRadius: 4, color: 'var(--text)', fontSize: 12, padding: '0 6px', height: 24, outline: 'none', fontFamily: 'var(--font-ui)',
  },
  primaryBtn: { background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4, padding: '0 12px', height: 24, fontSize: 12, cursor: 'pointer' },
  ghostBtn: { background: 'var(--border)', color: 'var(--text)', border: 'none', borderRadius: 4, padding: '0 12px', height: 24, fontSize: 12, cursor: 'pointer' },
  addTokenBtn: {
    width: '100%', background: 'var(--border)', border: '1px dashed var(--border-strong)',
    borderRadius: 6, color: 'var(--text-secondary)', fontSize: 12, padding: '0 8px', height: 28, cursor: 'pointer', marginTop: 4,
  },
  exportBtn: {
    width: '100%', background: 'transparent', border: 'none',
    color: 'var(--text-secondary)', fontSize: 11, padding: '0 8px', height: 28, cursor: 'pointer', marginTop: 8,
  },
  applyHint: { fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', padding: '4px 8px', lineHeight: 1.5 },
};
