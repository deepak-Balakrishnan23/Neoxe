import { DesignFile, Page, Shape } from './types';
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
    const html = frameToHtml(frame, page, file.images);

    // Collect interactive shapes in this frame's subtree → hotspots (one per interaction)
    const hotspots: string[] = [];
    const walked = new Set<string>();
    const walk = (id: string) => {
      if (walked.has(id)) return;
      const s = page.objects[id];
      if (!s) return;
      walked.add(id);
      for (const it of (s.interactions ?? [])) {
        let attrs: string | null = null;
        // Navigate targets must still exist as top-level frames — a deleted/moved target
        // would otherwise emit a dead hotspot into the export.
        if (it.action === 'navigate' && it.targetFrameId && frameIds.includes(it.targetFrameId)) {
          attrs = `data-action="navigate" data-target="${it.targetFrameId}" title="→ ${escapeAttr(page.objects[it.targetFrameId]?.name ?? 'frame')}"`;
        } else if (it.action === 'back') {
          attrs = `data-action="back" title="← Back"`;
        } else if (it.action === 'url' && it.url && /^https?:\/\//i.test(it.url.trim())) {
          // Only http(s) — a javascript:/data: URL here would execute in the exported
          // prototype when the hotspot is clicked.
          attrs = `data-action="url" data-href="${escapeAttr(it.url.trim())}" title="↗ ${escapeAttr(it.url.trim())}"`;
        }
        if (!attrs) continue;
        const left = s.selrect.x - frame.x;
        const top = s.selrect.y - frame.y;
        hotspots.push(
          `<div class="hotspot" data-trigger="${it.trigger}" ${attrs} data-transition="${it.transition}" ` +
          `style="left:${left}px;top:${top}px;width:${s.selrect.width}px;height:${s.selrect.height}px"></div>`
        );
      }
      s.childIds.forEach(walk);
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
      const s = page.objects[id];
      if (!s || s.type === 'frame' || walked.has(id)) continue;
      const scx = s.x + s.width / 2, scy = s.y + s.height / 2;
      if (scx >= frame.x && scx <= frame.x + frame.width && scy >= frame.y && scy <= frame.y + frame.height) walk(id);
    }

    return `<div class="screen" id="screen-${frame.id}" data-w="${frame.width}" data-h="${frame.height}">
      <div class="screen-inner" style="width:${frame.width}px;height:${frame.height}px">
        ${html}
        ${hotspots.join('\n        ')}
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

  /* transitions — applied to the .screen wrapper (the inner keeps its centering transform) */
  .screen.anim-dissolve { animation:dissolve .26s ease; }
  @keyframes dissolve { from{opacity:0} to{opacity:1} }
  .screen.anim-slide-left { animation:slideL .32s cubic-bezier(.2,.7,.2,1); }
  @keyframes slideL { from{transform:translateX(48px);opacity:.3} to{transform:translateX(0);opacity:1} }
  .screen.anim-slide-right { animation:slideR .32s cubic-bezier(.2,.7,.2,1); }
  @keyframes slideR { from{transform:translateX(-48px);opacity:.3} to{transform:translateX(0);opacity:1} }
  .screen.anim-slide-up { animation:slideU .32s cubic-bezier(.2,.7,.2,1); }
  @keyframes slideU { from{transform:translateY(48px);opacity:.3} to{transform:translateY(0);opacity:1} }

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

  var ANIMS = ['anim-dissolve','anim-slide-left','anim-slide-right','anim-slide-up'];
  function show(id, transition){
    var el = document.getElementById('screen-'+id);
    if(!el) return;
    document.querySelectorAll('.screen').forEach(function(s){ s.classList.remove('active'); ANIMS.forEach(function(a){ s.classList.remove(a); }); });
    el.classList.add('active');
    current = id;
    fit();
    if(transition && transition !== 'none'){
      var t = (transition === 'smart') ? 'dissolve' : transition;
      void el.offsetWidth; // restart animation
      el.classList.add('anim-' + t);
    }
    var sc = SCREENS.find(function(s){ return s.id===id; });
    document.getElementById('screenName').textContent = sc ? sc.name : '';
    document.getElementById('backBtn').disabled = backStack.length === 0;
    document.getElementById('fwdBtn').disabled = fwdStack.length === 0;
    renderPins();
  }

  function navigate(id, transition){ if(id===current) return; if(current) backStack.push(current); fwdStack = []; show(id, transition); }
  function goBack(){ if(!backStack.length) return; fwdStack.push(current); show(backStack.pop(), 'dissolve'); }
  function goForward(){ if(!fwdStack.length) return; backStack.push(current); show(fwdStack.pop(), 'dissolve'); }

  // Hotspots — click or hover, navigate / back / url
  function act(h){
    var a = h.getAttribute('data-action');
    if(a === 'navigate') navigate(h.getAttribute('data-target'), h.getAttribute('data-transition'));
    else if(a === 'back') goBack();
    else if(a === 'url'){ var u = h.getAttribute('data-href'); if(u && /^https?:\\/\\//i.test(u)) window.open(u, '_blank', 'noopener'); }
  }
  document.querySelectorAll('.hotspot').forEach(function(h){
    var trigger = h.getAttribute('data-trigger') || 'click';
    h.addEventListener(trigger === 'hover' ? 'mouseenter' : 'click', function(e){
      // In comment mode the click belongs to the comment layer — bail BEFORE stopping
      // propagation, or a full-screen hotspot blocks comments everywhere on its screen.
      if(commentMode) return;
      e.stopPropagation();
      act(h);
    });
  });

  document.getElementById('backBtn').onclick = goBack;
  document.getElementById('fwdBtn').onclick = goForward;
  document.getElementById('homeBtn').onclick = function(){ backStack=[]; fwdStack=[]; show(START,'dissolve'); };
  document.getElementById('hotspotBtn').onclick = function(){ document.body.classList.toggle('show-hotspots'); this.classList.toggle('on'); };

  document.addEventListener('keydown', function(e){
    if(/input|textarea/i.test((e.target.tagName||''))) { if(e.key==='Escape') closePop(); return; }
    if(e.key==='ArrowLeft') goBack();
    else if(e.key==='ArrowRight') goForward();
    else if(e.key==='h'||e.key==='H') { backStack=[]; fwdStack=[]; show(START,'dissolve'); }
    else if(e.key==='f'||e.key==='F') document.getElementById('hotspotBtn').click();
    else if(e.key==='c'||e.key==='C') toggleComment();
    else if(e.key==='Escape') closePop();
  });

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
