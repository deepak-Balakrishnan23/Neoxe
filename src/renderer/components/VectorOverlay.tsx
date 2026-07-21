import React from 'react';
import { Page, VectorChildNode } from '../../shared/types';
import { Viewport } from '../canvas/renderer';
import { sanitizeSvgMarkup } from '../../shared/sanitizeSvg';

interface Props {
  page: Page;
  viewport: Viewport;
  vectorEditShapeId: string | null;
  vectorEditChildId: string | null;
  svgEditShapeId: string | null;
  livePreviewSvg: string | null;
  onSelectChild: (shapeId: string, childId: string | null) => void;
}

function vcStyle(node: VectorChildNode) {
  return {
    fill: node.fill ?? 'none',
    stroke: node.stroke ?? 'none',
    strokeWidth: node.strokeWidth || undefined,
    opacity: node.opacity !== 1 ? node.opacity : undefined,
  };
}

function renderVChild(
  node: VectorChildNode,
  isEditing: boolean,
  selectedChildId: string | null,
  shapeId: string,
  onSelect: (shapeId: string, childId: string) => void,
): React.ReactNode {
  const s = vcStyle(node);
  const isSelected = isEditing && node.id === selectedChildId;
  const clickProps = isEditing
    ? { onClick: (e: React.MouseEvent) => { e.stopPropagation(); onSelect(shapeId, node.id); }, style: { cursor: 'pointer' } as React.CSSProperties }
    : {};
  const outline = isSelected ? { filter: 'drop-shadow(0 0 2px #0d99ff)' } : {};
  const allProps = { ...s, ...outline, ...clickProps };

  switch (node.type) {
    case 'vector-rect':
      return <rect key={node.id} {...allProps} x={node.x} y={node.y} width={node.width} height={node.height} rx={node.rx} />;
    case 'vector-circle':
      return <circle key={node.id} {...allProps} cx={node.cx} cy={node.cy} r={node.r} />;
    case 'vector-ellipse':
      return <ellipse key={node.id} {...allProps} cx={node.cx} cy={node.cy} rx={node.rx} ry={node.ry} />;
    case 'vector-path':
      return <path key={node.id} {...allProps} d={node.d} />;
    case 'vector-poly':
      return node.closed
        ? <polygon key={node.id} {...allProps} points={node.points} />
        : <polyline key={node.id} {...allProps} points={node.points} />;
    case 'vector-line':
      return <line key={node.id} {...allProps} x1={node.x1} y1={node.y1} x2={node.x2} y2={node.y2} />;
    case 'vector-group':
      return (
        <g key={node.id} transform={node.transform} {...clickProps}
          style={isSelected ? { filter: 'drop-shadow(0 0 2px #0d99ff)', cursor: 'pointer' } : clickProps.style}>
          {node.children?.map(child => renderVChild(child, isEditing, selectedChildId, shapeId, onSelect))}
        </g>
      );
    case 'vector-raw':
      // outerHTML originates from an imported (untrusted) SVG file — sanitize before
      // injecting into the live DOM, or a crafted file runs script in the app.
      return <g key={node.id} dangerouslySetInnerHTML={{ __html: sanitizeSvgMarkup(node.outerHTML ?? '') }} />;
    default:
      return null;
  }
}

export default function VectorOverlay({ page, viewport, vectorEditShapeId, vectorEditChildId, svgEditShapeId, livePreviewSvg, onSelectChild }: Props) {
  // The canvas now draws vectors that have stored SVG markup (so a drag preview moves them
  // live). This overlay only handles: (a) the shape being edited — crisp + interactive — and
  // (b) legacy vectors with no markup (vectorChildren only) that the canvas can't rasterize.
  const vectorShapes = Object.values(page.objects).filter(s =>
    s.type === 'vector' && !s.hidden && (
      s.id === vectorEditShapeId || s.id === svgEditShapeId ||
      (!s.svgInnerHTML && !s.svgContent)
    ),
  );
  if (vectorShapes.length === 0) return null;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {vectorShapes.map(shape => {
        const isVectorEditing = shape.id === vectorEditShapeId;
        const isSvgEditing = shape.id === svgEditShapeId;
        const screenX = shape.x * viewport.zoom + viewport.x;
        const screenY = shape.y * viewport.zoom + viewport.y;
        const screenW = shape.width * viewport.zoom;
        const screenH = shape.height * viewport.zoom;
        const origW = shape.svgOriginalWidth ?? shape.width;
        const origH = shape.svgOriginalHeight ?? shape.height;

        // Shapes with svgInnerHTML → render as a single inline <svg>; live preview
        // replaces the innerHTML during drag-editing so the shape updates in real time.
        if (shape.svgInnerHTML) {
          // svgInnerHTML comes from imported SVGs / opened .design files (untrusted) —
          // sanitize at the injection point so stored markup can never execute script.
          const innerHTML = sanitizeSvgMarkup(isSvgEditing && livePreviewSvg != null
            ? livePreviewSvg
            : shape.svgInnerHTML);
          return (
            <svg
              key={shape.id}
              style={{
                position: 'absolute',
                left: screenX,
                top: screenY,
                width: screenW,
                height: screenH,
                overflow: 'visible',
                pointerEvents: 'none',
              }}
              viewBox={`0 0 ${origW} ${origH}`}
              dangerouslySetInnerHTML={{ __html: innerHTML }}
            />
          );
        }

        // Legacy: render via VectorChildNode tree (no svgInnerHTML)
        return (
          <svg
            key={shape.id}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY,
              width: screenW,
              height: screenH,
              overflow: 'visible',
              pointerEvents: isVectorEditing ? 'all' : 'none',
              outline: isVectorEditing ? '1px solid rgba(13,153,255,0.4)' : undefined,
            }}
            viewBox={`0 0 ${origW} ${origH}`}
          >
            {(shape.vectorChildren ?? []).map(child =>
              renderVChild(child, isVectorEditing, vectorEditChildId, shape.id, onSelectChild)
            )}
          </svg>
        );
      })}
    </div>
  );
}
