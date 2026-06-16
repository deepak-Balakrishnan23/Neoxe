import { Shape } from '../../shared/types';

// Handle indices (matching getHandlePositions order):
//  0  1  2
//  7     3
//  6  5  4
// Index 8 = rotate handle (above index 1)

export const ROTATE_HANDLE = 8;
export const ROTATE_OFFSET = 20; // screen pixels above top-center

export function applyResizeDelta(
  original: Shape,
  handleIndex: number,
  dx: number,
  dy: number,
  lockAspect?: boolean,
): { x: number; y: number; width: number; height: number } {
  const rot = original.rotation || 0;
  const lock = lockAspect ?? false;
  if (!rot) return axisAlignedResize(original, handleIndex, dx, dy, lock);

  // Rotated resize: keep the opposite (anchor) corner fixed in document space.
  // 1. Un-rotate the document delta into the shape's local axes.
  const rad = (rot * Math.PI) / 180;
  const cosN = Math.cos(-rad), sinN = Math.sin(-rad);
  const ldx = dx * cosN - dy * sinN;
  const ldy = dx * sinN + dy * cosN;

  const oldCx = original.x + original.width / 2;
  const oldCy = original.y + original.height / 2;

  // 2. Apply the resize in local space relative to origin (0,0,w,h).
  const box = axisAlignedResize(
    { ...original, x: 0, y: 0 } as Shape, handleIndex, ldx, ldy, lock,
  );

  // 3. How far the center moved in local space.
  const dCenterLocalX = (box.x + box.width / 2) - original.width / 2;
  const dCenterLocalY = (box.y + box.height / 2) - original.height / 2;

  // 4. Rotate the center delta back into document space and reposition.
  const cosP = Math.cos(rad), sinP = Math.sin(rad);
  const newCx = oldCx + dCenterLocalX * cosP - dCenterLocalY * sinP;
  const newCy = oldCy + dCenterLocalX * sinP + dCenterLocalY * cosP;

  return {
    x: newCx - box.width / 2,
    y: newCy - box.height / 2,
    width: box.width,
    height: box.height,
  };
}

function axisAlignedResize(
  original: Shape,
  handleIndex: number,
  dx: number,
  dy: number,
  lockAspect: boolean,
): { x: number; y: number; width: number; height: number } {
  let { x, y, width, height } = original;
  const MIN = 1;

  switch (handleIndex) {
    case 0: // TL
      x += dx; y += dy; width -= dx; height -= dy;
      break;
    case 1: // TC
      y += dy; height -= dy;
      break;
    case 2: // TR
      y += dy; width += dx; height -= dy;
      break;
    case 3: // MR
      width += dx;
      break;
    case 4: // BR
      width += dx; height += dy;
      break;
    case 5: // BC
      height += dy;
      break;
    case 6: // BL
      x += dx; width -= dx; height += dy;
      break;
    case 7: // ML
      x += dx; width -= dx;
      break;
  }

  // Prevent flipping — clamp and compensate position
  if (width < MIN) {
    const over = MIN - width;
    if ([0, 6, 7].includes(handleIndex)) x -= over;
    width = MIN;
  }
  if (height < MIN) {
    const over = MIN - height;
    if ([0, 1, 2].includes(handleIndex)) y -= over;
    height = MIN;
  }

  // Aspect ratio lock: enforce uniform scale after free resize
  if (lockAspect && original.width > 0 && original.height > 0) {
    const ratio = original.width / original.height;
    const isCorner = [0, 2, 4, 6].includes(handleIndex);
    const isTopOrBottom = [1, 5].includes(handleIndex);
    const isLeftOrRight = [3, 7].includes(handleIndex);

    if (isCorner) {
      const scaleX = width / original.width;
      const scaleY = height / original.height;
      const scale = Math.max(Math.abs(scaleX), Math.abs(scaleY));
      const newW = Math.max(MIN, Math.round(original.width * scale));
      const newH = Math.max(MIN, Math.round(original.height * scale));
      // Anchor: opposite corner stays fixed
      if ([0, 6].includes(handleIndex)) x = original.x + original.width - newW;
      else x = original.x;
      if ([0, 2].includes(handleIndex)) y = original.y + original.height - newH;
      else y = original.y;
      width = newW; height = newH;
    } else if (isTopOrBottom) {
      const newW = Math.max(MIN, Math.round(height * ratio));
      x = original.x + (original.width - newW) / 2;
      width = newW;
    } else if (isLeftOrRight) {
      const newH = Math.max(MIN, Math.round(width / ratio));
      y = original.y + (original.height - newH) / 2;
      height = newH;
    }
  }

  return { x, y, width, height };
}

export function applyRotateDelta(
  original: Shape,
  centerX: number,
  centerY: number,
  startDocX: number,
  startDocY: number,
  currentDocX: number,
  currentDocY: number,
): number {
  const startAngle = Math.atan2(startDocY - centerY, startDocX - centerX);
  const currentAngle = Math.atan2(currentDocY - centerY, currentDocX - centerX);
  const delta = (currentAngle - startAngle) * (180 / Math.PI);
  return ((original.rotation + delta) % 360 + 360) % 360;
}

// Cursor names for each handle index
const HANDLE_CURSORS: Record<number, string> = {
  0: 'nwse-resize',
  1: 'ns-resize',
  2: 'nesw-resize',
  3: 'ew-resize',
  4: 'nwse-resize',
  5: 'ns-resize',
  6: 'nesw-resize',
  7: 'ew-resize',
  8: 'default', // rotate
};

export function handleCursor(index: number, rotation: number): string {
  if (index === 8) return 'default';
  // Rotate the cursor icon based on shape rotation
  const baseCursors = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize',
    'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'];
  return baseCursors[index] ?? 'default';
}

export function shapeCenterDoc(shape: Shape): { cx: number; cy: number } {
  return {
    cx: shape.x + shape.width / 2,
    cy: shape.y + shape.height / 2,
  };
}
