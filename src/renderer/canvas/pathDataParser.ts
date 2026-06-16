import { parsePath, absolutize, normalize, serialize } from 'path-data-parser';

export interface PathItem {
  key:  string;    // 'M' | 'L' | 'C' | 'Z' after normalize
  data: number[];
}

/** Parse d-string → normalized, absolute M/L/C/Z PathItem[]. Never throws. */
export function parseAndNormalize(d: string): PathItem[] {
  if (!d.trim()) return [];
  try {
    return normalize(absolutize(parsePath(d)));
  } catch {
    return [];
  }
}

/** Serialize PathItem[] → d-string. Never throws. */
export function serializePath(items: PathItem[]): string {
  if (!items.length) return '';
  try {
    return serialize(items);
  } catch {
    return '';
  }
}

/** Get the endpoint [x, y] of a PathItem, or null for Z. */
export function endpointOf(item: PathItem): [number, number] | null {
  switch (item.key) {
    case 'M': case 'L': return [item.data[0], item.data[1]];
    case 'C':            return [item.data[4], item.data[5]];
    default:             return null;
  }
}

/** The incoming bezier handle (cp2 for C). undefined for M/L/Z. */
export function incomingHandle(item: PathItem): [number, number] | undefined {
  return item.key === 'C' ? [item.data[2], item.data[3]] : undefined;
}
