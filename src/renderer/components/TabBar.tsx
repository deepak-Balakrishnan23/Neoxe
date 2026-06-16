import React, { useState } from 'react';
import { useDesignStore, Tab } from '../store/useDesignStore';
import Icon from './Icon';

// Chrome/Figma-style tab strip that lives in the centre of the top bar. Horizontally
// scrolls on overflow (never wraps); each tab is a rounded pill with a close button.
export default function TabBar() {
  const { tabs, activeTabId, setActiveTab, requestCloseTab, openNewTab } = useDesignStore();

  return (
    <div style={styles.scroller}>
      {tabs.map(tab => (
        <TabPill
          key={tab.id}
          tab={tab}
          active={tab.id === activeTabId}
          onActivate={() => setActiveTab(tab.id)}
          onClose={() => requestCloseTab(tab.id)}
        />
      ))}
      <button
        style={styles.addBtn}
        title="New tab (⌘N)"
        onClick={() => { void openNewTab(); }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-elevated)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}

function TabPill({ tab, active, onActivate, onClose }: {
  tab: Tab; active: boolean; onActivate: () => void; onClose: () => void;
}) {
  const [hover, setHover] = useState(false);
  // Close affordance: always shown on the active tab, on hover for inactive tabs.
  const showClose = active || hover;
  // When there are unsaved changes and the × is hidden, show a dirty dot instead.
  const showDot = tab.isDirty && !showClose;

  return (
    <div
      style={{
        ...styles.tab,
        background: active ? 'var(--bg-elevated-2)' : hover ? 'var(--bg-elevated)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--text-muted)',
        boxShadow: active ? '0 1px 3px rgba(0,0,0,0.35)' : 'none',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={e => { if (e.button === 0) onActivate(); }}
      title={tab.filename}
    >
      <span style={styles.label}>{tab.filename}</span>
      {showDot && <span style={styles.dot} />}
      {showClose && (
        <button
          style={styles.close}
          aria-label="Close tab"
          title="Close"
          onMouseDown={e => { e.stopPropagation(); }}
          onClick={e => { e.stopPropagation(); onClose(); }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-inset)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <Icon name="close" size={11} />
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  scroller: {
    display: 'flex', alignItems: 'center', gap: 4,
    flex: 1, minWidth: 0, overflowX: 'auto', overflowY: 'hidden',
    padding: '0 8px', height: '100%',
    // Hide the scrollbar but keep scrollability.
    scrollbarWidth: 'none',
    WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
  },
  tab: {
    display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto',
    maxWidth: 160, minWidth: 84, height: 30, padding: '0 6px 0 12px',
    borderRadius: 8, cursor: 'pointer', userSelect: 'none',
    fontFamily: 'system-ui', fontSize: 12,
  },
  label: {
    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  dot: { width: 7, height: 7, borderRadius: '50%', background: 'var(--text-secondary)', flexShrink: 0, marginRight: 3 },
  close: {
    width: 18, height: 18, borderRadius: 5, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0,
  },
  addBtn: {
    width: 28, height: 28, borderRadius: 7, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)',
    WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
  },
};
