import React, { useEffect, useState } from 'react';
import { useDesignStore } from '../store/useDesignStore';
import Icon from './Icon';

// Bottom-centre transient toast. Auto-dismisses a few seconds after each showToast().
export default function Toast() {
  const toast = useDesignStore(s => s.toast);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 2500);
    return () => clearTimeout(t);
  }, [toast?.id]);

  if (!toast) return null;

  return (
    <div style={{ ...styles.wrap, opacity: visible ? 1 : 0, transform: `translateX(-50%) translateY(${visible ? 0 : 8}px)` }}>
      <span style={styles.check}><Icon name="check" size={13} /></span>
      <span>{toast.message}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    position: 'fixed', bottom: 76, left: '50%', transform: 'translateX(-50%)',
    zIndex: 700, display: 'flex', alignItems: 'center', gap: 8,
    background: 'var(--bg-elevated-2)', color: 'var(--text)',
    border: '1px solid var(--border-strong)', borderRadius: 10,
    padding: '9px 14px', fontSize: 13, fontFamily: 'system-ui', fontWeight: 500,
    boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
    transition: 'opacity .18s ease, transform .18s ease', pointerEvents: 'none',
  },
  check: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 18, height: 18, borderRadius: '50%', background: 'var(--accent)', color: '#fff', flexShrink: 0,
  },
};
