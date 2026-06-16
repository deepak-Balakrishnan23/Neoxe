import React, { useEffect, useRef, useCallback } from 'react';
import { Shape, TextStyle } from '../../shared/types';
import { Viewport } from '../canvas/renderer';
import { fitTextSize } from '../canvas/textLayout';
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
  }, [isAutoWidth]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // New text starts empty (caret at 0); re-editing existing text drops the caret at the end.
    el.setSelectionRange(el.value.length, el.value.length);
    resize();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = useCallback(async (text: string) => {
    if (committed.current) return;
    committed.current = true;

    const page = activePage();
    if (!page) return;

    if (text.trim() === '') {
      // Empty text box → delete shape (Figma behaviour)
      const res = await api.applyChanges({ pageId: page.id, ops: [{ op: 'del', id: shape.id }] });
      if (res.ok && res.data) setFile(res.data);
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
    const fitted = fitTextSize({ ...shape, paragraphs, textAutoWidth: isAutoWidth });
    if (isAutoWidth) ops.push({ op: 'set', id: shape.id, attr: 'width', val: fitted.width });
    ops.push({ op: 'set', id: shape.id, attr: 'height', val: fitted.height });

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
        defaultValue={currentText}
        rows={1}
        wrap={isAutoWidth ? 'off' : 'soft'}
        onChange={resize}
        onKeyDown={onKeyDown}
        onBlur={e => commit(e.target.value)}
        style={{
          position: 'absolute',
          left: sx,
          top: sy,
          width: fixedWidth ?? 'auto',
          minWidth: 8 * viewport.zoom,
          height: 'auto',
          background: 'transparent',
          // outline (not border) so it doesn't shift text — the glyphs stay exactly
          // where drawText() will paint them after commit (no jump).
          border: 'none',
          outline: `${Math.max(1, viewport.zoom)}px solid #6E72F5`,
          color: style.color ?? '#000000',
          caretColor: style.color ?? '#000000',
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
