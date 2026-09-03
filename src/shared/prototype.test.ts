import { describe, it, expect } from 'vitest';
import { makeDefaultShape, Page, DesignFile, Shape } from './types';
import { generatePrototypeHtml } from './prototype';

function frame(id: string, name: string, x: number, w: number, h: number): Shape {
  return makeDefaultShape({ id, type: 'frame', name, frameId: id, parentId: null, x, y: 0, width: w, height: h,
    selrect: { x, y: 0, width: w, height: h }, childIds: [] });
}

function makeFile(): { file: DesignFile; page: Page } {
  // Two screens; a button on screen A navigates to screen B on click.
  const home = frame('home', 'Home', 0, 375, 812);
  const detail = frame('detail', 'Detail', 500, 375, 812);
  const button = makeDefaultShape({
    id: 'btn', type: 'rect', name: 'CTA', frameId: 'home', parentId: 'home',
    x: 40, y: 700, width: 295, height: 56, selrect: { x: 40, y: 700, width: 295, height: 56 },
    fills: [{ type: 'solid', color: '#6E72F5', opacity: 1 }],
    interactions: [{ id: 'i1', trigger: 'click', action: 'navigate', targetFrameId: 'detail', transition: 'slide-left' }],
  });
  home.childIds = ['btn'];
  const page: Page = {
    id: 'p1', name: 'Page 1', background: '#fff',
    childIds: ['home', 'detail'],
    objects: { home, detail, btn: button },
  };
  const file: DesignFile = {
    id: 'f1', name: 'Test', version: 1, pages: [page], activePageId: 'p1',
    images: {}, components: {}, colors: [], typographies: [], tokens: [], themes: [], activeThemeId: 'default',
    prototypeStartFrameId: 'home',
  };
  return { file, page };
}

describe('generatePrototypeHtml', () => {
  const { file, page } = makeFile();
  const html = generatePrototypeHtml(file, page);

  it('is a self-contained HTML document', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('</html>');
    // no external resources
    expect(html).not.toMatch(/<script src=/);
    expect(html).not.toMatch(/<link [^>]*href=/);
  });

  it('renders each frame as a DOM screen with inspectable CSS (not SVG)', () => {
    expect(html).toContain('id="screen-home"');
    expect(html).toContain('id="screen-detail"');
    expect(html).toContain('class="frame-root"');
    // the button becomes a div with its real background color
    expect(html).toContain('background:#6E72F5');
    // frame body is HTML divs, not an <svg> screen
    expect(html).not.toContain('<svg xmlns="http://www.w3.org/2000/svg"');
  });

  it('emits a click→navigate hotspot positioned frame-relative', () => {
    expect(html).toContain('data-action="navigate"');
    expect(html).toContain('data-target="detail"');
    expect(html).toContain('data-trigger="click"');
    expect(html).toContain('data-transition="slide-left"');
    // frame-relative: button at y=700 inside the frame (not page-absolute weirdness)
    expect(html).toContain('top:700px');
  });

  it('embeds the player runtime with back/forward + fit-to-viewport', () => {
    expect(html).toContain('function fit()');
    expect(html).toContain('function navigate(');
    expect(html).toContain('function goBack(');
    expect(html).toContain('function goForward()');
    expect(html).toContain('START = "home"');
  });

  it('handles a page with no frames without crashing', () => {
    const empty: Page = { id: 'e', name: 'E', background: '#fff', childIds: [], objects: {} };
    const f2: DesignFile = { ...file, pages: [empty], activePageId: 'e' };
    expect(() => generatePrototypeHtml(f2, empty)).not.toThrow();
  });

  it('the embedded runtime parses as valid JavaScript (blank-screen regression)', () => {
    // The runtime lives inside a TS template literal, where a single backslash is
    // cooked away: the URL-guard regex /^https?:\/\//i was emitted as /^https?:///i —
    // a mid-expression line comment. The resulting SyntaxError killed the ENTIRE
    // runtime, so no screen ever got .active and every Present opened blank.
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(m).toBeTruthy();
    expect(() => new Function(m![1])).not.toThrow();
    // The guard regex must survive with escaped slashes.
    expect(m![1]).toContain('/^https?:\\/\\//i');
  });
});
