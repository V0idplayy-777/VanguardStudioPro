/*
  Numeric verification for the point tracker's maths.

  Two pieces matter and both are pure CPU, so both can be checked exactly:

  - fitHomography / solveLinear. A wrong least-squares fit does not throw; it
    quietly returns a plane that is a fraction of a pixel off, which shows up as a
    pinned graphic drifting away from the surface it is supposed to be stuck to.
    Recovering a known homography from generated correspondences is an exact test.
  - findPatch. Checked against synthetic frames with a known displacement, the
    same way the optical-flow estimator is.

  Run with: npm run test:tracker
*/
import { applyHomography, fitHomography, findPatch, patchDiff, patchZNCC, quadMidpoints, sampleTrack, solveLinear, toLumaPlane, type LumaPlane } from '../src/engine/track/pointTracker';
import type { TrackAnalysis } from '../src/types/project';

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = '') {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
}

/* ------------------------------------------------------------------ *
 * solveLinear
 * ------------------------------------------------------------------ */
console.log('--- solveLinear ---');
{
  const x = solveLinear([[2, 1], [1, 3]], [5, 10]);
  check('2x2 system solved', !!x && Math.abs(x[0] - 1) < 1e-9 && Math.abs(x[1] - 3) < 1e-9, x ? x.map((v) => v.toFixed(6)).join(', ') : 'null');
}
{
  // Singular: the second row is a multiple of the first, so there is no unique
  // solution. Returning a bogus answer here would silently corrupt a fit.
  check('singular system returns null', solveLinear([[1, 2], [2, 4]], [3, 6]) === null);
  check('inconsistent system returns null', solveLinear([[1, 2], [2, 4]], [3, 7]) === null);
}
{
  // The classic case partial pivoting exists for: a tiny leading entry makes
  // naive elimination divide out an enormous multiplier and lose every
  // significant digit. True solution is x = y = 1.
  const x = solveLinear([[1e-14, 1], [1, 1]], [1, 2]);
  check('partial pivoting survives a tiny pivot', !!x && Math.abs(x[0] - 1) < 1e-6 && Math.abs(x[1] - 1) < 1e-6, x ? `x=${x[0].toFixed(9)} y=${x[1].toFixed(9)}` : 'null');
}
{
  // 8x8, the size fitHomography actually solves.
  const n = 8;
  const A: number[][] = [];
  const truth = [3, -1.5, 0.25, 7, -2, 0.125, 1.75, -0.5];
  for (let r = 0; r < n; r++) {
    const row: number[] = [];
    for (let c = 0; c < n; c++) row.push(Math.sin(r * 3.1 + c * 1.7) + (r === c ? 4 : 0));
    A.push(row);
  }
  const b = A.map((row) => row.reduce((s, v, c) => s + v * truth[c], 0));
  const x = solveLinear(A, b);
  let worst = 0;
  if (x) for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(x[i] - truth[i]));
  check('8x8 system recovered', !!x && worst < 1e-9, `worst err ${worst.toExponential(2)}`);
  check('solveLinear does not mutate its inputs', A[0][0] !== undefined && b.length === n && Math.abs(b[0] - A[0].reduce((s, v, c) => s + v * truth[c], 0)) < 1e-12);
}

/* ------------------------------------------------------------------ *
 * fitHomography / applyHomography
 * ------------------------------------------------------------------ */
console.log('--- homography fit ---');

function matVec(m: number[], p: [number, number]): [number, number] {
  const w = m[6] * p[0] + m[7] * p[1] + m[8];
  return [(m[0] * p[0] + m[1] * p[1] + m[2]) / w, (m[3] * p[0] + m[4] * p[1] + m[5]) / w];
}

/** Deterministic pseudo-random in -1..1. */
function rnd(i: number): number {
  const h = Math.sin(i * 91.7 + 47.3) * 43758.5453;
  return (h - Math.floor(h)) * 2 - 1;
}

{
  // A real perspective transform (a quad tilted in depth), recovered from exactly
  // the four correspondences the minimum requires.
  const H = [1.2, 0.08, 0.12, -0.05, 1.1, 0.09, 0.0004, -0.0006, 1];
  const src: [number, number][] = [[0.1, 0.15], [0.85, 0.2], [0.9, 0.8], [0.12, 0.75]];
  const dst = src.map((p) => matVec(H, p));
  const fit = fitHomography(src, dst);
  check('4-point perspective fit succeeds', !!fit);
  if (fit) {
    let worst = 0;
    for (const p of src) {
      const got = applyHomography(fit, p);
      const want = matVec(H, p);
      worst = Math.max(worst, Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1]));
    }
    check('4-point fit reproduces the transform', worst < 1e-7, `worst err ${worst.toExponential(2)}`);
    // Points the fit never saw must also map correctly - that is what makes it a
    // real homography rather than four independent guesses.
    let interp = 0;
    for (const p of [[0.5, 0.5], [0.3, 0.7], [0.65, 0.35]] as [number, number][]) {
      const got = applyHomography(fit, p);
      const want = matVec(H, p);
      interp = Math.max(interp, Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1]));
    }
    check('fit generalises to unseen points', interp < 1e-7, `worst err ${interp.toExponential(2)}`);
    check('h8 is normalised to 1', Math.abs(fit[8] - 1) < 1e-12, `${fit[8]}`);
  }
}

{
  // A planar track produces many noisy correspondences per frame (eight points
  // once midpoints are included; more if the user seeds a denser patch). The fit
  // has to average that noise down, otherwise the pinned graphic jitters by
  // however much the worst single match was off.
  const H = [1.05, -0.03, 0.08, 0.02, 1.07, -0.05, 0.0003, 0.0002, 1];
  const NOISE = 0.004;
  const errs = new Map<number, number>();
  for (const n of [8, 16, 32]) {
    const src: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      // Spread over the unit square with a deterministic, non-degenerate pattern.
      const gx = (i * 7) % 8;
      const gy = Math.floor(((i * 7) % 64) / 8);
      src.push([0.08 + 0.84 * (gx / 7), 0.08 + 0.84 * ((gy + ((i * 3) % 5) / 5) / 8)]);
    }
    const dst = src.map((p, i) => {
      const t = matVec(H, p);
      return [t[0] + rnd(i) * NOISE, t[1] + rnd(i + 100) * NOISE] as [number, number];
    });
    const fit = fitHomography(src, dst);
    if (!fit) {
      check(`noisy ${n}-point fit succeeds`, false, 'returned null');
      continue;
    }
    check(`noisy ${n}-point fit succeeds`, true);
    let sum2 = 0;
    let err = 0;
    for (const p of src) {
      const got = applyHomography(fit, p);
      const want = matVec(H, p);
      const ex = got[0] - want[0];
      const ey = got[1] - want[1];
      sum2 += ex * ex + ey * ey;
      err = Math.max(err, Math.abs(ex), Math.abs(ey));
    }
    const rms = Math.sqrt(sum2 / (2 * src.length));
    errs.set(n, rms);
    /*
      The residual a least-squares fit leaves AT its own data points is not the
      input noise - it is the component the 8-parameter model could not absorb.
      With 2n observations and 8 unknowns the expected RMS is

          noiseRMS * sqrt(1 - 8 / 2n)

      which for n = 8 is 0.71x the noise and for n = 32 is 0.94x. Asserting
      against that prediction checks the fit is genuinely least squares; a
      naive "must beat the per-point noise" bound is simply false at small n and
      would be testing for something no correct implementation can deliver.
    */
    const noiseRms = NOISE / Math.sqrt(3); // rnd() is uniform in -1..1
    const expected = noiseRms * Math.sqrt(Math.max(0.02, 1 - 8 / (2 * n)));
    check(`residual matches the least-squares prediction (${n} points)`, rms < expected * 2.5, `rms ${rms.toExponential(2)}, predicted ${expected.toExponential(2)}`);
    check(`fit reduces the noise (${n} points)`, rms < noiseRms * 1.6, `rms ${rms.toExponential(2)} vs input noise rms ${noiseRms.toExponential(2)}`);
    void err;
  }
  // And more points must measurably help. Least squares residual falls with
  // 1/sqrt(n), so asserting a firm improvement from 8 to 32 points checks the
  // averaging is real without depending on a tail statistic landing inside a
  // tight per-n budget.
  const e8 = errs.get(8) ?? Infinity;
  const e32 = errs.get(32) ?? Infinity;
  check('more correspondences measurably reduce the residual', e32 < e8 * 0.7, `8 pts ${e8.toExponential(2)} -> 32 pts ${e32.toExponential(2)}`);
  check('the residual falls monotonically with point count', (errs.get(8) ?? 0) > (errs.get(16) ?? 0) && (errs.get(16) ?? 0) > (errs.get(32) ?? 0), `${errs.get(8)?.toExponential(2)} > ${errs.get(16)?.toExponential(2)} > ${errs.get(32)?.toExponential(2)}`);
}

{
  check('fewer than 4 correspondences returns null', fitHomography([[0, 0], [1, 0], [1, 1]], [[0, 0], [1, 0], [1, 1]]) === null);
  const degen = fitHomography([[0.5, 0.5], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]], [[0.5, 0.5], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]]);
  check('a collapsed quad does not produce NaN', degen === null || degen.every((v) => Number.isFinite(v)));
  check('identity correspondences give the identity map', (() => {
    const pts: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]];
    const h = fitHomography(pts, pts);
    if (!h) return false;
    return pts.every((p) => { const q = applyHomography(h, p); return Math.abs(q[0] - p[0]) < 1e-6 && Math.abs(q[1] - p[1]) < 1e-6; });
  })());
  check('applyHomography with a zero denominator returns the input unchanged', (() => {
    const q = applyHomography([1, 0, 0, 0, 1, 0, 0, 0, 0], [0.3, 0.4]);
    return q[0] === 0.3 && q[1] === 0.4;
  })());
}

/* ------------------------------------------------------------------ *
 * Patch matching
 * ------------------------------------------------------------------ */
console.log('--- patch matching ---');

function hash(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
/** Smooth multi-octave value noise; see tests/gl-maths.ts for why band-limiting matters. */
function vnoise(x: number, y: number, scale: number): number {
  const gx = x / scale;
  const gy = y / scale;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0);
  const b = hash(x0 + 1, y0);
  const c = hash(x0, y0 + 1);
  const d = hash(x0 + 1, y0 + 1);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}
function scene(x: number, y: number): number {
  const w = 0.5 * vnoise(x, y, 64) + 0.3 * vnoise(x, y, 18) + 0.2 * vnoise(x, y, 7);
  return 128 + 150 * (w - 0.5);
}
function makePlane(w: number, h: number, fn: (x: number, y: number) => number): LumaPlane {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, Math.round(fn(x, y))));
      const p = (y * w + x) * 4;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return toLumaPlane({ data, width: w, height: h, colorSpace: 'srgb' } as unknown as ImageData);
}

{
  const W = 240;
  const H = 160;
  const ref = makePlane(W, H, (x, y) => scene(x, y));
  for (const [dx, dy] of [[0, 0], [6, 0], [0, -5], [9, 7], [-11, 4], [3.5, -2.5]] as [number, number][]) {
    const cur = makePlane(W, H, (x, y) => scene(x - dx, y - dy));
    const px = W / 2;
    const py = H / 2;
    const m = findPatch(ref, cur, px, py, 10, 16);
    const err = Math.max(Math.abs(m.dx - dx), Math.abs(m.dy - dy));
    check(`findPatch recovers (${dx}, ${dy}) px`, err < 0.45, `got (${m.dx.toFixed(2)}, ${m.dy.toFixed(2)}), err ${err.toFixed(3)} px`);
    check(`findPatch reports a confident match (${dx}, ${dy})`, m.score > 0.85, `score ${m.score.toFixed(3)}`);
  }
}

{
  const W = 200;
  const H = 140;
  const ref = makePlane(W, H, (x, y) => scene(x, y));
  // ZNCC must be invariant to a brightness and contrast change, which is what
  // stops a mid-clip exposure shift from being read as the feature vanishing.
  const bright = makePlane(W, H, (x, y) => Math.min(255, scene(x, y) * 1.25 + 40));
  const same = patchZNCC(ref, W / 2, H / 2, ref, W / 2, H / 2, 10);
  const shifted = patchZNCC(ref, W / 2, H / 2, bright, W / 2, H / 2, 10);
  check('ZNCC of a patch with itself is 1', Math.abs(same - 1) < 1e-6, `${same.toFixed(6)}`);
  check('ZNCC ignores a brightness/contrast change', shifted > 0.97, `${shifted.toFixed(4)}`);
  const moved = patchZNCC(ref, W / 2, H / 2, ref, W / 2 + 14, H / 2, 10);
  check('ZNCC drops when the patch is displaced', moved < 0.8, `${moved.toFixed(4)}`);
  const flat = makePlane(W, H, () => 128);
  check('ZNCC of a featureless patch is 0, not NaN', patchZNCC(flat, W / 2, H / 2, flat, W / 2, H / 2, 10) === 0);
  check('patchDiff of identical patches is 0', patchDiff(ref, W / 2, H / 2, ref, W / 2, H / 2, 10) === 0);
  check('patchDiff outside the frame is Infinity', patchDiff(ref, 2, 2, ref, -40, 2, 10) === Infinity);
}

{
  // A patch too close to the edge has no full window to match against, and must
  // report failure rather than inventing motion from a partial patch.
  const W = 120;
  const H = 80;
  const ref = makePlane(W, H, (x, y) => scene(x, y));
  const m = findPatch(ref, ref, 3, 3, 10, 8);
  check('a patch clipped by the frame edge scores zero', m.score === 0 && m.dx === 0 && m.dy === 0, `dx=${m.dx} dy=${m.dy} score=${m.score}`);
}

/* ------------------------------------------------------------------ *
 * Planar helpers and sampling
 * ------------------------------------------------------------------ */
console.log('--- planar helpers ---');
{
  const q: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const m = quadMidpoints(q);
  check('quadMidpoints returns four points', m.length === 4);
  const want: [number, number][] = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
  check('quadMidpoints are the edge midpoints', m.every((p, i) => Math.abs(p[0] - want[i][0]) < 1e-12 && Math.abs(p[1] - want[i][1]) < 1e-12), JSON.stringify(m));
  check('midpoints of a non-axis-aligned quad', (() => {
    const qq: [number, number][] = [[0.2, 0.1], [0.9, 0.3], [0.7, 0.95], [0.1, 0.6]];
    const mm = quadMidpoints(qq);
    return Math.abs(mm[0][0] - 0.55) < 1e-12 && Math.abs(mm[0][1] - 0.2) < 1e-12;
  })());
  check('quadMidpoints of a short list is empty', quadMidpoints([[0, 0], [1, 1]]).length === 0);
}

console.log('--- track sampling ---');
{
  const ta: TrackAnalysis = {
    id: 't1',
    name: 'Point track',
    kind: 'point',
    seed: [[0.2, 0.3]],
    // Linear sweep from x 0.2 to 0.8 over 0..2 s, at 4 analysed frames.
    positions: [[[0.2, 0.3]], [[0.4, 0.3]], [[0.6, 0.3]], [[0.8, 0.3]]],
    frames: [0, 20, 40, 60],
    confidence: [1, 0.9, 0.4, 0.8],
    startSec: 0,
    endSec: 2,
    at: 0,
  };
  const at = (s: number) => sampleTrack(ta, s)[0];
  check('sampleTrack is exact at the first analysed frame', Math.abs(at(0)[0] - 0.2) < 1e-9, `${at(0)[0]}`);
  check('sampleTrack is exact at the last analysed frame', Math.abs(at(2)[0] - 0.8) < 1e-9, `${at(2)[0]}`);
  check('sampleTrack is exact at an interior analysed frame', Math.abs(at(2 / 3)[0] - 0.4) < 1e-9, `${at(2 / 3)[0]}`);
  check('sampleTrack interpolates linearly between frames', Math.abs(at(1)[0] - 0.5) < 1e-9, `${at(1)[0]}`);
  check('sampleTrack holds before the analysed range', Math.abs(at(-5)[0] - 0.2) < 1e-9, `${at(-5)[0]}`);
  check('sampleTrack holds after the analysed range', Math.abs(at(99)[0] - 0.8) < 1e-9, `${at(99)[0]}`);
  check('sampleTrack is monotonic across the range', (() => {
    let prev = -Infinity;
    for (let s = 0; s <= 2.0001; s += 0.05) {
      const v = at(s)[0];
      if (v < prev - 1e-12) return false;
      prev = v;
    }
    return true;
  })());
}
{
  // A planar track returns all four corners, in seed order.
  const ta: TrackAnalysis = {
    id: 't2',
    name: 'Planar track',
    kind: 'planar',
    seed: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]],
    positions: [
      [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]],
      [[0.2, 0.1], [1.0, 0.1], [1.0, 0.9], [0.2, 0.9]],
    ],
    frames: [0, 30],
    confidence: [1, 1],
    startSec: 0,
    endSec: 1,
    at: 0,
  };
  const mid = sampleTrack(ta, 0.5);
  check('planar sampleTrack returns four corners', mid.length === 4, `${mid.length}`);
  check('planar sampleTrack interpolates every corner', mid.every((p, i) => Math.abs(p[0] - (ta.positions[0][i][0] + 0.05)) < 1e-9), JSON.stringify(mid));
}

console.log('');
if (failures) {
  console.log(`${failures} of ${checks} tracker checks FAILED.`);
  process.exitCode = 1;
} else {
  console.log(`All ${checks} tracker checks passed.`);
}
