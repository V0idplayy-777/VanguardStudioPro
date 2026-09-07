import { create } from 'zustand';
import { Compositor } from '../gl/compositor';
import { TimelineAudio } from '../audio/timelineAudio';
import { getSharedAudioContext } from '../audio/audioContext';
import { getActiveSequence, sequenceDuration, useProject } from '../../state/projectStore';
import { useUI, logEvent } from '../../state/uiStore';
import type { Project, Sequence } from '../../types/project';
import { onMediaChange } from '../media/mediaStore';

/*
  Playback controller. Owns:
   - the shared Compositor (one WebGL context on a hidden canvas)
   - TimelineAudio for realtime sound
   - the playhead clock

  Monitors subscribe to `frameVersion` and call `renderTo(canvas)` to display
  the latest composite.
*/

interface PlaybackState {
  playing: boolean;
  playhead: number; // frames in active sequence
  rate: number; // 1 normal, 2/4 shuttle, negative reverse
  loop: boolean;
  frameVersion: number;
  droppedFrames: number;
  renderMs: number;
  fpsActual: number;
  masterDb: number;
  masterMute: boolean;
  /** The sequence id the transport is bound to. */
  sequenceId: string | null;
  setPlayhead: (f: number, opts?: { fromUser?: boolean }) => void;
  play: (rate?: number) => void;
  pause: () => void;
  toggle: () => void;
  stop: () => void;
  setLoop: (b: boolean) => void;
  shuttle: (dir: -1 | 0 | 1) => void;
  step: (frames: number) => void;
  setMaster: (db: number) => void;
  setMasterMute: (m: boolean) => void;
  bump: () => void;
}

let compositor: Compositor | null = null;
let audio: TimelineAudio | null = null;
let rafId = 0;
let lastTick = 0;
let rendering = false;
let pendingRender = false;
let lastRenderedFrame = -1;
let lastRenderedRev = -1;
let lastRenderedQuality = '';
let fpsAcc = 0;
let fpsCount = 0;
let fpsTime = 0;
let lastMediaVersion = 0;
let mediaVersion = 0;
onMediaChange(() => {
  mediaVersion++;
});

export function getCompositor(): Compositor {
  if (!compositor) {
    const c = document.createElement('canvas');
    c.width = 1920;
    c.height = 1080;
    compositor = new Compositor(c);
    compositor.onShaderError = (m) => logEvent('error', 'Shader failed to compile', m);
  }
  return compositor;
}

export function getTimelineAudio(): TimelineAudio {
  if (!audio) {
    audio = new TimelineAudio(
      getSharedAudioContext(),
      () => useProject.getState().project,
      () => getActiveSequence(useProject.getState().project),
    );
  }
  return audio;
}

export const usePlayback = create<PlaybackState>((set, get) => ({
  playing: false,
  playhead: 0,
  rate: 1,
  loop: false,
  frameVersion: 0,
  droppedFrames: 0,
  renderMs: 0,
  fpsActual: 0,
  masterDb: 0,
  masterMute: false,
  sequenceId: null,
  setPlayhead: (f, opts) => {
    const seq = getActiveSequence(useProject.getState().project);
    const max = seq ? Math.max(sequenceDuration(seq), 0) : 0;
    const clamped = Math.max(0, Math.min(Math.round(f), Math.max(max, 0) + (seq ? seq.settings.fps * 3600 : 0)));
    set({ playhead: clamped });
    if (get().playing && opts?.fromUser) {
      getTimelineAudio().play(clamped / (seq?.settings.fps ?? 30), get().rate);
    }
    if (seq) {
      // persist for the sequence view without creating history
      useProject.getState().updateTransient((p) => {
        const s = p.sequences.find((x) => x.id === seq.id);
        if (s) s.view = { ...s.view, playhead: clamped };
      });
    }
    scheduleRender();
  },
  play: (rate = 1) => {
    const seq = getActiveSequence(useProject.getState().project);
    if (!seq) return;
    const fps = seq.settings.fps;
    let start = get().playhead;
    const dur = sequenceDuration(seq);
    if (rate > 0 && start >= dur && dur > 0) start = seq.inPoint ?? 0;
    set({ playing: true, rate, playhead: start });
    getTimelineAudio().play(start / fps, rate);
    lastTick = performance.now();
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  },
  pause: () => {
    if (!get().playing) return;
    set({ playing: false, rate: 1 });
    getTimelineAudio().stop();
    cancelAnimationFrame(rafId);
    useUI.getState().setShuttleRate(0);
    scheduleRender(true);
  },
  toggle: () => {
    if (get().playing) get().pause();
    else get().play(1);
  },
  stop: () => {
    get().pause();
  },
  setLoop: (loop) => set({ loop }),
  shuttle: (dir) => {
    const st = get();
    if (dir === 0) {
      st.pause();
      return;
    }
    let rate = st.rate;
    if (!st.playing || Math.sign(rate) !== dir) rate = dir;
    else rate = Math.min(32, Math.abs(rate) * 2) * dir;
    st.play(rate);
    useUI.getState().setShuttleRate(rate);
  },
  step: (frames) => {
    const st = get();
    if (st.playing) st.pause();
    st.setPlayhead(st.playhead + frames, { fromUser: true });
  },
  setMaster: (db) => {
    set({ masterDb: db });
    getTimelineAudio().setMasterGain(db);
  },
  setMasterMute: (m) => {
    set({ masterMute: m });
    getTimelineAudio().setMuted(m);
  },
  bump: () => set({ frameVersion: get().frameVersion + 1 }),
}));

function tick(now: number) {
  const st = usePlayback.getState();
  if (!st.playing) return;
  const project = useProject.getState().project;
  const seq = getActiveSequence(project);
  if (!seq) {
    st.pause();
    return;
  }
  const fps = seq.settings.fps;
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  let frame: number;
  if (st.rate > 0 && st.rate <= 4) {
    // slave to audio clock for sync
    frame = Math.round(getTimelineAudio().currentTime() * fps);
  } else {
    frame = Math.round(st.playhead + dt * fps * st.rate);
  }
  const dur = sequenceDuration(seq);
  const loopStart = seq.inPoint ?? 0;
  const loopEnd = seq.outPoint ?? dur;
  if (st.rate > 0 && frame >= (seq.outPoint !== null && st.loop ? loopEnd : Math.max(dur, 1))) {
    if (st.loop && loopEnd > loopStart) {
      usePlayback.setState({ playhead: loopStart });
      getTimelineAudio().play(loopStart / fps, st.rate);
      scheduleRender();
      rafId = requestAnimationFrame(tick);
      return;
    }
    usePlayback.setState({ playhead: Math.max(dur, 0) });
    st.pause();
    return;
  }
  if (st.rate < 0 && frame <= 0) {
    usePlayback.setState({ playhead: 0 });
    st.pause();
    return;
  }
  if (frame !== st.playhead) usePlayback.setState({ playhead: frame });
  scheduleRender();
  rafId = requestAnimationFrame(tick);
}

let renderQueued = false;
let forceNext = false;

export function scheduleRender(force = false) {
  if (force) forceNext = true;
  if (renderQueued) {
    pendingRender = true;
    return;
  }
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    void renderNow();
  });
}

/** Whether the current sequence has any content to draw. */
export function sequenceHasContent(seq: Sequence | null) {
  return !!seq && (seq.clips.length > 0 || seq.captions.length > 0);
}

let lastRT: ReturnType<Compositor['core']['acquire']> | null = null;

async function renderNow() {
  if (rendering) {
    pendingRender = true;
    return;
  }
  const st = usePlayback.getState();
  const project = useProject.getState().project;
  const seq = getActiveSequence(project);
  if (!seq) return;
  const quality = useUI.getState().programQuality;
  const key = `${quality}`;
  const force = forceNext;
  forceNext = false;
  if (!force && lastRenderedFrame === st.playhead && lastRenderedRev === project.revision && lastRenderedQuality === key && lastMediaVersion === mediaVersion && !hasAnimatedEffects(seq, st.playhead)) {
    return;
  }
  rendering = true;
  const t0 = performance.now();
  try {
    const comp = getCompositor();
    if (lastRT) {
      comp.release(lastRT);
      lastRT = null;
    }
    comp.releaseAll();
    let scale = quality === 'half' ? 2 : quality === 'quarter' ? 4 : 1;
    // During fast playback drop to half to keep up
    if (st.playing && scale === 1 && st.renderMs > 1000 / seq.settings.fps * 0.9) scale = 2;
    const rt = await comp.renderFrame(project, seq, st.playhead, { scale, captions: true });
    lastRT = rt;
    lastRenderedFrame = st.playhead;
    lastRenderedRev = project.revision;
    lastRenderedQuality = key;
    lastMediaVersion = mediaVersion;
    const ms = performance.now() - t0;
    fpsAcc += ms;
    fpsCount++;
    if (performance.now() - fpsTime > 500) {
      usePlayback.setState({ renderMs: fpsAcc / Math.max(1, fpsCount), fpsActual: st.playing ? Math.min(seq.settings.fps, 1000 / Math.max(1, fpsAcc / Math.max(1, fpsCount))) : 0 });
      fpsAcc = 0;
      fpsCount = 0;
      fpsTime = performance.now();
    }
    if (comp.lastFrameIncomplete && !st.playing) {
      // media still decoding: retry shortly
      window.setTimeout(() => scheduleRender(true), 120);
    }
    usePlayback.setState({ frameVersion: usePlayback.getState().frameVersion + 1 });
  } catch (e: any) {
    logEvent('error', 'Render failed', String(e?.stack ?? e));
  } finally {
    rendering = false;
    if (pendingRender) {
      pendingRender = false;
      scheduleRender();
    }
  }
}

function hasAnimatedEffects(seq: Sequence, frame: number) {
  for (const c of seq.clips) {
    if (frame < c.start || frame >= c.start + c.duration) continue;
    for (const e of c.effects) if (e.enabled && ANIMATED.has(e.type)) return true;
  }
  return false;
}
const ANIMATED = new Set(['noise', 'filmGrain', 'dust', 'vhs', 'strobe', 'wave', 'ripple', 'echo']);

/** Current composite render target (premultiplied). May be null before first render. */
export function currentRenderTarget() {
  return lastRT;
}

/** Draw the latest composite into a visible canvas. */
export function presentTo(canvas: HTMLCanvasElement, opts: { channel?: number; checker?: boolean; bg?: [number, number, number] }) {
  const comp = getCompositor();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (!lastRT) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const src = comp.canvas as HTMLCanvasElement;
  if (src.width !== lastRT.width || src.height !== lastRT.height) {
    src.width = lastRT.width;
    src.height = lastRT.height;
  }
  comp.present(lastRT, { channel: opts.channel, checker: opts.checker, bg: opts.bg });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
}

/** Render an arbitrary frame of a sequence to a canvas (thumbnails, export, source monitor). */
export async function renderFrameToCanvas(project: Project, seq: Sequence, frame: number, target: HTMLCanvasElement, opts: { scale?: number; soloClipId?: string | null; captions?: boolean } = {}) {
  const comp = getCompositor();
  const rt = await comp.renderFrame(project, seq, frame, { scale: opts.scale ?? 1, soloClipId: opts.soloClipId ?? null, captions: opts.captions ?? true });
  comp.drawToCanvas(rt, target);
  comp.release(rt);
  // restore main render target state for the program monitor
  forceNext = true;
  scheduleRender(true);
}

/** Convenience for keyboard handlers. */
export function nudgePlayhead(frames: number) {
  usePlayback.getState().step(frames);
}

// Re-render when the project or UI quality changes.
useProject.subscribe((s, prev) => {
  if (s.project !== prev.project) {
    const seq = getActiveSequence(s.project);
    const prevSeq = getActiveSequence(prev.project);
    if (seq && prevSeq && seq.id !== prevSeq.id) {
      usePlayback.getState().pause();
      usePlayback.setState({ playhead: seq.view.playhead ?? 0, sequenceId: seq.id });
    }
    if (usePlayback.getState().playing && seq !== prevSeq) getTimelineAudio().invalidate();
    scheduleRender();
  }
});
useUI.subscribe((s, prev) => {
  if (s.programQuality !== prev.programQuality || s.programChannel !== prev.programChannel || s.transparencyGrid !== prev.transparencyGrid) scheduleRender(true);
});
onMediaChange(() => scheduleRender(true));
