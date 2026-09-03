import React, { useState } from 'react';
import { useDesignStore } from '../store/useDesignStore';
import { cancelAutosave, clearAutosave } from '../persistence';

// Shown when a tab with unsaved changes is closed. Save / Don't Save / Cancel.
// Styled to match the existing dialog chrome (ExportDialog / PreferencesDialog).
export default function UnsavedWarningModal() {
  const { pendingCloseTabId, tabs, closeTab, saveTab, showToast, set } = useStoreSlice();
  const [busy, setBusy] = useState(false);

  // Escape = Cancel (the non-destructive choice) so the confirm is keyboard-dismissable.
  // Effect runs before the early return (rules of hooks); no-ops while closed.
  React.useEffect(() => {
    if (!pendingCloseTabId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') set({ pendingCloseTabId: null }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingCloseTabId, set]);

  if (!pendingCloseTabId) return null;
  const tab = tabs.find(t => t.id === pendingCloseTabId);
  if (!tab) return null;

  const onSave = async () => {
    setBusy(true);
    try {
      const res = await saveTab(tab.id);
      if (res.saved) {
        showToast(res.firstSave ? 'Saved' : 'Latest changes updated');
        await closeTab(tab.id);
      } else {
        // Save dialog was cancelled — dismiss the modal, leave the tab open.
        set({ pendingCloseTabId: null });
      }
    } finally {
      setBusy(false);
    }
  };
  const onDontSave = () => {
    // The user explicitly discarded this document's changes — drop its autosave so the
    // next launch doesn't offer to "recover" work they chose to throw away (Figma-style).
    const fileId = useDesignStore.getState().activeTabId === tab.id
      ? useDesignStore.getState().file?.id
      : tab.session?.file?.id;
    if (fileId) { cancelAutosave(); clearAutosave(fileId); }
    void closeTab(tab.id);
  };
  const onCancel = () => set({ pendingCloseTabId: null });

  return (
    <div style={s.overlay} onMouseDown={onCancel}>
      <div style={s.dialog} onMouseDown={e => e.stopPropagation()}>
        <div style={s.title}>Unsaved changes</div>
        <div style={s.body}>Save changes to “{tab.filename}” before closing?</div>
        <div style={s.actions}>
          <button style={s.dontSave} onClick={onDontSave} disabled={busy}>Don’t Save</button>
          <div style={{ flex: 1 }} />
          <button style={s.cancel} onClick={onCancel} disabled={busy}>Cancel</button>
          <button style={s.primary} onClick={onSave} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

// Small typed accessor so we can also reach the raw `set` for clearing pendingCloseTabId.
function useStoreSlice() {
  const pendingCloseTabId = useDesignStore(st => st.pendingCloseTabId);
  const tabs = useDesignStore(st => st.tabs);
  const closeTab = useDesignStore(st => st.closeTab);
  const saveTab = useDesignStore(st => st.saveTab);
  const showToast = useDesignStore(st => st.showToast);
  const set = useDesignStore.setState;
  return { pendingCloseTabId, tabs, closeTab, saveTab, showToast, set };
}

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(17,17,27,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 600, backdropFilter: 'blur(4px)', fontFamily: 'var(--font-ui)',
  },
  dialog: {
    background: 'var(--bg-panel)', border: '1px solid var(--border-strong)',
    borderRadius: 12, padding: 20, width: 360, display: 'flex', flexDirection: 'column', gap: 12,
    boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
  },
  title: { fontSize: 16, fontWeight: 700, color: 'var(--text)' },
  body: { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 },
  actions: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 },
  dontSave: {
    background: 'transparent', border: '1px solid var(--border-strong)',
    color: 'var(--text-secondary)', fontSize: 13, padding: '8px 12px', borderRadius: 6, cursor: 'pointer',
  },
  cancel: {
    background: 'var(--border)', border: 'none',
    color: 'var(--text)', fontSize: 13, padding: '8px 16px', borderRadius: 6, cursor: 'pointer',
  },
  primary: {
    background: 'var(--accent)', border: 'none',
    color: '#fff', fontSize: 13, padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontWeight: 600,
  },
};
