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
import { makeDefaultShape, Page, Shape } from '../shared/types';
import {
  scheduleAutosave, hasRecoverableSession, clearAutosave,
  markSavePoint, addRecent, getRecents, RecentFile,
} from './persistence';
import { DesignFile } from '../shared/types';

export default function App() {
  const {
    setFile, file, setExportOpen, selectedIds, setSelectedIds, activePage, clearSelection,
    initFirstTab, openNewTab, openFileInNewTab, saveTab, activeTabId, showToast,
  } = useDesignStore();
  const { autosaveInterval, setPrefsOpen, theme, leftPanelCollapsed } = usePrefs();
  const [recovery, setRecovery] = useState<DesignFile | null>(null);
  const bootstrapped = useRef(false);
  const clipboard = useRef<{ rootIds: string[]; shapes: Shape[] } | null>(null);

  // ── Apply saved theme on load ──────────────────────────────────────────────
  useEffect(() => { setThemeMode(theme); }, [theme]);

  // ── Bootstrap: check for crash recovery, else load sample ──────────────────
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    const recoverable = hasRecoverableSession();
    if (recoverable) {
      setRecovery(recoverable.file);
    }
    // The launch document becomes the first tab.
    api.newFile().then(res => {
      if (res.ok && res.data) initFirstTab(res.data);
    });
  }, [initFirstTab]);

  // ── Autosave on every file change ──────────────────────────────────────────
  useEffect(() => {
    if (file) scheduleAutosave(file, autosaveInterval);
  }, [file, autosaveInterval]);

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
          if (file) { markSavePoint(file.id); addRecent(file); }
          showToast(res.firstSave ? 'Saved' : 'Latest changes updated');
        }
      }
      return;
    }
    if (meta && e.key === 'o') {
      e.preventDefault();
      try {
        const opened = await openDesignFile();
        if (opened) {
          await openFileInNewTab(opened);
          addRecent(opened);
        }
      } catch (err) {
        alert('Open failed: ' + (err as Error).message);
      }
      return;
    }
    if (meta && e.key === 'e') {
      e.preventDefault();
      setExportOpen(true);
      return;
    }
    if (meta && e.key === ',') {
      e.preventDefault();
      setPrefsOpen(true);
      return;
    }

    // Shortcuts below need an active page + don't fire while typing
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (typing) return;
    const page = activePage();
    if (!page) return;
    const sel = [...selectedIds];

    // ⌘A — select all root shapes
    if (meta && e.key === 'a') {
      e.preventDefault();
      setSelectedIds(page.childIds.slice());
      return;
    }

    // ⌘C / ⌘X — copy / cut selection to in-memory clipboard
    if (meta && (e.key === 'c' || e.key === 'x') && sel.length) {
      e.preventDefault();
      const rootIds = topLevelSelection(page, sel);
      clipboard.current = {
        rootIds,
        shapes: collectSubtree(page, rootIds).map(shape => structuredClone(shape)),
      };
      if (e.key === 'x') {
        const res = await api.applyChanges({ pageId: page.id, ops: rootIds.map(id => ({ op: 'del' as const, id })) });
        if (res.ok && res.data) { setFile(res.data); clearSelection(); }
      }
      return;
    }

    // ⌘V — paste clipboard (offset by 16px)
    if (meta && e.key === 'v' && clipboard.current?.shapes.length) {
      e.preventDefault();
      const { ops, rootIds } = cloneShapesForInsert(page, clipboard.current.rootIds, clipboard.current.shapes, 16, 16);
      const res = await api.applyChanges({ pageId: page.id, ops });
      if (res.ok && res.data) { setFile(res.data); setSelectedIds(rootIds); }
      return;
    }

    // ⌘D — duplicate in place (+16,+16)
    if (meta && e.key === 'd' && sel.length) {
      e.preventDefault();
      const rootSourceIds = topLevelSelection(page, sel);
      const sourceShapes = collectSubtree(page, rootSourceIds).map(shape => structuredClone(shape));
      const { ops, rootIds } = cloneShapesForInsert(page, rootSourceIds, sourceShapes, 16, 16);
      const res = await api.applyChanges({ pageId: page.id, ops });
      if (res.ok && res.data) { setFile(res.data); setSelectedIds(rootIds); }
      return;
    }

    // [ / ] — send backward / bring forward ; ⌘[ / ⌘] — to back / to front
    if ((e.key === '[' || e.key === ']') && sel.length) {
      e.preventDefault();
      const id = sel[0];
      const shape = page.objects[id];
      const siblings = shape.parentId ? (page.objects[shape.parentId]?.childIds ?? []) : page.childIds;
      const cur = siblings.indexOf(id);
      let target: number;
      if (e.key === ']') target = meta ? siblings.length - 1 : Math.min(siblings.length - 1, cur + 1);
      else target = meta ? 0 : Math.max(0, cur - 1);
      const res = await api.applyChanges({ pageId: page.id, ops: [{ op: 'move', id, parentId: shape.parentId, index: target }] });
      if (res.ok && res.data) setFile(res.data);
      return;
    }
  }, [setFile, setExportOpen, setPrefsOpen, file, activePage, selectedIds, setSelectedIds, clearSelection,
      openNewTab, openFileInNewTab, saveTab, activeTabId, showToast]);

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  return (
    <div style={styles.root}>
      {recovery && (
        <RecoveryBanner
          file={recovery}
          onRecover={() => { void openFileInNewTab(recovery); setRecovery(null); }}
          onDismiss={() => { clearAutosave(); setRecovery(null); }}
        />
      )}

      <Toolbar />
      <div style={styles.workspace}>
        {!leftPanelCollapsed && <LayersPanel />}
        <div style={styles.canvasWrap}>
          <Canvas />
          <FloatingToolbar />
        </div>
        <PropertiesPanel />
      </div>
      {!file && <SplashOverlay />}
      <ExportDialog />
      <PreferencesDialog />
      <UnsavedWarningModal />
      <Toast />
    </div>
  );
}

// ── Recovery banner ───────────────────────────────────────────────────────────

function RecoveryBanner({ file, onRecover, onDismiss }: {
  file: DesignFile; onRecover: () => void; onDismiss: () => void;
}) {
  return (
    <div style={styles.recovery}>
      <span style={styles.recoveryText}>
        ⚠ Unsaved changes from a previous session were recovered — "{file.name}"
      </span>
      <button style={styles.recoveryBtn} onClick={onRecover}>Restore</button>
      <button style={styles.recoveryDismiss} onClick={onDismiss}>Discard</button>
    </div>
  );
}

// ── Splash with recent files ────────────────────────────────────────────────

function SplashOverlay() {
  const { openNewTab, openFileInNewTab } = useDesignStore();
  const [recents] = useState<RecentFile[]>(() => getRecents());

  const handleOpen = async () => {
    try {
      const opened = await openDesignFile();
      if (opened) await openFileInNewTab(opened);
    } catch (e) {
      alert('Open failed: ' + (e as Error).message);
    }
  };

  return (
    <div style={styles.splash}>
      <div style={styles.splashCard}>
        <div style={styles.splashLogo}>✦ Neouxe</div>
        <div style={styles.splashSub}>A local-first design tool</div>
        <button style={styles.splashBtn} onClick={() => { void openNewTab(); }}>
          New File
        </button>
        <button style={{ ...styles.splashBtn, background: 'rgba(255,255,255,0.05)' }} onClick={handleOpen}>
          Open File…
        </button>
        {recents.length > 0 && (
          <div style={styles.recents}>
            <div style={styles.recentsHeader}>Recent</div>
            {recents.slice(0, 5).map(r => (
              <div key={r.id} style={styles.recentRow} onClick={() => { void openFileInNewTab(r.file); }}>
                <span style={styles.recentName}>{r.name}</span>
                <span style={styles.recentTime}>{new Date(r.timestamp).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function topLevelSelection(page: Page, ids: string[]): string[] {
  const selected = new Set(ids);
  return ids.filter(id => {
    let parentId = page.objects[id]?.parentId ?? null;
    while (parentId) {
      if (selected.has(parentId)) return false;
      parentId = page.objects[parentId]?.parentId ?? null;
    }
    return true;
  });
}

function collectSubtree(page: Page, rootIds: string[]): Shape[] {
  const out: Shape[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    const shape = page.objects[id];
    if (!shape || seen.has(id)) return;
    seen.add(id);
    out.push(shape);
    for (const childId of shape.childIds) visit(childId);
  };
  rootIds.forEach(visit);
  return out;
}

function cloneShapesForInsert(
  page: Page,
  sourceRootIds: string[],
  sourceShapes: Shape[],
  offsetX: number,
  offsetY: number,
): { ops: Parameters<typeof api.applyChanges>[0]['ops']; rootIds: string[] } {
  const idMap = new Map(sourceShapes.map(shape => [shape.id, Math.random().toString(36).slice(2, 10)]));
  const newRootIds = sourceRootIds.map(id => idMap.get(id)).filter((id): id is string => !!id);
  const ops = sourceShapes.map(orig => {
    const id = idMap.get(orig.id)!;
    const parentId = orig.parentId && idMap.has(orig.parentId)
      ? idMap.get(orig.parentId)!
      : orig.parentId && page.objects[orig.parentId]
        ? orig.parentId
        : null;
    const frameId = orig.type === 'frame'
      ? id
      : idMap.get(orig.frameId) ?? (page.objects[orig.frameId] ? orig.frameId : page.id);
    const x = orig.x + offsetX;
    const y = orig.y + offsetY;
    const copy = makeDefaultShape({
      ...structuredClone(orig),
      id,
      parentId,
      frameId,
      x,
      y,
      childIds: orig.childIds.map(childId => idMap.get(childId)).filter((childId): childId is string => !!childId),
      selrect: { x, y, width: orig.width, height: orig.height },
    });
    return { op: 'add' as const, shape: copy };
  });
  return { ops, rootIds: newRootIds };
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', background: 'var(--bg-panel)', overflow: 'hidden' },
  workspace: { display: 'flex', flex: 1, overflow: 'hidden' },
  canvasWrap: { flex: 1, position: 'relative', display: 'flex', overflow: 'hidden' },
  recovery: {
    position: 'fixed', top: 0, left: 0, right: 0, zIndex: 300,
    background: '#45403a', borderBottom: '1px solid rgba(245,197,66,0.4)',
    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px',
    fontFamily: 'system-ui', fontSize: 13,
  },
  recoveryText: { color: '#F5C542', flex: 1 },
  recoveryBtn: { background: '#6E72F5', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 14px', fontSize: 12, cursor: 'pointer' },
  recoveryDismiss: { background: 'transparent', color: '#C8C8D0', border: 'none', padding: '5px 10px', fontSize: 12, cursor: 'pointer' },
  splash: {
    position: 'fixed', inset: 0, background: 'rgba(8,8,10,0.8)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, backdropFilter: 'blur(8px)',
  },
  splashCard: {
    background: '#1b1b1f', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16,
    padding: '40px 48px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, minWidth: 300,
  },
  splashLogo: { fontSize: 36, fontWeight: 800, color: '#8084FF', fontFamily: 'system-ui', letterSpacing: '-1px' },
  splashSub: { fontSize: 14, color: '#9B9BA6', fontFamily: 'system-ui', marginBottom: 8 },
  splashBtn: {
    background: '#6E72F5', color: '#fff', border: 'none', borderRadius: 8,
    padding: '10px 24px', fontSize: 14, fontFamily: 'system-ui', cursor: 'pointer', width: '100%', fontWeight: 500,
  },
  recents: { width: '100%', marginTop: 8, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 12 },
  recentsHeader: { fontSize: 10, color: '#9B9BA6', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, fontFamily: 'system-ui' },
  recentRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontFamily: 'system-ui',
  },
  recentName: { color: '#ECECEF', fontSize: 13 },
  recentTime: { color: '#9B9BA6', fontSize: 11 },
};
