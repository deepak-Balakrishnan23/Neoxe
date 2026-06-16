// Shared mutable reference to the canvas viewport. Canvas.tsx writes here on
// every viewport change so that non-canvas components (e.g. frame preset panel)
// can read the current pan/zoom without prop drilling or store changes.
export interface Viewport { x: number; y: number; zoom: number; }

export let currentViewport: Viewport = { x: 40, y: 60, zoom: 1 };

export function syncViewport(vp: Viewport): void {
  currentViewport = vp;
}
