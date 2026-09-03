import React, { useState, useMemo } from 'react';
import { useDesignStore } from '../store/useDesignStore';
import { generateCode, CodeFormat } from '../../shared/codegen';

const FORMATS: { id: CodeFormat; label: string }[] = [
  { id: 'css', label: 'CSS' },
  { id: 'html', label: 'HTML' },
  { id: 'svg', label: 'SVG' },
  { id: 'react', label: 'React' },
  { id: 'tailwind', label: 'Tailwind' },
];

export default function InspectPanel() {
  const { activePage, selectedIds } = useDesignStore();
  const [format, setFormat] = useState<CodeFormat>('css');
  const [copied, setCopied] = useState(false);

  const page = activePage();
  const shape = page && selectedIds.size === 1
    ? page.objects[[...selectedIds][0]]
    : null;

  // Memoized so the full CSS/SVG/HTML string isn't regenerated on unrelated re-renders
  // (e.g. the 1.2s `copied` toggle) — only when the shape, page, or format actually change.
  const code = useMemo(
    () => (shape && page) ? generateCode(shape, page, format) : '',
    [shape, page, format]);

  if (!shape || !page) {
    return <div style={s.empty}>Select a shape to inspect its code</div>;
  }

  const copy = () => {
    navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  // Position relative to the parent container (Figma model) — the page-absolute
  // canvas coordinate is meaningless for handoff.
  const parent = shape.parentId ? page.objects[shape.parentId] : null;

  return (
    <div style={s.wrap}>
      {/* Measurements */}
      <div style={s.measures}>
        <Measure label="W" value={Math.round(shape.width)} />
        <Measure label="H" value={Math.round(shape.height)} />
        <Measure label="X" value={Math.round(shape.x - (parent?.x ?? 0))} />
        <Measure label="Y" value={Math.round(shape.y - (parent?.y ?? 0))} />
        {shape.rotation !== 0 && <Measure label="∠" value={shape.rotation} unit="°" />}
      </div>
      {parent && <div style={s.relNote}>X/Y relative to “{parent.name}”</div>}

      {/* Format tabs */}
      <div style={s.formatTabs}>
        {FORMATS.map(f => (
          <button key={f.id}
            style={{ ...s.formatTab, ...(format === f.id ? s.formatActive : {}) }}
            onClick={() => setFormat(f.id)}>{f.label}</button>
        ))}
      </div>

      {/* Code */}
      <div style={s.codeWrap}>
        <button style={s.copyBtn} onClick={copy}>{copied ? '✓ Copied' : '⧉ Copy'}</button>
        <pre style={s.code}>{code}</pre>
      </div>

      {/* Typography (text shapes) — font details for handoff, Figma-style */}
      {shape.type === 'text' && shape.textStyle && (
        <div style={s.colorList}>
          <div style={s.colorHeader}>Typography</div>
          <div style={s.typoGrid}>
            <span style={s.typoKey}>Font</span><span style={s.typoVal}>{shape.textStyle.fontFamily}</span>
            <span style={s.typoKey}>Weight</span><span style={s.typoVal}>{shape.textStyle.fontWeight}</span>
            <span style={s.typoKey}>Size</span><span style={s.typoVal}>{shape.textStyle.fontSize}px</span>
            <span style={s.typoKey}>Line height</span><span style={s.typoVal}>{shape.textStyle.lineHeight}</span>
            {!!shape.textStyle.letterSpacing && (<><span style={s.typoKey}>Letter</span><span style={s.typoVal}>{shape.textStyle.letterSpacing}px</span></>)}
          </div>
        </div>
      )}

      {/* Colors — solid fills + stroke colors, click to copy */}
      {(shape.fills.some(f => f.type === 'solid') || shape.strokes.length > 0) && (
        <div style={s.colorList}>
          <div style={s.colorHeader}>Colors</div>
          {shape.fills.map((f, i) => f.type === 'solid' && (
            <div key={`f${i}`} style={s.colorRow}
              onClick={() => navigator.clipboard?.writeText(f.color)}>
              <div style={{ ...s.swatch, background: f.color }} />
              <span style={s.colorVal}>{f.color.toUpperCase()}</span>
              <span style={s.copyHint}>fill · click to copy</span>
            </div>
          ))}
          {shape.strokes.map((st, i) => (
            <div key={`s${i}`} style={s.colorRow}
              onClick={() => navigator.clipboard?.writeText(st.color)}>
              <div style={{ ...s.swatch, background: st.color }} />
              <span style={s.colorVal}>{st.color.toUpperCase()}</span>
              <span style={s.copyHint}>stroke · click to copy</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Measure({ label, value, unit }: { label: string; value: number; unit?: string }) {
  return (
    <div style={s.measure}>
      <div style={s.measureLabel}>{label}</div>
      <div style={s.measureValue}>{value}{unit ?? 'px'}</div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  wrap: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'var(--font-ui)' },
  empty: { padding: 16, color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'var(--font-ui)' },
  measures: { display: 'flex', gap: 8, padding: '10px 12px 6px', flexWrap: 'wrap' },
  relNote: { fontSize: 10, color: 'var(--text-muted)', padding: '0 12px 8px', borderBottom: '1px solid var(--border)' },
  typoGrid: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 10px', fontSize: 11 },
  typoKey: { color: 'var(--text-secondary)' },
  typoVal: { color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  measure: { background: 'var(--border)', borderRadius: 4, padding: '4px 8px', minWidth: 42 },
  measureLabel: { fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' },
  measureValue: { fontSize: 12, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' },
  formatTabs: { display: 'flex', gap: 2, padding: '8px 8px 4px', flexWrap: 'wrap' },
  formatTab: {
    background: 'var(--border)', border: 'none', color: 'var(--text-secondary)',
    fontSize: 11, padding: '0 8px', height: 24, borderRadius: 4, cursor: 'pointer',
  },
  formatActive: { background: 'var(--accent-soft)', color: 'var(--text)' },
  codeWrap: { position: 'relative', margin: '4px 8px', flex: 1, minHeight: 0, overflow: 'hidden' },
  copyBtn: {
    position: 'absolute', top: 6, right: 6, zIndex: 2,
    background: 'rgba(30,30,46,0.9)', border: '1px solid var(--border-strong)',
    color: 'var(--text)', fontSize: 10, padding: '0 8px', height: 24, borderRadius: 4, cursor: 'pointer',
  },
  code: {
    background: 'var(--bg-inset)', borderRadius: 6, padding: '10px',
    fontSize: 11, lineHeight: 1.5, color: 'var(--text)',
    fontFamily: 'var(--font-mono)',
    overflow: 'auto', height: '100%', margin: 0,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  },
  colorList: { padding: '8px 12px', borderTop: '1px solid var(--border)' },
  colorHeader: { fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: 8 },
  colorRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', cursor: 'pointer', fontSize: 12 },
  swatch: { width: 14, height: 14, borderRadius: 4, border: '1px solid var(--border-strong)' },
  colorVal: { color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 11 },
  copyHint: { color: 'var(--text-muted)', fontSize: 11, marginLeft: 'auto' },
};
