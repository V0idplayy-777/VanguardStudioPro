import { create } from 'zustand';

/*
  Custom keyboard shortcut remapping.

  SHORTCUTS (src/app/shortcuts.ts) holds the factory defaults. This store keeps
  only user overrides: `overrides[id] = keys` rebinds a command, and `removed`
  holds commands the user unassigned. Everything persists to localStorage under
  'vsp.shortcuts.v1' and can be exported / imported as JSON.
*/

const STORAGE_KEY = 'vsp.shortcuts.v1';

export interface ShortcutPresetFile {
  app: 'vanguard-studio-pro';
  kind: 'shortcuts';
  version: 1;
  overrides: Record<string, string>;
  removed: string[];
}

interface ShortcutStore {
  overrides: Record<string, string>;
  removed: string[];
  /** Rebind a command, or pass null to unassign it. */
  setBinding: (id: string, keys: string | null) => void;
  resetBinding: (id: string) => void;
  resetAll: () => void;
  importPreset: (file: ShortcutPresetFile) => void;
  exportPreset: () => ShortcutPresetFile;
}

function load(): { overrides: Record<string, string>; removed: string[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { overrides: {}, removed: [] };
    const parsed = JSON.parse(raw);
    return {
      overrides: typeof parsed.overrides === 'object' && parsed.overrides ? parsed.overrides : {},
      removed: Array.isArray(parsed.removed) ? parsed.removed.filter((x: unknown) => typeof x === 'string') : [],
    };
  } catch {
    return { overrides: {}, removed: [] };
  }
}

function persist(overrides: Record<string, string>, removed: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ overrides, removed }));
  } catch {
    /* ignore */
  }
}

export const useShortcutStore = create<ShortcutStore>((set, get) => ({
  ...load(),
  setBinding: (id, keys) => {
    const overrides = { ...get().overrides };
    let removed = get().removed.filter((r) => r !== id);
    if (keys == null || keys === '') {
      delete overrides[id];
      if (!removed.includes(id)) removed = [...removed, id];
    } else {
      overrides[id] = keys;
    }
    set({ overrides, removed });
    persist(overrides, removed);
  },
  resetBinding: (id) => {
    const overrides = { ...get().overrides };
    delete overrides[id];
    const removed = get().removed.filter((r) => r !== id);
    set({ overrides, removed });
    persist(overrides, removed);
  },
  resetAll: () => {
    set({ overrides: {}, removed: [] });
    persist({}, []);
  },
  importPreset: (file) => {
    const overrides: Record<string, string> = {};
    for (const [k, v] of Object.entries(file.overrides ?? {})) if (typeof v === 'string' && v) overrides[k] = v;
    const removed = (file.removed ?? []).filter((x) => typeof x === 'string');
    set({ overrides, removed });
    persist(overrides, removed);
  },
  exportPreset: () => ({ app: 'vanguard-studio-pro', kind: 'shortcuts', version: 1, overrides: { ...get().overrides }, removed: [...get().removed] }),
}));

/** Non-hook accessor for the dispatch hot path. */
export function shortcutOverrides() {
  return useShortcutStore.getState();
}
