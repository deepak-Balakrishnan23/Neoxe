import { DesignFile, ChangeSet, ChangeOp, Shape, Page, makeDefaultPage, ColorEntry, TextStyle, DesignToken, TokenType, VectorChildNode, ComponentPropDef, Shadow, BlurEffect, LayoutGrid, isTextOnPath } from '../shared/types';
import { applyTokensToFile } from '../shared/tokens';
import { applyAutoLayoutToPage } from '../shared/autoLayout';
import { fitTextSize } from './canvas/textLayout';
import { constraintOps } from '../shared/constraints';
import { resolvePropDefs } from '../shared/components';
import { booleanSegments, BoolOp } from '../shared/boolean';
import { shapeToSegments, segmentsBounds, toLocal } from '../shared/flatten';

function uid() { return Math.random().toString(36).slice(2, 10); }

// The value `attr` will hold once this changeset applies — the last op that sets it, or
// the shape's current value when the changeset doesn't touch it.
function pendingNumber(ops: ChangeOp[], id: string, attr: string, current: number): number {
  for (let i = ops.length - 1; i >= 0; i--) {
    const o = ops[i];
    if (o.op === 'set' && o.id === id && o.attr === attr && typeof o.val === 'number') return o.val;
  }
  return current;
}

// Properties propagated from master to instances (unless overridden)
const PROPAGATED_ATTRS = new Set([
  'fills', 'strokes', 'shadows', 'blur', 'opacity', 'blendMode',
  'textStyle', 'paragraphs', 'content', 'type',
  // Corner radius and smoothing sit in the same Appearance row as the fills and strokes
  // above and are just as much a paint property — leaving them out meant rounding a
  // master's corners changed nothing in any of its instances.
  'cornerRadii', 'cornerSmoothing',
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
    // Lay the document out on open. A file saved by this app is already reflow-stable, so
    // this is a no-op for it — but a file that has never been laid out (imported, or
    // authored elsewhere) would otherwise render with every auto-layout child still at
    // its stored position. Not part of any undo entry: opening a file is not an edit.
    for (const page of this.file.pages) this.reflow(page);
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

    // Constraint cascade: resizing a container repositions/resizes its children per their
    // Figma constraints. Emitted as real ops (like the rigid-body cascade above) so undo
    // restores exact child boxes instead of re-deriving them from a reverse resize.
    {
      const done = new Set<string>();
      for (const op of changeSet.ops) {
        if (op.op !== 'set') continue;
        if (op.attr !== 'width' && op.attr !== 'height') continue;
        const s = page.objects[op.id];
        if (!s || s.childIds.length === 0 || done.has(op.id)) continue;
        const width = pendingNumber(changeSet.ops, op.id, 'width', s.width);
        const height = pendingNumber(changeSet.ops, op.id, 'height', s.height);
        if (width === s.width && height === s.height) continue;  // a pure move — rigid body's job
        done.add(op.id);
        ops.push(...constraintOps(
          page, op.id,
          { x: s.x, y: s.y, width: s.width, height: s.height },
          {
            x: pendingNumber(changeSet.ops, op.id, 'x', s.x),
            y: pendingNumber(changeSet.ops, op.id, 'y', s.y),
            width, height,
          },
        ));
      }
    }

    // Declared-size bookkeeping for stretched ('fill') axes. `width`/`height` carry the
    // size the layout engine resolved, so the declared one is parked in baseWidth/
    // baseHeight (see Shape.baseWidth). Leaving 'fill' restores it; setting a size
    // explicitly redeclares it. Expanded into real ops so undo covers them too.
    for (const op of changeSet.ops) {
      if (op.op !== 'set') continue;
      const s = page.objects[op.id];
      if (!s) continue;
      for (const axis of ['width', 'height'] as const) {
        const modeAttr = axis === 'width' ? 'widthMode' : 'heightMode';
        const baseAttr = axis === 'width' ? 'baseWidth' : 'baseHeight';
        const base = s[baseAttr];
        if (op.attr === modeAttr && op.val !== 'fill' && base !== undefined) {
          ops.push({ op: 'set', id: op.id, attr: axis, val: base });
          ops.push({ op: 'set', id: op.id, attr: baseAttr, val: undefined });
        } else if (op.attr === axis && base !== undefined) {
          ops.push({ op: 'set', id: op.id, attr: baseAttr, val: undefined });
        }
      }
    }

    for (const op of ops) {
      const inv = this.applyOp(page, op);
      if (inv) inverseOps.unshift(inv);
      // Track changes to master components for propagation
      if (op.op === 'set') {
        const shape = page.objects[op.id];
        // Any shape inside a master propagates — not just the master's root, now that
        // instances mirror the whole subtree.
        if (shape && PROPAGATED_ATTRS.has(op.attr) && (shape.componentId || masterRootId(page, op.id))) {
          masterChanges.push({ shapeId: op.id, attr: op.attr });
        }
        // If this is an instance being edited, mark the attr as overridden. Record an
        // inverse restoring the PREVIOUS overrides map — without it, undoing the edit
        // reverts the value but leaves the override flag set, permanently blocking
        // future master updates for that attr on this instance.
        if ((shape?.masterId || shape?.masterShapeId) && PROPAGATED_ATTRS.has(op.attr)) {
          inverseOps.unshift({ op: 'set', id: op.id, attr: 'overrides', val: shape.overrides ? { ...shape.overrides } : undefined });
          shape.overrides = { ...(shape.overrides ?? {}), [op.attr]: op.val };
        }
      }
    }

    // Propagate master changes to all instances across all pages
    for (const { shapeId, attr } of masterChanges) this.propagateMasterAttr(page, shapeId, attr);

    // Re-derive component-property effects for any instance whose values just changed,
    // and for instances whose master was edited (propagation may have overwritten them).
    let componentPropsApplied = false;
    for (const op of ops) {
      if (op.op !== 'set') continue;
      if (op.attr === 'componentProps' && page.objects[op.id]?.masterId) {
        this.applyComponentProps(page, op.id);
        componentPropsApplied = true;
      }
    }
    if (masterChanges.length) {
      for (const s of Object.values(page.objects)) if (s.masterId) this.applyComponentProps(page, s.id);
    }

    // Structural edits inside a master change the SHAPE of every instance's tree.
    const structuralOps = ops.some(o => o.op === 'add' || o.op === 'del' || o.op === 'move');
    const instancesReconciled = structuralOps ? this.reconcileInstances() : false;

    // Recompute boolean outlines before layout — a bool's box can change, and a hugging
    // auto-layout parent has to measure the new one.
    const booleansChanged = this.recomputeBooleans(page);

    // Re-run Figma-style Auto Layout so containers reflow their children.
    // The reflow writes geometry straight onto the shapes rather than through ops, so its
    // writes have to be inverse-recorded: re-deriving them on undo only works while the
    // engine still OWNS those shapes. Undo something that hands a shape back — removing a
    // container, clearing its autoLayout, making a child absolute — and the pre-layout
    // x/y is gone for good, leaving the children parked where the layout had put them.
    // Recorded last in the entry so they are restored after the structural inverses.
    const beforeReflow = new Map<string, { x: number; y: number; width: number; height: number }>();
    for (const id in page.objects) {
      const s = page.objects[id];
      beforeReflow.set(id, { x: s.x, y: s.y, width: s.width, height: s.height });
    }
    const autoLayoutChanged = this.reflow(page);
    if (autoLayoutChanged) {
      for (const [id, was] of beforeReflow) {
        const s = page.objects[id];
        if (!s) continue;
        for (const attr of ['x', 'y', 'width', 'height'] as const) {
          if (s[attr] !== was[attr]) inverseOps.push({ op: 'set', id, attr, val: was[attr] });
        }
      }
    }

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
    // Applying component properties mutates layers INSIDE the instance, which the ops
    // never name — the same reason propagation and reflow disqualify the shared path.
    const canShare = !structural && masterChanges.length === 0 && !autoLayoutChanged
      && !componentPropsApplied && !booleansChanged && !instancesReconciled && this.lastSnapshot !== null;
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

    // Deep-clone the master's whole subtree. Every node keeps a `masterShapeId` link so
    // later master edits reach the matching node inside each instance; only the root
    // carries `masterId`, which is what makes it an instance rather than a copy.
    const subtree = cloneSubtree(masterPage, comp.shapeId);
    const idMap: Record<string, string> = {};
    for (const oldId of Object.keys(subtree)) idMap[oldId] = uid();
    const dx = x - master.x, dy = y - master.y;

    for (const [oldId, node] of Object.entries(subtree)) {
      const clone = node;
      clone.masterShapeId = oldId;
      clone.componentId = undefined;
      clone.overrides = {};
      clone.id = idMap[oldId];
      clone.childIds = clone.childIds.map(c => idMap[c]).filter(Boolean);
      clone.parentId = clone.parentId && idMap[clone.parentId] ? idMap[clone.parentId] : null;
      clone.x += dx; clone.y += dy;
      clone.selrect = { x: clone.x, y: clone.y, width: clone.width, height: clone.height };
      targetPage.objects[clone.id] = clone;
    }

    const instanceId = idMap[comp.shapeId];
    const instance = targetPage.objects[instanceId];
    instance.masterId = componentId;
    instance.parentId = null;
    targetPage.childIds.push(instanceId);
    recomputeFrameId(targetPage, instanceId);
    this.applyComponentProps(targetPage, instanceId);
    return this.snapshot();
  }

  // Every shape inside `instanceRootId`, root first.
  private instanceSubtree(page: Page, instanceRootId: string): Shape[] {
    const out: Shape[] = [];
    const visit = (id: string) => {
      const s = page.objects[id];
      if (!s) return;
      out.push(s);
      for (const c of s.childIds) visit(c);
    };
    visit(instanceRootId);
    return out;
  }

  /** Declare the component properties an instance of `componentId` can set. */
  setComponentProps(componentId: string, props: ComponentPropDef[]): DesignFile | null {
    if (!this.file) return null;
    const comp = this.file.components[componentId];
    if (!comp) return null;
    comp.props = props;
    // Existing instances re-derive from the new definitions (defaults may have changed).
    for (const p of this.file.pages) {
      for (const s of Object.values(p.objects)) if (s.masterId === componentId) this.applyComponentProps(p, s.id);
    }
    return this.snapshot();
  }

  // ── Effect & grid styles ────────────────────────────────────────────────────
  // Named, reusable versions of what a layer already stores inline. Kept as plain
  // file-level lists, like colours and typography.

  addEffectStyle(name: string, shadows: Shadow[], blur: BlurEffect | null): DesignFile | null {
    if (!this.file) return null;
    this.file.effects = [...(this.file.effects ?? []), {
      id: uid(), name: name.trim() || 'Effect',
      shadows: structuredClone(shadows), blur: blur ? structuredClone(blur) : null,
    }];
    return this.snapshot();
  }

  deleteEffectStyle(id: string): DesignFile | null {
    if (!this.file) return null;
    this.file.effects = (this.file.effects ?? []).filter(e => e.id !== id);
    return this.snapshot();
  }

  addGridStyle(name: string, grids: LayoutGrid[]): DesignFile | null {
    if (!this.file) return null;
    this.file.gridStyles = [...(this.file.gridStyles ?? []), {
      id: uid(), name: name.trim() || 'Grid', grids: structuredClone(grids),
    }];
    return this.snapshot();
  }

  deleteGridStyle(id: string): DesignFile | null {
    if (!this.file) return null;
    this.file.gridStyles = (this.file.gridStyles ?? []).filter(g => g.id !== id);
    return this.snapshot();
  }

  // ── Variants ────────────────────────────────────────────────────────────────

  /**
   * Turn the selected shapes into one component set. Shapes that aren't components yet
   * become components first; each gets a value for `propName` taken from its layer name
   * (deduplicated), which is the property the instance picker then exposes.
   */
  combineAsVariants(shapeIds: string[], pageId: string, propName = 'Variant'): DesignFile | null {
    if (!this.file) return null;
    const page = this.file.pages.find(p => p.id === pageId);
    if (!page || shapeIds.length < 2) return null;

    const setId = uid();
    const values: string[] = [];
    const variants: Record<string, Record<string, string>> = {};
    const taken = new Set<string>();

    for (const id of shapeIds) {
      const shape = page.objects[id];
      if (!shape) continue;
      let componentId = shape.componentId;
      if (!componentId) {
        componentId = uid();
        shape.componentId = componentId;
        this.file.components[componentId] = { name: shape.name, pageId, shapeId: id };
      }
      let value = shape.name.trim() || 'Variant';
      let n = 2;
      while (taken.has(value)) value = `${shape.name.trim() || 'Variant'} ${n++}`;
      taken.add(value);
      values.push(value);
      variants[componentId] = { [propName]: value };
      this.file.components[componentId].setId = setId;
    }

    const componentIds = Object.keys(variants);
    if (componentIds.length < 2) return null;
    this.file.componentSets = this.file.componentSets ?? {};
    this.file.componentSets[setId] = {
      id: setId,
      name: page.objects[shapeIds[0]]?.name ?? 'Component set',
      properties: { [propName]: values },
      variants,
      defaultComponentId: componentIds[0],
    };
    return this.snapshot();
  }

  /**
   * Point an instance at the sibling variant matching `props`, rebuilding its subtree
   * from that master. The root keeps its id and position so the selection survives the
   * swap; descendant overrides don't (their layers are replaced).
   */
  // ── Variant property editing ───────────────────────────────────────────────
  // `combineAsVariants` can only ever produce ONE property, named "Variant", with values
  // taken from layer names. A design system needs matrices (Type x State), and the model
  // already stores `properties` as a map — these three methods are what let the UI build
  // one instead of only the engine being able to.

  /** Rename a variant property across the set's table and every variant's coordinates. */
  renameVariantProperty(setId: string, from: string, to: string): DesignFile | null {
    if (!this.file) return null;
    const set = this.file.componentSets?.[setId];
    const name = to.trim();
    if (!set || !name || from === name || !(from in set.properties) || name in set.properties) return null;
    const props: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(set.properties)) props[k === from ? name : k] = v;
    set.properties = props;
    for (const id of Object.keys(set.variants)) {
      const coords = set.variants[id];
      if (!(from in coords)) continue;
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(coords)) next[k === from ? name : k] = v;
      set.variants[id] = next;
    }
    return this.snapshot();
  }

  /** Add a property to the set. Every existing variant takes `defaultValue`. */
  addVariantProperty(setId: string, name: string, defaultValue = 'Default'): DesignFile | null {
    if (!this.file) return null;
    const set = this.file.componentSets?.[setId];
    const key = name.trim(), val = defaultValue.trim() || 'Default';
    if (!set || !key || key in set.properties) return null;
    set.properties[key] = [val];
    for (const id of Object.keys(set.variants)) set.variants[id] = { ...set.variants[id], [key]: val };
    return this.snapshot();
  }

  /** Remove a property from the set and from every variant's coordinates. */
  removeVariantProperty(setId: string, name: string): DesignFile | null {
    if (!this.file) return null;
    const set = this.file.componentSets?.[setId];
    // A set with no properties has nothing to switch between — keep at least one.
    if (!set || !(name in set.properties) || Object.keys(set.properties).length < 2) return null;
    delete set.properties[name];
    for (const id of Object.keys(set.variants)) {
      const next = { ...set.variants[id] };
      delete next[name];
      set.variants[id] = next;
    }
    return this.snapshot();
  }

  /** Set THIS variant's value for a property, registering the value on the set. */
  setVariantValue(componentId: string, propName: string, value: string): DesignFile | null {
    if (!this.file) return null;
    const comp = this.file.components[componentId];
    const set = comp?.setId ? this.file.componentSets?.[comp.setId] : null;
    const v = value.trim();
    if (!set || !v || !(propName in set.properties)) return null;
    set.variants[componentId] = { ...(set.variants[componentId] ?? {}), [propName]: v };
    // Rebuild the value list from what the variants actually use, so renaming the last
    // variant off a value doesn't leave a dead option in every instance's dropdown.
    const used: string[] = [];
    for (const id of Object.keys(set.variants)) {
      const val = set.variants[id][propName];
      if (val && used.indexOf(val) === -1) used.push(val);
    }
    set.properties[propName] = used;
    return this.snapshot();
  }

  setInstanceVariant(shapeId: string, pageId: string, props: Record<string, string>): DesignFile | null {
    if (!this.file) return null;
    const page = this.file.pages.find(p => p.id === pageId);
    const root = page?.objects[shapeId];
    if (!page || !root?.masterId) return null;
    const comp = this.file.components[root.masterId];
    const set = comp?.setId ? this.file.componentSets?.[comp.setId] : null;
    if (!set) return null;

    const target = Object.entries(set.variants).find(([, vals]) =>
      Object.entries(props).every(([k, v]) => vals[k] === v));
    if (!target) return null;
    const [nextComponentId] = target;
    if (nextComponentId === root.masterId) return this.snapshot();

    const nextComp = this.file.components[nextComponentId];
    const masterPage = nextComp ? this.file.pages.find(p => p.id === nextComp.pageId) : null;
    const master = masterPage && nextComp ? masterPage.objects[nextComp.shapeId] : null;
    if (!master || !masterPage) return null;

    // Drop the old descendants, then graft a fresh clone of the new variant's subtree
    // onto the existing root id.
    for (const node of this.instanceSubtree(page, shapeId)) {
      if (node.id === shapeId) continue;
      delete page.objects[node.id];
    }
    const dx = root.x - master.x, dy = root.y - master.y;
    const subtree = cloneSubtree(masterPage, nextComp!.shapeId);
    const idMap: Record<string, string> = { [nextComp!.shapeId]: shapeId };
    for (const oldId of Object.keys(subtree)) if (!idMap[oldId]) idMap[oldId] = uid();

    for (const [oldId, node] of Object.entries(subtree)) {
      const clone = node;
      clone.masterShapeId = oldId;
      clone.componentId = undefined;
      clone.id = idMap[oldId];
      clone.childIds = clone.childIds.map(c => idMap[c]).filter(Boolean);
      clone.x += dx; clone.y += dy;
      clone.selrect = { x: clone.x, y: clone.y, width: clone.width, height: clone.height };
      if (oldId === nextComp!.shapeId) {
        // The root keeps its identity, placement and overrides — only its content swaps.
        clone.parentId = root.parentId;
        clone.masterId = nextComponentId;
        clone.overrides = root.overrides ?? {};
        clone.componentProps = root.componentProps;
      } else {
        clone.parentId = idMap[clone.parentId!] ?? shapeId;
        clone.overrides = {};
      }
      page.objects[clone.id] = clone;
    }
    recomputeFrameId(page, shapeId);
    this.applyComponentProps(page, shapeId);
    return this.snapshot();
  }

  // ── Component properties ────────────────────────────────────────────────────

  /**
   * Push an instance's component-property values onto the layers the master bound them
   * to. Idempotent: derived purely from the stored values, so it can re-run after any
   * swap or propagation.
   */
  private applyComponentProps(page: Page, instanceRootId: string) {
    if (!this.file) return;
    const root = page.objects[instanceRootId];
    if (!root?.masterId) return;
    const comp = this.file.components[root.masterId];
    // Variants share their set's properties, so resolve across the set — otherwise
    // swapping to a variant that didn't declare them would silently drop the values.
    const defs = resolvePropDefs(this.file, root.masterId);
    if (!comp || !defs.length) return;
    const masterPage = this.file.pages.find(p => p.id === comp!.pageId);
    if (!masterPage) return;
    const values = root.componentProps ?? {};
    const valueOf = (id: string) => (id in values ? values[id] : defs.find(d => d.id === id)?.defaultValue);

    for (const node of this.instanceSubtree(page, instanceRootId)) {
      const master = node.masterShapeId ? masterPage.objects[node.masterShapeId] : null;
      const bind = master?.propBindings;
      if (!bind) continue;
      if (bind.visible) node.hidden = valueOf(bind.visible) === false;
      if (bind.characters) {
        const text = String(valueOf(bind.characters) ?? '');
        node.paragraphs = [{ align: node.paragraphs?.[0]?.align ?? 'left', spans: [{ text }] }];
      }
    }
  }

  detachInstance(shapeId: string, pageId: string): DesignFile | null {
    if (!this.file) return null;
    const page = this.file.pages.find(p => p.id === pageId);
    if (!page) return null;
    const shape = page.objects[shapeId];
    if (!shape?.masterId) return null;
    // Bake the master's values into the whole instance subtree, then cut every link so
    // the result is plain geometry that no longer tracks the component.
    const comp = this.file.components[shape.masterId];
    const masterPage = comp ? this.file.pages.find(p => p.id === comp.pageId) : null;
    for (const node of this.instanceSubtree(page, shapeId)) {
      const master = masterPage && node.masterShapeId ? masterPage.objects[node.masterShapeId] : null;
      if (master) {
        for (const attr of PROPAGATED_ATTRS) {
          if (!(attr in (node.overrides ?? {}))) {
            // Deep-clone so the detached shape doesn't share the master's arrays.
            const v = (master as unknown as Record<string, unknown>)[attr];
            (node as unknown as Record<string, unknown>)[attr] = (v && typeof v === 'object') ? structuredClone(v) : v;
          }
        }
      }
      node.masterId = undefined;
      node.masterShapeId = undefined;
      node.overrides = undefined;
    }
    return this.snapshot();
  }

  resetOverrides(shapeId: string, pageId: string): DesignFile | null {
    if (!this.file) return null;
    const page = this.file.pages.find(p => p.id === pageId);
    if (!page) return null;
    const shape = page.objects[shapeId];
    if (!shape?.masterId) return null;
    // Drop every local override in the subtree AND pull the master's current values back
    // in — clearing the map alone would leave the last overridden value sitting there.
    const comp = this.file.components[shape.masterId];
    const masterPage = comp ? this.file.pages.find(p => p.id === comp.pageId) : null;
    for (const node of this.instanceSubtree(page, shapeId)) {
      node.overrides = {};
      const master = masterPage && node.masterShapeId ? masterPage.objects[node.masterShapeId] : null;
      if (!master) continue;
      for (const attr of PROPAGATED_ATTRS) {
        const v = (master as unknown as Record<string, unknown>)[attr];
        (node as unknown as Record<string, unknown>)[attr] = (v && typeof v === 'object') ? structuredClone(v) : v;
      }
    }
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

  // NOTE for all three token mutators: replace the array, never mutate it in place.
  // `resolveToken` caches its name→token map in a WeakMap keyed on the ARRAY IDENTITY, so
  // a `push` or an index assignment leaves the stale map in place — a new token resolves
  // to null and an edited one keeps resolving to its old value, which made both operations
  // look like they did nothing at all.
  addToken(name: string, type: TokenType, value: string | number): DesignFile | null {
    if (!this.file) return null;
    this.file.tokens = [...this.file.tokens, { id: uid(), name, $type: type, $value: value }];
    applyTokensToFile(this.file);
    return this.snapshot();
  }

  updateToken(id: string, patch: Partial<DesignToken>): DesignFile | null {
    if (!this.file) return null;
    if (!this.file.tokens.some(t => t.id === id)) return null;
    this.file.tokens = this.file.tokens.map(t => (t.id === id ? { ...t, ...patch } : t));
    applyTokensToFile(this.file);
    return this.snapshot();
  }

  deleteToken(id: string): DesignFile | null {
    if (!this.file) return null;
    const gone = this.file.tokens.find(t => t.id === id);
    this.file.tokens = this.file.tokens.filter(t => t.id !== id);
    // Drop every binding that pointed at the deleted token. Left in place they are
    // invisible landmines: the layer keeps whatever value it last resolved to, and the
    // moment a new token is created with the same name the stale binding springs back to
    // life and silently overwrites the layer.
    if (gone) {
      for (const page of this.file.pages) {
        for (const shape of Object.values(page.objects)) {
          if (!shape.tokenBindings) continue;
          const next = Object.fromEntries(
            Object.entries(shape.tokenBindings).filter(([, name]) => name !== gone.name),
          );
          if (Object.keys(next).length !== Object.keys(shape.tokenBindings).length) {
            shape.tokenBindings = Object.keys(next).length ? next : undefined;
          }
        }
      }
    }
    applyTokensToFile(this.file);
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
    // Component-property effects live on layers the ops never name, so — like propagation
    // and reflow — they're re-derived from the restored state rather than inverse-recorded.
    this.reconcileInstances();
    for (const s of Object.values(page.objects)) if (s.masterId) this.applyComponentProps(page, s.id);
    this.recomputeBooleans(page);
    this.reflow(page);
  }

  // Push the master's CURRENT value of `attr` to every non-overriding instance of its
  // component, across all pages.
  private propagateMasterAttr(page: Page, shapeId: string, attr: string) {
    if (!this.file) return;
    const masterShape = page.objects[shapeId];
    if (!masterShape) return;
    // The root of a master carries componentId; nodes below it are reached through the
    // masterShapeId back-link that every instance node keeps.
    const componentId = masterShape.componentId;
    if (!componentId && !masterRootId(page, shapeId)) return;
    const val = (masterShape as unknown as Record<string, unknown>)[attr];
    for (const p of this.file.pages) {
      for (const s of Object.values(p.objects)) {
        // Instance roots match on componentId; nodes deeper inside an instance match on
        // the master shape they mirror. Both sides must be defined — an undefined
        // componentId would otherwise match every shape that isn't an instance.
        if ((componentId != null && s.masterId === componentId) || (s.masterShapeId != null && s.masterShapeId === shapeId)) {
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

  /**
   * Mirror STRUCTURAL master edits into every instance: layers added to a master appear
   * in each instance, layers removed disappear, and sibling order follows the master.
   * Property edits are handled by propagateMasterAttr; this is the shape of the tree.
   *
   * Derived entirely from the master, so it re-runs after undo instead of being recorded
   * as inverse ops — the same contract as propagation and reflow.
   */
  private reconcileInstances(): boolean {
    if (!this.file) return false;
    let changed = false;

    for (const [componentId, comp] of Object.entries(this.file.components)) {
      const masterPage = this.file.pages.find(p => p.id === comp.pageId);
      const master = masterPage?.objects[comp.shapeId];
      if (!masterPage || !master) continue;

      for (const page of this.file.pages) {
        for (const root of Object.values(page.objects)) {
          if (root.masterId !== componentId) continue;
          const dx = root.x - master.x, dy = root.y - master.y;

          // Where each master node currently lives inside this instance.
          const byMaster = new Map<string, Shape>();
          for (const node of this.instanceSubtree(page, root.id)) {
            if (node.masterShapeId) byMaster.set(node.masterShapeId, node);
          }
          byMaster.set(comp.shapeId, root);

          // Add anything the master has and the instance doesn't, parents first.
          const addMissing = (masterId: string) => {
            const masterNode = masterPage.objects[masterId];
            if (!masterNode) return;
            for (const childMasterId of masterNode.childIds) {
              const childMaster = masterPage.objects[childMasterId];
              if (!childMaster) continue;
              if (!byMaster.has(childMasterId)) {
                const subtree = cloneSubtree(masterPage, childMasterId);
                const idMap: Record<string, string> = {};
                for (const oldId of Object.keys(subtree)) idMap[oldId] = uid();
                for (const [oldId, clone] of Object.entries(subtree)) {
                  clone.masterShapeId = oldId;
                  clone.componentId = undefined;
                  clone.masterId = undefined;
                  clone.overrides = {};
                  clone.id = idMap[oldId];
                  clone.childIds = clone.childIds.map(c => idMap[c]).filter(Boolean);
                  clone.parentId = clone.parentId && idMap[clone.parentId] ? idMap[clone.parentId] : byMaster.get(masterId)!.id;
                  clone.x += dx; clone.y += dy;
                  clone.selrect = { x: clone.x, y: clone.y, width: clone.width, height: clone.height };
                  page.objects[clone.id] = clone;
                  byMaster.set(oldId, clone);
                }
                const parent = byMaster.get(masterId)!;
                parent.childIds.push(idMap[childMasterId]);
                changed = true;
              }
              addMissing(childMasterId);
            }
          };
          addMissing(comp.shapeId);

          // Drop anything the master no longer has.
          for (const node of this.instanceSubtree(page, root.id)) {
            if (node.id === root.id || !node.masterShapeId) continue;
            if (masterPage.objects[node.masterShapeId]) continue;
            const parent = node.parentId ? page.objects[node.parentId] : null;
            if (parent) parent.childIds = parent.childIds.filter(c => c !== node.id);
            for (const gone of this.instanceSubtree(page, node.id)) delete page.objects[gone.id];
            changed = true;
          }

          // Match the master's sibling order.
          for (const [masterId, node] of byMaster) {
            const masterNode = masterPage.objects[masterId];
            if (!masterNode || !page.objects[node.id]) continue;
            const wanted = masterNode.childIds
              .map(cid => byMaster.get(cid)?.id)
              .filter((id): id is string => !!id && page.objects[id]?.parentId === node.id);
            if (wanted.length === node.childIds.length && wanted.some((id, i) => id !== node.childIds[i])) {
              node.childIds = wanted;
              changed = true;
            }
          }

          if (changed) recomputeFrameId(page, root.id);
        }
      }
    }
    return changed;
  }

  /**
   * Recompute the cached outline of every boolean group on the page. Deep-first so a
   * nested boolean's own result is ready before its parent consumes it. Derived purely
   * from the operands, so — like reflow — it can be re-run after undo instead of being
   * recorded as inverse ops.
   */
  private recomputeBooleans(page: Page): boolean {
    let changed = false;
    const visit = (id: string) => {
      const shape = page.objects[id];
      if (!shape) return;
      for (const childId of shape.childIds) visit(childId);
      if (shape.type !== 'bool') return;

      const operands = shape.childIds
        .map(cid => page.objects[cid])
        .filter((c): c is Shape => !!c && !c.hidden)
        .map(c => shapeToSegments(c, page.objects))
        .filter(segs => segs.length > 0);

      const next = operands.length >= 2
        ? booleanSegments((shape.boolType ?? 'union') as BoolOp, operands)
        : operands[0] ?? [];
      // null = the clipper could not produce a result; keep whatever geometry we had
      // rather than blanking the shape mid-edit.
      if (next === null) return;

      const bounds = segmentsBounds(next);
      const local = bounds ? toLocal(next, bounds.x, bounds.y) : next;
      const nx = bounds ? Math.round(bounds.x) : shape.x;
      const ny = bounds ? Math.round(bounds.y) : shape.y;
      const nw = bounds ? Math.round(bounds.width) : shape.width;
      const nh = bounds ? Math.round(bounds.height) : shape.height;

      if (JSON.stringify(shape.content ?? []) === JSON.stringify(local)
          && shape.x === nx && shape.y === ny && shape.width === nw && shape.height === nh) return;
      shape.content = local;
      shape.x = nx; shape.y = ny; shape.width = nw; shape.height = nh;
      shape.selrect = { x: nx, y: ny, width: nw, height: nh };
      changed = true;
    };
    for (const rootId of page.childIds) visit(rootId);
    return changed;
  }

  // Loop until stable in case a hug parent's resize cascades up through nested
  // containers. Skips entirely when the page has no auto-layout container.
  private reflow(page: Page): boolean {
    if (!Object.values(page.objects).some(s => s.autoLayout)) return false;
    let changed = false;
    for (let i = 0; i < 6; i++) {
      const moved = applyAutoLayoutToPage(page);
      // Auto-height text is width-dependent: narrow the box and the same words need more
      // lines. The layout engine sets the width but can't measure glyphs, so refit here
      // and let the loop settle — a re-fitted paragraph makes its hugging ancestors taller,
      // which is what stops a heading from clipping (or overlapping the block beneath it)
      // as soon as the artboard gets narrower.
      const refit = this.refitAutoHeightText(page);
      if (!moved && !refit) break;
      changed = true;
    }
    return changed;
  }

  /** Re-fit every auto-height text box to its current width. True if any height changed. */
  private refitAutoHeightText(page: Page): boolean {
    let changed = false;
    for (const id in page.objects) {
      const s = page.objects[id];
      if (!s || s.type !== 'text' || !s.textStyle) continue;
      // Auto-WIDTH text hugs its longest line, so the layout never constrains it; only
      // fixed-width / auto-height boxes have a height to recompute. `textAutoHeight`
      // undefined means auto (Figma's default for a text box).
      if (s.textAutoWidth === true || s.textAutoHeight === false) continue;
      // Text on a path sizes its own baseline; refitting would collapse the curve.
      if (isTextOnPath(s)) continue;
      const h = Math.max(0, Math.round(fitTextSize(s).height));
      if (h === s.height) continue;
      s.height = h;
      s.selrect = { ...s.selrect, height: h };
      changed = true;
    }
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

// The id of the master-component root above `id` (or `id` itself when it IS one), else
// null. Used to decide whether an edit should propagate out to instances.
function masterRootId(page: Page, id: string): string | null {
  let cur: string | null = id;
  while (cur) {
    const s: Shape | undefined = page.objects[cur];
    if (!s) return null;
    if (s.componentId) return cur;
    cur = s.parentId;
  }
  return null;
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
