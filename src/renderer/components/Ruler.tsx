import React, { useRef } from 'react';
import { useDesignStore, Guide } from '../store/useDesignStore';
import { usePrefs } from '../store/usePrefs';

const RULER_SIZE = 20;
const GUIDE_COLOR = '#2897E0';
const GUIDE_HOVER_COLOR = '#FF3B30';
const RULER_BG = '#1a1a1a';
const RULER_TICK = '#4a4a4a';
const RULER_TEXT = '#777';
const RULER_BORDER = '#333';

interface Viewport { x: number; y: number; zoom: number; }
interface RulerProps { viewport: Viewport; }

function getTickInterval(zoom: number): { major: number; minor: number } {
  if (zoom >= 8)   return { major: 5,    minor: 1 };
  if (zoom >= 4)   return { major: 10,   minor: 5 };
  if (zoom >= 2)   return { major: 50,   minor: 10 };
  if (zoom >= 1)   return { major: 50,   minor: 25 };
  if (zoom >= 0.5) return { major: 100,  minor: 50 };
  if (zoom >= 0.1) return { major: 500,  minor: 100 };
  return             { major: 1000,  minor: 500 };
}

function gId() { return Math.random().toString(36).slice(2, 10); }

interface DragState {
  kind: 'new' | 'guide';
  id: string;
  guideType: 'horizontal' | 'vertical';
  screenPos: number;
}

export default function Ruler({ viewport }: RulerProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const vpRef = useRef(viewport);
  vpRef.current = viewport;

  const { activePage, addGuide, updateGuide, removeGuide, guidesPerPage } = useDesignStore();
  const { showRulers, showGuides } = usePrefs();

  const pageIdRef = useRef('');
  const page = activePage();
  pageIdRef.current = page?.id ?? '';
  const guides: Guide[] = page ? (guidesPerPage[page.id] ?? []) : [];

  const [drag, setDrag] = React.useState<DragState | null>(null);
  dragRef.current = drag;
  const [hoverId, setHoverId] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  // Delete selected guide via keyboard
  React.useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        removeGuide(pageIdRef.current, selectedId);
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, removeGuide]);

  const startDrag = (d: DragState) => {
    dragRef.current = d;
    setDrag(d);
    document.body.style.userSelect = 'none';

    const onMove = (e: MouseEvent) => {
      const curr = dragRef.current;
      if (!curr) return;
      const rect = svgRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const screenPos = curr.guideType === 'horizontal'
        ? e.clientY - rect.top
        : e.clientX - rect.left;
      const next = { ...curr, screenPos };
      dragRef.current = next;
      setDrag(next);
    };

    const onUp = (e: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      const curr = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!curr) return;
      const rect = svgRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const screenPos = curr.guideType === 'horizontal'
        ? e.clientY - rect.top
        : e.clientX - rect.left;
      const vp = vpRef.current;
      const docPos = curr.guideType === 'horizontal'
        ? Math.round((screenPos - vp.y) / vp.zoom)
        : Math.round((screenPos - vp.x) / vp.zoom);
      const inRuler = screenPos < RULER_SIZE;
      const pid = pageIdRef.current;
      if (!pid) return;
      if (curr.kind === 'new') {
        if (!inRuler) addGuide(pid, { id: curr.id, type: curr.guideType, position: docPos });
      } else {
        if (inRuler) removeGuide(pid, curr.id);
        else updateGuide(pid, curr.id, docPos);
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (!showRulers && !showGuides) return null;

  const vp = viewport;
  const W = 8000; // large enough; SVG clips
  const H = 8000;

  function renderHTicks(): React.ReactNode[] {
    const { major, minor } = getTickInterval(vp.zoom);
    const docLeft = (RULER_SIZE - vp.x) / vp.zoom;
    const docRight = (window.innerWidth - vp.x) / vp.zoom;
    const elements: React.ReactNode[] = [];
    const majorStart = Math.ceil(docLeft / major) * major;
    const majorPositions = new Set<number>();
    for (let d = majorStart; d <= docRight + major; d += major) {
      majorPositions.add(Math.round(d));
    }
    // Minor ticks
    const minorStart = Math.ceil(docLeft / minor) * minor;
    for (let d = minorStart; d <= docRight + minor; d += minor) {
      if (majorPositions.has(Math.round(d))) continue;
      const sx = Math.round(d * vp.zoom + vp.x);
      if (sx < RULER_SIZE) continue;
      elements.push(
        <line key={`hm${d}`} x1={sx} y1={RULER_SIZE - 4} x2={sx} y2={RULER_SIZE} stroke={RULER_TICK} strokeWidth={0.5} />
      );
    }
    // Major ticks + labels
    for (const d of majorPositions) {
      const sx = Math.round(d * vp.zoom + vp.x);
      if (sx < RULER_SIZE) continue;
      elements.push(
        <line key={`hM${d}`} x1={sx} y1={RULER_SIZE - 8} x2={sx} y2={RULER_SIZE} stroke={RULER_TICK} strokeWidth={1} />,
        <text key={`hL${d}`} x={sx + 2} y={RULER_SIZE - 4} fill={RULER_TEXT} fontSize={9} fontFamily="system-ui,sans-serif">
          {d}
        </text>
      );
    }
    return elements;
  }

  function renderVTicks(): React.ReactNode[] {
    const { major, minor } = getTickInterval(vp.zoom);
    const docTop = (RULER_SIZE - vp.y) / vp.zoom;
    const docBot = (window.innerHeight - vp.y) / vp.zoom;
    const elements: React.ReactNode[] = [];
    const majorStart = Math.ceil(docTop / major) * major;
    const majorPositions = new Set<number>();
    for (let d = majorStart; d <= docBot + major; d += major) {
      majorPositions.add(Math.round(d));
    }
    // Minor ticks
    const minorStart = Math.ceil(docTop / minor) * minor;
    for (let d = minorStart; d <= docBot + minor; d += minor) {
      if (majorPositions.has(Math.round(d))) continue;
      const sy = Math.round(d * vp.zoom + vp.y);
      if (sy < RULER_SIZE) continue;
      elements.push(
        <line key={`vm${d}`} x1={RULER_SIZE - 4} y1={sy} x2={RULER_SIZE} y2={sy} stroke={RULER_TICK} strokeWidth={0.5} />
      );
    }
    // Major ticks + rotated labels
    for (const d of majorPositions) {
      const sy = Math.round(d * vp.zoom + vp.y);
      if (sy < RULER_SIZE) continue;
      elements.push(
        <line key={`vM${d}`} x1={RULER_SIZE - 8} y1={sy} x2={RULER_SIZE} y2={sy} stroke={RULER_TICK} strokeWidth={1} />,
        <text
          key={`vL${d}`}
          transform={`translate(${RULER_SIZE / 2 - 1}, ${sy - 2}) rotate(-90)`}
          textAnchor="middle"
          fill={RULER_TEXT}
          fontSize={9}
          fontFamily="system-ui,sans-serif"
        >
          {d}
        </text>
      );
    }
    return elements;
  }

  const dragScreenPos = drag?.screenPos ?? 0;
  const dragDocPos = drag
    ? (drag.guideType === 'horizontal'
        ? Math.round((dragScreenPos - vp.y) / vp.zoom)
        : Math.round((dragScreenPos - vp.x) / vp.zoom))
    : 0;
  const dragInRuler = dragScreenPos < RULER_SIZE;

  return (
    <svg
      ref={svgRef}
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: 20, overflow: 'hidden',
        userSelect: 'none', WebkitUserSelect: 'none',
      } as React.CSSProperties}
    >
      {/* Guide lines */}
      {showGuides && guides.map(g => {
        const isH = g.type === 'horizontal';
        const sp = isH
          ? Math.round(g.position * vp.zoom + vp.y)
          : Math.round(g.position * vp.zoom + vp.x);
        const isHover = hoverId === g.id;
        const isSel = selectedId === g.id;
        const color = (isHover || isSel) ? GUIDE_HOVER_COLOR : GUIDE_COLOR;
        return (
          <g
            key={g.id}
            style={{ pointerEvents: 'all', cursor: isH ? 'ns-resize' : 'ew-resize' }}
            onMouseEnter={() => setHoverId(g.id)}
            onMouseLeave={() => setHoverId(null)}
            onMouseDown={ev => {
              ev.stopPropagation();
              setSelectedId(g.id);
              const rect = svgRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
              startDrag({
                kind: 'guide',
                id: g.id,
                guideType: g.type,
                screenPos: isH ? ev.clientY - rect.top : ev.clientX - rect.left,
              });
            }}
          >
            {isH ? (
              <>
                <line x1={RULER_SIZE} y1={sp} x2={W} y2={sp} stroke="transparent" strokeWidth={8} />
                <line x1={RULER_SIZE} y1={sp} x2={W} y2={sp} stroke={color} strokeWidth={1} />
              </>
            ) : (
              <>
                <line x1={sp} y1={RULER_SIZE} x2={sp} y2={H} stroke="transparent" strokeWidth={8} />
                <line x1={sp} y1={RULER_SIZE} x2={sp} y2={H} stroke={color} strokeWidth={1} />
              </>
            )}
          </g>
        );
      })}

      {/* In-progress guide while dragging */}
      {drag && !dragInRuler && (
        <g style={{ pointerEvents: 'none' }}>
          {drag.guideType === 'horizontal' ? (
            <line x1={RULER_SIZE} y1={dragScreenPos} x2={W} y2={dragScreenPos} stroke={GUIDE_COLOR} strokeWidth={1} />
          ) : (
            <line x1={dragScreenPos} y1={RULER_SIZE} x2={dragScreenPos} y2={H} stroke={GUIDE_COLOR} strokeWidth={1} />
          )}
        </g>
      )}

      {/* Top ruler bar */}
      {showRulers && (
        <g
          style={{ pointerEvents: 'all', cursor: 'ns-resize' }}
          onMouseDown={ev => {
            const rect = svgRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
            startDrag({ kind: 'new', id: gId(), guideType: 'horizontal', screenPos: ev.clientY - rect.top });
          }}
        >
          <rect x={RULER_SIZE} y={0} width={W} height={RULER_SIZE} fill={RULER_BG} />
          <line x1={RULER_SIZE} y1={RULER_SIZE} x2={W} y2={RULER_SIZE} stroke={RULER_BORDER} strokeWidth={1} />
          {renderHTicks()}
        </g>
      )}

      {/* Left ruler bar */}
      {showRulers && (
        <g
          style={{ pointerEvents: 'all', cursor: 'ew-resize' }}
          onMouseDown={ev => {
            const rect = svgRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
            startDrag({ kind: 'new', id: gId(), guideType: 'vertical', screenPos: ev.clientX - rect.left });
          }}
        >
          <rect x={0} y={RULER_SIZE} width={RULER_SIZE} height={H} fill={RULER_BG} />
          <line x1={RULER_SIZE} y1={RULER_SIZE} x2={RULER_SIZE} y2={H} stroke={RULER_BORDER} strokeWidth={1} />
          {renderVTicks()}
        </g>
      )}

      {/* Corner square */}
      {showRulers && (
        <rect x={0} y={0} width={RULER_SIZE} height={RULER_SIZE} fill={RULER_BG} style={{ pointerEvents: 'all' }} />
      )}

      {/* Position badge during drag */}
      {drag && !dragInRuler && (() => {
        const isH = drag.guideType === 'horizontal';
        const bx = isH ? RULER_SIZE + 4 : dragScreenPos + 6;
        const by = isH ? dragScreenPos - 18 : RULER_SIZE + 4;
        return (
          <g style={{ pointerEvents: 'none' }}>
            <rect x={bx} y={by} width={44} height={16} rx={3} ry={3} fill="#1B6FC8" />
            <text
              x={bx + 22} y={by + 11}
              fill="#fff" fontSize={10} fontFamily="system-ui,sans-serif" textAnchor="middle"
            >
              {dragDocPos}
            </text>
          </g>
        );
      })()}
    </svg>
  );
}
