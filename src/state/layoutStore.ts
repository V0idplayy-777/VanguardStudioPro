import { create } from 'zustand';
import type { PanelId, WorkspaceId } from './uiStore';
import { uid } from '../engine/util';

export type SplitDir = 'row' | 'col';

export type LayoutNode = { kind: 'split'; id: string; dir: SplitDir; children: LayoutNode[]; sizes: number[] } | { kind: 'group'; id: string; tabs: PanelId[]; active: PanelId };

export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom';

const g = (tabs: PanelId[], active?: PanelId): LayoutNode => ({ kind: 'group', id: uid('g'), tabs, active: active ?? tabs[0] });
const split = (dir: SplitDir, children: LayoutNode[], sizes?: number[]): LayoutNode => ({ kind: 'split', id: uid('s'), dir, children, sizes: sizes ?? children.map(() => 1 / children.length) });

export function presetLayout(ws: WorkspaceId): LayoutNode {
  switch (ws) {
    case 'assembly':
      return split('row', [split('col', [g(['project', 'mediaBrowser', 'libraries']), g(['effects', 'markers', 'history', 'info'])], [0.62, 0.38]), split('col', [g(['program', 'source']), g(['timeline'])], [0.55, 0.45])], [0.32, 0.68]);
    case 'color':
      return split('row', [split('col', [g(['scopes']), g(['project', 'effects'])], [0.58, 0.42]), split('col', [g(['program', 'source']), g(['timeline'])], [0.55, 0.45]), g(['lumetri', 'effectControls'])], [0.24, 0.5, 0.26]);
    case 'effects':
      return split('row', [split('col', [g(['effectControls', 'source', 'lumetri']), g(['project', 'markers', 'history'])], [0.55, 0.45]), split('col', [g(['program']), g(['timeline'])], [0.55, 0.45]), g(['effects', 'info', 'events'])], [0.3, 0.5, 0.2]);
    case 'audio':
      return split('row', [split('col', [g(['audioClipMixer', 'effectControls', 'source']), g(['project', 'effects'])], [0.5, 0.5]), split('col', [g(['audioMixer', 'program']), g(['timeline'])], [0.5, 0.5]), split('col', [g(['audioMeters']), g(['loudness', 'essentialGraphics'])], [0.6, 0.4])], [0.26, 0.6, 0.14]);
    case 'graphics':
      return split('row', [split('col', [g(['effectControls', 'source', 'project']), g(['effects', 'history'])], [0.55, 0.45]), split('col', [g(['program']), g(['timeline'])], [0.55, 0.45]), g(['essentialGraphics', 'captions'])], [0.26, 0.5, 0.24]);
    case 'captions':
      return split('row', [split('col', [g(['captions']), g(['project', 'effects'])], [0.6, 0.4]), split('col', [g(['program', 'source']), g(['timeline'])], [0.55, 0.45]), g(['essentialGraphics', 'effectControls'])], [0.3, 0.48, 0.22]);
    case 'review':
      return split('row', [split('col', [g(['markers', 'info']), g(['project', 'history'])], [0.5, 0.5]), split('col', [g(['program']), g(['timeline'])], [0.62, 0.38])], [0.24, 0.76]);
    case 'export':
      return split('row', [g(['export']), split('col', [g(['program']), g(['timeline', 'events'])], [0.6, 0.4])], [0.42, 0.58]);
    case 'editing':
    case 'custom':
    default:
      return split('row', [split('col', [g(['source', 'effectControls', 'audioClipMixer', 'metadata']), g(['project', 'mediaBrowser', 'effects', 'markers', 'history', 'info', 'events'])], [0.56, 0.44]), split('col', [g(['program']), g(['timeline'])], [0.56, 0.44]), g(['audioMeters'])], [0.29, 0.66, 0.05]);
  }
}

const STORAGE_KEY = 'vsp.layouts.v3';

function loadSaved(): Partial<Record<WorkspaceId, LayoutNode>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<WorkspaceId, LayoutNode>>) : {};
  } catch {
    return {};
  }
}

interface LayoutState {
  layouts: Partial<Record<WorkspaceId, LayoutNode>>;
  /** Floating panels are rendered as dialogs above the dock. */
  floating: { id: string; panel: PanelId; x: number; y: number; w: number; h: number }[];
  get: (ws: WorkspaceId) => LayoutNode;
  set: (ws: WorkspaceId, node: LayoutNode) => void;
  reset: (ws: WorkspaceId) => void;
  resetAll: () => void;
  setActive: (ws: WorkspaceId, groupId: string, panel: PanelId) => void;
  resize: (ws: WorkspaceId, splitId: string, index: number, sizes: number[]) => void;
  moveTab: (ws: WorkspaceId, panel: PanelId, targetGroupId: string, zone: DropZone, index?: number) => void;
  closeTab: (ws: WorkspaceId, panel: PanelId) => void;
  openPanel: (ws: WorkspaceId, panel: PanelId) => void;
  float: (ws: WorkspaceId, panel: PanelId) => void;
  unfloat: (ws: WorkspaceId, id: string) => void;
  moveFloat: (id: string, patch: Partial<{ x: number; y: number; w: number; h: number }>) => void;
}

function persist(layouts: Partial<Record<WorkspaceId, LayoutNode>>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layouts));
  } catch {
    /* ignore */
  }
}

/* ---------- tree helpers (pure) ---------- */

export function findGroup(node: LayoutNode, panel: PanelId): LayoutNode | null {
  if (node.kind === 'group') return node.tabs.includes(panel) ? node : null;
  for (const c of node.children) {
    const f = findGroup(c, panel);
    if (f) return f;
  }
  return null;
}

export function findNode(node: LayoutNode, id: string): LayoutNode | null {
  if (node.id === id) return node;
  if (node.kind === 'split') for (const c of node.children) {
    const f = findNode(c, id);
    if (f) return f;
  }
  return null;
}

export function allPanels(node: LayoutNode, out: PanelId[] = []): PanelId[] {
  if (node.kind === 'group') out.push(...node.tabs);
  else node.children.forEach((c) => allPanels(c, out));
  return out;
}

export function allGroups(node: LayoutNode, out: LayoutNode[] = []): LayoutNode[] {
  if (node.kind === 'group') out.push(node);
  else node.children.forEach((c) => allGroups(c, out));
  return out;
}

function clone(n: LayoutNode): LayoutNode {
  return JSON.parse(JSON.stringify(n));
}

/** Remove a tab; collapse empty groups and single-child splits. */
function removeTab(node: LayoutNode, panel: PanelId): LayoutNode | null {
  if (node.kind === 'group') {
    if (!node.tabs.includes(panel)) return node;
    const tabs = node.tabs.filter((t) => t !== panel);
    if (!tabs.length) return null;
    return { ...node, tabs, active: tabs.includes(node.active) ? node.active : tabs[0] };
  }
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const r = removeTab(c, panel);
    if (r) {
      children.push(r);
      sizes.push(node.sizes[i]);
    }
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0);
  return { ...node, children, sizes: sizes.map((s) => s / total) };
}

function insertRelative(node: LayoutNode, targetGroupId: string, panel: PanelId, zone: DropZone, index?: number): LayoutNode {
  if (node.kind === 'group') {
    if (node.id !== targetGroupId) return node;
    if (zone === 'center') {
      const tabs = node.tabs.slice();
      const at = index == null ? tabs.length : Math.min(index, tabs.length);
      tabs.splice(at, 0, panel);
      return { ...node, tabs, active: panel };
    }
    const newGroup: LayoutNode = { kind: 'group', id: uid('g'), tabs: [panel], active: panel };
    const dir: SplitDir = zone === 'left' || zone === 'right' ? 'row' : 'col';
    const first = zone === 'left' || zone === 'top';
    return { kind: 'split', id: uid('s'), dir, children: first ? [newGroup, node] : [node, newGroup], sizes: [0.5, 0.5] };
  }
  // Merge into parent split when directions match to avoid deep nesting
  const children = node.children.map((c) => insertRelative(c, targetGroupId, panel, zone, index));
  const flat: LayoutNode[] = [];
  const sizes: number[] = [];
  children.forEach((c, i) => {
    if (c.kind === 'split' && c.dir === node.dir && node.children[i] !== c) {
      // newly created split with same direction: splice in
      const share = node.sizes[i];
      c.children.forEach((cc, j) => {
        flat.push(cc);
        sizes.push(share * c.sizes[j]);
      });
    } else {
      flat.push(c);
      sizes.push(node.sizes[i]);
    }
  });
  return { ...node, children: flat, sizes };
}

/** Preferred home group for a panel being opened from the Window menu. */
const PANEL_HOME: Partial<Record<PanelId, PanelId[]>> = {
  effects: ['project', 'effectControls'],
  effectControls: ['source', 'effects'],
  lumetri: ['effectControls', 'effects'],
  scopes: ['source', 'project'],
  essentialGraphics: ['effectControls', 'effects'],
  captions: ['project', 'effectControls'],
  markers: ['project'],
  history: ['project'],
  info: ['project'],
  metadata: ['source', 'project'],
  events: ['project'],
  audioMixer: ['program', 'source'],
  audioClipMixer: ['source', 'effectControls'],
  audioMeters: ['program'],
  loudness: ['audioMeters', 'project'],
  libraries: ['project'],
  mediaBrowser: ['project'],
  learn: ['effectControls', 'project'],
  tools: ['project'],
  export: ['source', 'project'],
  source: ['effectControls', 'project'],
  program: ['source'],
  timeline: ['program'],
  project: ['effects', 'source'],
};

const presetCache = new Map<WorkspaceId, LayoutNode>();

export const useLayout = create<LayoutState>((set, get) => ({
  layouts: loadSaved(),
  floating: [],
  get: (ws) => {
    // Pure: never writes to the store (it is called during render). Presets are cached so the
    // same object identity comes back until the workspace is actually modified.
    const l = get().layouts[ws];
    if (l) return l;
    let p = presetCache.get(ws);
    if (!p) {
      p = presetLayout(ws);
      presetCache.set(ws, p);
    }
    return p;
  },
  set: (ws, node) => {
    const layouts = { ...get().layouts, [ws]: node };
    set({ layouts });
    persist(layouts);
  },
  reset: (ws) => {
    const layouts = { ...get().layouts, [ws]: presetLayout(ws) };
    set({ layouts });
    persist(layouts);
  },
  resetAll: () => {
    set({ layouts: {}, floating: [] });
    persist({});
  },
  setActive: (ws, groupId, panel) => {
    const root = clone(get().get(ws));
    const grp = findNode(root, groupId);
    if (grp && grp.kind === 'group' && grp.tabs.includes(panel)) {
      grp.active = panel;
      get().set(ws, root);
    }
  },
  resize: (ws, splitId, _index, sizes) => {
    const root = clone(get().get(ws));
    const s = findNode(root, splitId);
    if (s && s.kind === 'split') {
      s.sizes = sizes;
      get().set(ws, root);
    }
  },
  moveTab: (ws, panel, targetGroupId, zone, index) => {
    const root = get().get(ws);
    const target = findNode(root, targetGroupId);
    if (!target || target.kind !== 'group') return;
    if (zone === 'center' && target.tabs.includes(panel) && target.tabs.length === 1) return;
    if (zone !== 'center' && target.tabs.length === 1 && target.tabs[0] === panel) return;
    let next = removeTab(clone(root), panel);
    if (!next) next = { kind: 'group', id: uid('g'), tabs: [panel], active: panel };
    // target may have been removed if it only contained this panel
    if (!findNode(next, targetGroupId)) {
      get().set(ws, next);
      return;
    }
    next = insertRelative(next, targetGroupId, panel, zone, index);
    get().set(ws, next);
  },
  closeTab: (ws, panel) => {
    const root = get().get(ws);
    const next = removeTab(clone(root), panel);
    get().set(ws, next ?? { kind: 'group', id: uid('g'), tabs: ['project'], active: 'project' });
  },
  openPanel: (ws, panel) => {
    const root = get().get(ws);
    const fl = get().floating.find((f) => f.panel === panel);
    if (fl) return;
    const existing = findGroup(root, panel);
    if (existing) {
      get().setActive(ws, existing.id, panel);
      return;
    }
    const homes = PANEL_HOME[panel] ?? ['project'];
    let target: LayoutNode | null = null;
    for (const h of homes) {
      target = findGroup(root, h);
      if (target) break;
    }
    if (!target) target = allGroups(root)[0];
    if (!target) return;
    get().set(ws, insertRelative(clone(root), target.id, panel, 'center'));
  },
  float: (ws, panel) => {
    const root = get().get(ws);
    const next = removeTab(clone(root), panel);
    get().set(ws, next ?? { kind: 'group', id: uid('g'), tabs: ['project'], active: 'project' });
    const n = get().floating.length;
    set({ floating: [...get().floating, { id: uid('f'), panel, x: 120 + n * 30, y: 80 + n * 30, w: 560, h: 420 }] });
  },
  unfloat: (ws, id) => {
    const f = get().floating.find((x) => x.id === id);
    if (!f) return;
    set({ floating: get().floating.filter((x) => x.id !== id) });
    get().openPanel(ws, f.panel);
  },
  moveFloat: (id, patch) => set({ floating: get().floating.map((f) => (f.id === id ? { ...f, ...patch } : f)) }),
}));

export const PANEL_TITLES: Record<PanelId, string> = {
  project: 'Project',
  source: 'Source',
  program: 'Program',
  timeline: 'Timeline',
  effects: 'Effects',
  effectControls: 'Effect Controls',
  audioMeters: 'Audio Meters',
  audioMixer: 'Audio Track Mixer',
  audioClipMixer: 'Audio Clip Mixer',
  lumetri: 'Lumetri Color',
  scopes: 'Lumetri Scopes',
  essentialGraphics: 'Essential Graphics',
  captions: 'Captions',
  markers: 'Markers',
  history: 'History',
  info: 'Info',
  metadata: 'Metadata',
  export: 'Export',
  libraries: 'Presets Library',
  events: 'Events',
  tools: 'Tools',
  loudness: 'Loudness',
  mediaBrowser: 'Media Browser',
  learn: 'Learn',
};
