/*
  Warp Stabilizer: measure camera shake, then cancel it.

  Analysis renders the clip solo at a small scale on a regular time grid (like
  Auto Reframe), converts each frame to a coarse zero-mean luma grid, and finds
  the frame-to-frame translation with a bounded SAD block search plus a
  parabolic sub-cell refinement. Cumulative translation is the camera path; a
  moving average of it is the "smooth camera" we want; the difference between
  the two becomes position keyframes, and a small zoom crop hides the edges
  the corrections would otherwise reveal.

  The pure maths (grid conversion, shift search, path planning) lives in
  exported functions so it can be tested without a GL context.
*/

import type { Clip, Project, Sequence } from '../../types/project';

export interface StabilizeSample {
  /** Clip-local timeline seconds. */
  t: number;
  /** Cumulative measured content translation, normalized to frame width (x right). */
  dx: number;
  /** Cumulative measured content translation, normalized to frame height (y down). */
  dy: number;
}

export interface StabilizeAnalysis {
  samples: StabilizeSample[];
  /** Seconds between analysed frames. */
  sampleStep: number;
  /** Peak absolute path excursion (normalized units) - how shaky the clip is. */
  maxShift: number;
  /** Mean texture level 0..1 - low means flat/featureless footage. */
  texture: number;
}

export interface StabilizePlan {
  /** Correction to APPLY (smoothed - raw), normalized frame units, per sample. */
  corrections: { t: number; dx: number; dy: number }[];
  /** Zoom factor (1.08 = scale to 108%) that hides the corrected edges. */
  zoom: number;
  /** Largest correction actually written, after clamping to the zoom crop. */
  maxCorrection: number;
}

/* ---------- pure helpers ---------- */

/** Downsample RGBA image data to a zero-mean luma grid of gw x gh cells. */
export function toLumaGrid(data: Uint8ClampedArray, w: number, h: number, gw: number, gh: number): { grid: Float32Array; mean: number } {
  const grid = new Float32Array(gw * gh);
  for (let cy = 0; cy < gh; cy++) {
    const sy0 = Math.floor((cy * h) / gh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((cy + 1) * h) / gh));
    for (let cx = 0; cx < gw; cx++) {
      const sx0 = Math.floor((cx * w) / gw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((cx + 1) * w) / gw));
      let sum = 0;
      let n = 0;
      for (let y = sy0; y < sy1; y++) {
        const row = y * w;
        for (let x = sx0; x < sx1; x++) {
          const p = (row + x) * 4;
          sum += (data[p] * 0.2126 + data[p + 1] * 0.7152 + data[p + 2] * 0.0722) / 255;
          n++;
        }
      }
      grid[cy * gw + cx] = n ? sum / n : 0;
    }
  }
  let mean = 0;
  for (let i = 0; i < grid.length; i++) mean += grid[i];
  mean /= Math.max(1, grid.length);
  for (let i = 0; i < grid.length; i++) grid[i] -= mean;
  // mean absolute deviation = texture measure
  let mad = 0;
  for (let i = 0; i < grid.length; i++) mad += Math.abs(grid[i]);
  return { grid, mean: mad / Math.max(1, grid.length) };
}

/**
 * Estimate how the CONTENT moved from prev to cur, in cells (x right, y down),
 * by minimizing zero-mean SAD over a bounded search window. Returns sub-cell
 * refined offsets and a confidence 0..1 (0 = flat footage, shift untrustable).
 */
export function estimateShift(
  prev: Float32Array,
  cur: Float32Array,
  w: number,
  h: number,
  maxSearch: number,
): { dx: number; dy: number; confidence: number } {
  const sadAt = (ox: number, oy: number): { sad: number; n: number } => {
    let sad = 0;
    let n = 0;
    const x0 = Math.max(0, ox);
    const x1 = Math.min(w, w + ox);
    const y0 = Math.max(0, oy);
    const y1 = Math.min(h, h + oy);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const d = cur[y * w + x] - prev[(y - oy) * w + (x - ox)];
        sad += d * d;
        n++;
      }
    }
    return n ? { sad: sad / n, n } : { sad: Infinity, n: 0 };
  };

  // Texture gate: flat frames carry no motion information.
  let tex = 0;
  for (let i = 0; i < cur.length; i++) tex += Math.abs(cur[i]);
  tex /= Math.max(1, cur.length);
  if (tex < 0.004) return { dx: 0, dy: 0, confidence: 0 };

  let best = { ox: 0, oy: 0, sad: Infinity };
  // Stability prior: among near-ties prefer the smallest shift, so ambiguous
  // (repetitive or low-texture) footage never accumulates phantom drift.
  let tie = { ox: 0, oy: 0, sad: Infinity };
  for (let oy = -maxSearch; oy <= maxSearch; oy++) {
    for (let ox = -maxSearch; ox <= maxSearch; ox++) {
      const { sad } = sadAt(ox, oy);
      if (sad < best.sad) best = { ox, oy, sad };
    }
  }
  const tieMax = best.sad * 1.02 + 1e-6;
  for (let oy = -maxSearch; oy <= maxSearch; oy++) {
    for (let ox = -maxSearch; ox <= maxSearch; ox++) {
      const { sad } = sadAt(ox, oy);
      if (sad > tieMax) continue;
      const mag = ox * ox + oy * oy;
      const bestMag = tie.ox * tie.ox + tie.oy * tie.oy;
      if (tie.sad === Infinity || mag < bestMag) tie = { ox, oy, sad };
    }
  }
  best = tie;
  // Parabolic sub-cell refinement on each axis.
  const refine = (m: number, c: number, p: number) => {
    const denom = m - 2 * c + p;
    if (Math.abs(denom) < 1e-9) return 0;
    const d = (0.5 * (m - p)) / denom;
    return Math.max(-1, Math.min(1, d));
  };
  let fx = 0;
  let fy = 0;
  if (best.ox > -maxSearch && best.ox < maxSearch) {
    fx = refine(sadAt(best.ox - 1, best.oy).sad, best.sad, sadAt(best.ox + 1, best.oy).sad);
  }
  if (best.oy > -maxSearch && best.oy < maxSearch) {
    fy = refine(sadAt(best.ox, best.oy - 1).sad, best.sad, sadAt(best.ox, best.oy + 1).sad);
  }
  const zero = sadAt(0, 0).sad;
  // Confidence: how much better the best shift is than no shift, plus texture.
  const gain = zero > 1e-9 ? Math.max(0, (zero - best.sad) / zero) : 0;
  const confidence = Math.min(1, tex * 12) * Math.min(1, 0.35 + gain * 6);
  return { dx: best.ox + fx, dy: best.oy + fy, confidence };
}

/** Moving-average smoothing of a path. window in samples; 'lock' collapses to the mean. */
export function smoothPath(values: number[], window: number, lock: boolean): number[] {
  const n = values.length;
  if (!n) return [];
  if (lock) {
    const m = values.reduce((a, b) => a + b, 0) / n;
    return values.map(() => m);
  }
  const w = Math.max(1, Math.floor(window));
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) {
      sum += values[j];
      cnt++;
    }
    out[i] = sum / cnt;
  }
  return out;
}

/**
 * Turn an analysis into the correction path + crop zoom.
 * smoothSec: temporal window of the smooth camera path (higher = glider but crops more).
 * lock: true removes ALL motion (tripod look).
 * zoomLimit: maximum scale factor the crop may use (1.2 = up to 120%).
 */
export function planStabilization(a: StabilizeAnalysis, opts: { smoothSec?: number; lock?: boolean; zoomLimit?: number }): StabilizePlan {
  const smoothSec = opts.smoothSec ?? 0.5;
  const zoomLimit = Math.max(1, opts.zoomLimit ?? 1.2);
  const rate = a.sampleStep > 0 ? 1 / a.sampleStep : 2;
  const win = Math.max(1, Math.round(smoothSec * rate));
  const rawX = a.samples.map((s) => s.dx);
  const rawY = a.samples.map((s) => s.dy);
  const smX = smoothPath(rawX, win, !!opts.lock);
  const smY = smoothPath(rawY, win, !!opts.lock);
  let corrX = a.samples.map((_, i) => smX[i] - rawX[i]);
  let corrY = a.samples.map((_, i) => smY[i] - rawY[i]);

  let maxCorr = 0;
  for (let i = 0; i < corrX.length; i++) maxCorr = Math.max(maxCorr, Math.abs(corrX[i]), Math.abs(corrY[i]));
  // A zoom of z hides edge gaps up to (z-1)/2 of the frame on each side.
  const wantedZoom = 1 + 2 * maxCorr;
  const zoom = Math.min(wantedZoom, zoomLimit);
  const limit = (zoom - 1) / 2;
  if (maxCorr > limit) {
    const k = limit / Math.max(1e-6, maxCorr);
    corrX = corrX.map((v) => v * k);
    corrY = corrY.map((v) => v * k);
    maxCorr = limit;
  }
  return { corrections: a.samples.map((s, i) => ({ t: s.t, dx: corrX[i], dy: corrY[i] })), zoom, maxCorrection: maxCorr };
}

/* ---------- analysis (needs the compositor) ---------- */

export interface AnalyzeStabilizeOptions {
  /** Frames per second to analyse (capped to the sequence rate). Default 12. */
  sampleFps?: number;
  /** Width of the luma search grid in cells. Default 64. */
  gridWidth?: number;
  /** Hard cap on analysed frames (long clips are sampled sparser). Default 600. */
  maxSamples?: number;
}

/** Measure the camera path of one clip. Returns null when undecodable / too short. */
export async function analyzeStabilization(
  project: Project,
  seq: Sequence,
  clip: Clip,
  opts: AnalyzeStabilizeOptions = {},
  onProgress?: (done: number, total: number) => void,
): Promise<StabilizeAnalysis | null> {
  const { getCompositor } = await import('../playback/playback');
  const comp = getCompositor();
  const fps = seq.settings.fps;
  const durSec = clip.duration / fps;
  if (durSec < 0.4) return null;

  const maxSamples = opts.maxSamples ?? 600;
  let sampleFps = Math.min(opts.sampleFps ?? 12, fps);
  if (durSec * sampleFps > maxSamples) sampleFps = Math.max(1, maxSamples / durSec);
  const sampleStep = 1 / sampleFps;
  const times: number[] = [0];
  for (let t = sampleStep; t < durSec - 1e-3; t += sampleStep) times.push(t);
  if (times.length < 3) return null;

  // Render small: ~240 px wide, like Auto Reframe's analysis pass.
  const renderScale = seq.settings.width > 1500 ? 8 : seq.settings.width > 700 ? 4 : 2;
  const gwTarget = Math.max(24, Math.min(96, opts.gridWidth ?? 64));

  const samples: StabilizeSample[] = [{ t: 0, dx: 0, dy: 0 }];
  let prev: Float32Array | null = null;
  let gw = 0;
  let gh = 0;
  let cumX = 0;
  let cumY = 0;
  let texSum = 0;
  let texN = 0;

  for (let i = 0; i < times.length; i++) {
    const frame = Math.round(clip.start + times[i] * fps);
    const rt = await comp.renderFrame(project, seq, frame, { soloClipId: clip.id, effects: false, captions: false, scale: renderScale });
    let img: ImageData;
    try {
      img = comp.readPixels(rt, [0, 0, 0]);
    } finally {
      comp.release(rt);
    }
    const gwi = Math.max(8, Math.min(gwTarget, img.width));
    const ghi = Math.max(8, Math.round((gwi * img.height) / Math.max(1, img.width)));
    const { grid, mean } = toLumaGrid(img.data, img.width, img.height, gwi, ghi);
    texSum += mean;
    texN++;
    if (prev && gwi === gw && ghi === gh) {
      const maxSearch = Math.max(2, Math.round(gwi * 0.11));
      const shift = estimateShift(prev, grid, gwi, ghi, maxSearch);
      // Cells -> normalized frame units.
      cumX += (shift.dx * shift.confidence) / gwi;
      cumY += (shift.dy * shift.confidence) / ghi;
    }
    prev = grid;
    gw = gwi;
    gh = ghi;
    if (i > 0) samples.push({ t: times[i], dx: cumX, dy: cumY });
    if (onProgress && (i % 4 === 3 || i === times.length - 1)) onProgress(i + 1, times.length);
    // Yield to the UI thread between renders.
    if ((i & 7) === 7) await new Promise((r) => setTimeout(r, 0));
  }

  if (samples.length < 3) return null;
  let maxShift = 0;
  for (const s of samples) maxShift = Math.max(maxShift, Math.abs(s.dx), Math.abs(s.dy));
  return { samples, sampleStep, maxShift, texture: texN ? texSum / texN : 0 };
}
