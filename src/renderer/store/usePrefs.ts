import { create } from 'zustand';

export interface Preferences {
  autosaveInterval: number; // ms
  snapToGrid: boolean;
  gridSize: number;
  showGrid: boolean;
  theme: 'dark' | 'light';
  showRulers: boolean;
  showGuides: boolean;
  snapToGuides: boolean;
  leftPanelCollapsed: boolean;
}

const PREFS_KEY = 'edit-prefs';

const DEFAULTS: Preferences = {
  autosaveInterval: 2000,
  snapToGrid: false,
  gridSize: 8,
  showGrid: false,
  theme: 'dark',
  showRulers: true,
  showGuides: true,
  snapToGuides: true,
  leftPanelCollapsed: false,
};

function load(): Preferences {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

interface PrefsStore extends Preferences {
  prefsOpen: boolean;
  set: (patch: Partial<Preferences>) => void;
  setPrefsOpen: (open: boolean) => void;
}

export const usePrefs = create<PrefsStore>((set) => ({
  ...load(),
  prefsOpen: false,
  set: (patch) =>
    set((state) => {
      const next = { ...state, ...patch };
      const { prefsOpen, set: _s, setPrefsOpen: _o, ...prefs } = next;
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      return next;
    }),
  setPrefsOpen: (open) => set({ prefsOpen: open }),
}));
