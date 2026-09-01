// ── Boolean geometry ──────────────────────────────────────────────────────────
// Real path geometry for boolean groups. The canvas can composite operands per-pixel,
// but that result can't be written to SVG or PDF and can't be edited — so the engine
// also computes the actual outline and caches it on the bool shape's `content`.
//
// Curves are flattened to polygons first (polygon clipping needs straight edges), which
// means a boolean over curved shapes is an approximation — accurate to FLATTEN_TOLERANCE
// document units, which is well under a pixel at normal zoom.

import polygonClipping from 'polygon-clipping';
import { PathSegment } from './types';

/** Max distance a flattened chord may stray from the true curve, in document units. */
const FLATTEN_TOLERANCE = 0.25;

export type Ring = [number, number][];

// Points along a cubic. The segment count comes from the control polygon's length, which
// bounds the true arc length from above — so it never under-samples.
function cubicPoints(p0: [number, number], c1: [number, number], c2: [number, number], p1: [number, number]): Ring {
  const len = dist(p0, c1) + dist(c1, c2) + dist(c2, p1);
  const n = Math.min(64, Math.max(4, Math.ceil(len / Math.max(0.01, FLATTEN_TOLERANCE * 8))));
  const out: Ring = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
      u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1],
    ]);
  }
  return out;
}

function dist(a: [number, number], b: [number, number]) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/**
 * Flatten path segments into closed rings. Every subpath becomes one ring, closed
 * implicitly whether or not it carried an explicit `Z`.
 */
export function segmentsToRings(segments: PathSegment[]): Ring[] {
  const rings: Ring[] = [];
  let current: Ring = [];
  let cursor: [number, number] = [0, 0];
  let start: [number, number] = [0, 0];

  const flush = () => {
    if (current.length >= 3) rings.push(current);
    current = [];
  };

  for (const seg of segments) {
    const c = seg.coords;
    switch (seg.verb) {
      case 'M':
        flush();
        cursor = [c[0], c[1]];
        start = cursor;
        current = [cursor];
        break;
      case 'L':
        cursor = [c[0], c[1]];
        current.push(cursor);
        break;
      case 'C': {
        const end: [number, number] = [c[4], c[5]];
        current.push(...cubicPoints(cursor, [c[0], c[1]], [c[2], c[3]], end));
        cursor = end;
        break;
      }
      case 'Q': {
        // Elevate the quadratic to a cubic so there's one flattening path to maintain.
        const end: [number, number] = [c[2], c[3]];
        const c1: [number, number] = [cursor[0] + (2 / 3) * (c[0] - cursor[0]), cursor[1] + (2 / 3) * (c[1] - cursor[1])];
        const c2: [number, number] = [end[0] + (2 / 3) * (c[0] - end[0]), end[1] + (2 / 3) * (c[1] - end[1])];
        current.push(...cubicPoints(cursor, c1, c2, end));
        cursor = end;
        break;
      }
      case 'Z':
        flush();
        cursor = start;
        break;
    }
  }
  flush();

  // polygon-clipping wants each ring closed (first point repeated at the end).
  return rings.map(r => {
    const first = r[0], last = r[r.length - 1];
    return first[0] === last[0] && first[1] === last[1] ? r : [...r, first];
  });
}

export type BoolOp = 'union' | 'difference' | 'intersection' | 'exclusion';

/**
 * Combine operands (each a list of segments in the SAME coordinate space) with `op`.
 * Returns the resulting outline, or null when an operand has no area or the clipper
 * can't produce a result — callers should keep their previous geometry in that case.
 *
 * Within one operand, the first subpath is the outline and any further subpaths are
 * holes — the convention a donut drawn with opposite winding already follows.
 */
export function booleanSegments(op: BoolOp, operands: PathSegment[][]): PathSegment[] | null {
  // Each operand becomes one Polygon: ring 0 is the outline, the rest are holes.
  const geoms = operands
    .map(segmentsToRings)
    .filter(rings => rings.length > 0)
    .map(rings => rings as unknown as polygonClipping.Polygon);
  if (geoms.length < 2) return null;

  const [first, ...rest] = geoms;
  let result: polygonClipping.MultiPolygon;
  try {
    result =
      op === 'difference' ? polygonClipping.difference(first, ...rest)
      : op === 'intersection' ? polygonClipping.intersection(first, ...rest)
      : op === 'exclusion' ? polygonClipping.xor(first, ...rest)
      : polygonClipping.union(first, ...rest);
  } catch {
    // The clipper throws on some degenerate inputs (zero-area or self-touching rings).
    // A null result keeps the last good geometry rather than blanking the shape.
    return null;
  }
  if (!result || result.length === 0) return [];

  const out: PathSegment[] = [];
  for (const polygon of result) {
    for (const ring of polygon) {
      if (ring.length < 3) continue;
      // The clipper repeats the first point at the end; `Z` expresses that instead.
      const pts = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
        ? ring.slice(0, -1) : ring;
      out.push({ verb: 'M', coords: [round(pts[0][0]), round(pts[0][1])] });
      for (let i = 1; i < pts.length; i++) out.push({ verb: 'L', coords: [round(pts[i][0]), round(pts[i][1])] });
      out.push({ verb: 'Z', coords: [] });
    }
  }
  return out;
}

const round = (v: number) => Math.round(v * 100) / 100;
