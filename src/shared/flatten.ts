// ── Flatten ───────────────────────────────────────────────────────────────────
// Convert shapes to path geometry so a selection can collapse into a single vector.
// Rectangles and ellipses are emitted as cubics; paths contribute their own segments;
// containers contribute their children. Text, images and SVG have no path form here and
// are skipped, so the caller can tell the user what was left out.

import { PathSegment, Shape } from './types';

// Circle→cubic constant: the control-point distance that makes a Bézier match a quarter
// arc to within ~0.02%.
const K = 0.5522847498;

/** Segments for one shape in absolute document coordinates. */
export function shapeToSegments(shape: Shape, objects: Record<string, Shape>): PathSegment[] {
  const { x, y, width: w, height: h } = shape;

  switch (shape.type) {
    case 'rect':
    case 'frame': {
      const r = shape.cornerRadii;
      const max = Math.min(w, h) / 2;
      const tl = Math.min(r?.tl ?? 0, max), tr = Math.min(r?.tr ?? 0, max);
      const br = Math.min(r?.br ?? 0, max), bl = Math.min(r?.bl ?? 0, max);
      if (!tl && !tr && !br && !bl) {
        return [
          { verb: 'M', coords: [x, y] },
          { verb: 'L', coords: [x + w, y] },
          { verb: 'L', coords: [x + w, y + h] },
          { verb: 'L', coords: [x, y + h] },
          { verb: 'Z', coords: [] },
        ];
      }
      const arc = (cx: number, cy: number, fromX: number, fromY: number, toX: number, toY: number): PathSegment =>
        ({ verb: 'C', coords: [fromX + (cx - fromX) * K, fromY + (cy - fromY) * K, toX + (cx - toX) * K, toY + (cy - toY) * K, toX, toY] });
      return [
        { verb: 'M', coords: [x + tl, y] },
        { verb: 'L', coords: [x + w - tr, y] },
        arc(x + w, y, x + w - tr, y, x + w, y + tr),
        { verb: 'L', coords: [x + w, y + h - br] },
        arc(x + w, y + h, x + w, y + h - br, x + w - br, y + h),
        { verb: 'L', coords: [x + bl, y + h] },
        arc(x, y + h, x + bl, y + h, x, y + h - bl),
        { verb: 'L', coords: [x, y + tl] },
        arc(x, y, x, y + tl, x + tl, y),
        { verb: 'Z', coords: [] },
      ];
    }
    case 'circle': {
      const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry;
      return [
        { verb: 'M', coords: [cx, y] },
        { verb: 'C', coords: [cx + rx * K, y, x + w, cy - ry * K, x + w, cy] },
        { verb: 'C', coords: [x + w, cy + ry * K, cx + rx * K, y + h, cx, y + h] },
        { verb: 'C', coords: [cx - rx * K, y + h, x, cy + ry * K, x, cy] },
        { verb: 'C', coords: [x, cy - ry * K, cx - rx * K, y, cx, y] },
        { verb: 'Z', coords: [] },
      ];
    }
    case 'path':
    case 'bool': {
      // Path content is shape-local (that's how the renderer draws it) — lift to absolute.
      const own = (shape.content ?? []).map(seg => ({
        verb: seg.verb,
        coords: seg.coords.map((v, i) => (i % 2 === 0 ? v + x : v + y)),
      }));
      // A boolean group's computed outline REPLACES its operands — counting both would
      // double the geometry and undo the subtraction.
      if (own.length > 0) return own;
      return shape.childIds.flatMap(id => (objects[id] ? shapeToSegments(objects[id], objects) : []));
    }
    case 'group':
      return shape.childIds.flatMap(id => (objects[id] ? shapeToSegments(objects[id], objects) : []));
    default:
      return []; // text / image / svg / vector have no path form here
  }
}

/** True when flattening this shape would produce geometry. */
export function isFlattenable(shape: Shape, objects: Record<string, Shape>): boolean {
  return shapeToSegments(shape, objects).length > 0;
}

/** Translate absolute segments into a shape-local frame at (originX, originY). */
export function toLocal(segments: PathSegment[], originX: number, originY: number): PathSegment[] {
  return segments.map(seg => ({
    verb: seg.verb,
    coords: seg.coords.map((v, i) => (i % 2 === 0 ? v - originX : v - originY)),
  }));
}

/** Bounding box of absolute segments (anchor + control points — a safe outer bound). */
export function segmentsBounds(segments: PathSegment[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const seg of segments) {
    for (let i = 0; i + 1 < seg.coords.length; i += 2) {
      minX = Math.min(minX, seg.coords[i]); maxX = Math.max(maxX, seg.coords[i]);
      minY = Math.min(minY, seg.coords[i + 1]); maxY = Math.max(maxY, seg.coords[i + 1]);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * A regular polygon (or star, when `innerRatio` is set) inscribed in the box, in
 * SHAPE-LOCAL coordinates. Figma's polygon and star tools produce these.
 */
export function regularPolygon(width: number, height: number, points: number, innerRatio?: number): PathSegment[] {
  const n = Math.max(3, Math.round(points));
  const rx = width / 2, ry = height / 2;
  const out: PathSegment[] = [];
  const total = innerRatio == null ? n : n * 2;
  for (let i = 0; i < total; i++) {
    // Start at the top (−90°) so a polygon sits point-up, as Figma draws it.
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / total;
    const k = innerRatio == null || i % 2 === 0 ? 1 : innerRatio;
    const x = rx + Math.cos(angle) * rx * k;
    const y = ry + Math.sin(angle) * ry * k;
    out.push({ verb: i === 0 ? 'M' : 'L', coords: [x, y] });
  }
  out.push({ verb: 'Z', coords: [] });
  return out;
}
