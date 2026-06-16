import { DesignFile, ChangeSet, ChangeOp, Shape, Page } from '../shared/types';

type InverseOp =
  | { op: 'set'; id: string; attr: string; val: unknown }
  | { op: 'setImage'; id: string; dataUrl: string | null }
  | { op: 'add'; shape: Shape }
  | { op: 'addTree'; rootId: string; shapes: Record<string, Shape> }
  | { op: 'del'; id: string }
  | { op: 'move'; id: string; parentId: string | null; index: number };

interface UndoEntry {
  pageId: string;
  inverseOps: InverseOp[];
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

  getState(): DesignFile | null {
    return this.file ? structuredClone(this.file) : null;
  }

  applyChanges(changeSet: ChangeSet) {
    if (!this.file) throw new Error('no file loaded');
    const page = this.file.pages.find(p => p.id === changeSet.pageId);
    if (!page) throw new Error(`page ${changeSet.pageId} not found`);

    const inverseOps: InverseOp[] = [];

    for (const op of changeSet.ops) {
      const inv = this.applyOp(page, op);
      if (inv) inverseOps.unshift(inv); // reverse order so undo restores correctly
    }

    this.undoStack.push({ pageId: changeSet.pageId, inverseOps });
    this.redoStack = [];
  }

  undo() {
    if (!this.file || this.undoStack.length === 0) return;
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

  redo() {
    if (!this.file || this.redoStack.length === 0) return;
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
        const prev = (shape as unknown as Record<string, unknown>)[op.attr];
        (shape as unknown as Record<string, unknown>)[op.attr] = op.val;
        // Keep selrect in sync for basic position/size changes
        this.updateSelrect(shape);
        return { op: 'set', id: op.id, attr: op.attr, val: prev };
      }

      case 'setImage': {
        if (!this.file) return null;
        const prev = this.file.images[op.id] ?? null;
        if (op.dataUrl === null) delete this.file.images[op.id];
        else this.file.images[op.id] = op.dataUrl;
        return { op: 'setImage', id: op.id, dataUrl: prev };
      }

      case 'add': {
        const shape = op.shape;
        page.objects[shape.id] = structuredClone(shape);
        // Wire into parent's childIds
        const parent = shape.parentId ? page.objects[shape.parentId] : null;
        if (parent) {
          if (!parent.childIds.includes(shape.id)) parent.childIds.push(shape.id);
        } else {
          if (!page.childIds.includes(shape.id)) page.childIds.push(shape.id);
        }
        this.recomputeFrameId(page, shape.id);
        return { op: 'del', id: shape.id };
      }

      case 'addTree': {
        const root = op.shapes[op.rootId];
        if (!root) return null;
        for (const shape of Object.values(op.shapes)) {
          page.objects[shape.id] = structuredClone(shape);
        }
        const parent = root.parentId ? page.objects[root.parentId] : null;
        if (parent) {
          if (!parent.childIds.includes(root.id)) parent.childIds.push(root.id);
        } else if (!page.childIds.includes(root.id)) {
          page.childIds.push(root.id);
        }
        this.recomputeFrameId(page, root.id);
        return { op: 'del', id: root.id };
      }

      case 'del': {
        const shape = page.objects[op.id];
        if (!shape) return null;
        const subtree = this.cloneSubtree(page, op.id);
        // Remove from parent
        const parent = shape.parentId ? page.objects[shape.parentId] : null;
        if (parent) {
          parent.childIds = parent.childIds.filter(id => id !== op.id);
        } else {
          page.childIds = page.childIds.filter(id => id !== op.id);
        }
        for (const id of Object.keys(subtree)) delete page.objects[id];
        return { op: 'addTree', rootId: op.id, shapes: subtree };
      }

      case 'move': {
        const shape = page.objects[op.id];
        if (!shape) return null;
        if (op.parentId === op.id || (op.parentId && this.isDescendant(page, op.parentId, op.id))) {
          return null;
        }
        const prevParentId = shape.parentId;
        const prevParent = prevParentId ? page.objects[prevParentId] : null;
        const prevIndex = prevParent
          ? prevParent.childIds.indexOf(op.id)
          : page.childIds.indexOf(op.id);

        // Remove from old parent
        if (prevParent) {
          prevParent.childIds = prevParent.childIds.filter(id => id !== op.id);
        } else {
          page.childIds = page.childIds.filter(id => id !== op.id);
        }

        // Insert into new parent
        const newParent = op.parentId ? page.objects[op.parentId] : null;
        shape.parentId = op.parentId;
        if (newParent) {
          newParent.childIds.splice(op.index, 0, op.id);
        } else {
          page.childIds.splice(op.index, 0, op.id);
        }

        this.recomputeFrameId(page, op.id);
        return { op: 'move', id: op.id, parentId: prevParentId, index: prevIndex };
      }
    }
  }

  private updateSelrect(shape: Shape) {
    shape.selrect = { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
  }

  private cloneSubtree(page: Page, rootId: string): Record<string, Shape> {
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

  private isDescendant(page: Page, id: string, ancestorId: string): boolean {
    let current = page.objects[id]?.parentId ?? null;
    while (current) {
      if (current === ancestorId) return true;
      current = page.objects[current]?.parentId ?? null;
    }
    return false;
  }

  private recomputeFrameId(page: Page, id: string) {
    const shape = page.objects[id];
    if (!shape) return;
    if (shape.type === 'frame') {
      shape.frameId = shape.id;
    } else {
      let frameId = page.id;
      let parentId = shape.parentId;
      while (parentId) {
        const parent = page.objects[parentId];
        if (!parent) break;
        if (parent.type === 'frame') {
          frameId = parent.id;
          break;
        }
        parentId = parent.parentId;
      }
      shape.frameId = frameId;
    }
    for (const childId of shape.childIds) this.recomputeFrameId(page, childId);
  }
}
