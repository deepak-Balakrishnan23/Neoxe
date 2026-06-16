// Module-level cache of decoded images, keyed by imageId.
// Populated by Canvas.tsx as the file loads; read by exporters.
export const imageCache: Record<string, HTMLImageElement> = {};

export function loadImage(id: string, dataUrl: string) {
  if (imageCache[id]) return;
  const img = new Image();
  img.src = dataUrl;
  imageCache[id] = img;
}
