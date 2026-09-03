import { Shape, Page, Rect, isTextOnPath } from '../../shared/types';
import { Viewport } from './renderer';
import { getHandlePositions } from './renderer';
import { ROTATE_HANDLE, ROTATE_OFFSET } from './transform';

// Convert a screen-space point to document-space
export function screenToDoc(x: number, y: number, vp: Viewport): { x: number; y: number } {
  return {
    x: (x - vp.x) / vp.zoom,
    y: (y - vp.y) / vp.zoom,
  };
}

// Hit-test a point against the page, front-to-back.
// Returns the deepest shape id hit, or null.
// Accepts any object carrying the shape map + root order (not just a full Page) so
// callers holding partial page views can hit-test without fabricating unused fields.
export function hitTestPoint(
  page: Pick<Page, 'objects' | 'childIds'>,
  docX: number,
  docY: number,
): string | null {
  // Walk root-level shapes back-to-front (last child on top)
  const candidates = [...page.childIds].reverse();
  for (const id of candidates) {
    const shape = page.objects[id];
    if (!shape || shape.hidden || shape.locked) continue;

    const hit = hitTestShape(shape, page, docX, docY);
    if (hit) return hit;
  }
  return null;
}

function hitTestShape(
  shape: Shape,
  page: Pick<Page, 'objects' | 'childIds'>,
  x: number,
  y: number,
): string | null {
  // Transform the test point into the shape's LOCAL (un-rotated) space so
  // rotated shapes are hit-tested against their actual rotated bounds.
  const lp = toLocal(x, y, shape);

  // AABB rejection in local space — only gate by parent bounds when it clips.
  const clips = shape.type === 'frame' && shape.clipContent;
  if (clips && !pointInRect(lp.x, lp.y, { x: shape.x, y: shape.y, width: shape.width, height: shape.height })) {
    return null;
  }

  // Check children first (they are on top). Children store absolute coords and
  // are tested independently (each handles its own rotation).
  if (shape.childIds.length > 0) {
    const children = [...shape.childIds].reverse();
    for (const childId of children) {
      const child = page.objects[childId];
      if (!child || child.hidden || child.locked) continue;
      const hit = hitTestShape(child, page, x, y);
      if (hit) return hit;
    }
  }

  // Then test self in local space
  if (shape.type === 'circle') {
    return pointInEllipseLocal(lp.x, lp.y, shape) ? shape.id : null;
  }
  // Text on a path sits ON its baseline, so glyphs running along the TOP of an ellipse are
  // drawn above the shape's own box. Testing the bare box means clicking the text you can
  // actually see misses the shape entirely - it reads as "the text can't be selected or
  // edited". Grow the target by a line so the glyphs are inside it.
  if (isTextOnPath(shape)) {
    const pad = (shape.textStyle?.fontSize ?? 16) * 1.5;
    return pointInRect(lp.x, lp.y, {
      x: shape.x - pad, y: shape.y - pad,
      width: shape.width + pad * 2, height: shape.height + pad * 2,
    }) ? shape.id : null;
  }
  return pointInRect(lp.x, lp.y, { x: shape.x, y: shape.y, width: shape.width, height: shape.height })
    ? shape.id : null;
}

// Rotate a document-space point into a shape's local (un-rotated) frame,
// pivoting around the shape's center.
function toLocal(x: number, y: number, shape: Shape): { x: number; y: number } {
  if (!shape.rotation) return { x, y };
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;
  const rad = (-shape.rotation * Math.PI) / 180;
  const dx = x - cx, dy = y - cy;
  return {
    x: cx + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: cy + dx * Math.sin(rad) + dy * Math.cos(rad),
  };
}

export function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

// Ellipse test in the shape's local space (point already un-rotated).
function pointInEllipseLocal(x: number, y: number, shape: Shape): boolean {
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;
  const rx = shape.width / 2;
  const ry = shape.height / 2;
  if (rx === 0 || ry === 0) return false;
  const dx = x - cx;
  const dy = y - cy;
  return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
}

// Hit-test handles of selected shapes. Returns { shapeId, handleIndex } or null.
// handleIndex 0–7 = resize handles, 8 = rotate handle.
// All coords are in SCREEN space (handles are drawn at fixed screen size).
export function getHandleAt(
  screenX: number,
  screenY: number,
  selectedIds: Set<string>,
  page: Page,
  viewport: Viewport,
): { shapeId: string; handleIndex: number } | null {
  const HIT_RADIUS = 7; // screen pixels

  // Multi-selection uses a single union box whose handles are DOM elements in the overlay
  // (they own their own mousedown). Skip per-shape hit-testing so a click inside the group
  // doesn't grab one shape's handle.
  if (selectedIds.size > 1) return null;

  for (const id of selectedIds) {
    const shape = page.objects[id];
    if (!shape) continue;

    // Convert selrect to screen space
    const sr = shape.selrect;
    const screenSelrect = {
      x: sr.x * viewport.zoom + viewport.x,
      y: sr.y * viewport.zoom + viewport.y,
      width: sr.width * viewport.zoom,
      height: sr.height * viewport.zoom,
    };

    // The overlay draws handles rotated around the shape's centre. Un-rotate the test point
    // into that same (axis-aligned) frame so every test below works for rotated shapes too.
    const ccx = screenSelrect.x + screenSelrect.width / 2;
    const ccy = screenSelrect.y + screenSelrect.height / 2;
    let px = screenX, py = screenY;
    if (shape.rotation) {
      const a = (-shape.rotation * Math.PI) / 180;
      const dx = screenX - ccx, dy = screenY - ccy;
      px = ccx + dx * Math.cos(a) - dy * Math.sin(a);
      py = ccy + dx * Math.sin(a) + dy * Math.cos(a);
    }

    // Rotate handle — fixed offset above TC in screen space
    const rotateSX = screenSelrect.x + screenSelrect.width / 2;
    const rotateSY = screenSelrect.y - ROTATE_OFFSET;
    const rdx = px - rotateSX;
    const rdy = py - rotateSY;
    if (rdx * rdx + rdy * rdy <= HIT_RADIUS * HIT_RADIUS) {
      return { shapeId: id, handleIndex: ROTATE_HANDLE };
    }

    // 8 resize handles in screen space
    const handles = getHandlePositions(screenSelrect);
    for (let i = 0; i < handles.length; i++) {
      const [hx, hy] = handles[i];
      const dx = px - hx;
      const dy = py - hy;
      if (dx * dx + dy * dy <= HIT_RADIUS * HIT_RADIUS) {
        return { shapeId: id, handleIndex: i };
      }
    }

    // Rotate zones — just OUTSIDE each corner (Figma-style: hover a corner from outside to
    // rotate). Only when the point is beyond the resize handle but within ROTATE_ZONE, and
    // outside the selection box, so it never competes with resize or moving the shape.
    const ROTATE_ZONE = 18;
    const inBox = px >= screenSelrect.x && px <= screenSelrect.x + screenSelrect.width
               && py >= screenSelrect.y && py <= screenSelrect.y + screenSelrect.height;
    if (!inBox) {
      const corners = [
        [screenSelrect.x, screenSelrect.y],
        [screenSelrect.x + screenSelrect.width, screenSelrect.y],
        [screenSelrect.x + screenSelrect.width, screenSelrect.y + screenSelrect.height],
        [screenSelrect.x, screenSelrect.y + screenSelrect.height],
      ];
      for (const [cx, cy] of corners) {
        const dx = px - cx, dy = py - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > HIT_RADIUS * HIT_RADIUS && d2 <= ROTATE_ZONE * ROTATE_ZONE) {
          return { shapeId: id, handleIndex: ROTATE_HANDLE };
        }
      }
    }
  }
  return null;
}

// Marquee selection — Figma "touch" semantics: any candidate whose bounds INTERSECT the
// rect is selected. `candidateIds` restricts the pool (e.g. a frame's direct children, or
// the page's top-level nodes) so a marquee never reaches across the hierarchy.
export function hitTestMarquee(
  page: Page,
  marquee: Rect,
  candidateIds?: string[],
): string[] {
  const ids = candidateIds ?? Object.keys(page.objects);
  const result: string[] = [];
  for (const id of ids) {
    const shape = page.objects[id];
    if (!shape || shape.hidden || shape.locked) continue;
    const r = shape.selrect;
    const intersects =
      r.x < marquee.x + marquee.width &&
      r.x + r.width > marquee.x &&
      r.y < marquee.y + marquee.height &&
      r.y + r.height > marquee.y;
    if (intersects) result.push(id);
  }
  return result;
}
