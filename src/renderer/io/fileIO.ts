// Renderer-side file I/O (pure web app).
//
//  - Chromium (Chrome/Edge, Brave with the flag): File System Access API → real OS save
//    dialog on first save, then silent overwrite of the same file via the kept handle.
//  - No File System Access (Safari/Firefox, default Brave): fall back to a normal
//    download for save, and a hidden <input type=file> for open.

import { DesignFile } from '../../shared/types';
import { importDesignJson } from '../../shared/importers';

const DESIGN_EXT = '.design';

// Parse + validate an opened file. Routes through importDesignJson so native .design files
// are shape-checked (a foreign/corrupt JSON without pages/activePageId used to sail through
// `JSON.parse(...) as DesignFile` and crash later on file.pages.find(...)), and Figma /
// Penpot exports are converted instead of silently producing a broken document.
function parseDesignFile(text: string): DesignFile {
  let json: unknown;
  try { json = JSON.parse(text); }
  catch { throw new Error('This file isn’t valid JSON.'); }
  try { return importDesignJson(json); }
  catch { throw new Error('This file isn’t a recognized design file (.design, Figma, or Penpot export).'); }
}

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
};

function sanitizeName(name: string): string {
  const base = (name || 'untitled').trim().replace(/[\\/:*?"<>|]+/g, '-');
  return base.endsWith(DESIGN_EXT) ? base : base + DESIGN_EXT;
}

// Per-document save target (kept across edits, keyed by the stable file id). Holds the
// FileSystemFileHandle so re-saves write to the same place with no prompt.
const saveTargets = new Map<string, FsaHandle>();

export interface PersistResult {
  saved: boolean;          // false = the user cancelled the OS save dialog
  firstSave: boolean;      // true when this document had no prior save target
  targetLabel: string | null;  // filename to show/remember on the tab
}

async function ensurePermission(handle: FsaHandle): Promise<boolean> {
  const opts = { mode: 'readwrite' };
  try {
    if (!handle.queryPermission) return true;                       // older impl — assume usable
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (handle.requestPermission && (await handle.requestPermission(opts)) === 'granted') return true;
    return false;                                                   // prompt dismissed / denied
  } catch {
    return false;                                                   // request needs activation / failed
  }
}

async function writeViaHandle(handle: FsaHandle, content: string | Blob) {
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

// Download fallback for browsers without the File System Access API. The file genuinely
// saves (to the Downloads folder); the user just doesn't pick the location.
function downloadFile(filename: string, payload: string | Blob, mime: string) {
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
 * Save a document to disk. With the File System Access API the first save prompts
 * (native OS dialog) and later saves overwrite the remembered target silently;
 * without it, each save downloads the file.
 */
export async function persistFile(opts: { content: string; filename: string; fileId: string }): Promise<PersistResult> {
  const { content, fileId } = opts;
  const defaultName = sanitizeName(opts.filename);
  const existing = saveTargets.get(fileId);
  const firstSave = !existing;

  if (win.showSaveFilePicker) {
    // Repeat save of an already-targeted file → write straight back, no dialog.
    if (existing && (await ensurePermission(existing))) {
      await writeViaHandle(existing, content);
      return { saved: true, firstSave, targetLabel: existing.name ?? defaultName };
    }
    // First save (or Save As) → native OS "Save As" dialog, then remember the handle.
    try {
      const handle = await win.showSaveFilePicker({
        suggestedName: defaultName,
        types: [{ description: 'Design File', accept: { 'application/json': [DESIGN_EXT, '.json'] } }],
      });
      await writeViaHandle(handle, content);
      saveTargets.set(fileId, handle);
      return { saved: true, firstSave, targetLabel: handle.name ?? defaultName };
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return { saved: false, firstSave, targetLabel: null };
      throw e;
    }
  }

  // No File System Access API — download so Save still works in every browser.
  downloadFile(defaultName, content, 'application/json');
  return { saved: true, firstSave, targetLabel: defaultName };
}

/** Serialize a document exactly as Open expects to parse it. */
export function serializeFile(file: DesignFile): string {
  return JSON.stringify(file, null, 2);
}

export interface ExportResult {
  saved: boolean;
  targetLabel: string | null;
}

/**
 * Export arbitrary text (e.g. an HTML prototype) to disk. One-shot: always prompts for a
 * location where supported (export ≠ document save); downloads otherwise.
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

  downloadFile(suggestedName, content, mime);
  return { saved: true, targetLabel: suggestedName };
}

// Keep the node name readable for the suggested filename: strip only characters that
// would break a path, preserve spaces / case (Figma keeps the layer name as-is).
function exportBaseName(name: string): string {
  return (name || 'export').replace(/[\\/:*?"<>| -]+/g, '').trim() || 'export';
}

/**
 * Save an exported asset (SVG text, or a PNG/JPG/PDF blob) to disk. One-shot dialog where
 * supported; downloads otherwise. Provide `text` for SVG, or `blob`/`dataUrl` for raster/PDF.
 */
export async function saveExportFile(opts: {
  text?: string;
  blob?: Blob;
  dataUrl?: string;
  suggestedName: string;      // the node/page name — used as-is (only path-illegal chars stripped)
  extension: string;          // 'svg' | 'png' | 'jpg' | 'pdf'
  description: string;
  mime: string;
  // Skip the save dialog and download straight to the browser's download folder. A batch
  // export needs this: only the first picker call has transient activation, so the rest
  // would throw.
  forceDownload?: boolean;
}): Promise<ExportResult> {
  const { text, blob, dataUrl, extension, description, mime } = opts;
  const extNoDot = extension.replace(/^\./, '');
  const ext = '.' + extNoDot;
  const base = exportBaseName(opts.suggestedName);
  const suggestedName = base.endsWith(ext) ? base : base + ext;

  // Decode a data-URL to a Blob SYNCHRONOUSLY (atob, no await) so the file picker is the
  // first await after the click — otherwise transient activation is lost and it throws.
  const payload: string | Blob = text != null ? text : (blob ?? (dataUrl ? dataUrlToBlob(dataUrl, mime) : ''));

  if (win.showSaveFilePicker && !opts.forceDownload) {
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

  downloadFile(suggestedName, payload, mime);
  return { saved: true, targetLabel: suggestedName };
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
      const parsed = parseDesignFile(text);
      if (parsed?.id) saveTargets.set(parsed.id, handle);
      return parsed;
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return null;
      throw e;
    }
  }

  // Fallback open: hidden <input type=file> (read-only; no save handle to keep).
  return new Promise<DesignFile | null>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `${DESIGN_EXT},.json,application/json`;
    input.style.display = 'none';
    input.onchange = () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return resolve(null);
      f.text().then(t => resolve(parseDesignFile(t))).catch(reject);
    };
    document.body.appendChild(input);
    input.click();
  });
}
