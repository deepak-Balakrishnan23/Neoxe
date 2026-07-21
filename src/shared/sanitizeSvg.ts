// SVG markup sanitizer. Imported SVG files and opened .design documents are UNTRUSTED —
// their markup is re-injected into the live DOM via dangerouslySetInnerHTML (VectorOverlay),
// so a crafted file could otherwise execute script in the app (stored XSS). This strips
// script-capable elements and attributes while preserving normal vector content.
//
// Canvas rendering (drawSVG via <img>) is inherently script-blocked by the browser; this
// sanitizer exists for the DOM overlay path.

const BANNED_ELEMENTS = new Set([
  'script', 'foreignobject', 'iframe', 'object', 'embed', 'audio', 'video', 'meta', 'link', 'base',
]);

function sanitizeElement(el: Element) {
  // Remove banned children (snapshot the list — we mutate while iterating).
  for (const child of [...el.children]) {
    if (BANNED_ELEMENTS.has(child.tagName.toLowerCase())) child.remove();
    else sanitizeElement(child);
  }
  // Strip event handlers and script-capable attribute values.
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    const value = attr.value.trim().toLowerCase();
    if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
    // Only same-document fragment refs (#id) and inline data:image/ are allowed. External
    // http(s) refs are stripped — a `<use href="http://evil/x.svg#a">` or an <image> with a
    // remote href in an untrusted file would exfiltrate/track (SSRF/pixel) or pull hostile
    // markup on open.
    if ((name === 'href' || name === 'xlink:href' || name === 'src')
        && !(value.startsWith('#') || value.startsWith('data:image/'))) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (value.includes('javascript:')) el.removeAttribute(attr.name);
  }
}

/**
 * Sanitize a fragment of SVG markup (inner content of an <svg>). Returns markup safe to
 * inject into the DOM. Malformed input comes back as-parsed (browser-recovered) markup.
 */
export function sanitizeSvgMarkup(markup: string): string {
  if (!markup) return '';
  // Fast path: nothing even resembling an element/attribute of interest.
  if (!/[<&]/.test(markup)) return markup;
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, 'image/svg+xml');
  const root = doc.documentElement;
  // Malformed XML → refuse the whole fragment (parsers report this differently:
  // a <parsererror> child in browsers, a replaced root in jsdom).
  if (root.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length > 0) return '';
  sanitizeElement(root);
  return root.innerHTML;
}
