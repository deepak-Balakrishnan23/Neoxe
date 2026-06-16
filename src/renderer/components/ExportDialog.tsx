import React, { useState } from 'react';
import { useDesignStore } from '../store/useDesignStore';
import { exportRaster, exportSvg, exportPdf, exportPdfMultiPage, RasterFormat } from '../export/exporters';
import { imageCache } from '../canvas/imageCache';

// Prototype/HTML export lives in its own Prototype section — not a format here.
type Fmt = 'png' | 'jpeg' | 'webp' | 'svg' | 'pdf';
const RASTER: Fmt[] = ['png', 'jpeg', 'webp'];
const FMT_LABEL: Record<Fmt, string> = {
  png: 'PNG', jpeg: 'JPG', webp: 'WEBP', svg: 'SVG', pdf: 'PDF',
};

export default function ExportDialog() {
  const { exportOpen, setExportOpen, file, activePage, selectedIds, showToast } = useDesignStore();
  const [format, setFormat] = useState<Fmt>('png');
  const [scale, setScale] = useState(2);
  const [target, setTarget] = useState<'page' | 'selection'>('selection');
  const [pdfMode, setPdfMode] = useState<'single' | 'frames'>('single');
  const [busy, setBusy] = useState(false);

  if (!exportOpen) return null;
  const page = activePage();
  if (!page || !file) return null;

  const hasSelection = selectedIds.size > 0;
  const ids = target === 'selection' && hasSelection ? [...selectedIds] : undefined;
  const isRaster = RASTER.includes(format);

  const doExport = async () => {
    setBusy(true);
    try {
      let res: { saved: boolean; unsupported?: boolean } | undefined;
      if (isRaster) {
        res = await exportRaster(file, page, scale, ids, imageCache, format as RasterFormat);
      } else if (format === 'svg') {
        res = await exportSvg(file, page, ids);
      } else if (format === 'pdf') {
        res = pdfMode === 'frames'
          ? await exportPdfMultiPage(file, page, imageCache)
          : await exportPdf(file, page, ids, imageCache);
      }
      if (res?.saved) showToast(`Exported ${FMT_LABEL[format]}`);
      else if (res?.unsupported) showToast('Saving not supported in this browser — use the desktop app');
      // cancelled (saved:false, not unsupported) → no toast
    } catch (e) {
      showToast(`Export failed: ${(e as Error)?.message ?? e}`);
    } finally {
      setBusy(false);
      setExportOpen(false);
    }
  };

  return (
    <div style={s.overlay} onMouseDown={() => setExportOpen(false)}>
      <div style={s.dialog} onMouseDown={e => e.stopPropagation()}>
        <div style={s.title}>Export</div>

        {/* Target */}
        <div style={s.field}>
          <span style={s.label}>Target</span>
          <div style={s.segGroup}>
            <button style={{ ...s.seg, ...(target === 'selection' ? s.segActive : {}) }}
              disabled={!hasSelection}
              onClick={() => setTarget('selection')}>
              Selection{hasSelection ? ` (${selectedIds.size})` : ''}
            </button>
            <button style={{ ...s.seg, ...(target === 'page' ? s.segActive : {}) }}
              onClick={() => setTarget('page')}>Whole Page</button>
          </div>
        </div>

        {/* Format */}
        <div style={s.field}>
          <span style={s.label}>Format</span>
          <div style={s.segGroup}>
            {(['png', 'jpeg', 'webp', 'svg', 'pdf'] as Fmt[]).map(f => (
              <button key={f} style={{ ...s.seg, ...(format === f ? s.segActive : {}) }}
                onClick={() => setFormat(f)}>{FMT_LABEL[f]}</button>
            ))}
          </div>
        </div>

        {/* Scale (raster formats) */}
        {isRaster && (
          <div style={s.field}>
            <span style={s.label}>Scale</span>
            <div style={s.segGroup}>
              {[1, 2, 3, 4].map(sc => (
                <button key={sc} style={{ ...s.seg, ...(scale === sc ? s.segActive : {}) }}
                  onClick={() => setScale(sc)}>{sc}×</button>
              ))}
            </div>
          </div>
        )}

        {/* PDF page mode */}
        {format === 'pdf' && (
          <div style={s.field}>
            <span style={s.label}>PDF pages</span>
            <div style={s.segGroup}>
              <button style={{ ...s.seg, ...(pdfMode === 'single' ? s.segActive : {}) }}
                onClick={() => setPdfMode('single')}>Single page</button>
              <button style={{ ...s.seg, ...(pdfMode === 'frames' ? s.segActive : {}) }}
                onClick={() => setPdfMode('frames')}>One page per frame</button>
            </div>
          </div>
        )}

        <div style={s.actions}>
          <button style={s.cancel} onClick={() => setExportOpen(false)}>Cancel</button>
          <button style={s.primary} onClick={doExport} disabled={busy}>
            {busy ? 'Exporting…' : `Export ${FMT_LABEL[format]}`}
          </button>
        </div>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(17,17,27,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 500, backdropFilter: 'blur(4px)', fontFamily: 'system-ui',
  },
  dialog: {
    background: 'var(--bg-panel)', border: '1px solid var(--border-strong)',
    borderRadius: 12, padding: 20, width: 320, display: 'flex', flexDirection: 'column', gap: 14,
    boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
  },
  title: { fontSize: 16, fontWeight: 700, color: 'var(--text)' },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' },
  hint: { fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45, background: 'var(--border)', borderRadius: 6, padding: '8px 10px' },
  segGroup: { display: 'flex', gap: 4 },
  seg: {
    flex: 1, background: 'var(--border)', border: '1px solid var(--border-strong)',
    color: 'var(--text)', fontSize: 12, padding: '6px 8px', borderRadius: 6, cursor: 'pointer',
  },
  // Solid accent fill + white text reads in both light and dark themes (a pale tint with
  // white text was invisible in light mode).
  segActive: { background: 'var(--accent)', border: '1px solid var(--accent)', color: '#fff', fontWeight: 600 },
  actions: { display: 'flex', gap: 8, marginTop: 4 },
  cancel: {
    flex: 1, background: 'var(--border)', border: 'none',
    color: 'var(--text)', fontSize: 13, padding: '8px', borderRadius: 6, cursor: 'pointer',
  },
  primary: {
    flex: 2, background: 'var(--accent)', border: 'none',
    color: '#fff', fontSize: 13, padding: '8px', borderRadius: 6, cursor: 'pointer', fontWeight: 500,
  },
};
