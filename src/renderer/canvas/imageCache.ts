// Module-level cache of decoded images, keyed by imageId.
// Populated by Canvas.tsx as the file loads; read by exporters.
export const imageCache: Record<string, HTMLImageElement> = {};

export function loadImage(id: string, dataUrl: string, onDecoded?: () => void) {
  if (imageCache[id]) return;
  const img = new Image();
  // Decode completes async — without a signal the (idle-gated) canvas loop would not
  // repaint, leaving the image blank until the next interaction.
  if (onDecoded) img.onload = onDecoded;
  img.src = dataUrl;
  imageCache[id] = img;
}
