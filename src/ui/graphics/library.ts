import { create } from 'zustand';
import type { GraphicDocument, GraphicLayer } from '../../types/project';
import { uid } from '../../engine/util';
import type { GraphicTemplate } from './templates';

/*
  Motion graphics library: user-saved templates.

  Any graphic on the timeline can be snapshotted into the library (Graphics >
  Save Graphic as Template). Entries persist to localStorage with their design
  resolution; when applied to a sequence of a different size the layers are
  proportionally scaled so text and shapes land where the designer put them.
*/

const STORAGE_KEY = 'vsp.graphics.library.v1';

export interface LibraryEntry {
  id: string;
  name: string;
  category: GraphicTemplate['category'];
  description: string;
  designWidth: number;
  designHeight: number;
  doc: GraphicDocument;
  createdAt: number;
}

interface LibraryStore {
  entries: LibraryEntry[];
  save: (name: string, category: LibraryEntry['category'], doc: GraphicDocument, designWidth: number, designHeight: number, description?: string) => LibraryEntry;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  replaceAll: (entries: LibraryEntry[]) => void;
}

function load(): LibraryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e) => e && e.doc && Array.isArray(e.doc.layers)) : [];
  } catch {
    return [];
  }
}

function persist(entries: LibraryEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* quota — library stays for this session */
  }
}

export const useGraphicsLibrary = create<LibraryStore>((set, get) => ({
  entries: load(),
  save: (name, category, doc, designWidth, designHeight, description) => {
    const entry: LibraryEntry = {
      id: uid('gtpl'),
      name: name.trim() || 'Untitled Template',
      category,
      description: description ?? 'Saved from the timeline.',
      designWidth,
      designHeight,
      doc: JSON.parse(JSON.stringify(doc)),
      createdAt: Date.now(),
    };
    const entries = [...get().entries, entry];
    set({ entries });
    persist(entries);
    return entry;
  },
  remove: (id) => {
    const entries = get().entries.filter((e) => e.id !== id);
    set({ entries });
    persist(entries);
  },
  rename: (id, name) => {
    const entries = get().entries.map((e) => (e.id === id ? { ...e, name } : e));
    set({ entries });
    persist(entries);
  },
  replaceAll: (entries) => {
    set({ entries });
    persist(entries);
  },
}));

function scaleParam(p: any, s: number): any {
  if (p == null || typeof p !== 'object') return p;
  const out = { ...p };
  if (typeof out.value === 'number') out.value = out.value * s;
  else if (Array.isArray(out.value)) out.value = out.value.map((v: number) => v * s);
  if (Array.isArray(out.keyframes)) out.keyframes = out.keyframes.map((k: any) => ({ ...k, v: typeof k.v === 'number' ? k.v * s : Array.isArray(k.v) ? k.v.map((v: number) => v * s) : k.v }));
  return out;
}

/** Scale a saved document from its design size to a target frame size. */
export function scaleLibraryDoc(entry: LibraryEntry, targetW: number, targetH: number): GraphicDocument {
  const sx = targetW / Math.max(1, entry.designWidth);
  const sy = targetH / Math.max(1, entry.designHeight);
  const s = Math.min(sx, sy);
  const layers: GraphicLayer[] = entry.doc.layers.map((l) => {
    const c = JSON.parse(JSON.stringify(l));
    c.id = uid('gl');
    c.x = scaleParam(c.x, sx);
    c.y = scaleParam(c.y, sy);
    c.scale = scaleParam(c.scale, 1);
    if (typeof c.fontSize === 'number') c.fontSize = Math.round(c.fontSize * s);
    if (typeof c.width === 'number') c.width *= sx;
    if (typeof c.height === 'number') c.height *= sy;
    if (typeof c.x2 === 'number') c.x2 *= sx;
    if (typeof c.y2 === 'number') c.y2 *= sy;
    if (typeof c.radius === 'number') c.radius *= s;
    if (typeof c.strokeWidth === 'number') c.strokeWidth *= s;
    if (typeof c.tracking === 'number') c.tracking *= s;
    if (typeof c.boxWidth === 'number' && c.boxWidth) c.boxWidth *= sx;
    if (typeof c.boxHeight === 'number' && c.boxHeight) c.boxHeight *= sy;
    if (c.background && typeof c.background.padding === 'number') c.background.padding *= s;
    if (c.background && typeof c.background.radius === 'number') c.background.radius *= s;
    if (typeof c.shadowBlur === 'number') c.shadowBlur *= s;
    if (typeof c.shadowOffsetX === 'number') c.shadowOffsetX *= s;
    if (typeof c.shadowOffsetY === 'number') c.shadowOffsetY *= s;
    return c;
  });
  return { layers, introProtect: entry.doc.introProtect, outroProtect: entry.doc.outroProtect, templateId: entry.id };
}

/** Present library entries through the same GraphicTemplate shape as built-ins. */
export function libraryEntryAsTemplate(entry: LibraryEntry): GraphicTemplate {
  return {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    description: entry.description,
    build: (w, h) => scaleLibraryDoc(entry, w, h),
  };
}

export function exportLibraryFile(): { app: string; kind: string; version: number; entries: LibraryEntry[] } {
  return { app: 'vanguard-studio-pro', kind: 'graphics-library', version: 1, entries: useGraphicsLibrary.getState().entries };
}

export function importLibraryFile(data: any): number {
  const list = Array.isArray(data?.entries) ? data.entries : [];
  const valid = list.filter((e: any) => e && e.doc && Array.isArray(e.doc.layers));
  if (!valid.length) return 0;
  const stamped = valid.map((e: any) => ({ ...e, id: uid('gtpl'), createdAt: Date.now() }));
  const merged = [...useGraphicsLibrary.getState().entries, ...stamped];
  useGraphicsLibrary.getState().replaceAll(merged);
  return stamped.length;
}
