import React from 'react';
import { useDesignStore } from '../store/useDesignStore';
import { usePrefs } from '../store/usePrefs';
import { openDesignFile } from '../io/fileIO';
import { generatePrototypeHtml } from '../../shared/prototype';
import Icon from './Icon';
import TabBar from './TabBar';
import { T } from '../theme';

export default function Toolbar() {
  const {
    file, activePage, setExportOpen, activeTabId, tabs,
    openFileInNewTab, saveTab, showToast,
  } = useDesignStore();
  const { setPrefsOpen, leftPanelCollapsed, set: setPrefs } = usePrefs();

  // Save is only enabled when the active document has unsaved changes (Figma-style).
  const canSave = !!tabs.find(t => t.id === activeTabId)?.isDirty;

  const handlePresent = () => {
    const page = activePage();
    if (!file || !page) return;
    // Only top-level FRAMES become screens (Figma model) — with none, the generated
    // HTML is an empty shell that opens as a blank tab with zero explanation. This is
    // the most prominent Present entry point (visible on every tab), so it needs the
    // same guard as the Prototype panel's own Present/Export HTML buttons.
    const hasFrame = page.childIds.some(id => page.objects[id]?.type === 'frame');
    if (!hasFrame) { showToast('Add a frame before presenting: content outside a frame can’t be shown'); return; }
    const html = generatePrototypeHtml(file, page);
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    window.open(url, '_blank');
  };

  // Open creates its own tab (New lives on the tab bar's + button).
  const handleOpen = async () => {
    try {
      const opened = await openDesignFile();
      if (opened) await openFileInNewTab(opened);
    } catch (e) {
      alert('Open failed: ' + (e as Error).message);
    }
  };
  const handleSave = async () => {
    if (!activeTabId || !canSave) return;
    const res = await saveTab(activeTabId);
    if (res.saved) showToast(res.firstSave ? 'Saved' : 'Latest changes updated');
  };

  return (
    <div style={styles.toolbar}>
      <div style={styles.left}>
        <span style={styles.logo}><Icon name="logo" size={18} color={T.accent} /> Neouxe</span>
        <Sep />
        <IconBtn
          onClick={() => setPrefs({ leftPanelCollapsed: !leftPanelCollapsed })}
          title={leftPanelCollapsed ? 'Show left panel (⌘\\)' : 'Hide left panel (⌘\\)'}
        ><Icon name="panel-left" size={17} color={leftPanelCollapsed ? undefined : T.accent} /></IconBtn>
        <Sep />
        <IconBtn onClick={handleOpen} title="Open (⌘O)"><Icon name="folder-open" size={17} /></IconBtn>
        <IconBtn onClick={handleSave} title={canSave ? 'Save (⌘S)' : 'No changes to save'} disabled={!canSave}><Icon name="save" size={17} /></IconBtn>
      </div>

      <div style={styles.center}>
        <TabBar />
      </div>

      <div style={styles.right}>
        <IconBtn title="Settings (⌘,)" onClick={() => setPrefsOpen(true)}><Icon name="settings" size={17} /></IconBtn>
        <Sep />
        <button onClick={handlePresent} title="Present prototype" style={styles.presentBtn}>
          <Icon name="play" size={14} /> Present
        </button>
        <button onClick={() => setExportOpen(true)} title="Export (⇧⌘E)" style={styles.exportBtn}>
          <Icon name="export" size={14} color="#fff" /> Export
        </button>
      </div>
    </div>
  );
}

function IconBtn({ children, title, onClick, disabled }: {
  children: React.ReactNode; title?: string; onClick?: () => void; disabled?: boolean;
}) {
  const [h, setH] = React.useState(false);
  return (
    <button onClick={disabled ? undefined : onClick} title={title} disabled={disabled}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        ...styles.iconBtn,
        background: !disabled && h ? T.bgElevated : 'transparent',
        color: disabled ? T.textMuted : h ? T.text : T.textSecondary,
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}>
      {children}
    </button>
  );
}

function Sep() { return <div style={styles.sep} />; }


const styles: Record<string, React.CSSProperties> = {
  toolbar: {
    height: 48, background: T.bgApp, borderBottom: `1px solid ${T.border}`,
    display: 'flex', alignItems: 'center', padding: '0 12px', gap: 8, flexShrink: 0,
  },
  left: { display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto' },
  center: { display: 'flex', alignItems: 'center', flex: '1 1 0', minWidth: 0, height: '100%' },
  right: { display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto', justifyContent: 'flex-end' },
  logo: {
    display: 'flex', alignItems: 'center', gap: 8, color: T.text, fontWeight: 700, fontSize: 16,
    fontFamily: T.font, letterSpacing: '-0.3px', marginRight: 8,
  },
  iconBtn: {
    border: 'none', width: 32, height: 32, borderRadius: T.rMd, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'background .12s, color .12s',
  },
  sep: { width: 1, height: 20, background: T.border, margin: '0 5px' },
  exportBtn: {
    display: 'flex', alignItems: 'center', gap: 8, background: T.accent, border: 'none', color: '#fff',
    fontSize: 13, padding: '8px 16px', borderRadius: T.rMd, cursor: 'pointer',
    fontFamily: T.font, fontWeight: 600,
  },
  presentBtn: {
    display: 'flex', alignItems: 'center', gap: 8, background: T.bgElevated, border: 'none', color: T.text,
    fontSize: 13, padding: '8px 12px', borderRadius: T.rMd, cursor: 'pointer',
    fontFamily: T.font, fontWeight: 500,
  },
};
