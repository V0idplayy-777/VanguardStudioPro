import type { Id } from '../../types/project';
import { uid } from '../util';
import { kvGet, kvSet, kvDel } from '../media/mediaDb';

/*
  3D LUTs: .cube / .3dl import, plus generated "input transform" LUTs that turn
  log or wide-gamut footage into Rec.709 display values.

  Everything ends up as the same thing — a `Lut3D` sampled by one GLSL
  `sampler3D` in the compositor — so an imported creative look and a camera-log
  conversion take exactly the same render path and can both be exported back to
  .cube.

  Ordering follows the .cube convention: RED varies fastest, so element
  (r, g, b) lives at index ((b * size) + g) * size + r. That maps directly onto
  a WebGL2 TEXTURE_3D uploaded with width = height = depth = size.

  --- On the built-in transforms -------------------------------------------
  Only curves that are exact published standards, or that can be verified
  numerically here, are generated in-app (see tests/lut-maths.ts, which checks
  monotonicity, continuity at every cut point and round-trip error). Camera
  vendor log curves are NOT approximated from memory, because a slightly wrong
  EOTF produces a visibly wrong image and looks like a bug in the grade. For
  S-Log3 / C-Log3 / V-Log / D-Log / BRAW and friends, import the manufacturer's
  .cube — it is exact, it is free, and it is what a colourist would use anyway.
*/

export interface Lut3D {
  id: string;
  title: string;
  /** Cube edge length. */
  size: number;
  /** size^3 * 4 floats, RGBA, red fastest. Alpha is always 1. */
  rgba: Float32Array;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** Original file text, kept so the LUT survives a reload without re-parsing. */
  source?: string;
  /** Generated in-app rather than imported. */
  generated?: boolean;
  /** 'creative' | 'technical' — groups the pickers. */
  kind: 'creative' | 'technical';
  fileName?: string;
  bytes?: number;
  at?: number;
}

export interface LutMeta {
  id: string;
  title: string;
  size: number;
  kind: 'creative' | 'technical';
  fileName?: string;
  bytes?: number;
  at?: number;
}

/* ======================================================================== */
/*  Parsing                                                                  */
/* ======================================================================== */

/**
 * Parse a `.cube` file (Adobe / Resolve / DaVinci dialect, also what every
 * camera vendor ships). Supports 3D LUTs, 1D LUTs (expanded to 3D), DOMAIN_MIN
 * / DOMAIN_MAX and `#` comments.
 */
export function parseCube(text: string, fileName = ''): Lut3D {
  const lines = text.split(/\r?\n/);
  let title = fileName.replace(/\.cube$/i, '') || 'Untitled LUT';
  let size3d = 0;
  let size1d = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const up = line.toUpperCase();
    if (up.startsWith('TITLE')) {
      const m = line.match(/"([^"]*)"/);
      if (m) title = m[1];
      continue;
    }
    if (up.startsWith('LUT_3D_SIZE')) {
      size3d = parseInt(line.split(/\s+/)[1] ?? '0', 10);
      continue;
    }
    if (up.startsWith('LUT_1D_SIZE')) {
      size1d = parseInt(line.split(/\s+/)[1] ?? '0', 10);
      continue;
    }
    if (up.startsWith('DOMAIN_MIN')) {
      const n = nums(line);
      if (n.length >= 3) domainMin = [n[0], n[1], n[2]];
      continue;
    }
    if (up.startsWith('DOMAIN_MAX')) {
      const n = nums(line);
      if (n.length >= 3) domainMax = [n[0], n[1], n[2]];
      continue;
    }
    // Any other keyword we do not model is skipped rather than fatal.
    if (/^[A-Z_]/.test(line) && !/^-?[\d.]/.test(line)) continue;
    const n = nums(line);
    if (n.length >= 3) values.push(n[0], n[1], n[2]);
  }

  if (!size3d && !size1d) throw new Error('No LUT_3D_SIZE or LUT_1D_SIZE found — not a .cube file.');
  if (size3d) {
    const expected = size3d * size3d * size3d * 3;
    if (values.length < expected) throw new Error(`Truncated LUT: expected ${expected / 3} entries, found ${values.length / 3}.`);
    if (values.length > expected + 3) throw new Error(`Too many entries for a ${size3d}³ LUT (found ${values.length / 3}).`);
    return fromTriples(title, size3d, values.slice(0, expected), 'creative', fileName, text, domainMin, domainMax);
  }
  // 1D LUT: expand onto a 33³ cube so the shader path stays single.
  return expand1D(title, size1d, values, fileName, text);
}

/**
 * Parse a `.3dl` file. Two dialects are handled:
 *   - Assimilate/Scratch/Resolve: the first data line lists the input mesh
 *     (`0 1023` for 10-bit, or a full ramp), entries are integer code values.
 *   - Autodesk (Lustre/Maya): same idea, sometimes without the mesh line.
 */
export function parse3dl(text: string, fileName = ''): Lut3D {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!lines.length) throw new Error('Empty .3dl file.');
  let idx = 0;
  // Mesh line: all integers, either 2 (range) or N (explicit ramp).
  let mesh: number[] | null = null;
  const first = nums(lines[0]);
  if (first.length >= 2 && first.every((v) => Number.isInteger(v))) {
    mesh = first;
    idx = 1;
  }
  const values: number[] = [];
  for (; idx < lines.length; idx++) {
    const n = nums(lines[idx]);
    if (n.length >= 3) values.push(n[0], n[1], n[2]);
  }
  const count = values.length / 3;
  const size = Math.round(Math.cbrt(count));
  if (size < 2 || size * size * size !== count) throw new Error(`Cannot determine .3dl cube size from ${count} entries.`);
  let lo = 0,
    hi = 1023;
  if (mesh) {
    if (mesh.length === 2) [lo, hi] = mesh;
    else {
      lo = mesh[0];
      hi = mesh[mesh.length - 1];
    }
  } else {
    // Infer from the data range.
    lo = Infinity;
    hi = -Infinity;
    for (const v of values) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi <= 1) {
      lo = 0;
      hi = 1;
    }
  }
  const span = hi - lo || 1;
  const norm = values.map((v) => (v - lo) / span);
  return fromTriples(fileName.replace(/\.3dl$/i, '') || 'Untitled LUT', size, norm, 'creative', fileName, text);
}

/** Parse either format from a filename or sniffed content. */
export function parseLutFile(file: { name: string; text: string }): Lut3D {
  const lower = file.name.toLowerCase();
  const lut = lower.endsWith('.3dl') ? parse3dl(file.text, file.name) : parseCube(file.text, file.name);
  lut.id = uid('lut');
  lut.fileName = file.name;
  lut.bytes = file.text.length;
  lut.at = Date.now();
  return lut;
}

function nums(line: string): number[] {
  const out: number[] = [];
  for (const tok of line.split(/[\s,]+/)) {
    if (!tok) continue;
    const v = Number(tok);
    if (Number.isFinite(v)) out.push(v);
    else break;
  }
  return out;
}

function fromTriples(title: string, size: number, values: number[], kind: 'creative' | 'technical', fileName?: string, source?: string, domainMin: [number, number, number] = [0, 0, 0], domainMax: [number, number, number] = [1, 1, 1]): Lut3D {
  const rgba = new Float32Array(size * size * size * 4);
  for (let i = 0, p = 0; i < size * size * size; i++, p += 3) {
    rgba[i * 4] = clamp01(values[p] ?? 0);
    rgba[i * 4 + 1] = clamp01(values[p + 1] ?? 0);
    rgba[i * 4 + 2] = clamp01(values[p + 2] ?? 0);
    rgba[i * 4 + 3] = 1;
  }
  return { id: uid('lut'), title, size, rgba, domainMin, domainMax, source, kind, fileName };
}

function expand1D(title: string, size1d: number, values: number[], fileName?: string, source?: string): Lut3D {
  if (values.length < size1d * 3) throw new Error('Truncated 1D LUT.');
  const out = 33;
  const rgba = new Float32Array(out * out * out * 4);
  const lookup = (v: number) => {
    const x = clamp01(v) * (size1d - 1);
    const i0 = Math.floor(x),
      i1 = Math.min(size1d - 1, i0 + 1),
      f = x - i0;
    return [values[i0 * 3] * (1 - f) + values[i1 * 3] * f, values[i0 * 3 + 1] * (1 - f) + values[i1 * 3 + 1] * f, values[i0 * 3 + 2] * (1 - f) + values[i1 * 3 + 2] * f];
  };
  for (let b = 0; b < out; b++)
    for (let g = 0; g < out; g++)
      for (let r = 0; r < out; r++) {
        const i = ((b * out + g) * out + r) * 4;
        const c = lookup(r / (out - 1));
        rgba[i] = clamp01(c[0]);
        rgba[i + 1] = clamp01(c[1]);
        rgba[i + 2] = clamp01(c[2]);
        rgba[i + 3] = 1;
      }
  return { id: uid('lut'), title, size: out, rgba, domainMin: [0, 0, 0], domainMax: [1, 1, 1], source, kind: 'creative', fileName };
}

/* ======================================================================== */
/*  Serialisation                                                            */
/* ======================================================================== */

/** Write a LUT back out as a .cube (round-trips imports and generated LUTs). */
export function toCube(lut: Lut3D): string {
  const out: string[] = [];
  out.push(`TITLE "${lut.title.replace(/"/g, "'")}"`);
  out.push(`# Exported by Vanguard Studio Pro`);
  out.push(`DOMAIN_MIN ${lut.domainMin.join(' ')}`);
  out.push(`DOMAIN_MAX ${lut.domainMax.join(' ')}`);
  out.push(`LUT_3D_SIZE ${lut.size}`);
  out.push('');
  const n = lut.size * lut.size * lut.size;
  for (let i = 0; i < n; i++) {
    out.push(`${lut.rgba[i * 4].toFixed(6)} ${lut.rgba[i * 4 + 1].toFixed(6)} ${lut.rgba[i * 4 + 2].toFixed(6)}`);
  }
  return out.join('\n');
}

/* ======================================================================== */
/*  Colour science primitives                                                */
/* ======================================================================== */

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export type RGB = [number, number, number];
/** CIE xy chromaticity coordinate (primaries and white points). */
export type XY = [number, number];
type Mat3 = [number, number, number, number, number, number, number, number, number];

function applyMat(m: Mat3, c: RGB): RGB {
  return [m[0] * c[0] + m[1] * c[1] + m[2] * c[2], m[3] * c[0] + m[4] * c[1] + m[5] * c[2], m[6] * c[0] + m[7] * c[1] + m[8] * c[2]];
}

function mulMat(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0) as number[];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o as unknown as Mat3;
}

function invertMat(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h,
    B = -(d * i - f * g),
    C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) return m;
  const id = 1 / det;
  return [A * id, (c * h - b * i) * id, (b * f - c * e) * id, B * id, (a * i - c * g) * id, (c * d - a * f) * id, C * id, (b * g - a * h) * id, (a * e - b * d) * id];
}

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * CIE xy chromaticity -> XYZ, scaled to Y = 1.
 *
 * Imaginary primaries (negative y, as in ARRI Wide Gamut 3) are legitimate
 * here: they produce negative X and Z, which is exactly what a wide-gamut
 * matrix needs. Only a true y = 0 is degenerate.
 */
function xyToXYZ(x: number, y: number): RGB {
  if (Math.abs(y) < 1e-9) return [0, 0, 0];
  return [x / y, 1, (1 - x - y) / y];
}

/**
 * Build the RGB->XYZ matrix for a set of primaries and a white point, scaled so
 * the white maps to Y = 1.
 */
function rgbToXYZ(primaries: [XY, XY, XY], white: XY): Mat3 {
  const [r, g, b] = primaries.map((p) => xyToXYZ(p[0], p[1])) as [RGB, RGB, RGB];
  const w = xyToXYZ(white[0], white[1]);
  const m: Mat3 = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const s = applyMat(invertMat(m), w);
  return [m[0] * s[0], m[1] * s[1], m[2] * s[2], m[3] * s[0], m[4] * s[1], m[5] * s[2], m[6] * s[0], m[7] * s[1], m[8] * s[2]];
}

/** RGB->Rec.709 matrix for a source gamut (Bradford-free: both are D65). */
export function gamutToRec709(primaries: [XY, XY, XY], white: XY = [0.3127, 0.329]): Mat3 {
  return mulMat(invertMat(REC709_XYZ), rgbToXYZ(primaries, white));
}

const REC709_PRIMARIES: [XY, XY, XY] = [
  [0.64, 0.33],
  [0.3, 0.6],
  [0.15, 0.06],
];
const REC709_XYZ = rgbToXYZ(REC709_PRIMARIES, [0.3127, 0.329]);

/* ---------- transfer functions (exact published standards) ---------- */

/** ITU-R BT.709 OETF inverse: display code -> scene linear. */
export function rec709EOTF(v: number): number {
  const x = Math.max(0, v);
  return x < 0.08145 ? x / 4.5 : Math.pow((x + 0.099) / 1.099, 1 / 0.45);
}
/** ITU-R BT.709 OETF: scene linear -> display code. */
export function rec709OETF(l: number): number {
  const x = Math.max(0, l);
  return x < 0.018 ? 4.5 * x : 1.099 * Math.pow(x, 0.45) - 0.099;
}

/** IEC 61966-2-1 sRGB EOTF. */
export function srgbEOTF(v: number): number {
  const x = Math.max(0, v);
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** SMPTE ST 2084 (PQ) EOTF -> absolute luminance normalised so 1.0 = 10 000 cd/m². */
export function pqEOTF(v: number): number {
  const m1 = 2610 / 16384;
  const m2 = (2523 / 4096) * 128;
  const c1 = 3424 / 4096;
  const c2 = (2413 / 4096) * 32;
  const c3 = (2392 / 4096) * 32;
  const p = Math.pow(Math.max(0, v), 1 / m2);
  const num = Math.max(0, p - c1);
  const den = c2 - c3 * p;
  if (den <= 0) return 0;
  return Math.pow(num / den, 1 / m1);
}

/** ARIB STD-B67 (HLG) EOTF, system gamma 1.2 applied per display. */
export function hlgEOTF(v: number): number {
  const a = 0.17883277;
  const b = 1 - 4 * a;
  const c = 0.5 - a * Math.log(4 * a);
  const x = Math.max(0, Math.min(1, v));
  const scene = x <= 0.5 ? (x * x) / 3 : (Math.exp((x - c) / a) + b) / 12;
  return scene;
}

/** SMPTE ST 2084 (PQ) OETF: absolute luminance (1.0 = 10 000 nits) -> PQ code. */
export function pqOETF(l: number): number {
  const m1 = 2610 / 16384;
  const m2 = (2523 / 4096) * 128;
  const c1 = 3424 / 4096;
  const c2 = (2413 / 4096) * 32;
  const c3 = (2392 / 4096) * 32;
  const y = Math.pow(Math.max(0, l), m1);
  return Math.pow((c1 + c2 * y) / (1 + c3 * y), m2);
}

/** ARIB STD-B67 (HLG) OETF: scene linear -> HLG signal. */
export function hlgOETF(l: number): number {
  const a = 0.17883277;
  const b = 1 - 4 * a;
  const c = 0.5 - a * Math.log(4 * a);
  const x = Math.max(0, l);
  return x <= 1 / 12 ? Math.sqrt(3 * x) : a * Math.log(12 * x - b) + c;
}

/**
 * ARRI LogC3 (EI 800) log->linear, published parameter set.
 * log2lin(t) = (t > e*cut + f) ? (pow(10, (t - d) / c) - b) / a : (t - f) / e
 */
const LOGC3 = { cut: 0.0113, a: 5.555556, b: 0.052272, c: 0.24719, d: 0.385537, e: 5.367655, f: 0.092809 };
export function logC3EOTF(v: number): number {
  const t = Math.max(0, v);
  const k = LOGC3;
  const cutY = k.e * k.cut + k.f;
  return t > cutY ? (Math.pow(10, (t - k.d) / k.c) - k.b) / k.a : (t - k.f) / k.e;
}
/** Inverse, used to build and to verify round-trips. */
export function logC3OETF(l: number): number {
  const k = LOGC3;
  const x = Math.max(0, l);
  return x > k.cut ? k.c * Math.log10(k.a * x + k.b) + k.d : k.e * x + k.f;
}

/**
 * Parametric Cineon-style log, exposed as "Generic camera log" so any vendor
 * curve can be dialled in against a reference frame instead of guessed at.
 * Encodes `grayLin` to `grayCode` with `range` stops of latitude either side.
 */
export interface GenericLogParams {
  /** Code value for 18% gray (0..1). */
  grayCode: number;
  /** Code value for black (0..1). */
  blackCode: number;
  /** Scene-linear exposure the code value 1.0 represents, relative to gray. */
  stopsAboveGray: number;
  /** Scene-linear exposure the black code represents, relative to gray. */
  stopsBelowGray: number;
  grayLin: number;
}

export const GENERIC_LOG_DEFAULTS: GenericLogParams = { grayCode: 0.435, blackCode: 0.0928, stopsAboveGray: 8.5, stopsBelowGray: 8, grayLin: 0.18 };

/** log code (0..1) -> scene linear, per the generic parameters. */
export function genericLogEOTF(v: number, p: GenericLogParams = GENERIC_LOG_DEFAULTS): number {
  const x = Math.max(0, Math.min(1, v));
  const span = Math.max(1e-6, p.grayCode - p.blackCode);
  const norm = (x - p.blackCode) / span; // 0 at black, 1 at gray, >1 above gray
  if (norm <= 0) return 0;
  // Below gray: `stopsBelowGray` stops of latitude compressed into 0..1 of the
  // code span; above gray: `stopsAboveGray` stops per unit of the same span.
  const linAtGray = p.grayLin;
  if (norm <= 1) return linAtGray * Math.pow(2, -p.stopsBelowGray * (1 - norm));
  return linAtGray * Math.pow(2, p.stopsAboveGray * (norm - 1));
}

/* ======================================================================== */
/*  Input transforms                                                         */
/* ======================================================================== */

export interface InputTransform {
  id: string;
  label: string;
  group: string;
  note: string;
  /** Display-referred source value -> scene linear (per channel). */
  decode: (v: number) => number;
  /** Source RGB primaries, when they differ from Rec.709. */
  primaries?: [XY, XY, XY];
  white?: [number, number];
  /** Peak luminance in nits for HDR sources (drives the tone map). */
  peakNits?: number;
  /** Extra scene-linear -> display step (tone mapping). */
  toneMap?: (l: number) => number;
  /**
   * Highlight roll-off knee in scene-linear. Log and HDR curves encode far more
   * than Rec.709 can display (LogC3 EI 800 reaches ~340% reflectance), so
   * anything above the knee is compressed exponentially towards white instead
   * of hard-clipping. Without this, blown highlights flatten into a dead white
   * plate instead of rolling off the way a film print does.
   */
  rollOffKnee?: number;
}

/**
 * Soft highlight knee: identity below `knee`, exponentially approaching 1.0
 * above it. Continuous and differentiable at the knee, so no visible band.
 */
export function rollOff(l: number, knee: number): number {
  const x = Math.max(0, l);
  const k = Math.max(0, Math.min(0.999, knee));
  if (x <= k) return x;
  const span = 1 - k;
  return k + span * (1 - Math.exp(-(x - k) / span));
}

/** Hable-ish filmic tone map, normalised so 1.0 in maps to ~1.0 out. */
function filmic(x: number, shoulder = 0.9): number {
  const v = Math.max(0, x);
  const a = 2.51,
    b = 0.03,
    c = 2.43,
    d = 0.59,
    e = 0.14;
  const f = (t: number) => (t * (a * t + b)) / (t * (c * t + d) + e);
  return clamp01(f(v) / f(shoulder * 4));
}

const REC2020_PRIMARIES: [XY, XY, XY] = [
  [0.708, 0.292],
  [0.17, 0.797],
  [0.131, 0.046],
];
const P3D65_PRIMARIES: [XY, XY, XY] = [
  [0.68, 0.32],
  [0.265, 0.69],
  [0.15, 0.06],
];
const AWG3_PRIMARIES: [XY, XY, XY] = [
  [0.684, 0.313],
  [0.221, 0.848],
  [0.0861, -0.078],
];
const SGAMUT3_PRIMARIES: [XY, XY, XY] = [
  [0.766, 0.275],
  [0.225, 0.8],
  [0.089, -0.087],
];
const CINEMA_GAMUT_PRIMARIES: [XY, XY, XY] = [
  [0.74, 0.28],
  [0.17, 1.14],
  [0.08, -0.1],
];
const VGAMUT_PRIMARIES: [XY, XY, XY] = [
  [0.73, 0.28],
  [0.165, 1.135],
  [0.1, -0.07],
];

export const INPUT_TRANSFORMS: InputTransform[] = [
  {
    id: 'none',
    label: 'None (already Rec.709)',
    group: 'Off',
    note: 'No conversion. Correct for ordinary camera or screen-recording footage.',
    decode: rec709EOTF,
  },
  {
    id: 'rec709',
    label: 'Rec.709 (display)',
    group: 'Standard',
    note: 'BT.709 OETF inverse. Select this if the file was tagged Rec.709 but is being read as raw code values.',
    decode: rec709EOTF,
  },
  {
    id: 'srgb',
    label: 'sRGB → Rec.709',
    group: 'Standard',
    note: 'IEC 61966-2-1 sRGB. Use for stills, screen captures and web sources.',
    decode: srgbEOTF,
  },
  {
    id: 'rec2020',
    label: 'Rec.2020 → Rec.709',
    group: 'Wide gamut',
    note: 'BT.2020 primaries mapped to Rec.709. Fixes the over-saturated look of UHD sources.',
    decode: rec709EOTF,
    primaries: REC2020_PRIMARIES,
  },
  {
    id: 'p3d65',
    label: 'DCI-P3 (D65) → Rec.709',
    group: 'Wide gamut',
    note: 'Display P3 to Rec.709. The usual conversion for phone and cinema-master sources.',
    decode: rec709EOTF,
    primaries: P3D65_PRIMARIES,
  },
  {
    id: 'hlg2020',
    label: 'HLG (Rec.2020) → Rec.709 SDR',
    group: 'HDR',
    note: 'ARIB STD-B67 hybrid log-gamma, as recorded by phones and broadcasters, tone mapped to SDR.',
    decode: hlgEOTF,
    primaries: REC2020_PRIMARIES,
    peakNits: 1000,
    toneMap: (l) => filmic(l * 1.6),
  },
  {
    id: 'pq2020',
    label: 'HDR10 / PQ (Rec.2020) → Rec.709 SDR',
    group: 'HDR',
    note: 'SMPTE ST 2084 at 1000 nits, filmic tone map to SDR. For HDR10 screen recordings and camera masters.',
    decode: pqEOTF,
    primaries: REC2020_PRIMARIES,
    peakNits: 1000,
    toneMap: (l) => filmic(l * 1.6),
  },
  {
    id: 'logc3',
    label: 'ARRI LogC3 (EI 800) → Rec.709',
    group: 'Camera log',
    note: 'Published ALEXA LogC3 parameters at EI 800 with ALEXA Wide Gamut 3. For other exposure indices, import ARRI\'s .cube.',
    decode: logC3EOTF,
    primaries: AWG3_PRIMARIES,
    rollOffKnee: 0.75,
  },
  {
    id: 'sgamut3',
    label: 'S-Gamut3 (log curve unknown) → Rec.709 gamut',
    group: 'Camera log',
    note: 'Gamut conversion only — it assumes the curve is already linear-ish. For S-Log2/S-Log3 footage import Sony\'s official .cube; the curve is exact there and we will not guess at it.',
    decode: rec709EOTF,
    primaries: SGAMUT3_PRIMARIES,
  },
  {
    id: 'cinemaGamut',
    label: 'Canon Cinema Gamut → Rec.709 gamut',
    group: 'Camera log',
    note: 'Gamut conversion only. For C-Log2/C-Log3 curves import Canon\'s official .cube.',
    decode: rec709EOTF,
    primaries: CINEMA_GAMUT_PRIMARIES,
  },
  {
    id: 'vgamut',
    label: 'Panasonic V-Gamut → Rec.709 gamut',
    group: 'Camera log',
    note: 'Gamut conversion only. For the V-Log curve import Panasonic\'s official V-Log→V709 .cube.',
    decode: rec709EOTF,
    primaries: VGAMUT_PRIMARIES,
  },
  {
    id: 'genericLog',
    label: 'Generic camera log (adjustable)…',
    group: 'Camera log',
    note: 'Cineon-style parametric log. Dial gray code, black code and latitude against a reference frame to approximate any vendor curve without importing a file.',
    decode: (v) => genericLogEOTF(v),
    rollOffKnee: 0.75,
  },
];

export function inputTransform(id: string | undefined): InputTransform | null {
  if (!id || id === 'none') return null;
  return INPUT_TRANSFORMS.find((t) => t.id === id) ?? null;
}

/* ======================================================================== */
/*  LUT generation                                                           */
/* ======================================================================== */

const GEN_SIZE = 33;

/**
 * Bake an input transform into a 33³ LUT: decode the source curve, convert the
 * gamut, optionally tone map, then encode to Rec.709 display values.
 */
export function buildTransformLut(t: InputTransform, opts: { size?: number; generic?: GenericLogParams } = {}): Lut3D {
  const size = opts.size ?? GEN_SIZE;
  const rgba = new Float32Array(size * size * size * 4);
  const mat: Mat3 = t.primaries ? gamutToRec709(t.primaries, t.white ?? [0.3127, 0.329]) : IDENTITY;
  const decode = t.id === 'genericLog' && opts.generic ? (v: number) => genericLogEOTF(v, opts.generic) : t.decode;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const i = ((b * size + g) * size + r) * 4;
        const src: RGB = [r / (size - 1), g / (size - 1), b / (size - 1)];
        let lin: RGB = [decode(src[0]), decode(src[1]), decode(src[2])];
        lin = [Math.max(0, lin[0]), Math.max(0, lin[1]), Math.max(0, lin[2])];
        if (mat !== IDENTITY) lin = applyMat(mat, lin);
        // Per-channel roll-off: compresses over-range highlights towards white
        // and lets them desaturate slightly, which is how film prints behave.
        if (t.rollOffKnee != null) lin = [rollOff(lin[0], t.rollOffKnee), rollOff(lin[1], t.rollOffKnee), rollOff(lin[2], t.rollOffKnee)];
        if (t.toneMap) {
          // Tone map on luma so highlights desaturate gracefully rather than clipping per channel.
          const y = 0.2627 * lin[0] + 0.678 * lin[1] + 0.0593 * lin[2];
          const mapped = t.toneMap(Math.max(0, y));
          const scale = y > 1e-5 ? mapped / y : 1;
          lin = [lin[0] * scale, lin[1] * scale, lin[2] * scale];
        }
        rgba[i] = clamp01(rec709OETF(Math.max(0, lin[0])));
        rgba[i + 1] = clamp01(rec709OETF(Math.max(0, lin[1])));
        rgba[i + 2] = clamp01(rec709OETF(Math.max(0, lin[2])));
        rgba[i + 3] = 1;
      }
    }
  }
  return { id: `transform:${t.id}`, title: t.label, size, rgba, domainMin: [0, 0, 0], domainMax: [1, 1, 1], generated: true, kind: 'technical' };
}

/** Identity LUT — the "off" position for the effect, and a safe fallback. */
export function identityLut(size = 17): Lut3D {
  const rgba = new Float32Array(size * size * size * 4);
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const i = ((b * size + g) * size + r) * 4;
        rgba[i] = r / (size - 1);
        rgba[i + 1] = g / (size - 1);
        rgba[i + 2] = b / (size - 1);
        rgba[i + 3] = 1;
      }
  return { id: 'identity', title: 'Identity', size, rgba, domainMin: [0, 0, 0], domainMax: [1, 1, 1], generated: true, kind: 'technical' };
}

/* ======================================================================== */
/*  CPU sampling (thumbnails, previews, tests)                               */
/* ======================================================================== */

/** Trilinear sample of a LUT at normalised RGB. */
export function sampleLut(lut: Lut3D, r: number, g: number, b: number): RGB {
  const s = lut.size;
  const dr = lut.domainMax[0] - lut.domainMin[0] || 1;
  const dg = lut.domainMax[1] - lut.domainMin[1] || 1;
  const db = lut.domainMax[2] - lut.domainMin[2] || 1;
  const xr = clamp01((r - lut.domainMin[0]) / dr) * (s - 1);
  const xg = clamp01((g - lut.domainMin[1]) / dg) * (s - 1);
  const xb = clamp01((b - lut.domainMin[2]) / db) * (s - 1);
  const r0 = Math.floor(xr),
    g0 = Math.floor(xg),
    b0 = Math.floor(xb);
  const r1 = Math.min(s - 1, r0 + 1),
    g1 = Math.min(s - 1, g0 + 1),
    b1 = Math.min(s - 1, b0 + 1);
  const fr = xr - r0,
    fg = xg - g0,
    fb = xb - b0;
  const at = (rr: number, gg: number, bb: number) => ((bb * s + gg) * s + rr) * 4;
  const out: RGB = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = lut.rgba[at(r0, g0, b0) + c] * (1 - fr) + lut.rgba[at(r1, g0, b0) + c] * fr;
    const c10 = lut.rgba[at(r0, g1, b0) + c] * (1 - fr) + lut.rgba[at(r1, g1, b0) + c] * fr;
    const c01 = lut.rgba[at(r0, g0, b1) + c] * (1 - fr) + lut.rgba[at(r1, g0, b1) + c] * fr;
    const c11 = lut.rgba[at(r0, g1, b1) + c] * (1 - fr) + lut.rgba[at(r1, g1, b1) + c] * fr;
    const c0 = c00 * (1 - fg) + c10 * fg;
    const c1 = c01 * (1 - fg) + c11 * fg;
    out[c] = c0 * (1 - fb) + c1 * fb;
  }
  return out;
}

/** Apply a LUT in place to an RGBA8 ImageData (used for thumbnails and previews). */
export function applyLutToImageData(img: ImageData, lut: Lut3D, intensity = 1) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0) continue;
    const r = d[i] / 255,
      g = d[i + 1] / 255,
      b = d[i + 2] / 255;
    const out = sampleLut(lut, r, g, b);
    d[i] = Math.round(255 * clamp01(r + (out[0] - r) * intensity));
    d[i + 1] = Math.round(255 * clamp01(g + (out[1] - g) * intensity));
    d[i + 2] = Math.round(255 * clamp01(b + (out[2] - b) * intensity));
  }
  return img;
}

/* ======================================================================== */
/*  Store (persisted per browser)                                            */
/* ======================================================================== */

const KV_LIST = 'luts:list';
const KV_ITEM = (id: Id) => `luts:${id}`;

interface StoredLut {
  id: string;
  title: string;
  size: number;
  kind: 'creative' | 'technical';
  fileName?: string;
  bytes?: number;
  at?: number;
  source?: string;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
}

const cache = new Map<string, Lut3D>();
let list: StoredLut[] | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function onLutChange(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

async function loadList(): Promise<StoredLut[]> {
  if (list) return list;
  list = ((await kvGet<StoredLut[]>(KV_LIST)) ?? []).filter((l) => l && l.id && l.size >= 2);
  return list;
}

/** All imported LUTs, newest first. */
export async function listLuts(): Promise<LutMeta[]> {
  const l = await loadList();
  return [...l].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).map((x) => ({ id: x.id, title: x.title, size: x.size, kind: x.kind, fileName: x.fileName, bytes: x.bytes, at: x.at }));
}

export function peekLut(id: string): Lut3D | undefined {
  return cache.get(id);
}

/** Load (and cache) a LUT by id. Generated transforms are built on demand. */
export async function getLut(id: string): Promise<Lut3D | null> {
  if (!id) return null;
  const hit = cache.get(id);
  if (hit) return hit;
  if (id.startsWith('transform:')) {
    const t = inputTransform(id.slice('transform:'.length));
    if (!t) return null;
    const lut = buildTransformLut(t);
    cache.set(id, lut);
    return lut;
  }
  const l = await loadList();
  const meta = l.find((x) => x.id === id);
  if (!meta) return null;
  if (!meta.source) return null;
  try {
    const lut = parseLutFile({ name: meta.fileName ?? 'lut.cube', text: meta.source });
    lut.id = meta.id;
    lut.title = meta.title;
    lut.kind = meta.kind;
    cache.set(meta.id, lut);
    return lut;
  } catch {
    return null;
  }
}

/** Synchronous accessor for the render path; returns null until loaded. */
export function getLutSync(id: string): Lut3D | null {
  return cache.get(id) ?? null;
}

/** Kick off a load without waiting (used by the compositor's prefetch). */
export function preloadLut(id: string) {
  if (!id || cache.has(id)) return;
  void getLut(id);
}

export async function addLut(lut: Lut3D): Promise<Lut3D> {
  const l = await loadList();
  const rec: StoredLut = { id: lut.id, title: lut.title, size: lut.size, kind: lut.kind, fileName: lut.fileName, bytes: lut.bytes, at: lut.at ?? Date.now(), source: lut.source, domainMin: lut.domainMin, domainMax: lut.domainMax };
  list = [l.filter((x) => x.id !== rec.id), rec].flat();
  cache.set(rec.id, lut);
  await kvSet(KV_ITEM(rec.id), rec);
  await kvSet(KV_LIST, list);
  emit();
  return lut;
}

export async function renameLut(id: string, title: string) {
  const l = await loadList();
  const rec = l.find((x) => x.id === id);
  if (!rec) return;
  rec.title = title;
  await kvSet(KV_ITEM(id), rec);
  await kvSet(KV_LIST, l);
  const c = cache.get(id);
  if (c) c.title = title;
  emit();
}

export async function deleteLut(id: string) {
  const l = await loadList();
  list = l.filter((x) => x.id !== id);
  cache.delete(id);
  await kvDel(KV_ITEM(id));
  await kvSet(KV_LIST, list);
  emit();
}

/** Load every known LUT into memory (called once at startup). */
export async function warmLutCache() {
  const l = await loadList();
  for (const rec of l) {
    if (!rec.source) continue;
    try {
      const lut = parseLutFile({ name: rec.fileName ?? 'lut.cube', text: rec.source });
      lut.id = rec.id;
      lut.title = rec.title;
      lut.kind = rec.kind;
      cache.set(rec.id, lut);
    } catch {
      /* unreadable entry: leave it out of the cache, the list still shows it */
    }
  }
  emit();
}

/** A small generated creative LUT so the effect is useful with nothing imported. */
export function builtInLooks(): Lut3D[] {
  const mk = (id: string, title: string, fn: (r: number, g: number, b: number) => RGB): Lut3D => {
    const size = 33;
    const rgba = new Float32Array(size * size * size * 4);
    for (let b = 0; b < size; b++)
      for (let g = 0; g < size; g++)
        for (let r = 0; r < size; r++) {
          const i = ((b * size + g) * size + r) * 4;
          const o = fn(r / (size - 1), g / (size - 1), b / (size - 1));
          rgba[i] = clamp01(o[0]);
          rgba[i + 1] = clamp01(o[1]);
          rgba[i + 2] = clamp01(o[2]);
          rgba[i + 3] = 1;
        }
    return { id, title, size, rgba, domainMin: [0, 0, 0], domainMax: [1, 1, 1], generated: true, kind: 'creative' };
  };
  return [
    mk('builtin:neutral', 'Neutral (no change)', (r, g, b) => [r, g, b]),
    mk('builtin:tealOrange', 'Teal & Orange', (r, g, b) => {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const sh = 1 - smooth(0, 0.6, l),
        hi = smooth(0.4, 1, l);
      return [r - 0.08 * sh + 0.1 * hi, g + 0.02 * sh + 0.03 * hi, b + 0.1 * sh - 0.08 * hi];
    }),
    mk('builtin:bleach', 'Bleach Bypass', (r, g, b) => {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const k = 0.35;
      return [r * (1 - k) + l * k * 1.15, g * (1 - k) + l * k, b * (1 - k) + l * k * 0.9];
    }),
    mk('builtin:warmFilm', 'Warm Film', (r, g, b) => [Math.pow(r, 0.95) * 1.04, g, Math.pow(b, 1.06) * 0.96]),
    mk('builtin:coolTeal', 'Cool Teal', (r, g, b) => [Math.pow(r, 1.05) * 0.96, g, Math.pow(b, 0.95) * 1.05]),
    mk('builtin:vintage', 'Vintage Fade', (r, g, b) => {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const f = (v: number) => v * 0.82 + 0.09;
      return [mix(f(r), l, 0.3) + 0.04, mix(f(g), l, 0.3) + 0.02, mix(f(b), l, 0.3) - 0.02];
    }),
  ];
}

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function mix(a: number, b: number, t: number) {
  return a * (1 - t) + b * t;
}

export { REC709_PRIMARIES, REC2020_PRIMARIES, P3D65_PRIMARIES, gamutToRec709 as matrixToRec709 };

/* ======================================================================== */
/*  Picker options                                                           */
/* ======================================================================== */

export interface LutChoice {
  id: string;
  title: string;
  /** Grouping label for Select/option lists. */
  group: string;
}

const GROUP_IMPORTED = 'Imported files';
const GROUP_CAMERA = 'Camera log conversion';
const GROUP_LOOKS = 'Built-in looks';

/**
 * Every LUT the user can pick, in the order the pickers should show them.
 *
 * Shared by the LUT Manager and the Creative LUT effect so the two lists can
 * never drift apart. `transform:*` ids are generated on demand by getLut rather
 * than stored, which is why they are enumerated from INPUT_TRANSFORMS.
 */
export async function lutChoices(): Promise<LutChoice[]> {
  const imported = await listLuts();
  const out: LutChoice[] = imported.map((m) => ({ id: m.id, title: m.title, group: GROUP_IMPORTED }));
  for (const t of INPUT_TRANSFORMS) {
    // 'none' is not a LUT, and the parametric log is dialled in from the
    // Interpret Footage dialog rather than picked blind from a list.
    if (t.id === 'none' || t.id === 'genericLog') continue;
    out.push({ id: `transform:${t.id}`, title: t.label, group: GROUP_CAMERA });
  }
  for (const l of builtInLooks()) out.push({ id: l.id, title: l.title, group: GROUP_LOOKS });
  return out;
}
