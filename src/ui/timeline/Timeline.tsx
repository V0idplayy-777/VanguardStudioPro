import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProject, useActiveSequence, findAsset, sequenceDuration } from '../../state/projectStore';
import { useUI, type ContextMenuItem, type ToolId } from '../../state/uiStore';
import { usePlayback } from '../../engine/playback/playback';
import type { Clip, Id, Sequence, Track, MediaAsset } from '../../types/project';
import { LABEL_COLORS } from '../../types/project';
import * as E from '../../engine/timeline/edits';
import { cmd, resolveParam } from '../../app/commands';
import { onTimelineEvent } from '../../app/shortcuts';
import { useTimelineView, MIME_ASSETS, MIME_EFFECT, MIME_TRANSITION, MIME_TEMPLATE } from './timelineState';
import { ClipView, dbToPos, posToDb } from './ClipView';
import { TrackHeader } from './TrackHeader';
import { Ruler } from './Ruler';
import { IconButton, MenuButton, TimecodeField, useElementSize, usePointerDrag } from '../controls';
import { Icon } from '../icons';
import { TRANSITIONS, AUDIO_TRANSITIONS, TRANSITION_MAP } from '../../engine/effects/transitions';
import { setKeyframe, removeKeyframe } from '../../engine/keyframes';
import { formatTime } from '../../engine/timecode';
import { clamp } from '../../engine/util';
import { getEffectDef } from '../../engine/effects/registry';
import { AUDIO_EFFECT_MAP } from '../../engine/effects/audioRegistry';
import { importFiles } from '../../engine/media/importer';
import { templateById } from '../graphics/templates';

const RULER_H = 28;

type DragState =
  | { kind: 'move'; ids: Id[]; startFrames: Map<Id, number>; startTracks: Map<Id, Id>; originTrack: Id; lastDelta: number; lastTrackDelta: number; insert: boolean; copy: boolean; began: boolean }
  | { kind: 'trim'; id: Id; edge: 'start' | 'end'; origStart: number; origEnd: number; mode: 'normal' | 'ripple' | 'roll' | 'rate'; partnerId?: Id; began: boolean }
  | { kind: 'slip'; id: Id; began: boolean; orig: number }
  | { kind: 'slide'; id: Id; began: boolean; lastDelta: number }
  | { kind: 'rubber'; id: Id; path: string; startY: number; startVal: number; began: boolean; frame: number }
  | { kind: 'kf'; id: Id; path: string; t: number; startVal: number; began: boolean; lastT: number }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | { kind: 'scrub' }
  | { kind: 'hand'; startScroll: number; startY: number }
  | { kind: 'transition'; clipId: Id; edge: 'in' | 'out'; startDur: number; began: boolean };

export function TimelinePanel() {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const tool = useUI((s) => s.tool);
  const setTool = useUI((s) => s.setTool);
  const snapping = useUI((s) => s.snapping);
  const setSnapping = useUI((s) => s.setSnapping);
  const linked = useUI((s) => s.linkedSelection);
  const setLinked = useUI((s) => s.setLinkedSelection);
  const selection = useUI((s) => s.selection);
  const ui = useUI;
  const setPlayhead = usePlayback((s) => s.setPlayhead);
  // NOTE: no `playhead` subscription here on purpose — during playback it
  // changes 30-60x/s and would re-render the entire timeline. Per-frame UI
  // (playhead marker, ruler head, timecode) subscribes via micro components
  // below; imperative code reads usePlayback.getState().playhead.
  const view = useTimelineView();
  const { pixelsPerFrame: ppf, scrollFrame, scrollY } = view;
  const [lanesRef, lanesSize] = useElementSize<HTMLDivElement>();
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const [ghost, setGhost] = useState<{ track: Id; start: number; duration: number; label: string }[] | null>(null);
  const [dropTrack, setDropTrack] = useState<Id | null>(null);
  const [gapHl, setGapHl] = useState<{ track: Id; start: number; end: number } | null>(null);
  const openSeqIds = project.openSequenceIds;
  const [headerWidth] = useState(190);
  const rootRef = useRef<HTMLDivElement>(null);
  const showAudioWaveforms = useUI((s) => s.showAudioWaveforms);
  const showVideoThumbnails = useUI((s) => s.showVideoThumbnails);
  const showClipNames = useUI((s) => s.showClipNames);
  const showThroughEdits = useUI((s) => s.showThroughEdits);
  const showDuplicateFrames = useUI((s) => s.showDuplicateFrames);
  const timelineDisplay = useMemo(() => ({ wave: showAudioWaveforms, thumbs: showVideoThumbnails, names: showClipNames, through: showThroughEdits, dup: showDuplicateFrames }), [showAudioWaveforms, showVideoThumbnails, showClipNames, showThroughEdits, showDuplicateFrames]);

  const fps = seq?.settings.fps ?? 30;
  const laneWidth = lanesSize.width;
  const frameToX = useCallback((f: number) => (f - scrollFrame) * ppf, [scrollFrame, ppf]);
  const xToFrame = useCallback((x: number) => scrollFrame + x / ppf, [scrollFrame, ppf]);

  // Track layout: video tracks top (reversed order: V3 above V1), then audio
  const layout = useMemo(() => {
    if (!seq) return { rows: [] as { track: Track; top: number; height: number }[], videoH: 0, totalH: 0 };
    const vids = seq.tracks.filter((t) => t.kind === 'video').slice().reverse();
    const auds = seq.tracks.filter((t) => t.kind === 'audio');
    const rows: { track: Track; top: number; height: number }[] = [];
    let y = 0;
    for (const t of vids) {
      rows.push({ track: t, top: y, height: t.height });
      y += t.height + 1;
    }
    const videoH = y;
    y += 5; // divider
    for (const t of auds) {
      rows.push({ track: t, top: y, height: t.height });
      y += t.height + 1;
    }
    return { rows, videoH, totalH: y };
  }, [seq?.tracks]);

  const rowAtY = useCallback(
    (y: number) => {
      const yy = y + scrollY;
      return layout.rows.find((r) => yy >= r.top && yy < r.top + r.height + 1) ?? null;
    },
    [layout, scrollY],
  );

  // Keep the playhead visible during playback (subscription, no re-render).
  // Pages by half a lane when the playhead reaches the edge instead of
  // following it continuously — a scroll change re-renders the timeline, and
  // doing that on every frame made playback juddery on big timelines.
  const playing = usePlayback((s) => s.playing);
  useEffect(() => {
    if (!playing || !laneWidth) return;
    return usePlayback.subscribe((st, prev) => {
      if (st.playhead === prev.playhead) return;
      const ph = st.playhead;
      const x = frameToX(ph);
      if (x > laneWidth - 20) view.setScroll(ph - laneWidth / (2 * ppf));
      else if (x < 0) view.setScroll(ph);
    });
  }, [playing, laneWidth, frameToX, ppf]);

  // Zoom events from shortcuts
  useEffect(
    () =>
      onTimelineEvent((e) => {
        if (!seq) return;
        if (e.type === 'zoom') zoomAround(e.factor, frameToX(usePlayback.getState().playhead));
        if (e.type === 'zoomFit') zoomToFit();
        if (e.type === 'scrollTo') view.setScroll(e.frame);
      }),
    [seq, frameToX, laneWidth],
  );

  const zoomAround = (factor: number, anchorX: number) => {
    const f = xToFrame(anchorX);
    const nppf = clamp(ppf * factor, 0.002, 120);
    view.setZoom(nppf);
    view.setScroll(f - anchorX / nppf);
  };
  const zoomToFit = () => {
    if (!seq || !laneWidth) return;
    const dur = Math.max(fps * 10, sequenceDuration(seq) * 1.05);
    view.setZoom(laneWidth / dur);
    view.setScroll(0);
  };
  useEffect(() => {
    // initial zoom: show ~60s
    if (laneWidth && view.pixelsPerFrame === 2 && seq) view.setZoom(laneWidth / (fps * 60));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneWidth > 0]);

  const snapTo = useCallback(
    (frame: number, exclude: Set<Id>, shiftHeld: boolean) => {
      if (!seq) return { frame, snapped: false as boolean, to: null as number | null };
      const on = snapping !== shiftHeld; // shift inverts
      if (!on) return { frame, snapped: false, to: null };
      const tol = 8 / ppf;
      const cands = E.snapCandidates(seq, exclude, usePlayback.getState().playhead);
      return E.snapFrame(frame, cands, tol);
    },
    [seq, snapping, ppf],
  );

  /* ---------- pointer handling ---------- */

  const clipUnderPointer = (e: React.PointerEvent | React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest('[data-clip]') as HTMLElement | null;
    return el?.dataset.clip ?? null;
  };

  const beginBatch = (label: string) => useProject.getState().beginBatch(label);
  const endBatch = () => useProject.getState().endBatch();
  const transient = (fn: (s: Sequence) => void) =>
    useProject.getState().updateTransient((p) => {
      const s = p.sequences.find((x) => x.id === seq!.id);
      if (s) fn(s);
    });
  /** Apply fn to a fresh copy of the batch-start sequence (so incremental drags don't compound). */
  const batchStart = useRef<Sequence | null>(null);
  const fromStart = (fn: (s: Sequence) => void) =>
    useProject.getState().updateTransient((p) => {
      const idx = p.sequences.findIndex((x) => x.id === seq!.id);
      if (idx < 0 || !batchStart.current) return;
      const fresh = JSON.parse(JSON.stringify(batchStart.current)) as Sequence;
      fn(fresh);
      p.sequences[idx] = fresh;
    });

  const onClipPointerDown = (clip: Clip, e: React.PointerEvent, part: 'body' | 'trimL' | 'trimR' | 'rubber' | 'kf' | 'transIn' | 'transOut', extra?: any) => {
    if (!seq) return;
    const track = seq.tracks.find((t) => t.id === clip.trackId)!;
    if (e.button === 2) {
      // right click selects if not selected
      if (!selection.clipIds.includes(clip.id)) ui.getState().selectClips(E.expandSelection(seq, [clip.id], linked));
      return;
    }
    if (e.button !== 0) return;
    e.stopPropagation();
    if (track.locked) return;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const lanes = lanesRef.current!.getBoundingClientRect();
    const px = e.clientX - lanes.left;
    const frameAt = Math.round(xToFrame(px));
    const t: ToolId = tool;

    if (part === 'transIn' || part === 'transOut') {
      const edge = part === 'transIn' ? 'in' : 'out';
      ui.getState().setSelection({ clipIds: [], transitionIds: [clip.id + ':' + edge], keyframes: [], markerIds: [] });
      const tr = edge === 'in' ? clip.transitionIn : clip.transitionOut;
      if (tr) {
        batchStart.current = seq;
        beginBatch('Trim transition');
        setDrag({ kind: 'transition', clipId: clip.id, edge, startDur: tr.duration, began: false });
      }
      return;
    }
    if (part === 'kf') {
      const k = { clipId: clip.id, path: extra.path, t: extra.t };
      const cur = selection.keyframes;
      const has = cur.some((x) => x.clipId === k.clipId && x.path === k.path && x.t === k.t);
      if (e.altKey) {
        // alt-click removes keyframe
        useProject.getState().update('Remove keyframe', (p) => {
          const s = p.sequences.find((x) => x.id === seq.id)!;
          const c = s.clips.find((x) => x.id === clip.id)!;
          setParamAt(c, extra.path, removeKeyframe(resolveParam(c, extra.path) as any, extra.t));
        });
        return;
      }
      ui.getState().setSelection({ keyframes: additive ? (has ? cur.filter((x) => !(x.clipId === k.clipId && x.path === k.path && x.t === k.t)) : [...cur, k]) : has ? cur : [k], clipIds: [] });
      const p = resolveParam(clip, extra.path)!;
      const kf = p.keyframes!.find((x: any) => x.t === extra.t)!;
      batchStart.current = seq;
      beginBatch('Move keyframe');
      setDrag({ kind: 'kf', id: clip.id, path: extra.path, t: extra.t, startVal: kf.v, began: false, lastT: extra.t });
      return;
    }
    if (part === 'rubber' || t === 'pen') {
      const path = extra?.path ?? (track.kind === 'audio' ? 'audio.volume' : 'motion.opacity');
      const p = resolveParam(clip, path)!;
      const isAudio = track.kind === 'audio';
      const local = frameAt - clip.start;
      const curVal = p.keyframes?.length ? (evalAt(p, local) as number) : (p.value as number);
      if (e.ctrlKey || e.metaKey || t === 'pen') {
        // add keyframe at pointer
        useProject.getState().update('Add keyframe', (pr) => {
          const s = pr.sequences.find((x) => x.id === seq.id)!;
          const c = s.clips.find((x) => x.id === clip.id)!;
          const pp = resolveParam(c, path)!;
          const v = pp.keyframes?.length ? (evalAt(pp, local) as number) : (pp.value as number);
          setParamAt(c, path, { ...setKeyframe(pp as any, local, v as any), animated: true });
        });
        ui.getState().setSelection({ keyframes: [{ clipId: clip.id, path, t: local }], clipIds: [] });
        return;
      }
      if (p.keyframes?.length) {
        // drag segment: not supported, select clip instead
        ui.getState().selectClips([clip.id]);
        return;
      }
      batchStart.current = seq;
      beginBatch(isAudio ? 'Clip volume' : 'Clip opacity');
      setDrag({ kind: 'rubber', id: clip.id, path, startY: e.clientY, startVal: curVal, began: false, frame: local });
      return;
    }

    if (t === 'razor') {
      useProject.getState().update('Razor', (p) => {
        const s = p.sequences.find((x) => x.id === seq.id)!;
        const ids = e.shiftKey ? undefined : [clip.id, ...(linked ? E.linkedClips(s, clip).map((c) => c.id) : [])];
        E.razorAt(s, frameAt, e.shiftKey ? undefined : undefined, e.shiftKey ? undefined : ids);
      });
      return;
    }
    if (t === 'trackSelectFwd' || t === 'trackSelectBack') {
      const fwd = t === 'trackSelectFwd';
      const tracks = e.shiftKey ? [clip.trackId] : seq.tracks.map((x) => x.id);
      const ids = seq.clips.filter((c) => tracks.includes(c.trackId) && (fwd ? c.start + c.duration > clip.start : c.start < clip.start + clip.duration)).map((c) => c.id);
      ui.getState().selectClips(ids, additive);
      return;
    }
    if (t === 'hand') return;
    if (t === 'zoom') {
      zoomAround(e.altKey ? 1 / 1.5 : 1.5, px);
      return;
    }

    // Selection
    let selIds: Id[];
    const base = E.expandSelection(seq, [clip.id], linked && !e.altKey);
    if (additive) {
      if (selection.clipIds.includes(clip.id)) selIds = selection.clipIds.filter((id) => !base.includes(id));
      else selIds = [...selection.clipIds, ...base];
    } else selIds = selection.clipIds.includes(clip.id) ? selection.clipIds : base;
    ui.getState().selectClips(selIds);

    if (part === 'trimL' || part === 'trimR') {
      const edge = part === 'trimL' ? 'start' : 'end';
      let mode: 'normal' | 'ripple' | 'roll' | 'rate' = t === 'ripple' ? 'ripple' : t === 'rolling' ? 'roll' : t === 'rateStretch' ? 'rate' : 'normal';
      if (e.ctrlKey || e.metaKey) mode = mode === 'normal' ? 'ripple' : mode;
      let partnerId: Id | undefined;
      if (mode === 'roll') {
        const onTrack = E.clipsOnTrackSorted(seq, clip.trackId);
        const i = onTrack.findIndex((c) => c.id === clip.id);
        const nb = edge === 'start' ? onTrack[i - 1] : onTrack[i + 1];
        if (!nb || (edge === 'start' ? nb.start + nb.duration !== clip.start : nb.start !== clip.start + clip.duration)) mode = 'normal';
        else partnerId = nb.id;
      }
      batchStart.current = seq;
      beginBatch(mode === 'ripple' ? 'Ripple trim' : mode === 'roll' ? 'Rolling edit' : mode === 'rate' ? 'Rate stretch' : 'Trim');
      setDrag({ kind: 'trim', id: clip.id, edge, origStart: clip.start, origEnd: clip.start + clip.duration, mode, partnerId, began: false });
      return;
    }
    if (t === 'slip') {
      batchStart.current = seq;
      beginBatch('Slip');
      setDrag({ kind: 'slip', id: clip.id, began: false, orig: clip.inPoint });
      return;
    }
    if (t === 'slide') {
      batchStart.current = seq;
      beginBatch('Slide');
      setDrag({ kind: 'slide', id: clip.id, began: false, lastDelta: 0 });
      return;
    }
    // move
    const ids = selIds.length ? selIds : base;
    const startFrames = new Map<Id, number>();
    const startTracks = new Map<Id, Id>();
    for (const id of ids) {
      const c = seq.clips.find((x) => x.id === id);
      if (c) {
        startFrames.set(id, c.start);
        startTracks.set(id, c.trackId);
      }
    }
    batchStart.current = seq;
    beginBatch('Move');
    setDrag({ kind: 'move', ids, startFrames, startTracks, originTrack: clip.trackId, lastDelta: 0, lastTrackDelta: 0, insert: false, copy: e.altKey, began: false });
  };

  // Global pointer move/up for active drag
  useEffect(() => {
    if (!drag || !seq) return;
    const lanesEl = lanesRef.current!;
    let lastX = 0,
      lastY = 0;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const r = lanesEl.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      lastX = px;
      lastY = py;
      const frame = xToFrame(px);
      // auto-scroll near edges
      if (px > r.width - 12) view.setScroll(scrollFrame + 12 / ppf);
      else if (px < 12 && scrollFrame > 0) view.setScroll(scrollFrame - 12 / ppf);

      switch (d.kind) {
        case 'scrub': {
          setPlayhead(Math.max(0, Math.round(frame)), { fromUser: true });
          break;
        }
        case 'hand': {
          view.setScroll(d.startScroll - (px - (d as any).px0) / ppf);
          break;
        }
        case 'marquee': {
          setDrag({ ...d, x1: px, y1: py });
          break;
        }
        case 'move': {
          const c0 = batchStart.current!.clips.find((c) => c.id === d.ids[0])!;
          // grab offset: keep pointer offset relative to the clip start
          if ((d as any).grabOffset == null) (d as any).grabOffset = xToFrame((d as any).px0 ?? px) - c0.start;
          const grab: number = (d as any).grabOffset;
          let delta = Math.round(frame - grab - c0.start);
          const minStart = Math.min(...d.ids.map((id) => d.startFrames.get(id)!));
          if (minStart + delta < 0) delta = -minStart;
          // snapping on the leading/trailing edges
          const exclude = new Set(d.ids);
          const lead = minStart + delta;
          const maxEnd = Math.max(...d.ids.map((id) => d.startFrames.get(id)! + batchStart.current!.clips.find((c) => c.id === id)!.duration)) + delta;
          const s1 = snapTo(lead, exclude, e.shiftKey);
          const s2 = snapTo(maxEnd, exclude, e.shiftKey);
          if (s1.snapped) {
            delta += s1.frame - lead;
            view.setSnapLine(s1.frame);
          } else if (s2.snapped) {
            delta += s2.frame - maxEnd;
            view.setSnapLine(s2.frame);
          } else view.setSnapLine(null);
          // vertical track shift
          const row = rowAtY(py);
          let trackDelta = 0;
          if (row) {
            const origin = seq.tracks.find((t) => t.id === d.originTrack)!;
            if (row.track.kind === origin.kind) {
              const same = seq.tracks.filter((t) => t.kind === origin.kind);
              trackDelta = same.findIndex((t) => t.id === row.track.id) - same.findIndex((t) => t.id === origin.id);
            }
          }
          // validate track delta for all moving clips
          const shift = new Map<Id, Id>();
          let ok = true;
          for (const id of d.ids) {
            const t0 = seq.tracks.find((t) => t.id === d.startTracks.get(id))!;
            const same = seq.tracks.filter((t) => t.kind === t0.kind);
            const target = same[same.findIndex((t) => t.id === t0.id) + trackDelta];
            if (!target || target.locked) {
              ok = false;
              break;
            }
            shift.set(id, target.id);
          }
          if (!ok) {
            trackDelta = 0;
            for (const id of d.ids) shift.set(id, d.startTracks.get(id)!);
          }
          const insert = e.ctrlKey || e.metaKey;
          if (!d.began && delta === 0 && trackDelta === 0) return;
          d.began = true;
          d.lastDelta = delta;
          d.lastTrackDelta = trackDelta;
          d.insert = insert;
          if (d.copy) {
            // ghost preview only; commit on drop
            setGhost(
              d.ids.map((id) => {
                const c = batchStart.current!.clips.find((x) => x.id === id)!;
                return { track: shift.get(id)!, start: d.startFrames.get(id)! + delta, duration: c.duration, label: c.name };
              }),
            );
          } else {
            fromStart((s) => E.moveClips(s, d.ids, delta, shift, insert ? 'insert' : 'overwrite'));
          }
          break;
        }
        case 'trim': {
          const s0 = batchStart.current!;
          const c0 = s0.clips.find((c) => c.id === d.id)!;
          let f = Math.round(frame);
          const snap = snapTo(f, new Set([d.id]), e.shiftKey);
          if (snap.snapped) {
            f = snap.frame;
            view.setSnapLine(f);
          } else view.setSnapLine(null);
          const asset = findAsset(project, c0.assetId);
          const hasMediaLimit = asset && asset.kind !== 'image' && asset.kind !== 'generator' && asset.duration != null && !c0.freezeAt;
          if (d.edge === 'start') {
            f = Math.min(f, d.origEnd - 1);
            f = Math.max(0, f);
            if (hasMediaLimit && !c0.reversed) {
              const minF = d.origStart - Math.floor((c0.inPoint / c0.speed) * fps);
              f = Math.max(f, minF);
            }
          } else {
            f = Math.max(f, d.origStart + 1);
            if (hasMediaLimit && !c0.reversed) {
              const remain = asset!.duration! - c0.inPoint;
              const maxF = d.origStart + Math.floor((remain / c0.speed) * fps);
              f = Math.min(f, maxF);
            }
          }
          d.began = true;
          fromStart((s) => {
            const c = s.clips.find((x) => x.id === d.id)!;
            const partners = linked ? E.linkedClips(s, c).filter((l) => (d.edge === 'start' ? l.start === c.start : l.start + l.duration === c.start + c.duration)) : [c];
            if (d.mode === 'roll' && d.partnerId) {
              if (d.edge === 'start') E.rollEdit(s, d.partnerId, c.id, f);
              else E.rollEdit(s, c.id, d.partnerId, f);
              return;
            }
            if (d.mode === 'rate') {
              const newDur = d.edge === 'start' ? d.origEnd - f : f - d.origStart;
              const srcSpan = E.sourceSpan(c, fps);
              const speed = srcSpan / (newDur / fps);
              for (const l of partners) {
                if (d.edge === 'start') l.start = f;
                l.duration = newDur;
                l.speed = speed;
              }
              return;
            }
            if (d.mode === 'ripple') {
              E.rippleTrim(s, c.id, d.edge, f);
              return;
            }
            for (const l of partners) {
              if (d.edge === 'start') {
                const nb = E.clipsOnTrackSorted(s, l.trackId).filter((x) => x.id !== l.id && x.start + x.duration <= l.start);
                const limit = nb.length ? Math.max(...nb.map((x) => x.start + x.duration)) : 0;
                E.trimClipStart(l, Math.max(f, limit), fps);
              } else {
                const nb = E.clipsOnTrackSorted(s, l.trackId).filter((x) => x.id !== l.id && x.start >= l.start + l.duration);
                const limit = nb.length ? Math.min(...nb.map((x) => x.start)) : Infinity;
                E.trimClipEnd(l, Math.min(f, limit), fps);
              }
            }
          });
          useTimelineView.getState().setHover({ x: e.clientX + 12, y: e.clientY - 24, text: `${d.edge === 'start' ? 'In' : 'Out'} ${formatTime(f, fps, ui.getState().timecodeMode, seq.settings.dropFrame)}  (${d.edge === 'start' ? f - d.origStart : f - d.origEnd >= 0 ? '+' : ''}${d.edge === 'start' ? '' : f - d.origEnd})` });
          break;
        }
        case 'slip': {
          const delta = Math.round((px - (d as any).px0) / ppf);
          if (Number.isNaN(delta)) break;
          d.began = true;
          fromStart((s) => {
            const c = s.clips.find((x) => x.id === d.id)!;
            for (const l of linked ? E.linkedClips(s, c) : [c]) E.slipClip(s, l.id, -delta, findAsset(project, l.assetId));
          });
          useTimelineView.getState().setHover({ x: e.clientX + 12, y: e.clientY - 24, text: `Slip ${-delta >= 0 ? '+' : ''}${-delta}` });
          break;
        }
        case 'slide': {
          const delta = Math.round((px - (d as any).px0) / ppf);
          d.began = true;
          fromStart((s) => {
            const c = s.clips.find((x) => x.id === d.id)!;
            for (const l of linked ? E.linkedClips(s, c) : [c]) E.slideClip(s, l.id, delta);
          });
          useTimelineView.getState().setHover({ x: e.clientX + 12, y: e.clientY - 24, text: `Slide ${delta >= 0 ? '+' : ''}${delta}` });
          break;
        }
        case 'rubber': {
          const dy = d.startY - e.clientY;
          const isAudio = d.path === 'audio.volume';
          const row = layout.rows.find((r) => r.track.id === seq.clips.find((c) => c.id === d.id)?.trackId);
          const bodyH = Math.max(10, (row?.height ?? 40) - 17);
          let v: number;
          if (isAudio) v = posToDb(dbToPos(d.startVal) + dy / bodyH);
          else v = clamp(d.startVal + (dy / bodyH) * 100, 0, 100);
          if (e.ctrlKey) v = d.startVal + (v - d.startVal) * 0.2;
          d.began = true;
          fromStart((s) => {
            const c = s.clips.find((x) => x.id === d.id)!;
            const targets = e.shiftKey || selection.clipIds.length > 1 ? s.clips.filter((x) => selection.clipIds.includes(x.id) && x.id !== c.id) : [];
            for (const t of [c, ...targets]) {
              const p = resolveParam(t, d.path)!;
              setParamAt(t, d.path, { ...p, value: t === c ? v : (resolveParam(batchStart.current!.clips.find((x) => x.id === t.id)!, d.path)!.value as number) + (v - d.startVal) });
            }
          });
          useTimelineView.getState().setHover({ x: e.clientX + 12, y: e.clientY - 24, text: isAudio ? `${v.toFixed(1)} dB` : `${v.toFixed(0)} %` });
          break;
        }
        case 'kf': {
          const c0 = batchStart.current!.clips.find((c) => c.id === d.id)!;
          const local = clamp(Math.round(frame - c0.start), 0, c0.duration);
          const dy = (d as any).y0 == null ? 0 : (d as any).y0 - e.clientY;
          const row = layout.rows.find((r) => r.track.id === c0.trackId);
          const bodyH = Math.max(10, (row?.height ?? 40) - 17);
          const isAudio = d.path === 'audio.volume';
          const v = isAudio ? posToDb(dbToPos(d.startVal) + dy / bodyH) : clamp(d.startVal + (dy / bodyH) * 100, 0, 100);
          d.began = true;
          d.lastT = local;
          fromStart((s) => {
            const c = s.clips.find((x) => x.id === d.id)!;
            const p = resolveParam(c, d.path)!;
            const kfs = (p.keyframes ?? []).filter((k: any) => k.t !== d.t && k.t !== local);
            const orig = (p.keyframes ?? []).find((k: any) => k.t === d.t)!;
            kfs.push({ ...orig, t: local, v });
            kfs.sort((a: any, b: any) => a.t - b.t);
            setParamAt(c, d.path, { ...p, keyframes: kfs });
          });
          useTimelineView.getState().setHover({ x: e.clientX + 12, y: e.clientY - 24, text: `${isAudio ? v.toFixed(1) + ' dB' : v.toFixed(0) + ' %'} @ ${local}` });
          break;
        }
        case 'transition': {
          const delta = Math.round((px - (d as any).px0) / ppf);
          d.began = true;
          fromStart((s) => {
            const c = s.clips.find((x) => x.id === d.clipId)!;
            const tr = d.edge === 'in' ? c.transitionIn : c.transitionOut;
            if (!tr) return;
            const nd = clamp(d.startDur + (d.edge === 'in' ? delta : delta), 1, c.duration);
            tr.duration = nd;
            // mirror on the neighbour
            const onTrack = E.clipsOnTrackSorted(s, c.trackId);
            const i = onTrack.findIndex((x) => x.id === c.id);
            const nb = d.edge === 'in' ? onTrack[i - 1] : onTrack[i + 1];
            if (nb) {
              const m = d.edge === 'in' ? nb.transitionOut : nb.transitionIn;
              if (m && m.type === tr.type) m.duration = nd;
            }
          });
          useTimelineView.getState().setHover({ x: e.clientX + 12, y: e.clientY - 24, text: `Duration ${formatTime(Math.max(1, d.startDur + Math.round((px - (d as any).px0) / ppf)), fps, 'timecode')}` });
          break;
        }
      }
    };
    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('dragging-grab');
      view.setSnapLine(null);
      useTimelineView.getState().setHover(null);
      if (!d) return;
      if (d.kind === 'marquee') {
        const x0 = Math.min(d.x0, d.x1),
          x1 = Math.max(d.x0, d.x1),
          y0 = Math.min(d.y0, d.y1) + scrollY,
          y1 = Math.max(d.y0, d.y1) + scrollY;
        const f0 = xToFrame(x0),
          f1 = xToFrame(x1);
        const ids: Id[] = [];
        for (const row of layout.rows) {
          if (row.top + row.height < y0 || row.top > y1) continue;
          for (const c of seq.clips) if (c.trackId === row.track.id && c.start < f1 && c.start + c.duration > f0) ids.push(c.id);
        }
        if (Math.abs(d.x1 - d.x0) > 3 || Math.abs(d.y1 - d.y0) > 3) ui.getState().selectClips(E.expandSelection(seq, ids, linked), d.additive);
        setDrag(null);
        return;
      }
      if (d.kind === 'move' && d.copy && d.began) {
        // commit copy
        useProject.getState().cancelBatch();
        const shiftMap = new Map<Id, Id>();
        const delta = d.lastDelta;
        for (const id of d.ids) {
          const t0 = seq.tracks.find((t) => t.id === d.startTracks.get(id))!;
          const same = seq.tracks.filter((t) => t.kind === t0.kind);
          shiftMap.set(id, (same[same.findIndex((t) => t.id === t0.id) + d.lastTrackDelta] ?? t0).id);
        }
        let newIds: Id[] = [];
        useProject.getState().update('Duplicate', (p) => {
          const s = p.sequences.find((x) => x.id === seq.id)!;
          newIds = E.duplicateClips(s, d.ids);
          // duplicateClips places copies right after; move them to the drop position
          const map = new Map<Id, Id>();
          newIds.forEach((nid, i) => map.set(nid, shiftMap.get(d.ids[i])!));
          const first = s.clips.find((c) => c.id === newIds[0])!;
          const origFirst = s.clips.find((c) => c.id === d.ids[0])!;
          E.moveClips(s, newIds, origFirst.start + delta - first.start, map, d.insert ? 'insert' : 'overwrite');
        });
        ui.getState().selectClips(newIds);
        setGhost(null);
        setDrag(null);
        return;
      }
      if ('began' in d && !d.began) {
        useProject.getState().cancelBatch();
      } else endBatch();
      if (d.kind === 'kf' && !d.began && !(e.shiftKey || e.ctrlKey || e.metaKey)) {
        // plain click without drag: select the keyframe only (already handled)
      }
      setGhost(null);
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  const onLanesPointerDown = (e: React.PointerEvent) => {
    if (!seq) return;
    if (e.button === 1 || tool === 'hand' || (e.button === 0 && e.altKey && !clipUnderPointer(e) && tool !== 'select')) {
      const r = lanesRef.current!.getBoundingClientRect();
      const d: any = { kind: 'hand', startScroll: scrollFrame, startY: e.clientY, px0: e.clientX - r.left };
      setDrag(d);
      document.body.classList.add('dragging-grab');
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (clipUnderPointer(e)) return;
    const r = lanesRef.current!.getBoundingClientRect();
    const px = e.clientX - r.left,
      py = e.clientY - r.top;
    if (tool === 'zoom') {
      zoomAround(e.altKey ? 1 / 1.5 : 1.5, px);
      return;
    }
    if (tool === 'razor') {
      const row = rowAtY(py);
      if (row) {
        const f = Math.round(xToFrame(px));
        useProject.getState().update('Razor', (p) => {
          const s = p.sequences.find((x) => x.id === seq.id)!;
          E.razorAt(s, f, e.shiftKey ? undefined : [row.track.id]);
        });
      }
      return;
    }
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!additive) {
      ui.getState().clearSelection();
    }
    setDrag({ kind: 'marquee', x0: px, y0: py, x1: px, y1: py, additive });
  };

  const rulerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !seq) return;
    const r = lanesRef.current!.getBoundingClientRect();
    const f = Math.max(0, Math.round(xToFrame(e.clientX - r.left)));
    setPlayhead(f, { fromUser: true });
    setDrag({ kind: 'scrub' });
  };

  // Wheel: scroll / zoom
  const onWheel = (e: React.WheelEvent) => {
    if (!seq) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const r = lanesRef.current!.getBoundingClientRect();
      zoomAround(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      view.setScroll(scrollFrame + (e.deltaX || e.deltaY) / ppf);
    } else if (e.altKey) {
      const r = lanesRef.current!.getBoundingClientRect();
      zoomAround(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left);
    } else {
      const maxY = Math.max(0, layout.totalH - lanesSize.height);
      view.setScrollY(clamp(scrollY + e.deltaY, 0, maxY));
    }
  };
  useEffect(() => {
    const el = lanesRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, [lanesRef.current]);

  /* ---------- external drops (assets, effects, transitions, files) ---------- */

  const dragPayload = (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types);
    if (types.includes(MIME_ASSETS)) return 'assets';
    if (types.includes(MIME_EFFECT)) return 'effect';
    if (types.includes(MIME_TRANSITION)) return 'transition';
    if (types.includes(MIME_TEMPLATE)) return 'template';
    if (types.includes('Files')) return 'files';
    return null;
  };
  const onDragOver = (e: React.DragEvent) => {
    const kind = dragPayload(e);
    if (!kind || !seq) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = kind === 'assets' || kind === 'files' || kind === 'template' ? 'copy' : 'link';
    const r = lanesRef.current!.getBoundingClientRect();
    const px = e.clientX - r.left,
      py = e.clientY - r.top;
    const row = rowAtY(py);
    if (kind === 'assets' || kind === 'files' || kind === 'template') {
      const ext = useTimelineView.getState().externalDrag;
      let f = Math.max(0, Math.round(xToFrame(px)));
      const s = snapTo(f, new Set(), e.shiftKey);
      if (s.snapped) f = s.frame;
      view.setSnapLine(s.snapped ? f : null);
      if (row && ext?.kind === 'asset') {
        const ghosts: { track: Id; start: number; duration: number; label: string }[] = [];
        let cursor = f;
        for (const id of ext.ids) {
          const a = findAsset(project, id);
          if (!a) continue;
          const dur = E.assetDurationFrames(a, fps, project.settings.defaultStillDuration) - (a.srcIn ? Math.round(a.srcIn * fps) : 0) - (a.srcOut != null && a.duration ? Math.round((a.duration - a.srcOut) * fps) : 0);
          const trackFor = (kind: 'video' | 'audio') => {
            if (row.track.kind === kind) return row.track.id;
            const partner = kind === 'video' ? seq.tracks.find((t) => t.kind === 'video' && t.targeted) ?? seq.tracks.find((t) => t.kind === 'video') : seq.tracks.find((t) => t.kind === 'audio' && t.targeted) ?? seq.tracks.find((t) => t.kind === 'audio');
            return partner?.id ?? null;
          };
          const wantV = a.hasVideo || a.kind === 'image' || a.kind === 'generator' || a.kind === 'sequence';
          const vt = wantV ? trackFor('video') : null;
          const at = a.hasAudio ? trackFor('audio') : null;
          if (vt) ghosts.push({ track: vt, start: cursor, duration: Math.max(1, dur), label: a.name });
          if (at) ghosts.push({ track: at, start: cursor, duration: Math.max(1, dur), label: a.name });
          cursor += Math.max(1, dur);
        }
        setGhost(ghosts);
        setDropTrack(row.track.id);
      } else if (row) {
        setDropTrack(row.track.id);
        setGhost([{ track: row.track.id, start: f, duration: fps * 5, label: kind === 'template' ? 'Graphic' : 'Import' }]);
      }
    } else if (row) {
      // effect/transition: highlight the clip under pointer
      setDropTrack(row.track.id);
      const f = xToFrame(px);
      const c = seq.clips.find((c) => c.trackId === row.track.id && f >= c.start && f < c.start + c.duration);
      if (kind === 'transition' && c) {
        const nearStart = f - c.start < (c.start + c.duration - f);
        setGapHl({ track: row.track.id, start: nearStart ? c.start : c.start + c.duration - Math.min(c.duration, project.settings.defaultTransitionDuration), end: nearStart ? c.start + Math.min(c.duration, project.settings.defaultTransitionDuration) : c.start + c.duration });
      } else if (c) setGapHl({ track: row.track.id, start: c.start, end: c.start + c.duration });
      else setGapHl(null);
    }
  };
  const onDragLeave = () => {
    setGhost(null);
    setDropTrack(null);
    setGapHl(null);
    view.setSnapLine(null);
  };
  const onDrop = async (e: React.DragEvent) => {
    const kind = dragPayload(e);
    onDragLeave();
    if (!kind || !seq) return;
    e.preventDefault();
    const r = lanesRef.current!.getBoundingClientRect();
    const px = e.clientX - r.left,
      py = e.clientY - r.top;
    const row = rowAtY(py);
    let f = Math.max(0, Math.round(xToFrame(px)));
    const s = snapTo(f, new Set(), e.shiftKey);
    if (s.snapped) f = s.frame;
    const insert = e.ctrlKey || e.metaKey;
    if (kind === 'assets') {
      const ids = JSON.parse(e.dataTransfer.getData(MIME_ASSETS)) as Id[];
      const assets = ids.map((id) => findAsset(project, id)).filter(Boolean) as MediaAsset[];
      if (!assets.length || !row) return;
      let cursor = f;
      const created: Id[] = [];
      useProject.getState().update('Add to timeline', (p) => {
        const sq = p.sequences.find((x) => x.id === seq.id)!;
        for (const a of assets) {
          if (a.kind === 'sequence' && a.sequenceId === seq.id) continue;
          const vTrack = row.track.kind === 'video' ? row.track.id : undefined;
          const aTrack = row.track.kind === 'audio' ? row.track.id : undefined;
          const out = E.placeAsset(p, sq, a, cursor, { mode: insert ? 'insert' : 'overwrite', videoTrackId: vTrack, audioTrackId: aTrack, srcIn: a.srcIn, srcOut: a.srcOut, take: e.altKey ? (row.track.kind === 'audio' ? 'audio' : 'video') : 'both' });
          created.push(...out);
          const c = sq.clips.find((x) => x.id === out[0]);
          if (c) cursor = c.start + c.duration;
        }
      });
      ui.getState().selectClips(created);
      return;
    }
    if (kind === 'files') {
      const files = Array.from(e.dataTransfer.files);
      const assets = await importFiles(files);
      if (!assets.length || !row) return;
      // wait a tick for probe to fill durations
      await new Promise((res) => setTimeout(res, 400));
      const p = useProject.getState().project;
      const fresh = assets.map((a) => findAsset(p, a.id)!).filter(Boolean);
      let cursor = f;
      const created: Id[] = [];
      useProject.getState().update('Add to timeline', (pr) => {
        const sq = pr.sequences.find((x) => x.id === seq.id)!;
        for (const a of fresh) {
          const out = E.placeAsset(pr, sq, a, cursor, { mode: insert ? 'insert' : 'overwrite', videoTrackId: row.track.kind === 'video' ? row.track.id : undefined, audioTrackId: row.track.kind === 'audio' ? row.track.id : undefined });
          created.push(...out);
          const c = sq.clips.find((x) => x.id === out[0]);
          if (c) cursor = c.start + c.duration;
        }
      });
      ui.getState().selectClips(created);
      return;
    }
    if (kind === 'template') {
      const id = e.dataTransfer.getData(MIME_TEMPLATE);
      const tpl = templateById(id);
      if (!tpl || !row || row.track.kind !== 'video') return;
      const asset = cmd.newGenerator('graphic', {}, tpl.name);
      useProject.getState().update('Add graphic', (p) => {
        const a = p.assets.find((x) => x.id === asset.id)!;
        a.graphic = tpl.build(seq.settings.width, seq.settings.height);
        const sq = p.sequences.find((x) => x.id === seq.id)!;
        const out = E.placeAsset(p, sq, a, f, { mode: insert ? 'insert' : 'overwrite', videoTrackId: row.track.id, stillFrames: fps * 5 });
        ui.getState().selectClips(out);
      });
      return;
    }
    if (!row) return;
    const fAt = xToFrame(px);
    const target = seq.clips.find((c) => c.trackId === row.track.id && fAt >= c.start && fAt < c.start + c.duration);
    if (kind === 'effect') {
      const type = e.dataTransfer.getData(MIME_EFFECT);
      const ids = target ? (selection.clipIds.includes(target.id) ? selection.clipIds : [target.id]) : [];
      if (!ids.length) return;
      cmd.addEffectToClips(ids, type);
      ui.getState().selectClips(ids);
      return;
    }
    if (kind === 'transition') {
      const type = e.dataTransfer.getData(MIME_TRANSITION);
      if (!target) return;
      const def = TRANSITION_MAP[type];
      if (!def) return;
      if (!!def.audio !== (row.track.kind === 'audio')) return;
      const nearStart = fAt - target.start < target.start + target.duration - fAt;
      cmd.addTransitionTo(target.id, nearStart ? 'in' : 'out', type);
    }
  };

  /* ---------- context menu ---------- */

  const clipContextMenu = (clip: Clip, e: React.MouseEvent) => {
    e.preventDefault();
    if (!seq) return;
    const ids = selection.clipIds.includes(clip.id) ? selection.clipIds : E.expandSelection(seq, [clip.id], linked);
    ui.getState().selectClips(ids);
    const track = seq.tracks.find((t) => t.id === clip.trackId)!;
    const isAudio = track.kind === 'audio';
    const trList = (isAudio ? AUDIO_TRANSITIONS : TRANSITIONS).slice(0, 14);
    const items: ContextMenuItem[] = [
      { label: 'Cut', shortcut: 'Ctrl+X', onSelect: () => cmd.cut() },
      { label: 'Copy', shortcut: 'Ctrl+C', onSelect: () => cmd.copy() },
      { label: 'Paste', shortcut: 'Ctrl+V', disabled: !cmd.hasClipboard(), onSelect: () => cmd.paste(false) },
      { label: 'Clear', shortcut: 'Del', onSelect: () => cmd.deleteSelection(false) },
      { label: 'Ripple Delete', shortcut: 'Shift+Del', onSelect: () => cmd.deleteSelection(true) },
      { separator: true },
      { label: clip.enabled ? 'Disable' : 'Enable', shortcut: 'Shift+E', onSelect: () => cmd.toggleEnabled() },
      { label: clip.linkId ? 'Unlink' : 'Link', onSelect: () => cmd.linkSelection(!clip.linkId) },
      { label: clip.groupId ? 'Ungroup' : 'Group', disabled: !clip.groupId && ids.length < 2, onSelect: () => cmd.groupSelection(!clip.groupId) },
      { label: 'Nest...', onSelect: () => ui.getState().openModal({ kind: 'nest' }) },
      { separator: true },
      { label: 'Speed / Duration...', shortcut: 'Ctrl+R', onSelect: () => cmd.speedDuration() },
      { label: isAudio ? 'Audio Gain...' : 'Frame Hold', shortcut: isAudio ? 'G' : undefined, onSelect: () => (isAudio ? cmd.audioGain() : cmd.frameHold()) },
      ...(isAudio ? [] : [{ label: 'Scale to Frame Size', onSelect: () => scaleToFrame(seq, ids, 'fit') }, { label: 'Time Remapping...', onSelect: () => ui.getState().openModal({ kind: 'timeRemap' }) }]),
      { label: 'Rename...', onSelect: () => ui.getState().openModal({ kind: 'rename', payload: { clipId: clip.id } }) },
      { label: 'Label', submenu: (Object.keys(LABEL_COLORS) as (keyof typeof LABEL_COLORS)[]).map((l) => ({ label: l.charAt(0).toUpperCase() + l.slice(1), checked: clip.label === l, onSelect: () => cmd.setLabel(l) })) },
      { separator: true },
      {
        label: 'Apply Transition',
        submenu: [
          { label: 'Default at both ends', shortcut: 'Ctrl+D', onSelect: () => cmd.applyDefaultTransition(isAudio ? 'audio' : 'video') },
          { separator: true },
          ...trList.map((t) => ({ label: t.name, submenu: [{ label: 'At start', onSelect: () => cmd.addTransitionTo(clip.id, 'in', t.type) }, { label: 'At end', onSelect: () => cmd.addTransitionTo(clip.id, 'out', t.type) }] })),
        ],
      },
      { label: 'Remove Transitions', disabled: !clip.transitionIn && !clip.transitionOut, onSelect: () => useProject.getState().update('Remove transitions', (p) => { const s = p.sequences.find((x) => x.id === seq.id)!; E.removeTransition(s, clip.id, 'in'); E.removeTransition(s, clip.id, 'out'); }) },
      { label: 'Remove Effects', disabled: !clip.effects.length, onSelect: () => cmd.removeEffects(ids) },
      { label: 'Copy Attributes', onSelect: () => cmd.copyAttributes() },
      { label: 'Paste Attributes...', disabled: !cmd.hasAttributes(), onSelect: () => ui.getState().openModal({ kind: 'confirm', payload: { kind: 'pasteAttributes' } }) },
      { separator: true },
      { label: 'Reveal in Project', onSelect: () => cmd.revealInProject() },
      { label: 'Open in Source Monitor', disabled: !clip.assetId, onSelect: () => clip.assetId && ui.getState().setSourceAssetId(clip.assetId) },
      ...(clip.nestedSequenceId ? [{ label: 'Open Nested Sequence', onSelect: () => cmd.openSequence(clip.nestedSequenceId!) }] : []),
      { label: 'Show Clip Info', onSelect: () => ui.getState().openModal({ kind: 'confirm', payload: { kind: 'clipInfo', clipId: clip.id } }) },
    ];
    ui.getState().openContextMenu(e.clientX, e.clientY, items);
  };

  const lanesContextMenu = (e: React.MouseEvent) => {
    if (clipUnderPointer(e)) return;
    e.preventDefault();
    if (!seq) return;
    const r = lanesRef.current!.getBoundingClientRect();
    const row = rowAtY(e.clientY - r.top);
    const f = Math.round(xToFrame(e.clientX - r.left));
    const items: ContextMenuItem[] = [
      { label: 'Paste', shortcut: 'Ctrl+V', disabled: !cmd.hasClipboard(), onSelect: () => { setPlayhead(f, { fromUser: true }); cmd.paste(false); } },
      { label: 'Add Marker Here', onSelect: () => { setPlayhead(f, { fromUser: true }); cmd.addMarker(); } },
      { separator: true },
      ...(row ? [{ label: row.track.kind === 'video' ? 'Close Gap' : 'Close Gap', onSelect: () => useProject.getState().update('Close gap', (p) => E.closeGap(p.sequences.find((x) => x.id === seq.id)!, row.track.id, f)) }, { label: 'Ripple Delete Gap', onSelect: () => useProject.getState().update('Ripple delete gap', (p) => E.closeGap(p.sequences.find((x) => x.id === seq.id)!, row.track.id, f)) }] : []),
      { label: 'Remove All Gaps on All Tracks', onSelect: () => cmd.removeAllGaps() },
      { separator: true },
      { label: 'Add Video Track', onSelect: () => cmd.addTrack('video') },
      { label: 'Add Audio Track', onSelect: () => cmd.addTrack('audio') },
      { label: 'Delete Empty Tracks', onSelect: () => cmd.deleteEmptyTracks() },
      { separator: true },
      { label: 'Show Audio Waveforms', checked: timelineDisplay.wave, onSelect: () => ui.getState().setTimelineDisplay({ showAudioWaveforms: !timelineDisplay.wave }) },
      { label: 'Show Video Thumbnails', checked: timelineDisplay.thumbs, onSelect: () => ui.getState().setTimelineDisplay({ showVideoThumbnails: !timelineDisplay.thumbs }) },
      { label: 'Show Clip Names', checked: timelineDisplay.names, onSelect: () => ui.getState().setTimelineDisplay({ showClipNames: !timelineDisplay.names }) },
      { label: 'Show Through Edits', checked: timelineDisplay.through, onSelect: () => ui.getState().setTimelineDisplay({ showThroughEdits: !timelineDisplay.through }) },
      { separator: true },
      { label: 'Zoom to Sequence', shortcut: '\\', onSelect: zoomToFit },
      { label: 'Sequence Settings...', onSelect: () => ui.getState().openModal({ kind: 'sequenceSettings' }) },
    ];
    ui.getState().openContextMenu(e.clientX, e.clientY, items);
  };

  const clipDoubleClick = (clip: Clip) => {
    if (clip.nestedSequenceId) {
      cmd.openSequence(clip.nestedSequenceId);
      return;
    }
    if (clip.assetId) {
      ui.getState().setSourceAssetId(clip.assetId);
      ui.getState().setSourceTime(E.sourceTimeAt(clip, usePlayback.getState().playhead, fps));
    }
    if (clip.generator === 'graphic') {
      ui.getState().setWorkspace('graphics');
    }
  };

  /* ---------- render ---------- */

  if (!seq) {
    return (
      <div className="timeline">
        <div className="tl-head" />
        <div className="empty" style={{ marginTop: 40 }}>
          <strong>No sequence open</strong>
          Create one with File &gt; New Sequence, or drag media onto the Program Monitor.
          <div style={{ marginTop: 10 }}>
            <button className="btn primary" onClick={() => cmd.newSequence()}>
              New Sequence
            </button>
          </div>
        </div>
      </div>
    );
  }

  const dur = sequenceDuration(seq);
  const visibleFrames = laneWidth / ppf;
  const totalFrames = Math.max(dur * 1.1, scrollFrame + visibleFrames, fps * 30);
  const selSet = new Set(selection.clipIds);
  const displayTool = drag?.kind === 'hand' ? 'hand' : tool;
  const cursor = displayTool === 'razor' ? 'crosshair' : displayTool === 'hand' ? (drag ? 'grabbing' : 'grab') : displayTool === 'zoom' ? 'zoom-in' : displayTool === 'pen' ? 'crosshair' : displayTool === 'ripple' || displayTool === 'rolling' ? 'col-resize' : displayTool === 'rateStretch' ? 'ew-resize' : undefined;
  const maxScrollY = Math.max(0, layout.totalH - lanesSize.height);

  return (
    <div className="timeline" ref={rootRef} tabIndex={0} onWheel={onWheel}>
      <div className="tl-head">
        <PlayheadTimecode fps={fps} dropFrame={seq.settings.dropFrame} onChange={(f) => setPlayhead(f, { fromUser: true })} />
        <div className="vsep" />
        <div className="tl-seq-tabs" role="tablist">
          {openSeqIds.map((id) => {
            const s = project.sequences.find((x) => x.id === id);
            if (!s) return null;
            return (
              <button key={id} role="tab" aria-selected={id === seq.id} className={id === seq.id ? 'on' : ''} onClick={() => id !== seq.id && cmd.openSequence(id)} title={`${s.name}  ${s.settings.width}x${s.settings.height} ${s.settings.fps}fps`}>
                <Icon name="sequence" size={11} />
                {s.name}
                {openSeqIds.length > 1 ? (
                  <span
                    className="x"
                    onClick={(e) => {
                      e.stopPropagation();
                      cmd.closeSequenceTab(id);
                    }}
                    title="Close"
                  >
                    <Icon name="close" size={8} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="vsep" />
        <IconButton icon="insert" label="Insert (from Source)" title="Insert from Source (,)" onClick={() => cmd.insertOverwriteFromSource('insert')} />
        <IconButton icon="overwrite" label="Overwrite (from Source)" title="Overwrite from Source (.)" onClick={() => cmd.insertOverwriteFromSource('overwrite')} />
        <div className="vsep" />
        <IconButton icon="snap" label="Snap" title="Snap in Timeline (S)" on={snapping} onClick={() => setSnapping(!snapping)} />
        <IconButton icon="link" label="Linked Selection" title="Linked Selection" on={linked} onClick={() => setLinked(!linked)} />
        <IconButton icon="marker" label="Add Marker" title="Add Marker (M)" onClick={() => cmd.addMarker()} />
        <MenuButton
          icon="wrench"
          label="Timeline display settings"
          items={() => [
            { label: 'Show Audio Waveforms', checked: useUI.getState().showAudioWaveforms, onSelect: () => ui.getState().setTimelineDisplay({ showAudioWaveforms: !useUI.getState().showAudioWaveforms }) },
            { label: 'Show Video Thumbnails', checked: useUI.getState().showVideoThumbnails, onSelect: () => ui.getState().setTimelineDisplay({ showVideoThumbnails: !useUI.getState().showVideoThumbnails }) },
            { label: 'Show Clip Names', checked: useUI.getState().showClipNames, onSelect: () => ui.getState().setTimelineDisplay({ showClipNames: !useUI.getState().showClipNames }) },
            { label: 'Show Through Edits', checked: useUI.getState().showThroughEdits, onSelect: () => ui.getState().setTimelineDisplay({ showThroughEdits: !useUI.getState().showThroughEdits }) },
            { separator: true },
            { label: 'Expand All Tracks', onSelect: () => useProject.getState().update('Expand tracks', (p) => p.sequences.find((x) => x.id === seq.id)!.tracks.forEach((t) => (t.height = t.kind === 'video' ? 96 : 80))) },
            { label: 'Minimize All Tracks', onSelect: () => useProject.getState().update('Minimize tracks', (p) => p.sequences.find((x) => x.id === seq.id)!.tracks.forEach((t) => (t.height = 24))) },
            { label: 'Reset Track Heights', onSelect: () => useProject.getState().update('Reset track heights', (p) => p.sequences.find((x) => x.id === seq.id)!.tracks.forEach((t) => (t.height = t.kind === 'video' ? 48 : 44))) },
            { separator: true },
            { label: 'Zoom to Sequence', shortcut: '\\', onSelect: zoomToFit },
          ]}
        />
        <div className="spacer" />
        <span className="label tiny" title="Sequence settings">
          {seq.settings.width}x{seq.settings.height} {seq.settings.fps % 1 ? seq.settings.fps.toFixed(2) : seq.settings.fps}p
        </span>
        <TimecodeField frames={dur} fps={fps} dropFrame={seq.settings.dropFrame} muted title="Sequence duration" />
      </div>
      <div className="tl-body">
        <ToolBox tool={tool} setTool={setTool} />
        <div className="tl-headers" style={{ width: headerWidth }}>
          <div className="ruler-corner">
            <IconButton icon="zoomOut" label="Zoom out" sm onClick={() => zoomAround(1 / 1.5, laneWidth / 2)} />
            <IconButton icon="zoomFit" label="Zoom to sequence" sm onClick={zoomToFit} />
            <IconButton icon="zoom" label="Zoom in" sm onClick={() => zoomAround(1.5, laneWidth / 2)} />
            <div className="spacer" />
            <MenuButton icon="trackAdd" label="Add tracks" className="ibtn sm" items={[{ label: 'Add Video Track', onSelect: () => cmd.addTrack('video') }, { label: 'Add Audio Track', onSelect: () => cmd.addTrack('audio') }, { separator: true }, { label: 'Delete Empty Tracks', onSelect: () => cmd.deleteEmptyTracks() }]} />
          </div>
          <div className="hdr-scroll">
            <div className="hdr-inner" style={{ top: -scrollY }}>
              {layout.rows.map((r) => (
                <TrackHeader key={r.track.id} track={r.track} seq={seq} top={r.top} height={r.height} />
              ))}
              <div className="tl-divider" style={{ position: 'absolute', top: layout.videoH, left: 0, right: 0 }} />
            </div>
          </div>
        </div>
        <div className="tl-tracks" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
          <Ruler seq={seq} ppf={ppf} scrollFrame={scrollFrame} width={laneWidth} onPointerDown={rulerDown} />
          <div ref={lanesRef} className="tl-lanes" style={{ cursor }} onPointerDown={onLanesPointerDown} onContextMenu={lanesContextMenu}>
            <div className="lanes-inner" style={{ top: -scrollY, height: layout.totalH }}>
              {layout.rows.map((r) => (
                <div key={r.track.id} className={['tl-lane', r.track.kind, r.track.locked ? 'locked' : '', r.track.targeted ? 'targeted' : '', dropTrack === r.track.id ? 'drop' : ''].filter(Boolean).join(' ')} style={{ top: r.top, height: r.height + 1 }} data-track={r.track.id}>
                  {seq.clips
                    .filter((c) => c.trackId === r.track.id)
                    .map((c) => {
                      const left = frameToX(c.start);
                      const w = Math.max(2, c.duration * ppf);
                      if (left + w < -50 || left > laneWidth + 50) return null;
                      return (
                        <ClipView
                          key={c.id}
                          clip={c}
                          track={r.track}
                          asset={findAsset(project, c.assetId)}
                          seq={seq}
                          left={left}
                          width={w}
                          height={r.height}
                          selected={selSet.has(c.id)}
                          dragging={drag?.kind === 'move' && drag.ids.includes(c.id) && drag.began}
                          ppf={ppf}
                          scrollFrame={scrollFrame}
                          laneWidth={laneWidth}
                          showRubber={r.track.showKeyframes !== 'none'}
                          onPointerDown={(e, part, extra) => {
                            // stash pointer origin for slip/slide/transition
                            const rr = lanesRef.current!.getBoundingClientRect();
                            (window as any).__vspPx0 = e.clientX - rr.left;
                            onClipPointerDown(c, e, part, extra);
                            setDrag((d) => (d ? ({ ...d, px0: e.clientX - rr.left, y0: e.clientY } as any) : d));
                          }}
                          onContextMenu={(e) => clipContextMenu(c, e)}
                          onDoubleClick={() => clipDoubleClick(c)}
                        />
                      );
                    })}
                </div>
              ))}
              <div className="tl-divider" style={{ position: 'absolute', top: layout.videoH, left: 0, right: 0 }} />
              {ghost?.map((g, i) => {
                const row = layout.rows.find((r) => r.track.id === g.track);
                if (!row) return null;
                return (
                  <div key={i} className="clip ghost" style={{ left: frameToX(g.start), width: Math.max(2, g.duration * ppf), top: row.top + 1, bottom: 'auto', height: row.height - 2 }}>
                    <div className="clip-head">
                      <span className="clip-name">{g.label}</span>
                    </div>
                  </div>
                );
              })}
              {gapHl ? (() => {
                const row = layout.rows.find((r) => r.track.id === gapHl.track);
                return row ? <div className="tl-gap-hl" style={{ left: frameToX(gapHl.start), width: (gapHl.end - gapHl.start) * ppf, top: row.top, height: row.height }} /> : null;
              })() : null}
            </div>
            {seq.inPoint != null && seq.outPoint != null ? <div style={{ position: 'absolute', top: 0, bottom: 0, left: frameToX(seq.inPoint), width: (seq.outPoint - seq.inPoint) * ppf, background: 'var(--c-in-out)', pointerEvents: 'none' }} /> : null}
            {view.snapLine != null ? <div className="tl-snapline" style={{ left: frameToX(view.snapLine) }} /> : null}
            {drag?.kind === 'marquee' ? <div className="tl-marquee" style={{ left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }} /> : null}
            <PlayheadMarker frameToX={frameToX} />
            {seq.clips.length === 0 ? (
              <div className="tl-empty">
                <span>
                  Drag media here from the Project panel, or select a clip in the Source Monitor and press <kbd>,</kbd> to insert / <kbd>.</kbd> to overwrite.
                </span>
              </div>
            ) : null}
          </div>
          <HScroll totalFrames={totalFrames} visibleFrames={visibleFrames} scrollFrame={scrollFrame} onScroll={(f) => view.setScroll(f)} onZoom={(ppfNew, f) => { view.setZoom(ppfNew); view.setScroll(f); }} laneWidth={laneWidth} ppf={ppf} />
        </div>
        <div className="tl-scroll-v" onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const t = (e.clientY - r.top) / r.height;
          view.setScrollY(clamp(t * layout.totalH - lanesSize.height / 2, 0, maxScrollY));
        }}>
          {layout.totalH > lanesSize.height ? <div className="thumb" style={{ top: `${(scrollY / layout.totalH) * 100}%`, height: `${Math.min(100, (lanesSize.height / layout.totalH) * 100)}%` }} /> : null}
        </div>
      </div>
      <HoverTooltip />
    </div>
  );
}

function HoverTooltip() {
  const hover = useTimelineView((s) => s.hover);
  if (!hover) return null;
  return (
    <div className="tl-tooltip" style={{ left: hover.x, top: hover.y }}>
      {hover.text}
    </div>
  );
}

function HScroll({ totalFrames, visibleFrames, scrollFrame, onScroll, onZoom, laneWidth, ppf }: { totalFrames: number; visibleFrames: number; scrollFrame: number; onScroll: (f: number) => void; onZoom: (ppf: number, f: number) => void; laneWidth: number; ppf: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef({ scroll: 0, ppf: 1, left: 0, width: 0 });
  const total = Math.max(totalFrames, visibleFrames);
  const thumbLeft = (scrollFrame / total) * 100;
  const thumbW = Math.max(3, (visibleFrames / total) * 100);
  const drag = usePointerDrag({
    onStart: () => {
      start.current = { scroll: scrollFrame, ppf, left: thumbLeft, width: thumbW };
    },
    onMove: (d) => {
      const w = ref.current!.clientWidth;
      onScroll(start.current.scroll + (d.dx / w) * total);
    },
    cursorClass: 'dragging-grab',
  });
  const zoomL = usePointerDrag({
    onStart: () => {
      start.current = { scroll: scrollFrame, ppf, left: thumbLeft, width: thumbW };
    },
    onMove: (d) => {
      const w = ref.current!.clientWidth;
      const framesDelta = (d.dx / w) * total;
      const newVisible = Math.max(10, visibleFramesAt(start.current.ppf) - framesDelta);
      const newPpf = laneWidth / newVisible;
      onZoom(newPpf, Math.max(0, start.current.scroll + framesDelta));
    },
  });
  const zoomR = usePointerDrag({
    onStart: () => {
      start.current = { scroll: scrollFrame, ppf, left: thumbLeft, width: thumbW };
    },
    onMove: (d) => {
      const w = ref.current!.clientWidth;
      const framesDelta = (d.dx / w) * total;
      const newVisible = Math.max(10, visibleFramesAt(start.current.ppf) + framesDelta);
      onZoom(laneWidth / newVisible, start.current.scroll);
    },
  });
  const visibleFramesAt = (p: number) => laneWidth / p;
  return (
    <div
      ref={ref}
      className="tl-scroll-h"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).classList.contains('tl-scroll-h')) {
          const r = e.currentTarget.getBoundingClientRect();
          onScroll(((e.clientX - r.left) / r.width) * total - visibleFrames / 2);
        }
      }}
    >
      <div className="thumb" style={{ left: `${thumbLeft}%`, width: `${thumbW}%` }} onPointerDown={drag} title="Drag to scroll. Drag the ends to zoom.">
        <div className="zh l" onPointerDown={(e) => { e.stopPropagation(); zoomL(e); }} />
        <div className="zh r" onPointerDown={(e) => { e.stopPropagation(); zoomR(e); }} />
      </div>
    </div>
  );
}

export function ToolBox({ tool, setTool }: { tool: ToolId; setTool: (t: ToolId) => void }) {
  const tools: { id: ToolId; icon: any; label: string; key: string }[] = [
    { id: 'select', icon: 'select', label: 'Selection Tool', key: 'V' },
    { id: 'trackSelectFwd', icon: 'trackSelectFwd', label: 'Track Select Forward Tool', key: 'A' },
    { id: 'trackSelectBack', icon: 'trackSelectBack', label: 'Track Select Backward Tool', key: 'Shift+A' },
    { id: 'ripple', icon: 'rippleEdit', label: 'Ripple Edit Tool', key: 'B' },
    { id: 'rolling', icon: 'rollingEdit', label: 'Rolling Edit Tool', key: 'N' },
    { id: 'rateStretch', icon: 'rateStretch', label: 'Rate Stretch Tool', key: 'R' },
    { id: 'razor', icon: 'razor', label: 'Razor Tool', key: 'C' },
    { id: 'slip', icon: 'slip', label: 'Slip Tool', key: 'Y' },
    { id: 'slide', icon: 'slide', label: 'Slide Tool', key: 'U' },
    { id: 'pen', icon: 'pen', label: 'Pen Tool (keyframes)', key: 'P' },
    { id: 'hand', icon: 'hand', label: 'Hand Tool', key: 'H' },
    { id: 'zoom', icon: 'zoom', label: 'Zoom Tool (Alt to zoom out)', key: 'Z' },
  ];
  return (
    <div className="toolbox" role="toolbar" aria-label="Tools">
      {tools.map((t, i) => (
        <React.Fragment key={t.id}>
          {i === 3 || i === 6 || i === 9 ? <div className="hsep" /> : null}
          <IconButton icon={t.icon} label={t.label} title={`${t.label} (${t.key})`} tool on={tool === t.id} onClick={() => setTool(t.id)} />
        </React.Fragment>
      ))}
    </div>
  );
}

/* ---------- helpers ---------- */

function evalAt(p: { value: any; keyframes?: any[] }, t: number) {
  // small local evaluator to avoid importing evalParam types
  const kfs = p.keyframes ?? [];
  if (!kfs.length) return p.value;
  if (t <= kfs[0].t) return kfs[0].v;
  if (t >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1].v;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i],
      b = kfs[i + 1];
    if (t >= a.t && t <= b.t) {
      const f = (t - a.t) / Math.max(1, b.t - a.t);
      return a.interp === 'hold' ? a.v : a.v + (b.v - a.v) * f;
    }
  }
  return p.value;
}

export function setParamAt(clip: Clip, path: string, p: any) {
  const parts = path.split('.');
  if (parts[0] === 'motion') (clip.motion as any)[parts[1]] = p;
  else if (parts[0] === 'audio') (clip.audio as any)[parts[1]] = p;
  else if (parts[0] === 'fx') {
    const fx = clip.effects.find((e) => e.id === parts[1]);
    if (!fx) return;
    if (parts[2] === 'mask') {
      const m = fx.masks.find((x) => x.id === parts[3]);
      if (m) (m as any)[parts[4]] = p;
    } else fx.params[parts[2]] = p;
  }
}

function scaleToFrame(seq: Sequence, ids: Id[], mode: 'fit' | 'fill') {
  useProject.getState().update('Scale to frame size', (p) => {
    const s = p.sequences.find((x) => x.id === seq.id)!;
    for (const c of s.clips) {
      if (!ids.includes(c.id)) continue;
      const a = p.assets.find((x) => x.id === c.assetId);
      const w = a?.width ?? s.settings.width,
        h = a?.height ?? s.settings.height;
      const sx = s.settings.width / w,
        sy = s.settings.height / h;
      c.motion.scale = { value: (mode === 'fit' ? Math.min(sx, sy) : Math.max(sx, sy)) * 100 };
    }
  });
}

export { getEffectDef, AUDIO_EFFECT_MAP };


/* ---------- per-frame micro components ----------
   These subscribe to the playhead themselves so frame moves during playback
   re-render only this tiny subtree (a positioned div), never the timeline. */

export function PlayheadMarker({ frameToX }: { frameToX: (f: number) => number }) {
  const ph = usePlayback((s) => s.playhead);
  return <div className="tl-playhead" style={{ left: frameToX(ph) }} />;
}

export function PlayheadTimecode({ fps, dropFrame, onChange }: { fps: number; dropFrame?: boolean; onChange: (f: number) => void }) {
  const ph = usePlayback((s) => s.playhead);
  return <TimecodeField frames={ph} fps={fps} dropFrame={dropFrame} onChange={onChange} />;
}
