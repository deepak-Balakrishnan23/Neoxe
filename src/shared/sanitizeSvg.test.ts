// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sanitizeSvgMarkup } from './sanitizeSvg';

describe('sanitizeSvgMarkup', () => {
  it('keeps normal vector content', () => {
    const out = sanitizeSvgMarkup('<rect x="1" y="2" width="10" height="10" fill="red"/><path d="M0 0L5 5"/>');
    expect(out).toContain('<rect');
    expect(out).toContain('<path');
  });

  it('strips <script> elements', () => {
    const out = sanitizeSvgMarkup('<rect/><script>alert(1)</script>');
    expect(out).not.toContain('script');
    expect(out).toContain('<rect');
  });

  it('strips event-handler attributes', () => {
    const out = sanitizeSvgMarkup('<rect onclick="alert(1)" onload="x()" fill="blue"/>');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('onload');
    expect(out).toContain('fill="blue"');
  });

  it('strips foreignObject / iframe', () => {
    const out = sanitizeSvgMarkup('<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></body></foreignObject><circle r="4"/>');
    expect(out.toLowerCase()).not.toContain('foreignobject');
    expect(out).toContain('<circle');
  });

  it('refuses malformed XML entirely (fail closed)', () => {
    expect(sanitizeSvgMarkup('<rect foo=bar unquoted>')).toBe('');
  });

  it('keeps fragment refs but strips javascript: AND external http(s) hrefs', () => {
    const out = sanitizeSvgMarkup('<a href="javascript:alert(1)"><text>x</text></a><use href="#ok"/><image href="https://x/y.png"/>');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('href="#ok"');       // same-document fragment ref kept
    expect(out).not.toContain('https://x/y.png'); // external ref stripped (SSRF/tracking)
  });

  it('keeps inline data:image refs', () => {
    const out = sanitizeSvgMarkup('<image href="data:image/png;base64,iVBOR"/>');
    expect(out).toContain('data:image/png');
  });

  it('handles nested banned elements', () => {
    const out = sanitizeSvgMarkup('<g><g><script>evil()</script><rect/></g></g>');
    expect(out).not.toContain('script');
    expect(out).toContain('<rect');
  });
});
