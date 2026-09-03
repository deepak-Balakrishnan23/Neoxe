// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { makeDefaultShape, Page, DesignFile, Shape, Interaction } from './types';
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

  it('a comment is signed, and an empty one is not saved', () => {
    const { file, page } = buildChain(2);
    mount(generatePrototypeHtml(file, page));
    localStorage.clear();
    localStorage.setItem('edit-proto-author', 'Deep');

    (document.getElementById('commentBtn') as HTMLElement).click();
    const layer = document.querySelector('#screen-f0 .comment-layer') as HTMLElement;
    layer.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 40 }));
    const pop = layer.querySelector('.comment-pop') as HTMLElement;

    // The card names its author — an exported note with no author is useless to whoever
    // receives it.
    expect((pop.querySelector('.who') as HTMLElement).textContent).toBe('Deep');
    expect((pop.querySelector('.avatar') as HTMLElement).textContent).toBe('D');

    // Saving an empty note used to create a blank pin.
    (pop.querySelector('.cbtn-save') as HTMLElement).click();
    expect(layer.querySelector('.comment-pin')).toBeNull();

    (pop.querySelector('textarea') as HTMLTextAreaElement).value = 'Signed feedback';
    (pop.querySelector('.cbtn-save') as HTMLElement).click();
    const stored = JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('edit-proto-comments::'))!)!);
    expect(stored.f0[0]).toMatchObject({ text: 'Signed feedback', author: 'Deep' });
  });

  it('importing a reviewer’s comments merges instead of wiping your own', async () => {
    const { file, page } = buildChain(2);
    mount(generatePrototypeHtml(file, page));
    localStorage.clear();
    localStorage.setItem('edit-proto-author', 'Me');

    // One local comment.
    (document.getElementById('commentBtn') as HTMLElement).click();
    const layer = document.querySelector('#screen-f0 .comment-layer') as HTMLElement;
    layer.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }));
    const pop = layer.querySelector('.comment-pop') as HTMLElement;
    (pop.querySelector('textarea') as HTMLTextAreaElement).value = 'mine';
    (pop.querySelector('.cbtn-save') as HTMLElement).click();

    // A reviewer's file arrives with a different comment on the same screen.
    const incoming = { comments: { f0: [
      { id: 'theirs-1', x: 50, y: 60, text: 'theirs', t: Date.now(), author: 'Reviewer' },
    ] } };
    const input = document.getElementById('importFile') as HTMLInputElement;
    const file2 = new File([JSON.stringify(incoming)], 'comments.json', { type: 'application/json' });
    (input.onchange as (e: unknown) => void)({ target: { files: [file2], value: '' } });
    await new Promise(r => setTimeout(r, 30));   // FileReader is async

    const key = Object.keys(localStorage).find(k => k.startsWith('edit-proto-comments::'))!;
    const stored = JSON.parse(localStorage.getItem(key)!);
    // Both survive. Replacing wholesale destroyed the local notes.
    expect(stored.f0.map((c: { text: string }) => c.text).sort()).toEqual(['mine', 'theirs']);
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

// ── Triggers, overlays, scrolling ─────────────────────────────────────────────
// Everything below drives the exported runtime the way a viewer would: real events on
// real elements, asserting what the screen actually does.

/** Two frames, with `interactions` attached to the FIRST frame itself. */
function twoFrames(interactions: Shape['interactions']): { file: DesignFile; page: Page } {
  const a = frame('f0', 'Home', 0);
  const b = frame('f1', 'Detail', 500);
  a.interactions = interactions;
  const page: Page = { id: 'p1', name: 'Page 1', background: '#fff', childIds: ['f0', 'f1'], objects: { f0: a, f1: b } };
  const file: DesignFile = {
    id: 'fx', name: 'Test', version: 1, pages: [page], activePageId: 'p1',
    images: {}, components: {}, colors: [], typographies: [], tokens: [], themes: [], activeThemeId: 'default',
    prototypeStartFrameId: 'f0',
  };
  return { file, page };
}

const activeId = () => (document.querySelector('.screen.active') as HTMLElement | null)?.id;

describe('exported prototype runtime — triggers', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('a key trigger navigates when its key is pressed, and ignores other keys', () => {
    const { file, page } = twoFrames([
      { id: 'k', trigger: 'key', action: 'navigate', targetFrameId: 'f1', transition: 'none', keyCode: 'Enter' },
    ]);
    mount(generatePrototypeHtml(file, page));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    expect(activeId()).toBe('screen-f0');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(activeId()).toBe('screen-f1');
  });

  it('an after-delay trigger fires once the screen has been up for its delay', async () => {
    const { file, page } = twoFrames([
      { id: 'd', trigger: 'after-delay', action: 'navigate', targetFrameId: 'f1', transition: 'none', delay: 20 },
    ]);
    mount(generatePrototypeHtml(file, page));
    expect(activeId()).toBe('screen-f0');
    await new Promise(r => setTimeout(r, 60));
    expect(activeId()).toBe('screen-f1');
  });

  it('mouse-enter and mouse-leave fire on their own events', () => {
    const { file, page } = twoFrames([
      { id: 'm', trigger: 'mouse-enter', action: 'navigate', targetFrameId: 'f1', transition: 'none' },
    ]);
    mount(generatePrototypeHtml(file, page));
    const hs = document.querySelector('#screen-f0 .hotspot') as HTMLElement;
    hs.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(activeId()).toBe('screen-f1');
  });

  it('"while hovering" reverts when the pointer leaves', () => {
    const { file, page } = twoFrames([
      { id: 'h', trigger: 'hover', action: 'navigate', targetFrameId: 'f1', transition: 'none' },
    ]);
    mount(generatePrototypeHtml(file, page));
    const hs = document.querySelector('#screen-f0 .hotspot') as HTMLElement;
    hs.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(activeId()).toBe('screen-f1');
    hs.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    expect(activeId()).toBe('screen-f0');
  });

  it('a drag trigger waits for real movement rather than firing on press', () => {
    const { file, page } = twoFrames([
      { id: 'g', trigger: 'drag', action: 'navigate', targetFrameId: 'f1', transition: 'none' },
    ]);
    mount(generatePrototypeHtml(file, page));
    const hs = document.querySelector('#screen-f0 .hotspot') as HTMLElement;
    hs.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 100 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 103, clientY: 100 }));
    expect(activeId()).toBe('screen-f0');   // 3px is a click, not a drag
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 160, clientY: 100 }));
    expect(activeId()).toBe('screen-f1');
  });
});

describe('exported prototype runtime — overlays', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('opens an overlay over the current screen and closes it again', () => {
    const { file, page } = twoFrames([
      { id: 'o', trigger: 'click', action: 'overlay', targetFrameId: 'f1', transition: 'none',
        overlay: { position: 'center', background: 'dim', closeOnClickOutside: true } },
    ]);
    mount(generatePrototypeHtml(file, page));
    (document.querySelector('#screen-f0 .hotspot') as HTMLElement).click();

    // The screen underneath stays current — an overlay is not a navigation.
    expect(activeId()).toBe('screen-f0');
    expect(document.querySelectorAll('#screen-f0 .ov-item').length).toBe(1);
    expect(document.querySelectorAll('#screen-f0 .ov-backdrop').length).toBe(1);

    (document.querySelector('.ov-backdrop') as HTMLElement).click();
    expect(document.querySelectorAll('.ov-item').length).toBe(0);
  });

  it('honours "no dim" and "do not close on click outside"', () => {
    const { file, page } = twoFrames([
      { id: 'o', trigger: 'click', action: 'overlay', targetFrameId: 'f1', transition: 'none',
        overlay: { position: 'top-right', background: 'none', closeOnClickOutside: false } },
    ]);
    mount(generatePrototypeHtml(file, page));
    (document.querySelector('#screen-f0 .hotspot') as HTMLElement).click();
    expect(document.querySelectorAll('.ov-backdrop').length).toBe(0);
    const item = document.querySelector('.ov-item') as HTMLElement;
    expect(item.style.top).toBe('0px');
    expect(item.style.right).toBe('0px');
  });

  it('navigating away clears any open overlay', () => {
    const { file, page } = twoFrames([
      { id: 'o', trigger: 'click', action: 'overlay', targetFrameId: 'f1', transition: 'none' },
      { id: 'k', trigger: 'key', action: 'navigate', targetFrameId: 'f1', transition: 'none', keyCode: 'Enter' },
    ]);
    mount(generatePrototypeHtml(file, page));
    (document.querySelector('#screen-f0 .hotspot') as HTMLElement).click();
    expect(document.querySelectorAll('.ov-item').length).toBe(1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(activeId()).toBe('screen-f1');
    expect(document.querySelectorAll('.ov-item').length).toBe(0);
  });
});

describe('exported prototype — scrolling and timing attributes', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('a scrolling frame gets a scroller sized to its content, with pinned layers lifted out', () => {
    const f = frame('f0', 'Home', 0);
    f.scrollBehavior = 'vertical';
    const tall = makeDefaultShape({ id: 'tall', type: 'rect', name: 'Body', frameId: 'f0', parentId: 'f0',
      x: 0, y: 0, width: 400, height: 900, selrect: { x: 0, y: 0, width: 400, height: 900 } });
    const bar = makeDefaultShape({ id: 'bar', type: 'rect', name: 'Nav', frameId: 'f0', parentId: 'f0',
      x: 0, y: 0, width: 400, height: 60, selrect: { x: 0, y: 0, width: 400, height: 60 } });
    bar.scrollPosition = 'fixed';
    f.childIds = ['tall', 'bar'];
    const page: Page = { id: 'p1', name: 'P', background: '#fff', childIds: ['f0'], objects: { f0: f, tall, bar } };
    const file: DesignFile = { id: 'fz', name: 'T', version: 1, pages: [page], activePageId: 'p1',
      images: {}, components: {}, colors: [], typographies: [], tokens: [], themes: [], activeThemeId: 'default',
      prototypeStartFrameId: 'f0' };

    const html = generatePrototypeHtml(file, page);
    expect(html).toContain('overflow:hidden auto');
    expect(html).toContain('height:900px');
    // The pinned bar is drawn in its own layer, not inside the scrolling body.
    document.body.innerHTML = html.match(/<body>([\s\S]*?)<script>/)![1];
    expect(document.querySelectorAll('.fixed-layer [data-layer="Nav"]').length).toBe(1);
    expect(document.querySelectorAll('.scroll-content [data-layer="Nav"]').length).toBe(0);
    expect(document.querySelectorAll('.scroll-content [data-layer="Body"]').length).toBe(1);
  });

  it('carries each interaction\'s own duration and easing into the markup', () => {
    const { file, page } = twoFrames([
      { id: 'n', trigger: 'click', action: 'navigate', targetFrameId: 'f1',
        transition: 'push-left', duration: 640, easing: 'ease-in-out' },
    ]);
    const html = generatePrototypeHtml(file, page);
    expect(html).toContain('data-transition="push-left"');
    expect(html).toContain('data-duration="640"');
    expect(html).toContain('data-easing="ease-in-out"');
  });

  it('drops a scroll-to whose target has been deleted, and keeps a valid one', () => {
    const { file, page } = twoFrames([
      { id: 's', trigger: 'click', action: 'scroll-to', transition: 'none', scrollTargetId: 'ghost' },
    ]);
    expect(generatePrototypeHtml(file, page)).not.toContain('data-action="scroll-to"');

    const target = makeDefaultShape({ id: 'sec', type: 'rect', name: 'Section', frameId: 'f0', parentId: 'f0',
      x: 0, y: 700, width: 400, height: 100, selrect: { x: 0, y: 700, width: 400, height: 100 } });
    page.objects['sec'] = target;
    page.objects['f0'].childIds = ['sec'];
    page.objects['f0'].interactions = [
      { id: 's', trigger: 'click', action: 'scroll-to', transition: 'none', scrollTargetId: 'sec' },
    ];
    const html = generatePrototypeHtml(file, page);
    expect(html).toContain('data-action="scroll-to"');
    expect(html).toContain('data-scroll-y="700"');
  });
});

// ── Figma-parity fixes: timing that was authored but discarded, and event precision ──
// jsdom has no Web Animations, so the runtime's anim() bails out via `!el.animate`. Stub it
// to record what the runtime ASKED for — that is exactly the authored-timing claim.
function recordAnimations(): { calls: { duration: number; easing: string }[] } {
  const rec: { calls: { duration: number; easing: string }[] } = { calls: [] };
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true, writable: true,
    value: function (_frames: unknown, opts: { duration: number; easing: string }) {
      rec.calls.push({ duration: opts.duration, easing: opts.easing });
      return { onfinish: null, cancel() {} };
    },
  });
  return rec;
}

describe('authored transition timing is honoured, not silently discarded', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('Back uses the interaction’s own duration and easing', () => {
    const { file, page } = buildChain(2);
    // Screen f1 carries a Back interaction with deliberately distinctive timing.
    page.objects.f1.interactions = [{
      id: 'b1', trigger: 'click', action: 'back',
      transition: 'dissolve', duration: 900, easing: 'linear',
    }];
    mount(generatePrototypeHtml(file, page));
    (document.querySelector('#screen-f0 .hotspot') as HTMLElement).click();   // f0 -> f1
    const rec = recordAnimations();
    (document.querySelector('#screen-f1 .hotspot[data-action="back"]') as HTMLElement).click();
    // Before the fix goBack() hardcoded 220ms / ease-out and threw these away, so the
    // Animation, Easing and Duration controls did nothing whatsoever for a Back action.
    expect(rec.calls.some(c => c.duration === 900)).toBe(true);
    expect(document.querySelector('.screen.active')!.id).toBe('screen-f0');
  });

  it('Close overlay uses the interaction’s own duration', () => {
    const { file, page } = buildChain(2);
    page.objects.f0.interactions = [{
      id: 'o1', trigger: 'click', action: 'overlay', targetFrameId: 'f1',
      transition: 'dissolve', duration: 10,
    }];
    page.objects.f1.interactions = [{
      id: 'c1', trigger: 'click', action: 'close-overlay',
      transition: 'dissolve', duration: 800, easing: 'linear',
    }];
    mount(generatePrototypeHtml(file, page));
    (document.querySelector('#screen-f0 .hotspot[data-action="overlay"]') as HTMLElement).click();
    const rec = recordAnimations();
    const closer = document.querySelector('.ov-item .hotspot[data-action="close-overlay"]')
      ?? document.querySelector('.hotspot[data-action="close-overlay"]');
    (closer as HTMLElement).click();
    expect(rec.calls.some(c => c.duration === 800)).toBe(true);   // was hardcoded 160
  });

  it('the toolbar Back button still works after Back gained parameters', () => {
    // Regression: backBtn.onclick = goBack passed a MouseEvent as the transition, which
    // reached transition.replace() and threw.
    const { file, page } = buildChain(2);
    mount(generatePrototypeHtml(file, page));
    (document.querySelector('#screen-f0 .hotspot') as HTMLElement).click();
    expect(document.querySelector('.screen.active')!.id).toBe('screen-f1');
    (document.getElementById('backBtn') as HTMLElement).click();
    expect(document.querySelector('.screen.active')!.id).toBe('screen-f0');
  });
});

describe('slide-* is a distinct transition from move-in-*', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  const animateOutgoing = (transition: 'slide-left' | 'move-in-left') => {
    const { file, page } = buildChain(2);
    page.objects.f0.interactions = [{
      id: 'n1', trigger: 'click', action: 'navigate', targetFrameId: 'f1',
      transition, duration: 300,
    }];
    mount(generatePrototypeHtml(file, page));
    const rec = recordAnimations();
    (document.querySelector('#screen-f0 .hotspot') as HTMLElement).click();
    return rec.calls.length;
  };

  it('slide moves the outgoing screen as well as the incoming one', () => {
    // Two animations: incoming in, outgoing drifting. Figma's Slide moves both; before the
    // fix the direction suffix was stripped and slide-* was byte-identical to move-in-*,
    // making four of the eighteen dropdown options silent duplicates.
    expect(animateOutgoing('slide-left')).toBe(2);
  });

  it('move-in leaves the outgoing screen where it is', () => {
    expect(animateOutgoing('move-in-left')).toBe(1);
  });
});

describe('mouse-enter fires on the hotspot boundary, not on every descendant', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('does not re-fire when the pointer moves between children of the same hotspot', () => {
    const { file, page } = buildChain(3);
    page.objects.f0.interactions = [{
      id: 'm1', trigger: 'mouse-enter', action: 'navigate', targetFrameId: 'f1',
      transition: 'none', duration: 0,
    }];
    mount(generatePrototypeHtml(file, page));
    const hotspot = document.querySelector('#screen-f0 .hotspot') as HTMLElement;
    const inner = document.createElement('span');
    hotspot.appendChild(inner);

    // Entering from outside: fires.
    hotspot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    expect(document.querySelector('.screen.active')!.id).toBe('screen-f1');

    // Now back on f0 and slide the pointer onto a child of the SAME hotspot. mouseover
    // bubbles from descendants, so this used to re-fire the navigate — moving from a
    // button's padding onto its own label counted as a fresh mouse-enter.
    (document.getElementById('homeBtn') as HTMLElement).click();
    expect(document.querySelector('.screen.active')!.id).toBe('screen-f0');
    inner.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: hotspot }));
    expect(document.querySelector('.screen.active')!.id).toBe('screen-f0');
  });
});

// ── Figma parity: "Change to" (variant swap) and "Set variable mode" (theme swap) ──

/** One screen holding an instance of variant A, with variant B's master parked offscreen. */
function buildVariantFile(trigger: Interaction['trigger'] = 'click') {
  const mk = (o: Partial<Shape> & { id: string; name: string }) => makeDefaultShape({
    type: 'frame', frameId: o.id, x: 0, y: 0, width: 100, height: 40,
    selrect: { x: o.x ?? 0, y: o.y ?? 0, width: 100, height: 40 }, ...o,
  } as Parameters<typeof makeDefaultShape>[0]);

  const screen = mk({ id: 'f0', name: 'Screen', x: 0, y: 0, width: 400, height: 300,
    selrect: { x: 0, y: 0, width: 400, height: 300 },
    fills: [{ type: 'solid', color: '#ffffff', opacity: 1 }], childIds: ['inst'] });
  // The instance sits at (50,60) inside the screen and points at variant A.
  const inst = mk({ id: 'inst', name: 'Button', frameId: 'f0', parentId: 'f0', x: 50, y: 60,
    selrect: { x: 50, y: 60, width: 100, height: 40 }, masterId: 'cmpA',
    fills: [{ type: 'solid', color: '#5C7CFA', opacity: 1 }],
    interactions: [{ id: 'sw', trigger, action: 'change-to', targetComponentId: 'cmpB', transition: 'none' }] });
  // Variant B's master lives far away on the canvas — its coordinates must be translated
  // onto the instance when the runtime swaps it in.
  const masterB = mk({ id: 'mB', name: 'Button / Hover', frameId: 'mB', x: 900, y: 900,
    selrect: { x: 900, y: 900, width: 100, height: 40 }, componentId: 'cmpB',
    fills: [{ type: 'solid', color: '#3B5BDB', opacity: 1 }] });

  const page: Page = { id: 'p1', name: 'Page 1', background: '#fff',
    childIds: ['f0', 'mB'], objects: { f0: screen, inst, mB: masterB } };
  const file: DesignFile = {
    id: 'f1', name: 'Variants', version: 1, pages: [page], activePageId: 'p1',
    images: {},
    components: { cmpA: { name: 'Button / Default', pageId: 'p1', shapeId: 'inst', setId: 'set1' },
      cmpB: { name: 'Button / Hover', pageId: 'p1', shapeId: 'mB', setId: 'set1' } },
    colors: [], typographies: [], tokens: [], themes: [], activeThemeId: 'default',
    prototypeStartFrameId: 'f0',
  };
  return { file, page };
}

describe('Change to — swaps an instance to a sibling variant in place', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  const shown = (variant: string) =>
    [...document.querySelectorAll('#screen-f0 [data-vvariant="' + variant + '"]')]
      .filter(el => (el as HTMLElement).style.display !== 'none').length;

  it('renders both variants, with only the current one visible', () => {
    const { file, page } = buildVariantFile();
    mount(generatePrototypeHtml(file, page));
    expect(document.querySelectorAll('#screen-f0 [data-vgroup="inst"]').length).toBeGreaterThan(1);
    expect(shown('cmpA')).toBeGreaterThan(0);
    expect(shown('cmpB')).toBe(0);       // the alternate ships hidden
  });

  it('positions the alternate variant over the instance, not at the master’s coordinates', () => {
    const { file, page } = buildVariantFile();
    const html = generatePrototypeHtml(file, page);
    mount(html);
    const alt = document.querySelector('#screen-f0 [data-vvariant="cmpB"]') as HTMLElement;
    // Master B is at (900,900) on the canvas; the instance is at (50,60) in the screen.
    expect(alt.style.left).toBe('50px');
    expect(alt.style.top).toBe('60px');
  });

  it('clicking swaps which variant is displayed', () => {
    const { file, page } = buildVariantFile('click');
    mount(generatePrototypeHtml(file, page));
    (document.querySelector('#screen-f0 .hotspot[data-action="change-to"]') as HTMLElement).click();
    expect(shown('cmpB')).toBeGreaterThan(0);
    expect(shown('cmpA')).toBe(0);
    // …and it stays on the same screen. A variant swap is not navigation.
    expect(document.querySelector('.screen.active')!.id).toBe('screen-f0');
  });

  it('a While-hovering swap reverts when the pointer leaves', () => {
    const { file, page } = buildVariantFile('hover');
    mount(generatePrototypeHtml(file, page));
    const spot = document.querySelector('#screen-f0 .hotspot[data-action="change-to"]') as HTMLElement;
    spot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    expect(shown('cmpB')).toBeGreaterThan(0);
    spot.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    expect(shown('cmpA')).toBeGreaterThan(0);   // back to the variant it started on
    expect(shown('cmpB')).toBe(0);
  });

  it('a variant target that no longer exists emits no hotspot', () => {
    const { file, page } = buildVariantFile();
    page.objects.inst.interactions![0].targetComponentId = 'deleted';
    expect(generatePrototypeHtml(file, page)).not.toContain('data-action="change-to"');
  });
});

describe('Set variable mode — retheming without leaving the screen', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  function buildThemedFile() {
    const { file, page } = buildChain(1);
    file.tokens = [{ id: 't1', name: 'color.primary', $type: 'color', $value: '#5C7CFA' }];
    file.themes = [{ id: 'dark', name: 'Dark', values: { 'color.primary': '#0EA5A5' } }];
    // A box bound to the token, and a hotspot that switches to the Dark mode.
    page.objects.box = makeDefaultShape({
      id: 'box', type: 'rect', name: 'Box', frameId: 'f0', parentId: 'f0',
      x: 10, y: 10, width: 80, height: 80, selrect: { x: 10, y: 10, width: 80, height: 80 },
      fills: [{ type: 'solid', color: '#5C7CFA', opacity: 1 }],
      tokenBindings: { 'fills.0.color': 'color.primary' },
      interactions: [{ id: 'm1', trigger: 'click', action: 'set-variable-mode',
        targetThemeId: 'dark', transition: 'none' }],
    });
    page.objects.f0.childIds = ['box'];
    return { file, page };
  }

  it('emits a custom property per colour token, and a block per mode', () => {
    const { file, page } = buildThemedFile();
    const html = generatePrototypeHtml(file, page);
    expect(html).toContain('--tok-color-primary:#5C7CFA');            // :root default
    expect(html).toContain('body[data-proto-mode="dark"]');
    expect(html).toContain('--tok-color-primary:#0EA5A5');            // the Dark override
  });

  it('re-expresses the bound colour as var() so the mode can win', () => {
    const { file, page } = buildThemedFile();
    mount(generatePrototypeHtml(file, page));
    const box = document.querySelector('[data-id="box"]') as HTMLElement;
    // The baked colour stays as the fallback; the var() is appended after it and wins.
    expect(box.getAttribute('style')).toContain('background:var(--tok-color-primary)');
  });

  it('clicking sets the mode on <body>, and Default clears it', () => {
    const { file, page } = buildThemedFile();
    mount(generatePrototypeHtml(file, page));
    (document.querySelector('.hotspot[data-action="set-variable-mode"]') as HTMLElement).click();
    expect(document.body.getAttribute('data-proto-mode')).toBe('dark');

    page.objects.box.interactions![0].targetThemeId = 'default';
    mount(generatePrototypeHtml(file, page));
    (document.querySelector('.hotspot[data-action="set-variable-mode"]') as HTMLElement).click();
    expect(document.body.hasAttribute('data-proto-mode')).toBe(false);
  });

  it('an unknown mode emits no hotspot, and files with no mode switch carry no var()', () => {
    const { file, page } = buildThemedFile();
    page.objects.box.interactions![0].targetThemeId = 'nope';
    expect(generatePrototypeHtml(file, page)).not.toContain('data-action="set-variable-mode"');

    // No switcher anywhere -> no var() indirection is added to the export at all.
    page.objects.box.interactions = [];
    expect(generatePrototypeHtml(file, page)).not.toContain('background:var(--tok-');
  });
});
