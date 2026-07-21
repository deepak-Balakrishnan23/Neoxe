import { DesignFile, ChangeSet, ChangeOp, Shape, Page, makeDefaultPage, ColorEntry, TextStyle, DesignToken, TokenType, VectorChildNode } from '../shared/types';
import { applyTokensToFile } from '../shared/tokens';
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
  // Master attrs whose instance propagation must be replayed after the ops are
  // (un)applied. Propagation mutates instances (possibly on other pages) without
  // inverse ops; it's deterministic from the master's current value, so undo/redo
  // re-run it after restoring the master instead of recording per-instance inverses.
  propagations?: { shapeId: string; attr: string }[];
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
  // The last snapshot handed to the UI. Used for structural sharing: an incremental snapshot
  // reuses this one's unchanged shape/page objects by reference (see incrementalSnapshot).
  private lastSnapshot: DesignFile | null = null;

  load(file: DesignFile) {
    this.file = structuredClone(file);
    this.undoStack = [];
    this.redoStack = [];
    this.lastSnapshot = null;
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
    this.lastSnapshot = null;
  }

  getState(): DesignFile | null {
    return this.file ? this.snapshot() : null;
  }

  // UI snapshot: deep-clone everything EXCEPT the images map, which is shared by reference.
  // Image values are large base64 data-URLs and are effectively immutable, so cloning the
  // whole map on every edit dominated the hot path (a drag = ~60 full-document clones/sec).
  // Safe because: (a) the top-level object still gets a fresh identity, so React re-renders;
  // (b) the id-keyed image cache (loadImage) picks up new images regardless of map identity;
  // (c) nothing compares images-map identity to detect changes; (d) undo replays ops, it
  // doesn't hold file snapshots. Session parking (exportSession) still deep-clones fully for
  // true tab isolation.
  private snapshot(): DesignFile {
    const file = this.file!;
    const { images, ...rest } = file;
    const clone = structuredClone(rest) as DesignFile;
    clone.images = images;
    this.lastSnapshot = clone;
    return clone;
  }

  // Structural-sharing snapshot for the hot path (pure `set` edits: drag/resize/color/text).
  // Only the shapes named in `touched` are cloned; every other shape/page keeps the SAME
  // object reference as the previous snapshot. That lets React (and the per-row layer
  // selectors) skip everything that didn't change, instead of every shape getting a fresh
  // identity on every edit. Callers guarantee this is only used when the change is a pure
  // set with no structural ops, no component propagation, and no auto-layout reflow — so the
  // touched set is provably complete and reuse is safe. Falls back to a full snapshot() if
  // there's no prior snapshot to share from.
  private incrementalSnapshot(pageId: string, touched: Set<string>): DesignFile {
    const prev = this.lastSnapshot;
    if (!prev) return this.snapshot();
    const file = this.file!;
    const pages = file.pages.map(p => {
      const prevPage = prev.pages.find(pp => pp.id === p.id);
      // Untouched page → reuse the previous snapshot's (already-isolated) page object.
      if (p.id !== pageId || !prevPage) {
        return prevPage ?? { ...p, objects: structuredClone(p.objects), childIds: [...p.childIds] };
      }
      // Touched page → new objects map; clone only touched (or newly-seen) shapes.
      const objects: Record<string, Shape> = {};
      for (const id in p.objects) {
        const prevObj = prevPage.objects[id];
        objects[id] = (touched.has(id) || !prevObj) ? structuredClone(p.objects[id]) : prevObj;
      }
      return { ...p, objects, childIds: [...p.childIds] };
    });
    // File-level fields (name/colors/tokens/components/…) are unchanged by a shape set, so
    // they're shared by reference — same immutability contract as `images` (see snapshot()).
    const snap: DesignFile = { ...file, pages, images: file.images };
    this.lastSnapshot = snap;
    return snap;
  }

  applyChanges(changeSet: ChangeSet): DesignFile {
    if (!this.file) throw new Error('no file loaded');
    const page = this.file.pages.find(p => p.id === changeSet.pageId);
    if (!page) throw new Error(`page ${changeSet.pageId} not found`);
    const inverseOps: InverseOp[] = [];
    const masterChanges: { shapeId: string; attr: string }[] = [];

    // Rigid-body cascade (flat coordinate model, Figma-equivalent visuals): moving or
    // rotating a container carries its whole subtree. Every entry point (panel X/Y/R
    // inputs, canvas rotate drag, group rotate) sends plain `set` ops for the CONTAINER
    // only; the engine expands them here into descendant position/rotation ops so
    // behaviour — and undo — is identical everywhere. Callers must NOT send their own
    // descendant ops for these attrs (they'd be applied twice). The auto layout engine
    // NEVER writes rotation and mutates bounds directly, so it bypasses this entirely.
    const ops: ChangeOp[] = [...changeSet.ops];
    {
      // Collect each container's combined (dx, dy, dRot) from this changeset, measured
      // against CURRENT state (before any op applies).
      const tx = new Map<string, { dx: number; dy: number; dRot: number }>();
      // A changeset that RESIZES a shape may also set its x/y (dragging a left/top
      // handle) — that x/y shift repositions the frame's edge, children stay put
      // (Figma resize semantics). Only pure moves/rotations carry the subtree.
      const resized = new Set(changeSet.ops
        .flatMap(o => (o.op === 'set' && (o.attr === 'width' || o.attr === 'height')) ? [o.id] : []));
      for (const op of changeSet.ops) {
        if (op.op !== 'set' || (op.attr !== 'x' && op.attr !== 'y' && op.attr !== 'rotation')) continue;
        const s = page.objects[op.id];
        if (!s || s.childIds.length === 0 || typeof op.val !== 'number') continue;
        if (resized.has(op.id) && op.attr !== 'rotation') continue;
        const t = tx.get(op.id) ?? { dx: 0, dy: 0, dRot: 0 };
        if (op.attr === 'x') t.dx = op.val - s.x;
        else if (op.attr === 'y') t.dy = op.val - s.y;
        else t.dRot = op.val - s.rotation;
        tx.set(op.id, t);
      }
      for (const [cid, t] of tx) {
        if (!t.dx && !t.dy && !t.dRot) continue;
        const s = page.objects[cid]!;
        const pcx = s.x + s.width / 2, pcy = s.y + s.height / 2;
        const rad = (t.dRot * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        const walk = (id: string) => {
          const sh = page.objects[id];
          if (!sh) return;
          for (const chId of sh.childIds) {
            const c = page.objects[chId];
            if (!c) continue;
            // Rotate the child's centre about the container's (old) centre, then apply
            // the container's translation — one rigid transform for the whole subtree.
            const ccx = c.x + c.width / 2, ccy = c.y + c.height / 2;
            const nx = pcx + (ccx - pcx) * cos - (ccy - pcy) * sin + t.dx;
            const ny = pcy + (ccx - pcx) * sin + (ccy - pcy) * cos + t.dy;
            ops.push({ op: 'set', id: chId, attr: 'x', val: Math.round(nx - c.width / 2) });
            ops.push({ op: 'set', id: chId, attr: 'y', val: Math.round(ny - c.height / 2) });
            if (t.dRot) ops.push({ op: 'set', id: chId, attr: 'rotation', val: Math.round((((c.rotation + t.dRot) % 360) + 360) % 360) });
            walk(chId);
          }
        };
        walk(cid);
      }
    }

    for (const op of ops) {
      const inv = this.applyOp(page, op);
      if (inv) inverseOps.unshift(inv);
      // Track changes to master components for propagation
      if (op.op === 'set') {
        const shape = page.objects[op.id];
        if (shape?.componentId && PROPAGATED_ATTRS.has(op.attr)) {
          masterChanges.push({ shapeId: op.id, attr: op.attr });
        }
        // If this is an instance being edited, mark the attr as overridden. Record an
        // inverse restoring the PREVIOUS overrides map — without it, undoing the edit
        // reverts the value but leaves the override flag set, permanently blocking
        // future master updates for that attr on this instance.
        if (shape?.masterId && PROPAGATED_ATTRS.has(op.attr)) {
          inverseOps.unshift({ op: 'set', id: op.id, attr: 'overrides', val: shape.overrides ? { ...shape.overrides } : undefined });
          shape.overrides = { ...(shape.overrides ?? {}), [op.attr]: op.val };
        }
      }
    }

    // Propagate master changes to all instances across all pages
    for (const { shapeId, attr } of masterChanges) this.propagateMasterAttr(page, shapeId, attr);

    // Re-run Figma-style Auto Layout so containers reflow their children.
    const autoLayoutChanged = this.reflow(page);

    // Don't record a no-op changeset (every op missed its target) — it would make undo
    // silently do nothing and cost the user extra ⌘Z presses to reach a real edit.
    if (inverseOps.length > 0) {
      this.undoStack.push({
        pageId: changeSet.pageId,
        inverseOps,
        propagations: masterChanges.length ? masterChanges : undefined,
      });
      this.redoStack = [];
    }

    // Choose the snapshot strategy. The incremental (structural-sharing) path is only safe
    // when the touched set is provably complete: a pure `set`/`setVectorChild` change (no
    // add/del/move that reshuffles childIds), no component propagation (which mutates
    // instances on other pages), and no auto-layout reflow (which moves shapes not named in
    // the ops). Anything else → a full snapshot. `ops` includes the rigid-body cascade's
    // descendant `set` ops, so moving a parent still names every moved child.
    const touched = new Set<string>();
    let structural = false;
    for (const op of ops) {
      if (op.op === 'set' || op.op === 'setVectorChild') touched.add(op.id);
      else if (op.op === 'setImage') { /* images are shared by reference — nothing to track */ }
      else structural = true; // add / del / move reshuffles structure
    }
    const canShare = !structural && masterChanges.length === 0 && !autoLayoutChanged && this.lastSnapshot !== null;
    return canShare ? this.incrementalSnapshot(changeSet.pageId, touched) : this.snapshot();
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
    this.redoStack.push({ pageId: entry.pageId, inverseOps: redoOps, propagations: entry.propagations });
    this.replaySideEffects(page, entry.propagations);
  }

  // ── Page management (not change-op based — file-level mutations) ────────────

  addPage(): DesignFile | null {
    if (!this.file) return null;
    const id = uid();
    const page = makeDefaultPage(id, `Page ${this.file.pages.length + 1}`);
    this.file.pages.push(page);
    this.file.activePageId = id;
    return this.snapshot();
  }

  deletePage(pageId: string): DesignFile | null {
    if (!this.file || this.file.pages.length <= 1) return null;
    const idx = this.file.pages.findIndex(p => p.id === pageId);
    if (idx === -1) return null;
    this.file.pages.splice(idx, 1);
    if (this.file.activePageId === pageId) {
      this.file.activePageId = this.file.pages[Math.max(0, idx - 1)].id;
    }
    return this.snapshot();
  }

  switchPage(pageId: string): DesignFile | null {
    if (!this.file) return null;
    if (!this.file.pages.find(p => p.id === pageId)) return null;
    this.file.activePageId = pageId;
    return this.snapshot();
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
    return this.snapshot();
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
    return this.snapshot();
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
          if (!(attr in (shape.overrides ?? {}))) {
            // Deep-clone so the detached shape doesn't share the master's arrays.
            const v = (master as unknown as Record<string, unknown>)[attr];
            (shape as unknown as Record<string, unknown>)[attr] = (v && typeof v === 'object') ? structuredClone(v) : v;
          }
        }
      }
    }
    shape.masterId = undefined;
    shape.overrides = undefined;
    return this.snapshot();
  }

  resetOverrides(shapeId: string, pageId: string): DesignFile | null {
    if (!this.file) return null;
    const page = this.file.pages.find(p => p.id === pageId);
    if (!page) return null;
    const shape = page.objects[shapeId];
    if (!shape?.masterId) return null;
    shape.overrides = {};
    return this.snapshot();
  }

  renameFile(name: string): DesignFile | null {
    if (!this.file) return null;
    this.file.name = name.trim() || 'Untitled';
    return this.snapshot();
  }

  // ── Prototype ─────────────────────────────────────────────────────────────

  setPrototypeStart(frameId: string): DesignFile | null {
    if (!this.file) return null;
    this.file.prototypeStartFrameId = frameId;
    return this.snapshot();
  }

  // (Legacy flex/grid layout removed — Figma-style Auto Layout in shared/autoLayout.ts
  // is the single layout model; it reflows inside applyChanges above.)

  // ── Design tokens ───────────────────────────────────────────────────────────

  addToken(name: string, type: TokenType, value: string | number): DesignFile | null {
    if (!this.file) return null;
    this.file.tokens.push({ id: uid(), name, $type: type, $value: value });
    applyTokensToFile(this.file);
    return this.snapshot();
  }

  updateToken(id: string, patch: Partial<DesignToken>): DesignFile | null {
    if (!this.file) return null;
    const idx = this.file.tokens.findIndex(t => t.id === id);
    if (idx === -1) return null;
    this.file.tokens[idx] = { ...this.file.tokens[idx], ...patch };
    applyTokensToFile(this.file);
    return this.snapshot();
  }

  deleteToken(id: string): DesignFile | null {
    if (!this.file) return null;
    this.file.tokens = this.file.tokens.filter(t => t.id !== id);
    return this.snapshot();
  }

  // Bind a token to a shape property path, then resolve.
  bindToken(shapeId: string, pageId: string, path: string, tokenName: string): DesignFile | null {
    if (!this.file) return null;
    const page = this.file.pages.find(p => p.id === pageId);
    const shape = page?.objects[shapeId];
    if (!shape) return null;
    shape.tokenBindings = { ...(shape.tokenBindings ?? {}), [path]: tokenName };
    applyTokensToFile(this.file);
    return this.snapshot();
  }

  unbindToken(shapeId: string, pageId: string, path: string): DesignFile | null {
    if (!this.file) return null;
    const page = this.file.pages.find(p => p.id === pageId);
    const shape = page?.objects[shapeId];
    if (!shape?.tokenBindings) return null;
    const next = { ...shape.tokenBindings };
    delete next[path];
    shape.tokenBindings = next;
    return this.snapshot();
  }

  switchTheme(themeId: string): DesignFile | null {
    if (!this.file) return null;
    this.file.activeThemeId = themeId;
    applyTokensToFile(this.file);
    return this.snapshot();
  }

  // ── Color library ─────────────────────────────────────────────────────────

  addColor(name: string, color: string, opacity: number): DesignFile | null {
    if (!this.file) return null;
    this.file.colors.push({ id: uid(), name, color, opacity });
    return this.snapshot();
  }

  updateColor(id: string, patch: Partial<ColorEntry>): DesignFile | null {
    if (!this.file) return null;
    const idx = this.file.colors.findIndex(c => c.id === id);
    if (idx === -1) return null;
    this.file.colors[idx] = { ...this.file.colors[idx], ...patch };
    return this.snapshot();
  }

  deleteColor(id: string): DesignFile | null {
    if (!this.file) return null;
    this.file.colors = this.file.colors.filter(c => c.id !== id);
    return this.snapshot();
  }

  // ── Typography library ─────────────────────────────────────────────────────

  addTypography(name: string, style: Partial<TextStyle>): DesignFile | null {
    if (!this.file) return null;
    this.file.typographies.push({ id: uid(), name, style });
    return this.snapshot();
  }

  deleteTypography(id: string): DesignFile | null {
    if (!this.file) return null;
    this.file.typographies = this.file.typographies.filter(t => t.id !== id);
    return this.snapshot();
  }

  renamePage(pageId: string, name: string): DesignFile | null {
    if (!this.file) return null;
    const page = this.file.pages.find(p => p.id === pageId);
    if (!page) return null;
    page.name = name;
    return this.snapshot();
  }

  setPageBackground(pageId: string, color: string): DesignFile | null {
    if (!this.file) return null;
    const page = this.file.pages.find(p => p.id === pageId);
    if (!page) return null;
    page.background = color;
    return this.snapshot();
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
    this.undoStack.push({ pageId: entry.pageId, inverseOps: undoOps, propagations: entry.propagations });
    this.replaySideEffects(page, entry.propagations);
  }

  // Deterministic post-op side effects, shared by applyChanges / undo / redo. Master
  // propagation and auto-layout reflow are pure functions of the document's current
  // attrs, so re-running them after replaying (inverse) ops reproduces the exact
  // pre/post-edit geometry — no per-instance or per-child inverse ops needed. Undo is
  // safe because every recorded state was itself reflow-stable when it was created.
  private replaySideEffects(page: Page, propagations?: { shapeId: string; attr: string }[]) {
    if (propagations) for (const { shapeId, attr } of propagations) this.propagateMasterAttr(page, shapeId, attr);
    this.reflow(page);
  }

  // Push the master's CURRENT value of `attr` to every non-overriding instance of its
  // component, across all pages.
  private propagateMasterAttr(page: Page, shapeId: string, attr: string) {
    if (!this.file) return;
    const masterShape = page.objects[shapeId];
    if (!masterShape?.componentId) return;
    const componentId = masterShape.componentId;
    const val = (masterShape as unknown as Record<string, unknown>)[attr];
    for (const p of this.file.pages) {
      for (const s of Object.values(p.objects)) {
        if (s.masterId === componentId) {
          // Only propagate if the instance hasn't locally overridden this attr.
          // Use `attr in overrides` (not truthiness) so a deliberate falsy override
          // — opacity:0, content:"" — isn't treated as "unset" and clobbered by master.
          // Clone non-primitive values so instances don't share mutable arrays.
          if (!(attr in (s.overrides ?? {}))) {
            (s as unknown as Record<string, unknown>)[attr] =
              (val && typeof val === 'object') ? structuredClone(val) : val;
          }
        }
      }
    }
  }

  // Loop until stable in case a hug parent's resize cascades up through nested
  // containers. Skips entirely when the page has no auto-layout container.
  private reflow(page: Page): boolean {
    if (!Object.values(page.objects).some(s => s.autoLayout)) return false;
    let changed = false;
    for (let i = 0; i < 6; i++) { if (!applyAutoLayoutToPage(page)) break; changed = true; }
    return changed;
  }

  private applyOp(page: Page, op: ChangeOp | InverseOp): InverseOp | null {
    switch (op.op) {
      case 'set': {
        const shape = page.objects[op.id];
        if (!shape) return null;
        const prev = (shape as unknown as Record<string, unknown>)[op.attr];
        (shape as unknown as Record<string, unknown>)[op.attr] = op.val;
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
        const prevVal = (prev as unknown as Record<string, unknown>)[op.attr];
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
