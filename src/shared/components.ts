// ── Component helpers ─────────────────────────────────────────────────────────
// Component properties are declared per component, but a component SET shares them:
// swapping a variant must not drop the properties an instance had set. Resolution
// therefore looks at the whole set, not just the component the instance points at.

import { ComponentPropDef, DesignFile } from './types';

/**
 * The component properties an instance of `componentId` exposes: its own definitions,
 * plus any declared on its sibling variants (first declaration of a name wins).
 */
export function resolvePropDefs(file: DesignFile, componentId: string | undefined): ComponentPropDef[] {
  if (!componentId) return [];
  const comp = file.components[componentId];
  if (!comp) return [];
  const set = comp.setId ? file.componentSets?.[comp.setId] : null;
  if (!set) return comp.props ?? [];

  const out: ComponentPropDef[] = [];
  const seen = new Set<string>();
  const take = (defs?: ComponentPropDef[]) => {
    for (const d of defs ?? []) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      out.push(d);
    }
  };
  take(comp.props);
  take(file.components[set.defaultComponentId]?.props);
  for (const id of Object.keys(set.variants)) take(file.components[id]?.props);
  return out;
}
