import React, { useRef } from 'react';
import { useDesignStore, ToolType } from '../store/useDesignStore';
import Icon, { IconName } from './Icon';
import { T } from '../theme';
import { importImageFiles, IMAGE_ACCEPT_ATTR } from '../io/imageImport';

const TOOLS: { id: ToolType; icon: IconName; shortcut: string; label: string }[] = [
  { id: 'select',  icon: 'cursor',  shortcut: 'V', label: 'Move' },
  { id: 'frame',   icon: 'frame',   shortcut: 'F', label: 'Frame' },
  { id: 'rect',    icon: 'rect',    shortcut: 'R', label: 'Rectangle' },
  { id: 'ellipse', icon: 'ellipse', shortcut: 'O', label: 'Ellipse' },
  { id: 'text',    icon: 'text',    shortcut: 'T', label: 'Text' },
  { id: 'pen',     icon: 'pen',     shortcut: 'P', label: 'Pen' },
  { id: 'image',   icon: 'image',   shortcut: '⇧⌘K', label: 'Place image' },
];

export default function FloatingToolbar() {
  const { activeTool, setActiveTool } = useDesignStore();
  const imageInputRef = useRef<HTMLInputElement>(null);

  const onTool = (id: ToolType) => {
    if (id === 'image') { imageInputRef.current?.click(); return; }
    setActiveTool(id);
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
      <div style={styles.pill}>
        {TOOLS.map((t, i) => (
          <React.Fragment key={t.id}>
            {i === 1 && <div style={styles.sep} />}
            {i === 5 && <div style={styles.sep} />}
            <ToolButton tool={t} active={activeTool === t.id} onClick={() => onTool(t.id)} />
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function ToolButton({ tool, active, onClick }: {
  tool: { icon: IconName; shortcut: string; label: string };
  active: boolean; onClick: () => void;
}) {
  const [hover, setHover] = React.useState(false);
  return (
    <div style={{ position: 'relative' }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button
        onClick={onClick}
        aria-label={tool.label}
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
          {tool.label} <span style={styles.tipKey}>{tool.shortcut}</span>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)',
    zIndex: 50, pointerEvents: 'none',
  },
  pill: {
    pointerEvents: 'auto',
    display: 'flex', alignItems: 'center', gap: 3,
    background: T.bgApp, border: `1px solid ${T.border}`,
    borderRadius: 14, padding: 6, boxShadow: T.shadowFloat,
  },
  toolBtn: {
    border: 'none', width: 40, height: 40, borderRadius: 10, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'background .12s, color .12s',
  },
  sep: { width: 1, height: 24, background: T.border, margin: '0 4px' },
  tip: {
    position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
    marginBottom: 10, background: '#000', color: '#fff', fontSize: 11,
    padding: '5px 9px', borderRadius: 6, whiteSpace: 'nowrap', fontFamily: T.font,
    pointerEvents: 'none', display: 'flex', alignItems: 'center', gap: 6,
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  },
  tipKey: { color: 'rgba(255,255,255,0.5)', fontSize: 10 },
};
