/*
  Beat / onset detection for music clips.

  Energy-based onset detection: the signal is chopped into short windows,
  per-band energies are compared against a moving local average, and peaks
  that stand out far enough (sensitivity) and far enough apart (min spacing)
  become beats. Good enough to cut a montage to; not a substitute for a
  beatgrid in a DJ app.
*/

export interface BeatOptions {
  /** 0 (only huge hits) .. 1 (every nuance). Default 0.5 */
  sensitivity: number;
  /** Minimum spacing between beats in seconds. Default derived from bpmMin. */
  minSpacing: number;
}

export interface BeatResult {
  /** Beat times in seconds, ascending, relative to the source start. */
  beats: number[];
  /** Median inter-beat interval, seconds (null when fewer than 4 beats). */
  beatInterval: number | null;
  /** Estimated BPM from the median interval. */
  bpm: number | null;
}

export function detectBeats(buffer: AudioBuffer, opts: Partial<BeatOptions> = {}): BeatResult {
  const sensitivity = Math.max(0, Math.min(1, opts.sensitivity ?? 0.5));
  const minSpacing = Math.max(0.08, opts.minSpacing ?? 60 / 200);

  const sr = buffer.sampleRate;
  const chCount = Math.min(2, buffer.numberOfChannels);
  const n = buffer.length;
  // Mono mixdown into one Float32Array.
  const mono = new Float32Array(n);
  for (let c = 0; c < chCount; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / chCount;
  }

  // Window/hop: 1024/512 gives ~46 fps of energy frames at 48 kHz.
  const win = 1024;
  const hop = 512;
  const frames = Math.max(1, Math.floor((n - win) / hop) + 1);

  // Two coarse bands (low: kick, high: snare/hats) so both kinds of onsets count.
  const energyLow = new Float32Array(frames);
  const energyHigh = new Float32Array(frames);
  // Simple one-pole filters applied per sample while accumulating.
  let lp = 0;
  for (let f = 0; f < frames; f++) {
    const s0 = f * hop;
    let lo = 0,
      hi = 0;
    for (let i = 0; i < win; i++) {
      const x = mono[s0 + i] ?? 0;
      lp += 0.12 * (x - lp); // ~ cut around 900 Hz at 48k - "low" band
      lo += lp * lp;
      const hp = x - lp;
      hi += hp * hp;
    }
    energyLow[f] = Math.sqrt(lo / win);
    energyHigh[f] = Math.sqrt(hi / win);
  }

  // Novelty: positive energy delta per band.
  const novelty = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    novelty[f] = Math.max(0, energyLow[f] - energyLow[f - 1]) * 1.6 + Math.max(0, energyHigh[f] - energyHigh[f - 1]);
  }

  // Adaptive threshold: moving average of ±16 frames (~0.35 s) scaled by
  // sensitivity. Louder-than-local-average spikes pass.
  const half = 16;
  const prefix = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) prefix[f + 1] = prefix[f] + novelty[f];
  const factor = 1.35 + (1 - sensitivity) * 1.8; // high sensitivity -> lower bar
  const minGapFrames = Math.round(minSpacing * sr / hop);

  const beats: number[] = [];
  let lastBeatFrame = -Infinity;
  for (let f = 1; f < frames; f++) {
    const a = Math.max(0, f - half);
    const b = Math.min(frames, f + half + 1);
    const localAvg = (prefix[b] - prefix[a]) / (b - a);
    if (novelty[f] > localAvg * factor + 1e-4 && f - lastBeatFrame >= minGapFrames) {
      // Local maximum refinement: prefer the strongest frame in the neighbourhood.
      let best = f;
      for (let g = Math.max(1, f - 2); g <= Math.min(frames - 1, f + 2); g++) {
        if (novelty[g] > novelty[best]) best = g;
      }
      const t = (best * hop + win / 2) / sr;
      if (beats.length && t - beats[beats.length - 1] < minSpacing) {
        // keep the stronger of the two
        continue;
      }
      beats.push(t);
      lastBeatFrame = best;
    }
  }

  // Median interval -> BPM
  let bpm: number | null = null;
  let med: number | null = null;
  if (beats.length >= 4) {
    const ivs: number[] = [];
    for (let i = 1; i < beats.length; i++) {
      const d = beats[i] - beats[i - 1];
      if (d > 0.2 && d < 2.0) ivs.push(d);
    }
    if (ivs.length >= 3) {
      ivs.sort((x, y) => x - y);
      med = ivs[Math.floor(ivs.length / 2)];
      let est = 60 / med;
      // fold into a sane tempo range
      while (est < 70) est *= 2;
      while (est > 180) est /= 2;
      bpm = Math.round(est);
    }
  }
  return { beats, beatInterval: med, bpm };
}
