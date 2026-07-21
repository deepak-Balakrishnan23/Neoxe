import { SvgAnchorPoint } from '../../shared/types';

// Parse an SVG path d-string into AnchorPoints (all absolute coords). Every curve command
// is normalized to C (cubic) or Q (quadratic): S/T resolve their implicit reflected control
// point, and A (elliptical arc) is converted to cubic Béziers — so imported curved SVGs keep
// their shape when edited (they used to be flattened to straight lines).
export function parseSvgPath(d: string): SvgAnchorPoint[] {
  const tokens = tokenizeD(d);
  const points: SvgAnchorPoint[] = [];
  let i = 0;
  let curX = 0, curY = 0;
  // Track the previous command + its last control point so S/T can reflect it.
  let prevCmd = '';
  let lastC2x = 0, lastC2y = 0; // last cubic 2nd control point (abs)
  let lastQx = 0, lastQy = 0;   // last quadratic control point (abs)

  function num() { return parseFloat(tokens[i++]); }
  function isNum() { return i < tokens.length && /^-?[\d.]/.test(tokens[i]); }

  while (i < tokens.length) {
    const cmd = tokens[i++];
    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;

    do {
      switch (upper) {
        case 'M': {
          let x = num(), y = num();
          if (rel) { x += curX; y += curY; }
          points.push({ command: 'M', x, y });
          curX = x; curY = y; prevCmd = 'M';
          break;
        }
        case 'L': {
          let x = num(), y = num();
          if (rel) { x += curX; y += curY; }
          points.push({ command: 'L', x, y });
          curX = x; curY = y; prevCmd = 'L';
          break;
        }
        case 'H': {
          let x = num();
          if (rel) x += curX;
          points.push({ command: 'L', x, y: curY });
          curX = x; prevCmd = 'L';
          break;
        }
        case 'V': {
          let y = num();
          if (rel) y += curY;
          points.push({ command: 'L', x: curX, y });
          curY = y; prevCmd = 'L';
          break;
        }
        case 'C': {
          let cp1x = num(), cp1y = num(), cp2x = num(), cp2y = num(), x = num(), y = num();
          if (rel) { const bx = curX, by = curY; cp1x+=bx; cp1y+=by; cp2x+=bx; cp2y+=by; x+=bx; y+=by; }
          points.push({ command: 'C', x, y, cp1x, cp1y, cp2x, cp2y });
          lastC2x = cp2x; lastC2y = cp2y; curX = x; curY = y; prevCmd = 'C';
          break;
        }
        case 'S': {
          // Smooth cubic: cp1 is the reflection of the previous cubic's cp2 about the
          // current point (or the current point itself if the previous cmd wasn't C/S).
          let cp2x = num(), cp2y = num(), x = num(), y = num();
          if (rel) { cp2x+=curX; cp2y+=curY; x+=curX; y+=curY; }
          const smooth = prevCmd === 'C' || prevCmd === 'S';
          const cp1x = smooth ? 2 * curX - lastC2x : curX;
          const cp1y = smooth ? 2 * curY - lastC2y : curY;
          points.push({ command: 'C', x, y, cp1x, cp1y, cp2x, cp2y });
          lastC2x = cp2x; lastC2y = cp2y; curX = x; curY = y; prevCmd = 'S';
          break;
        }
        case 'Q': {
          let cpx = num(), cpy = num(), x = num(), y = num();
          if (rel) { cpx += curX; cpy += curY; x += curX; y += curY; }
          points.push({ command: 'Q', x, y, cp1x: cpx, cp1y: cpy });
          lastQx = cpx; lastQy = cpy; curX = x; curY = y; prevCmd = 'Q';
          break;
        }
        case 'T': {
          // Smooth quadratic: control point is the reflection of the previous quadratic's
          // control about the current point (or the current point if prev wasn't Q/T).
          let x = num(), y = num();
          if (rel) { x += curX; y += curY; }
          const smooth = prevCmd === 'Q' || prevCmd === 'T';
          const cpx = smooth ? 2 * curX - lastQx : curX;
          const cpy = smooth ? 2 * curY - lastQy : curY;
          points.push({ command: 'Q', x, y, cp1x: cpx, cp1y: cpy });
          lastQx = cpx; lastQy = cpy; curX = x; curY = y; prevCmd = 'T';
          break;
        }
        case 'A': {
          const rx = num(), ry = num(), phi = num(), largeArc = num(), sweep = num();
          let x = num(), y = num();
          if (rel) { x += curX; y += curY; }
          // Convert the elliptical arc to cubic Bézier segments.
          for (const c of arcToCubics(curX, curY, rx, ry, phi, largeArc !== 0, sweep !== 0, x, y)) {
            points.push({ command: 'C', x: c.x, y: c.y, cp1x: c.cp1x, cp1y: c.cp1y, cp2x: c.cp2x, cp2y: c.cp2y });
          }
          lastC2x = curX; lastC2y = curY; // arcs don't feed S-reflection meaningfully
          curX = x; curY = y; prevCmd = 'A';
          break;
        }
        case 'Z': {
          points.push({ command: 'Z', x: curX, y: curY });
          prevCmd = 'Z';
          break;
        }
      }
    } while (upper !== 'Z' && isNum());
  }
  return points;
}

// Convert an SVG elliptical arc (endpoint parametrization) to a list of cubic Bézier
// segments. Standard implementation: endpoint→center conversion, then split the sweep into
// ≤90° pieces and approximate each with one cubic. Falls back to a straight line for a
// degenerate (zero-radius) arc.
function arcToCubics(
  x1: number, y1: number, rx: number, ry: number, phiDeg: number,
  largeArc: boolean, sweep: boolean, x2: number, y2: number,
): { cp1x: number; cp1y: number; cp2x: number; cp2y: number; x: number; y: number }[] {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) {
    return [{ cp1x: x1, cp1y: y1, cp2x: x2, cp2y: y2, x: x2, y: y2 }];
  }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (phiDeg % 360) * Math.PI / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  // Step 1: transform to the ellipse's coordinate system.
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  // Correct out-of-range radii.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  // Step 2: center in the transformed system.
  const sign = largeArc !== sweep ? 1 : -1;
  const numer = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denom = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, numer) / denom);
  const cxp = co * (rx * y1p) / ry;
  const cyp = co * -(ry * x1p) / rx;
  // Step 3: center back in the original system.
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  // Step 4: start angle + sweep.
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / (len || 1))));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
  // Step 5: split into ≤90° segments, each approximated by one cubic.
  const segs = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)));
  const delta = dtheta / segs;
  const t = (4 / 3) * Math.tan(delta / 4);
  const out: { cp1x: number; cp1y: number; cp2x: number; cp2y: number; x: number; y: number }[] = [];
  let th = theta1, sx = x1, sy = y1;
  // Point + tangent on the (rotated) ellipse at angle a.
  const pt = (a: number) => {
    const ca = Math.cos(a), sa = Math.sin(a);
    return {
      x: cosP * rx * ca - sinP * ry * sa + cx,
      y: sinP * rx * ca + cosP * ry * sa + cy,
      dx: cosP * (-rx * sa) - sinP * (ry * ca),
      dy: sinP * (-rx * sa) + cosP * (ry * ca),
    };
  };
  for (let s = 0; s < segs; s++) {
    const th2 = th + delta;
    const p1 = pt(th), p2 = pt(th2);
    out.push({
      cp1x: sx + t * p1.dx, cp1y: sy + t * p1.dy,
      cp2x: p2.x - t * p2.dx, cp2y: p2.y - t * p2.dy,
      x: p2.x, y: p2.y,
    });
    th = th2; sx = p2.x; sy = p2.y;
  }
  return out;
}

function tokenizeD(d: string): string[] {
  // Split on command letters and number sequences
  return d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
}

export function svgPathToString(points: SvgAnchorPoint[]): string {
  return points.map(pt => {
    switch (pt.command) {
      case 'M': return `M ${r(pt.x)} ${r(pt.y)}`;
      case 'L': return `L ${r(pt.x)} ${r(pt.y)}`;
      case 'C': return `C ${r(pt.cp1x!)} ${r(pt.cp1y!)} ${r(pt.cp2x!)} ${r(pt.cp2y!)} ${r(pt.x)} ${r(pt.y)}`;
      case 'Q': return `Q ${r(pt.cp1x!)} ${r(pt.cp1y!)} ${r(pt.x)} ${r(pt.y)}`;
      case 'Z': return 'Z';
      default: return '';
    }
  }).join(' ');
}

function r(n: number) { return Math.round(n * 1000) / 1000; }
