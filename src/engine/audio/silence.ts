/*
  Silence detection for the Remove Silence editor.

  Windows the mono mixdown at ~20 ms, converts each window to dBFS RMS, then
  finds runs of quiet windows. The threshold adapts to the material: it sits a
  fixed margin above the noise floor (the 15th percentile window), so a noisy
  phone recording and a clean studio track both work without retuning.

  Returned intervals are in SOURCE seconds, padded by `padding` on both sides
  so speech onsets keep their attack.
*/

export interface SilenceOptions {
  /** Margin above the noise floor in dB. Higher = only true silence counts. Default 10. */
  sensitivity: number;
  /** Minimum silent run to report, seconds. Default 0.45. */
  minSilence: number;
  /** Keep this much silence around speech, seconds. Default 0.15. */
  padding: number;
}

export interface SilenceResult {
  /** Silent intervals [start, end) in seconds, ascending, non-overlapping. */
  silences: Array<[number, number]>;
  /** Fraction of the analysed span that is speech. */
  speechRatio: number;
  /** Adaptive threshold that was used, dBFS. */
  thresholdDb: number;
}

const WIN = 0.02; // 20 ms analysis windows

export function detectSilence(buffer: AudioBuffer, opts: Partial<SilenceOptions> = {}): SilenceResult {
  const sensitivity = Math.max(3, Math.min(30, opts.sensitivity ?? 10));
  const minSilence = Math.max(0.15, opts.minSilence ?? 0.45);
  const padding = Math.max(0, Math.min(0.5, opts.padding ?? 0.15));

  const sr = buffer.sampleRate;
  const chCount = Math.min(2, buffer.numberOfChannels);
  const winSamples = Math.max(64, Math.round(WIN * sr));
  const n = buffer.length;
  const windows = Math.max(1, Math.floor(n / winSamples));

  // Per-window dBFS on the mono mixdown.
  const dbs = new Float32Array(windows);
  const chans: Float32Array[] = [];
  for (let c = 0; c < chCount; c++) chans.push(buffer.getChannelData(c));
  for (let w = 0; w < windows; w++) {
    const s0 = w * winSamples;
    const s1 = Math.min(n, s0 + winSamples);
    let sum = 0;
    for (let i = s0; i < s1; i++) {
      let v = 0;
      for (let c = 0; c < chCount; c++) v += chans[c][i];
      v /= chCount;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / Math.max(1, s1 - s0));
    dbs[w] = 20 * Math.log10(Math.max(1e-7, rms));
  }

  // Noise floor: 15th percentile window level.
  const sorted = Float32Array.from(dbs).sort();
  const floor = sorted[Math.floor(sorted.length * 0.15)] ?? -70;
  const thresholdDb = Math.max(-65, floor + sensitivity);

  // Runs of windows under the threshold -> seconds.
  const silences: Array<[number, number]> = [];
  let runStart = -1;
  for (let w = 0; w <= windows; w++) {
    const quiet = w < windows && dbs[w] < thresholdDb;
    if (quiet && runStart < 0) runStart = w;
    if (!quiet && runStart >= 0) {
      const s = (runStart * winSamples) / sr;
      const e = (w * winSamples) / sr;
      if (e - s >= minSilence) silences.push([s, e]);
      runStart = -1;
    }
  }

  // Pad: KEEP this much silence around speech, i.e. shrink the deleted span.
  const padded: Array<[number, number]> = [];
  for (const [s, e] of silences) {
    const ps = s + padding;
    const pe = Math.min(buffer.duration, e - padding);
    if (pe <= ps) continue; // fully padded away - keep it
    const last = padded[padded.length - 1];
    if (last && ps <= last[1]) last[1] = Math.max(last[1], pe);
    else padded.push([ps, pe]);
  }
  // Drop padded runs that got shorter than the minimum again.
  const out = padded.filter(([s, e]) => e - s >= Math.min(minSilence, 0.12));

  const silentSec = out.reduce((a, [s, e]) => a + (e - s), 0);
  return { silences: out, speechRatio: 1 - silentSec / Math.max(0.001, buffer.duration), thresholdDb };
}

/** Total seconds covered by intervals. */
export function totalDuration(intervals: Array<[number, number]>) {
  return intervals.reduce((a, [s, e]) => a + Math.max(0, e - s), 0);
}
