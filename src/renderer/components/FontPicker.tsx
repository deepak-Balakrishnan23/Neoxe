import React, { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { ensureFontLoaded, isFontAvailable, FONT_LOADED_EVENT, FONT_FAILED_EVENT } from '../canvas/fontLoader';

// ── Local Font Access API ─────────────────────────────────────────────────────
// Chromium-only, experimental — not in TS's DOM lib yet, so declare the minimal
// shape we actually use. `queryLocalFonts()` triggers a one-time browser permission
// prompt ("Allow this site to see fonts installed on your device"); it must be
// called from within a user gesture (a click handler), which is why we only call
// it when the user explicitly opts in from inside the picker.
interface LocalFontData { family: string; fullName: string; postscriptName: string; style: string }
declare global {
  interface Window {
    queryLocalFonts?: () => Promise<LocalFontData[]>;
  }
}

const SUPPORTS_LOCAL_FONTS = typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function';

// Always-available, no-permission-needed fallback. First entry is the OS UI font
// stack — labeled plainly ("System default") rather than a bare "System" so it
// doesn't read as a mystery font name.
export const WEB_SAFE_FONTS: { name: string; stack: string }[] = [
  { name: 'System default', stack: 'system-ui, -apple-system, sans-serif' },
  { name: 'Inter', stack: 'Inter, system-ui, sans-serif' },
  { name: 'Helvetica', stack: 'Helvetica, Arial, sans-serif' },
  { name: 'Arial', stack: 'Arial, Helvetica, sans-serif' },
  { name: 'Verdana', stack: 'Verdana, Geneva, sans-serif' },
  { name: 'Tahoma', stack: 'Tahoma, sans-serif' },
  { name: 'Trebuchet MS', stack: '"Trebuchet MS", sans-serif' },
  { name: 'Georgia', stack: 'Georgia, serif' },
  { name: 'Times New Roman', stack: '"Times New Roman", Times, serif' },
  { name: 'Garamond', stack: 'Garamond, serif' },
  { name: 'Courier New', stack: '"Courier New", monospace' },
  { name: 'Menlo', stack: 'Menlo, Monaco, monospace' },
];

function familyToStack(family: string): string {
  const needsQuotes = /[^a-zA-Z0-9-]/.test(family);
  return `${needsQuotes ? `"${family}"` : family}, sans-serif`;
}

type Status = 'idle' | 'loading' | 'granted' | 'denied' | 'unsupported';

interface Props {
  value: string;               // current CSS font-family stack, e.g. 'Inter, system-ui, sans-serif'
  onChange: (stack: string) => void;
}

export default function FontPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Status>(SUPPORTS_LOCAL_FONTS ? 'idle' : 'unsupported');
  const [localFamilies, setLocalFamilies] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  // Track availability of the CURRENT font so a missing family (e.g. an icon font
  // that isn't installed) shows a clear indicator instead of silently falling back.
  // Re-check whenever the value changes or a pending load resolves/fails.
  const [, forceCheck] = useState(0);
  useEffect(() => { ensureFontLoaded(value); }, [value]);
  useEffect(() => {
    const bump = () => forceCheck(n => n + 1);
    window.addEventListener(FONT_LOADED_EVENT, bump);
    window.addEventListener(FONT_FAILED_EVENT, bump);
    return () => {
      window.removeEventListener(FONT_LOADED_EVENT, bump);
      window.removeEventListener(FONT_FAILED_EVENT, bump);
    };
  }, []);
  const available = isFontAvailable(value);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    setTimeout(() => window.addEventListener('mousedown', handler), 0);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  // Must run inside a click handler — the permission prompt only appears in
  // response to a genuine user gesture.
  const requestSystemFonts = useCallback(async () => {
    if (!window.queryLocalFonts) { setStatus('unsupported'); return; }
    setStatus('loading');
    try {
      const fonts = await window.queryLocalFonts();
      const families = Array.from(new Set(fonts.map(f => f.family))).sort((a, b) => a.localeCompare(b));
      setLocalFamilies(families);
      setStatus('granted');
    } catch {
      setStatus('denied');
    }
  }, []);

  const known = WEB_SAFE_FONTS.find(f =>
    f.stack.split(',')[0].trim().toLowerCase() === value.split(',')[0].trim().toLowerCase());
  const currentLabel = known?.name ?? value.split(',')[0].replace(/["']/g, '').trim();

  const localOnly = localFamilies.filter(fam =>
    !WEB_SAFE_FONTS.some(w => w.name.toLowerCase() === fam.toLowerCase()));

  const entries = [...WEB_SAFE_FONTS, ...localOnly.map(fam => ({ name: fam, stack: familyToStack(fam) }))]
    .sort((a, b) => a.name.localeCompare(b.name));

  const filtered = query.trim()
    ? entries.filter(f => f.name.toLowerCase().includes(query.trim().toLowerCase()))
    : entries;

  const select = (stack: string) => { onChange(stack); setOpen(false); setQuery(''); };

  return (
    <div ref={rootRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <button type="button" style={s.trigger} onClick={() => setOpen(o => !o)} title="Font family">
        <span style={{ ...s.triggerLabel, fontFamily: value }}>{currentLabel}</span>
        {!available && (
          <span style={s.missing} title={`"${currentLabel}" isn't available on this device. Showing a fallback font.`}>!</span>
        )}
        <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div style={s.popover} onMouseDown={e => e.stopPropagation()}>
          <input
            autoFocus
            style={s.search}
            placeholder="Search fonts…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />

          {status === 'idle' && (
            <button type="button" style={s.cta} onClick={requestSystemFonts}>
              <Icon name="import" size={13} />
              Show fonts installed on this device
            </button>
          )}
          {status === 'loading' && <div style={s.note}>Requesting font access…</div>}
          {status === 'denied' && (
            <div style={s.note}>
              Font access denied. Showing web-safe fonts. Allow it from your browser's site settings to see installed fonts.
            </div>
          )}
          {status === 'unsupported' && (
            <div style={s.note}>Full system font access needs Chrome, Edge, or Brave. Showing web-safe fonts only.</div>
          )}

          <div style={s.list}>
            {filtered.length === 0 && <div style={s.note}>No fonts match "{query}"</div>}
            {filtered.map(f => (
              <FontOption key={f.name} name={f.name} stack={f.stack}
                active={f.name === currentLabel} onClick={() => select(f.stack)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FontOption({ name, stack, active, onClick }: {
  name: string; stack: string; active: boolean; onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      style={{ ...s.option, background: active ? 'var(--accent-soft)' : hover ? 'var(--row-hover)' : 'transparent' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
    >
      <span style={{ fontFamily: stack, ...s.optionLabel }}>{name}</span>
      {active && <Icon name="check" size={12} />}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  trigger: {
    width: '100%', height: 28, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: 'var(--bg-inset)', border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--text)', fontSize: 12, padding: '0 8px', cursor: 'pointer', gap: 8,
  },
  triggerLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', flex: 1 },
  missing: {
    flexShrink: 0, width: 14, height: 14, borderRadius: '50%', display: 'flex',
    alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700,
    background: 'var(--warning, #B8860B)', color: '#fff', lineHeight: 1,
  },
  popover: {
    position: 'absolute', top: '100%', left: 0, marginTop: 4, width: 240, maxWidth: '80vw',
    background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: 8,
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)', zIndex: 1000,
    display: 'flex', flexDirection: 'column', padding: 8, gap: 8,
  },
  search: {
    height: 28, background: 'var(--bg-inset)', border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--text)', fontSize: 12, padding: '0 8px', outline: 'none',
  },
  cta: {
    display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center',
    background: 'var(--accent-soft)', border: 'none', borderRadius: 6,
    color: 'var(--accent-hover)', fontSize: 11, fontWeight: 600, padding: '8px 8px', cursor: 'pointer',
  },
  note: { fontSize: 11, lineHeight: 1.4, color: 'var(--text-muted)', padding: '2px 4px' },
  list: { display: 'flex', flexDirection: 'column', maxHeight: 240, overflowY: 'auto' },
  option: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    padding: '6px 8px', borderRadius: 4, cursor: 'pointer', color: 'var(--text)',
  },
  optionLabel: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
};
