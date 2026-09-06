import { create } from 'zustand';
import {
  DEFAULT_CAPTION_STYLE,
  DEFAULT_SEQUENCE_SETTINGS,
  defaultClipAudio,
  defaultMotion,
  defaultTrack,
  param,
  type Bin,
  type Clip,
  type Id,
  type MediaAsset,
  type Project,
  type ProjectSettings,
  type Sequence,
  type SequenceSettings,
  type Track,
  type TrackKind,
} from '../types/project';
import { uid } from '../engine/util';
import { produce, setAutoFreeze } from 'immer';

// Structural sharing without freezing: every committed change yields a new
// object graph along the mutated path (so React.memo / selectors work), while
// untouched branches keep their identity. History entries are just references.
setAutoFreeze(false);

export interface HistoryEntry {
  label: string;
  before: Project;
  at: number;
}

export function defaultProjectSettings(name = 'Untitled Project'): ProjectSettings {
  return {
    name,
    defaultSequence: { ...DEFAULT_SEQUENCE_SETTINGS },
    defaultVideoTransition: 'crossDissolve',
    defaultAudioTransition: 'constantPower',
    defaultTransitionDuration: 30,
    defaultAudioTransitionDuration: 30,
    defaultStillDuration: 150,
    timecodeDisplay: 'timecode',
    autoSaveEnabled: true,
    autoSaveIntervalMinutes: 5,
    scratchNote: '',
    labelDefaults: {
      video: 'cerulean',
      audio: 'forest',
      image: 'mango',
      sequence: 'iris',
      graphic: 'purple',
      adjustment: 'tan',
      bin: 'lavender',
    },
    audioHardware: { latencyHint: 'interactive' },
    captionDefaults: { ...DEFAULT_CAPTION_STYLE },
  };
}

export function createSequence(name: string, settings: Partial<SequenceSettings> = {}, tracks = { video: 3, audio: 3 }): Sequence {
  const s: SequenceSettings = { ...DEFAULT_SEQUENCE_SETTINGS, ...settings };
  const trackList: Track[] = [];
  for (let i = 0; i < tracks.video; i++) trackList.push(defaultTrack('video', i, uid('trk')));
  for (let i = 0; i < tracks.audio; i++) trackList.push(defaultTrack('audio', i, uid('trk')));
  return {
    id: uid('seq'),
    name,
    settings: s,
    tracks: trackList,
    clips: [],
    markers: [],
    captions: [],
    captionTrack: { enabled: true, burnIn: false, style: { ...DEFAULT_CAPTION_STYLE }, name: 'Captions' },
    inPoint: null,
    outPoint: null,
    workArea: { enabled: false, start: 0, end: s.fps * 60 },
    view: { pixelsPerFrame: 4, scrollFrame: 0, scrollY: 0, playhead: 0 },
    label: 'iris',
    binId: null,
    createdAt: Date.now(),
    modifiedAt: Date.now(),
  };
}

export function createEmptyProject(name = 'Untitled Project'): Project {
  const seq = createSequence('Sequence 01');
  return {
    id: uid('proj'),
    version: 3,
    settings: defaultProjectSettings(name),
    bins: [],
    assets: [],
    sequences: [seq],
    openSequenceIds: [seq.id],
    activeSequenceId: seq.id,
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    revision: 0,
  };
}

interface ProjectState {
  project: Project;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Position in the combined history list for the History panel. */
  historyLabels: string[];
  dirty: boolean;
  batchBefore: Project | null;
  batchLabel: string | null;

  /** Apply an undoable change. */
  update: (label: string, fn: (p: Project) => void) => void;
  /** Apply a change without pushing history (used while dragging). Must be wrapped by beginBatch/endBatch to be undoable. */
  updateTransient: (fn: (p: Project) => void) => void;
  beginBatch: (label: string) => void;
  endBatch: (label?: string) => void;
  cancelBatch: () => void;
  undo: () => void;
  redo: () => void;
  jumpHistory: (index: number) => void;
  loadProject: (p: Project) => void;
  newProject: (name?: string) => void;
  markSaved: () => void;
  setDirty: (d: boolean) => void;
  autosavedAt: number | null;
  setAutosavedAt: (t: number) => void;
}

export const MAX_HISTORY = 200;

export const useProject = create<ProjectState>((set, get) => ({
  project: createEmptyProject(),
  past: [],
  future: [],
  historyLabels: [],
  dirty: false,
  batchBefore: null,
  batchLabel: null,

  update: (label, fn) => {
    const { project, past, batchBefore } = get();
    const now = Date.now();
    const next = produce(project, (draft) => {
      fn(draft as Project);
      draft.modifiedAt = now;
      draft.revision = project.revision + 1;
    });
    if (next === project) return;
    // Stamp modified sequences (cheap identity check thanks to structural sharing)
    const stamped = produce(next, (draft) => {
      for (let i = 0; i < draft.sequences.length; i++) {
        const before = project.sequences.find((x) => x.id === draft.sequences[i].id);
        if (before !== next.sequences[i]) draft.sequences[i].modifiedAt = now;
      }
    });
    if (!batchBefore) {
      const entry: HistoryEntry = { label, before: project, at: now };
      const newPast = [...past, entry].slice(-MAX_HISTORY);
      set({ project: stamped, past: newPast, future: [], dirty: true, historyLabels: newPast.map((e) => e.label) });
    } else {
      set({ project: stamped, dirty: true });
    }
  },

  updateTransient: (fn) => {
    const { project } = get();
    const next = produce(project, (draft) => {
      fn(draft as Project);
      draft.revision = project.revision + 1;
    });
    if (next !== project) set({ project: next, dirty: true });
  },

  beginBatch: (label) => {
    const { project, batchBefore } = get();
    if (batchBefore) return;
    set({ batchBefore: project, batchLabel: label });
  },

  endBatch: (label) => {
    const { batchBefore, batchLabel, past, project } = get();
    if (!batchBefore) return;
    const changed = docChanged(project, batchBefore);
    if (changed) {
      const entry: HistoryEntry = { label: label ?? batchLabel ?? 'Edit', before: batchBefore, at: Date.now() };
      const newPast = [...past, entry].slice(-MAX_HISTORY);
      set({ past: newPast, future: [], batchBefore: null, batchLabel: null, historyLabels: newPast.map((e) => e.label) });
    } else {
      set({ batchBefore: null, batchLabel: null });
    }
  },

  cancelBatch: () => {
    const { batchBefore, project } = get();
    if (!batchBefore) return;
    set({ project: { ...batchBefore, revision: project.revision + 1 }, batchBefore: null, batchLabel: null });
  },

  undo: () => {
    const { past, future, project, batchBefore } = get();
    if (!past.length || batchBefore) return;
    const entry = past[past.length - 1];
    const redoEntry: HistoryEntry = { label: entry.label, before: project, at: Date.now() };
    const restored: Project = { ...entry.before, revision: project.revision + 1 };
    const newPast = past.slice(0, -1);
    set({ project: restored, past: newPast, future: [redoEntry, ...future], dirty: true, historyLabels: newPast.map((e) => e.label) });
  },

  redo: () => {
    const { past, future, project, batchBefore } = get();
    if (!future.length || batchBefore) return;
    const entry = future[0];
    const undoEntry: HistoryEntry = { label: entry.label, before: project, at: Date.now() };
    const restored: Project = { ...entry.before, revision: project.revision + 1 };
    const newPast = [...past, undoEntry];
    set({ project: restored, past: newPast, future: future.slice(1), dirty: true, historyLabels: newPast.map((e) => e.label) });
  },

  jumpHistory: (index) => {
    // index = number of past entries that should remain applied
    const { past } = get();
    let steps = past.length - index;
    if (steps > 0) while (steps-- > 0) get().undo();
    else while (steps++ < 0) get().redo();
  },

  loadProject: (p) => set({ project: p, past: [], future: [], historyLabels: [], dirty: false, batchBefore: null, batchLabel: null }),
  newProject: (name) => set({ project: createEmptyProject(name), past: [], future: [], historyLabels: [], dirty: false, batchBefore: null }),
  markSaved: () => set({ dirty: false }),
  autosavedAt: null,
  setAutosavedAt: (t) => set({ autosavedAt: t }),
  setDirty: (d) => set({ dirty: d }),
}));

/** True when any undoable part of the document differs (identity based). */
function docChanged(a: Project, b: Project) {
  return a.bins !== b.bins || a.assets !== b.assets || a.sequences !== b.sequences || a.settings !== b.settings || a.openSequenceIds !== b.openSequenceIds || a.activeSequenceId !== b.activeSequenceId;
}

/* ---------- selectors ---------- */

export function getActiveSequence(p: Project): Sequence | null {
  return p.sequences.find((s) => s.id === p.activeSequenceId) ?? null;
}

export function useActiveSequence(): Sequence | null {
  return useProject((s) => s.project.sequences.find((x) => x.id === s.project.activeSequenceId) ?? null);
}

export function findClip(seq: Sequence, id: Id): Clip | undefined {
  return seq.clips.find((c) => c.id === id);
}

export function findAsset(p: Project, id: Id | null | undefined): MediaAsset | undefined {
  if (!id) return undefined;
  return p.assets.find((a) => a.id === id);
}

export function sequenceDuration(seq: Sequence): number {
  let end = 0;
  for (const c of seq.clips) end = Math.max(end, c.start + c.duration);
  for (const c of seq.captions) end = Math.max(end, c.end);
  return end;
}

export function clipsOnTrack(seq: Sequence, trackId: Id): Clip[] {
  return seq.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
}

export function trackIndex(seq: Sequence, trackId: Id): number {
  const kind = seq.tracks.find((t) => t.id === trackId)?.kind;
  return seq.tracks.filter((t) => t.kind === kind).findIndex((t) => t.id === trackId);
}

export function videoTracks(seq: Sequence): Track[] {
  return seq.tracks.filter((t) => t.kind === 'video');
}
export function audioTracks(seq: Sequence): Track[] {
  return seq.tracks.filter((t) => t.kind === 'audio');
}

/* ---------- clip factory ---------- */

export function makeClip(partial: Partial<Clip> & { trackId: Id; start: number; duration: number }): Clip {
  return {
    id: uid('clip'),
    assetId: null,
    name: 'Clip',
    inPoint: 0,
    speed: 1,
    reversed: false,
    maintainPitch: true,
    enabled: true,
    label: 'cerulean',
    linkId: null,
    groupId: null,
    motion: defaultMotion(),
    audio: defaultClipAudio(),
    effects: [],
    transitionIn: null,
    transitionOut: null,
    markers: [],
    ...partial,
  };
}

export function newTrack(kind: TrackKind, index: number): Track {
  const t = defaultTrack(kind, index, uid('trk'));
  t.targeted = false;
  return t;
}

/** Renumber track names V1.. A1.. after structural changes. */
export function renumberTracks(seq: Sequence) {
  let v = 0,
    a = 0,
    c = 0;
  for (const t of seq.tracks) {
    if (t.kind === 'video') t.name = /^V\d+$/.test(t.name) || !t.name ? `V${++v}` : (v++, t.name);
    else if (t.kind === 'audio') t.name = /^A\d+$/.test(t.name) || !t.name ? `A${++a}` : (a++, t.name);
    else t.name = /^C\d+$/.test(t.name) || !t.name ? `C${++c}` : (c++, t.name);
  }
}

export { param };
export type { Bin };
