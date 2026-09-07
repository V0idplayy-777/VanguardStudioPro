import { useProject, getActiveSequence, sequenceDuration, findAsset, createSequence, makeClip, renumberTracks } from '../state/projectStore';
import { useUI, toast, logEvent } from '../state/uiStore';
import { usePlayback } from '../engine/playback/playback';
import * as E from '../engine/timeline/edits';
import type { Clip, Id, MediaAsset, Sequence, Marker, GeneratorKind, Transition, Param } from '../types/project';
import { uid, download, stripExt } from '../engine/util';
import { importFiles, pickFiles, MEDIA_ACCEPT } from '../engine/media/importer';
import { getMedia } from '../engine/media/mediaStore';
import { downloadProject, openProjectFile, autosaveNow } from '../engine/project/serialize';
import { userPresets } from './presets';
import { exportFrame, exportEDL, exportMarkersCSV, exportChaptersYouTube } from '../engine/export/exporter';
import { getEffectDef, defaultEffectParams } from '../engine/effects/registry';
import { AUDIO_EFFECT_MAP } from '../engine/effects/audioRegistry';
import { TRANSITION_MAP } from '../engine/effects/transitions';
import { param } from '../types/project';
import { parseSRT, parseVTT } from '../engine/captions/subtitles';
import { analyzeClipFrame, autoColorParamsFrom } from '../engine/color/autoColor';
import { useSettings } from '../state/settingsStore';

/* ---------- helpers ---------- */

export function seqNow(): Sequence | null {
  return getActiveSequence(useProject.getState().project);
}

export function playheadNow(): number {
  return usePlayback.getState().playhead;
}

export function selectedClipIds(): Id[] {
  return useUI.getState().selection.clipIds;
}

export function selectedClips(): Clip[] {
  const seq = seqNow();
  if (!seq) return [];
  const ids = new Set(selectedClipIds());
  return seq.clips.filter((c) => ids.has(c.id));
}

function mutateSeq(label: string, fn: (seq: Sequence, project: ReturnType<typeof useProject.getState>['project']) => void) {
  const st = useProject.getState();
  st.update(label, (p) => {
    const seq = getActiveSequence(p);
    if (seq) fn(seq, p);
  });
}

function withSelectionExpanded(seq: Sequence, ids: Id[]) {
  return E.expandSelection(seq, ids, useUI.getState().linkedSelection);
}

/* ---------- file ---------- */

export const cmd = {
  /* file */
  newProject() {
    const st = useProject.getState();
    if (st.dirty && !confirm('Discard unsaved changes and start a new project?')) return;
    st.newProject('Untitled Project');
    useUI.getState().clearSelection();
    usePlayback.getState().pause();
    usePlayback.setState({ playhead: 0 });
    logEvent('info', 'New project created');
  },
  async openProject() {
    const files = await pickFiles('.vsproj,.json', false);
    if (!files.length) return;
    try {
      const { project, restored, missing } = await openProjectFile(files[0]);
      useProject.getState().loadProject(project);
      useUI.getState().clearSelection();
      usePlayback.setState({ playhead: 0 });
      toast('success', 'Project opened', `${project.settings.name} - ${restored} media item${restored === 1 ? '' : 's'} restored${missing.length ? `, ${missing.length} offline` : ''}`);
      if (missing.length) useUI.getState().openModal({ kind: 'linkMedia', payload: { assetIds: missing.map((m) => m.id) } });
    } catch (e: any) {
      toast('error', 'Could not open project', String(e?.message ?? e));
    }
  },
  async saveProject(embedMedia = false) {
    await downloadProject(useProject.getState().project, embedMedia);
    toast('success', 'Project saved', embedMedia ? 'Media files were embedded in the archive.' : undefined);
  },
  async importMedia(binId?: string | null) {
    const files = await pickFiles(MEDIA_ACCEPT, true);
    if (!files.length) return;
    await importFiles(files, { binId: binId ?? useUI.getState().currentBinId });
  },
  async importCaptions() {
    const files = await pickFiles('.srt,.vtt', false);
    if (!files.length) return;
    const text = await files[0].text();
    const seq = seqNow();
    if (!seq) return;
    const items = files[0].name.toLowerCase().endsWith('.vtt') ? parseVTT(text, seq.settings.fps) : parseSRT(text, seq.settings.fps);
    if (!items.length) return toast('warning', 'No captions found', files[0].name);
    mutateSeq('Import captions', (s) => {
      s.captions.push(...items.map((c) => ({ ...c, id: uid('cap') })));
      s.captions.sort((a, b) => a.start - b.start);
    });
    toast('success', 'Captions imported', `${items.length} items from ${files[0].name}`);
  },

  /* edit */
  undo() {
    useProject.getState().undo();
  },
  redo() {
    useProject.getState().redo();
  },
  selectAll() {
    const seq = seqNow();
    if (!seq) return;
    useUI.getState().selectClips(seq.clips.filter((c) => !seq.tracks.find((t) => t.id === c.trackId)?.locked).map((c) => c.id));
  },
  deselectAll() {
    useUI.getState().clearSelection();
  },
  cut() {
    cmd.copy();
    cmd.deleteSelection(false);
  },
  copy() {
    const seq = seqNow();
    const ids = selectedClipIds();
    if (!seq || !ids.length) return;
    const payload = E.copyClips(seq, withSelectionExpanded(seq, ids));
    if (payload) {
      clipboard = payload;
      logEvent('info', `Copied ${payload.clips.length} clip(s)`);
    }
  },
  paste(insert = false) {
    if (!clipboard) return;
    const at = playheadNow();
    let ids: Id[] = [];
    mutateSeq(insert ? 'Paste insert' : 'Paste', (seq) => {
      ids = E.pasteClips(seq, clipboard!, at, insert);
    });
    useUI.getState().selectClips(ids);
  },
  duplicate() {
    const ids = selectedClipIds();
    if (!ids.length) return;
    let out: Id[] = [];
    mutateSeq('Duplicate', (seq) => {
      out = E.duplicateClips(seq, withSelectionExpanded(seq, ids));
    });
    useUI.getState().selectClips(out);
  },
  deleteSelection(ripple: boolean) {
    const ui = useUI.getState();
    const seq = seqNow();
    if (!seq) return;
    if (ui.selection.transitionIds.length) {
      mutateSeq('Remove transition', (s) => {
        for (const tid of ui.selection.transitionIds) {
          const [clipId, edge] = tid.split(':');
          E.removeTransition(s, clipId, edge as 'in' | 'out');
        }
      });
      ui.setSelection({ transitionIds: [] });
      return;
    }
    if (ui.selection.markerIds.length) {
      mutateSeq('Delete marker', (s) => {
        s.markers = s.markers.filter((m) => !ui.selection.markerIds.includes(m.id));
      });
      ui.setSelection({ markerIds: [] });
      return;
    }
    if (ui.selection.keyframes.length) {
      cmd.deleteSelectedKeyframes();
      return;
    }
    const ids = withSelectionExpanded(seq, ui.selection.clipIds);
    if (!ids.length) return;
    mutateSeq(ripple ? 'Ripple delete' : 'Delete', (s) => E.deleteClips(s, ids, ripple));
    ui.clearSelection();
  },
  deleteSelectedKeyframes() {
    const ui = useUI.getState();
    const kfs = ui.selection.keyframes;
    if (!kfs.length) return;
    mutateSeq('Delete keyframes', (seq) => {
      for (const k of kfs) {
        const clip = seq.clips.find((c) => c.id === k.clipId);
        if (!clip) continue;
        const p = resolveParam(clip, k.path);
        if (p?.keyframes) p.keyframes = p.keyframes.filter((x) => x.t !== k.t);
      }
    });
    ui.setSelection({ keyframes: [] });
  },

  /* clip */
  toggleEnabled() {
    const ids = selectedClipIds();
    if (!ids.length) return;
    mutateSeq('Enable/disable clip', (seq) => {
      const all = withSelectionExpanded(seq, ids);
      const target = seq.clips.filter((c) => all.includes(c.id));
      const anyEnabled = target.some((c) => c.enabled);
      for (const c of target) c.enabled = !anyEnabled;
    });
  },
  linkSelection(link: boolean) {
    const ids = selectedClipIds();
    if (!ids.length) return;
    mutateSeq(link ? 'Link' : 'Unlink', (seq) => {
      const target = seq.clips.filter((c) => ids.includes(c.id));
      if (link) {
        const lid = uid('lnk');
        for (const c of target) c.linkId = lid;
      } else for (const c of target) c.linkId = null;
    });
  },
  groupSelection(group: boolean) {
    const ids = selectedClipIds();
    if (ids.length < (group ? 2 : 1)) return;
    mutateSeq(group ? 'Group' : 'Ungroup', (seq) => {
      const gid = uid('grp');
      for (const c of seq.clips) if (ids.includes(c.id)) c.groupId = group ? gid : null;
    });
  },
  nestSelection(name?: string) {
    const ids = selectedClipIds();
    if (!ids.length) return;
    const seq = seqNow();
    const nm = name ?? `Nested Sequence ${String((useProject.getState().project.sequences.length ?? 0) + 1).padStart(2, '0')}`;
    let created: Id | null = null;
    useProject.getState().update('Nest', (p) => {
      const s = getActiveSequence(p);
      if (!s) return;
      const nested = E.nestClips(p, s, withSelectionExpanded(s, ids), nm);
      created = nested?.id ?? null;
    });
    useUI.getState().clearSelection();
    if (created && seq) logEvent('info', `Nested ${ids.length} clip(s) into ${nm}`);
  },
  speedDuration() {
    if (!selectedClipIds().length) return;
    useUI.getState().openModal({ kind: 'speedDuration' });
  },
  setSpeed(speed: number, reverse: boolean, ripple: boolean, maintainPitch: boolean) {
    const ids = selectedClipIds();
    mutateSeq('Speed/Duration', (seq) => {
      for (const id of withSelectionExpanded(seq, ids)) E.setClipSpeed(seq, id, speed, { reverse, rippleAfter: ripple, maintainPitch });
    });
  },
  frameHold() {
    const ids = selectedClipIds();
    const ph = playheadNow();
    mutateSeq('Frame hold', (seq) => {
      for (const c of seq.clips) {
        if (!ids.includes(c.id)) continue;
        if (c.freezeAt != null) c.freezeAt = undefined;
        else c.freezeAt = E.sourceTimeAt(c, Math.max(c.start, Math.min(ph, c.start + c.duration - 1)), seq.settings.fps);
      }
    });
  },
  insertFrameHoldSegment() {
    const ids = selectedClipIds();
    const ph = playheadNow();
    if (!ids.length) return;
    mutateSeq('Insert frame hold segment', (seq) => {
      const fps = seq.settings.fps;
      const holdFrames = fps * 2;
      for (const id of ids) {
        const c = seq.clips.find((x) => x.id === id);
        if (!c || ph <= c.start || ph >= c.start + c.duration) continue;
        const srcT = E.sourceTimeAt(c, ph, fps);
        const right = E.splitClipAt(seq, c, ph, fps);
        if (!right) continue;
        // ripple right side and everything after
        E.ripple(seq, ph, holdFrames, undefined, new Set([c.id]));
        const hold = makeClip({ ...JSON.parse(JSON.stringify(c)), id: uid('clip'), start: ph, duration: holdFrames, freezeAt: srcT, transitionIn: null, transitionOut: null, linkId: null });
        seq.clips.push(hold);
      }
    });
  },
  audioGain() {
    if (!selectedClipIds().length) return;
    useUI.getState().openModal({ kind: 'audioGain' });
  },
  setAudioGain(db: number, normalizeTo?: number) {
    const ids = selectedClipIds();
    mutateSeq('Audio gain', (seq) => {
      for (const c of seq.clips) {
        if (!ids.includes(c.id)) continue;
        if (normalizeTo != null) {
          const rec = getMedia(c.assetId);
          const peak = rec?.peaks ? Math.max(0.0001, ...rec.peaks.map((ch) => ch.reduce((m, v) => Math.max(m, Math.abs(v)), 0))) : 1;
          c.audio.gain = normalizeTo - 20 * Math.log10(peak);
        } else c.audio.gain = db;
      }
    });
  },
  setLabel(label: Clip['label']) {
    const ui = useUI.getState();
    const ids = ui.selection.clipIds;
    if (ids.length) mutateSeq('Label', (seq) => seq.clips.forEach((c) => ids.includes(c.id) && (c.label = label)));
  },
  renameClip(id: Id, name: string) {
    mutateSeq('Rename clip', (seq) => {
      const c = seq.clips.find((x) => x.id === id);
      if (c) c.name = name;
    });
  },
  applyDefaultTransition(kind: 'video' | 'audio' | 'both' = 'both') {
    const seq = seqNow();
    if (!seq) return;
    const settings = useProject.getState().project.settings;
    const ids = selectedClipIds();
    const ph = playheadNow();
    mutateSeq('Apply default transition', (s) => {
      const targets = ids.length ? s.clips.filter((c) => ids.includes(c.id)) : [];
      if (!targets.length) {
        // apply at playhead on targeted tracks: find cuts at playhead
        for (const t of s.tracks) {
          if (!t.targeted || t.locked) continue;
          const onTrack = E.clipsOnTrackSorted(s, t.id);
          const right = onTrack.find((c) => c.start === ph);
          const left = onTrack.find((c) => c.start + c.duration === ph);
          const isAudio = t.kind === 'audio';
          if ((isAudio && kind === 'video') || (!isAudio && kind === 'audio')) continue;
          const type = isAudio ? settings.defaultAudioTransition : settings.defaultVideoTransition;
          const dur = isAudio ? settings.defaultAudioTransitionDuration : settings.defaultTransitionDuration;
          if (right) E.addTransition(s, right.id, 'in', type, dur, left ? 'center' : 'start');
          else if (left) E.addTransition(s, left.id, 'out', type, dur, 'end');
        }
        return;
      }
      for (const c of targets) {
        const track = s.tracks.find((t) => t.id === c.trackId);
        const isAudio = track?.kind === 'audio';
        if ((isAudio && kind === 'video') || (!isAudio && kind === 'audio')) continue;
        const type = isAudio ? settings.defaultAudioTransition : settings.defaultVideoTransition;
        const dur = isAudio ? settings.defaultAudioTransitionDuration : settings.defaultTransitionDuration;
        const onTrack = E.clipsOnTrackSorted(s, c.trackId);
        const i = onTrack.findIndex((x) => x.id === c.id);
        const prev = onTrack[i - 1],
          next = onTrack[i + 1];
        if (!c.transitionIn) E.addTransition(s, c.id, 'in', type, dur, prev && prev.start + prev.duration === c.start ? 'center' : 'start');
        if (!c.transitionOut) E.addTransition(s, c.id, 'out', type, dur, next && next.start === c.start + c.duration ? 'center' : 'end');
      }
    });
  },
  addTransitionTo(clipId: Id, edge: 'in' | 'out', type: string) {
    const settings = useProject.getState().project.settings;
    const def = TRANSITION_MAP[type];
    const dur = def?.audio ? settings.defaultAudioTransitionDuration : settings.defaultTransitionDuration;
    mutateSeq(`Add ${def?.name ?? 'transition'}`, (s) => {
      const c = s.clips.find((x) => x.id === clipId);
      if (!c) return;
      const onTrack = E.clipsOnTrackSorted(s, c.trackId);
      const i = onTrack.findIndex((x) => x.id === c.id);
      const nb = edge === 'in' ? onTrack[i - 1] : onTrack[i + 1];
      const adjacent = nb && (edge === 'in' ? nb.start + nb.duration === c.start : nb.start === c.start + c.duration);
      E.addTransition(s, clipId, edge, type, dur, adjacent ? 'center' : edge === 'in' ? 'start' : 'end');
    });
  },
  addEffectToSelection(type: string) {
    const ids = selectedClipIds();
    if (!ids.length) return toast('info', 'No clip selected', 'Select a clip in the timeline first, or drag the effect onto a clip.');
    cmd.addEffectToClips(ids, type);
  },
  applyPreset(ids: Id[], preset: { name: string; effects: { type: string; params: Record<string, Param> }[] }) {
    mutateSeq(`Apply preset ${preset.name}`, (seq) => {
      for (const c of seq.clips) {
        if (!ids.includes(c.id)) continue;
        const track = seq.tracks.find((t) => t.id === c.trackId);
        const isAudio = track?.kind === 'audio';
        for (const fx of preset.effects) {
          const def = getEffectDef(fx.type) ?? AUDIO_EFFECT_MAP[fx.type];
          if (!def || !!def.audio !== isAudio) continue;
          c.effects.push({ id: uid('fx'), type: fx.type, enabled: true, params: JSON.parse(JSON.stringify(fx.params)), masks: [] });
        }
      }
    });
  },
  addEffectToClips(ids: Id[], type: string) {
    if (type.startsWith('preset:')) {
      const pr = userPresets.byId(type.slice(7));
      if (pr) cmd.applyPreset(ids, pr);
      return;
    }
    const vdef = getEffectDef(type);
    const adef = AUDIO_EFFECT_MAP[type];
    const def = vdef ?? adef;
    if (!def) return;
    mutateSeq(`Add ${def.name}`, (seq) => {
      for (const c of seq.clips) {
        if (!ids.includes(c.id)) continue;
        const track = seq.tracks.find((t) => t.id === c.trackId);
        const isAudio = track?.kind === 'audio';
        if (!!def.audio !== isAudio) continue;
        c.effects.push({ id: uid('fx'), type, enabled: true, params: defaultEffectParams(def), masks: [] });
      }
    });
    useUI.getState().setSelection({ effectId: null });
  },
  copyEffect(clipId: Id, fxId: Id) {
    const seq = seqNow();
    const fx = seq?.clips.find((c) => c.id === clipId)?.effects.find((e) => e.id === fxId);
    if (!fx) return;
    const c = seq!.clips.find((x) => x.id === clipId)!;
    attrClipboard = JSON.parse(JSON.stringify({ motion: c.motion, audio: c.audio, effects: [fx] }));
    toast('success', 'Effect copied', 'Use Paste Attributes (Ctrl+Alt+V) on other clips to apply it.');
  },
  scaleToFrame(ids: Id[], mode: 'fit' | 'fill') {
    useProject.getState().update('Scale to frame size', (p) => {
      const s = p.sequences.find((x) => x.id === p.activeSequenceId);
      if (!s) return;
      for (const c of s.clips) {
        if (!ids.includes(c.id)) continue;
        const a = p.assets.find((x) => x.id === c.assetId);
        const w = a?.width ?? s.settings.width,
          h = a?.height ?? s.settings.height;
        const sx = s.settings.width / w,
          sy = s.settings.height / h;
        c.motion.scale = { value: (mode === 'fit' ? Math.min(sx, sy) : Math.max(sx, sy)) * 100 };
        c.motion.uniformScale = true;
      }
    });
  },
  /** Match the selected clip's average color/brightness to the clip immediately before it on the same track. */
  colorMatch() {
    const seq = seqNow();
    const ids = selectedClipIds();
    if (!seq || ids.length !== 1) return toast('info', 'Color match', 'Select exactly one video clip.');
    const clip = seq.clips.find((c) => c.id === ids[0])!;
    const prev = seq.clips.filter((c) => c.trackId === clip.trackId && c.start + c.duration <= clip.start).sort((a, b) => b.start - a.start)[0];
    if (!prev) return toast('info', 'Color match', 'There is no earlier clip on this track to match against.');
    const project = useProject.getState().project;
    void (async () => {
      const { renderFrameToCanvas } = await import('../engine/playback/playback');
      const stats = async (c: Clip) => {
        const cv = document.createElement('canvas');
        await renderFrameToCanvas(project, seq, c.start + Math.floor(c.duration / 2), cv, { scale: 8 });
        const ctx = cv.getContext('2d')!;
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let r = 0, g = 0, b = 0;
        const n = d.length / 4;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        return [r / n / 255, g / n / 255, b / n / 255] as [number, number, number];
      };
      const [ref, cur] = await Promise.all([stats(prev), stats(clip)]);
      const lumRef = 0.2126 * ref[0] + 0.7152 * ref[1] + 0.0722 * ref[2];
      const lumCur = 0.2126 * cur[0] + 0.7152 * cur[1] + 0.0722 * cur[2];
      const exposure = Math.max(-3, Math.min(3, Math.log2(Math.max(0.02, lumRef) / Math.max(0.02, lumCur))));
      const temp = Math.max(-100, Math.min(100, ((ref[2] - ref[0]) - (cur[2] - cur[0])) * 160));
      const tint = Math.max(-100, Math.min(100, ((ref[1] - (ref[0] + ref[2]) / 2) - (cur[1] - (cur[0] + cur[2]) / 2)) * 160));
      mutateSeq('Color match', (s) => {
        const c = s.clips.find((x) => x.id === clip.id)!;
        let fx = c.effects.find((e) => e.type === 'lumetri');
        if (!fx) {
          const def = getEffectDef('lumetri')!;
          fx = { id: uid('fx'), type: 'lumetri', enabled: true, params: defaultEffectParams(def), masks: [] };
          c.effects.push(fx);
        }
        fx.params.exposure = param(+exposure.toFixed(2));
        fx.params.temperature = param(+temp.toFixed(1));
        fx.params.tint = param(+tint.toFixed(1));
      });
      toast('success', 'Color matched', `Exposure ${exposure >= 0 ? '+' : ''}${exposure.toFixed(2)}, temperature ${temp.toFixed(0)}, tint ${tint.toFixed(0)}`);
    })();
  },
  removeEffects(clipIds: Id[]) {
    mutateSeq('Remove effects', (seq) => {
      for (const c of seq.clips) if (clipIds.includes(c.id)) c.effects = [];
    });
  },
  copyAttributes() {
    const clips = selectedClips();
    if (clips.length !== 1) return toast('info', 'Copy attributes', 'Select exactly one clip to copy attributes from.');
    const c = clips[0];
    attrClipboard = JSON.parse(JSON.stringify({ motion: c.motion, audio: c.audio, effects: c.effects }));
    logEvent('info', `Copied attributes from ${c.name}`);
  },
  pasteAttributes(what: { motion: boolean; audio: boolean; effects: boolean }) {
    if (!attrClipboard) return;
    const ids = selectedClipIds();
    mutateSeq('Paste attributes', (seq) => {
      for (const c of seq.clips) {
        if (!ids.includes(c.id)) continue;
        if (what.motion && attrClipboard!.motion) c.motion = JSON.parse(JSON.stringify(attrClipboard!.motion));
        if (what.audio && attrClipboard!.audio) c.audio = JSON.parse(JSON.stringify(attrClipboard!.audio));
        if (what.effects) c.effects = [...c.effects, ...attrClipboard!.effects.map((e) => ({ ...JSON.parse(JSON.stringify(e)), id: uid('fx') }))];
      }
    });
  },
  hasAttributes() {
    return !!attrClipboard;
  },
  hasClipboard() {
    return !!clipboard;
  },

  /* sequence */
  newSequence() {
    useUI.getState().openModal({ kind: 'newSequence' });
  },
  createSequence(name: string, settings: Partial<Sequence['settings']>, tracks: { video: number; audio: number }) {
    const s = createSequence(name, settings, tracks);
    useProject.getState().update('New sequence', (p) => {
      p.sequences.push(s);
      p.openSequenceIds.push(s.id);
      p.activeSequenceId = s.id;
      p.assets.push({ id: uid('ast'), kind: 'sequence', name, binId: useUI.getState().currentBinId, label: 'iris', sequenceId: s.id, hasVideo: true, hasAudio: true, width: s.settings.width, height: s.settings.height, fps: s.settings.fps, duration: 0, offline: false, createdAt: Date.now(), meta: {} });
    });
    usePlayback.setState({ playhead: 0 });
    return s.id;
  },
  openSequence(id: Id) {
    useProject.getState().update('Open sequence', (p) => {
      if (!p.openSequenceIds.includes(id)) p.openSequenceIds.push(id);
      p.activeSequenceId = id;
    });
    const s = getActiveSequence(useProject.getState().project);
    usePlayback.getState().pause();
    usePlayback.setState({ playhead: s?.view.playhead ?? 0 });
    useUI.getState().clearSelection();
  },
  closeSequenceTab(id: Id) {
    useProject.getState().updateTransient((p) => {
      p.openSequenceIds = p.openSequenceIds.filter((x) => x !== id);
      if (p.activeSequenceId === id) p.activeSequenceId = p.openSequenceIds[p.openSequenceIds.length - 1] ?? null;
    });
    useUI.getState().clearSelection();
  },
  razorAtPlayhead(allTracks: boolean) {
    const ph = playheadNow();
    const ui = useUI.getState();
    mutateSeq('Add edit', (seq) => {
      const sel = ui.selection.clipIds;
      if (sel.length) E.razorAt(seq, ph, undefined, sel);
      else E.razorAt(seq, ph, allTracks ? undefined : seq.tracks.filter((t) => t.targeted && !t.locked).map((t) => t.id));
    });
  },
  markIn() {
    const ph = playheadNow();
    mutateSeq('Mark in', (seq) => {
      seq.inPoint = ph;
      if (seq.outPoint != null && seq.outPoint <= ph) seq.outPoint = null;
    });
  },
  markOut() {
    const ph = playheadNow();
    mutateSeq('Mark out', (seq) => {
      seq.outPoint = ph;
      if (seq.inPoint != null && seq.inPoint >= ph) seq.inPoint = null;
    });
  },
  clearInOut(which: 'in' | 'out' | 'both' = 'both') {
    mutateSeq('Clear in/out', (seq) => {
      if (which !== 'out') seq.inPoint = null;
      if (which !== 'in') seq.outPoint = null;
    });
  },
  markClip() {
    const clips = selectedClips();
    if (!clips.length) return;
    const start = Math.min(...clips.map((c) => c.start));
    const end = Math.max(...clips.map((c) => c.start + c.duration));
    mutateSeq('Mark clip', (seq) => {
      seq.inPoint = start;
      seq.outPoint = end;
    });
  },
  markSelection() {
    cmd.markClip();
  },
  goTo(where: 'in' | 'out' | 'start' | 'end' | 'prevEdit' | 'nextEdit' | 'prevMarker' | 'nextMarker' | 'selStart' | 'selEnd') {
    const seq = seqNow();
    if (!seq) return;
    const pb = usePlayback.getState();
    const ph = pb.playhead;
    let f: number | null = null;
    switch (where) {
      case 'in':
        f = seq.inPoint;
        break;
      case 'out':
        f = seq.outPoint;
        break;
      case 'start':
        f = 0;
        break;
      case 'end':
        f = sequenceDuration(seq);
        break;
      case 'prevEdit': {
        const pts = E.editPoints(seq, seq.tracks.filter((t) => t.targeted).map((t) => t.id));
        const prev = pts.filter((p) => p < ph);
        f = prev.length ? prev[prev.length - 1] : 0;
        break;
      }
      case 'nextEdit': {
        const pts = E.editPoints(seq, seq.tracks.filter((t) => t.targeted).map((t) => t.id));
        f = pts.find((p) => p > ph) ?? sequenceDuration(seq);
        break;
      }
      case 'prevMarker': {
        const ms = seq.markers.map((m) => m.time).filter((t) => t < ph).sort((a, b) => a - b);
        f = ms.length ? ms[ms.length - 1] : null;
        break;
      }
      case 'nextMarker': {
        f = seq.markers.map((m) => m.time).filter((t) => t > ph).sort((a, b) => a - b)[0] ?? null;
        break;
      }
      case 'selStart': {
        const b = E.selectionBounds(seq, selectedClipIds());
        f = b ? b[0] : null;
        break;
      }
      case 'selEnd': {
        const b = E.selectionBounds(seq, selectedClipIds());
        f = b ? b[1] : null;
        break;
      }
    }
    if (f != null) pb.setPlayhead(f, { fromUser: true });
  },
  addMarker(opts: Partial<Marker> = {}) {
    const ph = playheadNow();
    let id = '';
    mutateSeq('Add marker', (seq) => {
      const existing = seq.markers.find((m) => m.time === ph && m.duration === 0);
      if (existing && !opts.name) {
        id = existing.id;
        return;
      }
      const m: Marker = { id: uid('mk'), time: ph, duration: 0, name: '', comment: '', color: 'green', kind: 'comment', ...opts };
      seq.markers.push(m);
      id = m.id;
    });
    return id;
  },
  clearAllMarkers() {
    mutateSeq('Clear markers', (seq) => {
      seq.markers = [];
    });
  },
  clearSelectedMarkers() {
    const ids = useUI.getState().selection.markerIds;
    mutateSeq('Clear marker', (seq) => {
      seq.markers = seq.markers.filter((m) => !ids.includes(m.id));
    });
    useUI.getState().setSelection({ markerIds: [] });
  },
  liftExtract(extract: boolean) {
    const seq = seqNow();
    if (!seq || seq.inPoint == null || seq.outPoint == null) return toast('info', extract ? 'Extract' : 'Lift', 'Set in and out points first.');
    const [a, b] = [seq.inPoint, seq.outPoint];
    mutateSeq(extract ? 'Extract' : 'Lift', (s) => {
      E.liftRange(s, a, b, extract, s.tracks.filter((t) => t.targeted && !t.locked).map((t) => t.id));
      if (extract) {
        s.inPoint = null;
        s.outPoint = null;
      }
    });
  },
  insertOverwriteFromSource(mode: 'insert' | 'overwrite') {
    const ui = useUI.getState();
    const assetId = ui.sourceAssetId;
    if (!assetId) return toast('info', 'Source monitor is empty', 'Open a clip in the Source Monitor first (double-click it in the Project panel).');
    const p = useProject.getState().project;
    const asset = findAsset(p, assetId);
    if (!asset) return;
    const seq = seqNow();
    if (!seq) return;
    const ph = seq.inPoint ?? playheadNow();
    let ids: Id[] = [];
    mutateSeq(mode === 'insert' ? 'Insert' : 'Overwrite', (s, proj) => {
      ids = E.placeAsset(proj, s, asset, ph, { mode, srcIn: asset.srcIn, srcOut: asset.srcOut });
    });
    if (ids.length) {
      const c = seqNow()?.clips.find((x) => x.id === ids[0]);
      if (c) usePlayback.getState().setPlayhead(c.start + c.duration, { fromUser: true });
    } else toast('warning', 'Nothing placed', 'No unlocked target track available for this media type.');
  },
  matchFrame() {
    const seq = seqNow();
    if (!seq) return;
    const ph = playheadNow();
    const ui = useUI.getState();
    const c = seq.clips
      .filter((c) => ph >= c.start && ph < c.start + c.duration && seq.tracks.find((t) => t.id === c.trackId)?.targeted)
      .sort((a, b) => trackOrder(seq, b.trackId) - trackOrder(seq, a.trackId))[0];
    if (!c || !c.assetId) return;
    ui.setSourceAssetId(c.assetId);
    ui.setSourceTime(E.sourceTimeAt(c, ph, seq.settings.fps));
  },
  revealAsset(id: Id) {
    const p = useProject.getState().project;
    const a = findAsset(p, id);
    if (!a) return;
    const ui = useUI.getState();
    ui.setCurrentBinId(a.binId ?? null);
    projectSelection.set([a.id]);
    ui.setFocusedPanel('project');
  },
  revealInProject() {
    const c = selectedClips()[0];
    if (!c) return;
    const ui = useUI.getState();
    ui.setProjectSearch('');
    ui.setSelection({});
    const asset = findAsset(useProject.getState().project, c.assetId);
    if (asset) {
      ui.setCurrentBinId(asset.binId);
      projectSelection.set([asset.id]);
    }
  },
  addTrack(kind: 'video' | 'audio', atIndex?: number) {
    mutateSeq('Add track', (seq) => {
      E.addTrack(seq, kind, atIndex);
      renumberTracks(seq);
    });
  },
  deleteTrack(id: Id) {
    mutateSeq('Delete track', (seq) => {
      E.deleteTrack(seq, id);
      renumberTracks(seq);
    });
  },
  deleteEmptyTracks() {
    mutateSeq('Delete empty tracks', (seq) => {
      E.deleteEmptyTracks(seq);
      renumberTracks(seq);
    });
  },
  closeGapAtPlayhead() {
    const ph = playheadNow();
    mutateSeq('Close gap', (seq) => {
      for (const t of seq.tracks) if (t.targeted) E.closeGap(seq, t.id, ph);
    });
  },
  removeAllGaps() {
    mutateSeq('Remove all gaps', (seq) => {
      for (const t of seq.tracks) if (!t.locked) E.removeAllGaps(seq, t.id);
    });
  },
  toggleTrackTarget(id: Id) {
    mutateSeq('Toggle track target', (seq) => {
      const t = seq.tracks.find((x) => x.id === id);
      if (t) t.targeted = !t.targeted;
    });
  },
  setTrackProp(id: Id, patch: Partial<Sequence['tracks'][number]>, label = 'Track') {
    mutateSeq(label, (seq) => {
      const t = seq.tracks.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
    });
  },
  nudge(frames: number, tracks = 0) {
    const ids = selectedClipIds();
    if (!ids.length) return;
    mutateSeq('Nudge', (seq) => {
      const all = withSelectionExpanded(seq, ids);
      let shift: Map<Id, Id> | null = null;
      if (tracks) {
        shift = new Map();
        for (const id of all) {
          const c = seq.clips.find((x) => x.id === id)!;
          const same = seq.tracks.filter((t) => t.kind === seq.tracks.find((x) => x.id === c.trackId)?.kind);
          const i = same.findIndex((t) => t.id === c.trackId);
          const target = same[i + tracks];
          if (!target || target.locked) return;
          shift.set(id, target.id);
        }
      }
      E.moveClips(seq, all, frames, shift);
    });
  },
  exportFrame: async (format: 'png' | 'jpeg' = 'png') => {
    const seq = seqNow();
    if (!seq) return;
    const blob = await exportFrame(useProject.getState().project, seq, playheadNow(), format);
    download(blob, `${seq.name}_${String(playheadNow()).padStart(6, '0')}.${format === 'png' ? 'png' : 'jpg'}`);
    toast('success', 'Frame exported', `${seq.settings.width} x ${seq.settings.height} ${format.toUpperCase()}`);
  },
  exportEDL() {
    const seq = seqNow();
    if (!seq) return;
    download(new Blob([exportEDL(useProject.getState().project, seq)], { type: 'text/plain' }), `${seq.name}.edl`);
  },
  exportMarkers(kind: 'csv' | 'chapters') {
    const seq = seqNow();
    if (!seq) return;
    if (kind === 'csv') download(new Blob([exportMarkersCSV(seq)], { type: 'text/csv' }), `${seq.name}_markers.csv`);
    else download(new Blob([exportChaptersYouTube(seq)], { type: 'text/plain' }), `${seq.name}_chapters.txt`);
  },
  exportCaptions(format: 'srt' | 'vtt') {
    const seq = seqNow();
    if (!seq || !seq.captions.length) return toast('info', 'No captions', 'This sequence has no captions to export.');
    const fps = seq.settings.fps;
    const tc = (f: number, sep: string) => {
      const ms = Math.round((f / fps) * 1000);
      const h = Math.floor(ms / 3600000),
        m = Math.floor((ms % 3600000) / 60000),
        s = Math.floor((ms % 60000) / 1000),
        r = ms % 1000;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
    };
    const sorted = [...seq.captions].sort((a, b) => a.start - b.start);
    const body = format === 'srt' ? sorted.map((c, i) => `${i + 1}\n${tc(c.start, ',')} --> ${tc(c.end, ',')}\n${c.text}\n`).join('\n') : 'WEBVTT\n\n' + sorted.map((c) => `${tc(c.start, '.')} --> ${tc(c.end, '.')}\n${c.text}\n`).join('\n');
    download(new Blob([body], { type: 'text/plain' }), `${seq.name}.${format}`);
  },
  async autosave() {
    await autosaveNow();
    if (useSettings.getState().verboseToasts) toast('info', 'Autosaved', 'Project snapshot stored in browser storage.');
  },
  /* project panel */
  newBin(name = 'New Bin') {
    const parent = useUI.getState().currentBinId;
    let id = '';
    useProject.getState().update('New bin', (p) => {
      id = uid('bin');
      p.bins.push({ id, name, parentId: parent, label: p.settings.labelDefaults.bin, expanded: true });
    });
    return id;
  },
  newGenerator(kind: GeneratorKind, params: Record<string, number | string | boolean> = {}, name?: string) {
    const seq = seqNow();
    const settings = useProject.getState().project.settings;
    const label = kind === 'adjustmentLayer' ? settings.labelDefaults.adjustment : kind === 'graphic' ? settings.labelDefaults.graphic : 'tan';
    const names: Record<GeneratorKind, string> = { colorMatte: 'Color Matte', adjustmentLayer: 'Adjustment Layer', blackVideo: 'Black Video', barsAndTone: 'Bars and Tone', graphic: 'Graphic', countdown: 'Universal Counting Leader' };
    const asset: MediaAsset = {
      id: uid('ast'),
      kind: 'generator',
      name: name ?? names[kind],
      binId: useUI.getState().currentBinId,
      label,
      generator: kind,
      generatorParams: params,
      width: seq?.settings.width ?? 1920,
      height: seq?.settings.height ?? 1080,
      fps: seq?.settings.fps ?? 30,
      duration: kind === 'countdown' ? 11 : kind === 'barsAndTone' ? 30 : settings.defaultStillDuration / (seq?.settings.fps ?? 30),
      hasVideo: true,
      hasAudio: kind === 'barsAndTone' || kind === 'countdown',
      offline: false,
      createdAt: Date.now(),
      meta: {},
    };
    useProject.getState().update(`New ${asset.name}`, (p) => {
      p.assets.push(asset);
    });
    return asset;
  },
  deleteAssets(ids: Id[]) {
    useProject.getState().update('Delete items', (p) => {
      // remove bins recursively
      const binIds = new Set<Id>();
      const collect = (id: Id) => {
        binIds.add(id);
        p.bins.filter((b) => b.parentId === id).forEach((b) => collect(b.id));
      };
      for (const id of ids) if (p.bins.some((b) => b.id === id)) collect(id);
      p.bins = p.bins.filter((b) => !binIds.has(b.id));
      const assetIds = new Set(ids.filter((id) => p.assets.some((a) => a.id === id)));
      for (const a of p.assets) if (a.binId && binIds.has(a.binId)) assetIds.add(a.id);
      const seqIds = new Set(p.assets.filter((a) => assetIds.has(a.id) && a.kind === 'sequence').map((a) => a.sequenceId));
      p.assets = p.assets.filter((a) => !assetIds.has(a.id));
      for (const s of p.sequences) s.clips = s.clips.filter((c) => !(c.assetId && assetIds.has(c.assetId)));
      p.sequences = p.sequences.filter((s) => !seqIds.has(s.id));
      p.openSequenceIds = p.openSequenceIds.filter((id) => !seqIds.has(id));
      if (p.activeSequenceId && seqIds.has(p.activeSequenceId)) p.activeSequenceId = p.openSequenceIds[0] ?? p.sequences[0]?.id ?? null;
    });
    useUI.getState().clearSelection();
  },
  renameAsset(id: Id, name: string) {
    useProject.getState().update('Rename', (p) => {
      const a = p.assets.find((x) => x.id === id);
      if (a) {
        a.name = name;
        if (a.kind === 'sequence') {
          const s = p.sequences.find((x) => x.id === a.sequenceId);
          if (s) s.name = name;
        }
        return;
      }
      const b = p.bins.find((x) => x.id === id);
      if (b) b.name = name;
    });
  },
  moveAssetsToBin(ids: Id[], binId: Id | null) {
    useProject.getState().update('Move to bin', (p) => {
      for (const a of p.assets) if (ids.includes(a.id)) a.binId = binId;
      for (const b of p.bins) if (ids.includes(b.id) && b.id !== binId) b.parentId = binId;
    });
  },
  newSequenceFromClip(asset: MediaAsset) {
    const name = stripExt(asset.name);
    const id = cmd.createSequence(name, { width: asset.width ?? 1920, height: asset.height ?? 1080, fps: asset.fps ?? 30 }, { video: 3, audio: 3 });
    useProject.getState().update('Add to sequence', (p) => {
      const s = p.sequences.find((x) => x.id === id);
      if (s) E.placeAsset(p, s, asset, 0, { mode: 'overwrite' });
    });
  },
  removeUnused() {
    useProject.getState().update('Remove unused', (p) => {
      const used = new Set<Id>();
      for (const s of p.sequences) for (const c of s.clips) if (c.assetId) used.add(c.assetId);
      p.assets = p.assets.filter((a) => a.kind === 'sequence' || used.has(a.id));
    });
  },
  addClipsToSequenceAtPlayhead(assets: MediaAsset[], mode: 'insert' | 'overwrite') {
    cmd.placeAssetsAt(assets, playheadNow(), mode);
  },
  /** Place assets beginning at an explicit frame (used by capture features). */
  placeAssetsAt(assets: MediaAsset[], frame: number, mode: 'insert' | 'overwrite' = 'overwrite') {
    let cursor = Math.max(0, frame);
    let ids: Id[] = [];
    mutateSeq('Add to timeline', (seq, p) => {
      for (const a of assets) {
        const out = E.placeAsset(p, seq, a, cursor, { mode });
        ids.push(...out);
        const c = seq.clips.find((x) => x.id === out[0]);
        if (c) cursor = c.start + c.duration;
      }
    });
    if (ids.length) useUI.getState().selectClips(ids);
  },

  /* color */
  /** One-click Auto Color on the selection (or the clip under the playhead). */
  async autoColorSelection(strength = 1) {
    const project = useProject.getState().project;
    const seq = seqNow();
    if (!seq) return toast('warning', 'No sequence', 'Open a sequence, select a clip and run Auto Color again.');
    let clips = selectedClips().filter((c) => c.effects !== undefined && seq.tracks.find((t) => t.id === c.trackId)?.kind === 'video');
    if (!clips.length) {
      const ph = playheadNow();
      clips = seq.clips.filter((c) => seq.tracks.find((t) => t.id === c.trackId)?.kind === 'video' && ph >= c.start && ph < E.clipEnd(c));
    }
    if (!clips.length) return toast('info', 'Nothing to color', 'Select a video clip (or park the playhead over one) and try again.');
    let done = 0;
    let params: import('../engine/color/autoColor').AutoColorParams | null = null;
    useProject.getState().beginBatch('Auto color');
    for (const clip of clips) {
      const live = useProject.getState().project.sequences.find((s) => s.id === seq.id)!.clips.find((c) => c.id === clip.id)!;
      const frame = Math.min(E.clipEnd(live) - 1, Math.max(live.start, playheadNow()));
      const stats = await analyzeClipFrame(useProject.getState().project, seq, live, frame);
      if (!stats) continue;
      const p2 = autoColorParamsFrom(stats, strength);
      params = p2;
      useProject.getState().updateTransient((p) => {
        const s = p.sequences.find((x) => x.id === seq.id);
        const c = s?.clips.find((x) => x.id === live.id);
        if (!c) return;
        let fx = c.effects.find((e) => e.type === 'lumetri');
        if (!fx) {
          const d = getEffectDef('lumetri')!;
          const defaults: Record<string, Param> = {};
          for (const pd of d.params) defaults[pd.key] = param(pd.default);
          fx = { id: uid('fx'), type: 'lumetri', enabled: true, params: defaults, masks: [] };
          c.effects.push(fx);
        }
        const setVal = (key: string, v: number) => {
          const cur = fx!.params[key];
          if (cur && !cur.animated) fx!.params[key] = { ...cur, value: v };
          else if (!cur) fx!.params[key] = param(v);
        };
        setVal('exposure', p2.exposure);
        setVal('contrast', p2.contrast);
        setVal('blacks', p2.blacks);
        setVal('whites', p2.whites);
        setVal('temperature', p2.temperature);
        setVal('tint', p2.tint);
        setVal('saturation', p2.saturation);
      });
      done++;
    }
    if (done) {
      // One undoable step for the whole batch.
      useProject.getState().endBatch();
      toast('success', `Auto Color applied to ${done} clip${done === 1 ? '' : 's'}`, params ? `Exposure ${params.exposure > 0 ? '+' : ''}${params.exposure.toFixed(1)}, temperature ${params.temperature > 0 ? '+' : ''}${params.temperature.toFixed(0)}` : undefined);
    } else {
      useProject.getState().cancelBatch();
      toast('warning', 'Auto Color', 'Could not read a frame from the selection.');
    }
  },
};

let clipboard: E.ClipboardPayload | null = null;
let attrClipboard: { motion: Clip['motion']; audio: Clip['audio']; effects: Clip['effects'] } | null = null;

function trackOrder(seq: Sequence, id: Id) {
  return seq.tracks.findIndex((t) => t.id === id);
}

export function resolveParam(clip: Clip, path: string): { keyframes?: any[]; value: any; animated?: boolean } | null {
  const parts = path.split('.');
  if (parts[0] === 'motion') return (clip.motion as any)[parts[1]] ?? null;
  if (parts[0] === 'audio') return (clip.audio as any)[parts[1]] ?? null;
  if (parts[0] === 'fx') {
    const fx = clip.effects.find((e) => e.id === parts[1]);
    if (!fx) return null;
    if (parts[2] === 'mask') {
      const m = fx.masks.find((x) => x.id === parts[3]);
      return m ? (m as any)[parts[4]] ?? null : null;
    }
    return fx.params[parts[2]] ?? null;
  }
  return null;
}

/** Project panel selection lives outside the UI store so the timeline selection remains independent. */
class ProjectSelection {
  ids: Id[] = [];
  listeners = new Set<() => void>();
  set(ids: Id[]) {
    this.ids = ids;
    this.listeners.forEach((l) => l());
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  get() {
    return this.ids;
  }
}
export const projectSelection = new ProjectSelection();

export type TransitionAlign = Transition['alignment'];
export { param };
