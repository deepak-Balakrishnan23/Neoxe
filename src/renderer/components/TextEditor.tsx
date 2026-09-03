import React, { useEffect, useRef, useCallback } from 'react';
import { Shape, TextStyle, isTextOnPath } from '../../shared/types';
import { Viewport } from '../canvas/renderer';
import { fitTextSize } from '../canvas/textLayout';
import { setLiveText } from '../canvas/renderer';
import { caretIndexAt, textPathString } from '../canvas/textPath';
import { useDesignStore } from '../store/useDesignStore';
import { api } from '../ipc/api';

interface Props {
  shape: Shape;
  viewport: Viewport;
}

export default function TextEditor({ shape, viewport }: Props) {
  const { setFile, setEditingTextId, activePage, setActiveTool, setSelectedIds } = useDesignStore();
  const ref = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const committed = useRef(false);

  const isAutoWidth = shape.textAutoWidth === true;

  // Text on a path edits in place on the curve rather than in a box overlay.

  const onPath = isTextOnPath(shape);
  const style = (shape.textStyle ?? {}) as TextStyle;
  const scaledFontSize = (style.fontSize ?? 16) * viewport.zoom;
  const scaledLetterSpacing = (style.letterSpacing ?? 0) * viewport.zoom;

  // Flatten paragraphs → editable text (each paragraph on its own line)
  const currentText = shape.paragraphs
    ? shape.paragraphs.map(p => p.spans.map(s => s.text).join('')).join('\n')
    : '';

  const sharedFont: React.CSSProperties = {
    fontSize: scaledFontSize,
    fontFamily: style.fontFamily ?? 'system-ui, sans-serif',
    fontWeight: style.fontWeight ?? 400,
    lineHeight: String(style.lineHeight ?? 1.2),
    letterSpacing: `${scaledLetterSpacing}px`,
    textTransform: (style.textTransform ?? 'none') as React.CSSProperties['textTransform'],
  };

  const resize = useCallback(() => {
    const el = ref.current;
    const mirror = mirrorRef.current;
    if (!el) return;
    // A text-on-path overlay is a fixed invisible hit area covering the whole shape (plus
    // a line of padding for glyphs that overshoot it). Auto-sizing it to the string would
    // shrink it back to one row, and clicks on the curved glyphs would miss it again.
    if (onPath) return;

    if (isAutoWidth && mirror) {
      // Measure the longest line to determine width
      const lines = el.value.split('\n');
      const longest = lines.reduce((a, b) => (a.length >= b.length ? a : b), '') || 'M';
      mirror.textContent = longest;
      el.style.width = Math.max(mirror.scrollWidth + 4, 20) + 'px';
    }

    // Auto-grow height
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, [isAutoWidth, onPath]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // New text starts empty (caret at 0); re-editing existing text drops the caret at the end.
    el.setSelectionRange(el.value.length, el.value.length);
    resize();
    if (onPath) setLiveText(shape.id, el.value, el.value.length, el.value.length);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Glyphs on a baseline straddle it, so those on the top of an ellipse render ABOVE the
  // shape's box. Pad the invisible overlay by a line's worth on every side or clicks on
  // exactly those glyphs miss it, hit the canvas, and commit - which reads as "the text
  // can't be edited".
  const padDoc = onPath ? (style.fontSize ?? 16) * 1.5 : 0;
  const padPx = padDoc * viewport.zoom;

  /** The character index under a screen point, measured ALONG the curve. The textarea is
   *  a rectangle, so its own hit-testing would pick a character from the wrong place. */
  const indexAtClient = useCallback((clientX: number, clientY: number): number => {
    const el = ref.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const lx = (clientX - r.left) / viewport.zoom - padDoc;
    const ly = (clientY - r.top) / viewport.zoom - padDoc;
    return caretIndexAt(shape, textPathString(shape, el.value), lx, ly);
  }, [shape, viewport.zoom, padDoc]);

  /** Mirror the textarea's value AND caret/selection onto the canvas, so a text-on-path
   *  shows where you are typing. Without this the overlay is invisible and editing looks
   *  like it is doing nothing. */
  const pushLive = useCallback(() => {
    const el = ref.current;
    if (!el || !onPath) return;
    setLiveText(shape.id, el.value, el.selectionStart ?? 0, el.selectionEnd ?? 0);
  }, [onPath, shape.id]);

  const commit = useCallback(async (text: string) => {
    if (committed.current) return;
    committed.current = true;

    const page = activePage();
    if (!page) return;

    if (text.trim() === '') {
      // Empty text box → delete shape (Figma behaviour)
      const res = await api.applyChanges({ pageId: page.id, ops: [{ op: 'del', id: shape.id }] });
      if (res.ok && res.data) setFile(res.data);
      setLiveText(null);
    setEditingTextId(null);
      setSelectedIds([]);
      setActiveTool('select');
      return;
    }

    const align = shape.paragraphs?.[0]?.align ?? 'left';
    const lines = text.split('\n');
    const paragraphs = lines.map(line => ({ align, spans: [{ text: line }] }));
    const firstName = lines[0].trim() || 'Text';

    const ops: Parameters<typeof api.applyChanges>[0]['ops'] = [
      { op: 'set', id: shape.id, attr: 'paragraphs', val: paragraphs },
      { op: 'set', id: shape.id, attr: 'name', val: firstName },
    ];

    // Fit the box to the content + style + mode (Figma auto-resize). Auto-width grows
    // width to the longest line and height to the line count; fixed-width keeps its
    // width and grows height to fit the wrapped lines. Same measurement the renderer uses.
    // Text on a path is exempt: its box defines the curve the glyphs run along, so
    // shrinking it to the typed string would flatten the baseline.
    if (!isTextOnPath(shape)) {
      const fitted = fitTextSize({ ...shape, paragraphs, textAutoWidth: isAutoWidth });
      if (isAutoWidth) ops.push({ op: 'set', id: shape.id, attr: 'width', val: fitted.width });
      ops.push({ op: 'set', id: shape.id, attr: 'height', val: fitted.height });
    }

    const res = await api.applyChanges({ pageId: page.id, ops });
    if (res.ok && res.data) setFile(res.data);
    setEditingTextId(null);
    // Figma: finishing a text edit selects the text with the Move tool active.
    setSelectedIds([shape.id]);
    setActiveTool('select');
  }, [activePage, shape, isAutoWidth, viewport.zoom, setFile, setEditingTextId, setActiveTool, setSelectedIds]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      commit(ref.current?.value ?? '');
      return;
    }
    // Enter = line break → default textarea behaviour (no override needed)
    // Cmd+A / Cmd+C / Cmd+V / Cmd+X → browser handles natively
  };

  const sx = shape.x * viewport.zoom + viewport.x;
  const sy = shape.y * viewport.zoom + viewport.y;
  const fixedWidth = !isAutoWidth ? Math.max(shape.width * viewport.zoom, 20) : undefined;

  return (
    <>
      {/* Hidden mirror for auto-width text measurement */}
      <div
        ref={mirrorRef}
        aria-hidden="true"
        style={{
          position: 'fixed',
          top: -9999,
          left: -9999,
          visibility: 'hidden',
          whiteSpace: 'pre',
          pointerEvents: 'none',
          ...sharedFont,
        }}
      />
      <textarea
        ref={ref}
        className={onPath ? 'textpath-editor' : undefined}
        defaultValue={currentText}
        rows={1}
        wrap={isAutoWidth ? 'off' : 'soft'}
        onChange={() => { resize(); pushLive(); }}
        onSelect={pushLive}
        onKeyUp={pushLive}
        onMouseDown={e => {
          if (!onPath) return;
          const el = ref.current;
          if (!el) return;
          // Selection is driven by hand here. The textarea's own drag-select works in box
          // coordinates, which on a curved baseline highlights the wrong characters, so
          // the native behaviour is suppressed and replaced with a walk along the path.
          e.preventDefault();
          if (document.activeElement !== el) el.focus();
          const anchor = indexAtClient(e.clientX, e.clientY);
          el.setSelectionRange(anchor, anchor);
          pushLive();

          const move = (ev: MouseEvent) => {
            const j = indexAtClient(ev.clientX, ev.clientY);
            el.setSelectionRange(Math.min(anchor, j), Math.max(anchor, j),
              j < anchor ? 'backward' : 'forward');
            pushLive();
          };
          const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            pushLive();
          };
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
        }}
        onDoubleClick={e => {
          if (!onPath) return;
          const el = ref.current;
          if (!el) return;
          // Double-click selects the word under the cursor, as in a normal text box.
          e.preventDefault();
          const i = indexAtClient(e.clientX, e.clientY);
          const v = el.value;
          const isWord = (c: string) => /[\p{L}\p{N}_]/u.test(c);
          let a = Math.min(i, Math.max(0, v.length - 1));
          let b = a;
          if (isWord(v[a] ?? '')) {
            while (a > 0 && isWord(v[a - 1])) a--;
            while (b < v.length && isWord(v[b])) b++;
          } else {
            b = Math.min(v.length, a + 1);
          }
          el.setSelectionRange(a, b);
          pushLive();
        }}
        onMouseUp={pushLive}
        onKeyDown={onKeyDown}
        onBlur={e => commit(e.target.value)}
        style={{
          position: 'absolute',
          left: onPath ? sx - padPx : sx,
          top: onPath ? sy - padPx : sy,
          width: onPath ? shape.width * viewport.zoom + padPx * 2 : (fixedWidth ?? 'auto'),
          minWidth: onPath ? undefined : 8 * viewport.zoom,
          height: onPath ? shape.height * viewport.zoom + padPx * 2 : 'auto',
          background: 'transparent',
          // outline (not border) so it doesn't shift text — the glyphs stay exactly
          // where drawText() will paint them after commit (no jump).
          border: 'none',
          // A curved baseline can't be represented by a box-shaped textarea, so for text
          // on a path the overlay goes invisible and only captures keystrokes: the canvas
          // keeps drawing the glyphs along the curve live as you type (Figma's behaviour).
          outline: onPath ? 'none' : `${Math.max(1, viewport.zoom)}px solid #6E72F5`,
          color: onPath ? 'transparent' : (style.color ?? '#000000'),
          caretColor: onPath ? 'transparent' : (style.color ?? '#000000'),
          ...sharedFont,
          padding: 0,
          margin: 0,
          resize: 'none',
          overflow: 'hidden',
          zIndex: 10,
          boxSizing: 'border-box',
          whiteSpace: isAutoWidth ? 'pre' : 'pre-wrap',
          wordBreak: isAutoWidth ? 'normal' : 'break-word',
        }}
      />
    </>
  );
}
