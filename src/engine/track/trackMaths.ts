/**
 * Pure maths behind the point / planar tracker.
 *
 * Split out from the analysis driver so the UI can import the small helpers it
 * needs to describe a finished track (quality, sampling a position at a time)
 * without pulling the whole frame-by-frame analysis into the main bundle - the
 * driver is loaded on demand when the user actually presses Track, the same way
 * the stabilizer is.
 *
 * Everything here is deterministic and unit-tested in tests/tracker-maths.ts.
 */
import type { Clip, TrackAnalysis } from '../../types/project';
import { sourceTimeAt } from '../timeline/edits';

/* ======================================================================== */
/*  Pure maths (unit-tested in tests/tracker-maths.ts)                       */
/* ======================================================================== */

/** Full-resolution luma plane in 0..1, y down, matching ImageData layout. */
export interface LumaPlane {
  w: number;
  h: number;
  data: Float32Array;
}

export function toLumaPlane(img: ImageData): LumaPlane {
  const { data, width: w, height: h } = img;
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (data[p] * 0.2126 + data[p + 1] * 0.7152 + data[p + 2] * 0.0722) / 255;
  }
  return { w, h, data: out };
}

/**
 * Solve A x = b by Gaussian elimination with partial pivoting.
 * Returns null for a singular or inconsistent system.
 */
export function solveLinear(Ain: number[][], bin: number[]): number[] | null {
  const n = bin.length;
  if (!n || Ain.length !== n || Ain.some((r) => r.length !== n)) return null;
  // Work on copies: elimination destroys the matrix.
  const A = Ain.map((r) => r.slice());
  const b = bin.slice();
  for (let col = 0; col < n; col++) {
    // Partial pivoting: without it, a small diagonal entry divides out huge
    // multipliers and the solution loses all its significant digits.
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    if (piv !== col) {
      const tr = A[piv];
      A[piv] = A[col];
      A[col] = tr;
      const tb = b[piv];
      b[piv] = b[col];
      b[col] = tb;
    }
    const d = A[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
    if (Math.abs(A[r][r]) < 1e-12) return null;
    x[r] = s / A[r][r];
  }
  return x.every((v) => Number.isFinite(v)) ? x : null;
}

/**
 * Least-squares homography mapping src -> dst, in row-major form
 * [h0 h1 h2; h3 h4 h5; h6 h7 h8] with h8 normalised to 1.
 *
 * Needs at least four correspondences; more is better, since the extra equations
 * are what average out per-point tracking noise. Fixing h8 = 1 turns the
 * homogeneous DLT null-space problem into an ordinary 8x8 linear solve. That is
 * only unsafe when the true h8 is zero, which maps finite points to infinity -
 * not something a tracked quad on screen can do.
 */
export function fitHomography(src: [number, number][], dst: [number, number][]): number[] | null {
  const n = Math.min(src.length, dst.length);
  if (n < 4) return null;
  // Normal equations of the 2n x 8 system.
  const ATA: number[][] = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const ATb: number[] = new Array(8).fill(0);
  const row = (a: number[], bi: number) => {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) ATA[i][j] += a[i] * a[j];
      ATb[i] += a[i] * bi;
    }
  };
  for (let k = 0; k < n; k++) {
    const [x, y] = src[k];
    const [X, Y] = dst[k];
    row([x, y, 1, 0, 0, 0, -X * x, -X * y], X);
    row([0, 0, 0, x, y, 1, -Y * x, -Y * y], Y);
  }
  // Tiny Tikhonov term: a degenerate configuration (all points collinear, or
  // several duplicated) leaves ATA singular, and the alternative is returning
  // null and losing an otherwise usable track.
  for (let i = 0; i < 8; i++) ATA[i][i] += 1e-9;
  const h = solveLinear(ATA, ATb);
  if (!h) return null;
  return [...h, 1];
}

/** Apply a row-major homography to a point, with the perspective divide. */
export function applyHomography(h: number[], p: [number, number]): [number, number] {
  const w = h[6] * p[0] + h[7] * p[1] + h[8];
  if (Math.abs(w) < 1e-12) return [p[0], p[1]];
  return [(h[0] * p[0] + h[1] * p[1] + h[2]) / w, (h[3] * p[0] + h[4] * p[1] + h[5]) / w];
}

/** Mean absolute difference of two patches, or Infinity when either leaves the frame. */
export function patchDiff(a: LumaPlane, ax: number, ay: number, b: LumaPlane, bx: number, by: number, r: number): number {
  let s = 0;
  let n = 0;
  for (let dy = -r; dy <= r; dy++) {
    const ary = ay + dy;
    const bry = by + dy;
    if (ary < 0 || ary >= a.h || bry < 0 || bry >= b.h) return Infinity;
    for (let dx = -r; dx <= r; dx++) {
      const arx = ax + dx;
      const brx = bx + dx;
      if (arx < 0 || arx >= a.w || brx < 0 || brx >= b.w) return Infinity;
      s += Math.abs(a.data[ary * a.w + arx] - b.data[bry * b.w + brx]);
      n++;
    }
  }
  return n ? s / n : Infinity;
}

/**
 * Zero-mean normalized cross-correlation of two patches, in -1..1.
 * Used for the confidence score rather than for the search: it is invariant to a
 * brightness or contrast shift between frames, which is what stops an exposure
 * change mid-clip from being read as the feature disappearing.
 */
export function patchZNCC(a: LumaPlane, ax: number, ay: number, b: LumaPlane, bx: number, by: number, r: number): number {
  let sa = 0;
  let sb = 0;
  let n = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = ax + dx;
      const y = ay + dy;
      const x2 = bx + dx;
      const y2 = by + dy;
      if (x < 0 || y < 0 || x >= a.w || y >= a.h || x2 < 0 || y2 < 0 || x2 >= b.w || y2 >= b.h) return 0;
      sa += a.data[y * a.w + x];
      sb += b.data[y2 * b.w + x2];
      n++;
    }
  }
  if (!n) return 0;
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let va = 0;
  let vb = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const da = a.data[(ay + dy) * a.w + (ax + dx)] - ma;
      const db = b.data[(by + dy) * b.w + (bx + dx)] - mb;
      num += da * db;
      va += da * da;
      vb += db * db;
    }
  }
  const den = Math.sqrt(va * vb);
  return den < 1e-9 ? 0 : num / den;
}

export interface MatchResult {
  dx: number;
  dy: number;
  /** Match quality 0..1. */
  score: number;
}

/**
 * Locate the patch centred at (x,y) in `ref` within `cur`.
 *
 * The integer search is plain MAD (cheap, and monotonic enough to find the right
 * cell); the winner is then refined to sub-pixel accuracy with a parabolic fit
 * through its four neighbours. Scoring is ZNCC at the refined position.
 */
export function findPatch(ref: LumaPlane, cur: LumaPlane, x: number, y: number, r: number, search: number, hintX = 0, hintY = 0): MatchResult {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi - r < 0 || yi - r < 0 || xi + r >= ref.w || yi + r >= ref.h) {
    return { dx: 0, dy: 0, score: 0 };
  }
  let best = Infinity;
  let bx = xi + hintX;
  let by = yi + hintY;
  const cx = xi + hintX;
  const cy = yi + hintY;
  for (let oy = -search; oy <= search; oy++) {
    for (let ox = -search; ox <= search; ox++) {
      const s = patchDiff(ref, xi, yi, cur, cx + ox, cy + oy, r);
      if (s < best) {
        best = s;
        bx = cx + ox;
        by = cy + oy;
      }
    }
  }
  if (!Number.isFinite(best)) return { dx: hintX, dy: hintY, score: 0 };
  // Sub-pixel refinement.
  let rx = 0;
  let ry = 0;
  if (best > 1e-7) {
    const xm = patchDiff(ref, xi, yi, cur, bx - 1, by, r);
    const xp = patchDiff(ref, xi, yi, cur, bx + 1, by, r);
    const ym = patchDiff(ref, xi, yi, cur, bx, by - 1, r);
    const yp = patchDiff(ref, xi, yi, cur, bx, by + 1, r);
    const d2x = xm + xp - 2 * best;
    const d2y = ym + yp - 2 * best;
    if (Number.isFinite(d2x) && d2x > 1e-9) rx = clampHalf((xm - xp) / (2 * d2x));
    if (Number.isFinite(d2y) && d2y > 1e-9) ry = clampHalf((ym - yp) / (2 * d2y));
  }
  const fx = bx + rx;
  const fy = by + ry;
  const score = patchZNCC(ref, xi, yi, cur, Math.round(fx), Math.round(fy), r);
  return { dx: fx - x, dy: fy - y, score: Math.max(0, Math.min(1, score)) };
}

function clampHalf(v: number): number {
  return v < -0.5 ? -0.5 : v > 0.5 ? 0.5 : v;
}

/** Edge midpoints of a quad, used as the extra constraints of a planar track. */
export function quadMidpoints(q: [number, number][]): [number, number][] {
  if (q.length < 4) return [];
  const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return [mid(q[0], q[1]), mid(q[1], q[2]), mid(q[2], q[3]), mid(q[3], q[0])];
}

/**
 * Interpolate a track at an arbitrary source second.
 * Analysed frames are sparse, so positions between them are lerped; outside the
 * analysed range the end positions are held rather than extrapolated, because an
 * extrapolated track flies off screen with no way to know where it went.
 */
export function sampleTrack(ta: TrackAnalysis, sec: number): [number, number][] {
  const { frames, positions, startSec, endSec } = ta;
  const n = frames.length;
  const pts = positions[0]?.length ?? ta.seed.length;
  if (!n) return ta.seed.slice(0, pts) as [number, number][];
  if (n === 1) return positions[0];
  const span = Math.max(1e-6, endSec - startSec);
  const f = (sec - startSec) / span;
  const t = Math.max(0, Math.min(n - 1, f * (n - 1)));
  const i0 = Math.floor(t);
  const i1 = Math.min(n - 1, i0 + 1);
  const k = t - i0;
  const a = positions[i0];
  const b = positions[i1];
  const out: [number, number][] = [];
  for (let p = 0; p < pts; p++) {
    const pa = a[p] ?? ta.seed[p] ?? [0, 0];
    const pb = b[p] ?? ta.seed[p] ?? [0, 0];
    out.push([pa[0] + (pb[0] - pa[0]) * k, pa[1] + (pb[1] - pa[1]) * k]);
  }
  return out;
}

/** Source second a timeline frame corresponds to, for reading a track back. */
export function trackTimeForFrame(clip: Clip, frame: number, fps: number): number {
  return sourceTimeAt(clip, frame, fps);
}

/** Mean confidence of a finished track - what the UI reports as track quality. */
export function trackQuality(ta: TrackAnalysis): number {
  if (!ta.confidence.length) return 0;
  return ta.confidence.reduce((a, b) => a + b, 0) / ta.confidence.length;
}

/** Fraction of analysed frames that matched well enough to trust. */
export function trackReliability(ta: TrackAnalysis): number {
  if (!ta.confidence.length) return 0;
  return ta.confidence.filter((c) => c >= 0.5).length / ta.confidence.length;
}
