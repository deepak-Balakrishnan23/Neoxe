import { DesignFile, Page, Shape, Interaction, ThemeSet } from './types';
import { frameToHtml, frameToResponsiveHtml, subtreeToHtml, ElementDecoration } from './codegen';
import { resolveToken } from './tokens';

// ── Single-file clickable HTML prototype generator ────────────────────────────
// Produces a fully self-contained .html file: every top-level frame becomes a
// "screen" rendered as real HTML/CSS (inspectable in DevTools), hotspots navigate
// between screens, and a built-in comment layer lets any viewer pin notes (saved
// to localStorage, exportable as JSON). No server, no account — just open the file.

interface ScreenData {
  id: string;
  name: string;
  width: number;
  height: number;
}

// Which token binding drives which CSS property in the exported HTML. Only colour-ish
// bindings are re-expressed as custom properties — those are what a mode switch changes.
// `border-color` works because the generated `border` shorthand is emitted first.
const THEMED_PROPS: Record<string, string> = {
  'fills.0.color': 'background',
  'textStyle.color': 'color',
  'strokes.0.color': 'border-color',
};

const cssVarName = (token: string) => `--tok-${token.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;

/**
 * One CSS block for the base values and one per ThemeSet. "Set variable mode" then costs a
 * single attribute on <body> instead of re-rendering every screen — which is also why the
 * baked colour stays in the element's own style as the var() fallback.
 */
function themeVarCss(file: DesignFile): string {
  const colours = file.tokens.filter(t => t.$type === 'color');
  if (colours.length === 0) return '';
  const decls = (theme: ThemeSet | null) => colours
    .map(t => {
      const v = resolveToken(t.name, file.tokens, theme);
      return v == null ? '' : `${cssVarName(t.name)}:${v}`;
    })
    .filter(Boolean).join(';');
  const modes = (file.themes ?? [])
    .map(t => `  body[data-proto-mode="${escapeAttr(t.id)}"] { ${decls(t)} }`)
    .join('\n');
  return `  :root { ${decls(null)} }${modes ? '\n' + modes : ''}`;
}

export interface PrototypeOptions {
  /**
   * Emit each screen as a nested auto-layout tree that reflows with the window, instead of
   * a pixel-faithful snapshot scaled to fit. Turns the export into a working responsive
   * website rather than a picture of one — at the cost of exact fidelity for layers the
   * flow model can't express (vectors keep their absolute pinning).
   */
  responsive?: boolean;
}

export function generatePrototypeHtml(file: DesignFile, page: Page, opts: PrototypeOptions = {}): string {
  const responsive = !!opts.responsive;
  // Top-level frames are screens
  const frameIds = page.childIds.filter(id => page.objects[id]?.type === 'frame');
  const frames = frameIds.map(id => page.objects[id]).filter(Boolean) as Shape[];

  // Fallback: nothing to show
  if (frames.length === 0) {
    return wrapHtml(file.name, '', '[]', 'null', '{}', '');
  }

  const startId = file.prototypeStartFrameId && frameIds.includes(file.prototypeStartFrameId)
    ? file.prototypeStartFrameId
    : frameIds[0];

  const screens: ScreenData[] = frames.map(f => ({ id: f.id, name: f.name, width: f.width, height: f.height }));

  // Only rewrite colours as custom properties when something can actually switch modes —
  // otherwise every export would carry var() indirection for no reason.
  const modeSwitching = Object.values(page.objects)
    .some(s2 => (s2.interactions ?? []).some(i => i.action === 'set-variable-mode'));

  // Render each screen: DOM body + hotspot overlays
  const screensHtml = frames.map(frame => {
    // Layers pinned against scrolling are lifted out of the scrolling body and drawn in
    // their own layer, so they stay put while the content moves under them.
    const fixedIds = frame.childIds.filter(id => page.objects[id]?.scrollPosition === 'fixed');
    const scrollsAt = frame.scrollBehavior && frame.scrollBehavior !== 'none' ? frame.scrollBehavior : null;

    // Scrollable content extends to the furthest descendant, so the scroller has
    // something to scroll to.
    let contentW = frame.width, contentH = frame.height;
    if (scrollsAt) {
      const extend = (id: string) => {
        const s2 = page.objects[id];
        if (!s2) return;
        if (s2.scrollPosition !== 'fixed') {
          contentW = Math.max(contentW, s2.selrect.x + s2.selrect.width - frame.x);
          contentH = Math.max(contentH, s2.selrect.y + s2.selrect.height - frame.y);
        }
        s2.childIds.forEach(extend);
      };
      frame.childIds.forEach(extend);
    }

    // The scrolling body renders from a frame stretched to its content, so the frame's
    // own fill covers the whole scroll length and nothing is clipped at the fold.
    const bodyFrame: Shape = {
      ...frame,
      width: contentW,
      height: contentH,
      childIds: frame.childIds.filter(id => !fixedIds.includes(id)),
    };
    const bodyPage: Page = { ...page, objects: { ...page.objects, [frame.id]: bodyFrame } };
    // Responsive mode nests the hotspot inside the element it belongs to, because a
    // reflowing layout has no fixed coordinate to pin an overlay at.
    const innerFor = (s2: Shape) => (s2.interactions ?? [])
      .map(it => {
        const attrs = hotspotAttrs(it, page, frameIds, file);
        return attrs
          ? `<div class="hotspot" data-trigger="${it.trigger}" ${attrs} style="position:absolute;inset:0"></div>`
          : '';
      })
      .filter(Boolean).join('');
    // ── "Change to" (variant swap) ────────────────────────────────────────────
    // A variant's master lives elsewhere on the canvas, so for every change-to interaction
    // in this screen we render the TARGET variant's subtree a second time, translated onto
    // the host's position and hidden. Both copies are tagged into one group so the runtime
    // can flip which one is displayed without touching the rest of the screen.
    type Swap = { hostId: string; from: string; to: string; toShapeId: string };
    const swaps: Swap[] = [];
    const collectSwaps = (id: string) => {
      const s2 = page.objects[id];
      if (!s2) return;
      for (const it of s2.interactions ?? []) {
        if (it.action !== 'change-to' || !it.targetComponentId) continue;
        const comp = file.components?.[it.targetComponentId];
        const toShape = comp ? page.objects[comp.shapeId] : null;
        if (!comp || !toShape) continue;
        // An instance identifies its current variant by masterId; a bare master by its own
        // componentId. Either way the group needs a stable name for "what is showing now".
        swaps.push({
          hostId: id,
          from: s2.masterId ?? s2.componentId ?? `self:${id}`,
          to: it.targetComponentId,
          toShapeId: comp.shapeId,
        });
      }
      s2.childIds.forEach(collectSwaps);
    };
    collectSwaps(frame.id);

    // Which original shapes belong to a group, and as which variant.
    const member = new Map<string, { group: string; variant: string }>();
    for (const sw of swaps) {
      const mark = (id: string) => {
        const s2 = page.objects[id];
        if (!s2) return;
        member.set(id, { group: sw.hostId, variant: sw.from });
        s2.childIds.forEach(mark);
      };
      mark(sw.hostId);
    }

    // ── "Set variable mode" (theme swap) ──────────────────────────────────────
    // Colour bindings are re-emitted as CSS custom properties with the baked value as the
    // fallback, so switching a mode is one attribute on <body> rather than a re-render.
    const themedStyle = (s2: Shape): string => {
      if (!modeSwitching) return '';
      const out: string[] = [];
      for (const [key, prop] of Object.entries(THEMED_PROPS)) {
        const tok = s2.tokenBindings?.[key];
        if (tok) out.push(`${prop}:var(${cssVarName(tok)})`);
      }
      return out.join(';');
    };

    const decorate = (s2: Shape): ElementDecoration | undefined => {
      const m = member.get(s2.id);
      const attrs = m ? `data-vgroup="${escapeAttr(m.group)}" data-vvariant="${escapeAttr(m.variant)}"` : undefined;
      const style = themedStyle(s2) || undefined;
      return attrs || style ? { attrs, style } : undefined;
    };

    const html = responsive
      ? frameToResponsiveHtml(frame, page, file.images, innerFor)
      : frameToHtml(bodyFrame, bodyPage, file.images, decorate);

    // The alternate variants, hidden, plus their own hotspots so a reciprocal change-to
    // (Default -> Hover -> Default) works without leaving the screen.
    const altBlocks = swaps.map(sw => {
      const host = page.objects[sw.hostId];
      const alt = page.objects[sw.toShapeId];
      if (!host || !alt) return '';
      const dx = host.x - frame.x, dy = host.y - frame.y;
      const body = subtreeToHtml(sw.toShapeId, page, file.images, alt.x - dx, alt.y - dy, (s2) => ({
        attrs: `data-vgroup="${escapeAttr(sw.hostId)}" data-vvariant="${escapeAttr(sw.to)}"`,
        style: `display:none${themedStyle(s2) ? ';' + themedStyle(s2) : ''}`,
      }));
      const spots: string[] = [];
      const walkAlt = (id: string) => {
        const s2 = page.objects[id];
        if (!s2) return;
        for (const it of s2.interactions ?? []) {
          const at = hotspotAttrs(it, page, frameIds, file);
          if (!at) continue;
          const l = Math.round(s2.selrect.x - alt.x + dx);
          const t2 = Math.round(s2.selrect.y - alt.y + dy);
          spots.push(
            `<div class="hotspot" data-trigger="${it.trigger}" ${at}`
            + ` data-vgroup="${escapeAttr(sw.hostId)}" data-vvariant="${escapeAttr(sw.to)}"`
            + ` style="display:none;left:${l}px;top:${t2}px;width:${s2.selrect.width}px;height:${s2.selrect.height}px"></div>`,
          );
        }
        s2.childIds.forEach(walkAlt);
      };
      walkAlt(sw.toShapeId);
      return body + (spots.length ? '\n        ' + spots.join('\n        ') : '');
    }).filter(Boolean).join('\n        ');

    // Pinned layers render from a copy with no paint of its own — it's a transparent
    // layer over the scroller, not a second background.
    const fixedFrame: Shape = { ...frame, fills: [], strokes: [], childIds: fixedIds };
    const fixedHtml = fixedIds.length === 0 ? '' : frameToHtml(
      fixedFrame,
      { ...page, objects: { ...page.objects, [frame.id]: fixedFrame } },
      file.images,
    );

    // Collect interactive shapes in this frame's subtree → hotspots (one per interaction)
    const hotspots: string[] = [];
    const fixedHotspots: string[] = [];
    const walked = new Set<string>();
    const walk = (id: string) => {
      if (walked.has(id)) return;
      const s2 = page.objects[id];
      if (!s2) return;
      walked.add(id);
      for (const it of (s2.interactions ?? [])) {
        const attrs = hotspotAttrs(it, page, frameIds, file);
        if (!attrs) continue;
        const left = s2.selrect.x - frame.x;
        const top = s2.selrect.y - frame.y;
        // A change-to hotspot has to know which group it drives; the group is the shape
        // that carries the interaction.
        const vg = it.action === 'change-to' ? ` data-vgroup="${escapeAttr(id)}"` : '';
        const markup =
          `<div class="hotspot" data-trigger="${it.trigger}" ${attrs}${vg} ` +
          `style="left:${left}px;top:${top}px;width:${s2.selrect.width}px;height:${s2.selrect.height}px"></div>`;
        // A hotspot travels with whatever it sits on: pinned layers keep theirs in the
        // fixed layer, everything else scrolls with the content.
        if (responsive) continue;   // already nested inside the element by innerFor
        if (isFixedInFrame(page, id, frame.id)) fixedHotspots.push(markup);
        else hotspots.push(markup);
      }
      s2.childIds.forEach(walk);
    };
    // Walk the frame ITSELF, not just its children: dragging a connection from a whole
    // frame (Figma's frame→frame flow, e.g. Frame 1 → 2 → 3) stores the interaction on
    // the frame. Starting the walk at frame.childIds skipped those, so the whole chain
    // produced zero hotspots — Present showed screen 1 and every click did nothing. A
    // frame-level navigate becomes a full-screen hotspot (left/top = 0, frame-sized).
    walk(frame.id);
    // Also process loose top-level shapes that sit inside this frame (see frameToHtml):
    // their interactions must become hotspots too, or a connection dragged from a shape
    // that isn't a true child of the frame would render but never be clickable.
    for (const id of page.childIds) {
      const s2 = page.objects[id];
      if (!s2 || s2.type === 'frame' || walked.has(id)) continue;
      const scx = s2.x + s2.width / 2, scy = s2.y + s2.height / 2;
      if (scx >= frame.x && scx <= frame.x + frame.width && scy >= frame.y && scy <= frame.y + frame.height) walk(id);
    }

    // Interactions on the frame that don't need a hotspot: after-delay and key both fire
    // from the screen itself.
    const screenTriggers = (frame.interactions ?? [])
      .filter(it => it.trigger === 'after-delay' || it.trigger === 'key')
      .map(it => {
        const attrs = hotspotAttrs(it, page, frameIds, file);
        return attrs ? `<div class="screen-trigger" data-trigger="${it.trigger}" ${attrs}></div>` : '';
      })
      .filter(Boolean);

    const overflow = scrollsAt === 'both' ? 'auto'
      : scrollsAt === 'horizontal' ? 'auto hidden'
      : scrollsAt === 'vertical' ? 'hidden auto'
      : 'hidden';

    // Responsive screens fill the window and scroll like a page; fixed-size screens keep
    // the artboard's exact box so `fit()` can scale it to the viewport.
    const innerStyle = responsive ? 'width:100%;height:100%' : `width:${frame.width}px;height:${frame.height}px`;
    const scrollerStyle = responsive ? 'overflow:hidden auto' : `overflow:${overflow}`;
    const contentStyle = responsive ? 'width:100%' : `width:${contentW}px;height:${contentH}px`;
    return `<div class="screen" id="screen-${frame.id}" data-w="${frame.width}" data-h="${frame.height}"${responsive ? ' data-responsive="1"' : ''}>
      <div class="screen-inner" style="${innerStyle}">
        <div class="scroller" style="${scrollerStyle}">
          <div class="scroll-content" style="${contentStyle}">
            ${html}
            ${altBlocks}
            ${hotspots.join('\n            ')}
          </div>
        </div>
        ${fixedHtml || fixedHotspots.length ? `<div class="fixed-layer">${fixedHtml}${fixedHotspots.join('')}</div>` : ''}
        ${screenTriggers.join('')}
        <div class="comment-layer" data-screen="${frame.id}"></div>
      </div>
    </div>`;
  }).join('\n');

  const protoId = `proto-${file.id}`;
  // Escape `<` inside the embedded JSON: a document string containing "</script>" would
  // otherwise terminate the inline <script> block and inject markup into the export.
  const embed = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
  return wrapHtml(file.name, screensHtml, embed(screens), embed(startId), embed(protoId), themeVarCss(file));
}

// True when the shape is inside a subtree that's pinned against the frame's scrolling.
function isFixedInFrame(page: Page, id: string, frameId: string): boolean {
  let cur: string | null = id;
  while (cur && cur !== frameId) {
    const s: Shape | undefined = page.objects[cur];
    if (!s) return false;
    if (s.scrollPosition === 'fixed') return true;
    cur = s.parentId;
  }
  return false;
}

/**
 * The `data-*` attributes describing one interaction to the runtime, or null when the
 * interaction can't run (a deleted navigate target, an unsafe URL, a missing overlay).
 */
function hotspotAttrs(it: Interaction, page: Page, frameIds: string[], file?: DesignFile): string | null {
  const common =
    ` data-transition="${it.transition}"` +
    ` data-duration="${Math.max(0, it.duration ?? 300)}"` +
    ` data-easing="${it.easing ?? 'ease-out'}"` +
    (it.trigger === 'key' ? ` data-key="${escapeAttr(it.keyCode ?? 'Enter')}"` : '') +
    (it.trigger === 'after-delay' ? ` data-delay="${Math.max(0, it.delay ?? 1000)}"` : '');

  const overlayAttrs = (o = it.overlay) =>
    ` data-ov-pos="${o?.position ?? 'center'}"` +
    ` data-ov-x="${o?.x ?? 0}" data-ov-y="${o?.y ?? 0}"` +
    ` data-ov-bg="${o?.background ?? 'dim'}"` +
    ` data-ov-close="${o?.closeOnClickOutside === false ? '0' : '1'}"`;

  switch (it.action) {
    case 'navigate':
      // Navigate targets must still exist as top-level frames — a deleted/moved target
      // would otherwise emit a dead hotspot into the export.
      if (!it.targetFrameId || !frameIds.includes(it.targetFrameId)) return null;
      return `data-action="navigate" data-target="${it.targetFrameId}" title="→ ${escapeAttr(page.objects[it.targetFrameId]?.name ?? 'frame')}"${common}`;
    case 'overlay':
    case 'swap-overlay':
      if (!it.targetFrameId || !frameIds.includes(it.targetFrameId)) return null;
      return `data-action="${it.action}" data-target="${it.targetFrameId}" title="⧉ ${escapeAttr(page.objects[it.targetFrameId]?.name ?? 'frame')}"${common}${overlayAttrs()}`;
    case 'close-overlay':
      return `data-action="close-overlay" title="Close overlay"${common}`;
    case 'back':
      return `data-action="back" title="← Back"${common}`;
    case 'url':
      // Only http(s) — a javascript:/data: URL here would execute in the exported
      // prototype when the hotspot is clicked.
      if (!it.url || !/^https?:\/\//i.test(it.url.trim())) return null;
      return `data-action="url" data-href="${escapeAttr(it.url.trim())}" title="↗ ${escapeAttr(it.url.trim())}"${common}`;
    case 'scroll-to': {
      const target = it.scrollTargetId ? page.objects[it.scrollTargetId] : null;
      if (!target) return null;
      const frame = page.objects[target.frameId];
      const offsetY = Math.round(target.selrect.y - (frame?.y ?? 0));
      const offsetX = Math.round(target.selrect.x - (frame?.x ?? 0));
      return `data-action="scroll-to" data-scroll-x="${offsetX}" data-scroll-y="${offsetY}" title="↓ ${escapeAttr(target.name)}"${common}`;
    }
    case 'change-to': {
      // The target is a componentId, and it must resolve to a real master shape or the
      // runtime would have nothing to swap in.
      const comp = it.targetComponentId ? file?.components?.[it.targetComponentId] : null;
      if (!comp || !page.objects[comp.shapeId]) return null;
      return `data-action="change-to" data-to-variant="${escapeAttr(it.targetComponentId!)}"`
        + ` title="⇄ ${escapeAttr(comp.name)}"${common}`;
    }
    case 'set-variable-mode': {
      // 'default' is the base value set; anything else must be a real ThemeSet.
      const id = it.targetThemeId;
      if (!id) return null;
      const known = id === 'default' || !!file?.themes?.some(t => t.id === id);
      if (!known) return null;
      const name = id === 'default' ? 'Default' : (file?.themes?.find(t => t.id === id)?.name ?? id);
      return `data-action="set-variable-mode" data-mode="${escapeAttr(id)}" title="◐ ${escapeAttr(name)}"${common}`;
    }
    default:
      return null;
  }
}

// ── HTML shell with embedded nav + comment runtime ────────────────────────────

function wrapHtml(title: string, screensHtml: string, screensJson: string, startJson: string, protoIdJson: string, themeCss: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeAttr(title)}: Prototype</title>
<style>
${themeCss ? themeCss + '\n' : ''}  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#15151f; font-family:system-ui,-apple-system,sans-serif; overflow:hidden; height:100vh; }
  #stage { position:absolute; inset:0; overflow:hidden; }
  .screen { position:absolute; inset:0; display:none; }
  .screen.active { display:block; }
  .screen-inner { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
    transform-origin:center center; background:#fff; box-shadow:0 12px 48px rgba(0,0,0,.45); will-change:transform; }
  .frame-root { background:#fff; }
  .hotspot { position:absolute; cursor:pointer; background:transparent; transition:background .12s; z-index:5; border-radius:3px; }
  body.show-hotspots .hotspot { background:rgba(92,124,250,.22); outline:1px solid rgba(92,124,250,.6); animation:pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{ box-shadow:0 0 0 0 rgba(92,124,250,.5) } 50%{ box-shadow:0 0 0 6px rgba(92,124,250,0) } }

  /* Transitions run through the Web Animations API so each interaction can carry its own
     duration and easing — no per-variant CSS needed. */
  .screen.leaving { display:block; z-index:1; }
  .screen.entering { z-index:2; }

  /* scrolling + pinned layers */
  .screen-inner { overflow:hidden; }
  .scroller { position:absolute; inset:0; }
  .scroller::-webkit-scrollbar { width:8px; height:8px; }
  .scroller::-webkit-scrollbar-thumb { background:rgba(0,0,0,.22); border-radius:4px; }
  .scroll-content { position:relative; }
  /* Pinned layers sit above the scrolling body but must not swallow clicks meant for it,
     and their frame shell must not repaint the background over the content below. */
  .fixed-layer { position:absolute; inset:0; z-index:6; pointer-events:none; }
  .fixed-layer .frame-root { background:transparent; }
  .fixed-layer > *, .fixed-layer .hotspot { pointer-events:auto; }
  .screen-trigger { display:none; }

  /* overlays — appended INSIDE the active screen so they inherit its fit scale */
  .ov-backdrop { position:absolute; inset:0; background:rgba(0,0,0,.45); z-index:30; opacity:0; }
  .ov-item { position:absolute; z-index:31; background:#fff; overflow:hidden;
    box-shadow:0 18px 60px rgba(0,0,0,.45); }
  .ov-item .comment-layer, .ov-item .fixed-layer { display:none; }

  /* toolbar */
  #toolbar { position:fixed; bottom:18px; left:50%; transform:translateX(-50%); z-index:100;
    display:flex; gap:4px; background:rgba(24,24,37,.92); backdrop-filter:blur(10px);
    border:1px solid rgba(255,255,255,.1); border-radius:12px; padding:6px; box-shadow:0 8px 32px rgba(0,0,0,.4); }
  .tb { background:transparent; border:none; color:#bac2de; font-size:13px; padding:7px 11px;
    border-radius:8px; cursor:pointer; font-family:inherit; display:flex; align-items:center; gap:5px; }
  .tb:hover { background:rgba(255,255,255,.08); color:#fff; }
  .tb:disabled { opacity:.35; cursor:default; }
  .tb.on { background:rgba(92,124,250,.3); color:#fff; }
  .tb-sep { width:1px; background:rgba(255,255,255,.1); margin:4px 2px; }
  #screenName { color:#9399b2; font-size:12px; padding:7px 10px; align-self:center; max-width:160px;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  /* comments */
  body.comment-mode .screen-inner { cursor:crosshair; }
  /* The comment layer OVERLAYS the whole screen (above hotspots, z 15 > 5). It ignores the
     mouse in normal mode (pointer-events:none) so hotspots stay clickable, and becomes the
     click target in comment mode — full-screen hotspots can no longer swallow the click.
     Pins/popups opt back in so they're clickable in either mode. */
  .comment-layer { position:absolute; inset:0; z-index:15; pointer-events:none; }
  body.comment-mode .comment-layer { pointer-events:auto; cursor:crosshair; }
  .comment-pin { position:absolute; width:26px; height:26px; border-radius:50% 50% 50% 2px;
    background:#f5c542; border:2px solid #fff; box-shadow:0 2px 8px rgba(0,0,0,.35); z-index:20;
    transform:translate(-4px,-26px); cursor:pointer; display:flex; align-items:center; justify-content:center;
    font-size:11px; font-weight:700; color:#1a1a2e; pointer-events:auto; }
  /* While probing for the layer under the cursor, nothing may intercept the hit test. */
  body.probing .hotspot { pointer-events:none; }
  .comment-pop { position:absolute; z-index:30; width:288px; background:#1e1e2e; border:1px solid rgba(255,255,255,.15);
    border-radius:12px; padding:12px; box-shadow:0 10px 34px rgba(0,0,0,.55); transform:translate(8px,-8px); pointer-events:auto; }
  .comment-pop .head { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
  .comment-pop .avatar { width:24px; height:24px; border-radius:50%; background:#5c7cfa; color:#fff; font-size:11px;
    font-weight:700; display:flex; align-items:center; justify-content:center; flex:0 0 auto; text-transform:uppercase; }
  .comment-pop .who { font-size:13px; font-weight:600; color:#cdd6f4; flex:1; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; }
  .comment-pop .close { background:none; border:none; color:#9399b2; cursor:pointer; font-size:15px;
    line-height:1; padding:2px 4px; flex:0 0 auto; }
  /* The layer the pin sits on, quoted the way a text selection would be. */
  .comment-pop .quote { border-left:2px solid #5c7cfa; padding:1px 0 1px 8px; margin:0 0 8px; font-size:12px;
    color:#9399b2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .comment-pop .when { font-size:11px; color:#6c7086; margin:0 0 8px; }
  .comment-pop textarea { width:100%; height:70px; background:rgba(255,255,255,.07); border:1px solid rgba(92,124,250,.55);
    border-radius:8px; color:#cdd6f4; font-family:inherit; font-size:13px; padding:8px; resize:none; outline:none; box-sizing:border-box; }
  .comment-pop .row { display:flex; gap:6px; margin-top:8px; }
  .comment-pop button { flex:1; border:none; border-radius:6px; padding:7px; font-size:12px; cursor:pointer; font-family:inherit; }
  .cbtn-save { background:#5c7cfa; color:#fff; }
  .cbtn-del { background:rgba(243,139,168,.2); color:#f38ba8; }
  #toast { position:fixed; top:18px; left:50%; transform:translateX(-50%); background:#1e1e2e; color:#cdd6f4;
    padding:8px 16px; border-radius:8px; font-size:13px; z-index:200; opacity:0; transition:opacity .2s;
    border:1px solid rgba(255,255,255,.12); }
  #toast.show { opacity:1; }
</style>
</head>
<body>
  <div id="stage">
    ${screensHtml}
  </div>

  <div id="toolbar">
    <button class="tb" id="backBtn" title="Back (←)">‹</button>
    <button class="tb" id="fwdBtn" title="Forward (→)">›</button>
    <button class="tb" id="homeBtn" title="Home (H)">⌂</button>
    <span id="screenName"></span>
    <div class="tb-sep"></div>
    <button class="tb" id="hotspotBtn" title="Flash hotspots (F)">✦ Hotspots</button>
    <button class="tb" id="commentBtn" title="Comment mode (C)">💬 <span id="cCount"></span></button>
    <div class="tb-sep"></div>
    <button class="tb" id="exportBtn" title="Download this browser's comments as JSON, to send back to the designer">⤓ Comments</button>
    <button class="tb" id="importBtn" title="Merge a reviewer's comments JSON into this browser">⤒ Merge</button>
    <input type="file" id="importFile" accept="application/json" style="display:none" />
  </div>
  <div id="toast"></div>

<script>
(function(){
  var SCREENS = ${screensJson};
  var START = ${startJson};
  var PROTO_ID = ${protoIdJson};
  var STORE_KEY = 'edit-proto-comments::' + PROTO_ID;
  var AUTHOR_KEY = 'edit-proto-author';
  // Author names, layer names and imported files are all untrusted text that gets written
  // into innerHTML below — escape at the boundary rather than trusting the source.
  function esc(v){
    return String(v == null ? '' : v).replace(/[&<>"']/g, function(ch){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch];
    });
  }
  // Comments travel between browsers as JSON, so an unsigned note is nearly useless to
  // whoever receives it. Ask once, remember, and stamp every comment.
  function author(){
    var a = '';
    try { a = localStorage.getItem(AUTHOR_KEY) || ''; } catch(e){}
    if(!a){
      var asked = typeof window.prompt === 'function'
        ? window.prompt('Your name (shown on your comments)') : null;
      a = String(asked || '').trim() || 'Anonymous';
      try { localStorage.setItem(AUTHOR_KEY, a); } catch(e){}
    }
    return a;
  }
  // A name typed once shouldn't be permanent — clicking it in the card lets you fix it.
  function renameAuthor(){
    if(typeof window.prompt !== 'function') return null;
    var next = window.prompt('Your name (shown on your comments)', author());
    if(next === null) return null;
    var v = String(next).trim() || 'Anonymous';
    try { localStorage.setItem(AUTHOR_KEY, v); } catch(e){}
    return v;
  }

  var backStack = [], fwdStack = [];
  var current = null;
  var commentMode = false;
  var openPop = null;
  var curScale = 1;

  function comments(){ try { return JSON.parse(localStorage.getItem(STORE_KEY)||'{}'); } catch(e){ return {}; } }
  function saveComments(c){ localStorage.setItem(STORE_KEY, JSON.stringify(c)); updateCount(); }
  function updateCount(){
    var c = comments(), n = 0;
    Object.keys(c).forEach(function(k){ n += (c[k]||[]).length; });
    document.getElementById('cCount').textContent = n ? '('+n+')' : '';
  }

  // Scale the active screen to fit the viewport (handles mobile + desktop sizes).
  function fit(){
    var sc = document.getElementById('screen-'+current);
    if(!sc) return;
    var inner = sc.querySelector('.screen-inner');
    var W = +sc.getAttribute('data-w'), H = +sc.getAttribute('data-h');
    var stage = document.getElementById('stage');
    // A responsive screen reflows to the window, so scaling it would defeat the point —
    // it stays 1:1 and the browser does the layout.
    if(sc.getAttribute('data-responsive')){
      curScale = 1;
      inner.style.transform = 'translate(-50%,-50%)';
      return;
    }
    var availW = stage.clientWidth - 48, availH = stage.clientHeight - 96;
    curScale = Math.min(1, availW/W, availH/H);
    inner.style.transform = 'translate(-50%,-50%) scale('+curScale+')';
  }
  window.addEventListener('resize', fit);

  // ── Transition engine ─────────────────────────────────────
  // Every transition is one Web Animations call, so an interaction's own duration and
  // easing apply without generating a CSS variant per combination.
  var EASING = {
    'linear':'linear', 'ease-in':'cubic-bezier(.42,0,1,1)', 'ease-out':'cubic-bezier(0,0,.58,1)',
    'ease-in-out':'cubic-bezier(.42,0,.58,1)', 'ease-out-back':'cubic-bezier(.34,1.56,.64,1)'
  };
  // Motion vector for a named direction: where the INCOMING screen starts, which is also
  // the direction the transition appears to travel.
  function vec(dir, W, H){
    if(dir==='left')  return [W, 0];
    if(dir==='right') return [-W, 0];
    if(dir==='up')    return [0, H];
    return [0, -H];   // down
  }
  // How far the OUTGOING screen drifts on a slide-* transition, as a fraction of the
  // travel a push-* would give it. Push = 1 (locked together), move-in = 0 (static).
  var SLIDE_DRIFT = 0.25;

  function anim(el, frames, dur, ease){
    if(!el || !el.animate || dur <= 0) return null;
    return el.animate(frames, { duration: dur, easing: EASING[ease] || EASING['ease-out'], fill: 'both' });
  }

  // Smart animate: match layers by name across the two screens and tween each matched
  // pair from where it was to where it lands — the same rule Figma uses.
  function smartAnimate(prev, next, dur, ease){
    var before = {};
    prev.querySelectorAll('[data-layer]').forEach(function(el){
      var k = el.getAttribute('data-layer');
      if(!(k in before)) before[k] = el.getBoundingClientRect();
    });
    next.classList.add('active');
    var moved = [];
    next.querySelectorAll('[data-layer]').forEach(function(el){
      var k = el.getAttribute('data-layer');
      var from = before[k];
      if(!from) return;
      var to = el.getBoundingClientRect();
      var dx = from.left - to.left, dy = from.top - to.top;
      var sx = to.width  ? from.width  / to.width  : 1;
      var sy = to.height ? from.height / to.height : 1;
      if(Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx-1) < 0.005 && Math.abs(sy-1) < 0.005) return;
      moved.push([el, dx, dy, sx, sy]);
    });
    // Nothing matched → smart animate has nothing to say; fall back to a cross-fade.
    if(moved.length === 0){ anim(next, [{opacity:0},{opacity:1}], dur, ease); return; }
    anim(next, [{opacity:0},{opacity:1}], Math.min(dur, 160), ease);
    moved.forEach(function(m){
      var el = m[0];
      var base = el.style.transformOrigin;
      el.style.transformOrigin = 'top left';
      var a = anim(el, [
        { transform: 'translate('+m[1]+'px,'+m[2]+'px) scale('+m[3]+','+m[4]+')' },
        { transform: 'translate(0,0) scale(1,1)' },
      ], dur, ease);
      if(a) a.onfinish = function(){ el.style.transform=''; el.style.transformOrigin = base; };
    });
  }

  function runTransition(prev, next, transition, dur, ease){
    var W = next.clientWidth, H = next.clientHeight;
    if(!transition || transition === 'none' || !prev || dur <= 0){ next.classList.add('active'); return; }

    if(transition === 'smart'){ smartAnimate(prev, next, dur, ease); return; }
    if(transition === 'dissolve'){
      next.classList.add('active');
      anim(next, [{opacity:0},{opacity:1}], dur, ease);
      return;
    }

    var kind = transition.replace(/-(left|right|up|down)$/, '');
    var dir  = (transition.match(/-(left|right|up|down)$/) || [,'left'])[1];
    var v = vec(dir, W, H);
    var inFrom = 'translate('+v[0]+'px,'+v[1]+'px)';
    var outTo  = 'translate('+(-v[0])+'px,'+(-v[1])+'px)';

    next.classList.add('active');
    // move-out keeps the incoming screen still and slides the old one away over it.
    if(kind !== 'move-out') anim(next, [{transform:inFrom},{transform:'translate(0,0)'}], dur, ease);
    // push carries the old screen along with the new one; move-out slides it off over the
    // top; move-in leaves it where it is, simply covered.
    // SLIDE is the in-between, and the distinction Figma draws: the outgoing screen drifts
    // in the same direction rather than sitting still. Without this, slide-left/right/up/down
    // produced byte-identical animations to move-in-*, so four of the eighteen transition
    // options in the dropdown were silent duplicates.
    if(kind === 'slide'){
      var sv = 'translate('+(-v[0] * SLIDE_DRIFT)+'px,'+(-v[1] * SLIDE_DRIFT)+'px)';
      var sa = anim(prev, [{transform:'translate(0,0)'},{transform: sv}], dur, ease);
      if(sa) sa.onfinish = function(){ prev.style.transform = ''; };
    }
    if(kind === 'push' || kind === 'move-out'){
      var a = anim(prev, [{transform:'translate(0,0)'},{transform: outTo}], dur, ease);
      if(a) a.onfinish = function(){ prev.style.transform = ''; };
    }
  }

  function show(id, transition, dur, ease){
    var el = document.getElementById('screen-'+id);
    if(!el) return;
    var prev = current && current !== id ? document.getElementById('screen-'+current) : null;
    closeAllOverlays(true);
    clearDelays();
    // Exactly one screen is ever 'active'. The outgoing one is marked 'leaving', which
    // keeps it painted (and animatable) for the length of the transition without making
    // it a second current screen.
    document.querySelectorAll('.screen').forEach(function(sc){
      sc.classList.remove('active');
      sc.classList.remove('entering');
      if(sc !== prev) sc.classList.remove('leaving');
    });
    var ms = dur == null ? 300 : dur;
    if(prev && prev !== el && transition && transition !== 'none' && ms > 0){
      prev.classList.add('leaving');
      window.setTimeout(function(){ prev.classList.remove('leaving'); prev.style.transform = ''; }, ms + 20);
    }
    el.classList.add('entering');
    current = id;
    fit();
    runTransition(prev, el, transition, ms, ease);
    var sc2 = SCREENS.find(function(s){ return s.id===id; });
    document.getElementById('screenName').textContent = sc2 ? sc2.name : '';
    document.getElementById('backBtn').disabled = backStack.length === 0;
    document.getElementById('fwdBtn').disabled = fwdStack.length === 0;
    renderPins();
    armDelays();
  }

  function navigate(id, transition, dur, ease){ if(id===current) return; if(current) backStack.push(current); fwdStack = []; show(id, transition, dur, ease); }
  // The editor exposes Animation / Easing / Duration on a Back interaction and they were
  // serialized into the hotspot — then thrown away here, so those three controls did
  // nothing at all for Back. Defaults still apply when Back comes from the toolbar or a
  // hover/press revert, which carry no authored values.
  // Callers are mixed: act() passes authored values, revert() and the toolbar button pass
  // none — and the button is wired as an event handler, so argument 1 can be a MouseEvent.
  // Coerce by TYPE rather than truthiness so a stray object can't reach show().
  function goBack(transition, dur, ease){
    if(!backStack.length) return;
    fwdStack.push(current);
    var t = typeof transition === 'string' ? transition : 'dissolve';
    var d = typeof dur === 'number' && isFinite(dur) ? dur : 220;
    var ez = typeof ease === 'string' ? ease : 'ease-out';
    show(backStack.pop(), t, d, ez);
  }
  function goForward(){ if(!fwdStack.length) return; backStack.push(current); show(fwdStack.pop(), 'dissolve', 220, 'ease-out'); }

  // ── Overlays ──────────────────────────────────────────────
  // An overlay is a clone of the target screen's body, appended INSIDE the active screen
  // so it inherits the fit-to-viewport scale and sits in frame coordinates.
  var overlays = [];

  function activeInner(){
    var sc = document.getElementById('screen-'+current);
    return sc ? sc.querySelector('.screen-inner') : null;
  }

  function positionOverlay(el, pos, x, y){
    var st = el.style;
    st.left = st.top = st.right = st.bottom = 'auto';
    st.transform = '';
    if(pos === 'manual'){ st.left = x+'px'; st.top = y+'px'; return; }
    if(pos === 'center'){ st.left='50%'; st.top='50%'; st.transform='translate(-50%,-50%)'; return; }
    var parts = pos.split('-');           // e.g. bottom-center
    if(parts[0] === 'top') st.top = '0px'; else st.bottom = '0px';
    if(parts[1] === 'left') st.left = '0px';
    else if(parts[1] === 'right') st.right = '0px';
    else { st.left = '50%'; st.transform = 'translateX(-50%)'; }
  }

  function openOverlay(h, swap){
    var host = activeInner();
    var src = document.getElementById('screen-'+h.getAttribute('data-target'));
    if(!host || !src) return;
    if(swap) closeOverlay(0);

    var dur = +h.getAttribute('data-duration') || 0;
    var ease = h.getAttribute('data-easing');
    var pos = h.getAttribute('data-ov-pos') || 'center';
    var dim = h.getAttribute('data-ov-bg') !== 'none';
    var closeOutside = h.getAttribute('data-ov-close') !== '0';

    var backdrop = null;
    if(dim){
      backdrop = document.createElement('div');
      backdrop.className = 'ov-backdrop';
      host.appendChild(backdrop);
      anim(backdrop, [{opacity:0},{opacity:1}], Math.min(dur||200, 200), 'ease-out') || (backdrop.style.opacity = 1);
      if(!backdrop.getAnimations || !backdrop.getAnimations().length) backdrop.style.opacity = 1;
    }

    var item = document.createElement('div');
    item.className = 'ov-item';
    item.style.width = src.getAttribute('data-w')+'px';
    item.style.height = src.getAttribute('data-h')+'px';
    var body = src.querySelector('.scroll-content');
    item.innerHTML = body ? body.innerHTML : '';
    positionOverlay(item, pos, +h.getAttribute('data-ov-x') || 0, +h.getAttribute('data-ov-y') || 0);
    host.appendChild(item);

    var t = h.getAttribute('data-transition');
    if(t === 'dissolve' || t === 'none' || !t) anim(item, [{opacity:0},{opacity:1}], dur, ease);
    else {
      var W = item.offsetWidth, H = item.offsetHeight;
      var v = vec((t.match(/-(left|right|up|down)$/) || [,'up'])[1], W, H);
      var keep = item.style.transform;                       // preserve the centring transform
      anim(item, [
        { transform: keep + ' translate('+v[0]+'px,'+v[1]+'px)', opacity: 0 },
        { transform: keep + ' translate(0,0)', opacity: 1 },
      ], dur, ease);
    }

    if(backdrop && closeOutside) backdrop.addEventListener('click', function(){ closeOverlay(); });
    overlays.push({ item: item, backdrop: backdrop });
  }

  function closeOverlay(dur, ease){
    var top = overlays.pop();
    if(!top) return;
    var d = typeof dur === 'number' && isFinite(dur) ? dur : 160;
    var ez = typeof ease === 'string' ? ease : 'ease-out';
    var kill = function(){ top.item.remove(); if(top.backdrop) top.backdrop.remove(); };
    if(d > 0){
      var a = anim(top.item, [{opacity:1},{opacity:0}], d, ez);
      if(top.backdrop) anim(top.backdrop, [{opacity:1},{opacity:0}], d, ez);
      if(a) a.onfinish = kill; else kill();
    } else kill();
  }

  function closeAllOverlays(immediate){ while(overlays.length) closeOverlay(immediate ? 0 : undefined); }

  // ── After-delay triggers ──────────────────────────────────
  var delayTimers = [];
  function clearDelays(){ delayTimers.forEach(clearTimeout); delayTimers = []; }
  function armDelays(){
    var sc = document.getElementById('screen-'+current);
    if(!sc) return;
    sc.querySelectorAll('[data-trigger="after-delay"]').forEach(function(h){
      var ms = +h.getAttribute('data-delay') || 0;
      delayTimers.push(window.setTimeout(function(){ if(current === sc.id.slice(7)) act(h); }, ms));
    });
  }

  // ── "Change to": swap which variant of a group is visible, in place ────────
  // Both copies of the subtree are already in the DOM, tagged with the same data-vgroup;
  // showing one and hiding the other is the whole swap. The previous variant is remembered
  // so a "While hovering" change-to can revert when the pointer leaves.
  var variantPrev = {};
  function variantMembers(group){
    return document.querySelectorAll('#screen-'+current+' [data-vgroup="'+group+'"]');
  }
  function showingVariant(members){
    for(var i=0;i<members.length;i++){
      if(members[i].style.display !== 'none') return members[i].getAttribute('data-vvariant');
    }
    return null;
  }
  function changeVariant(group, to){
    if(!group || !to) return;
    var members = variantMembers(group);
    if(!members.length) return;
    var from = showingVariant(members);
    if(from !== null && from !== to) variantPrev[group] = from;
    for(var i=0;i<members.length;i++){
      var el = members[i];
      el.style.display = el.getAttribute('data-vvariant') === to ? '' : 'none';
    }
  }
  function restoreVariant(group){
    var back = group ? variantPrev[group] : null;
    if(back) { delete variantPrev[group]; changeVariant(group, back); }
  }

  // ── "Set variable mode": one attribute flips every themed custom property ──
  function setMode(id){
    if(!id) return;
    if(id === 'default') document.body.removeAttribute('data-proto-mode');
    else document.body.setAttribute('data-proto-mode', id);
  }

  // ── Actions ───────────────────────────────────────────────
  function act(h){
    var a = h.getAttribute('data-action');
    var dur = +h.getAttribute('data-duration');
    var ease = h.getAttribute('data-easing');
    var t = h.getAttribute('data-transition');
    if(!isFinite(dur)) dur = null;          // absent attribute -> fall back to defaults
    if(a === 'navigate') navigate(h.getAttribute('data-target'), t, dur, ease);
    else if(a === 'back') goBack(t, dur, ease);
    else if(a === 'overlay') openOverlay(h, false);
    else if(a === 'swap-overlay') openOverlay(h, true);
    else if(a === 'close-overlay') closeOverlay(dur, ease);
    else if(a === 'scroll-to'){
      var sc = document.querySelector('#screen-'+current+' .scroller');
      if(sc) sc.scrollTo({ left:+h.getAttribute('data-scroll-x')||0, top:+h.getAttribute('data-scroll-y')||0, behavior:'smooth' });
    }
    else if(a === 'url'){ var u = h.getAttribute('data-href'); if(u && /^https?:\\/\\//i.test(u)) window.open(u, '_blank', 'noopener'); }
    else if(a === 'change-to') changeVariant(h.getAttribute('data-vgroup'), h.getAttribute('data-to-variant'));
    else if(a === 'set-variable-mode') setMode(h.getAttribute('data-mode'));
  }

  // "While hovering" and "While pressing" revert when the pointer leaves or lifts.
  function revert(h){
    var a = h.getAttribute('data-action');
    if(a === 'overlay' || a === 'swap-overlay') closeOverlay();
    else if(a === 'navigate') goBack();
    else if(a === 'change-to') restoreVariant(h.getAttribute('data-vgroup'));
  }

  // Delegated so cloned overlay content keeps working — a clone carries the data
  // attributes but none of the listeners a per-element binding would have attached.
  // Bound to #stage rather than document so the listeners live and die with the markup
  // they serve; a second runtime in the same document can't stack duplicate handlers.
  var stageEl = document.getElementById('stage');
  function hotspotFor(e){
    var el = e.target.closest ? e.target.closest('.hotspot') : null;
    return el;
  }
  function handles(h, trigger){ return h && (h.getAttribute('data-trigger') || 'click') === trigger; }

  stageEl.addEventListener('click', function(e){
    if(commentMode) return;
    var h = hotspotFor(e);
    if(!handles(h, 'click')) return;
    e.stopPropagation();
    act(h);
  }, true);

  // mouseover/mouseout bubble from every descendant, so sliding the pointer from a
  // button's padding onto its own label used to re-fire the interaction. Only act when the
  // pointer actually crossed the hotspot's boundary: the semantics of mouseenter/mouseleave,
  // which can't be used directly here because this is one delegated listener on the stage.
  function crossedBoundary(h, e){
    var other = e.relatedTarget;
    return !other || !(h === other || h.contains(other));
  }
  stageEl.addEventListener('mouseover', function(e){
    if(commentMode) return;
    var h = hotspotFor(e);
    if(!h || !crossedBoundary(h, e)) return;
    var trig = h.getAttribute('data-trigger');
    if(trig === 'hover' || trig === 'mouse-enter') act(h);
  });
  stageEl.addEventListener('mouseout', function(e){
    if(commentMode) return;
    var h = hotspotFor(e);
    if(!h || !crossedBoundary(h, e)) return;
    var trig = h.getAttribute('data-trigger');
    if(trig === 'mouse-leave') act(h);
    else if(trig === 'hover') revert(h);
  });
  stageEl.addEventListener('mousedown', function(e){
    if(commentMode) return;
    var h = hotspotFor(e);
    if(!h) return;
    var trig = h.getAttribute('data-trigger');
    if(trig === 'mouse-down' || trig === 'press') act(h);
    if(trig === 'drag') startDrag(h, e);
  });
  stageEl.addEventListener('mouseup', function(e){
    if(commentMode) return;
    var h = hotspotFor(e);
    if(!h) return;
    var trig = h.getAttribute('data-trigger');
    if(trig === 'mouse-up') act(h);
    else if(trig === 'press') revert(h);
  });

  // Drag: fires once the pointer has travelled far enough to read as a drag, not a click.
  var dragState = null;
  function startDrag(h, e){ dragState = { h: h, x: e.clientX, y: e.clientY }; }
  // A drag can travel outside the stage, so its move/up live on the document — swapped
  // rather than stacked, the same way the key handler is.
  if(window.__protoDragMove){
    document.removeEventListener('mousemove', window.__protoDragMove);
    document.removeEventListener('mouseup', window.__protoDragEnd);
  }
  window.__protoDragMove = function(e){
    if(!dragState) return;
    if(Math.hypot(e.clientX - dragState.x, e.clientY - dragState.y) < 12) return;
    var h = dragState.h; dragState = null;
    act(h);
  };
  window.__protoDragEnd = function(){ dragState = null; };
  document.addEventListener('mousemove', window.__protoDragMove);
  document.addEventListener('mouseup', window.__protoDragEnd);

  document.getElementById('backBtn').onclick = function(){ goBack(); };
  document.getElementById('fwdBtn').onclick = function(){ goForward(); };
  document.getElementById('homeBtn').onclick = function(){ backStack=[]; fwdStack=[]; show(START,'dissolve',220,'ease-out'); };
  document.getElementById('hotspotBtn').onclick = function(){ document.body.classList.toggle('show-hotspots'); this.classList.toggle('on'); };

  // Keys aren't aimed at an element, so this one has to live on the document. Replace any
  // handler a previous run left behind rather than stacking a second.
  if(window.__protoKeydown) document.removeEventListener('keydown', window.__protoKeydown);
  window.__protoKeydown = function(e){
    if(/input|textarea/i.test((e.target.tagName||''))) { if(e.key==='Escape') closePop(); return; }

    // Key triggers on the active screen run first — a prototype that binds a key owns it.
    var sc = document.getElementById('screen-'+current);
    var claimed = false;
    if(sc && !commentMode){
      sc.querySelectorAll('[data-trigger="key"]').forEach(function(h){
        if(h.getAttribute('data-key') === e.key){ act(h); claimed = true; }
      });
    }
    if(claimed){ e.preventDefault(); return; }

    if(e.key==='Escape' && overlays.length){ closeOverlay(); return; }
    if(e.key==='ArrowLeft') goBack();
    else if(e.key==='ArrowRight') goForward();
    else if(e.key==='h'||e.key==='H') { backStack=[]; fwdStack=[]; show(START,'dissolve',220,'ease-out'); }
    else if(e.key==='f'||e.key==='F') document.getElementById('hotspotBtn').click();
    else if(e.key==='c'||e.key==='C') toggleComment();
    else if(e.key==='Escape') closePop();
  };
  document.addEventListener('keydown', window.__protoKeydown);

  // ── Comments ──────────────────────────────────────────────
  document.getElementById('commentBtn').onclick = function(){ toggleComment(); };
  function toggleComment(){
    commentMode = !commentMode;
    document.body.classList.toggle('comment-mode', commentMode);
    document.getElementById('commentBtn').classList.toggle('on', commentMode);
    closePop();
  }

  // Click the layer itself: it overlays the full screen (inset:0), so its rect matches the
  // scaled screen exactly — dividing by curScale recovers frame-local pin coordinates.
  // (The old handler listened on the parent and measured against an UNSTYLED zero-size
  // layer div sitting below the content, so every pin landed at the wrong spot.)
  document.querySelectorAll('.comment-layer').forEach(function(layer){
    layer.addEventListener('click', function(e){
      if(!commentMode) return;
      if(e.target.classList.contains('comment-pin')) return;
      if(e.target.closest('.comment-pop')) return; // typing in the editor, not placing
      e.stopPropagation();
      var rect = layer.getBoundingClientRect();
      var x = (e.clientX - rect.left) / curScale;
      var y = (e.clientY - rect.top) / curScale;
      openEditor(layer.getAttribute('data-screen'), x, y, null, layerAt(e.clientX, e.clientY, layer));
    });
  });

  /**
   * The name of the design layer under the cursor. A pin at a bare x/y tells the designer
   * where you clicked but not what you clicked; every exported element carries
   * data-layer, so the layer name is the prototype's equivalent of a quoted selection.
   * The comment layer and the hotspots both sit above the content, so both are made
   * transparent to hit-testing for the duration of the probe.
   */
  function layerAt(cx, cy, layer){
    // Quoted context is a bonus, never a requirement: if hit-testing isn't available the
    // comment still gets placed, just without a layer name attached.
    if(typeof document.elementFromPoint !== 'function') return '';
    var prev = layer.style.pointerEvents;
    layer.style.pointerEvents = 'none';
    document.body.classList.add('probing');
    var el = null;
    try { el = document.elementFromPoint(cx, cy); } catch(err){ el = null; }
    document.body.classList.remove('probing');
    layer.style.pointerEvents = prev;
    var host = el && el.closest ? el.closest('[data-layer]') : null;
    return host ? (host.getAttribute('data-layer') || '') : '';
  }

  function renderPins(){
    document.querySelectorAll('.comment-layer').forEach(function(layer){
      layer.innerHTML = '';
      var screenId = layer.getAttribute('data-screen');
      (comments()[screenId]||[]).forEach(function(cm, i){
        var pin = document.createElement('div');
        pin.className = 'comment-pin';
        pin.style.left = cm.x+'px'; pin.style.top = cm.y+'px';
        pin.textContent = (i+1);
        pin.addEventListener('click', function(ev){ ev.stopPropagation(); openEditor(screenId, cm.x, cm.y, cm.id, cm.layer||''); });
        layer.appendChild(pin);
      });
    });
  }

  function closePop(){ if(openPop){ openPop.remove(); openPop=null; } }

  function openEditor(screenId, x, y, existingId, layerName){
    closePop();
    var layer = document.querySelector('.comment-layer[data-screen="'+screenId+'"]');
    var list = comments()[screenId] || [];
    var existing = existingId ? list.find(function(cm){ return cm.id===existingId; }) : null;

    var pop = document.createElement('div');
    pop.className = 'comment-pop';
    pop.style.left = x+'px'; pop.style.top = y+'px';
    var who = existing ? (existing.author || 'Anonymous') : author();
    var ctx = existing ? (existing.layer || '') : (layerName || '');
    pop.innerHTML =
      '<div class="head">'+
        '<div class="avatar">'+esc(who.slice(0,1))+'</div>'+
        '<div class="who">'+esc(who)+'</div>'+
        '<button class="close" title="Close">✕</button>'+
      '</div>'+
      (ctx ? '<div class="quote" title="'+esc(ctx)+'">'+esc(ctx)+'</div>' : '')+
      (existing ? '<div class="when">'+esc(new Date(existing.t).toLocaleString())+'</div>' : '')+
      '<textarea placeholder="Add a comment…"></textarea>'+
      '<div class="row"><button class="cbtn-save">'+(existing?'Save':'Add comment')+'</button>'+
      (existing?'<button class="cbtn-del">Delete</button>':'')+'</div>';
    layer.appendChild(pop);
    openPop = pop;
    var ta = pop.querySelector('textarea');
    ta.value = existing ? existing.text : '';
    ta.focus();
    pop.addEventListener('click', function(e){ e.stopPropagation(); });
    pop.querySelector('.close').onclick = function(){ closePop(); };
    if(!existing){
      var whoEl = pop.querySelector('.who');
      whoEl.style.cursor = 'pointer';
      whoEl.title = 'Click to change your name';
      whoEl.onclick = function(){
        var v = renameAuthor();
        if(v){ who = v; whoEl.textContent = v; pop.querySelector('.avatar').textContent = v.slice(0,1); }
      };
    }
    // ⌘/Ctrl+Enter commits without reaching for the mouse; Escape abandons.
    ta.addEventListener('keydown', function(ev){
      if(ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); pop.querySelector('.cbtn-save').click(); }
      if(ev.key === 'Escape') { ev.preventDefault(); closePop(); }
    });

    pop.querySelector('.cbtn-save').onclick = function(){
      var c2 = comments(), l2 = c2[screenId]||[];
      if(!ta.value.trim()){ toast('Nothing to save'); return; }
      if(existing){ existing.text = ta.value; existing.t = Date.now(); c2[screenId]=l2; }
      else { l2.push({ id:'c'+Date.now()+Math.random().toString(36).slice(2,5), x:x, y:y,
        text:ta.value, t:Date.now(), author:who, layer:ctx }); c2[screenId]=l2; }
      saveComments(c2); closePop(); renderPins(); toast('Comment saved');
    };
    var del = pop.querySelector('.cbtn-del');
    if(del){ del.onclick = function(){
      var c2 = comments(); c2[screenId] = (c2[screenId]||[]).filter(function(cm){ return cm.id!==existingId; });
      saveComments(c2); closePop(); renderPins(); toast('Comment deleted');
    };}
  }

  document.getElementById('stage').addEventListener('click', closePop);

  document.getElementById('exportBtn').onclick = function(){
    var data = { proto: PROTO_ID, exported: new Date().toISOString(), comments: comments() };
    var blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'comments.json'; a.click(); URL.revokeObjectURL(a.href);
    toast('Comments exported');
  };
  document.getElementById('importBtn').onclick = function(){ document.getElementById('importFile').click(); };
  document.getElementById('importFile').onchange = function(e){
    var f = e.target.files[0]; if(!f) return;
    var r = new FileReader();
    r.onload = function(){
      try {
        var d = JSON.parse(r.result);
        if(!d.comments) { toast('No comments in that file'); return; }
        // MERGE, don't replace. Overwriting meant importing a reviewer's file silently
        // destroyed your own notes — the opposite of what collecting feedback is for.
        // Ids are unique per comment, so they decide identity; a re-import of the same
        // file updates in place instead of duplicating.
        var mine = comments(), added = 0, updated = 0;
        Object.keys(d.comments).forEach(function(screenId){
          var incoming = d.comments[screenId] || [];
          var list = mine[screenId] || [];
          incoming.forEach(function(cm){
            if(!cm || !cm.id) return;
            var at = -1;
            for(var i=0;i<list.length;i++){ if(list[i].id === cm.id){ at = i; break; } }
            if(at >= 0){ list[at] = cm; updated++; } else { list.push(cm); added++; }
          });
          mine[screenId] = list;
        });
        saveComments(mine); renderPins();
        toast('Merged ' + added + ' new, ' + updated + ' updated');
      } catch(err){ toast('Invalid file'); }
    };
    r.readAsText(f); e.target.value='';
  };

  var toastTimer;
  function toast(msg){ var t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer=setTimeout(function(){ t.classList.remove('show'); }, 1600); }

  // init
  updateCount();
  if(START) show(START);
})();
</script>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
