import React, { useState, useEffect, useRef } from 'react';
import { AnchorPoint } from '../../shared/types';
import { Viewport } from '../canvas/renderer';

interface Props {
  shapeId: string;
  shapeX: number;
  shapeY: number;
  viewport: Viewport;
  initialPoints: AnchorPoint[];
  selectedIndices: number[];
  onSelectPoints: (indices: number[]) => void;
  onCommit: (points: AnchorPoint[]) => void;
}

const ACCENT = '#1a73e8';
const R  = 5;    // anchor circle radius (screen px)
const CP = 3;    // control-point half-size (screen px)
const SW = 1.5;  // stroke width (screen px)

interface DragState {
  type: 'anchor' | 'cp1' | 'cp2';
  ptIndex: number;
  lastX: number;
  lastY: number;
  altKey: boolean;
  // Capture the resolved selection AT drag-start so the move handler never
  // reads stale closure values (React may not have re-rendered yet).
  selectedAt: number[];
}

export default function VectorEditOverlay({
  shapeX, shapeY, viewport, initialPoints, selectedIndices, onSelectPoints, onCommit,
}: Props) {
  const [pts, setPts] = useState<AnchorPoint[]>(initialPoints);
  const dragRef = useRef<DragState | null>(null);
  const vpRef = useRef(viewport);
  vpRef.current = viewport;

  // Re-sync when external state changes (shape switch, undo, etc.)
  useEffect(() => { setPts(initialPoints); }, [initialPoints]);

  // Shape-local coords → absolute screen coords
  const sx = (lx: number) => (shapeX + lx) * viewport.zoom + viewport.x;
  const sy = (ly: number) => (shapeY + ly) * viewport.zoom + viewport.y;

  const onAnchorDown = (e: React.MouseEvent, idx: number) => {
    e.stopPropagation();
    const newSel = e.shiftKey
      ? selectedIndices.includes(idx)
        ? selectedIndices.filter(i => i !== idx)
        : [...selectedIndices, idx]
      : [idx];
    onSelectPoints(newSel);
    dragRef.current = {
      type: 'anchor', ptIndex: idx,
      lastX: e.clientX, lastY: e.clientY,
      altKey: e.altKey,
      selectedAt: newSel,   // resolved immediately — no stale-closure bug
    };
  };

  const onCPDown = (e: React.MouseEvent, idx: number, which: 'cp1' | 'cp2') => {
    e.stopPropagation();
    dragRef.current = {
      type: which, ptIndex: idx,
      lastX: e.clientX, lastY: e.clientY,
      altKey: e.altKey,
      selectedAt: selectedIndices,
    };
  };

  // One stable effect — reads selection from dragRef.selectedAt, not from closure
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const zoom = vpRef.current.zoom;
      const dx = (e.clientX - drag.lastX) / zoom;
      const dy = (e.clientY - drag.lastY) / zoom;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;

      setPts(prev => prev.map((p, i) => {
        if (drag.type === 'anchor') {
          if (!drag.selectedAt.includes(i)) return p;
          return {
            ...p,
            x: p.x + dx, y: p.y + dy,
            cp1x: p.cp1x !== undefined ? p.cp1x + dx : undefined,
            cp1y: p.cp1y !== undefined ? p.cp1y + dy : undefined,
            cp2x: p.cp2x !== undefined ? p.cp2x + dx : undefined,
            cp2y: p.cp2y !== undefined ? p.cp2y + dy : undefined,
          };
        }
        if (i !== drag.ptIndex) return p;
        if (drag.type === 'cp1') {
          return { ...p, cp1x: (p.cp1x ?? p.x) + dx, cp1y: (p.cp1y ?? p.y) + dy };
        }
        // cp2: symmetric by default, Alt = asymmetric (break the curve)
        const np = { ...p, cp2x: (p.cp2x ?? p.x) + dx, cp2y: (p.cp2y ?? p.y) + dy };
        if (!drag.altKey && p.cp1x !== undefined) {
          np.cp1x = p.x - (np.cp2x! - p.x);
          np.cp1y = p.y - (np.cp2y! - p.y);
        }
        return np;
      }));
    };

    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setPts(prev => { onCommit(prev); return prev; });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onCommit]); // stable dep — selection read from dragRef, not closure

  // Build the path d-string in screen space for the outline
  const pathD = pts.map(p => {
    switch (p.command) {
      case 'M': return `M ${sx(p.x)} ${sy(p.y)}`;
      case 'L': return `L ${sx(p.x)} ${sy(p.y)}`;
      case 'C': return `C ${sx(p.cp1x ?? p.x)} ${sy(p.cp1y ?? p.y)} ${sx(p.cp2x ?? p.x)} ${sy(p.cp2y ?? p.y)} ${sx(p.x)} ${sy(p.y)}`;
      case 'Q': return `Q ${sx(p.cp1x ?? p.x)} ${sy(p.cp1y ?? p.y)} ${sx(p.x)} ${sy(p.y)}`;
      case 'Z': return 'Z';
    }
  }).join(' ');

  return (
    <svg
      style={{
        position: 'absolute', inset: 0,
        width: '100%', height: '100%',
        pointerEvents: 'none',
        zIndex: 20, overflow: 'visible',
      }}
    >
      {/* Live path outline */}
      <path d={pathD} fill="none" stroke={ACCENT} strokeWidth={1} opacity={0.6} />

      {pts.map((pt, i) => {
        if (pt.command === 'Z') return null;
        const cx = sx(pt.x);
        const cy = sy(pt.y);
        const isSelected = selectedIndices.includes(i);

        return (
          <g key={i}>
            {/* cp1 handle — only when this point is selected */}
            {isSelected && pt.cp1x !== undefined && (() => {
              const hx = sx(pt.cp1x!), hy = sy(pt.cp1y!);
              return (
                <>
                  <line x1={cx} y1={cy} x2={hx} y2={hy} stroke={ACCENT} strokeWidth={1} opacity={0.6} />
                  <rect
                    x={hx - CP} y={hy - CP} width={CP * 2} height={CP * 2}
                    fill="white" stroke={ACCENT} strokeWidth={SW}
                    style={{ cursor: 'pointer', pointerEvents: 'all' }}
                    onMouseDown={e => onCPDown(e, i, 'cp1')}
                  />
                </>
              );
            })()}
            {/* cp2 handle — only when this point is selected */}
            {isSelected && pt.cp2x !== undefined && (() => {
              const hx = sx(pt.cp2x!), hy = sy(pt.cp2y!);
              return (
                <>
                  <line x1={cx} y1={cy} x2={hx} y2={hy} stroke={ACCENT} strokeWidth={1} opacity={0.6} />
                  <rect
                    x={hx - CP} y={hy - CP} width={CP * 2} height={CP * 2}
                    fill="white" stroke={ACCENT} strokeWidth={SW}
                    style={{ cursor: 'pointer', pointerEvents: 'all' }}
                    onMouseDown={e => onCPDown(e, i, 'cp2')}
                  />
                </>
              );
            })()}
            {/* Invisible larger hit area first, then the visible circle on top */}
            <circle
              cx={cx} cy={cy} r={R + 4}
              fill="transparent"
              style={{ cursor: 'pointer', pointerEvents: 'all' }}
              onMouseDown={e => onAnchorDown(e, i)}
            />
            <circle
              cx={cx} cy={cy} r={R}
              fill={isSelected ? ACCENT : 'white'}
              stroke={ACCENT} strokeWidth={SW}
              style={{ cursor: 'pointer', pointerEvents: 'all' }}
              onMouseDown={e => onAnchorDown(e, i)}
            />
          </g>
        );
      })}
    </svg>
  );
}
