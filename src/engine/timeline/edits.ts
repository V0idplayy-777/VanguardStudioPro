import type { Clip, Id, MediaAsset, Project, Sequence, Track, Transition } from '../../types/project';
import { param } from '../../types/project';
import { uid, deepClone } from '../util';
import { clipsOnTrack, makeClip, newTrack, renumberTracks } from '../../state/projectStore';
import { shiftKeyframes } from '../keyframes';
import { TRANSITION_MAP } from '../effects/transitions';
import { settings } from '../../state/settingsStore';

/*
  Pure-ish timeline operations. They mutate the passed Sequence (which is a
  shallow copy inside a store update) and return useful ids. All positions are
  frames.
*/

export function clipEnd(c: Clip) {
  return c.start + c.duration;
}

/** Source seconds at a given timeline frame inside clip. */
export function sourceTimeAt(clip: Clip, frame: number, fps: number): number {
  const local = Math.max(0, frame - clip.start);
  if (clip.freezeAt !== undefined) return clip.freezeAt;
  const secs = local / fps;
  if (clip.timeRemap && clip.timeRemap.length >= 2) {
    // integrate speed keyframes (percent) - piecewise linear speed
    let t = 0;
    const kfs = clip.timeRemap;
    let prevT = 0,
      prevV = kfs[0].v / 100;
    for (let i = 0; i < kfs.length; i++) {
      const k = kfs[i];
      const kt = k.t / fps;
      const kv = k.v / 100;
      if (secs <= kt) {
        const dt = secs - prevT;
        const frac = kt > prevT ? dt / (kt - prevT) : 0;
        const vAtS = prevV + (kv - prevV) * frac;
        t += dt * (prevV + vAtS) / 2;
        return clip.inPoint + (clip.reversed ? -t : t);
      }
      t += (kt - prevT) * (prevV + kv) / 2;
      prevT = kt;
      prevV = kv;
    }
    t += (secs - prevT) * prevV;
    return clip.inPoint + (clip.reversed ? -t : t);
  }
  const s = secs * clip.speed;
  return clip.reversed ? clip.inPoint - s : clip.inPoint + s;
}

/** Duration in source seconds consumed by the clip. */
export function sourceSpan(clip: Clip, fps: number): number {
  return (clip.duration / fps) * clip.speed;
}

export function assetDurationFrames(asset: MediaAsset | undefined, fps: number, stillFrames: number): number {
  if (!asset) return stillFrames;
  if (asset.kind === 'image' || asset.kind === 'generator') return stillFrames;
  return Math.max(1, Math.round((asset.duration ?? 5) * fps));
}

export function overlapping(seq: Sequence, trackId: Id, start: number, end: number, exclude: Set<Id> = new Set()): Clip[] {
  return seq.clips.filter((c) => c.trackId === trackId && !exclude.has(c.id) && c.start < end && clipEnd(c) > start);
}

/** Remove the part of any clip on the track inside [start, end). Splits clips that straddle. */
export function clearRange(seq: Sequence, trackId: Id, start: number, end: number, exclude: Set<Id> = new Set()) {
  const hits = overlapping(seq, trackId, start, end, exclude);
  const fps = seq.settings.fps;
  for (const c of hits) {
    const cs = c.start,
      ce = clipEnd(c);
    if (cs >= start && ce <= end) {
      seq.clips = seq.clips.filter((x) => x.id !== c.id);
      continue;
    }
    if (cs < start && ce > end) {
      // split into two
      const right = splitClipAt(seq, c, end, fps);
      trimClipEnd(c, start, fps);
      if (right) {
        // ensure right side begins at end
        void right;
      }
      continue;
    }
    if (cs < start) {
      trimClipEnd(c, start, fps);
    } else {
      trimClipStart(c, end, fps);
    }
  }
}

/** Trim the head of the clip to newStart (keeps timeline alignment of content). */
export function trimClipStart(c: Clip, newStart: number, fps: number) {
  const delta = newStart - c.start;
  if (delta === 0) return;
  const srcDelta = (delta / fps) * c.speed * (c.reversed ? -1 : 1);
  c.inPoint += srcDelta;
  c.start = newStart;
  c.duration -= delta;
  shiftClipKeyframes(c, -delta);
  if (c.transitionIn && c.transitionIn.duration > c.duration) c.transitionIn.duration = Math.max(1, Math.floor(c.duration / 2));
}

export function trimClipEnd(c: Clip, newEnd: number, fps: number) {
  c.duration = Math.max(1, newEnd - c.start);
  if (c.transitionOut && c.transitionOut.duration > c.duration) c.transitionOut.duration = Math.max(1, Math.floor(c.duration / 2));
}

export function shiftClipKeyframes(c: Clip, delta: number) {
  if (delta === 0) return;
  const m = c.motion;
  m.position = shiftKeyframes(m.position, delta);
  m.scale = shiftKeyframes(m.scale, delta);
  m.scaleWidth = shiftKeyframes(m.scaleWidth, delta);
  m.rotation = shiftKeyframes(m.rotation, delta);
  m.anchor = shiftKeyframes(m.anchor, delta);
  m.opacity = shiftKeyframes(m.opacity, delta);
  c.audio.volume = shiftKeyframes(c.audio.volume, delta);
  c.audio.pan = shiftKeyframes(c.audio.pan, delta);
  for (const e of c.effects) {
    for (const k of Object.keys(e.params)) e.params[k] = shiftKeyframes(e.params[k], delta);
    for (const mk of e.masks) {
      mk.center = shiftKeyframes(mk.center, delta);
      mk.size = shiftKeyframes(mk.size, delta);
      mk.rotation = shiftKeyframes(mk.rotation, delta);
      mk.feather = shiftKeyframes(mk.feather, delta);
      mk.opacity = shiftKeyframes(mk.opacity, delta);
      mk.expansion = shiftKeyframes(mk.expansion, delta);
    }
  }
  if (c.timeRemap) c.timeRemap = c.timeRemap.map((k) => ({ ...k, t: k.t + delta }));
  for (const mk of c.markers) mk.time += delta;
}

/** Split clip at frame. Returns the new right-hand clip, or null if the frame is not strictly inside. */
export function splitClipAt(seq: Sequence, c: Clip, frame: number, fps: number): Clip | null {
  if (frame <= c.start || frame >= clipEnd(c)) return null;
  const right = deepClone(c);
  right.id = uid('clip');
  right.transitionIn = null;
  c.transitionOut = null;
  const leftDur = frame - c.start;
  right.start = frame;
  right.duration = c.duration - leftDur;
  right.inPoint = sourceTimeAt(c, frame, fps);
  right.markers = c.markers.filter((m) => m.time >= leftDur).map((m) => ({ ...m, time: m.time - leftDur }));
  c.markers = c.markers.filter((m) => m.time < leftDur);
  shiftClipKeyframes(right, -leftDur);
  c.duration = leftDur;
  if (c.transitionIn && c.transitionIn.duration > c.duration) c.transitionIn.duration = Math.max(1, Math.floor(c.duration / 2));
  seq.clips.push(right);
  return right;
}

/** Razor all clips crossing the frame on given tracks (or all unlocked). Linked clips keep link ids so halves stay linked. */
export function razorAt(seq: Sequence, frame: number, trackIds?: Id[], onlyClipIds?: Id[]): Id[] {
  const fps = seq.settings.fps;
  const created: Id[] = [];
  const targets = seq.clips.filter((c) => {
    const tr = seq.tracks.find((t) => t.id === c.trackId);
    if (!tr || tr.locked) return false;
    if (trackIds && !trackIds.includes(c.trackId)) return false;
    if (onlyClipIds && !onlyClipIds.includes(c.id)) return false;
    return frame > c.start && frame < clipEnd(c);
  });
  // new link ids for right halves so they link to each other, not the left halves
  const linkMap = new Map<string, string>();
  for (const c of targets) {
    const r = splitClipAt(seq, c, frame, fps);
    if (r) {
      if (c.linkId) {
        if (!linkMap.has(c.linkId)) linkMap.set(c.linkId, uid('lnk'));
        r.linkId = linkMap.get(c.linkId)!;
      }
      created.push(r.id);
    }
  }
  return created;
}

export function ripple(seq: Sequence, fromFrame: number, delta: number, trackIds?: Id[], excludeClipIds: Set<Id> = new Set()) {
  for (const c of seq.clips) {
    if (excludeClipIds.has(c.id)) continue;
    const tr = seq.tracks.find((t) => t.id === c.trackId);
    if (!tr) continue;
    if (trackIds && !trackIds.includes(c.trackId) && !tr.syncLocked) continue;
    if (tr.locked) continue;
    if (c.start >= fromFrame) c.start = Math.max(0, c.start + delta);
  }
  for (const m of seq.markers) if (m.time >= fromFrame) m.time = Math.max(0, m.time + delta);
  for (const cp of seq.captions)
    if (cp.start >= fromFrame) {
      cp.start = Math.max(0, cp.start + delta);
      cp.end = Math.max(cp.start + 1, cp.end + delta);
    }
}

export interface PlaceOptions {
  mode: 'insert' | 'overwrite';
  /** Track ids to use per stream. */
  videoTrackId?: Id | null;
  audioTrackId?: Id | null;
  /** Source in/out seconds. */
  srcIn?: number;
  srcOut?: number;
  /** For stills / generators the duration in frames. */
  stillFrames?: number;
  /** Which streams to take. */
  take?: 'both' | 'video' | 'audio';
  /** Override name. */
  name?: string;
}

/** Add an asset to the sequence at frame. Returns created clip ids. */
export function placeAsset(project: Project, seq: Sequence, asset: MediaAsset, frame: number, opts: PlaceOptions): Id[] {
  const fps = seq.settings.fps;
  const stillFrames = opts.stillFrames ?? project.settings.defaultStillDuration;
  const srcIn = opts.srcIn ?? asset.srcIn ?? 0;
  const srcOut = opts.srcOut ?? asset.srcOut ?? asset.duration ?? undefined;
  const totalFrames = asset.kind === 'image' || asset.kind === 'generator' ? stillFrames : Math.max(1, Math.round(((srcOut ?? asset.duration ?? 5) - srcIn) * fps));
  const take = opts.take ?? 'both';
  const wantVideo = (asset.hasVideo || asset.kind === 'image' || asset.kind === 'generator' || asset.kind === 'sequence') && take !== 'audio';
  const wantAudio = asset.hasAudio && take !== 'video';
  const vTrack = opts.videoTrackId ? seq.tracks.find((t) => t.id === opts.videoTrackId) : seq.tracks.find((t) => t.kind === 'video' && t.targeted) ?? seq.tracks.find((t) => t.kind === 'video');
  const aTrack = opts.audioTrackId ? seq.tracks.find((t) => t.id === opts.audioTrackId) : seq.tracks.find((t) => t.kind === 'audio' && t.targeted) ?? seq.tracks.find((t) => t.kind === 'audio');
  const created: Id[] = [];
  const linkId = wantVideo && wantAudio ? uid('lnk') : null;
  const label = asset.label;
  const name = opts.name ?? asset.name;

  const touchedTracks: Id[] = [];
  if (wantVideo && vTrack && !vTrack.locked) touchedTracks.push(vTrack.id);
  if (wantAudio && aTrack && !aTrack.locked) touchedTracks.push(aTrack.id);
  if (!touchedTracks.length) return created;

  if (opts.mode === 'insert') {
    // split anything crossing frame on touched tracks (and sync-locked tracks), then ripple
    for (const tid of touchedTracks) razorAt(seq, frame, [tid]);
    const syncTracks = seq.tracks.filter((t) => t.syncLocked && !t.locked).map((t) => t.id);
    for (const tid of syncTracks) if (!touchedTracks.includes(tid)) razorAt(seq, frame, [tid]);
    ripple(seq, frame, totalFrames, [...new Set([...touchedTracks, ...syncTracks])]);
  } else {
    for (const tid of touchedTracks) clearRange(seq, tid, frame, frame + totalFrames);
  }

  if (wantVideo && vTrack && !vTrack.locked) {
    const clip = makeClip({
      trackId: vTrack.id,
      start: frame,
      duration: totalFrames,
      assetId: asset.id,
      name,
      inPoint: srcIn,
      label,
      linkId,
      nestedSequenceId: asset.kind === 'sequence' ? asset.sequenceId : undefined,
      generator: asset.generator,
      generatorParams: asset.generatorParams ? { ...asset.generatorParams } : undefined,
      graphic: asset.graphic ? deepClone(asset.graphic) : undefined,
    });
    // Settings > Import: scale placed media to fit or fill the frame.
    const scaleMode = settings().importScaleMode;
    if (scaleMode !== 'native' && (asset.kind === 'video' || asset.kind === 'image') && asset.width && asset.height) {
      const f = scaleMode === 'fit' ? Math.min : Math.max;
      const s = f(seq.settings.width / asset.width, seq.settings.height / asset.height) * 100;
      clip.motion.scale = param(Math.round(s * 10) / 10);
    }
    seq.clips.push(clip);
    created.push(clip.id);
  }
  if (wantAudio && aTrack && !aTrack.locked) {
    const clip = makeClip({
      trackId: aTrack.id,
      start: frame,
      duration: totalFrames,
      assetId: asset.id,
      name,
      inPoint: srcIn,
      label: asset.kind === 'audio' ? label : 'forest',
      linkId,
      nestedSequenceId: asset.kind === 'sequence' ? asset.sequenceId : undefined,
    });
    seq.clips.push(clip);
    created.push(clip.id);
  }
  return created;
}

export function linkedClips(seq: Sequence, clip: Clip): Clip[] {
  if (!clip.linkId) return [clip];
  return seq.clips.filter((c) => c.linkId === clip.linkId);
}

export function groupedClips(seq: Sequence, clip: Clip): Clip[] {
  if (!clip.groupId) return [clip];
  return seq.clips.filter((c) => c.groupId === clip.groupId);
}

/** Expand a selection to include linked and grouped partners. */
export function expandSelection(seq: Sequence, ids: Id[], linkedSelection: boolean): Id[] {
  const out = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...out]) {
      const c = seq.clips.find((x) => x.id === id);
      if (!c) continue;
      const partners = [...(linkedSelection ? linkedClips(seq, c) : []), ...groupedClips(seq, c)];
      for (const p of partners)
        if (!out.has(p.id)) {
          out.add(p.id);
          changed = true;
        }
    }
  }
  return [...out];
}

export function deleteClips(seq: Sequence, ids: Id[], rippleAfter = false) {
  const targets = seq.clips.filter((c) => ids.includes(c.id));
  if (!targets.length) return;
  const fps = seq.settings.fps;
  void fps;
  seq.clips = seq.clips.filter((c) => !ids.includes(c.id));
  if (rippleAfter) {
    // Ripple each removed range (process from right to left so earlier ranges are unaffected)
    const ranges = targets.map((c) => ({ start: c.start, end: clipEnd(c), track: c.trackId })).sort((a, b) => b.start - a.start);
    for (const r of ranges) {
      // only ripple if nothing else remains in the gap on that track
      const stillThere = overlapping(seq, r.track, r.start, r.end);
      if (stillThere.length) continue;
      const gapEnd = Math.min(r.end, ...clipsOnTrack(seq, r.track).filter((c) => c.start >= r.start).map((c) => c.start));
      const delta = -(gapEnd - r.start);
      if (delta < 0) ripple(seq, r.end, delta);
    }
  }
}

export function moveClips(seq: Sequence, ids: Id[], deltaFrames: number, trackShift: Map<Id, Id> | null, mode: 'overwrite' | 'insert' = 'overwrite') {
  const moving = seq.clips.filter((c) => ids.includes(c.id));
  if (!moving.length) return;
  const minStart = Math.min(...moving.map((c) => c.start));
  if (minStart + deltaFrames < 0) deltaFrames = -minStart;
  const exclude = new Set(ids);
  // apply track and time
  const newPos = moving.map((c) => ({ c, start: c.start + deltaFrames, trackId: trackShift?.get(c.id) ?? c.trackId }));
  if (mode === 'insert') {
    const target = Math.min(...newPos.map((p) => p.start));
    const span = Math.max(...newPos.map((p) => p.start + p.c.duration)) - target;
    for (const tid of new Set(newPos.map((p) => p.trackId))) razorAt(seq, target, [tid]);
    ripple(seq, target, span, undefined, exclude);
  } else {
    for (const p of newPos) clearRange(seq, p.trackId, p.start, p.start + p.c.duration, exclude);
  }
  for (const p of newPos) {
    p.c.start = p.start;
    p.c.trackId = p.trackId;
  }
}

/** Ripple trim: adjust clip edge and shift everything after by the change. */
export function rippleTrim(seq: Sequence, clipId: Id, edge: 'start' | 'end', newFrame: number) {
  const c = seq.clips.find((x) => x.id === clipId);
  if (!c) return;
  const fps = seq.settings.fps;
  const linked = linkedClips(seq, c);
  if (edge === 'start') {
    const delta = newFrame - c.start;
    for (const l of linked) {
      if (l.start === c.start) {
        trimClipStart(l, newFrame, fps);
        l.start = c.start === newFrame ? l.start : l.start; // keep
      }
    }
    // shift the trimmed clips back so the cut point stays where it was, then ripple everything after
    for (const l of linked) if (l.start === newFrame) l.start -= delta;
    ripple(seq, newFrame - delta + 1, -delta, undefined, new Set(linked.map((l) => l.id)));
  } else {
    const oldEnd = clipEnd(c);
    const delta = newFrame - oldEnd;
    for (const l of linked) if (clipEnd(l) === oldEnd) trimClipEnd(l, newFrame, fps);
    ripple(seq, oldEnd, delta, undefined, new Set(linked.map((l) => l.id)));
  }
}

/** Rolling edit: move the cut between two adjacent clips. */
export function rollEdit(seq: Sequence, leftId: Id, rightId: Id, newFrame: number) {
  const l = seq.clips.find((x) => x.id === leftId);
  const r = seq.clips.find((x) => x.id === rightId);
  if (!l || !r) return;
  const fps = seq.settings.fps;
  const minF = l.start + 1;
  const maxF = clipEnd(r) - 1;
  const f = Math.max(minF, Math.min(maxF, newFrame));
  trimClipEnd(l, f, fps);
  trimClipStart(r, f, fps);
}

/** Slip: change source in point without moving the clip. */
export function slipClip(seq: Sequence, clipId: Id, deltaFrames: number, asset?: MediaAsset) {
  const c = seq.clips.find((x) => x.id === clipId);
  if (!c) return;
  const fps = seq.settings.fps;
  let newIn = c.inPoint + (deltaFrames / fps) * c.speed * (c.reversed ? -1 : 1);
  if (asset?.duration !== undefined && asset.kind !== 'image') {
    const span = sourceSpan(c, fps);
    newIn = Math.max(0, Math.min(asset.duration - span, newIn));
  } else newIn = Math.max(0, newIn);
  c.inPoint = newIn;
}

/** Slide: move a clip in time while trimming neighbours to compensate. */
export function slideClip(seq: Sequence, clipId: Id, deltaFrames: number) {
  const c = seq.clips.find((x) => x.id === clipId);
  if (!c) return;
  const fps = seq.settings.fps;
  const onTrack = clipsOnTrack(seq, c.trackId);
  const idx = onTrack.findIndex((x) => x.id === clipId);
  const prev = onTrack[idx - 1];
  const next = onTrack[idx + 1];
  const newStart = c.start + deltaFrames;
  const newEnd = clipEnd(c) + deltaFrames;
  if (prev && newStart <= prev.start + 1) return;
  if (next && newEnd >= clipEnd(next) - 1) return;
  if (!prev && newStart < 0) return;
  if (prev && clipEnd(prev) === c.start) trimClipEnd(prev, newStart, fps);
  if (next && next.start === clipEnd(c)) trimClipStart(next, newEnd, fps);
  c.start = newStart;
}

export function setClipSpeed(seq: Sequence, clipId: Id, speed: number, opts: { rippleAfter?: boolean; reverse?: boolean; maintainPitch?: boolean; keepDuration?: boolean } = {}) {
  const c = seq.clips.find((x) => x.id === clipId);
  if (!c) return;
  const fps = seq.settings.fps;
  const oldEnd = clipEnd(c);
  const srcSpan = sourceSpan(c, fps);
  const newSpeed = Math.max(0.01, Math.abs(speed));
  if (!opts.keepDuration) {
    const newDur = Math.max(1, Math.round((srcSpan / newSpeed) * fps));
    const delta = newDur - c.duration;
    c.duration = newDur;
    if (delta > 0 && !opts.rippleAfter) {
      // overwrite mode: trim to next clip
      const nxt = clipsOnTrack(seq, c.trackId).find((x) => x.id !== c.id && x.start >= oldEnd);
      if (nxt && clipEnd(c) > nxt.start) c.duration = nxt.start - c.start;
    }
    if (opts.rippleAfter && delta !== 0) ripple(seq, oldEnd, delta, undefined, new Set([c.id]));
  }
  c.speed = newSpeed;
  if (opts.reverse !== undefined) c.reversed = opts.reverse;
  if (opts.maintainPitch !== undefined) c.maintainPitch = opts.maintainPitch;
}

export function addTransition(seq: Sequence, clipId: Id, edge: 'in' | 'out', type: string, duration: number, alignment: Transition['alignment'] = 'center'): boolean {
  const c = seq.clips.find((x) => x.id === clipId);
  if (!c) return false;
  const def = TRANSITION_MAP[type];
  if (!def) return false;
  const params: Transition['params'] = {};
  for (const p of def.params) params[p.key] = param(p.default);
  const tr: Transition = { id: uid('tr'), type, duration: Math.max(1, Math.min(duration, Math.floor(c.duration))), alignment, params };
  if (edge === 'in') c.transitionIn = tr;
  else c.transitionOut = tr;
  // Mirror on neighbour so both clips know about it
  const onTrack = clipsOnTrack(seq, c.trackId);
  const idx = onTrack.findIndex((x) => x.id === clipId);
  const neighbour = edge === 'in' ? onTrack[idx - 1] : onTrack[idx + 1];
  const adjacent = neighbour && (edge === 'in' ? clipEnd(neighbour) === c.start : neighbour.start === clipEnd(c));
  if (adjacent) {
    const mirror: Transition = { ...tr, id: uid('tr'), params: deepClone(params) };
    if (edge === 'in') neighbour!.transitionOut = mirror;
    else neighbour!.transitionIn = mirror;
  }
  return true;
}

export function removeTransition(seq: Sequence, clipId: Id, edge: 'in' | 'out') {
  const c = seq.clips.find((x) => x.id === clipId);
  if (!c) return;
  const onTrack = clipsOnTrack(seq, c.trackId);
  const idx = onTrack.findIndex((x) => x.id === clipId);
  const neighbour = edge === 'in' ? onTrack[idx - 1] : onTrack[idx + 1];
  if (edge === 'in') {
    c.transitionIn = null;
    if (neighbour && clipEnd(neighbour) === c.start) neighbour.transitionOut = null;
  } else {
    c.transitionOut = null;
    if (neighbour && neighbour.start === clipEnd(c)) neighbour.transitionIn = null;
  }
}

/** Neighbour transition partner info for rendering a transition across a cut. */
export function transitionAtCut(seq: Sequence, clip: Clip, edge: 'in' | 'out'): { transition: Transition; from: Clip | null; to: Clip | null } | null {
  const tr = edge === 'in' ? clip.transitionIn : clip.transitionOut;
  if (!tr) return null;
  const onTrack = clipsOnTrack(seq, clip.trackId);
  const idx = onTrack.findIndex((x) => x.id === clip.id);
  if (edge === 'in') {
    const prev = onTrack[idx - 1];
    return { transition: tr, from: prev && clipEnd(prev) === clip.start ? prev : null, to: clip };
  }
  const next = onTrack[idx + 1];
  return { transition: tr, from: clip, to: next && next.start === clipEnd(clip) ? next : null };
}

/** Transition span in timeline frames [start, end) for a clip edge. */
export function transitionRange(seq: Sequence, clip: Clip, edge: 'in' | 'out'): [number, number] | null {
  const info = transitionAtCut(seq, clip, edge);
  if (!info) return null;
  const { transition: tr } = info;
  const cut = edge === 'in' ? clip.start : clipEnd(clip);
  const hasPartner = edge === 'in' ? !!info.from : !!info.to;
  if (!hasPartner) {
    // fade from/to nothing: sits fully inside the clip
    return edge === 'in' ? [cut, cut + tr.duration] : [cut - tr.duration, cut];
  }
  if (tr.alignment === 'start') return [cut, cut + tr.duration];
  if (tr.alignment === 'end') return [cut - tr.duration, cut];
  const half = Math.floor(tr.duration / 2);
  return [cut - half, cut - half + tr.duration];
}

export function addTrack(seq: Sequence, kind: 'video' | 'audio', atIndex?: number): Track {
  const sameKind = seq.tracks.filter((t) => t.kind === kind);
  const tr = newTrack(kind, sameKind.length);
  if (kind === 'video') {
    // video tracks are stored V1..Vn ascending; insert after index
    const insertAt = atIndex === undefined ? sameKind.length : Math.min(atIndex, sameKind.length);
    const globalIdx = seq.tracks.indexOf(sameKind[insertAt]) === -1 ? seq.tracks.filter((t) => t.kind === 'video').length : seq.tracks.indexOf(sameKind[insertAt]);
    seq.tracks.splice(globalIdx, 0, tr);
  } else {
    const insertAt = atIndex === undefined ? sameKind.length : Math.min(atIndex, sameKind.length);
    const base = seq.tracks.findIndex((t) => t.kind === 'audio');
    const idx = base === -1 ? seq.tracks.length : base + insertAt;
    seq.tracks.splice(idx, 0, tr);
  }
  renumberTracks(seq);
  return tr;
}

export function deleteTrack(seq: Sequence, trackId: Id) {
  seq.clips = seq.clips.filter((c) => c.trackId !== trackId);
  seq.tracks = seq.tracks.filter((t) => t.id !== trackId);
  renumberTracks(seq);
}

export function deleteEmptyTracks(seq: Sequence) {
  const used = new Set(seq.clips.map((c) => c.trackId));
  const v = seq.tracks.filter((t) => t.kind === 'video');
  const a = seq.tracks.filter((t) => t.kind === 'audio');
  const keep = (list: Track[]) => {
    const kept = list.filter((t) => used.has(t.id));
    if (!kept.length && list.length) kept.push(list[0]);
    return kept;
  };
  const keepIds = new Set([...keep(v), ...keep(a), ...seq.tracks.filter((t) => t.kind === 'caption')].map((t) => t.id));
  seq.tracks = seq.tracks.filter((t) => keepIds.has(t.id));
  renumberTracks(seq);
}

/** Nest selected clips into a new sequence; returns the new sequence. */
export function nestClips(project: Project, seq: Sequence, ids: Id[], name: string): Sequence | null {
  const clips = seq.clips.filter((c) => ids.includes(c.id));
  if (!clips.length) return null;
  const start = Math.min(...clips.map((c) => c.start));
  const end = Math.max(...clips.map(clipEnd));
  const nested: Sequence = {
    id: uid('seq'),
    name,
    settings: { ...seq.settings },
    tracks: [],
    clips: [],
    markers: [],
    captions: [],
    captionTrack: { ...seq.captionTrack, style: { ...seq.captionTrack.style } },
    inPoint: null,
    outPoint: null,
    workArea: { enabled: false, start: 0, end: end - start },
    view: { pixelsPerFrame: seq.view.pixelsPerFrame, scrollFrame: 0, scrollY: 0, playhead: 0 },
    label: 'iris',
    binId: null,
    createdAt: Date.now(),
    modifiedAt: Date.now(),
  };
  // map tracks used
  const usedTrackIds = [...new Set(clips.map((c) => c.trackId))];
  const trackMap = new Map<Id, Id>();
  const vUsed = seq.tracks.filter((t) => t.kind === 'video' && usedTrackIds.includes(t.id));
  const aUsed = seq.tracks.filter((t) => t.kind === 'audio' && usedTrackIds.includes(t.id));
  const vCount = Math.max(1, vUsed.length),
    aCount = Math.max(1, aUsed.length);
  for (let i = 0; i < vCount; i++) nested.tracks.push(newTrack('video', i));
  for (let i = 0; i < aCount; i++) nested.tracks.push(newTrack('audio', i));
  nested.tracks[0].targeted = true;
  const firstAudio = nested.tracks.find((t) => t.kind === 'audio');
  if (firstAudio) firstAudio.targeted = true;
  vUsed.forEach((t, i) => trackMap.set(t.id, nested.tracks.filter((x) => x.kind === 'video')[i].id));
  aUsed.forEach((t, i) => trackMap.set(t.id, nested.tracks.filter((x) => x.kind === 'audio')[i].id));
  for (const c of clips) {
    const nc = deepClone(c);
    nc.start -= start;
    nc.trackId = trackMap.get(c.trackId)!;
    nested.clips.push(nc);
  }
  project.sequences.push(nested);
  // asset entry for the nested sequence
  const asset: MediaAsset = {
    id: uid('ast'),
    kind: 'sequence',
    name,
    binId: null,
    label: 'iris',
    duration: (end - start) / seq.settings.fps,
    width: seq.settings.width,
    height: seq.settings.height,
    fps: seq.settings.fps,
    hasVideo: vUsed.length > 0 || true,
    hasAudio: aUsed.length > 0,
    sequenceId: nested.id,
    offline: false,
    createdAt: Date.now(),
    meta: {},
  };
  project.assets.push(asset);
  // replace in parent
  seq.clips = seq.clips.filter((c) => !ids.includes(c.id));
  const vTrack = vUsed[0] ?? seq.tracks.find((t) => t.kind === 'video');
  const aTrack = aUsed[0] ?? null;
  const linkId = aTrack ? uid('lnk') : null;
  if (vTrack) {
    seq.clips.push(
      makeClip({ trackId: vTrack.id, start, duration: end - start, assetId: asset.id, name, label: 'iris', nestedSequenceId: nested.id, linkId }),
    );
  }
  if (aTrack && aUsed.length) {
    seq.clips.push(
      makeClip({ trackId: aTrack.id, start, duration: end - start, assetId: asset.id, name, label: 'iris', nestedSequenceId: nested.id, linkId }),
    );
  }
  return nested;
}

export function snapCandidates(seq: Sequence, excludeIds: Set<Id>, playhead: number): number[] {
  const pts = new Set<number>([0, playhead]);
  for (const c of seq.clips) {
    if (excludeIds.has(c.id)) continue;
    pts.add(c.start);
    pts.add(clipEnd(c));
  }
  for (const m of seq.markers) pts.add(m.time);
  if (seq.inPoint !== null) pts.add(seq.inPoint);
  if (seq.outPoint !== null) pts.add(seq.outPoint);
  return [...pts];
}

export function snapFrame(frame: number, candidates: number[], tolerance: number): { frame: number; snapped: boolean; to: number | null } {
  let best: number | null = null;
  let bestD = tolerance + 1;
  for (const c of candidates) {
    const d = Math.abs(c - frame);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  if (best !== null && bestD <= tolerance) return { frame: best, snapped: true, to: best };
  return { frame, snapped: false, to: null };
}

/** Find the edit points (cut positions) on the timeline. */
export function editPoints(seq: Sequence, trackIds?: Id[]): number[] {
  const pts = new Set<number>([0]);
  for (const c of seq.clips) {
    if (trackIds && !trackIds.includes(c.trackId)) continue;
    pts.add(c.start);
    pts.add(clipEnd(c));
  }
  return [...pts].sort((a, b) => a - b);
}

export function closeGap(seq: Sequence, trackId: Id, atFrame: number) {
  const onTrack = clipsOnTrack(seq, trackId);
  const next = onTrack.find((c) => c.start > atFrame);
  const prev = [...onTrack].reverse().find((c) => clipEnd(c) <= atFrame);
  const gapStart = prev ? clipEnd(prev) : 0;
  const gapEnd = next ? next.start : null;
  if (gapEnd === null || gapEnd <= gapStart) return;
  ripple(seq, gapEnd, -(gapEnd - gapStart));
}

export function selectionBounds(seq: Sequence, ids: Id[]): [number, number] | null {
  const clips = seq.clips.filter((c) => ids.includes(c.id));
  if (!clips.length) return null;
  return [Math.min(...clips.map((c) => c.start)), Math.max(...clips.map(clipEnd))];
}

/** Lift or extract the in/out range. */
export function liftRange(seq: Sequence, start: number, end: number, extract: boolean, trackIds?: Id[]) {
  const tracks = trackIds ?? seq.tracks.filter((t) => t.targeted && !t.locked).map((t) => t.id);
  for (const tid of tracks) clearRange(seq, tid, start, end);
  if (extract) ripple(seq, end, -(end - start), tracks);
}

export function duplicateClips(seq: Sequence, ids: Id[]): Id[] {
  const clips = seq.clips.filter((c) => ids.includes(c.id));
  if (!clips.length) return [];
  const end = Math.max(...clips.map(clipEnd));
  const start = Math.min(...clips.map((c) => c.start));
  const linkMap = new Map<string, string>();
  const out: Id[] = [];
  for (const c of clips) {
    const nc = deepClone(c);
    nc.id = uid('clip');
    nc.start = c.start - start + end;
    if (nc.linkId) {
      if (!linkMap.has(nc.linkId)) linkMap.set(nc.linkId, uid('lnk'));
      nc.linkId = linkMap.get(nc.linkId)!;
    }
    nc.groupId = null;
    clearRange(seq, nc.trackId, nc.start, clipEnd(nc));
    seq.clips.push(nc);
    out.push(nc.id);
  }
  return out;
}

/** Copy clips to a serialisable clipboard payload. */
export interface ClipboardPayload {
  kind: 'clips';
  clips: Clip[];
  origin: number;
  trackOrder: { id: Id; kind: string; index: number }[];
}

export function copyClips(seq: Sequence, ids: Id[]): ClipboardPayload | null {
  const clips = seq.clips.filter((c) => ids.includes(c.id));
  if (!clips.length) return null;
  const origin = Math.min(...clips.map((c) => c.start));
  const order = seq.tracks.map((t, i) => ({ id: t.id, kind: t.kind, index: seq.tracks.filter((x) => x.kind === t.kind).indexOf(t) }));
  return { kind: 'clips', clips: deepClone(clips), origin, trackOrder: order };
}

export function pasteClips(seq: Sequence, payload: ClipboardPayload, atFrame: number, insert: boolean): Id[] {
  const out: Id[] = [];
  const linkMap = new Map<string, string>();
  const groupMap = new Map<string, string>();
  // Map track: same kind and same index if it exists, else nearest targeted
  const resolveTrack = (oldTrackId: Id): Track | undefined => {
    const info = payload.trackOrder.find((t) => t.id === oldTrackId);
    if (!info) return seq.tracks.find((t) => t.kind === 'video');
    const same = seq.tracks.filter((t) => t.kind === info.kind);
    // relative to lowest used track index in payload vs targeted track
    const lowest = Math.min(...payload.clips.map((c) => payload.trackOrder.find((t) => t.id === c.trackId)?.index ?? 0).filter((_, i) => payload.trackOrder.find((t) => t.id === payload.clips[i].trackId)?.kind === info.kind));
    const targeted = same.findIndex((t) => t.targeted);
    const base = targeted >= 0 ? targeted : 0;
    const idx = base + (info.index - (isFinite(lowest) ? lowest : 0));
    return same[Math.min(same.length - 1, Math.max(0, idx))] ?? same[0];
  };
  const placed: { c: Clip; track: Track }[] = [];
  for (const c of payload.clips) {
    const track = resolveTrack(c.trackId);
    if (!track || track.locked) continue;
    const nc = deepClone(c);
    nc.id = uid('clip');
    nc.trackId = track.id;
    nc.start = c.start - payload.origin + atFrame;
    if (nc.linkId) {
      if (!linkMap.has(nc.linkId)) linkMap.set(nc.linkId, uid('lnk'));
      nc.linkId = linkMap.get(nc.linkId)!;
    }
    if (nc.groupId) {
      if (!groupMap.has(nc.groupId)) groupMap.set(nc.groupId, uid('grp'));
      nc.groupId = groupMap.get(nc.groupId)!;
    }
    placed.push({ c: nc, track });
  }
  if (!placed.length) return out;
  if (insert) {
    const span = Math.max(...placed.map((p) => clipEnd(p.c))) - atFrame;
    for (const t of new Set(placed.map((p) => p.track.id))) razorAt(seq, atFrame, [t]);
    ripple(seq, atFrame, span);
  }
  for (const p of placed) {
    if (!insert) clearRange(seq, p.track.id, p.c.start, clipEnd(p.c));
    seq.clips.push(p.c);
    out.push(p.c.id);
  }
  return out;
}

/** Snap all clips on the track so no gaps remain between them. */
export function removeAllGaps(seq: Sequence, trackId: Id) {
  const list = clipsOnTrack(seq, trackId);
  let cursor = 0;
  for (const c of list) {
    if (c.start > cursor) {
      const delta = c.start - cursor;
      ripple(seq, c.start, -delta, [trackId]);
    }
    cursor = clipEnd(c);
  }
}

/** Clips on a track sorted by start. */
export function clipsOnTrackSorted(seq: Sequence, trackId: Id): Clip[] {
  return seq.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
}
