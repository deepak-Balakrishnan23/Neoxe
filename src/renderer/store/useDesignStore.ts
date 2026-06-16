import { create } from 'zustand';
import { DesignFile, Page, PathSegment, AnchorPoint, SvgPathEdit, SvgPointRef, Guide } from '../../shared/types';
export type { Guide };
import { api } from '../ipc/api';
import { persistFile, serializeFile } from '../io/fileIO';
import type { EngineSession } from '../mockEngine';

export type ToolType = 'select' | 'rect' | 'ellipse' | 'frame' | 'text' | 'pen' | 'image';

// One open document. The active tab's live document/history lives in the engine; its
// `session` is null. Inactive tabs cache their full session (doc + undo/redo) so they
// stay fully isolated, and are swapped back into the engine when re-activated.
export interface Tab {
  id: string;
  filename: string;
  isDirty: boolean;
  session: EngineSession | null;
  selectedIds: string[];
  // On-disk path this document is bound to (native save). null = never saved yet, so the
  // next save opens the OS dialog.
  savedFilePath: string | null;
}

interface DesignStore {
  file: DesignFile | null;
  selectedIds: Set<string>;
  activeTool: ToolType;
  rightMode: 'design' | 'inspect' | 'prototype';
  exportOpen: boolean;
  editingTextId: string | null;
  // Group currently "entered" for direct child selection (Figma group edit mode). null = top-level.
  groupEditId: string | null;
  // Vector shape being edited (double-click enters vector edit mode)
  vectorEditShapeId: string | null;
  vectorEditChildId: string | null;
  // Path anchor-point edit mode
  pathEditShapeId: string | null;
  editingPoints: AnchorPoint[];
  selectedPointIndices: number[];
  // SVG path edit mode
  svgEditShapeId: string | null;
  svgEditingPaths: SvgPathEdit[];
  svgSelectedPoints: SvgPointRef[];
  // Ephemeral SVG innerHTML during drag-editing — never persisted
  livePreviewSvg: string | null;
  // Pen tool in-progress path
  penSegments: PathSegment[] | null;
  penCurrentDoc: { x: number; y: number } | null;
  // Pen continuation: shape being extended + direction
  penContinueShapeId: string | null;
  penContinueIsFirst: boolean;

  // ── Tabs ──────────────────────────────────────────────────────────────────
  tabs: Tab[];
  activeTabId: string | null;
  pendingCloseTabId: string | null;  // tab awaiting the unsaved-changes decision

  // Guides per page
  guidesPerPage: Record<string, Guide[]>;
  addGuide: (pageId: string, guide: Guide) => void;
  updateGuide: (pageId: string, id: string, position: number) => void;
  removeGuide: (pageId: string, id: string) => void;
  clearGuides: (pageId: string) => void;

  // Transient toast (e.g. "Saved", "Latest changes updated"). id changes each show.
  toast: { id: number; message: string } | null;
  showToast: (message: string) => void;

  setFile: (file: DesignFile) => void;
  setSelectedIds: (ids: string[]) => void;
  toggleSelected: (id: string, multi: boolean) => void;
  clearSelection: () => void;
  setActiveTool: (tool: ToolType) => void;
  setRightMode: (mode: 'design' | 'inspect' | 'prototype') => void;
  setExportOpen: (open: boolean) => void;
  setEditingTextId: (id: string | null) => void;
  setGroupEditId: (id: string | null) => void;
  setVectorEditShapeId: (id: string | null) => void;
  setVectorEditChildId: (id: string | null) => void;
  setPathEditShapeId: (id: string | null) => void;
  setEditingPoints: (pts: AnchorPoint[]) => void;
  setSelectedPointIndices: (idxs: number[]) => void;
  setSvgEditShapeId: (id: string | null) => void;
  setSvgEditingPaths: (paths: SvgPathEdit[]) => void;
  setSvgSelectedPoints: (pts: SvgPointRef[]) => void;
  setLivePreviewSvg: (svg: string | null) => void;
  setPenSegments: (segs: PathSegment[] | null) => void;
  setPenCurrentDoc: (pt: { x: number; y: number } | null) => void;
  setPenContinueShapeId: (id: string | null) => void;
  setPenContinueIsFirst: (b: boolean) => void;

  // Tab actions
  initFirstTab: (file: DesignFile) => void;
  openNewTab: () => Promise<void>;
  openFileInNewTab: (file: DesignFile) => Promise<void>;
  setActiveTab: (id: string) => void;
  requestCloseTab: (id: string) => void;
  closeTab: (id: string) => Promise<void>;
  setDirty: (id: string, dirty: boolean) => void;
  setTabFilePath: (id: string, path: string) => void;
  // Save a tab to disk (native dialog on first save, silent overwrite after). Returns
  // whether it saved and whether this was the first save (for toast wording).
  saveTab: (id: string) => Promise<{ saved: boolean; firstSave: boolean }>;

  activePage: () => Page | null;
}

const genTabId = () => Math.random().toString(36).slice(2, 10);

// Pick an unused "Untitled" / "Untitled 2" / … name given the open tabs.
function uniqueUntitledName(tabs: Tab[]): string {
  const taken = new Set(tabs.map(t => t.filename));
  if (!taken.has('Untitled')) return 'Untitled';
  let n = 2;
  while (taken.has(`Untitled ${n}`)) n++;
  return `Untitled ${n}`;
}

export const useDesignStore = create<DesignStore>((set, get) => ({
  file: null,
  selectedIds: new Set(),
  activeTool: 'select',
  rightMode: 'design',
  exportOpen: false,
  editingTextId: null,
  groupEditId: null,
  vectorEditShapeId: null,
  vectorEditChildId: null,
  pathEditShapeId: null,
  editingPoints: [],
  selectedPointIndices: [],
  svgEditShapeId: null,
  svgEditingPaths: [],
  svgSelectedPoints: [],
  livePreviewSvg: null,
  penSegments: null,
  penCurrentDoc: null,
  penContinueShapeId: null,
  penContinueIsFirst: false,

  tabs: [],
  activeTabId: null,
  pendingCloseTabId: null,

  guidesPerPage: {},
  addGuide: (pageId, guide) =>
    set(state => {
      const next = { ...state.guidesPerPage, [pageId]: [...(state.guidesPerPage[pageId] ?? []), guide] };
      return {
        guidesPerPage: next,
        file: state.file ? { ...state.file, guidesPerPage: next } : null,
        tabs: state.tabs.map(t => t.id === state.activeTabId ? { ...t, isDirty: true } : t),
      };
    }),
  updateGuide: (pageId, id, position) =>
    set(state => {
      const next = { ...state.guidesPerPage, [pageId]: (state.guidesPerPage[pageId] ?? []).map(g => g.id === id ? { ...g, position } : g) };
      return {
        guidesPerPage: next,
        file: state.file ? { ...state.file, guidesPerPage: next } : null,
        tabs: state.tabs.map(t => t.id === state.activeTabId ? { ...t, isDirty: true } : t),
      };
    }),
  removeGuide: (pageId, id) =>
    set(state => {
      const next = { ...state.guidesPerPage, [pageId]: (state.guidesPerPage[pageId] ?? []).filter(g => g.id !== id) };
      return {
        guidesPerPage: next,
        file: state.file ? { ...state.file, guidesPerPage: next } : null,
        tabs: state.tabs.map(t => t.id === state.activeTabId ? { ...t, isDirty: true } : t),
      };
    }),
  clearGuides: (pageId) =>
    set(state => {
      const next = { ...state.guidesPerPage, [pageId]: [] };
      return {
        guidesPerPage: next,
        file: state.file ? { ...state.file, guidesPerPage: next } : null,
        tabs: state.tabs.map(t => t.id === state.activeTabId ? { ...t, isDirty: true } : t),
      };
    }),

  toast: null,
  showToast: (message) => set(state => ({ toast: { id: (state.toast?.id ?? 0) + 1, message } })),

  // Any document mutation flows through setFile → mark the active tab dirty and keep its
  // displayed filename in sync. Navigation (tab switch / new / open) sets `file` directly
  // via the tab actions below, so it never trips the dirty flag.
  setFile: (file) =>
    set((state) => ({
      file,
      tabs: state.tabs.map(t =>
        t.id === state.activeTabId
          ? { ...t, isDirty: true, filename: file.name || t.filename }
          : t),
    })),

  setSelectedIds: (ids) => set({ selectedIds: new Set(ids) }),

  toggleSelected: (id, multi) =>
    set((state) => {
      if (!multi) return { selectedIds: new Set([id]) };
      const next = new Set(state.selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedIds: next };
    }),

  clearSelection: () => set({ selectedIds: new Set(), groupEditId: null, vectorEditShapeId: null, vectorEditChildId: null, pathEditShapeId: null, editingPoints: [], selectedPointIndices: [], svgEditShapeId: null, svgEditingPaths: [], svgSelectedPoints: [], livePreviewSvg: null }),
  setActiveTool: (tool) => set({ activeTool: tool }),
  setRightMode: (mode) => set({ rightMode: mode }),
  setExportOpen: (open) => set({ exportOpen: open }),
  setEditingTextId: (id) => set({ editingTextId: id }),
  setGroupEditId: (id) => set({ groupEditId: id }),
  setVectorEditShapeId: (id) => set({ vectorEditShapeId: id }),
  setVectorEditChildId: (id) => set({ vectorEditChildId: id }),
  setPathEditShapeId: (id) => set({ pathEditShapeId: id }),
  setEditingPoints: (pts) => set({ editingPoints: pts }),
  setSelectedPointIndices: (idxs) => set({ selectedPointIndices: idxs }),
  setSvgEditShapeId: (id) => set({ svgEditShapeId: id }),
  setSvgEditingPaths: (paths) => set({ svgEditingPaths: paths }),
  setSvgSelectedPoints: (pts) => set({ svgSelectedPoints: pts }),
  setLivePreviewSvg: (svg) => set({ livePreviewSvg: svg }),
  setPenSegments: (segs) => set({ penSegments: segs }),
  setPenCurrentDoc: (pt) => set({ penCurrentDoc: pt }),
  setPenContinueShapeId: (id) => set({ penContinueShapeId: id }),
  setPenContinueIsFirst: (b) => set({ penContinueIsFirst: b }),

  // ── Tab actions ─────────────────────────────────────────────────────────────

  // Bootstrap: the already-loaded launch document becomes the first tab.
  initFirstTab: (file) =>
    set(() => {
      const id = genTabId();
      return {
        file,
        tabs: [{ id, filename: file.name || 'Untitled', isDirty: false, session: null, selectedIds: [], savedFilePath: null }],
        activeTabId: id,
        selectedIds: new Set<string>(),
        guidesPerPage: file.guidesPerPage ?? {},
      };
    }),

  // New tab with a fresh untitled canvas; becomes active. Does not touch other tabs.
  openNewTab: async () => {
    const state = get();
    const stashed = stashActive(state);          // park the current active session
    await api.newFile();                          // fresh empty document in the engine
    const name = uniqueUntitledName(state.tabs);
    const renamed = await api.renameFile(name);
    const file = (renamed?.ok ? renamed.data : null) ?? (await api.getState()).data ?? null;
    const id = genTabId();
    set({
      file,
      tabs: [...stashed, { id, filename: name, isDirty: false, session: null, selectedIds: [], savedFilePath: null }],
      activeTabId: id,
      selectedIds: new Set<string>(),
      editingTextId: null,
      groupEditId: null,
      vectorEditShapeId: null,
      vectorEditChildId: null,
      pathEditShapeId: null,
      editingPoints: [],
      selectedPointIndices: [],
      svgEditShapeId: null,
      svgEditingPaths: [],
      svgSelectedPoints: [],
      livePreviewSvg: null,
      guidesPerPage: {},
    });
  },

  // Open an already-parsed document in a new tab; becomes active.
  openFileInNewTab: async (file) => {
    const state = get();
    const stashed = stashActive(state);
    const r = await api.loadFile(file);
    const loaded = (r?.ok ? r.data : null) ?? file;
    const id = genTabId();
    set({
      file: loaded,
      tabs: [...stashed, { id, filename: loaded.name || 'Untitled', isDirty: false, session: null, selectedIds: [], savedFilePath: null }],
      activeTabId: id,
      selectedIds: new Set<string>(),
      editingTextId: null,
      groupEditId: null,
      vectorEditShapeId: null,
      vectorEditChildId: null,
      pathEditShapeId: null,
      editingPoints: [],
      selectedPointIndices: [],
      svgEditShapeId: null,
      svgEditingPaths: [],
      svgSelectedPoints: [],
      livePreviewSvg: null,
      guidesPerPage: loaded.guidesPerPage ?? {},
    });
  },

  setActiveTab: (id) => {
    const state = get();
    if (id === state.activeTabId) return;
    const target = state.tabs.find(t => t.id === id);
    if (!target) return;
    // Park the outgoing tab, swap the incoming session into the engine.
    const stashed = stashActive(state);
    const loaded = target.session ? api.loadSession(target.session) : state.file;
    const loadedFile = loaded ?? state.file;
    set({
      file: loadedFile,
      tabs: stashed,
      activeTabId: id,
      selectedIds: new Set(target.selectedIds),
      editingTextId: null,
      groupEditId: null,
      vectorEditShapeId: null,
      vectorEditChildId: null,
      pathEditShapeId: null,
      editingPoints: [],
      selectedPointIndices: [],
      svgEditShapeId: null,
      svgEditingPaths: [],
      svgSelectedPoints: [],
      livePreviewSvg: null,
      guidesPerPage: loadedFile?.guidesPerPage ?? {},
    });
  },

  // Decide whether closing needs the unsaved-changes modal first.
  requestCloseTab: (id) => {
    const tab = get().tabs.find(t => t.id === id);
    if (!tab) return;
    if (tab.isDirty) set({ pendingCloseTabId: id });
    else void get().closeTab(id);
  },

  closeTab: async (id) => {
    const state = get();
    const idx = state.tabs.findIndex(t => t.id === id);
    if (idx === -1) { set({ pendingCloseTabId: null }); return; }
    const remaining = state.tabs.filter(t => t.id !== id);
    const wasActive = state.activeTabId === id;

    if (!wasActive) {
      // Closing a background tab — drop it, leave the active document alone.
      set({ tabs: remaining, pendingCloseTabId: null });
      return;
    }

    if (remaining.length === 0) {
      // Last tab closed → auto-create a fresh untitled tab.
      await api.newFile();
      const renamed = await api.renameFile('Untitled');
      const file = (renamed?.ok ? renamed.data : null) ?? (await api.getState()).data ?? null;
      const newId = genTabId();
      set({
        file,
        tabs: [{ id: newId, filename: 'Untitled', isDirty: false, session: null, selectedIds: [], savedFilePath: null }],
        activeTabId: newId,
        selectedIds: new Set<string>(),
        pendingCloseTabId: null,
        editingTextId: null,
        groupEditId: null,
        vectorEditShapeId: null,
        vectorEditChildId: null,
        pathEditShapeId: null,
        editingPoints: [],
        selectedPointIndices: [],
        svgEditShapeId: null,
        svgEditingPaths: [],
        svgSelectedPoints: [],
        guidesPerPage: {},
      });
      return;
    }

    // Activate the nearest remaining tab (prefer the one to the right).
    const neighbor = state.tabs[idx + 1] ?? state.tabs[idx - 1];
    const next = remaining.find(t => t.id === neighbor.id) ?? remaining[0];
    const loaded = next.session ? api.loadSession(next.session) : state.file;
    const nextFile = loaded ?? state.file;
    set({
      file: nextFile,
      tabs: remaining,
      activeTabId: next.id,
      selectedIds: new Set(next.selectedIds),
      pendingCloseTabId: null,
      editingTextId: null,
      groupEditId: null,
      vectorEditShapeId: null,
      vectorEditChildId: null,
      pathEditShapeId: null,
      editingPoints: [],
      selectedPointIndices: [],
      svgEditShapeId: null,
      svgEditingPaths: [],
      svgSelectedPoints: [],
      livePreviewSvg: null,
      guidesPerPage: nextFile?.guidesPerPage ?? {},
    });
  },

  setDirty: (id, dirty) =>
    set((state) => ({
      tabs: state.tabs.map(t => (t.id === id ? { ...t, isDirty: dirty } : t)),
    })),

  setTabFilePath: (id, path) =>
    set((state) => ({
      tabs: state.tabs.map(t => (t.id === id ? { ...t, savedFilePath: path } : t)),
    })),

  saveTab: async (id) => {
    const state = get();
    const tab = state.tabs.find(t => t.id === id);
    if (!tab) return { saved: false, firstSave: false };
    // The active tab's live document is store.file; an inactive tab's is its parked session.
    const file = id === state.activeTabId ? state.file : tab.session?.file ?? null;
    if (!file) return { saved: false, firstSave: false };

    const res = await persistFile({
      content: serializeFile(file),
      filename: tab.filename,
      fileId: file.id,
    });
    if (!res.saved) {
      if (res.unsupported) get().showToast('Saving needs the desktop app or a Chromium browser');
      return { saved: false, firstSave: res.firstSave };
    }

    set((s) => ({
      tabs: s.tabs.map(t =>
        t.id === id ? { ...t, savedFilePath: res.targetLabel ?? t.savedFilePath, isDirty: false } : t),
    }));
    return { saved: true, firstSave: res.firstSave };
  },

  activePage: () => {
    const { file } = get();
    if (!file) return null;
    return file.pages.find(p => p.id === file.activePageId) ?? null;
  },
}));

// Capture the engine's current session into the active tab so it can be restored later.
// Returns the new tabs array (active tab's session + selection updated).
function stashActive(state: DesignStore): Tab[] {
  if (!state.activeTabId) return state.tabs;
  const session = api.exportSession();
  return state.tabs.map(t =>
    t.id === state.activeTabId
      ? { ...t, session, selectedIds: [...state.selectedIds] }
      : t);
}
