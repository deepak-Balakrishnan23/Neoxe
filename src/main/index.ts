import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { DesignFile, ChangeSet, IPCResponse } from '../shared/types';
import { DocumentEngine } from './documentEngine';
import { makeEmptyFile } from '../shared/sampleFile';

let mainWindow: BrowserWindow | null = null;
const engine = new DocumentEngine();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1E1E2E',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('file:new', (): IPCResponse<DesignFile> => {
  const file = makeEmptyFile();
  engine.load(file);
  return { ok: true, data: engine.getState() ?? undefined };
});

ipcMain.handle('file:open', async (): Promise<IPCResponse<DesignFile>> => {
  const result = await dialog.showOpenDialog({
    filters: [{ name: 'Design Files', extensions: ['design', 'json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) {
    return { ok: false, error: 'cancelled' };
  }
  try {
    const raw = fs.readFileSync(result.filePaths[0], 'utf-8');
    const file: DesignFile = JSON.parse(raw);
    engine.load(file);
    return { ok: true, data: engine.getState() ?? undefined };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('file:save', async (): Promise<IPCResponse<void>> => {
  const result = await dialog.showSaveDialog({
    filters: [{ name: 'Design Files', extensions: ['design'] }],
    defaultPath: `${engine.getState()?.name ?? 'untitled'}.design`,
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, error: 'cancelled' };
  }
  try {
    fs.writeFileSync(result.filePath, JSON.stringify(engine.getState(), null, 2), 'utf-8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('file:load', (_event, file: DesignFile): IPCResponse<DesignFile> => {
  engine.load(file);
  return { ok: true, data: engine.getState() ?? undefined };
});

// ── Native file save (renderer-driven; the renderer owns the document) ─────────

ipcMain.handle('dialog:save', async (_event, defaultName: string, filters?: { name: string; extensions: string[] }[]) => {
  return await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: filters ?? [{ name: 'Design Files', extensions: ['design'] }],
  });
});

ipcMain.handle('file:write', async (_event, args: { filePath: string; content: string }) => {
  try {
    fs.writeFileSync(args.filePath, args.content, 'utf8');
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
});

// Binary export write: `dataUrl` is a data: URL (e.g. PNG/JPG canvas output). Decode the
// base64 payload and write raw bytes so the file is a valid image, not text.
ipcMain.handle('file:write-export', async (_event, args: { filePath: string; dataUrl: string }) => {
  try {
    const comma = args.dataUrl.indexOf(',');
    const base64 = comma >= 0 ? args.dataUrl.slice(comma + 1) : args.dataUrl;
    fs.writeFileSync(args.filePath, Buffer.from(base64, 'base64'));
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
});

ipcMain.handle('doc:getState', (): IPCResponse<DesignFile> => {
  const state = engine.getState();
  if (!state) return { ok: false, error: 'no file loaded' };
  return { ok: true, data: state };
});

ipcMain.handle('doc:applyChanges', (_event, changeSet: ChangeSet): IPCResponse<DesignFile> => {
  try {
    engine.applyChanges(changeSet);
    return { ok: true, data: engine.getState()! };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('doc:undo', (): IPCResponse<DesignFile> => {
  engine.undo();
  const state = engine.getState();
  if (!state) return { ok: false, error: 'no state' };
  return { ok: true, data: state };
});

ipcMain.handle('doc:redo', (): IPCResponse<DesignFile> => {
  engine.redo();
  const state = engine.getState();
  if (!state) return { ok: false, error: 'no state' };
  return { ok: true, data: state };
});

// ── Crash recovery: filesystem autosave in userData ───────────────────────────

function autosavePath(): string {
  return path.join(app.getPath('userData'), 'autosave.json');
}

ipcMain.handle('doc:autosave', (_e, file: DesignFile): IPCResponse<void> => {
  try {
    fs.writeFileSync(autosavePath(), JSON.stringify({ file, timestamp: Date.now() }), 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('doc:checkRecovery', (): IPCResponse<{ file: DesignFile; timestamp: number } | null> => {
  try {
    const p = autosavePath();
    if (!fs.existsSync(p)) return { ok: true, data: null };
    const entry = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return { ok: true, data: entry };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('doc:clearRecovery', (): IPCResponse<void> => {
  try {
    const p = autosavePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});
