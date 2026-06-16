import { DesignFile, ChangeSet, ChangeOp, Shape, Page, makeDefaultPage, ColorEntry, TypographyEntry, TextStyle, DesignToken, TokenType, Layout, VectorChildNode } from '../shared/types';
import { applyTokensToFile } from '../shared/tokens';
import { layoutFile, defaultFlexLayout, defaultGridLayout } from '../shared/layout';
import { applyAutoLayoutToPage } from '../shared/autoLayout';

function uid() { return Math.random().toString(36).slice(2, 10); }

// Properties propagated from master to instances (unless overridden)
const PROPAGATED_ATTRS = new Set([
  'fills', 'strokes', 'shadows', 'blur', 'opacity', 'blendMode',
  'textStyle', 'paragraphs', 'content', 'type',
]);

type InverseOp =
  | { op: 'set'; id: string; attr: string; val: unknown }
  | { op: 'setImage'; id: string; dataUrl: string | null }
  | { op: 'setVectorChild'; id: string; childId: string; attr: string; val: unknown }
  | { op: 'add'; shape: Shape }
  | { op: 'addTree'; rootId: string; shapes: Record<string, Shape> }
  | { op: 'del'; id: string }
  | { op: 'move'; id: string; parentId: string | null; index: number };

interface UndoEntry {
  pageId: string;
  inverseOps: InverseOp[];
}

// A complete editing session: the document plus its undo/redo history. Used to give
// each open tab fully isolated canvas/pages/history — the store stashes inactive tabs'
// sessions and swaps the active one in/out of the engine on tab switch.
export interface EngineSession {
  file: DesignFile | null;
  undoStack: unknown[];
  redoStack: unknown[];
}

function findVectorChild(children: VectorChildNode[], id: string): VectorChildNode | null {
  for (const c of children) {
    if (c.id === id) return c;
    if (c.type === 'vector-group' && c.children) {
      const f = findVectorChild(c.children, id);
      if (f) return f;
    }
  }
  return null;
}

function updateVectorChild(
  children: VectorChildNode[],
  childId: string,
  attr: string,
  val: unknown,
): { updated: VectorChildNode[]; found: boolean } {
  let found = false;
  const updated = children.map(c => {
    if (c.id === childId) { found = true; return { ...c, [attr]: val }; }
    if (c.type === 'vector-group' && c.children) {
      const r = updateVectorChild(c.children, childId, attr, val);
      if (r.found) { found = true; return { ...c, children: r.updated }; }
    }
    return c;
  });
  return { updated, found };
}

export class DocumentEngine {
  private file: DesignFile | null = null;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];

  load(file: DesignFile) {
    this.file = structuredClone(file);
    this.undoStack = [];
    this.redoStack = [];
  }

  // Snapshot the active session (document + history) so it can be parked while another
  // tab is edited.
  exportSession(): EngineSession {
    return {
      file: this.file ? structuredClone(this.file) : null,
      undoStack: structuredClone(this.undoStack),
      redoStack: structuredClone(this.redoStack),
    };
  }

  // Make a previously-exported session the active one.
  loadSession(session: EngineSession) {
    this.file = session.file ? structuredClone(session.file) : null;
    this.undoStack = structuredClone(session.undoStack ?? []) as UndoEntry[];
    this.redoStack = structuredClone(session.redoStack ?? []) as UndoEntry[];
  }

  getState(): DesignFile | null {
    return this.file ? structuredClone(this.file) : null;
  }

  applyChanges(changeSet: ChangeSet) {
    if (!this.file) throw new Error('no file loaded');
    const page = this.file.pages.find(p => p.id === changeSet.pageId);
    if (!page) throw new Error(`page ${changeSet.pageId} not found`);
    const inverseOps: InverseOp[] = [];
    const masterChanges: { shapeId: string; attr: string; val: unknown }[] = [];

    for (const op of changeSet.ops) {
      const inv = this.applyOp(page, op);
      if (inv) inverseOps.unshift(inv);
      // Track changes to master components for propagation
      if (op.op === 'set') {
        const shape = page.objects[op.id];
        if (shape?.componentId && PROPAGATED_ATTRS.has(op.attr)) {
          masterChanges.push({ shapeId: op.id, attr: op.attr, val: op.val });
        }
        // If this is an instance being edited, mark the attr as overridden
        if (shape?.masterId && PROPAGATED_ATTRS.has(op.attr)) {
          shape.overrides = { ...(shape.overrides ?? {}), [op.attr]: op.val };
        }
      }
    }

    // Propagate master changes to all instances across all pages
    for (const { shapeId, attr, val } of masterChanges) {
      const masterShape = page.objects[shapeId];
      if (!masterShape?.componentId) continue;
      const componentId = masterShape.componentId;
      for (const p of this.file.pages) {
        for (const s of Object.values(p.objects)) {
          if (s.masterId === componentId) {
            // Only propagate if the instance hasn't locally overridden this attr.
            // Clone non-primitive values so instances don't share mutable arrays.
            if (!(s.overrides ?? {})[attr]) {
              (s as Record<string, unknown>)[attr] =
                (val && typeof val === 'object') ? structuredClone(val) : val;
            }
          }
        }
      }
    }

    // Re-run auto-layout so any layout frames reflow their children
    layoutFile(page);
    // After flex/grid pass, run Figma-style Auto Layout. Loop until stable in case a
    // hug parent's resize cascades up through nested auto-layout containers.
    for (let i = 0; i < 6; i++) { if (!applyAutoLayoutToPage(page)) break; }

    this.undoStack.push({ pageId: changeSet.pageId, inverseOps });
    this.redoStack = [];
  }

  undo() {
    if (!this.file || !this.undoStack.length) return;
    const entry = this.undoStack.pop()!;
    const page = this.file.pages.find(p => p.id === entry.pageId);
    if (!page) return;
    const redoOps: InverseOp[] = [];
    for (const op of entry.inverseOps) {
      const inv = this.applyOp(page, op);
      if (inv) redoOps.unshift(inv);
    }
    this.redoStack.push({ pageId: entry.pageId, inverseOps: redoOps });
  }

  // ── Page management (not change-op based — file-level mutations) ────────────

  addPage(): DesignFile | null {
    if (!this.file) return null;
    const id = uid();
    const page = makeDefaultPage(id, `Page ${this.file.pages.length + 1}`);
    this.file.pages.push(page);
    this.file.activePageId = id;
    return structuredClone(this.file);
  }

  deletePage(pageId: string): DesignFile | null {
    if (!this.file || this.file.pages.length <= 1) return null;
    const idx = this.file.pages.findIndex(p => p.id === pageId);
    if (idx === -1) return null;
    this.file.pages.splice(idx, 1);
    if (this.file.activePageId === pageId) {
      this.file.activePageId = this.file.pages[Math.max(0, idx - 1)].id;
    }
    return structuredClone(this.file);
  }

  switchPage(pageId: string): DesignFile | null {
    if (!this.file) return null;
    if (!this.file.pages.find(p => p.id === pageId)) return null;
    this.file.activePageId = pageId;
    return structuredClone(this.file);
  }

  // ── Component management ──────────────────────────────────────────────────

  createComponent(shapeId: string, pageId: string): DesignFile | null {
    if (!this.file) return null;
    const page = this.file.pages.find(p => p.id === pageId);
    if (!page) return null;
    const shape = page.objects[shapeId];
    if (!shape) return null;
    const componentId = uid();
    shape.componentId = componentId;
    this.file.components[componentId] = { name: shape.name, pageId, shapeId };
    return structuredClone(this.file);
  }

  createInstance(componentId: string, pageId: string, x: number, y: number): DesignFile | null {
    if (!this.file) return null;
    const comp = this.file.components[componentId];
    if (!comp) return null;
    const masterPage = this.file.pages.find(p => p.id === comp.pageId);
    if (!masterPage) return null;
    const master = masterPage.objects[comp.shapeId];
    if (!master) return null;
    const targetPage = this.file.pages.find(p => p.id === pageId);
    if (!targetPage) return null;

    const instanceId = uid();
    const instance: Shape = {
      ...structuredClone(master),
      id: instanceId,
      x, y,
      masterId: componentId,
      componentId: undefined,
      overrides: {},
      selrect: { x, y, width: master.width, height: master.height },
    };
    // Reset childIds (instances don't replicate master's children hierarchy for now)
    instance.childIds = [];
    instance.parentId = null;
    targetPage.objects[instanceId] = instance;
    targetPage.childIds.push(instanceId);
    return structuredClone(this.file);
  }

  detachInstance(shapeId: string, pageId: string): DesignFile | null {
    if (!this.file) return null;
    const page = this.file.pages.find(p => p.id === pageId);
    if (!page) return null;
    const shape = page.objects[shapeId];
    if (!shape?.masterId) return null;
    // Apply all master properties (resolve) then detach
    const comp = this.file.components[shape.masterId];
    if (comp) {
      const masterPage = this.file.pages.find(p => p.id === comp.pageId);
      const master = masterPage?.objects[comp.shapeId];
      if (master) {
        for (const attr of PROPAGATED_ATTRS) {
          if (!(shape.overrides ?? {})[attr]) {
            // Deep-clone so the detached shape doesn't share the master's arrays.
            const v = (master as Record<string, unknown>)[attr];
            (shape as Record<string, unknown>)[attr] = (v && typeof v === 'object') ? structuredClone(v) : v;
          }
        }
      }
    }
    shape.masterId = undefined;
    shape.overrides = undefined;
    return structuredClone(this.file);
  }

  resetOverrides(shapeId: string, pageId: string): DesignFile | null {
    if (!this.file) return null;
    const page = this.file.pages.find(p => p.id === pageId);
    if (!page) return null;
    const shape = page.objects[shapeId];
    if (!shape?.masterId) return null;
    shape.overrides = {};
    return structuredClone(this.file);
  }

  renameFile(name: string): DesignFile | null {
    if (!this.file) return null;
    this.file.name = name.trim() || 'Untitled';
    return structuredClone(this.file);
  }

  // ── Prototype ─────────────────────────────────────────────────────────────

  setPrototypeStart(frameId: string): DesignFile | null {
    if (!this.file) return null;
    this.file.prototypeStartFrameId = frameId;
    return structuredClone(this.file);
  }

  // ── Auto-layout ───────────────────────────────────────────────────────────

  setLayout(shapeId: string, pageId: string, kind: 'flex' | 'grid' | null): DesignFile | null {
    if (!this.file) return null;
    const page = this.file.pages.find(p => p.id === pageId);
    const shape = page?.objects[shapeId];
    if (!shape || !page) return null;
    if (kind === null) {
      shape.layout = null;
    } else if (kind === 'flex') {
      shape.layout = defaultFlexLayout();
    } else {
      shape.layout = defaultGridLayout();
    }
    layoutFile(page);
    // After flex/grid pass, run Figma-style Auto Layout. Loop until stable in case a
    // hug parent's resize cascades up through nested auto-layout containers.
    for (let i = 0; i < 6; i++) { if (!applyAutoLayoutToPage(page)) break; }
    return structuredClone(this.file);
  }

  updateLayout(shapeId: string, pageId: string, patch: Partial<Layout>): DesignFile | null {
    if (!this.file) return null;
    const page = this.file.pages.find(p => p.id === pageId);
    const shape = page?.objects[shapeId];
    if (!shape?.layout || !page) return null;
    shape.layout = { ...shape.layout, ...patch } as Layout;
    layoutFile(page);
    // After flex/grid pass, run Figma-style Auto Layout. Loop until stable in case a
    // hug parent's resize cascades up through nested auto-layout containers.
    for (let i = 0; i < 6; i++) { if (!applyAutoLayoutToPage(page)) break; }
    return structuredClone(this.file);
  }

  // ── Design tokens ───────────────────────────────────────────────────────────

  addToken(name: string, type: TokenType, value: string | number): DesignFile | null {
    if (!this.file) return null;
    this.file.tokens.push({ id: uid(), name, $type: type, $value: value });
    applyTokensToFile(this.file);
    return structuredClone(this.file);
  }

  updateToken(id: string, patch: Partial<DesignToken>): DesignFile | null {
    if (!this.file) return null;
    const idx = this.file.tokens.findIndex(t => t.id === id);
    if (idx === -1) return null;
    this.file.tokens[idx] = { ...this.file.tokens[idx], ...patch };
    applyTokensToFile(this.file);
    return structuredClone(this.file);
  }

  deleteToken(id: string): DesignFile | null {
    if (!this.file) return null;
    this.file.tokens = this.file.tokens.filter(t => t.id !== id);
    return structuredClone(this.file);
  }

  // Bind a token to a shape property path, then resolve.
  bindToken(shapeId: string, pageId: string, path: string, tokenName: string): DesignFile | null {
    if (!this.file) return null;
    const page = this.file.pages.find(p => p.id === pageId);
    const shape = page?.objects[shapeId];
    if (!shape) return null;
    shape.tokenBindings = { ...(shape.tokenBindings ?? {}), [path]: tokenName };
    applyTokensToFile(this.file);
    return structuredClone(this.file);
  }

  unbindToken(shapeId: string, pageId: string, path: string): DesignFile | null {
    if (!this.file) return null;
    const page = this.file.pages.find(p => p.id === pageId);
    const shape = page?.objects[shapeId];
    if (!shape?.tokenBindings) return null;
    const next = { ...shape.tokenBindings };
    delete next[path];
    shape.tokenBindings = next;
    return structuredClone(this.file);
  }

  switchTheme(themeId: string): DesignFile | null {
    if (!this.file) return null;
    this.file.activeThemeId = themeId;
    applyTokensToFile(this.file);
    return structuredClone(this.file);
  }

  // ── Color library ─────────────────────────────────────────────────────────

  addColor(name: string, color: string, opacity: number): DesignFile | null {
    if (!this.file) return null;
    this.file.colors.push({ id: uid(), name, color, opacity });
    return structuredClone(this.file);
  }

  updateColor(id: string, patch: Partial<ColorEntry>): DesignFile | null {
    if (!this.file) return null;
    const idx = this.file.colors.findIndex(c => c.id === id);
    if (idx === -1) return null;
    this.file.colors[idx] = { ...this.file.colors[idx], ...patch };
    return structuredClone(this.file);
  }

  deleteColor(id: string): DesignFile | null {
    if (!this.file) return null;
    this.file.colors = this.file.colors.filter(c => c.id !== id);
    return structuredClone(this.file);
  }

  // ── Typography library ─────────────────────────────────────────────────────

  addTypography(name: string, style: Partial<TextStyle>): DesignFile | null {
    if (!this.file) return null;
    this.file.typographies.push({ id: uid(), name, style });
    return structuredClone(this.file);
  }

  deleteTypography(id: string): DesignFile | null {
    if (!this.file) return null;
    this.file.typographies = this.file.typographies.filter(t => t.id !== id);
    return structuredClone(this.file);
  }

  renamePage(pageId: string, name: string): DesignFile | null {
    if (!this.file) return null;
    const page = this.file.pages.find(p => p.id === pageId);
    if (!page) return null;
    page.name = name;
    return structuredClone(this.file);
  }

  setPageBackground(pageId: string, color: string): DesignFile | null {
    if (!this.file) return null;
    const page = this.file.pages.find(p => p.id === pageId);
    if (!page) return null;
    page.background = color;
    return structuredClone(this.file);
  }

  redo() {
    if (!this.file || !this.redoStack.length) return;
    const entry = this.redoStack.pop()!;
    const page = this.file.pages.find(p => p.id === entry.pageId);
    if (!page) return;
    const undoOps: InverseOp[] = [];
    for (const op of entry.inverseOps) {
      const inv = this.applyOp(page, op);
      if (inv) undoOps.unshift(inv);
    }
    this.undoStack.push({ pageId: entry.pageId, inverseOps: undoOps });
  }

  private applyOp(page: Page, op: ChangeOp | InverseOp): InverseOp | null {
    switch (op.op) {
      case 'set': {
        const shape = page.objects[op.id];
        if (!shape) return null;
        const prev = (shape as Record<string, unknown>)[op.attr];
        (shape as Record<string, unknown>)[op.attr] = op.val;
        shape.selrect = { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
        return { op: 'set', id: op.id, attr: op.attr, val: prev };
      }
      case 'setImage': {
        if (!this.file) return null;
        const prev = this.file.images[op.id] ?? null;
        if (op.dataUrl === null) delete this.file.images[op.id];
        else this.file.images[op.id] = op.dataUrl;
        return { op: 'setImage', id: op.id, dataUrl: prev };
      }
      case 'setVectorChild': {
        const shape = page.objects[op.id];
        if (!shape || !shape.vectorChildren) return null;
        const prev = findVectorChild(shape.vectorChildren, op.childId);
        if (!prev) return null;
        const prevVal = (prev as Record<string, unknown>)[op.attr];
        const { updated, found } = updateVectorChild(shape.vectorChildren, op.childId, op.attr, op.val);
        if (!found) return null;
        shape.vectorChildren = updated;
        return { op: 'setVectorChild', id: op.id, childId: op.childId, attr: op.attr, val: prevVal };
      }
      case 'add': {
        page.objects[op.shape.id] = structuredClone(op.shape);
        const parent = op.shape.parentId ? page.objects[op.shape.parentId] : null;
        if (parent) { if (!parent.childIds.includes(op.shape.id)) parent.childIds.push(op.shape.id); }
        else { if (!page.childIds.includes(op.shape.id)) page.childIds.push(op.shape.id); }
        recomputeFrameId(page, op.shape.id);
        return { op: 'del', id: op.shape.id };
      }
      case 'addTree': {
        const root = op.shapes[op.rootId];
        if (!root) return null;
        for (const shape of Object.values(op.shapes)) {
          page.objects[shape.id] = structuredClone(shape);
        }
        const parent = root.parentId ? page.objects[root.parentId] : null;
        if (parent) { if (!parent.childIds.includes(root.id)) parent.childIds.push(root.id); }
        else { if (!page.childIds.includes(root.id)) page.childIds.push(root.id); }
        recomputeFrameId(page, root.id);
        return { op: 'del', id: root.id };
      }
      case 'del': {
        const shape = page.objects[op.id];
        if (!shape) return null;
        const subtree = cloneSubtree(page, op.id);
        const parent = shape.parentId ? page.objects[shape.parentId] : null;
        if (parent) parent.childIds = parent.childIds.filter(id => id !== op.id);
        else page.childIds = page.childIds.filter(id => id !== op.id);
        for (const id of Object.keys(subtree)) delete page.objects[id];
        return { op: 'addTree', rootId: op.id, shapes: subtree };
      }
      case 'move': {
        const shape = page.objects[op.id];
        if (!shape) return null;
        if (op.parentId === op.id || (op.parentId && isDescendant(page, op.parentId, op.id))) {
          return null;
        }
        const prevParentId = shape.parentId;
        const prevParent = prevParentId ? page.objects[prevParentId] : null;
        const prevIndex = prevParent ? prevParent.childIds.indexOf(op.id) : page.childIds.indexOf(op.id);
        if (prevParent) prevParent.childIds = prevParent.childIds.filter(id => id !== op.id);
        else page.childIds = page.childIds.filter(id => id !== op.id);
        shape.parentId = op.parentId;
        const newParent = op.parentId ? page.objects[op.parentId] : null;
        if (newParent) newParent.childIds.splice(op.index, 0, op.id);
        else page.childIds.splice(op.index, 0, op.id);
        // Recompute the nearest-ancestor-frame cache for the moved subtree.
        recomputeFrameId(page, op.id);
        return { op: 'move', id: op.id, parentId: prevParentId, index: prevIndex };
      }
    }
  }
}

function cloneSubtree(page: Page, rootId: string): Record<string, Shape> {
  const out: Record<string, Shape> = {};
  const visit = (id: string) => {
    const shape = page.objects[id];
    if (!shape || out[id]) return;
    out[id] = structuredClone(shape);
    for (const childId of shape.childIds) visit(childId);
  };
  visit(rootId);
  return out;
}

function isDescendant(page: Page, id: string, ancestorId: string): boolean {
  let current = page.objects[id]?.parentId ?? null;
  while (current) {
    if (current === ancestorId) return true;
    current = page.objects[current]?.parentId ?? null;
  }
  return false;
}

// Recompute frameId (nearest ancestor frame, else page) for a shape + its subtree.
function recomputeFrameId(page: Page, id: string) {
  const shape = page.objects[id];
  if (!shape) return;
  if (shape.type === 'frame') {
    shape.frameId = shape.id;
  } else {
    let frameId = page.id;
    let pid = shape.parentId;
    while (pid) {
      const p = page.objects[pid];
      if (!p) break;
      if (p.type === 'frame') { frameId = pid; break; }
      pid = p.parentId;
    }
    shape.frameId = frameId;
  }
  for (const childId of shape.childIds) recomputeFrameId(page, childId);
}
