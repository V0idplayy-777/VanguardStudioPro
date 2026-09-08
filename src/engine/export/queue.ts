import { create } from 'zustand';
import type { Id } from '../../types/project';
import { useProject } from '../../state/projectStore';
import { toast, logEvent } from '../../state/uiStore';
import { settings } from '../../state/settingsStore';
import { download, formatBytes, formatDurationShort, uid } from '../util';
import { playChime } from '../audio/notify';
import { ExportCancelled, applyAppExportDefaults, defaultExportSettings, exportFilenameFor, exportSequence, type ExportSettings } from './exporter';

/*
  Render Queue: batch exports.

  Items snapshot a sequence id + export settings when queued; the actual render
  always reads the LATEST project state when the queue runs, so last-minute
  edits are picked up. Jobs run one at a time (single GL context, single
  encoder) and each finished file downloads on its own when auto-download is
  on (Settings > Export).
*/

export type QueueStatus = 'pending' | 'running' | 'done' | 'error';

export interface QueueItem {
  id: Id;
  seqId: Id;
  seqName: string;
  settings: ExportSettings;
  status: QueueStatus;
  /** 0..1 while running. */
  progress: number;
  message?: string;
  /** Kept so finished items can be downloaded again until cleared. */
  result?: { blob: Blob; filename: string; size: number; frames: number; seconds: number };
  error?: string;
  queuedAt: number;
}

interface QueueState {
  items: QueueItem[];
  running: boolean;
  add: (seqId: Id, seqName: string, settings: ExportSettings) => string;
  /** Convenience: queue the active sequence with app export defaults applied. */
  addActiveSequence: () => void;
  remove: (id: Id) => void;
  clearFinished: () => void;
  clearAll: () => void;
  start: () => Promise<void>;
  stop: () => void;
}

let ac: AbortController | null = null;

export const useRenderQueue = create<QueueState>((set, get) => ({
  items: [],
  running: false,

  add: (seqId, seqName, s) => {
    const id = uid('rq');
    set({ items: [...get().items, { id, seqId, seqName, settings: s, status: 'pending', progress: 0, queuedAt: Date.now() }] });
    logEvent('info', `Queued for export: ${seqName}`, `${s.filename}.${s.container}`);
    return id;
  },

  addActiveSequence: () => {
    const p = useProject.getState().project;
    const seq = p.sequences.find((s) => s.id === p.activeSequenceId);
    if (!seq) return toast('warning', 'Render Queue', 'Open a sequence first.');
    const st = settings();
    const base = applyAppExportDefaults(defaultExportSettings(seq, seq.name), seq, {
      exportDefaultPreset: st.exportDefaultPreset,
      exportFilenameMode: st.exportFilenameMode,
      exportBurnCaptions: st.exportBurnCaptions,
      projectName: p.settings.name,
    });
    get().add(seq.id, seq.name, base);
    toast('success', 'Added to Render Queue', `${seq.name} -> ${base.filename}.${base.container}`);
  },

  remove: (id) => {
    if (get().running) {
      const it = get().items.find((x) => x.id === id);
      if (it?.status === 'running') get().stop();
    }
    set({ items: get().items.filter((x) => x.id !== id) });
  },

  clearFinished: () => set({ items: get().items.filter((x) => x.status === 'pending' || x.status === 'running') }),
  clearAll: () => {
    if (get().running) get().stop();
    set({ items: [] });
  },

  stop: () => {
    ac?.abort();
  },

  start: async () => {
    if (get().running) return;
    const pending = get().items.filter((x) => x.status === 'pending' || x.status === 'error');
    if (!pending.length) {
      toast('info', 'Render Queue', 'Nothing queued. Use "Add to Queue" in the Export panel first.');
      return;
    }
    ac = new AbortController();
    const signal = ac.signal;
    set({ running: true });
    let doneCount = 0;
    let errorCount = 0;
    const startedAt = performance.now();
    logEvent('info', `Render queue started (${pending.length} item${pending.length === 1 ? '' : 's'})`);

    for (const item of pending) {
      if (signal.aborted) break;
      const patch = (p: Partial<QueueItem>) => set({ items: get().items.map((x) => (x.id === item.id ? { ...x, ...p } : x)) });
      // Always render from the freshest project state.
      const project = useProject.getState().project;
      const seq = project.sequences.find((s) => s.id === item.seqId);
      if (!seq) {
        patch({ status: 'error', error: 'Sequence no longer exists', progress: 0 });
        errorCount++;
        continue;
      }
      patch({ status: 'running', progress: 0, error: undefined, message: 'Preparing' });
      // Refresh the filename in case the mode is 'dated' and the day rolled over.
      const st = settings();
      const runSettings: ExportSettings = { ...item.settings, filename: exportFilenameFor(st.exportFilenameMode, seq.name, project.settings.name) };
      try {
        const r = await exportSequence(project, seq, runSettings, (p) => {
          patch({ progress: p.totalFrames ? p.frame / p.totalFrames : 0, message: p.phase + (p.message ? ` - ${p.message}` : '') });
        }, signal);
        if (settings().exportAutoDownload) download(r.blob, r.filename);
        patch({ status: 'done', progress: 1, message: undefined, result: { blob: r.blob, filename: r.filename, size: r.blob.size, frames: r.frames, seconds: r.durationSeconds } });
        doneCount++;
        logEvent('info', `Queue export finished: ${r.filename}`, `${formatBytes(r.blob.size)}, ${r.frames} frames`);
        toast('success', 'Render queue', `${r.filename} (${formatBytes(r.blob.size)}) in ${formatDurationShort(r.durationSeconds)}${settings().exportAutoDownload ? '' : ' - download it from the queue list'}`);
      } catch (e) {
        if (e instanceof ExportCancelled || signal.aborted) {
          patch({ status: 'pending', progress: 0, message: undefined });
          break;
        }
        patch({ status: 'error', progress: 0, error: String((e as Error)?.message ?? e), message: undefined });
        errorCount++;
        logEvent('error', `Queue export failed: ${item.seqName}`, String((e as Error)?.stack ?? e));
      }
    }

    const cancelled = signal.aborted;
    ac = null;
    set({ running: false });
    if (settings().soundOnExport) playChime(cancelled ? 'info' : errorCount && !doneCount ? 'error' : 'success');
    const secs = (performance.now() - startedAt) / 1000;
    if (cancelled) toast('info', 'Render queue stopped', `${doneCount} finished before stopping.`);
    else toast(errorCount ? 'warning' : 'success', 'Render queue complete', `${doneCount} exported, ${errorCount} failed in ${formatDurationShort(secs)}.`);
    logEvent('info', `Render queue finished: ${doneCount} done, ${errorCount} failed`, formatDurationShort(secs));
  },
}));

/** Number of items waiting to run (pending or failed-and-retryable). */
export function queuePendingCount(): number {
  return useRenderQueue.getState().items.filter((x) => x.status === 'pending' || x.status === 'error').length;
}
