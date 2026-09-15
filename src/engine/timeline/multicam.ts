import type { Id, MulticamAngle, MulticamData, Sequence } from '../../types/project';
import { useProject } from '../../state/projectStore';
import { useUI } from '../../state/uiStore';
import { getMedia } from '../media/mediaStore';
import { findSyncOffset } from '../audio/sync';

/**
 * Multicam editing engine:
 * Creates multicam sequences, aligns multi-camera angles via audio waveform sync,
 * and manages live angle switching during playback.
 */

export async function createMulticamSequenceFromAssets(
  assetIds: Id[],
  name = 'Multicam Sequence',
  syncMethod: 'audio' | 'inPoint' | 'manual' = 'audio'
): Promise<Id | null> {
  const project = useProject.getState().project;
  const assets = assetIds.map((id) => project.assets.find((a) => a.id === id)).filter(Boolean);
  if (assets.length < 2) {
    useUI.getState().toast({ kind: 'warning', title: 'Multicam', message: 'Select at least 2 media clips to create a Multicam sequence.' });
    return null;
  }

  const fps = assets[0]?.fps || project.settings.defaultSequence.fps || 30;
  const W = assets[0]?.width || project.settings.defaultSequence.width || 1920;
  const H = assets[0]?.height || project.settings.defaultSequence.height || 1080;

  // Compute audio sync offsets if requested
  let offsetsSec: number[] = new Array(assets.length).fill(0);
  if (syncMethod === 'audio') {
    try {
      const refMedia = getMedia(assets[0]!.id);
      if (refMedia?.audio) {
        for (let i = 1; i < assets.length; i++) {
          const othMedia = getMedia(assets[i]!.id);
          if (othMedia?.audio) {
            const sync = findSyncOffset(refMedia.audio, othMedia.audio);
            offsetsSec[i] = sync.offsetSec;
          }
        }
      }
    } catch {
      useUI.getState().toast({ kind: 'warning', title: 'Audio Sync', message: 'Audio alignment failed; falling back to clip start.' });
    }
  }

  const seqId = `seq_mc_${Date.now()}`;
  const angles: MulticamAngle[] = [];
  const tracks: any[] = [];
  const clips: any[] = [];

  assets.forEach((asset, idx) => {
    const angleId = `angle_${idx + 1}`;
    const vTrackId = `trk_mc_v_${idx + 1}`;
    const aTrackId = `trk_mc_a_${idx + 1}`;
    const offsetFrame = Math.round((offsetsSec[idx] || 0) * fps);

    angles.push({
      id: angleId,
      name: `Angle ${idx + 1}: ${asset!.name}`,
      trackId: vTrackId,
      assetId: asset!.id,
    });

    tracks.push({
      id: vTrackId,
      kind: 'video',
      name: `Angle ${idx + 1}`,
      height: 48,
      locked: false,
      muted: false,
      solo: false,
      visible: true,
      targeted: idx === 0,
      syncLocked: true,
      volume: { value: 0 },
      pan: { value: 0 },
      effects: [],
      showKeyframes: 'clip',
      output: 'master',
    });

    tracks.push({
      id: aTrackId,
      kind: 'audio',
      name: `Audio ${idx + 1}`,
      height: 44,
      locked: false,
      muted: idx !== 0, // Mute non-primary audio by default
      solo: false,
      visible: true,
      targeted: idx === 0,
      syncLocked: true,
      volume: { value: 0 },
      pan: { value: 0 },
      effects: [],
      showKeyframes: 'clip',
      output: 'master',
    });

    const durFrames = Math.max(30, Math.round((asset!.duration || 10) * fps));
    const startFrame = Math.max(0, offsetFrame);

    clips.push({
      id: `clip_mc_v_${idx}`,
      trackId: vTrackId,
      assetId: asset!.id,
      name: asset!.name,
      start: startFrame,
      duration: durFrames,
      inPoint: 0,
      speed: 1,
      reversed: false,
      maintainPitch: true,
      enabled: true,
      label: 'cerulean',
      linkId: `link_mc_${idx}`,
      groupId: null,
      motion: { position: { value: [0.5, 0.5] }, scale: { value: 100 }, scaleWidth: { value: 100 }, uniformScale: true, rotation: { value: 0 }, anchor: { value: [0.5, 0.5] }, opacity: { value: 100 }, blendMode: 'normal', antiFlicker: { value: 0 } },
      audio: { gain: 0, volume: { value: 0 }, pan: { value: 0 }, muted: false, channelMode: 'stereo', invertPhase: false },
      effects: [],
      transitionIn: null,
      transitionOut: null,
      markers: [],
    });

    clips.push({
      id: `clip_mc_a_${idx}`,
      trackId: aTrackId,
      assetId: asset!.id,
      name: asset!.name,
      start: startFrame,
      duration: durFrames,
      inPoint: 0,
      speed: 1,
      reversed: false,
      maintainPitch: true,
      enabled: true,
      label: 'teal',
      linkId: `link_mc_${idx}`,
      groupId: null,
      motion: { position: { value: [0.5, 0.5] }, scale: { value: 100 }, scaleWidth: { value: 100 }, uniformScale: true, rotation: { value: 0 }, anchor: { value: [0.5, 0.5] }, opacity: { value: 100 }, blendMode: 'normal', antiFlicker: { value: 0 } },
      audio: { gain: 0, volume: { value: 0 }, pan: { value: 0 }, muted: false, channelMode: 'stereo', invertPhase: false },
      effects: [],
      transitionIn: null,
      transitionOut: null,
      markers: [],
    });
  });

  const multicam: MulticamData = {
    angles,
    audioAngleId: angles[0].id,
    switches: [{ frame: 0, angleId: angles[0].id }],
    syncMethod,
    createdAt: Date.now(),
  };

  useProject.getState().update('Create Multicam Sequence', (p) => {
    p.sequences.push({
      id: seqId,
      name,
      settings: { ...p.settings.defaultSequence, width: W, height: H, fps },
      tracks,
      clips,
      markers: [],
      captions: [],
      captionTrack: { enabled: false, burnIn: false, style: { fontFamily: 'Inter', fontSize: 48, fontWeight: 500, italic: false, color: '#f0f0f0', backgroundColor: '#000000', backgroundOpacity: 0.6, edge: 'none', edgeColor: '#000000', align: 'center', position: 0.9, maxWidth: 0.8, letterSpacing: 0 }, name: 'Captions' },
      inPoint: null,
      outPoint: null,
      workArea: { enabled: false, start: 0, end: 300 },
      view: { pixelsPerFrame: 10, scrollFrame: 0, scrollY: 0, playhead: 0 },
      label: 'cerulean',
      binId: null,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      multicam,
    });
    p.openSequenceIds.push(seqId);
    p.activeSequenceId = seqId;
  });

  useUI.getState().toast({ kind: 'success', title: 'Multicam Sequence Created', message: `Created "${name}" with ${angles.length} camera angles.` });
  return seqId;
}

/** Record or switch angle at playhead. */
export function switchMulticamAngle(seqId: Id, angleId: Id, frame: number): boolean {
  let switched = false;
  useProject.getState().update('Switch Multicam Angle', (p) => {
    const s = p.sequences.find((x) => x.id === seqId);
    if (!s || !s.multicam) return;

    const mc = s.multicam;
    const existingIdx = mc.switches.findIndex((sw) => Math.abs(sw.frame - frame) <= 2);
    if (existingIdx >= 0) {
      mc.switches[existingIdx].angleId = angleId;
    } else {
      mc.switches.push({ frame, angleId });
      mc.switches.sort((a, b) => a.frame - b.frame);
    }

    // Adjust track visibility so active angle track is primary
    const targetAngle = mc.angles.find((a) => a.id === angleId);
    if (targetAngle) {
      s.tracks.forEach((t) => {
        if (t.kind === 'video') {
          t.visible = t.id === targetAngle.trackId;
        }
      });
    }

    switched = true;
  });
  return switched;
}

/** Returns active angle at specified frame. */
export function getActiveAngleAtFrame(multicam: MulticamData, frame: number): MulticamAngle | null {
  if (!multicam || !multicam.angles.length) return null;
  const sorted = [...multicam.switches].sort((a, b) => a.frame - b.frame);
  let activeAngleId = sorted[0]?.angleId ?? multicam.angles[0].id;
  for (const sw of sorted) {
    if (frame >= sw.frame) activeAngleId = sw.angleId;
    else break;
  }
  return multicam.angles.find((a) => a.id === activeAngleId) ?? multicam.angles[0];
}
