import React, { useState } from 'react';
import { useDesignStore } from '../store/useDesignStore';
import { generateCode, CodeFormat, cssClassName } from '../../shared/codegen';

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

  if (!shape || !page) {
    return <div style={s.empty}>Select a shape to inspect its code</div>;
  }

  const code = generateCode(shape, page, format);

  const copy = () => {
    navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div style={s.wrap}>
      {/* Measurements */}
      <div style={s.measures}>
        <Measure label="W" value={Math.round(shape.width)} />
        <Measure label="H" value={Math.round(shape.height)} />
        <Measure label="X" value={Math.round(shape.x)} />
        <Measure label="Y" value={Math.round(shape.y)} />
        {shape.rotation !== 0 && <Measure label="∠" value={shape.rotation} unit="°" />}
      </div>

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

      {/* Fills / measurements details */}
      {shape.fills.length > 0 && (
        <div style={s.colorList}>
          <div style={s.colorHeader}>Colors</div>
          {shape.fills.map((f, i) => f.type === 'solid' && (
            <div key={i} style={s.colorRow}
              onClick={() => navigator.clipboard?.writeText(f.color)}>
              <div style={{ ...s.swatch, background: f.color }} />
              <span style={s.colorVal}>{f.color.toUpperCase()}</span>
              <span style={s.copyHint}>click to copy</span>
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
  wrap: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui' },
  empty: { padding: 16, color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'system-ui' },
  measures: { display: 'flex', gap: 6, padding: '10px 12px', flexWrap: 'wrap', borderBottom: '1px solid var(--border)' },
  measure: { background: 'var(--border)', borderRadius: 4, padding: '4px 8px', minWidth: 42 },
  measureLabel: { fontSize: 9, color: 'var(--text-secondary)', textTransform: 'uppercase' },
  measureValue: { fontSize: 12, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' },
  formatTabs: { display: 'flex', gap: 2, padding: '8px 8px 4px', flexWrap: 'wrap' },
  formatTab: {
    background: 'var(--border)', border: 'none', color: 'var(--text-secondary)',
    fontSize: 11, padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
  },
  formatActive: { background: 'var(--accent-soft)', color: 'var(--text)' },
  codeWrap: { position: 'relative', margin: '4px 8px', flex: 1, minHeight: 0, overflow: 'hidden' },
  copyBtn: {
    position: 'absolute', top: 6, right: 6, zIndex: 2,
    background: 'rgba(30,30,46,0.9)', border: '1px solid var(--border-strong)',
    color: 'var(--text)', fontSize: 10, padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
  },
  code: {
    background: 'var(--bg-inset)', borderRadius: 6, padding: '10px',
    fontSize: 11, lineHeight: 1.5, color: 'var(--text)',
    fontFamily: 'ui-monospace, Menlo, monospace',
    overflow: 'auto', height: '100%', margin: 0,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  },
  colorList: { padding: '8px 12px', borderTop: '1px solid var(--border)' },
  colorHeader: { fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: 6 },
  colorRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', cursor: 'pointer', fontSize: 12 },
  swatch: { width: 14, height: 14, borderRadius: 3, border: '1px solid var(--border-strong)' },
  colorVal: { color: 'var(--text)', fontFamily: 'monospace', fontSize: 11 },
  copyHint: { color: 'var(--text-muted)', fontSize: 9, marginLeft: 'auto' },
};
