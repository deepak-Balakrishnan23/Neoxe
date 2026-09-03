import React, { useRef, useEffect } from 'react';
import { useDesignStore, ToolType } from '../store/useDesignStore';
import Icon, { IconName } from './Icon';
import { T } from '../theme';
import { importImageFiles, IMAGE_ACCEPT_ATTR } from '../io/imageImport';

interface Tool { id: ToolType; icon: IconName; shortcut: string; label: string }
interface Group { id: string; tools: Tool[] }

/**
 * Tools are grouped the way Figma groups them: one button per group showing whichever
 * tool in that group you last used, plus a chevron that opens the full list. A group of
 * one renders as a plain button with no chevron.
 *
 * Image stays its own button rather than joining the shape group - it opens a file
 * picker instead of arming a drag tool, so it does not behave like its neighbours.
 */
const GROUPS: Group[] = [
  { id: 'select', tools: [{ id: 'select', icon: 'cursor', shortcut: 'V', label: 'Move' }] },
  { id: 'frame', tools: [{ id: 'frame', icon: 'frame', shortcut: 'F', label: 'Frame' }] },
  {
    id: 'shape',
    tools: [
      { id: 'rect', icon: 'rect', shortcut: 'R', label: 'Rectangle' },
      { id: 'line', icon: 'line', shortcut: 'L', label: 'Line' },
      { id: 'arrow', icon: 'arrow', shortcut: '⇧L', label: 'Arrow' },
      { id: 'ellipse', icon: 'ellipse', shortcut: 'O', label: 'Ellipse' },
      { id: 'polygon', icon: 'polygon', shortcut: '', label: 'Polygon' },
      { id: 'star', icon: 'star', shortcut: '', label: 'Star' },
    ],
  },
  {
    id: 'pen',
    tools: [
      { id: 'pen', icon: 'pen', shortcut: 'P', label: 'Pen' },
      { id: 'pencil', icon: 'pencil', shortcut: '⇧P', label: 'Pencil' },
    ],
  },
  {
    id: 'text',
    tools: [
      { id: 'text', icon: 'text', shortcut: 'T', label: 'Text' },
      { id: 'text-path', icon: 'text-path', shortcut: '', label: 'Text on path' },
    ],
  },
  { id: 'image', tools: [{ id: 'image', icon: 'image', shortcut: '⇧⌘K', label: 'Place image' }] },
];

export default function FloatingToolbar() {
  const { activeTool, setActiveTool } = useDesignStore();
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [openGroup, setOpenGroup] = React.useState<string | null>(null);
  // Per-group memory of the last tool picked, so the button keeps showing it.
  const [lastUsed, setLastUsed] = React.useState<Record<string, ToolType>>({});
  const wrapRef = useRef<HTMLDivElement>(null);

  // A menu should not outlive a click elsewhere or an Escape.
  useEffect(() => {
    if (!openGroup) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpenGroup(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenGroup(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openGroup]);

  const onTool = (id: ToolType) => {
    if (id === 'image') { imageInputRef.current?.click(); return; }
    setActiveTool(id);
  };

  /** The tool a group's button represents: the active one if it belongs to this group,
   *  otherwise the last one used here, otherwise the group's first. */
  const shownTool = (g: Group): Tool =>
    g.tools.find(t => t.id === activeTool)
    ?? g.tools.find(t => t.id === lastUsed[g.id])
    ?? g.tools[0];

  const pick = (g: Group, t: Tool) => {
    setLastUsed(prev => ({ ...prev, [g.id]: t.id }));
    setOpenGroup(null);
    onTool(t.id);
  };

  return (
    <div style={styles.wrap}>
      <input
        ref={imageInputRef} type="file" accept={IMAGE_ACCEPT_ATTR} multiple style={{ display: 'none' }}
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length === 0) return;
          const imgs = await importImageFiles(files);
          if (imgs.length > 0) {
            window.dispatchEvent(new CustomEvent('tool:images-loaded', { detail: imgs }));
          } else {
            alert('Could not import that image. Supported: PNG, JPG, GIF, WEBP, BMP, SVG, HEIC.');
          }
        }}
      />
      <div style={styles.pill} ref={wrapRef}>
        {GROUPS.map(g => {
          const tool = shownTool(g);
          const active = g.tools.some(t => t.id === activeTool);
          return (
            <React.Fragment key={g.id}>
              {/* Image is visually set apart: it opens a picker rather than arming a tool. */}
              {g.id === 'image' && <div style={styles.sep} />}
              <div style={styles.group}>
                <ToolButton
                  tool={tool}
                  active={active}
                  onClick={() => onTool(tool.id)}
                />
                {g.tools.length > 1 && (
                  <ChevronButton
                    open={openGroup === g.id}
                    label={`${tool.label} options`}
                    onClick={() => setOpenGroup(openGroup === g.id ? null : g.id)}
                  />
                )}
                {openGroup === g.id && (
                  <div style={styles.menu} role="menu">
                    {g.tools.map(t => (
                      <MenuItem
                        key={t.id}
                        tool={t}
                        checked={activeTool === t.id}
                        onClick={() => pick(g, t)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

function ToolButton({ tool, active, onClick }: { tool: Tool; active: boolean; onClick: () => void }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div style={{ position: 'relative' }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button
        onClick={onClick}
        aria-label={tool.label}
        aria-pressed={active}
        style={{
          ...styles.toolBtn,
          background: active ? T.accent : hover ? T.bgElevated2 : 'transparent',
          color: active ? '#fff' : T.text,
        }}
      >
        <Icon name={tool.icon} size={19} strokeWidth={active ? 1.7 : 1.5} />
      </button>
      {hover && (
        <div style={styles.tip}>
          {tool.label}{tool.shortcut && <span style={styles.tipKey}>{tool.shortcut}</span>}
        </div>
      )}
    </div>
  );
}

function ChevronButton({ open, label, onClick }: { open: boolean; label: string; onClick: () => void }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-expanded={open}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...styles.chevBtn,
        background: open || hover ? T.bgElevated2 : 'transparent',
        color: open ? T.text : T.textSecondary,
      }}
    >
      <Icon name="chevron-down" size={12} strokeWidth={1.6} />
    </button>
  );
}

function MenuItem({ tool, checked, onClick }: { tool: Tool; checked: boolean; onClick: () => void }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      role="menuitemradio"
      aria-checked={checked}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...styles.menuItem, background: hover ? T.bgElevated2 : 'transparent' }}
    >
      <span style={styles.menuCheck}>
        {checked && <Icon name="check" size={12} strokeWidth={2} />}
      </span>
      <Icon name={tool.icon} size={16} strokeWidth={1.5} />
      <span style={styles.menuLabel}>{tool.label}</span>
      <span style={styles.menuKey}>{tool.shortcut}</span>
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)',
    zIndex: 50, pointerEvents: 'none',
  },
  pill: {
    pointerEvents: 'auto',
    display: 'flex', alignItems: 'center', gap: 4,
    background: T.bgApp, border: `1px solid ${T.border}`,
    borderRadius: 12, padding: 8, boxShadow: T.shadowFloat,
  },
  group: { position: 'relative', display: 'flex', alignItems: 'center' },
  toolBtn: {
    border: 'none', width: 40, height: 40, borderRadius: 8, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'background .12s, color .12s',
  },
  chevBtn: {
    border: 'none', width: 16, height: 40, borderRadius: 8, cursor: 'pointer', padding: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'background .12s, color .12s',
  },
  menu: {
    position: 'absolute', bottom: '100%', left: 0, marginBottom: 8,
    background: T.bgElevated, border: `1px solid ${T.border}`, borderRadius: 8,
    padding: 4, boxShadow: T.shadowPopover, minWidth: 200, zIndex: 60,
    display: 'flex', flexDirection: 'column', gap: 2,
  },
  menuItem: {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
    height: 28, padding: '0 8px', borderRadius: 6, border: 'none',
    cursor: 'pointer', color: T.text, fontSize: 12, textAlign: 'left',
    transition: 'background .12s',
  },
  menuCheck: {
    width: 12, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: T.text,
  },
  menuLabel: { flex: 1, minWidth: 0, whiteSpace: 'nowrap' },
  menuKey: { color: T.textMuted, fontSize: 11, flexShrink: 0 },
  sep: { width: 1, height: 24, background: T.border, margin: '0 4px' },
  tip: {
    position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
    marginBottom: 8, background: '#000', color: '#fff', fontSize: 11,
    padding: '4px 8px', borderRadius: 6, whiteSpace: 'nowrap', fontFamily: T.font,
    pointerEvents: 'none', display: 'flex', alignItems: 'center', gap: 8,
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  },
  tipKey: { color: 'rgba(255,255,255,0.5)', fontSize: 10 },
};
