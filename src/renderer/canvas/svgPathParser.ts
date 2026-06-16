import { SvgAnchorPoint } from '../../shared/types';

// Parse an SVG path d-string into AnchorPoints (all absolute coords)
export function parseSvgPath(d: string): SvgAnchorPoint[] {
  const tokens = tokenizeD(d);
  const points: SvgAnchorPoint[] = [];
  let i = 0;
  let curX = 0, curY = 0;
  let lastCmd = '';

  function num() { return parseFloat(tokens[i++]); }
  function isNum() { return i < tokens.length && /^-?[\d.]/.test(tokens[i]); }

  while (i < tokens.length) {
    const cmd = tokens[i++];
    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;
    lastCmd = upper;

    do {
      switch (upper) {
        case 'M': {
          let x = num(), y = num();
          if (rel) { x += curX; y += curY; }
          points.push({ command: 'M', x, y });
          curX = x; curY = y;
          lastCmd = 'L'; // subsequent coords are implicit L
          break;
        }
        case 'L': {
          let x = num(), y = num();
          if (rel) { x += curX; y += curY; }
          points.push({ command: 'L', x, y });
          curX = x; curY = y;
          break;
        }
        case 'H': {
          let x = num();
          if (rel) x += curX;
          points.push({ command: 'L', x, y: curY });
          curX = x;
          break;
        }
        case 'V': {
          let y = num();
          if (rel) y += curY;
          points.push({ command: 'L', x: curX, y });
          curY = y;
          break;
        }
        case 'C': {
          let cp1x = num(), cp1y = num(), cp2x = num(), cp2y = num(), x = num(), y = num();
          if (rel) { const bx = curX, by = curY; cp1x+=bx; cp1y+=by; cp2x+=bx; cp2y+=by; x+=bx; y+=by; }
          points.push({ command: 'C', x, y, cp1x, cp1y, cp2x, cp2y });
          curX = x; curY = y;
          break;
        }
        case 'Q': {
          let cpx = num(), cpy = num(), x = num(), y = num();
          if (rel) { cpx += curX; cpy += curY; x += curX; y += curY; }
          points.push({ command: 'Q', x, y, cp1x: cpx, cp1y: cpy });
          curX = x; curY = y;
          break;
        }
        case 'Z': {
          points.push({ command: 'Z', x: curX, y: curY });
          break;
        }
        // S, T, A: treat as L to the endpoint for now
        case 'S': { num(); num(); let x = num(), y = num(); if (rel) { x+=curX; y+=curY; } points.push({ command: 'L', x, y }); curX=x; curY=y; break; }
        case 'T': { let x = num(), y = num(); if (rel) { x+=curX; y+=curY; } points.push({ command: 'L', x, y }); curX=x; curY=y; break; }
        case 'A': { num();num();num();num();num(); let x=num(),y=num(); if(rel){x+=curX;y+=curY;} points.push({command:'L',x,y}); curX=x;curY=y; break; }
      }
    } while (upper !== 'Z' && isNum());
  }
  // suppress unused warning
  void lastCmd;
  return points;
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
