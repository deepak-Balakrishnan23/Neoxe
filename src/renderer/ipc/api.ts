import { DesignFile, ChangeSet, IPCResponse, TokenType, DesignToken } from '../../shared/types';
import { makeEmptyFile } from '../../shared/sampleFile';
import { DocumentEngine, EngineSession } from '../mockEngine';

// In-browser document engine facade. The app is a pure web app — the engine runs in the
// renderer; disk open/save live in io/fileIO.ts (File System Access API + fallbacks).
const engine = new DocumentEngine();

const docApi = {
  newFile: async (): Promise<IPCResponse<DesignFile>> => {
    engine.load(makeEmptyFile());
    return { ok: true, data: engine.getState()! };
  },
  loadFile: async (file: DesignFile): Promise<IPCResponse<DesignFile>> => {
    engine.load(file);
    return { ok: true, data: engine.getState()! };
  },
  getState: async (): Promise<IPCResponse<DesignFile>> => {
    const s = engine.getState();
    return s ? { ok: true, data: s } : { ok: false, error: 'no file loaded' };
  },
  applyChanges: async (cs: ChangeSet): Promise<IPCResponse<DesignFile>> => {
    // applyChanges already returns the (possibly structurally-shared) snapshot — use it
    // directly instead of a second getState() that would force a full clone.
    return { ok: true, data: engine.applyChanges(cs) };
  },
  undo: async (): Promise<IPCResponse<DesignFile>> => {
    engine.undo();
    return { ok: true, data: engine.getState()! };
  },
  redo: async (): Promise<IPCResponse<DesignFile>> => {
    engine.redo();
    return { ok: true, data: engine.getState()! };
  },
};

// ── Component & asset management ─────────────────────────────────────────────

const compMock = {
  createComponent: async (shapeId: string, pageId: string): Promise<IPCResponse<DesignFile>> => {
    const f = engine.createComponent(shapeId, pageId);
    return f ? { ok: true, data: f } : { ok: false, error: 'failed' };
  },
  createInstance: async (componentId: string, pageId: string, x: number, y: number): Promise<IPCResponse<DesignFile>> => {
    const f = engine.createInstance(componentId, pageId, x, y);
    return f ? { ok: true, data: f } : { ok: false, error: 'failed' };
  },
  detachInstance: async (shapeId: string, pageId: string): Promise<IPCResponse<DesignFile>> => {
    const f = engine.detachInstance(shapeId, pageId);
    return f ? { ok: true, data: f } : { ok: false, error: 'failed' };
  },
  resetOverrides: async (shapeId: string, pageId: string): Promise<IPCResponse<DesignFile>> => {
    const f = engine.resetOverrides(shapeId, pageId);
    return f ? { ok: true, data: f } : { ok: false, error: 'failed' };
  },
  addColor: async (name: string, color: string, opacity: number): Promise<IPCResponse<DesignFile>> => {
    const f = engine.addColor(name, color, opacity);
    return f ? { ok: true, data: f } : { ok: false, error: 'failed' };
  },
  updateColor: async (id: string, patch: { name?: string; color?: string; opacity?: number }): Promise<IPCResponse<DesignFile>> => {
    const f = engine.updateColor(id, patch);
    return f ? { ok: true, data: f } : { ok: false, error: 'failed' };
  },
  deleteColor: async (id: string): Promise<IPCResponse<DesignFile>> => {
    const f = engine.deleteColor(id);
    return f ? { ok: true, data: f } : { ok: false, error: 'failed' };
  },
  addTypography: async (name: string, style: Record<string, unknown>): Promise<IPCResponse<DesignFile>> => {
    const f = engine.addTypography(name, style as any);
    return f ? { ok: true, data: f } : { ok: false, error: 'failed' };
  },
  deleteTypography: async (id: string): Promise<IPCResponse<DesignFile>> => {
    const f = engine.deleteTypography(id);
    return f ? { ok: true, data: f } : { ok: false, error: 'failed' };
  },
};

// ── Token management ──────────────────────────────────────────────────────────

const tokenMock = {
  addToken: async (name: string, type: TokenType, value: string | number): Promise<IPCResponse<DesignFile>> => {
    const f = engine.addToken(name, type, value);
    return f ? { ok: true, data: f } : { ok: false, error: 'failed' };
  },
  updateToken: async (id: string, patch: Partial<DesignToken>): Promise<IPCResponse<DesignFile>> => {
    const f = engine.updateToken(id, patch);
    return f ? { ok: true, data: f } : { ok: false, error: 'failed' };
  },
  deleteToken: async (id: string): Promise<IPCResponse<DesignFile>> => {
    const f = engine.deleteToken(id);
    return f ? { ok: true, data: f } : { ok: false, error: 'failed' };
  },
  bindToken: async (shapeId: string, pageId: string, path: string, tokenName: string): Promise<IPCResponse<DesignFile>> => {
    const f = engine.bindToken(shapeId, pageId, path, tokenName);
    return f ? { ok: true, data: f } : { ok: false, error: 'failed' };
  },
  unbindToken: async (shapeId: string, pageId: string, path: string): Promise<IPCResponse<DesignFile>> => {
    const f = engine.unbindToken(shapeId, pageId, path);
    return f ? { ok: true, data: f } : { ok: false, error: 'failed' };
  },
  switchTheme: async (themeId: string): Promise<IPCResponse<DesignFile>> => {
    const f = engine.switchTheme(themeId);
    return f ? { ok: true, data: f } : { ok: false, error: 'failed' };
  },
};

// ── Page management ───────────────────────────────────────────────────────────

const pageMock = {
  addPage: async (): Promise<IPCResponse<DesignFile>> => {
    const f = engine.addPage();
    return f ? { ok: true, data: f } : { ok: false, error: 'no file' };
  },
  deletePage: async (pageId: string): Promise<IPCResponse<DesignFile>> => {
    const f = engine.deletePage(pageId);
    return f ? { ok: true, data: f } : { ok: false, error: 'cannot delete only page' };
  },
  switchPage: async (pageId: string): Promise<IPCResponse<DesignFile>> => {
    const f = engine.switchPage(pageId);
    return f ? { ok: true, data: f } : { ok: false, error: 'page not found' };
  },
  renamePage: async (pageId: string, name: string): Promise<IPCResponse<DesignFile>> => {
    const f = engine.renamePage(pageId, name);
    return f ? { ok: true, data: f } : { ok: false, error: 'page not found' };
  },
  setPageBackground: async (pageId: string, color: string): Promise<IPCResponse<DesignFile>> => {
    const f = engine.setPageBackground(pageId, color);
    return f ? { ok: true, data: f } : { ok: false, error: 'page not found' };
  },
};

export const api = {
  newFile: () => docApi.newFile(),
  // Load an already-parsed document (from disk Open in io/fileIO.ts) into the engine.
  loadFile: (file: DesignFile) => docApi.loadFile(file),

  // ── Multi-tab session management ──────────────────────────────────────────────
  // Each tab owns an isolated document + undo/redo history. The store stashes the
  // active session out and swaps another in when switching tabs.
  exportSession: (): EngineSession => engine.exportSession(),
  loadSession: (session: EngineSession): DesignFile | null => {
    engine.loadSession(session);
    return engine.getState();
  },
  getState: () => docApi.getState(),
  applyChanges: (cs: ChangeSet) => docApi.applyChanges(cs),
  undo: () => docApi.undo(),
  redo: () => docApi.redo(),
  // Component & assets
  createComponent: (shapeId: string, pageId: string) => compMock.createComponent(shapeId, pageId),
  createInstance: (componentId: string, pageId: string, x: number, y: number) => compMock.createInstance(componentId, pageId, x, y),
  detachInstance: (shapeId: string, pageId: string) => compMock.detachInstance(shapeId, pageId),
  resetOverrides: (shapeId: string, pageId: string) => compMock.resetOverrides(shapeId, pageId),
  addColor: (name: string, color: string, opacity: number) => compMock.addColor(name, color, opacity),
  updateColor: (id: string, patch: { name?: string; color?: string; opacity?: number }) => compMock.updateColor(id, patch),
  deleteColor: (id: string) => compMock.deleteColor(id),
  addTypography: (name: string, style: Record<string, unknown>) => compMock.addTypography(name, style),
  deleteTypography: (id: string) => compMock.deleteTypography(id),
  // Design tokens
  addToken: (name: string, type: TokenType, value: string | number) => tokenMock.addToken(name, type, value),
  updateToken: (id: string, patch: Partial<DesignToken>) => tokenMock.updateToken(id, patch),
  deleteToken: (id: string) => tokenMock.deleteToken(id),
  bindToken: (shapeId: string, pageId: string, path: string, tokenName: string) => tokenMock.bindToken(shapeId, pageId, path, tokenName),
  unbindToken: (shapeId: string, pageId: string, path: string) => tokenMock.unbindToken(shapeId, pageId, path),
  switchTheme: (themeId: string) => tokenMock.switchTheme(themeId),
  // Prototype
  setPrototypeStart: async (frameId: string): Promise<IPCResponse<DesignFile>> => {
    const f = engine.setPrototypeStart(frameId);
    return f ? { ok: true, data: f } : { ok: false, error: 'failed' };
  },
  renameFile: async (name: string): Promise<IPCResponse<DesignFile>> => {
    const f = engine.renameFile(name);
    return f ? { ok: true, data: f } : { ok: false, error: 'failed' };
  },
  // Page management always goes through the browser mock for now
  addPage: () => pageMock.addPage(),
  deletePage: (pageId: string) => pageMock.deletePage(pageId),
  switchPage: (pageId: string) => pageMock.switchPage(pageId),
  renamePage: (pageId: string, name: string) => pageMock.renamePage(pageId, name),
  setPageBackground: (pageId: string, color: string) => pageMock.setPageBackground(pageId, color),
};
