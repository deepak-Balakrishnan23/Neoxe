// ── Resize constraints ────────────────────────────────────────────────────────
// Figma's model for what happens to a container's children when the container is
// resized. Each child pins one of five behaviours per axis, measured against the
// container's box BEFORE the resize:
//
//   min     keep the gap to the left/top edge          (Figma "Left" / "Top")
//   max     keep the gap to the right/bottom edge      (Figma "Right" / "Bottom")
//   stretch keep BOTH gaps — the child resizes          (Figma "Left and right")
//   center  keep the offset from the container's centre (Figma "Center")
//   scale   scale the offset AND the size proportionally
//
// Pure: `constraintOps` reads the page and returns plain `set` ops, so the document
// engine can fold them into the same changeset as the resize itself — which is what
// makes undo exact rather than a re-derivation.

import { Shape, Rect, ChangeOp, ConstraintMode, Constraints } from './types';

export type { ConstraintMode, Constraints };

export const DEFAULT_CONSTRAINTS: Constraints = { horizontal: 'min', vertical: 'min' };

// Resolve one axis. All values are absolute document coordinates.
// p0/p1 = container start (before/after), s0/s1 = container size (before/after),
// c = child start, cs = child size.
function resolveAxis(
  mode: ConstraintMode,
  p0: number, s0: number, p1: number, s1: number,
  c: number, cs: number,
): { start: number; size: number } {
  const lead = c - p0;                 // gap to the min edge
  const trail = (p0 + s0) - (c + cs);  // gap to the max edge
  switch (mode) {
    case 'max':
      return { start: p1 + s1 - trail - cs, size: cs };
    case 'stretch':
      return { start: p1 + lead, size: Math.max(0, s1 - lead - trail) };
    case 'center': {
      const offset = (c + cs / 2) - (p0 + s0 / 2);
      return { start: p1 + s1 / 2 + offset - cs / 2, size: cs };
    }
    case 'scale': {
      // A zero-size container has no ratio to scale by — fall back to pinning the lead
      // gap so the child stays somewhere sane instead of collapsing onto the origin.
      const k = s0 === 0 ? 1 : s1 / s0;
      return { start: p1 + lead * k, size: cs * k };
    }
    case 'min':
    default:
      return { start: p1 + lead, size: cs };
  }
}

/**
 * `set` ops repositioning/resizing every descendant of `containerId` for a resize from
 * `before` to `after`. Recurses: a child that itself changes size re-lays its own children.
 *
 * Children the auto-layout engine owns are skipped — auto layout places them, and
 * running both would fight. Absolute-positioned children inside an auto-layout frame
 * are NOT owned by the engine, so they do follow their constraints (as in Figma).
 */
export function constraintOps(
  page: { objects: Record<string, Shape> },
  containerId: string,
  before: Rect,
  after: Rect,
): ChangeOp[] {
  const ops: ChangeOp[] = [];
  // Resize only. A container that merely moves carries its subtree rigidly (the engine's
  // move cascade); running constraints there too would move every child twice.
  if (before.width === after.width && before.height === after.height) return ops;

  const container = page.objects[containerId];
  if (!container) return ops;
  const ownedByAutoLayout = !!container.autoLayout;

  for (const childId of container.childIds) {
    const child = page.objects[childId];
    if (!child) continue;
    if (ownedByAutoLayout && child.layoutPositioning !== 'absolute') continue;

    const con = child.constraints ?? DEFAULT_CONSTRAINTS;
    const h = resolveAxis(con.horizontal, before.x, before.width, after.x, after.width, child.x, child.width);
    const v = resolveAxis(con.vertical, before.y, before.height, after.y, after.height, child.y, child.height);

    const nx = Math.round(h.start), ny = Math.round(v.start);
    const nw = Math.max(0, Math.round(h.size)), nh = Math.max(0, Math.round(v.size));

    if (nx !== child.x) ops.push({ op: 'set', id: childId, attr: 'x', val: nx });
    if (ny !== child.y) ops.push({ op: 'set', id: childId, attr: 'y', val: ny });
    if (nw !== child.width) ops.push({ op: 'set', id: childId, attr: 'width', val: nw });
    if (nh !== child.height) ops.push({ op: 'set', id: childId, attr: 'height', val: nh });

    if (child.childIds.length > 0) {
      ops.push(...constraintOps(
        page, childId,
        { x: child.x, y: child.y, width: child.width, height: child.height },
        { x: nx, y: ny, width: nw, height: nh },
      ));
    }
  }
  return ops;
}
