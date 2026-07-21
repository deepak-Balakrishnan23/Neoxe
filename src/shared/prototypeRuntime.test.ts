// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { makeDefaultShape, Page, DesignFile, Shape } from './types';
import { generatePrototypeHtml } from './prototype';

// Full integration test of the EXPORTED runtime: build a multi-frame navigate chain,
// generate the self-contained HTML, load it into jsdom, execute the embedded <script>,
// and drive real hotspot clicks — asserting the active screen actually changes. This is
// the end-to-end guard for "Present renders only the first frame / clicks do nothing".

function frame(id: string, name: string, x: number): Shape {
  return makeDefaultShape({
    id, type: 'frame', name, frameId: id, parentId: null,
    x, y: 0, width: 400, height: 300, selrect: { x, y: 0, width: 400, height: 300 },
    fills: [{ type: 'solid', color: '#ffffff', opacity: 1 }], childIds: [],
  });
}

function buildChain(n: number): { file: DesignFile; page: Page } {
  const frames: Shape[] = [];
  const objects: Record<string, Shape> = {};
  for (let i = 0; i < n; i++) {
    const f = frame(`f${i}`, i === 0 ? 'Frame 1' : String(i + 1), i * 500);
    frames.push(f);
    objects[f.id] = f;
  }
  // A full-frame hotspot on each screen navigating to the next (last → first), like the
  // user's Frame 1 → 2 → 3 → 4 → 5 → 6 → Frame 1 chain.
  for (let i = 0; i < n; i++) {
    const target = frames[(i + 1) % n];
    const hs = makeDefaultShape({
      id: `hs${i}`, type: 'rect', name: 'Hotspot', frameId: frames[i].id, parentId: frames[i].id,
      x: frames[i].x, y: 0, width: 400, height: 300, selrect: { x: frames[i].x, y: 0, width: 400, height: 300 },
      fills: [{ type: 'solid', color: '#6E72F5', opacity: 1 }],
      interactions: [{ id: `int${i}`, trigger: 'click', action: 'navigate', targetFrameId: target.id, transition: 'dissolve' }],
    });
    frames[i].childIds = [hs.id];
    objects[hs.id] = hs;
  }
  const page: Page = { id: 'p1', name: 'Page 1', background: '#fff', childIds: frames.map(f => f.id), objects };
  const file: DesignFile = {
    id: 'f1', name: 'Test', version: 1, pages: [page], activePageId: 'p1',
    images: {}, components: {}, colors: [], typographies: [], tokens: [], themes: [], activeThemeId: 'default',
    prototypeStartFrameId: 'f0',
  };
  return { file, page };
}

// The user's actual flow: drag-connect from a WHOLE FRAME to the next (Frame 1 → 2 → …).
// The navigate interaction is stored on the FRAME itself, not a child — which must still
// produce a full-screen hotspot.
function buildFrameChain(n: number): { file: DesignFile; page: Page } {
  const frames: Shape[] = [];
  const objects: Record<string, Shape> = {};
  for (let i = 0; i < n; i++) {
    const f = frame(`f${i}`, i === 0 ? 'Frame 1' : String(i + 1), i * 500);
    frames.push(f);
    objects[f.id] = f;
  }
  for (let i = 0; i < n; i++) {
    frames[i].interactions = [{
      id: `int${i}`, trigger: 'click', action: 'navigate',
      targetFrameId: frames[(i + 1) % n].id, transition: 'dissolve',
    }];
  }
  const page: Page = { id: 'p1', name: 'Page 1', background: '#fff', childIds: frames.map(f => f.id), objects };
  const file: DesignFile = {
    id: 'f1', name: 'Test', version: 1, pages: [page], activePageId: 'p1',
    images: {}, components: {}, colors: [], typographies: [], tokens: [], themes: [], activeThemeId: 'default',
    prototypeStartFrameId: 'f0',
  };
  return { file, page };
}

// Execute the generated document's runtime into the current jsdom window.
function mount(html: string) {
  const scriptSrc = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const bodyInner = html.match(/<body>([\s\S]*?)<script>/)![1];
  document.body.innerHTML = bodyInner;
  // jsdom lacks layout — stub the size reads fit() depends on so it doesn't divide by 0.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 800 });
  // eslint-disable-next-line no-new-func
  new Function(scriptSrc)();
}

describe('exported prototype runtime — live navigation (jsdom)', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('shows the start screen active on load', () => {
    const { file, page } = buildChain(6);
    mount(generatePrototypeHtml(file, page));
    const active = document.querySelectorAll('.screen.active');
    expect(active.length).toBe(1);
    expect((active[0] as HTMLElement).id).toBe('screen-f0');
  });

  it('clicking a hotspot navigates to the next screen', () => {
    const { file, page } = buildChain(6);
    mount(generatePrototypeHtml(file, page));
    const hotspot = document.querySelector('#screen-f0 .hotspot') as HTMLElement;
    expect(hotspot).toBeTruthy();
    hotspot.click();
    const active = document.querySelector('.screen.active') as HTMLElement;
    expect(active.id).toBe('screen-f1');
  });

  it('walks the entire 6-frame chain and loops back to the start', () => {
    const { file, page } = buildChain(6);
    mount(generatePrototypeHtml(file, page));
    const expectedOrder = ['screen-f1', 'screen-f2', 'screen-f3', 'screen-f4', 'screen-f5', 'screen-f0'];
    for (const expected of expectedOrder) {
      const active = document.querySelector('.screen.active') as HTMLElement;
      const hotspot = active.querySelector('.hotspot') as HTMLElement;
      hotspot.click();
      expect((document.querySelector('.screen.active') as HTMLElement).id).toBe(expected);
    }
  });

  it('frame→frame connections (source is the whole frame) produce clickable full-screen hotspots', () => {
    // Regression: hotspot generation walked only frame.childIds, so an interaction stored
    // ON the frame (the drag-connect-from-a-whole-frame flow) yielded ZERO hotspots —
    // Present showed screen 1 and every click did nothing.
    const { file, page } = buildFrameChain(6);
    const html = generatePrototypeHtml(file, page);
    // Each of the 6 screens must carry exactly one navigate hotspot.
    mount(html);
    const perScreen = ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'].map(id =>
      document.querySelectorAll(`#screen-${id} .hotspot[data-action="navigate"]`).length);
    expect(perScreen).toEqual([1, 1, 1, 1, 1, 1]);

    // And the chain is actually walkable by clicking.
    const order = ['screen-f1', 'screen-f2', 'screen-f3', 'screen-f4', 'screen-f5', 'screen-f0'];
    for (const expected of order) {
      const active = document.querySelector('.screen.active') as HTMLElement;
      (active.querySelector('.hotspot') as HTMLElement).click();
      expect((document.querySelector('.screen.active') as HTMLElement).id).toBe(expected);
    }
  });

  it('back button returns to the previous screen', () => {
    const { file, page } = buildChain(3);
    mount(generatePrototypeHtml(file, page));
    (document.querySelector('#screen-f0 .hotspot') as HTMLElement).click();
    expect((document.querySelector('.screen.active') as HTMLElement).id).toBe('screen-f1');
    (document.getElementById('backBtn') as HTMLElement).click();
    expect((document.querySelector('.screen.active') as HTMLElement).id).toBe('screen-f0');
  });

  it('LOOSE shapes sitting inside a frame render on its screen AND their connections work', () => {
    // The "click → blank white screen" case: a shape that looks like it's in the frame is
    // actually a page-level sibling (not a child). It must still render on that screen and
    // its interaction must still be a clickable hotspot.
    const frames: Shape[] = [];
    const objects: Record<string, Shape> = {};
    for (let i = 0; i < 3; i++) {
      const f = frame(`f${i}`, i === 0 ? 'Frame 1' : String(i + 1), i * 500);
      frames.push(f); objects[f.id] = f;
    }
    // Loose rects: top-level (parentId null), positioned INSIDE each frame, connected to next.
    const looseIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const rid = `loose${i}`;
      objects[rid] = makeDefaultShape({
        id: rid, type: 'rect', name: 'Loose', frameId: 'p1', parentId: null,
        x: i * 500 + 40, y: 60, width: 120, height: 90,
        selrect: { x: i * 500 + 40, y: 60, width: 120, height: 90 },
        fills: [{ type: 'solid', color: '#6E72F5', opacity: 1 }],
        interactions: [{ id: `li${i}`, trigger: 'click', action: 'navigate', targetFrameId: `f${(i + 1) % 3}`, transition: 'dissolve' }],
      });
      looseIds.push(rid);
    }
    // Page childIds: frames + loose rects, all top-level.
    const page: Page = { id: 'p1', name: 'Page 1', background: '#fff', childIds: [...frames.map(f => f.id), ...looseIds], objects };
    const file: DesignFile = {
      id: 'f1', name: 'Test', version: 1, pages: [page], activePageId: 'p1',
      images: {}, components: {}, colors: [], typographies: [], tokens: [], themes: [], activeThemeId: 'default',
      prototypeStartFrameId: 'f0',
    };
    const html = generatePrototypeHtml(file, page);
    mount(html);
    // Each screen renders its loose rect (the accent fill appears once per screen).
    ['f0', 'f1', 'f2'].forEach(id => {
      const screen = document.getElementById(`screen-${id}`)!;
      const rects = [...screen.querySelectorAll('.frame-root div')].filter(d => (d.getAttribute('style') || '').toLowerCase().includes('6e72f5'));
      expect(rects.length).toBe(1);
      expect(screen.querySelectorAll('.hotspot[data-action="navigate"]').length).toBe(1);
    });
    // And clicking the loose rect navigates.
    (document.querySelector('#screen-f0 .hotspot') as HTMLElement).click();
    expect((document.querySelector('.screen.active') as HTMLElement).id).toBe('screen-f1');
  });

  it('comment mode: place → save → pin renders at click point; persists to localStorage', () => {
    const { file, page } = buildChain(3);
    mount(generatePrototypeHtml(file, page));
    localStorage.clear();

    // Enter comment mode (💬 toolbar button)
    (document.getElementById('commentBtn') as HTMLElement).click();
    expect(document.body.classList.contains('comment-mode')).toBe(true);

    // Click the ACTIVE screen's comment layer at (120, 80) → editor popup opens there
    const layer = document.querySelector('#screen-f0 .comment-layer') as HTMLElement;
    layer.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 120, clientY: 80 }));
    const pop = layer.querySelector('.comment-pop') as HTMLElement;
    expect(pop).toBeTruthy();

    // Type + save → a pin appears at the clicked coordinates and localStorage holds it
    (pop.querySelector('textarea') as HTMLTextAreaElement).value = 'Fix this button';
    (pop.querySelector('.cbtn-save') as HTMLElement).click();
    const pin = layer.querySelector('.comment-pin') as HTMLElement;
    expect(pin).toBeTruthy();
    expect(pin.style.left).toBe('120px');
    expect(pin.style.top).toBe('80px');
    const stored = JSON.parse(localStorage.getItem('edit-proto-comments::proto-f1')!);
    expect(stored.f0[0].text).toBe('Fix this button');

    // Clicking a hotspot while in comment mode must NOT navigate (comments own the click)
    (document.querySelector('#screen-f0 .hotspot') as HTMLElement).click();
    expect((document.querySelector('.screen.active') as HTMLElement).id).toBe('screen-f0');

    // Leave comment mode → hotspot navigation works again
    (document.getElementById('commentBtn') as HTMLElement).click();
    (document.querySelector('#screen-f0 .hotspot') as HTMLElement).click();
    expect((document.querySelector('.screen.active') as HTMLElement).id).toBe('screen-f1');
  });

  it('comment layer overlays the screen and never blocks normal-mode clicks (CSS contract)', () => {
    const { file, page } = buildChain(2);
    const html = generatePrototypeHtml(file, page);
    // The layer must be a full-screen overlay ABOVE hotspots that ignores the mouse unless
    // comment mode is on — this is what makes comments placeable over full-screen hotspots.
    expect(html).toContain('.comment-layer { position:absolute; inset:0; z-index:15; pointer-events:none; }');
    expect(html).toContain('body.comment-mode .comment-layer { pointer-events:auto;');
  });
});
