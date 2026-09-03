import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Fill, GradientStop } from '../../shared/types';
import { useDesignStore } from '../store/useDesignStore';
import { api } from '../ipc/api';
import { importImageFiles, IMAGE_ACCEPT_ATTR } from '../io/imageImport';

// ── Color math ─────────────────────────────────────────────────────────────

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0');
  const n = parseInt(full, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, max === 0 ? 0 : d / max, max];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h /= 360;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const cases: [number, number, number][] = [
    [v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q],
  ];
  const [r, g, b] = cases[i % 6];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export function hueColor(h: number): string {
  const [r, g, b] = hsvToRgb(h, 1, 1);
  return rgbToHex(r, g, b);
}

// Build the CSS gradient string used for the preview bar (left→right by offset).
function stopsToCss(stops: GradientStop[]): string {
  const sorted = [...stops].sort((a, b) => a.offset - b.offset);
  return sorted.map(s => {
    const [r, g, b] = hexToRgb(s.color);
    return `rgba(${r},${g},${b},${s.opacity}) ${Math.round(s.offset * 100)}%`;
  }).join(', ');
}

const GRADIENT_TYPES = [
  { value: 'linear-gradient', label: 'Linear' },
  { value: 'radial-gradient', label: 'Radial' },
] as const;

// ── ColorPicker component ──────────────────────────────────────────────────

interface Props {
  color: string;    // hex (legacy solid API)
  opacity: number;  // 0–1
  onChange: (color: string, opacity: number) => void;
  onClose: () => void;
  anchorRect: DOMRect;
  // Full-fill API: when provided, the picker can switch between Solid and Gradient.
  fill?: Fill;
  onFillChange?: (fill: Fill) => void;
}

export default function ColorPicker({ color, opacity, onChange, onClose, anchorRect, fill, onFillChange }: Props) {
  const allowGradient = !!onFillChange;
  const fillIsGradient = fill?.type === 'linear-gradient' || fill?.type === 'radial-gradient';

  const fillIsImage = fill?.type === 'image';
  const [mode, setMode] = useState<'solid' | 'gradient' | 'image'>(
    fillIsImage ? 'image' : fillIsGradient ? 'gradient' : 'solid');
  const imageInputRef = useRef<HTMLInputElement>(null);
  const { activePage, setFile } = useDesignStore();

  // Import a file, store it on the document, and switch this paint to an image fill.
  const chooseImage = async (files: File[]) => {
    const page = activePage();
    if (!page || files.length === 0 || !onFillChange) return;
    const [img] = await importImageFiles(files);
    if (!img) return;
    const imageId = `img-${Math.random().toString(36).slice(2, 10)}`;
    const res = await api.applyChanges({ pageId: page.id, ops: [{ op: 'setImage', id: imageId, dataUrl: img.dataUrl }] });
    if (res.ok && res.data) setFile(res.data);
    setMode('image');
    onFillChange({ type: 'image', imageId, scaleMode: 'fill', opacity: fill?.opacity ?? 1 });
  };
  const [gradType, setGradType] = useState<'linear-gradient' | 'radial-gradient'>(
    fill?.type === 'radial-gradient' ? 'radial-gradient' : 'linear-gradient',
  );
  const [stops, setStops] = useState<GradientStop[]>(
    fillIsGradient ? (fill as { stops: GradientStop[] }).stops.map(s => ({ ...s }))
      : [{ color: color, opacity: opacity, offset: 0 }, { color: '#FFFFFF', opacity: 0, offset: 1 }],
  );
  const [selected, setSelected] = useState(0);

  // HSV/alpha drive the SV square; they mirror the "active" colour (solid value or the
  // currently-selected gradient stop).
  const activeHex = mode === 'gradient' ? (stops[selected]?.color ?? '#000000') : color;
  const activeAlpha = mode === 'gradient' ? (stops[selected]?.opacity ?? 1) : opacity;
  const [r0, g0, b0] = hexToRgb(activeHex);
  const [ih, is, iv] = rgbToHsv(r0, g0, b0);

  const [hue, setHue] = useState(ih);
  const [sat, setSat] = useState(is);
  const [val, setVal] = useState(iv);
  const [alpha, setAlpha] = useState(activeAlpha);
  const [hexInput, setHexInput] = useState(activeHex.replace('#', '').toUpperCase());

  const svRef = useRef<HTMLCanvasElement>(null);
  const hueRef = useRef<HTMLCanvasElement>(null);
  const alphaRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef<'sv' | 'hue' | 'alpha' | 'stop' | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Re-sync the SV square to a given colour (used when selecting a stop / toggling mode).
  const syncTo = (hex: string, a: number) => {
    const [rr, gg, bb] = hexToRgb(hex);
    const [nh, ns, nv] = rgbToHsv(rr, gg, bb);
    setHue(nh); setSat(ns); setVal(nv); setAlpha(a);
    setHexInput(hex.replace('#', '').toUpperCase());
  };

  // ── Emit ───────────────────────────────────────────────────────────────
  const emitSolid = (hex: string, a: number) => {
    if (onFillChange) onFillChange({ type: 'solid', color: hex, opacity: a });
    else onChange(hex, a);
  };
  const emitGradient = (nextStops: GradientStop[], type = gradType) => {
    if (!onFillChange) return;
    const base = { opacity: 1, stops: nextStops.map(s => ({ ...s })) };
    if (type === 'radial-gradient') {
      onFillChange({ type: 'radial-gradient', centerX: 0.5, centerY: 0.5, radius: 0.5, ...base });
    } else {
      onFillChange({ type: 'linear-gradient', startX: 0, startY: 0.5, endX: 1, endY: 0.5, ...base });
    }
  };

  // Apply an HSV/alpha edit to the active target (solid colour or selected stop).
  const applyColor = useCallback((h: number, s: number, v: number, a: number) => {
    const [rr, gg, bb] = hsvToRgb(h, s, v);
    const hex = rgbToHex(rr, gg, bb);
    setHexInput(hex.replace('#', '').toUpperCase());
    if (mode === 'gradient') {
      setStops(prev => {
        const next = prev.map((st, i) => (i === selected ? { ...st, color: hex, opacity: a } : st));
        emitGradient(next);
        return next;
      });
    } else {
      emitSolid(hex, a);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selected, gradType, onFillChange, onChange]);

  // ── Draw canvases ────────────────────────────────────────────────────────
  const drawSV = useCallback(() => {
    const c = svRef.current; if (!c) return;
    const ctx = c.getContext('2d')!;
    const { width: w, height: h } = c;
    const pure = hueColor(hue);
    ctx.clearRect(0, 0, w, h);
    const gradH = ctx.createLinearGradient(0, 0, w, 0);
    gradH.addColorStop(0, '#fff'); gradH.addColorStop(1, pure);
    ctx.fillStyle = gradH; ctx.fillRect(0, 0, w, h);
    const gradV = ctx.createLinearGradient(0, 0, 0, h);
    gradV.addColorStop(0, 'transparent'); gradV.addColorStop(1, '#000');
    ctx.fillStyle = gradV; ctx.fillRect(0, 0, w, h);
    const cx = sat * w, cy = (1 - val) * h;
    ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1; ctx.stroke();
  }, [hue, sat, val]);

  const drawHue = useCallback(() => {
    const c = hueRef.current; if (!c) return;
    const ctx = c.getContext('2d')!;
    const { width: w, height: h } = c;
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
    ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
    const cx = (hue / 360) * w;
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx, h / 2, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1; ctx.stroke();
  }, [hue]);

  const drawAlpha = useCallback(() => {
    const c = alphaRef.current; if (!c) return;
    const ctx = c.getContext('2d')!;
    const { width: w, height: h } = c;
    for (let x = 0; x < w; x += 8) for (let y = 0; y < h; y += 8) {
      ctx.fillStyle = ((x / 8 + y / 8) % 2 === 0) ? '#aaa' : '#fff';
      ctx.fillRect(x, y, 8, h);
    }
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'transparent'); grad.addColorStop(1, hueColor(hue));
    ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
    const cx = alpha * w;
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx, h / 2, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1; ctx.stroke();
  }, [hue, alpha]);

  useEffect(() => { drawSV(); drawHue(); drawAlpha(); }, [drawSV, drawHue, drawAlpha]);

  // ── SV / hue / alpha drag ────────────────────────────────────────────────
  const getSVPoint = (e: MouseEvent | React.MouseEvent) => {
    const c = svRef.current!; const rect = c.getBoundingClientRect();
    return { s: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)), v: Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height)) };
  };
  const onSVDown = (e: React.MouseEvent) => {
    dragging.current = 'sv';
    const { s, v } = getSVPoint(e); setSat(s); setVal(v); applyColor(hue, s, v, alpha); e.preventDefault();
  };
  const onHueDown = (e: React.MouseEvent) => {
    dragging.current = 'hue';
    const rect = hueRef.current!.getBoundingClientRect();
    const h = Math.max(0, Math.min(360, ((e.clientX - rect.left) / rect.width) * 360));
    setHue(h); applyColor(h, sat, val, alpha); e.preventDefault();
  };
  const onAlphaDown = (e: React.MouseEvent) => {
    dragging.current = 'alpha';
    const rect = alphaRef.current!.getBoundingClientRect();
    const a = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setAlpha(a); applyColor(hue, sat, val, a); e.preventDefault();
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      if (dragging.current === 'sv') {
        const { s, v } = getSVPoint(e); setSat(s); setVal(v); applyColor(hue, s, v, alpha);
      } else if (dragging.current === 'hue') {
        const rect = hueRef.current!.getBoundingClientRect();
        const h = Math.max(0, Math.min(360, ((e.clientX - rect.left) / rect.width) * 360));
        setHue(h); applyColor(h, sat, val, alpha);
      } else if (dragging.current === 'alpha') {
        const rect = alphaRef.current!.getBoundingClientRect();
        const a = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        setAlpha(a); applyColor(hue, sat, val, a);
      } else if (dragging.current === 'stop' && barRef.current) {
        const rect = barRef.current.getBoundingClientRect();
        const off = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        setStops(prev => {
          const next = prev.map((st, i) => (i === selected ? { ...st, offset: off } : st));
          emitGradient(next);
          return next;
        });
      }
    };
    const onUp = () => { dragging.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [hue, sat, val, alpha, applyColor, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mode + gradient editing ──────────────────────────────────────────────
  const switchToSolid = () => {
    setMode('solid');
    const hex = stops[selected]?.color ?? color;
    const a = stops[selected]?.opacity ?? opacity;
    syncTo(hex, a);
    emitSolid(hex, a);
  };
  const switchToGradient = () => {
    setMode('gradient');
    const init: GradientStop[] = stops.length >= 2 ? stops : [
      { color: color, opacity: opacity, offset: 0 },
      { color: '#FFFFFF', opacity: 0, offset: 1 },
    ];
    setStops(init); setSelected(0);
    syncTo(init[0].color, init[0].opacity);
    emitGradient(init);
  };
  const selectStop = (i: number) => {
    setSelected(i);
    syncTo(stops[i].color, stops[i].opacity);
  };
  const addStop = (offset: number) => {
    // interpolate position only — colour defaults to the selected stop's colour
    const base = stops[selected] ?? stops[0];
    const next = [...stops, { color: base.color, opacity: base.opacity, offset }];
    setStops(next);
    setSelected(next.length - 1);
    syncTo(base.color, base.opacity);
    emitGradient(next);
  };
  const removeStop = (i: number) => {
    if (stops.length <= 2) return;
    const next = stops.filter((_, idx) => idx !== i);
    setStops(next);
    const ns = Math.max(0, Math.min(next.length - 1, selected > i ? selected - 1 : selected));
    setSelected(ns);
    syncTo(next[ns].color, next[ns].opacity);
    emitGradient(next);
  };
  const setStopOffset = (i: number, pct: number) => {
    const next = stops.map((st, idx) => (idx === i ? { ...st, offset: Math.max(0, Math.min(1, pct / 100)) } : st));
    setStops(next); emitGradient(next);
  };

  // ── Close on outside click ─────────────────────────────────────────────────
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    setTimeout(() => window.addEventListener('mousedown', handler), 0);
    return () => window.removeEventListener('mousedown', handler);
  }, [onClose]);

  const left = Math.min(anchorRect.left, window.innerWidth - 240);
  const top = Math.min(anchorRect.bottom + 6, window.innerHeight - 360);

  const previewBg = mode === 'gradient'
    ? `linear-gradient(90deg, ${stopsToCss(stops)})`
    : activeHex;

  return (
    <div ref={rootRef} style={{ ...styles.popover, left, top }} onMouseDown={e => e.stopPropagation()} data-colorpicker>
      {/* Top: Solid / Gradient toggle (only the first two Figma fill types) */}
      {allowGradient && (
        <div style={styles.modeRow}>
          <button title="Solid" style={modeBtnStyle(mode === 'solid')} onClick={switchToSolid}>
            <span style={{ ...styles.modeSwatch, background: activeHex }} />
          </button>
          <button title="Gradient" style={modeBtnStyle(mode === 'gradient')} onClick={switchToGradient}>
            <span style={{ ...styles.modeSwatch, background: 'linear-gradient(135deg,#fff,#000)' }} />
          </button>
          <button title="Image" style={modeBtnStyle(mode === 'image')} onClick={() => imageInputRef.current?.click()}>
            <span style={{ ...styles.modeSwatch, background: 'repeating-conic-gradient(#bbb 0% 25%, #fff 0% 50%) 50% / 8px 8px' }} />
          </button>
          <input
            ref={imageInputRef} type="file" accept={IMAGE_ACCEPT_ATTR} style={{ display: 'none' }}
            onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void chooseImage(files); }}
          />
        </div>
      )}

      {/* Image paint: how the picture is fitted to the layer's box. */}
      {mode === 'image' && fill?.type === 'image' && (
        <div style={{ padding: '8px 10px 0' }}>
          <select
            style={styles.gradTypeSelect}
            value={fill.scaleMode}
            onChange={e => onFillChange?.({ ...fill, scaleMode: e.target.value as typeof fill.scaleMode })}
          >
            <option value="fill">Fill</option>
            <option value="fit">Fit</option>
            <option value="stretch">Stretch</option>
            <option value="tile">Tile</option>
          </select>
          <button style={{ ...styles.gradTypeSelect, marginTop: 8, cursor: 'pointer' }}
            onClick={() => imageInputRef.current?.click()}>Replace image…</button>
        </div>
      )}

      {/* Gradient controls: type + preview bar + stops */}
      {mode === 'gradient' && (
        <>
          <select
            style={styles.gradTypeSelect}
            value={gradType}
            onChange={e => { const t = e.target.value as typeof gradType; setGradType(t); emitGradient(stops, t); }}
          >
            {GRADIENT_TYPES.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
          </select>
          <div
            ref={barRef}
            style={{ ...styles.gradBar, backgroundImage: `linear-gradient(90deg, ${stopsToCss(stops)})` }}
            onMouseDown={e => {
              const rect = barRef.current!.getBoundingClientRect();
              const off = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
              addStop(off);
              dragging.current = 'stop';
              e.preventDefault();
            }}
          >
            {stops.map((st, i) => (
              <span
                key={i}
                onMouseDown={e => { e.stopPropagation(); selectStop(i); dragging.current = 'stop'; e.preventDefault(); }}
                style={{
                  ...styles.stopHandle,
                  left: `${st.offset * 100}%`,
                  background: st.color,
                  outline: i === selected ? '2px solid var(--text)' : '1px solid var(--border-strong)',
                  boxShadow: i === selected ? '0 0 0 1px var(--accent)' : '0 1px 3px rgba(0,0,0,0.5)',
                }}
              />
            ))}
          </div>
          {/* Stop list */}
          <div style={styles.stopList}>
            {stops.map((st, i) => (
              <div key={i} style={{ ...styles.stopRow, ...(i === selected ? styles.stopRowActive : {}) }}
                onMouseDown={() => selectStop(i)}>
                <input style={styles.stopOffset} type="number" min={0} max={100}
                  value={Math.round(st.offset * 100)}
                  onChange={e => setStopOffset(i, Number(e.target.value))}
                  onKeyDown={e => e.stopPropagation()} />
                <span style={{ ...styles.stopSwatch, background: st.color }} />
                <span style={styles.stopHex}>{st.color.replace('#', '').toUpperCase()}</span>
                <span style={styles.stopPct}>{Math.round(st.opacity * 100)}%</span>
                <button style={styles.stopRemove} title="Remove stop"
                  onClick={ev => { ev.stopPropagation(); removeStop(i); }}
                  disabled={stops.length <= 2}>−</button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Shared SV / hue / alpha — edits the active colour (solid or selected stop) */}
      <canvas ref={svRef} width={216} height={150} style={styles.svCanvas} onMouseDown={onSVDown} />
      <canvas ref={hueRef} width={216} height={14} style={styles.slider} onMouseDown={onHueDown} />
      <canvas ref={alphaRef} width={216} height={14} style={styles.slider} onMouseDown={onAlphaDown} />

      <div style={styles.row}>
        <div style={{ ...styles.swatch, background: previewBg }} />
        <input
          style={styles.hexInput}
          value={hexInput}
          onChange={e => setHexInput(e.target.value)}
          onBlur={e => {
            const h = e.target.value.replace('#', '');
            if (/^[0-9a-fA-F]{6}$/.test(h)) {
              const [r2, g2, b2] = hexToRgb('#' + h);
              const [nh, ns, nv] = rgbToHsv(r2, g2, b2);
              setHue(nh); setSat(ns); setVal(nv);
              applyColor(nh, ns, nv, alpha);
            }
          }}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }}
          maxLength={6}
          spellCheck={false}
        />
        <input
          style={{ ...styles.hexInput, width: 42 }}
          value={Math.round(alpha * 100)}
          type="number" min={0} max={100}
          onChange={e => { const a = Math.max(0, Math.min(100, Number(e.target.value))) / 100; setAlpha(a); applyColor(hue, sat, val, a); }}
          onKeyDown={e => e.stopPropagation()}
        />
        <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>%</span>
      </div>
    </div>
  );
}

// Kept outside the styles record — a function value can't satisfy the CSSProperties
// index signature, so mixing it in breaks the whole record's type.
const modeBtnStyle = (active: boolean): React.CSSProperties => ({
  width: 34, height: 28, borderRadius: 6, cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: active ? 'var(--accent-soft)' : 'var(--bg-elevated)',
  border: active ? '1px solid var(--accent)' : '1px solid transparent',
});

const styles: Record<string, React.CSSProperties> = {
  popover: {
    position: 'fixed', width: 236,
    background: 'var(--bg-panel)', border: '1px solid var(--border-strong)',
    borderRadius: 8, padding: 12, boxShadow: 'var(--shadow-popover)',
    zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 8,
  },
  modeRow: { display: 'flex', gap: 4 },
  modeSwatch: { width: 16, height: 16, borderRadius: 4, border: '1px solid var(--border-strong)' },
  gradTypeSelect: {
    background: 'var(--bg-elevated)', border: '1px solid var(--border)',
    borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '0 8px', height: 28, outline: 'none', cursor: 'pointer',
  },
  gradBar: { position: 'relative', height: 16, borderRadius: 6, cursor: 'copy', border: '1px solid var(--border-strong)' },
  stopHandle: {
    position: 'absolute', top: '50%', width: 12, height: 12, borderRadius: '50%',
    transform: 'translate(-50%, -50%)', cursor: 'grab',
  },
  stopList: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 96, overflowY: 'auto' },
  stopRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 4px', borderRadius: 4, cursor: 'pointer' },
  stopRowActive: { background: 'var(--accent-soft)' },
  stopOffset: {
    width: 42, background: 'var(--bg-elevated)', border: '1px solid var(--border)',
    borderRadius: 4, color: 'var(--text)', fontSize: 11, padding: '0 4px', height: 24, outline: 'none',
  },
  stopSwatch: { width: 16, height: 16, borderRadius: 4, border: '1px solid var(--border-strong)', flexShrink: 0 },
  stopHex: { flex: 1, color: 'var(--text)', fontSize: 11, fontFamily: 'var(--font-mono)' },
  stopPct: { color: 'var(--text-secondary)', fontSize: 11 },
  stopRemove: {
    width: 16, height: 16, borderRadius: 4, border: 'none', background: 'transparent',
    color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, lineHeight: 1,
  },
  svCanvas: { borderRadius: 4, cursor: 'default', display: 'block' },
  slider: { borderRadius: 6, cursor: 'ew-resize', display: 'block' },
  row: { display: 'flex', alignItems: 'center', gap: 8 },
  swatch: { width: 20, height: 20, borderRadius: 4, border: '1px solid var(--border-strong)', flexShrink: 0 },
  hexInput: {
    flex: 1, background: 'var(--bg-elevated)', border: '1px solid var(--border)',
    borderRadius: 4, color: 'var(--text)', fontSize: 12, padding: '0 6px', height: 24,
    outline: 'none', fontFamily: 'var(--font-mono)',
  },
};
