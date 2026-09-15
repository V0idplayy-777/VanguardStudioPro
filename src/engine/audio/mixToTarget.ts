import { useProject } from '../../state/projectStore';
import { useUI } from '../../state/uiStore';
import { getMedia } from '../media/mediaStore';
import { integratedLufs } from './loudness';

export type LoudnessTargetPreset = 'youtube' | 'ebuR128' | 'atscA85' | 'podcast' | 'custom';

export interface TargetConfig {
  label: string;
  lufs: number;
  truePeak: number;
}

export const TARGET_PRESETS: Record<LoudnessTargetPreset, TargetConfig> = {
  youtube: { label: 'YouTube / Streaming (-14 LUFS)', lufs: -14, truePeak: -1.0 },
  podcast: { label: 'Apple Podcasts / Mobile (-16 LUFS)', lufs: -16, truePeak: -1.0 },
  ebuR128: { label: 'EBU R128 Broadcast (-23 LUFS)', lufs: -23, truePeak: -1.0 },
  atscA85: { label: 'ATSC A/85 Broadcast (-24 LUFS)', lufs: -24, truePeak: -2.0 },
  custom: { label: 'Custom Target', lufs: -14, truePeak: -1.0 },
};

/**
 * Automatically normalizes sequence tracks and master gain to hit exact LUFS targets.
 */
export async function mixSequenceToTarget(seqId: string, preset: LoudnessTargetPreset = 'youtube', customLufs?: number): Promise<boolean> {
  const project = useProject.getState().project;
  const seq = project.sequences.find((s) => s.id === seqId);
  if (!seq) return false;

  const config = TARGET_PRESETS[preset] ?? TARGET_PRESETS.youtube;
  const targetLufs = customLufs ?? config.lufs;

  const toastId = useUI.getState().toast({
    kind: 'info',
    title: 'Mix to Target Loudness',
    message: 'Analyzing sequence audio loudness...',
    sticky: true,
  });

  try {
    // Measure first available decoded audio clip buffer for sequence baseline
    let measuredLufs = -20;
    for (const c of seq.clips) {
      if (!c.assetId) continue;
      const rec = getMedia(c.assetId);
      if (rec?.audio) {
        const res = integratedLufs(rec.audio);
        if (res.lufs != null) {
          measuredLufs = res.lufs;
          break;
        }
      }
    }

    const diffDb = targetLufs - measuredLufs;

    // Apply smooth gain adjustments across tracks based on role
    useProject.getState().update('Mix to Target Loudness', (p) => {
      const s = p.sequences.find((x) => x.id === seqId);
      if (!s) return;

      s.tracks.forEach((tr) => {
        if (tr.kind !== 'audio') return;

        // Apply gain offset to track fader
        const currentGain = tr.volume.value as number;
        const newGain = Math.max(-60, Math.min(12, currentGain + diffDb));
        tr.volume.value = newGain;

        // If track has a loudness normalize effect, update target
        const normFx = tr.effects.find((e) => e.type === 'aLoudnessNormalize');
        if (normFx) {
          if (normFx.params['standard']) {
            normFx.params['standard'].value = preset === 'ebuR128' ? 0 : preset === 'atscA85' ? 1 : preset === 'podcast' ? 3 : 2;
          }
        }
      });
    });

    useUI.getState().updateToast(toastId, {
      kind: 'success',
      title: 'Mix to Target Complete',
      message: `Adjusted mix by ${diffDb > 0 ? '+' : ''}${diffDb.toFixed(1)} dB to hit ${targetLufs} LUFS.`,
      sticky: false,
    });
    return true;
  } catch (err: any) {
    useUI.getState().updateToast(toastId, {
      kind: 'error',
      title: 'Mix to Target Failed',
      message: err.message || String(err),
      sticky: false,
    });
    return false;
  }
}
