/*
  Retention toolkit - timeline edits.

  The one-click actions that reshape the sequence for retention:
  zoom punches, flash-on-cuts, the infinite loop outro, rewind traps
  (split-second easter eggs) and comment-section bait.
*/

import type { Clip, GraphicDocument, Id, ImageLayer, MediaAsset, Project, Sequence, TextLayer } from '../types/project';
import { param } from '../types/project';
import * as E from '../engine/timeline/edits';
import { makeClip, sequenceDuration } from '../state/projectStore';
import { uid } from '../engine/util';

/* ---------- 2-second reset: zoom punches ---------- */

/**
 * Add a subtle scale punch to every video clip at `intervalSec` so the frame
 * never sits still for more than ~2 seconds. Clips with their own animated
 * scale (e.g. Ken Burns) are left alone.
 */
export function addZoomPunches(seq: Sequence, intervalSec = 2, ampPct = 4): number {
  const fps = seq.settings.fps;
  const interval = Math.max(2, Math.round(intervalSec * fps));
  let touched = 0;
  for (const c of seq.clips) {
    const tr = seq.tracks.find((t) => t.id === c.trackId);
    if (!tr || tr.kind !== 'video' || tr.locked) continue;
    if (c.motion.scale.animated && c.motion.scale.keyframes?.length) continue;
    if (c.duration <= interval) continue;
    const base = typeof c.motion.scale.value === 'number' ? c.motion.scale.value : 100;
    const kfs: Clip['motion']['scale']['keyframes'] = [];
    const peak = Math.round(interval * 0.4);
    for (let t = 0; t + interval < c.duration; t += interval) {
      kfs.push({ t, v: base, interp: 'linear' });
      kfs.push({ t: t + peak, v: Math.round(base * (1 + ampPct / 100) * 10) / 10, interp: 'easeOut' });
      kfs.push({ t: t + interval, v: base, interp: 'easeIn' });
    }
    if (!kfs.length) continue;
    c.motion.scale = { value: base, animated: true, keyframes: kfs };
    touched++;
  }
  return touched;
}

/* ---------- 2-second reset: flash on every cut ---------- */

/** Apply a quick white flash transition at every cut on unlocked video tracks. */
export function addFlashOnCuts(seq: Sequence, frames = 4): number {
  const fps = seq.settings.fps;
  const dur = Math.max(2, Math.min(frames, Math.round(fps * 0.2)));
  let added = 0;
  for (const tr of seq.tracks) {
    if (tr.kind !== 'video' || tr.locked) continue;
    const clips = E.clipsOnTrackSorted(seq, tr.id);
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const prev = clips[i - 1];
      if (!prev || E.clipEnd(prev) !== c.start) continue;
      if (c.transitionIn || prev.transitionOut) continue;
      if (E.addTransition(seq, c.id, 'in', 'colorWash', dur, 'center')) added++;
    }
  }
  return added;
}

/* ---------- Infinite loop outro ---------- */

/**
 * Duplicate the first `loopSec` of the sequence onto the end (with a
 * crossfade at the join) so the video restarts before the viewer notices it
 * ended. Returns the number of clips appended.
 */
export function makeLoopOutro(seq: Sequence, loopSec = 1): { added: number; error?: string } {
  const fps = seq.settings.fps;
  const L = Math.max(1, Math.round(loopSec * fps));
  const D = sequenceDuration(seq);
  if (D <= L + 2) return { added: 0, error: 'The sequence is too short to loop - it needs to be longer than the loop section.' };

  // Isolate the head with razor cuts on every unlocked track.
  E.razorAt(seq, L);
  const head = seq.clips.filter((c) => c.start < L && E.clipEnd(c) <= L && !seq.tracks.find((t) => t.id === c.trackId)?.locked);
  if (!head.length) return { added: 0, error: 'There is no media in the first second to loop back to.' };

  const joins: { copy: Clip; prev: Clip; kind: 'video' | 'audio' }[] = [];
  let added = 0;
  for (const c of head) {
    const tr = seq.tracks.find((t) => t.id === c.trackId);
    if (!tr || tr.locked) continue;
    const copy = makeClip({
      ...JSON.parse(JSON.stringify(c)),
      id: uid('clip'),
      start: D + c.start,
      transitionIn: null,
      transitionOut: null,
      linkId: null,
      groupId: null,
    });
    seq.clips.push(copy);
    added++;
    if (c.start === 0) {
      const onTrack = E.clipsOnTrackSorted(seq, tr.id);
      const prev = onTrack.filter((x) => x.id !== copy.id).find((x) => E.clipEnd(x) === D);
      if (prev) joins.push({ copy, prev, kind: tr.kind === 'video' ? 'video' : 'audio' });
    }
  }
  const fadeFrames = Math.max(2, Math.round(fps * 0.35));
  for (const j of joins) {
    if (j.kind === 'video') E.addTransition(seq, j.copy.id, 'in', 'crossDissolve', Math.min(fadeFrames, Math.floor(j.copy.duration / 2)), 'center');
    else E.addTransition(seq, j.copy.id, 'in', 'constantPower', Math.min(fadeFrames, Math.floor(j.copy.duration / 2)), 'center');
  }
  return { added };
}

/* ---------- Rewind trap (split-second easter egg) ---------- */

export interface RewindTrapOptions {
  kind: 'text' | 'image';
  text: string;
  assetId?: Id;
  /** Corner the trap sits in. */
  corner: 'tl' | 'tr' | 'bl' | 'br';
  /** On-screen time in frames (1-3 is a subconscious flash). */
  frames: number;
  /** Text size as a fraction of the frame height. */
  size?: number;
}

export function buildTrapDocument(seq: Sequence, project: Project, opts: RewindTrapOptions): GraphicDocument {
  const W = seq.settings.width;
  const H = seq.settings.height;
  const margin = Math.round(W * 0.06);
  const cx = opts.corner === 'tl' || opts.corner === 'bl' ? margin : W - margin;
  const cy = opts.corner === 'tl' || opts.corner === 'tr' ? Math.round(H * 0.1) : H - Math.round(H * 0.1);
  const layers: GraphicDocument['layers'] = [];
  if (opts.kind === 'text') {
    const fontSize = Math.max(16, Math.round(H * (opts.size ?? 0.05)));
    const layer: TextLayer = {
      id: uid('gl'),
      kind: 'text',
      name: 'Rewind Trap',
      visible: true,
      locked: false,
      x: param(cx),
      y: param(cy),
      scale: param(100),
      rotation: param(0),
      opacity: param(100),
      anchor: 'center',
      pin: 'none',
      fill: '#ffffff',
      fillEnabled: true,
      stroke: '#000000',
      strokeWidth: 0,
      strokeEnabled: false,
      shadowEnabled: false,
      shadowColor: '#000000',
      shadowBlur: 8,
      shadowOffsetX: 0,
      shadowOffsetY: 4,
      shadowOpacity: 0.6,
      blend: 'source-over',
      text: opts.text || 'nice try',
      fontFamily: 'Inter Variable',
      fontSize,
      fontWeight: 800,
      italic: false,
      underline: false,
      allCaps: true,
      tracking: 0,
      leading: 1.15,
      align: 'center',
      verticalAlign: 'middle',
      boxWidth: 0,
      boxHeight: 0,
      background: { enabled: true, color: '#000000', opacity: 0.75, padding: Math.round(fontSize * 0.35), radius: Math.round(fontSize * 0.2) },
      tabularNums: false,
      animIn: { type: 'scale', duration: 0.06, delay: 0, easing: 'easeOut' },
    };
    layers.push(layer);
  } else if (opts.assetId) {
    const asset = project.assets.find((a) => a.id === opts.assetId);
    const aw = asset?.width ?? W * 0.2;
    const ah = asset?.height ?? H * 0.2;
    const w = Math.round(W * 0.22);
    const h = Math.round((ah / Math.max(1, aw)) * w);
    const layer: ImageLayer = {
      id: uid('gl'),
      kind: 'image',
      name: 'Rewind Trap',
      visible: true,
      locked: false,
      x: param(cx),
      y: param(cy),
      scale: param(100),
      rotation: param(0),
      opacity: param(100),
      anchor: 'center',
      pin: 'none',
      fill: '#ffffff',
      fillEnabled: true,
      stroke: '#000000',
      strokeWidth: 0,
      strokeEnabled: false,
      shadowEnabled: false,
      shadowColor: '#000000',
      shadowBlur: 8,
      shadowOffsetX: 0,
      shadowOffsetY: 4,
      shadowOpacity: 0.6,
      blend: 'source-over',
      assetId: opts.assetId,
      width: w,
      height: h,
      animIn: { type: 'scale', duration: 0.06, delay: 0, easing: 'easeOut' },
    };
    layers.push(layer);
  }
  return { layers, introProtect: 0, outroProtect: 0 };
}

/** Insert a rewind trap as a split-second graphic clip at `frame` on the topmost video track. */
export function insertRewindTrap(seq: Sequence, project: Project, frame: number, opts: RewindTrapOptions): Clip | null {
  const frames = Math.max(1, Math.min(3, Math.round(opts.frames)));
  const videoTracks = seq.tracks.filter((t) => t.kind === 'video');
  if (!videoTracks.length) return null;
  let top = videoTracks[videoTracks.length - 1];
  if (top.locked) {
    top = E.addTrack(seq, 'video');
  }
  const doc = buildTrapDocument(seq, project, opts);
  const clip = makeClip({
    trackId: top.id,
    start: frame,
    duration: frames,
    assetId: null,
    name: 'Rewind Trap',
    generator: 'graphic',
    graphic: doc,
    label: 'yellow',
  });
  seq.clips.push(clip);
  return clip;
}

/* ---------- Comment section baiting ---------- */

/**
 * Plant one obvious, minor mistake: swap two adjacent letters in a random
 * word of a random caption. Viewers flood the comments to correct it.
 * Returns the caption text after the change, or null if nothing was changed.
 */
export function plantTypoBait(seq: Sequence): { id: Id; before: string; after: string } | null {
  const candidates = seq.captions.filter((c) => c.text.split(/\s+/).some((w) => w.replace(/\*/g, '').length >= 4));
  if (!candidates.length) return null;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  const words = pick.text.split(/\s+/).map((w) => w.replace(/\*/g, ''));
  const eligible = words.map((w, i) => ({ w, i })).filter((x) => x.w.length >= 4);
  const { w, i } = eligible[Math.floor(Math.random() * eligible.length)];
  const pos = 1 + Math.floor(Math.random() * (w.length - 2));
  const swapped = w.slice(0, pos) + w[pos + 1] + w[pos] + w.slice(pos + 2);
  words[i] = swapped;
  const before = pick.text;
  pick.text = words.join(' ');
  return { id: pick.id, before, after: pick.text };
}
