/*
  Sync by Audio: align two recordings of the same event (double-system sound,
  multicam angles) by cross-correlating their loudness envelopes.

  Both sources are reduced to a 10 ms RMS energy envelope, mean-centered and
  normalized, then correlated over a bounded lag range in two passes: a coarse
  80 ms envelope to find the neighborhood, then a fine 10 ms pass around it.
  The winning lag is the offset between the two SOURCE timelines; confidence is
  the normalized correlation peak (0..1).

  Offset semantics: offsetSec = L means an event at time t in `other`
  corresponds to time t + L in `ref` (L > 0: other's recording started
  earlier / its content comes sooner).
*/

export interface SyncMatch {
  /** Seconds; see module docs for sign convention. */
  offsetSec: number;
  /** Normalized correlation at the best lag, 0..1. */
  confidence: number;
}

const WIN = 0.01; // 10 ms envelope windows

/** Per-window RMS energy envelope of the mono mixdown. */
export function energyEnvelope(buffer: AudioBuffer, winSec = WIN): Float32Array {
  const sr = buffer.sampleRate;
  const chCount = Math.min(2, buffer.numberOfChannels);
  const winSamples = Math.max(32, Math.round(winSec * sr));
  const n = buffer.length;
  const windows = Math.max(1, Math.floor(n / winSamples));
  const env = new Float32Array(windows);
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
    env[w] = Math.sqrt(sum / Math.max(1, s1 - s0));
  }
  return env;
}

/** Pool an envelope by averaging blocks of `factor` windows. */
function pool(env: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return env;
  const out = new Float32Array(Math.ceil(env.length / factor));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = i * factor; j < Math.min(env.length, (i + 1) * factor); j++) {
      sum += env[j];
      n++;
    }
    out[i] = n ? sum / n : 0;
  }
  return out;
}

function center(env: Float32Array): { data: Float32Array; energy: number } {
  let mean = 0;
  for (let i = 0; i < env.length; i++) mean += env[i];
  mean /= Math.max(1, env.length);
  const data = new Float32Array(env.length);
  let energy = 0;
  for (let i = 0; i < env.length; i++) {
    data[i] = env[i] - mean;
    energy += data[i] * data[i];
  }
  return { data, energy: Math.sqrt(energy) };
}

/**
 * Normalized correlation of `other` against `ref` shifted by `lag` bins:
 * score = sum(other[i] * ref[i + lag]) over the overlap, divided by the local
 * norms so quiet stretches do not dominate.
 */
function scoreAt(ref: Float32Array, other: Float32Array, lag: number): number {
  const i0 = Math.max(0, -lag);
  const i1 = Math.min(other.length, ref.length - lag);
  if (i1 - i0 < 8) return -2;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = i0; i < i1; i++) {
    const a = other[i];
    const b = ref[i + lag];
    dot += a * b;
    na += a * a;
    nb += b * b;
  }
  const denom = Math.sqrt(na * nb);
  return denom < 1e-9 ? -2 : dot / denom;
}

/**
 * Find the offset between two decoded audio sources.
 * maxLagSec bounds the search (default 30 s each direction).
 */
export function findSyncOffset(ref: AudioBuffer, other: AudioBuffer, opts: { maxLagSec?: number } = {}): SyncMatch {
  const maxLagSec = Math.max(1, opts.maxLagSec ?? 30);
  const refFine = center(energyEnvelope(ref)).data;
  const othFine = center(energyEnvelope(other)).data;
  if (refFine.length < 16 || othFine.length < 16) return { offsetSec: 0, confidence: 0 };

  // Coarse pass at 80 ms resolution.
  const POOL = 8;
  const refCoarse = pool(refFine, POOL);
  const othCoarse = pool(othFine, POOL);
  const maxCoarse = Math.floor(maxLagSec / (WIN * POOL));
  let bestCoarse = 0;
  let bestCoarseScore = -2;
  for (let l = -maxCoarse; l <= maxCoarse; l++) {
    const s = scoreAt(refCoarse, othCoarse, l);
    if (s > bestCoarseScore) {
      bestCoarseScore = s;
      bestCoarse = l;
    }
  }

  // Fine pass at 10 ms within +/- 2 coarse bins of the winner.
  const center0 = bestCoarse * POOL;
  const radius = POOL * 2;
  let bestLag = center0;
  let bestScore = -2;
  for (let l = center0 - radius; l <= center0 + radius; l++) {
    const s = scoreAt(refFine, othFine, l);
    if (s > bestScore) {
      bestScore = s;
      bestLag = l;
    }
  }
  return { offsetSec: bestLag * WIN, confidence: Math.max(0, Math.min(1, bestScore)) };
}
