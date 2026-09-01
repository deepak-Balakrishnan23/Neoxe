import { DesignFile, Page, Shape, Interaction } from './types';
import { frameToHtml } from './codegen';

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

export function generatePrototypeHtml(file: DesignFile, page: Page): string {
  // Top-level frames are screens
  const frameIds = page.childIds.filter(id => page.objects[id]?.type === 'frame');
  const frames = frameIds.map(id => page.objects[id]).filter(Boolean) as Shape[];

  // Fallback: nothing to show
  if (frames.length === 0) {
    return wrapHtml(file.name, '', '[]', 'null', '{}');
  }

  const startId = file.prototypeStartFrameId && frameIds.includes(file.prototypeStartFrameId)
    ? file.prototypeStartFrameId
    : frameIds[0];

  const screens: ScreenData[] = frames.map(f => ({ id: f.id, name: f.name, width: f.width, height: f.height }));

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
    const html = frameToHtml(bodyFrame, bodyPage, file.images);

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
        const attrs = hotspotAttrs(it, page, frameIds);
        if (!attrs) continue;
        const left = s2.selrect.x - frame.x;
        const top = s2.selrect.y - frame.y;
        const markup =
          `<div class="hotspot" data-trigger="${it.trigger}" ${attrs} ` +
          `style="left:${left}px;top:${top}px;width:${s2.selrect.width}px;height:${s2.selrect.height}px"></div>`;
        // A hotspot travels with whatever it sits on: pinned layers keep theirs in the
        // fixed layer, everything else scrolls with the content.
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
        const attrs = hotspotAttrs(it, page, frameIds);
        return attrs ? `<div class="screen-trigger" data-trigger="${it.trigger}" ${attrs}></div>` : '';
      })
      .filter(Boolean);

    const overflow = scrollsAt === 'both' ? 'auto'
      : scrollsAt === 'horizontal' ? 'auto hidden'
      : scrollsAt === 'vertical' ? 'hidden auto'
      : 'hidden';

    return `<div class="screen" id="screen-${frame.id}" data-w="${frame.width}" data-h="${frame.height}">
      <div class="screen-inner" style="width:${frame.width}px;height:${frame.height}px">
        <div class="scroller" style="overflow:${overflow}">
          <div class="scroll-content" style="width:${contentW}px;height:${contentH}px">
            ${html}
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
  return wrapHtml(file.name, screensHtml, embed(screens), embed(startId), embed(protoId));
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
function hotspotAttrs(it: Interaction, page: Page, frameIds: string[]): string | null {
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
    default:
      return null;
  }
}

// ── HTML shell with embedded nav + comment runtime ────────────────────────────

function wrapHtml(title: string, screensHtml: string, screensJson: string, startJson: string, protoIdJson: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeAttr(title)} — Prototype</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
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
  .comment-pop { position:absolute; z-index:30; width:240px; background:#1e1e2e; border:1px solid rgba(255,255,255,.15);
    border-radius:10px; padding:10px; box-shadow:0 8px 28px rgba(0,0,0,.5); transform:translate(8px,-8px); pointer-events:auto; }
  .comment-pop textarea { width:100%; height:64px; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.12);
    border-radius:6px; color:#cdd6f4; font-family:inherit; font-size:13px; padding:6px; resize:none; outline:none; }
  .comment-pop .meta { font-size:11px; color:#9399b2; margin-bottom:6px; }
  .comment-pop .row { display:flex; gap:6px; margin-top:8px; }
  .comment-pop button { flex:1; border:none; border-radius:6px; padding:6px; font-size:12px; cursor:pointer; font-family:inherit; }
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
    <button class="tb" id="exportBtn" title="Export comments JSON">⤓</button>
    <button class="tb" id="importBtn" title="Import comments JSON">⤒</button>
    <input type="file" id="importFile" accept="application/json" style="display:none" />
  </div>
  <div id="toast"></div>

<script>
(function(){
  var SCREENS = ${screensJson};
  var START = ${startJson};
  var PROTO_ID = ${protoIdJson};
  var STORE_KEY = 'edit-proto-comments::' + PROTO_ID;

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
    // top; slide and move-in leave it where it is, simply covered.
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
  function goBack(){ if(!backStack.length) return; fwdStack.push(current); show(backStack.pop(), 'dissolve', 220, 'ease-out'); }
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

  function closeOverlay(dur){
    var top = overlays.pop();
    if(!top) return;
    var d = dur == null ? 160 : dur;
    var kill = function(){ top.item.remove(); if(top.backdrop) top.backdrop.remove(); };
    if(d > 0){
      var a = anim(top.item, [{opacity:1},{opacity:0}], d, 'ease-out');
      if(top.backdrop) anim(top.backdrop, [{opacity:1},{opacity:0}], d, 'ease-out');
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

  // ── Actions ───────────────────────────────────────────────
  function act(h){
    var a = h.getAttribute('data-action');
    var dur = +h.getAttribute('data-duration');
    var ease = h.getAttribute('data-easing');
    var t = h.getAttribute('data-transition');
    if(a === 'navigate') navigate(h.getAttribute('data-target'), t, dur, ease);
    else if(a === 'back') goBack();
    else if(a === 'overlay') openOverlay(h, false);
    else if(a === 'swap-overlay') openOverlay(h, true);
    else if(a === 'close-overlay') closeOverlay();
    else if(a === 'scroll-to'){
      var sc = document.querySelector('#screen-'+current+' .scroller');
      if(sc) sc.scrollTo({ left:+h.getAttribute('data-scroll-x')||0, top:+h.getAttribute('data-scroll-y')||0, behavior:'smooth' });
    }
    else if(a === 'url'){ var u = h.getAttribute('data-href'); if(u && /^https?:\\/\\//i.test(u)) window.open(u, '_blank', 'noopener'); }
  }

  // "While hovering" and "While pressing" revert when the pointer leaves or lifts.
  function revert(h){
    var a = h.getAttribute('data-action');
    if(a === 'overlay' || a === 'swap-overlay') closeOverlay();
    else if(a === 'navigate') goBack();
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

  stageEl.addEventListener('mouseover', function(e){
    if(commentMode) return;
    var h = hotspotFor(e);
    if(!h) return;
    var trig = h.getAttribute('data-trigger');
    if(trig === 'hover' || trig === 'mouse-enter') act(h);
  });
  stageEl.addEventListener('mouseout', function(e){
    if(commentMode) return;
    var h = hotspotFor(e);
    if(!h) return;
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

  document.getElementById('backBtn').onclick = goBack;
  document.getElementById('fwdBtn').onclick = goForward;
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
      openEditor(layer.getAttribute('data-screen'), x, y, null);
    });
  });

  function renderPins(){
    document.querySelectorAll('.comment-layer').forEach(function(layer){
      layer.innerHTML = '';
      var screenId = layer.getAttribute('data-screen');
      (comments()[screenId]||[]).forEach(function(cm, i){
        var pin = document.createElement('div');
        pin.className = 'comment-pin';
        pin.style.left = cm.x+'px'; pin.style.top = cm.y+'px';
        pin.textContent = (i+1);
        pin.addEventListener('click', function(ev){ ev.stopPropagation(); openEditor(screenId, cm.x, cm.y, cm.id); });
        layer.appendChild(pin);
      });
    });
  }

  function closePop(){ if(openPop){ openPop.remove(); openPop=null; } }

  function openEditor(screenId, x, y, existingId){
    closePop();
    var layer = document.querySelector('.comment-layer[data-screen="'+screenId+'"]');
    var list = comments()[screenId] || [];
    var existing = existingId ? list.find(function(cm){ return cm.id===existingId; }) : null;

    var pop = document.createElement('div');
    pop.className = 'comment-pop';
    pop.style.left = x+'px'; pop.style.top = y+'px';
    pop.innerHTML = '<div class="meta">'+(existing?('Comment · '+new Date(existing.t).toLocaleString()):'New comment')+'</div>'+
      '<textarea placeholder="Type your feedback…"></textarea>'+
      '<div class="row"><button class="cbtn-save">Save</button>'+(existing?'<button class="cbtn-del">Delete</button>':'')+'</div>';
    layer.appendChild(pop);
    openPop = pop;
    var ta = pop.querySelector('textarea');
    ta.value = existing ? existing.text : '';
    ta.focus();
    pop.addEventListener('click', function(e){ e.stopPropagation(); });

    pop.querySelector('.cbtn-save').onclick = function(){
      var c2 = comments(), l2 = c2[screenId]||[];
      if(existing){ existing.text = ta.value; existing.t = Date.now(); c2[screenId]=l2; }
      else { l2.push({ id:'c'+Date.now()+Math.random().toString(36).slice(2,5), x:x, y:y, text:ta.value, t:Date.now() }); c2[screenId]=l2; }
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
    r.onload = function(){ try { var d = JSON.parse(r.result); if(d.comments){ saveComments(d.comments); renderPins(); toast('Comments imported'); } } catch(err){ toast('Invalid file'); } };
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
