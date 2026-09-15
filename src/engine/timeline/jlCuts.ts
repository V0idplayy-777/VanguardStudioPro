import type { Clip, Sequence } from '../../types/project';
import { useProject } from '../../state/projectStore';
import { useUI } from '../../state/uiStore';

/**
 * Automates J-Cuts (audio starts before video) and L-Cuts (audio extends past video).
 * Applies to selected clip or linked audio/video clip pairs.
 */

export function applyJCut(seqId: string, clipId: string, frames = 30): boolean {
  let done = false;
  useProject.getState().update('Create J-Cut', (p) => {
    const s = p.sequences.find((x) => x.id === seqId);
    if (!s) return;
    const clip = s.clips.find((c) => c.id === clipId);
    if (!clip) return;

    // Find linked clip if any
    const linked = clip.linkId ? s.clips.find((c) => c.linkId === clip.linkId && c.id !== clip.id) : null;
    const track = s.tracks.find((t) => t.id === clip.trackId);
    if (!track) return;

    const isVideo = track.kind === 'video';
    const videoClip = isVideo ? clip : linked && s.tracks.find((t) => t.id === linked.trackId)?.kind === 'video' ? linked : null;
    const audioClip = !isVideo ? clip : linked && s.tracks.find((t) => t.id === linked.trackId)?.kind === 'audio' ? linked : null;

    if (videoClip && audioClip) {
      // Audio starts earlier than video
      const maxShift = Math.min(frames, audioClip.start, Math.floor(audioClip.inPoint * s.settings.fps));
      if (maxShift > 0) {
        audioClip.start -= maxShift;
        audioClip.duration += maxShift;
        audioClip.inPoint -= maxShift / s.settings.fps;
        done = true;
      }
    } else if (audioClip) {
      // Audio-only J-cut offset
      const maxShift = Math.min(frames, audioClip.start, Math.floor(audioClip.inPoint * s.settings.fps));
      if (maxShift > 0) {
        audioClip.start -= maxShift;
        audioClip.duration += maxShift;
        audioClip.inPoint -= maxShift / s.settings.fps;
        done = true;
      }
    }
  });

  if (done) {
    useUI.getState().toast({ kind: 'info', title: 'J-Cut Created', message: `Extended audio ${frames} frames before video.` });
  }
  return done;
}

export function applyLCut(seqId: string, clipId: string, frames = 30): boolean {
  let done = false;
  useProject.getState().update('Create L-Cut', (p) => {
    const s = p.sequences.find((x) => x.id === seqId);
    if (!s) return;
    const clip = s.clips.find((c) => c.id === clipId);
    if (!clip) return;

    const linked = clip.linkId ? s.clips.find((c) => c.linkId === clip.linkId && c.id !== clip.id) : null;
    const track = s.tracks.find((t) => t.id === clip.trackId);
    if (!track) return;

    const isVideo = track.kind === 'video';
    const audioClip = !isVideo ? clip : linked && s.tracks.find((t) => t.id === linked.trackId)?.kind === 'audio' ? linked : null;

    if (audioClip) {
      // Audio extends past video
      audioClip.duration += frames;
      done = true;
    }
  });

  if (done) {
    useUI.getState().toast({ kind: 'info', title: 'L-Cut Created', message: `Extended audio ${frames} frames past video end.` });
  }
  return done;
}
