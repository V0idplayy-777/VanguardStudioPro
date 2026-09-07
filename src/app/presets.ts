import type { Param } from '../types/project';

/** Effect presets saved by the user. Persisted in localStorage; small and plain JSON. */
export interface UserPreset {
  id: string;
  name: string;
  /** Human readable effect type list. */
  effectType: string;
  effects: { type: string; params: Record<string, Param> }[];
}

const KEY = 'vsp.presets.v1';

class PresetStore {
  private items: UserPreset[] = [];
  private listeners = new Set<() => void>();
  constructor() {
    try {
      this.items = JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch {
      this.items = [];
    }
  }
  get() {
    return this.items;
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private commit(next: UserPreset[]) {
    this.items = next;
    localStorage.setItem(KEY, JSON.stringify(next));
    this.listeners.forEach((l) => l());
  }
  add(p: UserPreset) {
    this.commit([...this.items, p]);
  }
  remove(id: string) {
    this.commit(this.items.filter((p) => p.id !== id));
  }
  byId(id: string) {
    return this.items.find((p) => p.id === id);
  }
}

export const userPresets = new PresetStore();
