import { PathSegment } from './types';

/** A flattened path: a polyline plus the cumulative arc length at each vertex. */
export interface Polyline {
  /** x,y pairs, flattened. */
  pts: number[];
  /** cum[i] = distance along the path at vertex i. cum[0] === 0. */
  cum: number[];
  /** Total arc length. */
  length: number;
}

/** A position along a path: where it is, and which way the path is heading there. */
export interface PathPoint {
  x: number;
  y: number;
  /** Tangent direction in radians, from atan2 of the local heading. */
  angle: number;
}

function cubicAt(t: number, a: number, b: number, c: number, d: number): number {
  const mt = 1 - t;
  return mt * mt * mt * a + 3 * mt * mt * t * b + 3 * mt * t * t * c + t * t * t * d;
}

function quadAt(t: number, a: number, b: number, c: number): number {
  const mt = 1 - t;
  return mt * mt * a + 2 * mt * t * b + t * t * c;
}

/**
 * Flatten a path to a polyline.
 *
 * Curves are subdivided into a fixed number of steps rather than adaptively: text on a
 * path samples the result thousands of times per frame, so a predictable cost matters
 * more than shaving vertices off a gentle curve.
 */
export function flattenPath(segments: PathSegment[], stepsPerCurve = 24): Polyline {
  const pts: number[] = [];
  let cx = 0, cy = 0;        // current point
  let sx = 0, sy = 0;        // subpath start (for Z)

  const push = (x: number, y: number) => {
    // Skip exact duplicates so zero-length steps can't produce a NaN tangent.
    const n = pts.length;
    if (n >= 2 && pts[n - 2] === x && pts[n - 1] === y) return;
    pts.push(x, y);
  };

  for (const seg of segments) {
    const k = seg.coords;
    switch (seg.verb) {
      case 'M':
        cx = k[0]; cy = k[1]; sx = cx; sy = cy;
        push(cx, cy);
        break;
      case 'L':
        cx = k[0]; cy = k[1];
        push(cx, cy);
        break;
      case 'Q': {
        const x0 = cx, y0 = cy;
        for (let i = 1; i <= stepsPerCurve; i++) {
          const t = i / stepsPerCurve;
          push(quadAt(t, x0, k[0], k[2]), quadAt(t, y0, k[1], k[3]));
        }
        cx = k[2]; cy = k[3];
        break;
      }
      case 'C': {
        const x0 = cx, y0 = cy;
        for (let i = 1; i <= stepsPerCurve; i++) {
          const t = i / stepsPerCurve;
          push(cubicAt(t, x0, k[0], k[2], k[4]), cubicAt(t, y0, k[1], k[3], k[5]));
        }
        cx = k[4]; cy = k[5];
        break;
      }
      case 'Z':
        push(sx, sy);
        cx = sx; cy = sy;
        break;
    }
  }

  const cum: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length; i += 2) {
    if (i === 0) { cum.push(0); continue; }
    const dx = pts[i] - pts[i - 2];
    const dy = pts[i + 1] - pts[i - 1];
    total += Math.hypot(dx, dy);
    cum.push(total);
  }
  return { pts, cum, length: total };
}

/**
 * The point at `dist` along the polyline, with the tangent angle there.
 *
 * Distances outside [0, length] are clamped and the end tangent is extended, so a glyph
 * that runs past the end of its path keeps going straight instead of piling up on the
 * last vertex.
 */
export function pointAtDistance(pl: Polyline, dist: number): PathPoint | null {
  const n = pl.cum.length;
  if (n === 0) return null;
  if (n === 1) return { x: pl.pts[0], y: pl.pts[1], angle: 0 };

  if (dist <= 0) {
    const angle = Math.atan2(pl.pts[3] - pl.pts[1], pl.pts[2] - pl.pts[0]);
    return { x: pl.pts[0] + Math.cos(angle) * dist, y: pl.pts[1] + Math.sin(angle) * dist, angle };
  }
  if (dist >= pl.length) {
    const i = n - 1;
    const angle = Math.atan2(pl.pts[i * 2 + 1] - pl.pts[i * 2 - 1], pl.pts[i * 2] - pl.pts[i * 2 - 2]);
    const over = dist - pl.length;
    return { x: pl.pts[i * 2] + Math.cos(angle) * over, y: pl.pts[i * 2 + 1] + Math.sin(angle) * over, angle };
  }

  // Binary search for the segment containing `dist`.
  let lo = 0, hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pl.cum[mid] <= dist) lo = mid; else hi = mid;
  }
  const segLen = pl.cum[hi] - pl.cum[lo];
  const t = segLen > 0 ? (dist - pl.cum[lo]) / segLen : 0;
  const x0 = pl.pts[lo * 2], y0 = pl.pts[lo * 2 + 1];
  const x1 = pl.pts[hi * 2], y1 = pl.pts[hi * 2 + 1];
  return {
    x: x0 + (x1 - x0) * t,
    y: y0 + (y1 - y0) * t,
    angle: Math.atan2(y1 - y0, x1 - x0),
  };
}

/**
 * Ramer-Douglas-Peucker simplification, used to turn a raw pointer trail from the pencil
 * into a path with a workable number of anchors. `tolerance` is in document units.
 */
export function simplifyPoints(pts: { x: number; y: number }[], tolerance = 2): { x: number; y: number }[] {
  if (pts.length <= 2) return pts.slice();

  const sqTol = tolerance * tolerance;
  const sqSegDist = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
    let x = a.x, y = a.y;
    let dx = b.x - x, dy = b.y - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b.x; y = b.y; }
      else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p.x - x; dy = p.y - y;
    return dx * dx + dy * dy;
  };

  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  // Explicit stack: a deep recursion on a long freehand stroke can blow the call stack.
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxSq = 0, index = -1;
    for (let i = first + 1; i < last; i++) {
      const sq = sqSegDist(pts[i], pts[first], pts[last]);
      if (sq > maxSq) { maxSq = sq; index = i; }
    }
    if (maxSq > sqTol && index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

/**
 * Turn a simplified pointer trail into smooth cubic segments.
 *
 * Uses Catmull-Rom control points converted to beziers, so a pencil stroke reads as a
 * drawn curve rather than a chain of straight lines.
 */
export function pointsToSmoothPath(pts: { x: number; y: number }[]): PathSegment[] {
  if (pts.length === 0) return [];
  if (pts.length === 1) return [{ verb: 'M', coords: [pts[0].x, pts[0].y] }];
  if (pts.length === 2) {
    return [
      { verb: 'M', coords: [pts[0].x, pts[0].y] },
      { verb: 'L', coords: [pts[1].x, pts[1].y] },
    ];
  }

  const out: PathSegment[] = [{ verb: 'M', coords: [pts[0].x, pts[0].y] }];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    // Catmull-Rom -> cubic bezier control points (tension 1/6).
    out.push({
      verb: 'C',
      coords: [
        p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
        p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
        p2.x, p2.y,
      ],
    });
  }
  return out;
}

/**
 * The three corners of an arrowhead sitting on one end of a path.
 *
 * `atEnd` picks which end; the head always points AWAY from the path, so the start head
 * is the end head with its tangent reversed. Returns null when the path is degenerate.
 */
export function arrowHead(pl: Polyline, atEnd: boolean, size: number): PathPoint[] | null {
  if (pl.length <= 0 || size <= 0) return null;
  const tip = pointAtDistance(pl, atEnd ? pl.length : 0);
  if (!tip) return null;
  const a = tip.angle + (atEnd ? 0 : Math.PI);
  const SPREAD = 0.4; // half-angle of the head, in radians
  const corner = (sign: 1 | -1): PathPoint => ({
    x: tip.x - size * Math.cos(a + sign * SPREAD),
    y: tip.y - size * Math.sin(a + sign * SPREAD),
    angle: a,
  });
  return [tip, corner(-1), corner(1)];
}

/** Bezier circle constant: handle length for a 90-degree arc. */
const KAPPA = 0.5522847498307936;

/**
 * A closed elliptical baseline inscribed in a w x h box, in shape-local coordinates.
 *
 * Starts at top-centre and runs clockwise, which is what puts centred text upright
 * across the top of the ellipse rather than inverted along the bottom.
 */
export function ellipsePath(w: number, h: number): PathSegment[] {
  const rx = w / 2, ry = h / 2;
  const cx = rx, cy = ry;
  return [
    { verb: 'M', coords: [cx, 0] },
    { verb: 'C', coords: [cx + rx * KAPPA, 0, w, cy - ry * KAPPA, w, cy] },
    { verb: 'C', coords: [w, cy + ry * KAPPA, cx + rx * KAPPA, h, cx, h] },
    { verb: 'C', coords: [cx - rx * KAPPA, h, 0, cy + ry * KAPPA, 0, cy] },
    { verb: 'C', coords: [0, cy - ry * KAPPA, cx - rx * KAPPA, 0, cx, 0] },
    { verb: 'Z', coords: [] },
  ];
}

/** The baseline a text shape actually uses: generated from its box, or an explicit path. */
export function textBaseline(
  shape: { width: number; height: number; textPath?: PathSegment[]; textPathShape?: 'ellipse' },
): PathSegment[] | null {
  if (shape.textPathShape === 'ellipse') {
    if (shape.width <= 0 || shape.height <= 0) return null;
    return ellipsePath(shape.width, shape.height);
  }
  return shape.textPath && shape.textPath.length > 1 ? shape.textPath : null;
}
