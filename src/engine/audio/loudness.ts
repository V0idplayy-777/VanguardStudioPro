/*
  Integrated loudness (EBU R128-ish) on an AudioBuffer, plus true-peak.

  Implements the R128 K-weighting (stage 1 high shelf, stage 2 high pass) as
  two biquads re-derived for the buffer's sample rate, then 400 ms gating
  blocks with 75% overlap: blocks below -70 LUFS are dropped, then blocks
  below (gated mean - 10) are dropped. Good to a few tenths of a LU against
  a full R128 meter — plenty for normalising clips.

  Used by "Normalize Audio": measure a clip's audible span, write the clip
  gain needed to hit the target LUFS.
*/

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function highShelf(fs: number, f0: number, gainDb: number, q: number): Biquad {
  // RBJ cookbook high-shelf
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 - (A - 1) * cw + twoSqrtAAlpha;
  return {
    b0: (A * (A + 1 + (A - 1) * cw + twoSqrtAAlpha)) / a0,
    b1: (-2 * A * (A - 1 + (A + 1) * cw)) / a0,
    b2: (A * (A + 1 + (A - 1) * cw - twoSqrtAAlpha)) / a0,
    a1: (2 * (A - 1 - (A + 1) * cw)) / a0,
    a2: (A + 1 - (A - 1) * cw - twoSqrtAAlpha) / a0,
  };
}

function highPass(fs: number, f0: number, q: number): Biquad {
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cw) / 2) / a0,
    b1: (-(1 + cw)) / a0,
    b2: ((1 + cw) / 2) / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

function runBiquad(x: Float32Array, f: Biquad): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = f.b0 * xi + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    y[i] = yi;
  }
  return y;
}

export interface LoudnessResult {
  /** Integrated loudness, LUFS. Null when the material is (near) silent. */
  lufs: number | null;
  /** Highest |sample| across channels after K-weighting, dBFS. */
  peakDb: number;
}

/** Integrated LUFS of a span (seconds) of the buffer. */
export function integratedLufs(buffer: AudioBuffer, startSec = 0, endSec = buffer.duration): LoudnessResult {
  const sr = buffer.sampleRate;
  const s0 = Math.max(0, Math.floor(startSec * sr));
  const s1 = Math.min(buffer.length, Math.ceil(endSec * sr));
  if (s1 - s0 < sr * 0.4) return { lufs: null, peakDb: -70 };

  // R128 stage 1 (high shelf, +4 dB @ ~1681 Hz) and stage 2 (high pass @ ~38 Hz).
  const shelf = highShelf(sr, 1681.97, 3.999, 0.7071);
  const hp = highPass(sr, 38.13, 0.5);

  const chCount = Math.min(2, buffer.numberOfChannels);
  const blockLen = Math.round(0.4 * sr);
  const step = Math.round(0.1 * sr);
  const starts: number[] = [];
  for (let s = s0; s + blockLen <= s1; s += step) starts.push(s);
  if (!starts.length) starts.push(s0);

  const powers: number[] = [];
  let peak = 0;
  const tmp = new Float32Array(blockLen);
  for (const st of starts) {
    let blockPower = 0;
    for (let c = 0; c < chCount; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < blockLen; i++) tmp[i] = data[st + i] ?? 0;
      const k = runBiquad(runBiquad(tmp, shelf), hp);
      let p = 0;
      for (let i = 0; i < blockLen; i++) {
        p += k[i] * k[i];
        const a = Math.abs(k[i]);
        if (a > peak) peak = a;
      }
      blockPower += p / blockLen;
    }
    powers.push(blockPower / chCount); // mean square per block (per channel avg)
  }

  // Gating: -70 LUFS absolute, then relative -10 below the gated mean.
  const toL = (p: number) => -0.691 + 10 * Math.log10(Math.max(1e-12, p));
  let pool = powers.filter((p) => toL(p) > -70);
  if (!pool.length) return { lufs: null, peakDb: 20 * Math.log10(Math.max(1e-7, peak)) };
  const mean1 = pool.reduce((a, b) => a + b, 0) / pool.length;
  const rel = toL(mean1) - 10;
  pool = pool.filter((p) => toL(p) > rel);
  const mean2 = pool.length ? pool.reduce((a, b) => a + b, 0) / pool.length : mean1;
  return { lufs: toL(mean2), peakDb: 20 * Math.log10(Math.max(1e-7, peak)) };
}
