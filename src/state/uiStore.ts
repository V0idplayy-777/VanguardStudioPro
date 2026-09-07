import { create } from 'zustand';
import type { Id } from '../types/project';
import type { TimecodeMode } from '../engine/timecode';

export type ToolId = 'select' | 'trackSelectFwd' | 'trackSelectBack' | 'ripple' | 'rolling' | 'rateStretch' | 'razor' | 'slip' | 'slide' | 'pen' | 'hand' | 'zoom' | 'remap';

export type PanelId =
  | 'project'
  | 'source'
  | 'program'
  | 'timeline'
  | 'effects'
  | 'effectControls'
  | 'audioMeters'
  | 'audioMixer'
  | 'audioClipMixer'
  | 'lumetri'
  | 'scopes'
  | 'essentialGraphics'
  | 'captions'
  | 'markers'
  | 'history'
  | 'info'
  | 'metadata'
  | 'export'
  | 'libraries'
  | 'events'
  | 'tools'
  | 'loudness'
  | 'mediaBrowser'
  | 'learn';

export type WorkspaceId = 'editing' | 'assembly' | 'color' | 'effects' | 'audio' | 'graphics' | 'captions' | 'review' | 'export' | 'custom';

export interface Selection {
  clipIds: Id[];
  /** Selected transitions as clipId:in|out. */
  transitionIds: string[];
  trackIds: Id[];
  markerIds: Id[];
  keyframes: { clipId: Id; path: string; t: number }[];
  captionIds: Id[];
  effectId: Id | null;
  graphicLayerIds: Id[];
}

export interface Toast {
  id: string;
  kind: 'info' | 'warning' | 'error' | 'success';
  title: string;
  message?: string;
  at: number;
  sticky?: boolean;
  progress?: number;
}

export interface EventLogEntry {
  id: string;
  kind: 'info' | 'warning' | 'error';
  message: string;
  at: number;
  detail?: string;
}

export interface ModalRequest {
  kind:
    | 'newSequence'
    | 'sequenceSettings'
    | 'export'
    | 'keyboardShortcuts'
    | 'preferences'
    | 'about'
    | 'projectSettings'
    | 'newBin'
    | 'rename'
    | 'audioGain'
    | 'speedDuration'
    | 'newItem'
    | 'colorMatte'
    | 'markerEdit'
    | 'captionsImport'
    | 'nest'
    | 'confirm'
    | 'linkMedia'
    | 'projectManager'
    | 'sceneDetect'
    | 'autoDucking'
    | 'interpretFootage'
    | 'labelPicker'
    | 'generateCountdown'
    | 'workspaceManager'
    | 'timeRemap'
    | 'welcome'
    | 'easter';
  payload?: any;
}

export type ProgramOverlay = 'none' | 'safeMargins' | 'grid' | 'rulers';

interface UIState {
  tool: ToolId;
  setTool: (t: ToolId) => void;
  selection: Selection;
  setSelection: (s: Partial<Selection>) => void;
  clearSelection: () => void;
  selectClips: (ids: Id[], additive?: boolean) => void;
  toggleClip: (id: Id) => void;

  workspace: WorkspaceId;
  setWorkspace: (w: WorkspaceId) => void;
  focusedPanel: PanelId | null;
  setFocusedPanel: (p: PanelId | null) => void;
  maximizedPanel: PanelId | null;
  setMaximizedPanel: (p: PanelId | null) => void;

  timecodeMode: TimecodeMode;
  setTimecodeMode: (m: TimecodeMode) => void;
  snapping: boolean;
  setSnapping: (b: boolean) => void;
  linkedSelection: boolean;
  setLinkedSelection: (b: boolean) => void;
  rippleDelete: boolean;
  showAudioWaveforms: boolean;
  showVideoThumbnails: boolean;
  showClipNames: boolean;
  showThroughEdits: boolean;
  showDuplicateFrames: boolean;
  setTimelineDisplay: (p: Partial<Pick<UIState, 'showAudioWaveforms' | 'showVideoThumbnails' | 'showClipNames' | 'showThroughEdits' | 'showDuplicateFrames'>>) => void;

  programQuality: 'full' | 'half' | 'quarter';
  setProgramQuality: (q: 'full' | 'half' | 'quarter') => void;
  programZoom: number | 'fit';
  setProgramZoom: (z: number | 'fit') => void;
  programOverlay: ProgramOverlay[];
  toggleProgramOverlay: (o: ProgramOverlay) => void;
  programChannel: 'rgb' | 'alpha' | 'r' | 'g' | 'b' | 'luma';
  setProgramChannel: (c: UIState['programChannel']) => void;
  transparencyGrid: boolean;
  setTransparencyGrid: (b: boolean) => void;
  showKeyframeEditor: boolean;
  setShowKeyframeEditor: (b: boolean) => void;

  /** Source monitor state. */
  sourceAssetId: Id | null;
  setSourceAssetId: (id: Id | null) => void;
  sourceTime: number;
  setSourceTime: (t: number) => void;
  /** Most recently opened source clips (asset ids, newest first). */
  recentSources: Id[];
  sourceMode: 'composite' | 'video' | 'audio';
  setSourceMode: (m: 'composite' | 'video' | 'audio') => void;

  modal: ModalRequest | null;
  openModal: (m: ModalRequest) => void;
  closeModal: () => void;

  toasts: Toast[];
  toast: (t: Omit<Toast, 'id' | 'at'>) => string;
  updateToast: (id: string, patch: Partial<Toast>) => void;
  dismissToast: (id: string) => void;

  events: EventLogEntry[];
  logEvent: (kind: EventLogEntry['kind'], message: string, detail?: string) => void;
  clearEvents: () => void;

  /** Effect Controls: which clip is pinned. */
  pinnedClipId: Id | null;
  setPinnedClipId: (id: Id | null) => void;

  /** Lumetri panel target when no clip selected. */
  lumetriTarget: 'clip' | 'adjustment';

  /** Grid nudge amount, frames. */
  nudgeFrames: number;

  effectsSearch: string;
  setEffectsSearch: (s: string) => void;
  projectSearch: string;
  setProjectSearch: (s: string) => void;
  projectView: 'list' | 'icon' | 'freeform';
  setProjectView: (v: 'list' | 'icon' | 'freeform') => void;
  projectSort: { key: 'name' | 'kind' | 'duration' | 'createdAt' | 'label' | 'size'; dir: 1 | -1 };
  setProjectSort: (k: UIState['projectSort']['key']) => void;
  projectIconSize: number;
  setProjectIconSize: (n: number) => void;
  currentBinId: Id | null;
  setCurrentBinId: (id: Id | null) => void;

  /** Playback rate for J/K/L shuttle. */
  shuttleRate: number;
  setShuttleRate: (r: number) => void;

  /** Whether an inline text field has focus (disables single-key shortcuts). */
  textEditing: boolean;
  setTextEditing: (b: boolean) => void;

  contextMenu: { x: number; y: number; items: ContextMenuItem[] } | null;
  openContextMenu: (x: number, y: number, items: ContextMenuItem[]) => void;
  closeContextMenu: () => void;

  /** Panel layouts, persisted. */
  layoutVersion: number;
  bumpLayout: () => void;

  /** Secret state for easter eggs (never displayed). */
  konami: number;
  secretCounter: Record<string, number>;
  bumpSecret: (key: string) => number;
  resetSecret: (key: string) => void;
  hamburgerMode: boolean;
  setHamburgerMode: (b: boolean) => void;
  turtleMode: boolean;
  setTurtleMode: (b: boolean) => void;
  colorInverted: boolean;
  setColorInverted: (b: boolean) => void;
}

export interface ContextMenuItem {
  label?: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  danger?: boolean;
  submenu?: ContextMenuItem[];
  onSelect?: () => void;
}

const emptySelection = (): Selection => ({
  clipIds: [],
  transitionIds: [],
  trackIds: [],
  markerIds: [],
  keyframes: [],
  captionIds: [],
  effectId: null,
  graphicLayerIds: [],
});

let toastCounter = 0;
let eventCounter = 0;

export const useUI = create<UIState>((set, get) => ({
  tool: 'select',
  setTool: (tool) => set({ tool }),
  selection: emptySelection(),
  setSelection: (s) => set({ selection: { ...get().selection, ...s } }),
  clearSelection: () => set({ selection: emptySelection() }),
  selectClips: (ids, additive) => {
    const cur = get().selection;
    if (additive) {
      const setIds = new Set(cur.clipIds);
      for (const id of ids) setIds.add(id);
      set({ selection: { ...emptySelection(), clipIds: [...setIds] } });
    } else set({ selection: { ...emptySelection(), clipIds: ids } });
  },
  toggleClip: (id) => {
    const cur = get().selection;
    const has = cur.clipIds.includes(id);
    set({ selection: { ...emptySelection(), clipIds: has ? cur.clipIds.filter((x) => x !== id) : [...cur.clipIds, id] } });
  },

  workspace: 'editing',
  setWorkspace: (workspace) => set({ workspace }),
  focusedPanel: 'timeline',
  setFocusedPanel: (focusedPanel) => set({ focusedPanel }),
  maximizedPanel: null,
  setMaximizedPanel: (maximizedPanel) => set({ maximizedPanel }),

  timecodeMode: 'timecode',
  setTimecodeMode: (timecodeMode) => set({ timecodeMode }),
  snapping: true,
  setSnapping: (snapping) => set({ snapping }),
  linkedSelection: true,
  setLinkedSelection: (linkedSelection) => set({ linkedSelection }),
  rippleDelete: false,
  showAudioWaveforms: true,
  showVideoThumbnails: true,
  showClipNames: true,
  showThroughEdits: true,
  showDuplicateFrames: false,
  setTimelineDisplay: (p) => set(p),

  programQuality: 'full',
  setProgramQuality: (programQuality) => set({ programQuality }),
  programZoom: 'fit',
  setProgramZoom: (programZoom) => set({ programZoom }),
  programOverlay: [],
  toggleProgramOverlay: (o) => {
    const cur = get().programOverlay;
    set({ programOverlay: cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o] });
  },
  programChannel: 'rgb',
  setProgramChannel: (programChannel) => set({ programChannel }),
  transparencyGrid: false,
  setTransparencyGrid: (transparencyGrid) => set({ transparencyGrid }),
  showKeyframeEditor: false,
  setShowKeyframeEditor: (showKeyframeEditor) => set({ showKeyframeEditor }),

  sourceAssetId: null,
  setSourceAssetId: (sourceAssetId) =>
    set((s) => ({ sourceAssetId, sourceTime: 0, recentSources: sourceAssetId ? [sourceAssetId, ...s.recentSources.filter((x) => x !== sourceAssetId)].slice(0, 12) : s.recentSources })),
  sourceTime: 0,
  recentSources: [],
  setSourceTime: (sourceTime) => set({ sourceTime }),
  sourceMode: 'composite',
  setSourceMode: (sourceMode) => set({ sourceMode }),

  modal: null,
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),

  toasts: [],
  toast: (t) => {
    const id = `t${++toastCounter}`;
    set({ toasts: [...get().toasts, { ...t, id, at: Date.now() }].slice(-6) });
    if (!t.sticky) {
      window.setTimeout(() => get().dismissToast(id), t.kind === 'error' ? 9000 : 4500);
    }
    return id;
  },
  updateToast: (id, patch) => set({ toasts: get().toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)) }),
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  events: [],
  logEvent: (kind, message, detail) => set({ events: [{ id: `e${++eventCounter}`, kind, message, detail, at: Date.now() }, ...get().events].slice(0, 300) }),
  clearEvents: () => set({ events: [] }),

  pinnedClipId: null,
  setPinnedClipId: (pinnedClipId) => set({ pinnedClipId }),
  lumetriTarget: 'clip',
  nudgeFrames: 1,

  effectsSearch: '',
  setEffectsSearch: (effectsSearch) => set({ effectsSearch }),
  projectSearch: '',
  setProjectSearch: (projectSearch) => set({ projectSearch }),
  projectView: 'list',
  setProjectView: (projectView) => set({ projectView }),
  projectSort: { key: 'name', dir: 1 },
  setProjectSort: (key) => {
    const cur = get().projectSort;
    set({ projectSort: { key, dir: cur.key === key ? ((cur.dir * -1) as 1 | -1) : 1 } });
  },
  projectIconSize: 96,
  setProjectIconSize: (projectIconSize) => set({ projectIconSize }),
  currentBinId: null,
  setCurrentBinId: (currentBinId) => set({ currentBinId }),

  shuttleRate: 0,
  setShuttleRate: (shuttleRate) => set({ shuttleRate }),

  textEditing: false,
  setTextEditing: (textEditing) => set({ textEditing }),

  contextMenu: null,
  openContextMenu: (x, y, items) => set({ contextMenu: { x, y, items } }),
  closeContextMenu: () => set({ contextMenu: null }),

  layoutVersion: 0,
  bumpLayout: () => set({ layoutVersion: get().layoutVersion + 1 }),

  konami: 0,
  secretCounter: {},
  bumpSecret: (key) => {
    const n = (get().secretCounter[key] ?? 0) + 1;
    set({ secretCounter: { ...get().secretCounter, [key]: n } });
    return n;
  },
  resetSecret: (key) => set({ secretCounter: { ...get().secretCounter, [key]: 0 } }),
  hamburgerMode: false,
  setHamburgerMode: (hamburgerMode) => set({ hamburgerMode }),
  turtleMode: false,
  setTurtleMode: (turtleMode) => set({ turtleMode }),
  colorInverted: false,
  setColorInverted: (colorInverted) => set({ colorInverted }),
}));

export function toast(kind: Toast['kind'], title: string, message?: string) {
  return useUI.getState().toast({ kind, title, message });
}

export function logEvent(kind: EventLogEntry['kind'], message: string, detail?: string) {
  useUI.getState().logEvent(kind, message, detail);
}
