// Renderer-side file I/O. NATIVE SAVE ONLY — never downloads.
//
//  - Electron: window.fileAPI → OS save dialog on first save, fs.writeFile after.
//  - Browser (Chromium/Brave): File System Access API → real OS save dialog on first
//    save, then silent overwrite of the same file via the kept handle.
//  - No File System Access + no Electron (e.g. Firefox): save reports unsupported. We do
//    NOT fall back to a blob download — clicking Save must never spray files into Downloads.

import { DesignFile } from '../../shared/types';

const DESIGN_EXT = '.design';

interface FsaHandle {
  name?: string;
  createWritable: () => Promise<{ write: (d: string | Blob) => Promise<void>; close: () => Promise<void> }>;
  getFile?: () => Promise<File>;
  queryPermission?: (o: { mode: string }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: string }) => Promise<PermissionState>;
}

const win = window as unknown as {
  showOpenFilePicker?: (opts?: unknown) => Promise<FsaHandle[]>;
  showSaveFilePicker?: (opts?: unknown) => Promise<FsaHandle>;
  fileAPI?: {
    saveDialog: (defaultName: string, filters?: { name: string; extensions: string[] }[]) => Promise<{ canceled: boolean; filePath?: string }>;
    writeFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>;
    // Binary export: write a data-URL (e.g. PNG/JPG canvas output) to disk natively.
    writeExport?: (filePath: string, dataUrl: string) => Promise<{ success: boolean; error?: string }>;
  };
};

function sanitizeName(name: string): string {
  const base = (name || 'untitled').trim().replace(/[\\/:*?"<>|]+/g, '-');
  return base.endsWith(DESIGN_EXT) ? base : base + DESIGN_EXT;
}

// Per-document save target (kept across edits, keyed by the stable file id). Holds the
// chosen on-disk path (Electron) or the FileSystemFileHandle (browser) so re-saves write
// to the same place with no prompt.
type SaveTarget =
  | { kind: 'electron'; path: string }
  | { kind: 'fsa'; handle: FsaHandle };
const saveTargets = new Map<string, SaveTarget>();

export interface PersistResult {
  saved: boolean;          // false = cancelled or unsupported
  firstSave: boolean;      // true when this document had no prior save target
  targetLabel: string | null;  // path/filename to show/remember on the tab
  unsupported?: boolean;   // true when neither native API is available
}

async function ensurePermission(handle: FsaHandle): Promise<boolean> {
  const opts = { mode: 'readwrite' };
  try {
    if (!handle.queryPermission || (await handle.queryPermission(opts)) === 'granted') return true;
    if (handle.requestPermission && (await handle.requestPermission(opts)) === 'granted') return true;
    return false;
  } catch {
    return true;
  }
}

async function writeViaHandle(handle: FsaHandle, content: string | Blob) {
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

// Last-resort download for EXPORT only (never for document save). Used when neither Electron
// nor the File System Access API is available — e.g. Brave, which disables showSaveFilePicker
// by default. Exporting an asset to Downloads is normal web behaviour; the strict no-download
// rule applies only to the document Save button (persistFile), not to exports.
function downloadExport(filename: string, payload: string | Blob, mime: string) {
  const blob = typeof payload === 'string' ? new Blob([payload], { type: mime }) : payload;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Save a document to disk natively. First save prompts (OS dialog); later saves overwrite
 * the remembered target silently. Never downloads.
 */
export async function persistFile(opts: { content: string; filename: string; fileId: string }): Promise<PersistResult> {
  const { content, fileId } = opts;
  const defaultName = sanitizeName(opts.filename);
  const existing = saveTargets.get(fileId);
  const firstSave = !existing;

  // ── Electron native ──────────────────────────────────────────────────────
  if (win.fileAPI) {
    if (existing && existing.kind === 'electron') {
      const r = await win.fileAPI.writeFile(existing.path, content);
      return { saved: !!r.success, firstSave, targetLabel: existing.path };
    }
    const dlg = await win.fileAPI.saveDialog(defaultName);
    if (dlg.canceled || !dlg.filePath) return { saved: false, firstSave, targetLabel: null };
    const r = await win.fileAPI.writeFile(dlg.filePath, content);
    if (!r.success) return { saved: false, firstSave, targetLabel: null };
    saveTargets.set(fileId, { kind: 'electron', path: dlg.filePath });
    return { saved: true, firstSave, targetLabel: dlg.filePath };
  }

  // ── Browser native: File System Access API ────────────────────────────────
  if (win.showSaveFilePicker) {
    if (existing && existing.kind === 'fsa' && (await ensurePermission(existing.handle))) {
      await writeViaHandle(existing.handle, content);
      return { saved: true, firstSave, targetLabel: existing.handle.name ?? defaultName };
    }
    try {
      const handle = await win.showSaveFilePicker({
        suggestedName: defaultName,
        types: [{ description: 'Design File', accept: { 'application/json': [DESIGN_EXT, '.json'] } }],
      });
      await writeViaHandle(handle, content);
      saveTargets.set(fileId, { kind: 'fsa', handle });
      return { saved: true, firstSave, targetLabel: handle.name ?? defaultName };
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return { saved: false, firstSave, targetLabel: null };
      throw e;
    }
  }

  // No native save available — deliberately do NOT download.
  return { saved: false, firstSave, targetLabel: null, unsupported: true };
}

/** Serialize a document exactly as Open expects to parse it. */
export function serializeFile(file: DesignFile): string {
  return JSON.stringify(file, null, 2);
}

export interface ExportResult {
  saved: boolean;
  targetLabel: string | null;
  unsupported?: boolean;
}

/**
 * Export arbitrary text (e.g. an HTML prototype) to disk via the native OS dialog.
 * One-shot: always prompts for a location (export ≠ document save). Never downloads —
 * if no native API exists, reports unsupported so the caller can show a toast.
 */
export async function exportTextFile(opts: {
  content: string;
  suggestedName: string;
  extension: string;          // e.g. 'html'
  description: string;        // e.g. 'HTML Prototype'
  mime: string;               // e.g. 'text/html'
}): Promise<ExportResult> {
  const { content, extension, description, mime } = opts;
  const ext = extension.startsWith('.') ? extension : '.' + extension;
  const base = (opts.suggestedName || 'export').trim().replace(/[\\/:*?"<>|]+/g, '-');
  const suggestedName = base.endsWith(ext) ? base : base + ext;

  // ── Electron native ──────────────────────────────────────────────────────
  if (win.fileAPI) {
    const dlg = await win.fileAPI.saveDialog(suggestedName, [{ name: description, extensions: [extension.replace(/^\./, '')] }]);
    if (dlg.canceled || !dlg.filePath) return { saved: false, targetLabel: null };
    const r = await win.fileAPI.writeFile(dlg.filePath, content);
    return { saved: !!r.success, targetLabel: r.success ? dlg.filePath : null };
  }

  // ── Browser native: File System Access API ────────────────────────────────
  if (win.showSaveFilePicker) {
    try {
      const handle = await win.showSaveFilePicker({
        suggestedName,
        types: [{ description, accept: { [mime]: [ext] } }],
      });
      await writeViaHandle(handle, content);
      return { saved: true, targetLabel: handle.name ?? suggestedName };
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return { saved: false, targetLabel: null };
      throw e;
    }
  }

  // No native save API (e.g. Brave) — fall back to a normal download so export still works.
  downloadExport(suggestedName, content, mime);
  return { saved: true, targetLabel: suggestedName };
}

// Keep the node name readable for the suggested filename: strip only characters that
// would break a path, preserve spaces / case (Figma keeps the layer name as-is).
function exportBaseName(name: string): string {
  return (name || 'export').replace(/[\\/:*?"<>| -]+/g, '').trim() || 'export';
}

/**
 * Save an exported asset (SVG text, or a PNG/JPG/PDF blob) to disk natively. One-shot
 * dialog; never downloads. Provide `text` for SVG, or `blob` (+ `dataUrl` for the Electron
 * binary write path) for raster/PDF.
 */
export async function saveExportFile(opts: {
  text?: string;
  blob?: Blob;
  dataUrl?: string;
  suggestedName: string;      // the node/page name — used as-is (only path-illegal chars stripped)
  extension: string;          // 'svg' | 'png' | 'jpg' | 'pdf'
  description: string;
  mime: string;
}): Promise<ExportResult> {
  const { text, blob, dataUrl, extension, description, mime } = opts;
  const extNoDot = extension.replace(/^\./, '');
  const ext = '.' + extNoDot;
  const base = exportBaseName(opts.suggestedName);
  const suggestedName = base.endsWith(ext) ? base : base + ext;

  // ── Electron native ──────────────────────────────────────────────────────
  if (win.fileAPI) {
    const dlg = await win.fileAPI.saveDialog(suggestedName, [{ name: description, extensions: [extNoDot] }]);
    if (dlg.canceled || !dlg.filePath) return { saved: false, targetLabel: null };
    let r: { success: boolean; error?: string };
    if (text != null) {
      r = await win.fileAPI.writeFile(dlg.filePath, text);
    } else {
      const url = dataUrl ?? (blob ? await blobToDataUrl(blob) : '');
      r = win.fileAPI.writeExport
        ? await win.fileAPI.writeExport(dlg.filePath, url)
        : { success: false, error: 'writeExport unavailable' };
    }
    return { saved: !!r.success, targetLabel: r.success ? dlg.filePath : null };
  }

  // ── Browser native: File System Access API ────────────────────────────────
  if (win.showSaveFilePicker) {
    // Decode a data-URL to a Blob SYNCHRONOUSLY (atob, no await) so the file picker is the
    // first await after the click — otherwise transient activation is lost and it throws.
    const payload: string | Blob = text != null ? text : (blob ?? (dataUrl ? dataUrlToBlob(dataUrl, mime) : ''));
    try {
      const handle = await win.showSaveFilePicker({
        suggestedName,
        types: [{ description, accept: { [mime]: [ext] } }],
      });
      await writeViaHandle(handle, payload);
      return { saved: true, targetLabel: handle.name ?? suggestedName };
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return { saved: false, targetLabel: null };
      throw e;
    }
  }

  // No native save API (e.g. Brave) — fall back to a normal download so export still works.
  const payload: string | Blob = text != null ? text : (blob ?? (dataUrl ? dataUrlToBlob(dataUrl, mime) : ''));
  downloadExport(suggestedName, payload, mime);
  return { saved: true, targetLabel: suggestedName };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl: string, fallbackMime: string): Blob {
  const comma = dataUrl.indexOf(',');
  const header = comma >= 0 ? dataUrl.slice(0, comma) : '';
  const body = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const mime = /data:([^;,]+)/.exec(header)?.[1] || fallbackMime;
  const isB64 = /;base64/i.test(header);
  const bytesStr = isB64 ? atob(body) : decodeURIComponent(body);
  const bytes = new Uint8Array(bytesStr.length);
  for (let i = 0; i < bytesStr.length; i++) bytes[i] = bytesStr.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * Open a design file from disk. Returns the parsed DesignFile, or null if cancelled.
 * When opened via the File System Access API, the handle is remembered so a later Save
 * overwrites the opened file in place (no prompt).
 */
export async function openDesignFile(): Promise<DesignFile | null> {
  if (win.showOpenFilePicker) {
    try {
      const [handle] = await win.showOpenFilePicker({
        types: [{ description: 'Design File', accept: { 'application/json': [DESIGN_EXT, '.json'] } }],
        multiple: false,
      });
      if (!handle?.getFile) return null;
      const fileObj = await handle.getFile();
      const text = await fileObj.text();
      const parsed = JSON.parse(text) as DesignFile;
      if (parsed?.id) saveTargets.set(parsed.id, { kind: 'fsa', handle });
      return parsed;
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return null;
      throw e;
    }
  }

  // Fallback open: hidden <input type=file> (read-only; no save handle).
  return new Promise<DesignFile | null>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `${DESIGN_EXT},.json,application/json`;
    input.style.display = 'none';
    input.onchange = () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return resolve(null);
      f.text().then(t => resolve(JSON.parse(t) as DesignFile)).catch(reject);
    };
    document.body.appendChild(input);
    input.click();
  });
}
