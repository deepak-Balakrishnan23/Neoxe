import React from 'react';
import { usePrefs } from '../store/usePrefs';
import { setThemeMode, T } from '../theme';
import Icon from './Icon';

export default function PreferencesDialog() {
  const prefs = usePrefs();
  if (!prefs.prefsOpen) return null;

  return (
    <div style={s.overlay} onMouseDown={() => prefs.setPrefsOpen(false)}>
      <div style={s.dialog} onMouseDown={e => e.stopPropagation()}>
        <div style={s.title}>Settings</div>

        <div style={s.groupLabel}>Appearance</div>
        <Field label="Theme">
          <div style={s.seg}>
            <button
              style={{ ...s.segBtn, ...(prefs.theme === 'light' ? s.segActive : {}) }}
              onClick={() => { prefs.set({ theme: 'light' }); setThemeMode('light'); }}>
              <Icon name="sun" size={14} /> Light
            </button>
            <button
              style={{ ...s.segBtn, ...(prefs.theme === 'dark' ? s.segActive : {}) }}
              onClick={() => { prefs.set({ theme: 'dark' }); setThemeMode('dark'); }}>
              <Icon name="moon" size={14} /> Dark
            </button>
          </div>
        </Field>

        <div style={s.groupLabel}>Canvas</div>
        <Field label="Autosave interval">
          <select style={s.select} value={prefs.autosaveInterval}
            onChange={e => prefs.set({ autosaveInterval: Number(e.target.value) })}>
            <option value={1000}>1 second</option>
            <option value={2000}>2 seconds</option>
            <option value={5000}>5 seconds</option>
            <option value={10000}>10 seconds</option>
          </select>
        </Field>

        <Field label="Snap to grid">
          <Toggle on={prefs.snapToGrid} onChange={v => prefs.set({ snapToGrid: v })} />
        </Field>

        <Field label="Show grid">
          <Toggle on={prefs.showGrid} onChange={v => prefs.set({ showGrid: v })} />
        </Field>

        <Field label="Grid size">
          <input style={s.num} type="number" min={2} max={100} value={prefs.gridSize}
            onChange={e => prefs.set({ gridSize: Number(e.target.value) })} />
        </Field>

        <div style={s.actions}>
          <button style={s.primary} onClick={() => prefs.setPrefsOpen(false)}>Done</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={s.field}>
      <span style={s.label}>{label}</span>
      {children}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button style={{ ...s.toggle, ...(on ? s.toggleOn : {}) }} onClick={() => onChange(!on)}>
      <span style={{ ...s.knob, transform: on ? 'translateX(16px)' : 'translateX(0)' }} />
    </button>
  );
}

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 600, backdropFilter: 'blur(4px)', fontFamily: T.font,
  },
  dialog: {
    background: T.bgPanel, border: `1px solid ${T.borderStrong}`,
    borderRadius: 14, padding: 20, width: 340, display: 'flex', flexDirection: 'column', gap: 12,
    boxShadow: T.shadowDialog,
  },
  title: { fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 2 },
  groupLabel: {
    fontSize: 10, fontWeight: 600, color: T.textMuted, textTransform: 'uppercase',
    letterSpacing: '0.06em', marginTop: 6, marginBottom: 2,
  },
  field: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  label: { fontSize: 13, color: T.textSecondary },
  seg: { display: 'flex', gap: 4, background: T.bgElevated, borderRadius: 8, padding: 3 },
  segBtn: {
    display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none',
    color: T.textSecondary, fontSize: 12, padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontFamily: T.font,
  },
  segActive: { background: T.accent, color: '#fff' },
  select: {
    background: T.bgElevated, border: `1px solid ${T.border}`,
    borderRadius: 6, color: T.text, fontSize: 12, padding: '4px 8px', outline: 'none', cursor: 'pointer',
  },
  num: {
    width: 60, background: T.bgElevated, border: `1px solid ${T.border}`,
    borderRadius: 6, color: T.text, fontSize: 12, padding: '4px 8px', outline: 'none',
  },
  toggle: {
    width: 36, height: 20, borderRadius: 10, background: T.bgElevated2,
    border: 'none', cursor: 'pointer', padding: 2, position: 'relative', transition: 'background .15s',
  },
  toggleOn: { background: T.accent },
  knob: {
    display: 'block', width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'transform .15s',
  },
  actions: { marginTop: 8 },
  primary: {
    width: '100%', background: '#6E72F5', border: 'none', color: '#fff',
    fontSize: 13, padding: '8px', borderRadius: 6, cursor: 'pointer', fontWeight: 500,
  },
};
