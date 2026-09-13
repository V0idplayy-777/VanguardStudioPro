/*
  Retention toolkit - sequence analysis.

  Scores the active sequence against the Corporate Retention & Engagement
  Playbook and returns findings the Retention Check panel can act on.
*/

import type { Sequence } from '../types/project';
import * as E from '../engine/timeline/edits';
import { sequenceDuration } from '../state/projectStore';

export type FindingStatus = 'ok' | 'warn' | 'info';

export interface RetentionFinding {
  id: string;
  status: FindingStatus;
  title: string;
  detail: string;
  /** Id of the fix action handled by the Retention Check panel. */
  fix?: 'smartCaptions' | 'zoomPunches' | 'flashOnCuts' | 'musicBed' | 'loopOutro' | 'rewindTrap' | 'typoBait' | 'retentionCaptionStyle';
}

export interface RetentionReport {
  findings: RetentionFinding[];
  /** Longest span between visual resets, in seconds (pacing check). */
  longestStaticSec: number;
  /** Cuts in the first three seconds (hook check). */
  hookCuts: number;
}

export function analyzeRetention(seq: Sequence): RetentionReport {
  const fps = seq.settings.fps;
  const D = sequenceDuration(seq);
  const durSec = D / fps;
  const videoTracks = seq.tracks.filter((t) => t.kind === 'video');
  const videoTrackIds = videoTracks.map((t) => t.id);
  const edits = E.editPoints(seq, videoTrackIds.length ? videoTrackIds : undefined).sort((a, b) => a - b);
  const findings: RetentionFinding[] = [];

  /* --- Hook: what happens in the first three seconds --- */
  const first3 = Math.round(fps * 3);
  const hookCuts = edits.filter((e) => e > 0 && e <= first3).length;
  const captionsInHook = seq.captions.some((c) => c.start < first3 && c.end > 0);
  if (hookCuts >= 1) {
    findings.push({ id: 'hook', status: 'ok', title: 'Hook is cut-driven', detail: `${hookCuts} cut${hookCuts === 1 ? '' : 's'} inside the first 3 seconds - the viewer has to keep watching to catch up.` });
  } else {
    findings.push({ id: 'hook', status: 'warn', title: 'No cut in the first 3 seconds', detail: 'Open mid-action or mid-sentence so the brain has to stay to understand context. Razor the opening and cut the intro.' });
  }
  if (!captionsInHook) findings.push({ id: 'hook-captions', status: 'warn', title: 'No captions in the opening hook', detail: 'Muted autoplay viewers read before they listen. Add captions that appear within the first second.', fix: 'smartCaptions' });

  /* --- Pacing: the 2-second reset --- */
  let longestStaticSec = 0;
  let longestAt = 0;
  let prev = 0;
  for (const e of [...edits, D]) {
    const gap = (e - prev) / fps;
    if (gap > longestStaticSec) {
      longestStaticSec = gap;
      longestAt = prev;
    }
    prev = e;
  }
  if (durSec > 0 && longestStaticSec > 2.5) {
    findings.push({ id: 'pacing', status: 'warn', title: `Static stretch of ${longestStaticSec.toFixed(1)}s`, detail: `No visual reset between ${(longestAt / fps).toFixed(1)}s and ${((longestAt + longestStaticSec * fps) / fps).toFixed(1)}s. Change the frame every 1.5-2s with a cut, zoom punch, flash or SFX.`, fix: 'zoomPunches' });
  } else if (durSec > 0) {
    findings.push({ id: 'pacing', status: 'ok', title: 'Pacing is tight', detail: `Longest stretch without a reset is ${longestStaticSec.toFixed(1)}s - inside the 2 second rule.` });
  }

  /* --- Captions: style check --- */
  const style = seq.captionTrack.style;
  const avgWords = seq.captions.length ? seq.captions.reduce((n, c) => n + c.text.split(/\s+/).filter(Boolean).length, 0) / seq.captions.length : 0;
  if (!seq.captions.length) {
    findings.push({ id: 'captions', status: 'info', title: 'No captions yet', detail: 'Transcribe the audio or paste a transcript, then generate bold, animated, centred micro-captions.', fix: 'smartCaptions' });
  } else if (!seq.captionTrack.enabled) {
    findings.push({ id: 'captions', status: 'warn', title: 'Captions are hidden', detail: 'The caption track is disabled - they will not appear in the video or the export.' });
  } else if (avgWords > 3) {
    findings.push({ id: 'captions', status: 'warn', title: 'Captions are too long', detail: `Average ${avgWords.toFixed(1)} words per caption. Keep it to 1-3 words per line so viewers read without thinking.`, fix: 'smartCaptions' });
  } else {
    const animated = style.animation && style.animation !== 'none';
    const centred = Math.abs(style.position - 0.5) < 0.05;
    const bold = style.fontWeight >= 700;
    findings.push({ id: 'captions', status: 'ok', title: 'Captions are retention-ready', detail: `1-3 words per line${bold ? ', bold' : ''}${centred ? ', centred' : ''}${animated ? ', animated' : ''}${style.kicker ? ', kicker word' : ''}.` });
    if (!animated || !centred || !bold) findings.push({ id: 'caption-style', status: 'info', title: 'Caption style can be punchier', detail: 'Bold, animated captions in the exact centre of the frame stop the eye from drifting.', fix: 'retentionCaptionStyle' });
  }

  /* --- Audio momentum --- */
  const audioClips = seq.clips.filter((c) => seq.tracks.find((t) => t.id === c.trackId)?.kind === 'audio');
  const musicBed = audioClips.some((c) => c.audio.gain <= -15);
  if (!audioClips.length) {
    findings.push({ id: 'audio', status: 'info', title: 'No audio bed', detail: 'Layer a high-tempo track at ~5% volume and add SFX on text transitions and punchlines.', fix: 'musicBed' });
  } else if (!musicBed) {
    findings.push({ id: 'audio', status: 'info', title: 'Music bed may be too loud', detail: 'Dopamine audio sits around 5% volume (about -26 dB). Drop the bed so it never competes with the voice.', fix: 'musicBed' });
  } else {
    findings.push({ id: 'audio', status: 'ok', title: 'Audio bed is present', detail: 'A low-level music bed is in place. Sharp SFX on transitions add the casino-floor energy.' });
  }

  /* --- Loop outro --- */
  findings.push({ id: 'loop', status: 'info', title: 'Loop outro', detail: 'Script the last sentence to flow back into the first. Duplicate the opening second onto the end with a crossfade for a seamless restart.', fix: 'loopOutro' });

  /* --- Engagement bait --- */
  findings.push({ id: 'bait', status: 'info', title: 'Engagement bait', detail: 'Plant a split-second rewind trap, and leave one obvious minor mistake for the comments to correct.', fix: 'rewindTrap' });

  return { findings, longestStaticSec, hookCuts };
}
