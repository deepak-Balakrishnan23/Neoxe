import React, { useEffect, useCallback, useState, useRef } from 'react';
import Toolbar from './components/Toolbar';
import Canvas from './components/Canvas';
import LayersPanel from './components/LayersPanel';
import PropertiesPanel from './components/PropertiesPanel';
import ExportDialog from './components/ExportDialog';
import PreferencesDialog from './components/PreferencesDialog';
import FloatingToolbar from './components/FloatingToolbar';
import UnsavedWarningModal from './components/UnsavedWarningModal';
import Toast from './components/Toast';
import { useDesignStore } from './store/useDesignStore';
import { usePrefs } from './store/usePrefs';
import { setThemeMode } from './theme';
import { api } from './ipc/api';
import { openDesignFile } from './io/fileIO';
import {
  scheduleAutosave, flushAutosave, getRecoverableSessions, clearAutosave,
} from './persistence';
import { DesignFile } from '../shared/types';

export default function App() {
  const {
    setFile, file, setExportOpen, activePage,
    openNewTab, openFileInNewTab, saveTab, activeTabId, tabs, showToast,
  } = useDesignStore();
  const { autosaveInterval, setPrefsOpen, theme, leftPanelCollapsed } = usePrefs();
  const [recoverySessions, setRecoverySessions] = useState<DesignFile[]>([]);
  const bootstrapped = useRef(false);

  // ── Apply saved theme on load ──────────────────────────────────────────────
  useEffect(() => { setThemeMode(theme); }, [theme]);

  // ── Bootstrap: check for crash recovery only ───────────────────────────────
  // No file is created on launch — `file` stays null so the landing page shows.
  // The user enters the editor by creating, opening, or recovering a file.
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    const sessions = getRecoverableSessions();
    if (sessions.length > 0) setRecoverySessions(sessions.map(s => s.file));
  }, []);

  // ── Autosave EVERY dirty tab (not just the active one) ─────────────────────
  // The active tab's live doc is `file`; inactive tabs' docs live in their parked session.
  // Debounced, so a burst of edits collapses to one write once you pause. Save-points keep
  // saved files out of recovery, so this never leaves a nagging banner behind.
  useEffect(() => {
    const dirtyFiles: DesignFile[] = [];
    for (const t of tabs) {
      if (!t.isDirty) continue;
      const f = t.id === activeTabId ? file : t.session?.file ?? null;
      if (f) dirtyFiles.push(f);
    }
    if (dirtyFiles.length > 0) scheduleAutosave(dirtyFiles, autosaveInterval);
  }, [file, autosaveInterval, tabs, activeTabId]);

  // ── Global keyboard shortcuts ──────────────────────────────────────────────
  const onKeyDown = useCallback(async (e: KeyboardEvent) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && !e.shiftKey && e.key === 'z') {
      e.preventDefault();
      const res = await api.undo();
      if (res.ok && res.data) setFile(res.data);
      return;
    }
    if ((meta && e.shiftKey && e.key === 'z') || (meta && e.key === 'y')) {
      e.preventDefault();
      const res = await api.redo();
      if (res.ok && res.data) setFile(res.data);
      return;
    }
    if (meta && !e.shiftKey && e.key === 'n') {
      e.preventDefault();
      void openNewTab();
      return;
    }
    if (meta && e.key === 's') {
      e.preventDefault();
      const isDirty = !!useDesignStore.getState().tabs.find(t => t.id === activeTabId)?.isDirty;
      if (activeTabId && isDirty) {
        const res = await saveTab(activeTabId);
        if (res.saved) {
          // saveTab handles persistence side-effects (save point + autosave clear).
          showToast(res.firstSave ? 'Saved' : 'Latest changes updated');
        }
      }
      return;
    }
    if (meta && e.key === 'o') {
      e.preventDefault();
      try {
        const opened = await openDesignFile();
        if (opened) await openFileInNewTab(opened);
      } catch (err) {
        alert('Open failed: ' + (err as Error).message);
      }
      return;
    }
    // Figma binds ⇧⌘E to Export and leaves ⌘E for Flatten (handled on the canvas).
    if (meta && e.shiftKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      setExportOpen(true);
      return;
    }
    if (meta && e.key === ',') {
      e.preventDefault();
      setPrefsOpen(true);
      return;
    }

    // NOTE: selection/clipboard/z-order shortcuts (⌘A ⌘C ⌘X ⌘V ⌘D [ ]) are owned
    // exclusively by Canvas.tsx's keydown handler. They used to be duplicated here,
    // which made every one of those shortcuts fire twice (e.g. ⌘D produced two clones).
  }, [setExportOpen, setPrefsOpen, file, activePage,
      openNewTab, openFileInNewTab, saveTab, activeTabId, showToast]);

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  // ── Flush latest edits on exit ─────────────────────────────────────────────
  // On any close/reload/navigation, synchronously persist the newest state of every dirty
  // tab so a plain refresh doesn't lose work. We do NOT clear here — whether recovery is
  // offered is decided by save-points (a saved file won't reappear), not by whether the
  // app happened to exit cleanly. This is what makes a normal refresh recoverable.
  useEffect(() => {
    const onBeforeUnload = () => {
      const st = useDesignStore.getState();
      const dirtyFiles: DesignFile[] = [];
      for (const t of st.tabs) {
        if (!t.isDirty) continue;
        const f = t.id === st.activeTabId ? st.file : t.session?.file ?? null;
        if (f) dirtyFiles.push(f);
      }
      flushAutosave(dirtyFiles);
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // No document open → show the landing / start page instead of the editor.
  if (!file) {
    return (
      <LandingPage
        recoverySessions={recoverySessions}
        onRecover={async () => { for (const f of recoverySessions) await openFileInNewTab(f); setRecoverySessions([]); }}
        onDiscardRecovery={() => { recoverySessions.forEach(f => clearAutosave(f.id)); setRecoverySessions([]); }}
      />
    );
  }

  return (
    <div style={styles.root}>
      <Toolbar />
      <div style={styles.workspace}>
        {!leftPanelCollapsed && <LayersPanel />}
        <div style={styles.canvasWrap}>
          <Canvas />
          <FloatingToolbar />
        </div>
        <PropertiesPanel />
      </div>
      <ExportDialog />
      <PreferencesDialog />
      <UnsavedWarningModal />
      <Toast />
    </div>
  );
}

// ── Landing / start page ──────────────────────────────────────────────────────
// Shown whenever no document is open (i.e. on launch). The editor is only mounted
// once the user creates, opens, or recovers a file.

function LandingPage({ recoverySessions, onRecover, onDiscardRecovery }: {
  recoverySessions: DesignFile[];
  onRecover: () => void;
  onDiscardRecovery: () => void;
}) {
  const { openNewTab, openFileInNewTab } = useDesignStore();

  const handleOpen = async () => {
    try {
      const opened = await openDesignFile();
      if (opened) await openFileInNewTab(opened);
    } catch (e) {
      alert('Open failed: ' + (e as Error).message);
    }
  };

  return (
    <div style={styles.landing}>
      {recoverySessions.length > 0 && (
        <div style={styles.recovery}>
          <span style={styles.recoveryText}>
            {recoverySessions.length === 1
              ? `⚠ Unsaved changes from your last session: "${recoverySessions[0].name}"`
              : `⚠ ${recoverySessions.length} unsaved sessions from your last session`}
          </span>
          <button style={styles.recoveryBtn} onClick={onRecover}>
            {recoverySessions.length === 1 ? 'Restore' : 'Restore all'}
          </button>
          <button style={styles.recoveryDismiss} onClick={onDiscardRecovery}>Discard</button>
        </div>
      )}

      <div style={styles.landingInner}>
        <div style={styles.landingHeader}>
          <div style={styles.landingLogo}>✦ Neouxe</div>
          <div style={styles.landingSub}>A local-first design tool</div>
        </div>

        <div style={styles.landingActions}>
          <button style={styles.actionCard} onClick={() => { void openNewTab(); }}>
            <span style={styles.actionPlus}>+</span>
            <span style={styles.actionTitle}>New design</span>
            <span style={styles.actionDesc}>Start with a blank canvas</span>
          </button>
          <button style={{ ...styles.actionCard, ...styles.actionCardGhost }} onClick={handleOpen}>
            <span style={styles.actionPlus}>↥</span>
            <span style={styles.actionTitle}>Open file…</span>
            <span style={styles.actionDesc}>Open a .design file from disk</span>
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', background: 'var(--bg-panel)', overflow: 'hidden' },
  workspace: { display: 'flex', flex: 1, overflow: 'hidden' },
  canvasWrap: { flex: 1, position: 'relative', display: 'flex', overflow: 'hidden' },
  recovery: {
    position: 'fixed', top: 0, left: 0, right: 0, zIndex: 300,
    background: 'var(--bg-elevated)', borderBottom: '1px solid var(--comment)',
    display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px',
    fontFamily: 'var(--font-ui)', fontSize: 13,
  },
  recoveryText: { color: 'var(--comment)', flex: 1 },
  recoveryBtn: { background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 16px', fontSize: 12, cursor: 'pointer' },
  recoveryDismiss: { background: 'transparent', color: 'var(--text-secondary)', border: 'none', padding: '4px 10px', fontSize: 12, cursor: 'pointer' },

  // ── Landing page ────────────────────────────────────────────────────────────
  landing: {
    position: 'fixed', inset: 0, background: 'var(--bg-canvas)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'var(--font-ui)', overflow: 'auto',
  },
  landingInner: { width: '100%', maxWidth: 720, padding: '32px 24px', display: 'flex', flexDirection: 'column', gap: 32 },
  landingHeader: { textAlign: 'center' },
  landingLogo: { fontSize: 44, fontWeight: 800, color: 'var(--accent-hover)', letterSpacing: '-1.5px' },
  landingSub: { fontSize: 16, color: 'var(--text-secondary)', marginTop: 8 },
  landingActions: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 },
  actionCard: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, textAlign: 'left',
    background: 'var(--accent)', color: '#fff', border: '1px solid transparent', borderRadius: 12,
    padding: '22px 24px', cursor: 'pointer', fontFamily: 'var(--font-ui)',
  },
  actionCardGhost: { background: 'var(--bg-elevated)', color: 'var(--text)', border: '1px solid var(--border-strong)' },
  actionPlus: { fontSize: 26, fontWeight: 700, lineHeight: 1, marginBottom: 4 },
  actionTitle: { fontSize: 16, fontWeight: 600 },
  actionDesc: { fontSize: 12, opacity: 0.8 },
};
