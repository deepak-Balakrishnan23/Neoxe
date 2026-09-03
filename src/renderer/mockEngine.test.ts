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

describe('DocumentEngine — components, variants and properties', () => {
  // A "Button" master: a frame with a text label inside, plus a second variant frame.
  function componentScene() {
    const eng = new DocumentEngine();
    const f = makeEmptyFile();
    const page = f.pages[0];
    const mkText = (id: string, parent: string, x: number) => makeDefaultShape({
      id, type: 'text', name: 'label', frameId: parent, parentId: parent, x, y: 10, width: 100, height: 20,
      paragraphs: [{ align: 'left', spans: [{ text: 'Button' }] }],
      selrect: { x, y: 10, width: 100, height: 20 },
    });
    page.objects['def'] = makeDefaultShape({ id: 'def', type: 'frame', name: 'Default', frameId: 'def', parentId: null, x: 0, y: 0, width: 160, height: 40, selrect: { x: 0, y: 0, width: 160, height: 40 } });
    page.objects['defL'] = mkText('defL', 'def', 10);
    page.objects['def'].childIds = ['defL'];
    page.objects['hov'] = makeDefaultShape({ id: 'hov', type: 'frame', name: 'Hover', frameId: 'hov', parentId: null, x: 300, y: 0, width: 160, height: 40, selrect: { x: 300, y: 0, width: 160, height: 40 } });
    page.objects['hovL'] = mkText('hovL', 'hov', 310);
    page.objects['hov'].childIds = ['hovL'];
    page.childIds.push('def', 'hov');
    eng.load(f);
    return eng;
  }
  const componentIdFor = (eng: DocumentEngine, shapeId: string) =>
    Object.entries(eng.getState()!.components).find(([, c]) => c.shapeId === shapeId)![0];

  it('an instance mirrors the master subtree and tracks edits to its children', () => {
    const eng = componentScene();
    eng.createComponent('def', 'page-1');
    const compId = componentIdFor(eng, 'def');
    eng.createInstance(compId, 'page-1', 0, 200);

    const objs1 = objs(eng.getState()!);
    const instance = Object.values(objs1).find(s => s.masterId === compId)!;
    expect(instance.childIds).toHaveLength(1);
    const label = objs1[instance.childIds[0]];
    expect(label.masterShapeId).toBe('defL');
    expect(label.y).toBe(210); // master child offset preserved

    // Editing the master's child reaches the instance's copy.
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'defL', attr: 'fills', val: [{ type: 'solid', color: '#00FF00', opacity: 1 }] }] });
    const after = objs(eng.getState()!)[label.id];
    expect((after.fills[0] as { color: string }).color).toBe('#00FF00');
  });

  it('detaching bakes the master values in and cuts every link in the subtree', () => {
    const eng = componentScene();
    eng.createComponent('def', 'page-1');
    const compId = componentIdFor(eng, 'def');
    eng.createInstance(compId, 'page-1', 0, 200);
    const instanceId = Object.values(objs(eng.getState()!)).find(s => s.masterId === compId)!.id;

    eng.detachInstance(instanceId, 'page-1');
    const detached = objs(eng.getState()!)[instanceId];
    expect(detached.masterId).toBeUndefined();
    expect(objs(eng.getState()!)[detached.childIds[0]].masterShapeId).toBeUndefined();

    // A later master edit no longer reaches it.
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'defL', attr: 'opacity', val: 0.5 }] });
    expect(objs(eng.getState()!)[detached.childIds[0]].opacity).toBe(1);
  });

  it('swapping a variant keeps the instance id, position and component-property values', () => {
    const eng = componentScene();
    eng.combineAsVariants(['def', 'hov'], 'page-1', 'State');
    const defComp = componentIdFor(eng, 'def');
    eng.setComponentProps(defComp, [{ id: 'p-text', name: 'Label', type: 'text', defaultValue: 'Button' }]);
    eng.applyChanges({ pageId: 'page-1', ops: [
      { op: 'set', id: 'defL', attr: 'propBindings', val: { characters: 'p-text' } },
      { op: 'set', id: 'hovL', attr: 'propBindings', val: { characters: 'p-text' } },
    ] });
    eng.createInstance(defComp, 'page-1', 0, 200);
    const instanceId = Object.values(objs(eng.getState()!)).find(s => s.masterId === defComp)!.id;
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: instanceId, attr: 'componentProps', val: { 'p-text': 'Save' } }] });

    const textOf = (id: string) => {
      const o = objs(eng.getState()!);
      return o[o[id].childIds[0]].paragraphs![0].spans[0].text;
    };
    expect(textOf(instanceId)).toBe('Save');

    eng.setInstanceVariant(instanceId, 'page-1', { State: 'Hover' });
    const swapped = objs(eng.getState()!)[instanceId];
    expect(swapped.x).toBe(0);
    expect(swapped.y).toBe(200);
    expect(eng.getState()!.components[swapped.masterId!].shapeId).toBe('hov');
    // The property is declared on the Default variant only — the set shares it.
    expect(textOf(instanceId)).toBe('Save');
  });

  it('a layer added to a master appears in existing instances, and removing it takes it back out', () => {
    const eng = componentScene();
    eng.createComponent('def', 'page-1');
    const compId = componentIdFor(eng, 'def');
    eng.createInstance(compId, 'page-1', 0, 200);
    const instanceId = Object.values(objs(eng.getState()!)).find(s => s.masterId === compId)!.id;
    expect(objs(eng.getState()!)[instanceId].childIds).toHaveLength(1);

    // Add a badge to the master.
    eng.applyChanges({ pageId: 'page-1', ops: [
      { op: 'add', shape: makeDefaultShape({ id: 'badge', type: 'rect', name: 'badge', frameId: 'def', parentId: 'def', x: 130, y: 5, width: 20, height: 20, selrect: { x: 130, y: 5, width: 20, height: 20 } }) },
    ] });

    const withBadge = objs(eng.getState()!);
    const instance = withBadge[instanceId];
    expect(instance.childIds).toHaveLength(2);
    const badgeCopy = instance.childIds.map(id => withBadge[id]).find(c => c.masterShapeId === 'badge')!;
    expect(badgeCopy).toBeTruthy();
    expect(badgeCopy.y).toBe(205); // master y + the instance's offset

    // Removing it from the master removes it from the instance too.
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'del', id: 'badge' }] });
    const after = objs(eng.getState()!);
    expect(after[instanceId].childIds).toHaveLength(1);
    expect(after[badgeCopy.id]).toBeUndefined();
  });

  it('instance children follow the master\'s sibling order', () => {
    const eng = componentScene();
    // Give the master a second child so there is an order to change.
    eng.applyChanges({ pageId: 'page-1', ops: [
      { op: 'add', shape: makeDefaultShape({ id: 'icon', type: 'rect', name: 'icon', frameId: 'def', parentId: 'def', x: 4, y: 4, width: 10, height: 10, selrect: { x: 4, y: 4, width: 10, height: 10 } }) },
    ] });
    eng.createComponent('def', 'page-1');
    const compId = componentIdFor(eng, 'def');
    eng.createInstance(compId, 'page-1', 0, 200);
    const instanceId = Object.values(objs(eng.getState()!)).find(s => s.masterId === compId)!.id;

    const masterOrder = () => objs(eng.getState()!)['def'].childIds;
    const instanceOrder = () => objs(eng.getState()!)[instanceId].childIds
      .map(id => objs(eng.getState()!)[id].masterShapeId);
    expect(instanceOrder()).toEqual(masterOrder());

    // Reorder the master's children; the instance follows.
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'move', id: 'icon', parentId: 'def', index: 0 }] });
    expect(instanceOrder()).toEqual(masterOrder());
  });

  it('undo restores the layers a component property had changed', () => {
    const eng = componentScene();
    eng.createComponent('def', 'page-1');
    const compId = componentIdFor(eng, 'def');
    eng.setComponentProps(compId, [{ id: 'p-text', name: 'Label', type: 'text', defaultValue: 'Button' }]);
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'defL', attr: 'propBindings', val: { characters: 'p-text' } }] });
    eng.createInstance(compId, 'page-1', 0, 200);
    const instanceId = Object.values(objs(eng.getState()!)).find(s => s.masterId === compId)!.id;

    const textOf = () => {
      const o = objs(eng.getState()!);
      return o[o[instanceId].childIds[0]].paragraphs![0].spans[0].text;
    };
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: instanceId, attr: 'componentProps', val: { 'p-text': 'Save' } }] });
    expect(textOf()).toBe('Save');
    eng.undo();
    expect(textOf()).toBe('Button');
    eng.redo();
    expect(textOf()).toBe('Save');
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

  it('a fill child keeps its declared size: Fixed restores it and a hug parent does not ratchet', () => {
    const eng = new DocumentEngine();
    const f = fileWithTwoRects();
    f.pages[0].objects['frame-1'].width = 400;
    f.pages[0].objects['frame-1'].height = 300;
    f.pages[0].objects['frame-1'].autoLayout = {
      direction: 'horizontal', spacing: 10,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      justifyContent: 'start', alignItems: 'start',
    };
    eng.load(f);
    // B fills the leftover space: 400 - 40 (A) - 10 (gap) = 350.
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'B', attr: 'widthMode', val: 'fill' }] });
    expect(objs(eng.getState()!).B.width).toBe(350);
    expect(objs(eng.getState()!).B.baseWidth).toBe(40);

    // A hugging parent measures B's DECLARED width (40), not the stretched 350 …
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'frame-1', attr: 'widthMode', val: 'hug' }] });
    expect(objs(eng.getState()!)['frame-1'].width).toBe(90);
    // … and stays there however many reflows follow.
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'frame-1', attr: 'name', val: 'AL' }] });
    expect(objs(eng.getState()!)['frame-1'].width).toBe(90);

    // Leaving fill restores the declared width instead of freezing the stretched one.
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'B', attr: 'widthMode', val: 'fixed' }] });
    expect(objs(eng.getState()!).B.width).toBe(40);
    expect(objs(eng.getState()!).B.baseWidth).toBeUndefined();
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

describe('undo restores geometry the auto-layout reflow wrote', () => {
  it('turning the frame into an auto-layout container is undoable, positions included', () => {
    const eng = new DocumentEngine();
    eng.load(fileWithTwoRects());
    const before = objs(eng.getState()!);
    expect([before.A.x, before.B.x]).toEqual([10, 100]);

    // Reflow packs B against A with a 20px gap, overwriting B.x.
    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'set', id: 'frame-1', attr: 'autoLayout', val: {
      direction: 'horizontal', spacing: 20,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      justifyContent: 'start', alignItems: 'start',
    } }] });
    expect(objs(eng.getState()!).B.x).toBe(objs(eng.getState()!).A.x + 40 + 20);

    // Undo hands the shapes back to the user — so their pre-layout positions have to
    // come back with them. Re-deriving the reflow cannot do this: with no container
    // left, there is nothing to re-derive from.
    eng.undo();
    const undone = eng.getState()!;
    expect([objs(undone).A.x, objs(undone).B.x]).toEqual([10, 100]);
    expect(objs(undone)['frame-1'].autoLayout).toBeFalsy();

    eng.redo();
    const redone = eng.getState()!;
    expect(objs(redone).B.x).toBe(objs(redone).A.x + 40 + 20);
  });

  it('undo of a child moving into an auto-layout container restores where it was', () => {
    const eng = new DocumentEngine();
    const f = fileWithTwoRects();
    f.pages[0].objects['frame-1'].autoLayout = {
      direction: 'vertical', spacing: 8,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      justifyContent: 'start', alignItems: 'start',
    };
    // C starts outside the container, at a position of its own.
    f.pages[0].objects['C'] = makeDefaultShape({ id: 'C', type: 'rect', name: 'C',
      frameId: 'page-1', parentId: null, x: 600, y: 400, width: 30, height: 30,
      selrect: { x: 600, y: 400, width: 30, height: 30 } });
    f.pages[0].childIds = [...f.pages[0].childIds, 'C'];
    eng.load(f);

    eng.applyChanges({ pageId: 'page-1', ops: [{ op: 'move', id: 'C', parentId: 'frame-1', index: 2 }] });
    expect(objs(eng.getState()!).C.x).not.toBe(600);

    eng.undo();
    const undone = eng.getState()!;
    expect([objs(undone).C.x, objs(undone).C.y]).toEqual([600, 400]);
  });
});

describe('tokens and components keep their promises', () => {
  const tokenFile = () => {
    const f = fileWithTwoRects();
    f.tokens = [{ id: 'tk', name: 'color.brand', $type: 'color', $value: '#FF3366' }];
    return f;
  };

  it('deleting a token drops the bindings that pointed at it', () => {
    const eng = new DocumentEngine();
    eng.load(tokenFile());
    eng.bindToken('A', 'page-1', 'fills.0.color', 'color.brand');
    expect(objs(eng.getState()!).A.fills[0]).toMatchObject({ color: '#FF3366' });
    expect(objs(eng.getState()!).A.tokenBindings).toBeTruthy();

    eng.deleteToken('tk');
    // A dangling binding is a landmine: re-creating the name would silently reclaim the
    // layer. The binding has to go with the token.
    expect(objs(eng.getState()!).A.tokenBindings).toBeUndefined();

    eng.addToken('color.brand', 'color', '#00FF00');
    expect(objs(eng.getState()!).A.fills[0]).toMatchObject({ color: '#FF3366' }); // not reclaimed
  });

  it('editing a token repaints every layer bound to it', () => {
    const eng = new DocumentEngine();
    eng.load(tokenFile());
    eng.bindToken('A', 'page-1', 'fills.0.color', 'color.brand');
    eng.bindToken('B', 'page-1', 'fills.0.color', 'color.brand');
    eng.updateToken('tk', { $value: '#0000FF' });
    const o = objs(eng.getState()!);
    expect(o.A.fills[0]).toMatchObject({ color: '#0000FF' });
    expect(o.B.fills[0]).toMatchObject({ color: '#0000FF' });
  });

  it('a master’s corner radius reaches its instances', () => {
    const eng = new DocumentEngine();
    eng.load(fileWithTwoRects());
    const withComp = eng.createComponent('A', 'page-1')!;
    const componentId = Object.keys(withComp.components)[0];
    const withInst = eng.createInstance(componentId, 'page-1', 500, 500)!;
    const instId = Object.keys(objs(withInst)).find(id => objs(withInst)[id].masterId === componentId)!;
    expect(instId).toBeTruthy();

    eng.applyChanges({ pageId: 'page-1', ops: [
      { op: 'set', id: 'A', attr: 'cornerRadii', val: { tl: 24, tr: 24, br: 24, bl: 24 } },
    ] });
    // Radius sits in the same Appearance row as fills and strokes, which already
    // propagated — it has to travel with them.
    expect(objs(eng.getState()!)[instId].cornerRadii).toEqual({ tl: 24, tr: 24, br: 24, bl: 24 });
  });
});

describe('the token map cache cannot go stale', () => {
  // resolveToken caches name→token per tokens-ARRAY identity, so any mutator that edits
  // the array in place serves a stale map. Both of these failed that way.
  it('a token added after an earlier resolve is immediately usable', () => {
    const eng = new DocumentEngine();
    const f = fileWithTwoRects();
    f.tokens = [{ id: 'first', name: 'color.a', $type: 'color', $value: '#111111' }];
    eng.load(f);
    eng.bindToken('A', 'page-1', 'fills.0.color', 'color.a');   // primes the cache
    eng.addToken('color.b', 'color', '#222222');
    eng.bindToken('B', 'page-1', 'fills.0.color', 'color.b');
    expect(objs(eng.getState()!).B.fills[0]).toMatchObject({ color: '#222222' });
  });

  it('an edited token resolves to its new value, not the cached one', () => {
    const eng = new DocumentEngine();
    const f = fileWithTwoRects();
    f.tokens = [{ id: 'tk', name: 'color.a', $type: 'color', $value: '#111111' }];
    eng.load(f);
    eng.bindToken('A', 'page-1', 'fills.0.color', 'color.a');   // primes the cache
    eng.updateToken('tk', { $value: '#333333' });
    expect(objs(eng.getState()!).A.fills[0]).toMatchObject({ color: '#333333' });
  });
});

describe('variant properties are editable, so a Type × State matrix is buildable', () => {
  const twoMasters = () => {
    const eng = new DocumentEngine();
    eng.load(fileWithTwoRects());
    // Combine names its property, instead of always producing "Variant".
    eng.combineAsVariants(['A', 'B'], 'page-1', 'Type');
    const f = eng.getState()!;
    const setId = Object.keys(f.componentSets!)[0];
    return { eng, setId };
  };

  it('combine uses the property name it is given', () => {
    const { eng, setId } = twoMasters();
    const set = eng.getState()!.componentSets![setId];
    expect(Object.keys(set.properties)).toEqual(['Type']);
    expect(Object.values(set.variants).map(v => v.Type).sort()).toEqual(['A', 'B']);
  });

  it('a second property can be added, giving every variant a default coordinate', () => {
    const { eng, setId } = twoMasters();
    eng.addVariantProperty(setId, 'State', 'Default');
    const set = eng.getState()!.componentSets![setId];
    expect(Object.keys(set.properties).sort()).toEqual(['State', 'Type']);
    // Every variant now sits at a full coordinate — a set with a half-filled matrix
    // would leave an instance's dropdown with nothing to select.
    for (const coords of Object.values(set.variants)) {
      expect(coords.State).toBe('Default');
      expect(coords.Type).toBeTruthy();
    }
  });

  it('renaming a property renames it everywhere, not just in the table', () => {
    const { eng, setId } = twoMasters();
    eng.renameVariantProperty(setId, 'Type', 'Tone');
    const set = eng.getState()!.componentSets![setId];
    expect(Object.keys(set.properties)).toEqual(['Tone']);
    for (const coords of Object.values(set.variants)) {
      expect(coords.Tone).toBeTruthy();
      expect('Type' in coords).toBe(false);
    }
  });

  it('renaming one variant’s value drops the dead option from the set', () => {
    const { eng, setId } = twoMasters();
    const componentId = Object.keys(eng.getState()!.componentSets![setId].variants)[0];
    eng.setVariantValue(componentId, 'Type', 'Primary');
    const set = eng.getState()!.componentSets![setId];
    // 'A' is no longer used by any variant, so it must not linger in the dropdown.
    expect(set.properties.Type).not.toContain('A');
    expect(set.properties.Type).toContain('Primary');
    expect(set.variants[componentId].Type).toBe('Primary');
  });

  it('refuses to remove the last property — a set with none switches nothing', () => {
    const { eng, setId } = twoMasters();
    expect(eng.removeVariantProperty(setId, 'Type')).toBeNull();
    eng.addVariantProperty(setId, 'State', 'Default');
    expect(eng.removeVariantProperty(setId, 'State')).not.toBeNull();
    expect(Object.keys(eng.getState()!.componentSets![setId].properties)).toEqual(['Type']);
  });
});
