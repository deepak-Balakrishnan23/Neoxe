import { AnchorPoint, PathSegment, PathVerb } from '../../shared/types';

/** Convert PathSegment[] → AnchorPoint[] (working copy for edit mode) */
export function segmentsToPoints(segments: PathSegment[]): AnchorPoint[] {
  return segments.map((seg, i) => {
    const p: AnchorPoint = { index: i, command: seg.verb, x: 0, y: 0 };
    switch (seg.verb) {
      case 'M':
      case 'L':
        p.x = seg.coords[0]; p.y = seg.coords[1];
        break;
      case 'C':
        p.cp1x = seg.coords[0]; p.cp1y = seg.coords[1];
        p.cp2x = seg.coords[2]; p.cp2y = seg.coords[3];
        p.x = seg.coords[4];   p.y = seg.coords[5];
        break;
      case 'Q':
        p.cp1x = seg.coords[0]; p.cp1y = seg.coords[1];
        p.x = seg.coords[2];   p.y = seg.coords[3];
        break;
      case 'Z':
        // Z has no coords; x/y stay 0 (unused for Z)
        break;
    }
    return p;
  });
}

/** Convert AnchorPoint[] → PathSegment[] (for committing back to store) */
export function pointsToSegments(points: AnchorPoint[]): PathSegment[] {
  return points.map(p => {
    switch (p.command) {
      case 'M': return { verb: 'M' as PathVerb, coords: [p.x, p.y] };
      case 'L': return { verb: 'L' as PathVerb, coords: [p.x, p.y] };
      case 'C': return { verb: 'C' as PathVerb, coords: [p.cp1x ?? p.x, p.cp1y ?? p.y, p.cp2x ?? p.x, p.cp2y ?? p.y, p.x, p.y] };
      case 'Q': return { verb: 'Q' as PathVerb, coords: [p.cp1x ?? p.x, p.cp1y ?? p.y, p.x, p.y] };
      case 'Z': return { verb: 'Z' as PathVerb, coords: [] };
    }
  });
}

/** Convert AnchorPoint[] → SVG path d-string (for the overlay <path> element) */
export function pointsToPathString(points: AnchorPoint[]): string {
  return points.map(p => {
    switch (p.command) {
      case 'M': return `M ${p.x} ${p.y}`;
      case 'L': return `L ${p.x} ${p.y}`;
      case 'C': return `C ${p.cp1x ?? p.x} ${p.cp1y ?? p.y} ${p.cp2x ?? p.x} ${p.cp2y ?? p.y} ${p.x} ${p.y}`;
      case 'Q': return `Q ${p.cp1x ?? p.x} ${p.cp1y ?? p.y} ${p.x} ${p.y}`;
      case 'Z': return 'Z';
    }
  }).join(' ');
}
