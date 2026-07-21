import { describe, it, expect, beforeEach } from 'vitest';
import { DocumentEngine } from './mockEngine';
import { makeEmptyFile } from '../shared/sampleFile';
import { makeDefaultShape, DesignFile } from '../shared/types';

// Two rects (A, B) as children of the default frame on page-1.
function fileWithTwoRects(): DesignFile {
  const f = makeEmptyFile();
  const page = f.pages[0];
  const A = makeDefaultShape({ id: 'A', type: 'rect', name: 'A', frameId: 'frame-1', parentId: 'frame-1', x: 10, y: 10, width: 40, height: 40, selrect: { x: 10, y: 10, width: 40, height: 40 } });
  const B = makeDefaultShape({ id: 'B', type: 'rect', name: 'B', frameId: 'frame-1', parentId: 'frame-1', x: 100, y: 10, width: 40, height: 40, selrect: { x: 100, y: 10, width: 40, height: 40 } });
  page.objects['A'] = A; page.objects['B'] = B;
  page.objects['frame-1'].childIds = ['A', 'B'];
  return f;
}

const objs = (snap: DesignFile) => snap.pages[0].objects;

describe('DocumentEngine — structural-sharing snapshots', () => {
  let eng: DocumentEngine;
  beforeEach(() => { eng = new DocumentEngine(); eng.load(fileWithTwoRects()); });

  it('a pure set() shares untouched shapes and clones only the touched one', () => {
    const s0 = eng.getState()!;
    const s1 = eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'A', attr: 'x', val: 999 }] });
    expect(objs(s1).A.x).toBe(999);          // touched shape updated
    expect(objs(s1).A).not.toBe(objs(s0).A); // touched shape is a fresh object
    expect(objs(s1).B).toBe(objs(s0).B);     // untouched shape shared by reference
  });

  it('previous snapshots stay immutable across later edits', () => {
    const s1 = eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'A', attr: 'x', val: 100 }] });
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'A', attr: 'x', val: 200 }] });
    expect(objs(s1).A.x).toBe(100); // s1 not mutated by the second edit
  });

  it('the rigid-body cascade names moved children, so they are cloned (not stale)', () => {
    // Moving the frame carries A and B; the engine appends child set-ops, so both are touched.
    const s0 = eng.getState()!;
    const s1 = eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'frame-1', attr: 'x', val: 500 }] });
    expect(objs(s1).A.x).toBe(objs(s0).A.x + 500);
    expect(objs(s1).B.x).toBe(objs(s0).B.x + 500);
    expect(objs(s1).A).not.toBe(objs(s0).A);
    expect(objs(s1).B).not.toBe(objs(s0).B);
  });

  it('structural ops (add) fall back to a correct full snapshot', () => {
    const s1 = eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'add', shape: makeDefaultShape({ id: 'C', type: 'rect', name: 'C', frameId: 'frame-1', parentId: 'frame-1', x: 5, y: 5, width: 10, height: 10, selrect: { x: 5, y: 5, width: 10, height: 10 } }) }] });
    expect(objs(s1).C).toBeTruthy();
    expect(objs(s1).A.x).toBe(10); // untouched shapes still correct
  });

  it('undo/redo produce correct values after a shared-snapshot edit', () => {
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'A', attr: 'x', val: 777 }] });
    eng.undo();
    expect(objs(eng.getState()!).A.x).toBe(10);
    eng.redo();
    expect(objs(eng.getState()!).A.x).toBe(777);
  });

  it('images map is shared by reference (not re-cloned every edit)', () => {
    const s0 = eng.getState()!;
    const s1 = eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'A', attr: 'y', val: 50 }] });
    expect(s1.images).toBe(s0.images);
  });
});

describe('DocumentEngine — undo replays side effects', () => {
  it('undo of an auto-layout spacing change restores the children positions', () => {
    const eng = new DocumentEngine();
    const f = fileWithTwoRects();
    f.pages[0].objects['frame-1'].autoLayout = {
      direction: 'vertical', spacing: 10,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      justifyContent: 'start', alignItems: 'start',
    };
    eng.load(f);
    // Settle the initial layout so the baseline state is reflow-stable.
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'frame-1', attr: 'name', val: 'AL' }] });
    const before = structuredClone(objs(eng.getState()!));
    // Change spacing — reflow moves B (second child) further down.
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'frame-1', attr: 'autoLayout', val: { ...f.pages[0].objects['frame-1'].autoLayout, spacing: 40 } }] });
    expect(objs(eng.getState()!).B.y).not.toBe(before.B.y);
    // Undo must restore BOTH the spacing attr and the reflowed child positions.
    eng.undo();
    const after = objs(eng.getState()!);
    expect(after['frame-1'].autoLayout!.spacing).toBe(10);
    expect(after.A.y).toBe(before.A.y);
    expect(after.B.y).toBe(before.B.y);
    // Redo re-applies the reflow too.
    eng.redo();
    expect(objs(eng.getState()!)['frame-1'].autoLayout!.spacing).toBe(40);
    expect(objs(eng.getState()!).B.y).toBe(before.A.y + before.A.height + 40);
  });

  it('undo of a master edit reverts its instances; redo re-propagates', () => {
    const eng = new DocumentEngine();
    const f = fileWithTwoRects();
    f.pages[0].objects['A'].componentId = 'comp-1';   // master
    f.pages[0].objects['B'].masterId = 'comp-1';      // instance
    f.pages[0].objects['A'].opacity = 1;
    f.pages[0].objects['B'].opacity = 1;
    eng.load(f);
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'A', attr: 'opacity', val: 0.5 }] });
    expect(objs(eng.getState()!).B.opacity).toBe(0.5); // propagated
    eng.undo();
    expect(objs(eng.getState()!).A.opacity).toBe(1);
    expect(objs(eng.getState()!).B.opacity).toBe(1);   // propagation replayed on undo
    eng.redo();
    expect(objs(eng.getState()!).A.opacity).toBe(0.5);
    expect(objs(eng.getState()!).B.opacity).toBe(0.5); // and on redo
  });

  it('undoing an instance override clears the override flag so master updates flow again', () => {
    const eng = new DocumentEngine();
    const f = fileWithTwoRects();
    f.pages[0].objects['A'].componentId = 'comp-1';
    f.pages[0].objects['B'].masterId = 'comp-1';
    f.pages[0].objects['A'].opacity = 1;
    f.pages[0].objects['B'].opacity = 1;
    eng.load(f);
    // Override the instance, then undo the override.
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'B', attr: 'opacity', val: 0.3 }] });
    expect(objs(eng.getState()!).B.overrides).toHaveProperty('opacity');
    eng.undo();
    expect(objs(eng.getState()!).B.opacity).toBe(1);
    expect('opacity' in (objs(eng.getState()!).B.overrides ?? {})).toBe(false); // flag cleared
    // Master edits reach the instance again.
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'A', attr: 'opacity', val: 0.7 }] });
    expect(objs(eng.getState()!).B.opacity).toBe(0.7);
  });
});
