import React, { useState, useRef, useEffect } from 'react';
import { useDesignStore, Tab } from '../store/useDesignStore';
import Icon from './Icon';

// Chrome/Figma-style tab strip that lives in the centre of the top bar. Horizontally
// scrolls on overflow (never wraps); each tab is a rounded pill with a close button.
export default function TabBar() {
  const { tabs, activeTabId, setActiveTab, requestCloseTab, openNewTab, renameTab } = useDesignStore();

  return (
    <div style={styles.scroller}>
      {tabs.map(tab => (
        <TabPill
          key={tab.id}
          tab={tab}
          active={tab.id === activeTabId}
          onActivate={() => setActiveTab(tab.id)}
          onClose={() => requestCloseTab(tab.id)}
          onRename={(name) => { void renameTab(tab.id, name); }}
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

function TabPill({ tab, active, onActivate, onClose, onRename }: {
  tab: Tab; active: boolean; onActivate: () => void; onClose: () => void; onRename: (name: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.filename);
  const inputRef = useRef<HTMLInputElement>(null);
  // Refs guard against the Enter→blur double-commit and the Escape (cancel) path.
  const editingRef = useRef(false);
  const cancelledRef = useRef(false);

  // Close affordance: always shown on the active tab, on hover for inactive tabs.
  const showClose = (active || hover) && !editing;
  // When there are unsaved changes and the × is hidden, show a dirty dot instead.
  const showDot = tab.isDirty && !showClose && !editing;

  useEffect(() => {
    if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editing]);

  // Commit on any click outside the input. The canvas/toolbar call preventDefault on
  // mousedown (keeping their own focus), so the input never blurs — we can't rely on
  // onBlur alone. Capture-phase listener runs before those handlers swallow the event.
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: MouseEvent) => {
      if (inputRef.current && !inputRef.current.contains(e.target as Node)) finish();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const begin = () => { cancelledRef.current = false; setDraft(tab.filename); setEditing(true); editingRef.current = true; };
  const finish = () => {
    if (!editingRef.current) return;            // already committed (e.g. Enter then blur)
    editingRef.current = false;
    setEditing(false);
    if (cancelledRef.current) { setDraft(tab.filename); return; }   // Escape → revert
    onRename(inputRef.current?.value ?? draft);  // read live value; store trims + 'Untitled' fallback
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelledRef.current = true; finish(); }
  };

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
      onMouseDown={e => { if (e.button === 0 && !editing) onActivate(); }}
      title={tab.filename}
    >
      {editing ? (
        <input
          ref={inputRef}
          style={styles.input}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={finish}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        />
      ) : (
        <span style={styles.label} onDoubleClick={e => { e.stopPropagation(); begin(); }}>{tab.filename}</span>
      )}
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
  },
  tab: {
    display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto',
    maxWidth: 160, minWidth: 84, height: 28, padding: '0 6px 0 12px',
    borderRadius: 8, cursor: 'pointer', userSelect: 'none',
    fontFamily: 'var(--font-ui)', fontSize: 12,
  },
  label: {
    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  input: {
    flex: 1, minWidth: 0, width: '100%',
    background: 'var(--bg-inset)', border: '1px solid var(--accent)', borderRadius: 4,
    color: 'var(--text)', font: 'inherit', fontSize: 12, padding: '1px 4px', outline: 'none',
  },
  dot: { width: 7, height: 7, borderRadius: '50%', background: 'var(--text-secondary)', flexShrink: 0, marginRight: 4 },
  close: {
    width: 16, height: 16, borderRadius: 4, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0,
  },
  addBtn: {
    width: 28, height: 28, borderRadius: 6, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)',
  },
};
