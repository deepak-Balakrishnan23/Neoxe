import { DesignFile } from '../shared/types';

// ── Local persistence: autosave + crash recovery (localStorage) ────────────────
//
// Autosave is keyed PER FILE (a map of fileId → entry), so every open dirty tab is
// independently recoverable — not just the active one. Recovery is offered for any file
// whose autosave is newer than its last clean save point, so a NORMAL refresh/close no
// longer loses unsaved work (the old design wiped everything on beforeunload, leaving
// only hard-crash recovery). The save-point comparison is what prevents the recovery
// banner from nagging after you've actually saved.

const AUTOSAVE_KEY = 'edit-autosave';   // Record<fileId, AutosaveEntry>
const SAVEPOINT_KEY = 'edit-savepoint'; // Record<fileId, number (ms)>

interface AutosaveEntry {
  file: DesignFile;
  timestamp: number;
  fileId: string;
}

// ── low-level map read/write ────────────────────────────────────────────────

function readAutosaves(): Record<string, AutosaveEntry> {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v as Record<string, AutosaveEntry> : {};
  } catch { return {}; }
}

function writeAutosaves(map: Record<string, AutosaveEntry>) {
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(AUTOSAVE_KEY);
    else localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(map));
  } catch (e) {
    // Quota exceeded or serialization error — non-fatal (images can be large).
    console.warn('autosave failed', e);
  }
}

function readSavePoints(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SAVEPOINT_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v as Record<string, number> : {};
  } catch { return {}; }
}

// ── Autosave (debounced, multi-file) ────────────────────────────────────────

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

// Persist the given dirty files immediately (used on beforeunload to capture the very
// latest edit, and internally by the debounce).
export function flushAutosave(files: DesignFile[]) {
  if (files.length === 0) return;
  const map = readAutosaves();
  const now = Date.now();
  for (const f of files) map[f.id] = { file: f, timestamp: now, fileId: f.id };
  writeAutosaves(map);
}

// Debounced autosave of every currently-dirty file.
export function scheduleAutosave(files: DesignFile[], intervalMs = 2000) {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => flushAutosave(files), intervalMs);
}

// Cancel a pending autosave (e.g. right after an explicit Save) so a stale timer can't
// re-write a "recoverable" autosave for content that was just saved.
export function cancelAutosave() {
  if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
}

// Drop a single file's autosave (after save/discard), or all of them (fileId omitted).
export function clearAutosave(fileId?: string) {
  if (!fileId) { localStorage.removeItem(AUTOSAVE_KEY); return; }
  const map = readAutosaves();
  delete map[fileId];
  writeAutosaves(map);
}

// ── Save points ─────────────────────────────────────────────────────────────

// Mark a clean save for a file so its autosave is no longer offered for recovery.
export function markSavePoint(fileId: string) {
  const sp = readSavePoints();
  sp[fileId] = Date.now();
  try { localStorage.setItem(SAVEPOINT_KEY, JSON.stringify(sp)); } catch { /* non-fatal */ }
}

// ── Recovery ──────────────────────────────────────────────────────────────────

// Every autosaved session whose changes are newer than its last clean save (i.e. genuine
// unsaved work that survived a refresh/close/crash). Newest first.
export function getRecoverableSessions(): AutosaveEntry[] {
  const map = readAutosaves();
  const sp = readSavePoints();
  return Object.values(map)
    .filter(e => !(typeof sp[e.fileId] === 'number' && sp[e.fileId] >= e.timestamp))
    .sort((a, b) => b.timestamp - a.timestamp);
}
