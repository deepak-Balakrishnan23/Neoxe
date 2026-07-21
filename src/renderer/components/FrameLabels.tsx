import React, { useState, useRef, useEffect } from 'react';
import { Shape } from '../../shared/types';
import { useDesignStore } from '../store/useDesignStore';
import { api } from '../ipc/api';
import { externalDragPreview } from '../canvas/renderer';

interface Viewport { x: number; y: number; zoom: number; }

interface Props {
  viewport: Viewport;
  onDragChange?: (active: boolean) => void;
}

// Collect a shape and all its descendants (absolute-coord tree must move together).
function withDescendants(objects: Record<string, Shape>, rootId: string): string[] {
  const out = new Set<string>();
  const visit = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    const s = objects[id];
    if (s) for (const c of s.childIds) visit(c);
  };
  visit(rootId);
  return [...out];
}

// Deepest frame whose selrect contains (x, y), skipping excluded ids (the dragged subtree).
// Mirrors the canvas move-drag reparenting so a frame dropped over another frame re-homes.
function frameUnderPoint(
  objects: Record<string, Shape>,
  x: number,
  y: number,
  exclude: Set<string>,
): Shape | null {
  let best: Shape | null = null;
  let bestDepth = -1;
  for (const id of Object.keys(objects)) {
    if (exclude.has(id)) continue;
    const s = objects[id];
    if (!s || s.type !== 'frame' || s.hidden) continue;
    const r = s.selrect;
    if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) {
      let depth = 0;
      let p = s.parentId ?? null;
      while (p) { depth++; p = objects[p]?.parentId ?? null; }
      if (depth > bestDepth) { best = s; bestDepth = depth; }
    }
  }
  return best;
}

export default function FrameLabels({ viewport, onDragChange }: Props) {
  const { activePage, selectedIds, setSelectedIds, setFile } = useDesignStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const finishedRef = useRef(false);
  const finishRef = useRef<(save: boolean) => void>(() => {});

  // Label-initiated drag: tracked entirely in refs + imperative DOM writes (NO React state)
  // so the label stays pixel-locked to the canvas frame, which the renderer moves on its rAF
  // loop. Driving the label through setState instead trails the canvas by a frame → "snake".
  const lastDeltaRef = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => { if (editingId) { finishedRef.current = false; inputRef.current?.select(); } }, [editingId]);

  // Exit rename on outside click (capture-phase — canvas preventDefault suppresses input blur)
  useEffect(() => {
    if (!editingId) return;
    const onDown = (e: MouseEvent) => {
      if (inputRef.current && !inputRef.current.contains(e.target as Node)) finishRef.current(true);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [editingId]);

  const page = activePage();
  if (!page) return null;

  const frames = page.childIds
    .map(id => page.objects[id])
    .filter((s): s is Shape => s?.type === 'frame' && !s.hidden);
  if (frames.length === 0) return null;

  const { x: panX, y: panY, zoom } = viewport;

  const finish = async (id: string, save: boolean) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const name = (inputRef.current?.value ?? '').trim();
    setEditingId(null);
    if (!save || !name) return;
    if (name === (page.objects[id]?.name ?? '')) return;
    const res = await api.applyChanges({ pageId: page.id, ops: [{ op: 'set', id, attr: 'name', val: name }] });
    if (res.ok && res.data) setFile(res.data);
  };
  if (editingId) finishRef.current = (save: boolean) => finish(editingId, save);

  const startLabelDrag = (f: Shape, e: React.MouseEvent) => {
    if (editingId) return;
    e.stopPropagation();
    setSelectedIds([f.id]);
    onDragChange?.(true);

    const startX = e.clientX;
    const startY = e.clientY;
    const origX = f.x;
    const origY = f.y;
    const { zoom: z } = viewport;
    const labelEl = e.currentTarget as HTMLElement; // the dragged label — moved imperatively
    // The label carries a rotation/offset transform — prepend the drag translation to it
    // instead of replacing it, so a rotated frame's label doesn't snap flat mid-drag.
    const baseTransform = labelEl.style.transform;
    lastDeltaRef.current = null;

    // Set preview for all descendants so the canvas draws them at offset positions too.
    const allIds = withDescendants(page.objects, f.id);
    const originals: Record<string, { x: number; y: number }> = {};
    for (const id of allIds) {
      const s = page.objects[id];
      if (s) originals[id] = { x: s.x, y: s.y };
    }

    const onMove = (me: MouseEvent) => {
      const dx = (me.clientX - startX) / z;
      const dy = (me.clientY - startY) / z;
      lastDeltaRef.current = { dx, dy };
      // Move the label by the same screen delta the canvas uses — same mouse event, no
      // setState, so it stays locked to the frame instead of trailing it.
      labelEl.style.transform = `translate(${dx * z}px, ${dy * z}px) ${baseTransform}`;
      for (const id of allIds) {
        const orig = originals[id];
        if (orig) externalDragPreview.set(id, { x: orig.x + dx, y: orig.y + dy });
      }
    };

    const onUp = async () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const ld = lastDeltaRef.current;
      lastDeltaRef.current = null;
      for (const id of allIds) externalDragPreview.delete(id);
      labelEl.style.transform = baseTransform;
      onDragChange?.(false);
      if (!ld || (Math.abs(ld.dx) < 1 && Math.abs(ld.dy) < 1)) return;
      // Commit only the frame's own x/y — the engine's rigid-body cascade translates the
      // whole subtree (explicit descendant ops here would be applied twice).
      const ops: { op: 'set' | 'move'; id: string; attr?: string; val?: unknown; parentId?: string | null; index?: number }[] = [
        { op: 'set' as const, id: f.id, attr: 'x', val: Math.round(origX + ld.dx) },
        { op: 'set' as const, id: f.id, attr: 'y', val: Math.round(origY + ld.dy) },
      ];

      // Re-parent the dragged frame into whatever frame its new center lands over (or the
      // page root on empty canvas). Coords stay absolute, so position is preserved.
      const excluded = new Set(allIds);
      const cx = origX + ld.dx + f.width / 2;
      const cy = origY + ld.dy + f.height / 2;
      const target = frameUnderPoint(page.objects, cx, cy, excluded);
      const targetParentId = target ? target.id : null;
      if (targetParentId !== (f.parentId ?? null)) {
        const siblings = targetParentId ? (page.objects[targetParentId]?.childIds ?? []) : page.childIds;
        ops.push({ op: 'move', id: f.id, parentId: targetParentId, index: siblings.length });
      }

      const res = await api.applyChanges({ pageId: page.id, ops: ops as Parameters<typeof api.applyChanges>[0]['ops'] });
      if (res.ok && res.data) setFile(res.data);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 16, overflow: 'hidden' }}>
      {frames.map(f => {
        const selected = selectedIds.has(f.id);
        // Anchor the label to the frame's (possibly rotated) top-left corner and rotate it
        // with the frame, so it stays glued to the top edge like Figma.
        const rot = f.rotation || 0;
        let cornerX = f.x, cornerY = f.y;
        if (rot) {
          const rad = (rot * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
          const cxd = f.x + f.width / 2, cyd = f.y + f.height / 2;
          cornerX = cxd + (f.x - cxd) * cos - (f.y - cyd) * sin;
          cornerY = cyd + (f.x - cxd) * sin + (f.y - cyd) * cos;
        }
        const left = cornerX * zoom + panX;
        const top = cornerY * zoom + panY;
        // One transform for every angle: rotate FIRST so the upward offset is applied in
        // the label's local (rotated) frame — the gap above the frame's top edge then
        // stays a constant 8px at any rotation. (translate-before-rotate composes the
        // offset in screen axes instead, which made the gap drift with the angle.)
        const labelTransform = `rotate(${rot}deg) translateY(calc(-100% - 8px))`;

        if (editingId === f.id) {
          return (
            <input
              key={f.id}
              ref={inputRef}
              defaultValue={f.name}
              size={Math.max(4, f.name.length)}
              spellCheck={false}
              onInput={e => { e.currentTarget.size = Math.max(4, e.currentTarget.value.length); }}
              onMouseDown={e => e.stopPropagation()}
              onBlur={() => finish(f.id, true)}
              onKeyDown={e => {
                e.stopPropagation();
                if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); finish(f.id, true); }
              }}
              // Same anchor + transform as the static label so entering rename swaps
              // text→input in place (above the frame's top-left corner) instead of the
              // input dropping down onto the canvas.
              style={renameInputStyle(left, top, labelTransform)}
            />
          );
        }
        return (
          <span
            key={f.id}
            title={f.name}
            onMouseDown={e => startLabelDrag(f, e)}
            onDoubleClick={e => { e.stopPropagation(); setEditingId(f.id); }}
            style={{
              position: 'absolute', left, top, maxWidth: Math.max(60, f.width * zoom),
              pointerEvents: 'all',
              cursor: 'move', // consistent move cursor — never the pan hand
              userSelect: 'none',
              font: '600 11px system-ui, sans-serif',
              color: selected ? 'var(--accent)' : 'var(--text-secondary)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              padding: '0 2px',
              transform: labelTransform,
              // Rotation pivots on the anchor point itself (the frame's rotated corner).
              transformOrigin: 'left top',
            }}
          >
            {f.name}
          </span>
        );
      })}
    </div>
  );
}

function renameInputStyle(left: number, top: number, transform: string): React.CSSProperties {
  return {
    position: 'absolute', left, top,
    // Match the static label's anchoring EXACTLY (same transform + origin) so rename
    // swaps in place: anchored at the frame's top-left corner, lifted above the top edge
    // by translateY(calc(-100% - 8px)), rotating around the same corner. Both use -100%
    // of their own height, so each sits 8px above the corner and the input never drops
    // onto the canvas.
    transform,
    transformOrigin: 'left top',
    pointerEvents: 'all',
    font: '600 11px system-ui, sans-serif',
    color: 'var(--text)',
    background: 'var(--bg-elevated)',
    caretColor: 'var(--accent)',
    border: '1.5px solid var(--accent)',
    borderRadius: 4,
    padding: '2px 6px',
    outline: 'none',
    boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
    minWidth: 36,
  };
}
