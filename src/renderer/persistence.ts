import { DesignFile } from '../shared/types';

// ── Local persistence: autosave, crash recovery, recent files ─────────────────
// Browser-first (localStorage). In Electron this is mirrored by the main process
// writing to the app data dir, but localStorage works identically for the renderer.

const AUTOSAVE_KEY = 'edit-autosave';
const RECENTS_KEY = 'edit-recent-files';
const MAX_RECENTS = 8;

interface AutosaveEntry {
  file: DesignFile;
  timestamp: number;
  fileId: string;
}

// ── Autosave ──────────────────────────────────────────────────────────────────

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleAutosave(file: DesignFile, intervalMs = 2000) {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => writeAutosave(file), intervalMs);
}

export function writeAutosave(file: DesignFile) {
  try {
    const entry: AutosaveEntry = { file, timestamp: Date.now(), fileId: file.id };
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(entry));
  } catch (e) {
    // Quota exceeded or serialization error — non-fatal
    console.warn('autosave failed', e);
  }
}

export function getAutosave(): AutosaveEntry | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearAutosave() {
  localStorage.removeItem(AUTOSAVE_KEY);
}

// Mark a clean save point so recovery only triggers on genuinely-newer autosaves.
const SAVEPOINT_KEY = 'edit-savepoint';
export function markSavePoint(fileId: string) {
  localStorage.setItem(SAVEPOINT_KEY, JSON.stringify({ fileId, timestamp: Date.now() }));
}
export function getSavePoint(): { fileId: string; timestamp: number } | null {
  try {
    const raw = localStorage.getItem(SAVEPOINT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// Should we offer recovery? Yes if an autosave exists that is newer than the
// last clean save point (i.e. unsaved changes survived a crash/refresh).
export function hasRecoverableSession(): AutosaveEntry | null {
  const auto = getAutosave();
  if (!auto) return null;
  const sp = getSavePoint();
  if (sp && sp.fileId === auto.fileId && sp.timestamp >= auto.timestamp) return null;
  return auto;
}

// ── Recent files ──────────────────────────────────────────────────────────────

export interface RecentFile {
  id: string;
  name: string;
  timestamp: number;
  thumbnail?: string;       // optional small data-url
  file: DesignFile;         // full content (local-first; capped count)
}

export function addRecent(file: DesignFile, thumbnail?: string) {
  try {
    const recents = getRecents();
    const filtered = recents.filter(r => r.id !== file.id);
    filtered.unshift({ id: file.id, name: file.name, timestamp: Date.now(), thumbnail, file });
    const capped = filtered.slice(0, MAX_RECENTS);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(capped));
  } catch (e) {
    console.warn('addRecent failed', e);
  }
}

export function getRecents(): RecentFile[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function removeRecent(id: string) {
  const recents = getRecents().filter(r => r.id !== id);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
}

export function clearRecents() {
  localStorage.removeItem(RECENTS_KEY);
}
