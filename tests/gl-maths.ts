/*
  Numeric verification for the GPU-side maths that cannot be unit-tested through
  WebGL itself: the corner-pin homography, the 3D LUT sampling coordinate, and
  the CPU optical-flow estimator that feeds the interpolation shader.

  The homography tests deliberately mirror the GLSL index conventions in
  src/engine/gl/shaders.ts (mat3 is column-major there, m[col][row]). A
  transposed inverse compiles fine and silently produces a warped quad that
  looks "almost right", which is the worst kind of bug to chase - so the mirror
  here is written out longhand rather than reusing a linear algebra helper.

  Run with: npm run test:gl
*/
import { computeFlow, toLuma } from '../src/engine/time/opticalFlow';

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = '') {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
}
function near(a: number, b: number, tol: number) {
  return Math.abs(a - b) <= tol;
}

/* ------------------------------------------------------------------ *
 * mat3 mirror: column-major, exactly like GLSL
 * ------------------------------------------------------------------ */
type M3 = number[]; // [c0r0, c0r1, c0r2, c1r0, c1r1, c1r2, c2r0, c2r1, c2r2]
type V2 = [number, number];
type V3 = [number, number, number];

/** m[col][row] in GLSL == cm[col*3 + row] here. */
function at(m: M3, col: number, row: number): number {
  return m[col * 3 + row];
}

function mulMV(m: M3, v: V3): V3 {
  return [
    at(m, 0, 0) * v[0] + at(m, 1, 0) * v[1] + at(m, 2, 0) * v[2],
    at(m, 0, 1) * v[0] + at(m, 1, 1) * v[1] + at(m, 2, 1) * v[2],
    at(m, 0, 2) * v[0] + at(m, 1, 2) * v[1] + at(m, 2, 2) * v[2],
  ];
}

function project(m: M3, p: V2): V2 {
  const q = mulMV(m, [p[0], p[1], 1]);
  if (Math.abs(q[2]) < 1e-9) return [NaN, NaN];
  return [q[0] / q[2], q[1] / q[2]];
}

/**
 * Verbatim port of quadMatrix() from shaders.ts, including the mat3(...)
 * constructor argument order (which sets columns, not rows).
 */
function quadMatrix(tl: V2, tr: V2, br: V2, bl: V2): M3 {
  const dx1 = tr[0] - br[0];
  const dx2 = bl[0] - br[0];
  const dx3 = tl[0] - tr[0] + br[0] - bl[0];
  const dy1 = tr[1] - br[1];
  const dy2 = bl[1] - br[1];
  const dy3 = tl[1] - tr[1] + br[1] - bl[1];
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  const a = tr[0] - tl[0] + g * tr[0];
  const d = tr[1] - tl[1] + g * tr[1];
  const b = bl[0] - tl[0] + h * bl[0];
  const e = bl[1] - tl[1] + h * bl[1];
  const c = tl[0];
  const f = tl[1];
  return [a, d, g, b, e, h, c, f, 1];
}

/** Verbatim port of invert3() from shaders.ts (gl-matrix formulation). */
function invert3(m: M3): M3 {
  const a00 = at(m, 0, 0);
  const a01 = at(m, 1, 0);
  const a02 = at(m, 2, 0);
  const a10 = at(m, 0, 1);
  const a11 = at(m, 1, 1);
  const a12 = at(m, 2, 1);
  const a20 = at(m, 0, 2);
  const a21 = at(m, 1, 2);
  const a22 = at(m, 2, 2);
  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;
  const det = a00 * b01 + a01 * b11 + a02 * b21;
  if (Math.abs(det) < 1e-9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const id = 1 / det;
  return [
    b01 * id,
    b11 * id,
    b21 * id,
    (-a22 * a01 + a02 * a21) * id,
    (a22 * a00 - a02 * a20) * id,
    (-a21 * a00 + a01 * a20) * id,
    (a12 * a01 - a02 * a11) * id,
    (-a12 * a00 + a02 * a10) * id,
    (a11 * a00 - a01 * a10) * id,
  ];
}

console.log('--- corner pin homography ---');
{
  // Affine case: a pure 2x scale with no perspective. g and h must come out 0.
  const M = quadMatrix([0, 0], [2, 0], [2, 2], [0, 2]);
  check('affine quad has no perspective terms', near(at(M, 0, 2), 0, 1e-9) && near(at(M, 1, 2), 0, 1e-9), `g=${at(M, 0, 2)} h=${at(M, 1, 2)}`);
  check('affine quad maps (0.5,0.5) -> (1,1)', (() => { const p = project(M, [0.5, 0.5]); return near(p[0], 1, 1e-9) && near(p[1], 1, 1e-9); })());
  check('identity quad maps to itself', (() => { const I = quadMatrix([0, 0], [1, 0], [1, 1], [0, 1]); const p = project(I, [0.3, 0.7]); return near(p[0], 0.3, 1e-9) && near(p[1], 0.7, 1e-9); })());
}

{
  // The property the shader actually depends on: invert3(quadMatrix(...)) sends
  // each quad corner back to its unit-square corner.
  const quads: { name: string; q: [V2, V2, V2, V2] }[] = [
    { name: 'mild perspective', q: [[0.1, 0.2], [0.9, 0.15], [1.0, 0.9], [0.05, 0.85]] },
    { name: 'strong keystone', q: [[0.3, 0.05], [0.7, 0.05], [1.0, 1.0], [0.0, 1.0]] },
    { name: 'rotated + tapered', q: [[0.2, 0.1], [0.95, 0.35], [0.8, 0.95], [0.1, 0.7]] },
  ];
  const unit: V2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (const { name, q } of quads) {
    const inv = invert3(quadMatrix(q[0], q[1], q[2], q[3]));
    let worst = 0;
    for (let i = 0; i < 4; i++) {
      const p = project(inv, q[i]);
      worst = Math.max(worst, Math.abs(p[0] - unit[i][0]), Math.abs(p[1] - unit[i][1]));
    }
    check(`${name}: inverse maps corners to unit square`, worst < 1e-6, `worst err ${worst.toExponential(2)}`);

    // Round trip: forward then inverse is the identity over the whole square.
    const fwd = quadMatrix(q[0], q[1], q[2], q[3]);
    let rt = 0;
    for (const s of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      for (const t of [0.05, 0.3, 0.6, 0.9]) {
        const back = project(inv, project(fwd, [s, t]));
        rt = Math.max(rt, Math.abs(back[0] - s), Math.abs(back[1] - t));
      }
    }
    check(`${name}: forward/inverse round trip`, rt < 1e-6, `worst err ${rt.toExponential(2)}`);
  }
}

{
  // Degenerate quads must not produce NaN or Infinity anywhere in the frame.
  const degen = invert3(quadMatrix([0.5, 0.5], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]));
  check('collapsed quad falls back to identity', degen.every((v, i) => near(v, [1, 0, 0, 0, 1, 0, 0, 0, 1][i], 1e-9)));
  const line = quadMatrix([0, 0], [1, 1], [2, 2], [3, 3]);
  check('collinear quad does not produce NaN', line.every((v) => Number.isFinite(v)));
}

console.log('--- 3D LUT sampling coordinate ---');
{
  // Mirror of applyLut3D() in shaders.ts. The half-texel inset must land exactly
  // on the first and last cube entries, otherwise CLAMP_TO_EDGE extrapolates and
  // the extremes of the grade are wrong - black lifts, white clips.
  for (const size of [17, 33, 65]) {
    const lutCoord = (c: number) => {
      const s = Math.max(size, 2);
      const cl = c < 0 ? 0 : c > 1 ? 1 : c;
      return cl * ((s - 1) / s) + 0.5 / s;
    };
    const texelIndex = (c: number) => lutCoord(c) * size - 0.5;
    let worst = 0;
    for (let i = 0; i <= 100; i++) {
      const c = i / 100;
      worst = Math.max(worst, Math.abs(texelIndex(c) - c * (size - 1)));
    }
    check(`LUT size ${size}: half-texel inset hits exact texel centres`, worst < 1e-9, `worst err ${worst.toExponential(2)}`);
    check(`LUT size ${size}: black maps to texel 0`, near(texelIndex(0), 0, 1e-9));
    check(`LUT size ${size}: white maps to last texel`, near(texelIndex(1), size - 1, 1e-9));
    check(`LUT size ${size}: out-of-range input is clamped inside the cube`, texelIndex(-0.5) >= -1e-9 && texelIndex(1.5) <= size - 1 + 1e-9);
  }
}

console.log('--- optical flow estimator ---');

/** Minimal ImageData stand-in: the estimator only reads data/width/height. */
function makeImage(w: number, h: number, fn: (x: number, y: number) => number): ImageData {
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
  return { data, width: w, height: h, colorSpace: 'srgb' } as unknown as ImageData;
}

/** Deterministic hash in 0..1. */
function hash(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * Smooth value noise on a `scale`-pixel lattice, interpolated with smoothstep.
 *
 * Band-limiting matters here. A test pattern built from hard-edged per-pixel
 * noise puts strong coherent energy well below the grid cell size; box-averaging
 * it into cells aliases that energy into a phase-dependent artifact which
 * overwhelms the actual motion signal, and every block matcher on earth locks
 * onto the alias. Real footage is optically low-pass filtered by the lens and
 * the sensor's pixel well, so it does not contain that signal - the test content
 * has to match what the estimator will actually be fed.
 */
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

/** Multi-octave texture, finest lattice 16px = 2 fine cells = 1 coarse cell. */
function pattern(x: number, y: number): number {
  const w = 0.5 * vnoise(x, y, 128) + 0.3 * vnoise(x, y, 48) + 0.2 * vnoise(x, y, 16);
  return 128 + 150 * (w - 0.5) - x * 0.03;
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
}

{
  // Sized so a grid cell covers ~8 image pixels, which is what the compositor
  // actually uses (48 cells across a 1080p frame). Cells much smaller than the
  // pattern's finest scale make the SAD surface noise-dominated, and no block
  // matcher can align sub-cell detail that has been averaged away.
  const W = 384;
  const H = 216;
  const gw = 48;
  const gh = 27;
  const cellW = W / gw;
  const cellH = H / gh;

  // Translate by known amounts, including deliberately sub-cell ones, and check
  // what comes back.
  const cases: { dx: number; dy: number; tol: number }[] = [
    { dx: 0, dy: 0, tol: 0.2 },
    { dx: 16, dy: 0, tol: 0.5 },
    { dx: 0, dy: 16, tol: 0.5 },
    { dx: 24, dy: -16, tol: 0.5 },
    { dx: -20, dy: 12, tol: 0.5 },
    { dx: 12, dy: 4, tol: 0.5 },
    { dx: 6, dy: -6, tol: 0.5 },
  ];

  for (const { dx, dy, tol } of cases) {
    // B is A's content displaced by (dx, dy): B(x,y) = A(x-dx, y-dy).
    const A = makeImage(W, H, (x, y) => pattern(x, y));
    const B = makeImage(W, H, (x, y) => pattern(x - dx, y - dy));
    const f = computeFlow(A, B, gw, gh);
    check(`flow grid dims are clamped and sane (${gw}x${gh})`, f.gw === gw && f.gh === gh, `${f.gw}x${f.gh}`);
    // Measure over interior cells only; the border cells have no full patch.
    const ex: number[] = [];
    const ey: number[] = [];
    const conf: number[] = [];
    for (let cy = 4; cy < f.gh - 4; cy++) {
      for (let cx = 4; cx < f.gw - 4; cx++) {
        const i = (cy * f.gw + cx) * 4;
        // Decode exactly as FLOW_FRAG does: (rg - 0.5) * 2 gives normalized
        // frame units, then scale by the grid size to get cells.
        ex.push((f.data[i] - 0.5) * 2 * f.gw);
        ey.push((f.data[i + 1] - 0.5) * 2 * f.gh);
        conf.push(f.data[i + 2]);
      }
    }
    const gotX = median(ex) * cellW;
    const gotY = median(ey) * cellH;
    const errCells = Math.max(Math.abs(gotX - dx) / cellW, Math.abs(gotY - dy) / cellH);
    check(`translation (${dx}, ${dy}) px recovered`, errCells <= tol, `got (${gotX.toFixed(2)}, ${gotY.toFixed(2)}) px, err ${errCells.toFixed(2)} cells`);
    // FLOW_FRAG maps confidence through `1 - clamp(b * 1.5, 0, 1)` into an
    // occlusion weight, so anything above ~0.4 still predominantly warps rather
    // than dissolving. Sub-cell motion on band-limited texture legitimately
    // scores below a dead-on integer-cell match: the parabola resolves the
    // vector, but a smooth patch simply carries less evidence.
    const subCell = Math.abs(dx / (W / gw) - Math.round(dx / (W / gw))) > 0.05 || Math.abs(dy / (H / gh) - Math.round(dy / (H / gh))) > 0.05;
    const floor = subCell ? 0.4 : 0.9;
    check(`confidence supports warping (${dx}, ${dy})${subCell ? ' [sub-cell]' : ''}`, median(conf) > floor, `median conf ${median(conf).toFixed(2)}, floor ${floor}`);
  }
}

{
  // A flat field carries no motion information. The estimator must say so with
  // low confidence - the shader uses that to dissolve instead of smearing.
  const W = 128;
  const H = 72;
  const flatA = makeImage(W, H, () => 128);
  const flatB = makeImage(W, H, () => 130);
  const f = computeFlow(flatA, flatB, 32, 18);
  const conf: number[] = [];
  for (let i = 0; i < f.gw * f.gh; i++) conf.push(f.data[i * 4 + 2]);
  check('flat field reports low confidence', median(conf) < 0.15, `median conf ${median(conf).toFixed(3)}`);
}

{
  // A featureless gradient carries far less matching evidence than real texture,
  // so it must score clearly lower - that ordering is what lets FLOW_FRAG choose
  // to dissolve bland areas instead of warping them. (A linear ramp under SAD is
  // still uniquely matchable along its own direction; this is about evidence,
  // not the classic aperture ambiguity.)
  const W = 256;
  const H = 144;
  const rampA = makeImage(W, H, (x) => (x / (W - 1)) * 255);
  const rampB = makeImage(W, H, (x) => ((x - 12) / (W - 1)) * 255);
  const f = computeFlow(rampA, rampB, 32, 18);
  const conf: number[] = [];
  for (let cy = 3; cy < f.gh - 3; cy++) for (let cx = 3; cx < f.gw - 3; cx++) conf.push(f.data[(cy * f.gw + cx) * 4 + 2]);
  check('a featureless ramp scores below textured content', median(conf) < 0.4, `median conf ${median(conf).toFixed(3)}`);
}

{
  // Output must stay inside the encodable range: the shader decodes with
  // (rg - 0.5) * 2, so anything outside 0..1 aliases into a reversed vector.
  const W = 128;
  const H = 72;
  const A = makeImage(W, H, (x, y) => pattern(x, y));
  const B = makeImage(W, H, (x, y) => pattern(x - 40, y + 30)); // larger than the search radius
  const f = computeFlow(A, B, 32, 18);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < f.gw * f.gh * 4; i++) {
    min = Math.min(min, f.data[i]);
    max = Math.max(max, f.data[i]);
  }
  check('flow output stays within 0..1 for RGBA16 encoding', min >= 0 && max <= 1, `range ${min.toFixed(4)}..${max.toFixed(4)}`);
  // Zero motion must encode as exactly 0.5, otherwise a still frame warps.
  const stillA = makeImage(W, H, (x, y) => pattern(x, y));
  const stillB = makeImage(W, H, (x, y) => pattern(x, y));
  const sf = computeFlow(stillA, stillB, 32, 18);
  let maxDev = 0;
  for (let i = 0; i < sf.gw * sf.gh; i++) {
    maxDev = Math.max(maxDev, Math.abs(sf.data[i * 4] - 0.5), Math.abs(sf.data[i * 4 + 1] - 0.5));
  }
  check('a still frame encodes as zero motion (0.5)', maxDev < 1e-9, `max deviation ${maxDev.toExponential(2)}`);
  check('an unrecoverable displacement saturates rather than wrapping', min >= 0 && max <= 1);
}

{
  // Luma grid: uniform input gives uniform output, and the downsample preserves
  // the mean of a linear ramp closely enough to match on.
  const g = toLuma(makeImage(64, 36, (x) => (x / 63) * 255), 16, 9);
  check('toLuma produces the requested grid size', g.length === 16 * 9, `${g.length}`);
  check('toLuma ramp is monotonic', (() => { for (let i = 1; i < 16; i++) if (g[i] <= g[i - 1]) return false; return true; })());
  check('toLuma spans 0..1 across a full ramp', near(g[0], 0, 0.06) && near(g[15], 1, 0.06), `${g[0].toFixed(3)}..${g[15].toFixed(3)}`);
  const flat = toLuma(makeImage(32, 32, () => 200), 8, 8);
  check('toLuma of a flat frame is constant', flat.every((v) => near(v, flat[0], 1e-6)), `${flat[0].toFixed(4)}`);
}

console.log('');
if (failures) {
  console.log(`${failures} of ${checks} GPU-maths checks FAILED.`);
  process.exitCode = 1;
} else {
  console.log(`All ${checks} GPU-maths checks passed.`);
}
