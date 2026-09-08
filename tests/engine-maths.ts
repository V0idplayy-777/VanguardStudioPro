/*
  Scratch test for the pure engine maths (run with: npx esbuild ... && node).
  Not part of the app bundle.
*/
import { toLumaGrid, estimateShift, smoothPath, planStabilization, type StabilizeAnalysis } from '../src/engine/stabilize/stabilizer';
import { energyEnvelope, findSyncOffset } from '../src/engine/audio/sync';
import { planMontageSlots, seededUnit } from '../src/engine/montage/montage';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) failures++;
}

/* ---------- stabilizer: shift recovery ---------- */
{
  // Synthetic textured frame: random 10px blobs (non-periodic, cell-scale features).
  const W = 160, H = 90;
  let seed = 42;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const data = new Uint8ClampedArray(W * H * 4).fill(60);
  for (let b = 0; b < 220; b++) {
    const bx = Math.floor(rnd() * W), by = Math.floor(rnd() * H);
    const r = 4 + Math.floor(rnd() * 8);
    const v = Math.floor(rnd() * 255);
    for (let y = Math.max(0, by - r); y < Math.min(H, by + r); y++)
      for (let x = Math.max(0, bx - r); x < Math.min(W, bx + r); x++) {
        const p = (y * W + x) * 4;
        data[p] = data[p + 1] = data[p + 2] = v;
      }
  }
  for (let p = 3; p < data.length; p += 4) data[p] = 255;
  // Shift the image content by (+8, -4) px = (+2, -1) grid cells.
  const shifted = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = x - 8, sy = y + 4;
    const p = (y * W + x) * 4;
    if (sx >= 0 && sx < W && sy >= 0 && sy < H) { const q = (sy * W + sx) * 4; shifted[p] = data[q]; shifted[p+1] = data[q+1]; shifted[p+2] = data[q+2]; }
    shifted[p + 3] = 255;
  }
  const g1 = toLumaGrid(data, W, H, 40, 22);
  const g2 = toLumaGrid(shifted, W, H, 40, 22);
  const est = estimateShift(g1.grid, g2.grid, 40, 22, 5);
  check('estimateShift recovers x', Math.abs(est.dx - 2) < 0.6, `dx=${est.dx.toFixed(2)} conf=${est.confidence.toFixed(2)}`);
  check('estimateShift recovers y', Math.abs(est.dy + 1) < 0.6, `dy=${est.dy.toFixed(2)}`);
  // No motion -> no shift.
  const still = estimateShift(g1.grid, g1.grid, 40, 22, 5);
  check('identical frames -> no shift', Math.abs(still.dx) < 0.3 && Math.abs(still.dy) < 0.3, `dx=${still.dx.toFixed(2)} dy=${still.dy.toFixed(2)}`);
  // Flat frames: no confidence.
  const flat = new Float32Array(40 * 22);
  const flatEst = estimateShift(flat, flat, 40, 22, 4);
  check('flat footage -> zero confidence', flatEst.confidence === 0 && flatEst.dx === 0);
}

/* ---------- stabilizer: smoothing + plan ---------- */
{
  const s = smoothPath([0, 0, 10, 0, 0], 1, false);
  check('smoothPath averages', Math.abs(s[2] - (10 + 0 + 0) / 3) < 1e-9, s.join(','));
  const lock = smoothPath([0, 5, 10], 2, true);
  check('smoothPath lock = mean', lock.every((v) => v === 5));

  // Jittery path: raw zig-zags +/-0.05, smoothed needs corrections + zoom.
  const samples = [] as StabilizeAnalysis['samples'];
  for (let i = 0; i < 40; i++) samples.push({ t: i / 12, dx: i % 2 ? 0.05 : -0.05, dy: 0 });
  const analysis: StabilizeAnalysis = { samples, sampleStep: 1 / 12, maxShift: 0.05, texture: 0.1 };
  const plan = planStabilization(analysis, { smoothSec: 0.5, zoomLimit: 1.2 });
  check('plan zoom <= limit', plan.zoom <= 1.2, `zoom=${plan.zoom.toFixed(3)}`);
  check('plan corrections bounded by crop', plan.maxCorrection <= (plan.zoom - 1) / 2 + 1e-9, `maxCorr=${plan.maxCorrection.toFixed(3)}`);
  const locked = planStabilization(analysis, { lock: true, zoomLimit: 1.5 });
  check('lock plan produces zoom for jitter', locked.zoom > 1.05, `zoom=${locked.zoom.toFixed(3)}`);
}

/* ---------- audio sync ---------- */
{
  // Fake AudioBuffers: 48 kHz, claps at known times.
  const sr = 48000;
  const mk = (claps: number[], dur = 6): AudioBuffer => {
    const len = Math.floor(dur * sr);
    const ch = new Float32Array(len);
    for (const t of claps) {
      const i0 = Math.floor(t * sr);
      for (let i = 0; i < sr * 0.05 && i0 + i < len; i++) ch[i0 + i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.015));
    }
    return { sampleRate: sr, length: len, numberOfChannels: 1, duration: dur, getChannelData: () => ch } as unknown as AudioBuffer;
  };
  // ref has claps at 1.0, 2.5, 4.0; other recorded the same event starting 0.8s earlier:
  // other's claps are at 0.2, 1.7, 3.2 => other(t) == ref(t + 0.8) => offset +0.8.
  const ref = mk([1.0, 2.5, 4.0]);
  const other = mk([0.2, 1.7, 3.2]);
  const m = findSyncOffset(ref, other, { maxLagSec: 5 });
  check('sync offset +0.8s recovered', Math.abs(m.offsetSec - 0.8) < 0.05, `offset=${m.offsetSec.toFixed(3)} conf=${m.confidence.toFixed(2)}`);
  const m2 = findSyncOffset(ref, mk([1.0, 2.5, 4.0]), { maxLagSec: 5 });
  check('identical sources -> 0 offset', Math.abs(m2.offsetSec) < 0.03, `offset=${m2.offsetSec.toFixed(3)}`);
  const env = energyEnvelope(ref);
  check('envelope length', env.length === Math.floor(6 / 0.01), `${env.length}`);
}

/* ---------- montage planning ---------- */
{
  const beats = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
  const slots = planMontageSlots(beats, 6, { density: 2, maxSeconds: 6 });
  check('slots start at 0', slots.length > 0 && slots[0].start === 0);
  check('slots end at cap', Math.abs(slots[slots.length - 1].end - 6) < 1e-9, `end=${slots[slots.length - 1].end}`);
  check('slots contiguous', slots.every((s, i) => i === 0 || Math.abs(s.start - slots[i - 1].end) < 1e-9));
  check('slots respect min length', slots.every((s) => s.end - s.start >= 0.35 - 1e-9), slots.map((s) => (s.end - s.start).toFixed(2)).join(' '));
  const dense = planMontageSlots(beats, 6, { density: 1, maxSeconds: 6 });
  check('density 1 cuts more than density 2', dense.length > slots.length, `${dense.length} vs ${slots.length}`);
  const capped = planMontageSlots(beats, 60, { density: 1, maxSeconds: 3 });
  check('maxSeconds caps', Math.abs(capped[capped.length - 1].end - 3) < 1e-9);
  check('too-short music -> no slots', planMontageSlots(beats, 0.2, { density: 1, maxSeconds: 10 }).length === 0);
  check('seededUnit deterministic', seededUnit('abc') === seededUnit('abc') && seededUnit('abc') !== seededUnit('abd'));
}

console.log(failures ? `\n${failures} FAILURES` : '\nAll engine maths tests passed.');
process.exit(failures ? 1 : 0);
