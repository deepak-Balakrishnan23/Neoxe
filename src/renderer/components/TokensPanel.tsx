import React, { useState } from 'react';
import { DesignToken, TokenType } from '../../shared/types';
import { useDesignStore } from '../store/useDesignStore';
import { api } from '../ipc/api';
import { resolveToken, activeTheme, isAlias, exportTokensW3C } from '../../shared/tokens';

const TYPE_DOT: Record<TokenType, string> = {
  color: '◉', dimension: '↔', number: '#', fontFamily: 'T',
  fontWeight: 'B', spacing: '⊟', borderRadius: '⌜', opacity: '◐',
};

export default function TokensPanel() {
  const { file, setFile, selectedIds, activePage } = useDesignStore();
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
                    // Determine binding path by token type
                    let path: string | null = null;
                    if (token.$type === 'color') {
                      if (selectedShape.type === 'text') path = 'textStyle.color';
                      else if (selectedShape.fills.length > 0) path = 'fills.0.color';
                    } else if (token.$type === 'borderRadius') {
                      path = 'borderRadius';
                    }
                    if (!path) return;
                    const res = await api.bindToken(selectedShape.id, page.id, path, token.name);
                    if (res.ok && res.data) setFile(res.data);
                  }}
                  onDelete={async () => {
                    const res = await api.deleteToken(token.id);
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
            <div style={{ display: 'flex', gap: 6 }}>
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

function TokenRow({ token, resolved, aliased, shortName, canApply, onApply, onDelete }: {
  token: DesignToken;
  resolved: string | number | null;
  aliased: boolean;
  shortName: string;
  canApply: boolean;
  onApply: () => void;
  onDelete: () => void;
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
      <span style={styles.tokenValue}>
        {aliased ? <span style={styles.aliasTag}>{String(token.$value)}</span> : null}
        {!aliased && String(resolved)}
      </span>
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
  panel: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui' },
  empty: { padding: 16, color: 'var(--text-secondary)', fontSize: 12 },
  themeBar: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
    borderBottom: '1px solid var(--border)', flexShrink: 0,
  },
  themeLabel: { fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' },
  themeSelect: {
    flex: 1, background: 'var(--border)', border: '1px solid var(--border-strong)',
    borderRadius: 4, color: 'var(--text)', fontSize: 12, padding: '3px 6px', cursor: 'pointer', outline: 'none',
  },
  scroll: { flex: 1, overflowY: 'auto', padding: '6px 8px' },
  group: { marginBottom: 10 },
  groupHeader: {
    fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)',
    textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4, paddingLeft: 2,
  },
  tokenRow: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px',
    fontSize: 12, borderRadius: 4,
  },
  swatch: { width: 16, height: 16, borderRadius: 3, flexShrink: 0, border: '1px solid var(--border-strong)' },
  typeDot: { width: 16, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 11, flexShrink: 0 },
  tokenName: { flex: 1, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tokenValue: { color: 'var(--text-secondary)', fontSize: 10, fontFamily: 'monospace', flexShrink: 0, maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis' },
  aliasTag: { color: 'var(--accent-hover)' },
  applyBtn: { background: 'transparent', border: 'none', color: 'var(--accent-hover)', fontSize: 13, cursor: 'pointer', padding: '0 2px', flexShrink: 0 },
  deleteBtn: { background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer', padding: '0 2px', flexShrink: 0 },
  addForm: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 4px' },
  input: {
    background: 'var(--border)', border: '1px solid var(--border-strong)',
    borderRadius: 4, color: 'var(--text)', fontSize: 12, padding: '4px 6px', outline: 'none', fontFamily: 'system-ui',
  },
  primaryBtn: { background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 12px', fontSize: 12, cursor: 'pointer' },
  ghostBtn: { background: 'var(--border)', color: 'var(--text)', border: 'none', borderRadius: 4, padding: '4px 12px', fontSize: 12, cursor: 'pointer' },
  addTokenBtn: {
    width: '100%', background: 'var(--border)', border: '1px dashed var(--border-strong)',
    borderRadius: 6, color: 'var(--text-secondary)', fontSize: 12, padding: '6px', cursor: 'pointer', marginTop: 4,
  },
  exportBtn: {
    width: '100%', background: 'transparent', border: 'none',
    color: 'var(--text-secondary)', fontSize: 11, padding: '8px', cursor: 'pointer', marginTop: 8,
  },
  applyHint: { fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', padding: '4px 8px', lineHeight: 1.5 },
};
