/*
  Chroma key helpers for the Green Screen dialog.

  Two pure functions, both mirroring the Ultra Key GLSL so what the dialog
  previews is what the compositor renders:

  - suggestKeyColor: find the dominant saturated background color (the
    "screen") by clustering hues over the frame border, and derive a sane
    starting tolerance from the cluster's chroma spread.
  - renderKeyPreview: per-pixel YCbCr-distance matte with tolerance /
    softness / pedestal / spill suppression, composited over a checkerboard
    (result view) or shown as a grayscale matte (matte view).
*/

export interface KeySuggestion {
  /** Screen color, 0..1 RGB. */
  color: [number, number, number];
  /** Ultra Key tolerance 0..100. */
  tolerance: number;
  softness: number;
  spill: number;
  /** Fraction of sampled border pixels belonging to the screen cluster. */
  coverage: number;
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  const v = mx;
  const s = mx > 0 ? d / mx : 0;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, s, v];
}

const lumaOf = (r: number, g: number, b: number) => r * 0.2126 + g * 0.7152 + b * 0.0722;

/** Sample the frame border and find the dominant saturated "screen" color. */
export function suggestKeyColor(data: Uint8ClampedArray, w: number, h: number): KeySuggestion | null {
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.12));
  const inBand = (x: number, y: number) => x < band || y < band || x >= w - band || y >= h - band;
  const BINS = 72;
  const hist = new Float64Array(BINS);
  const px: { r: number; g: number; b: number; hue: number }[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!inBand(x, y)) continue;
      const p = (y * w + x) * 4;
      const r = data[p] / 255;
      const g = data[p + 1] / 255;
      const b = data[p + 2] / 255;
      const [hue, s, v] = rgbToHsv(r, g, b);
      if (s < 0.22 || v < 0.1) continue; // the screen must be a real color
      hist[Math.min(BINS - 1, Math.floor(hue * BINS))] += s * v;
      px.push({ r, g, b, hue });
    }
  }
  if (px.length < 64) return null;
  // Peak hue bin (circular smoothing over +/-2 bins).
  let bestBin = 0;
  let bestScore = -1;
  for (let i = 0; i < BINS; i++) {
    let score = 0;
    for (let k = -2; k <= 2; k++) score += hist[(i + k + BINS) % BINS] * (k === 0 ? 1 : 0.55);
    if (score > bestScore) {
      bestScore = score;
      bestBin = i;
    }
  }
  const peakHue = (bestBin + 0.5) / BINS;
  const hueDist = (a: number, b: number) => {
    const d = Math.abs(a - b);
    return Math.min(d, 1 - d);
  };
  const cluster = px.filter((p) => hueDist(p.hue, peakHue) < 0.09);
  if (cluster.length < 48) return null;
  const coverage = cluster.length / px.length;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of cluster) {
    r += p.r;
    g += p.g;
    b += p.b;
  }
  r /= cluster.length;
  g /= cluster.length;
  b /= cluster.length;
  // Chroma-plane spread around the mean -> starting tolerance. Ultra Key maps
  // tolerance to 0..0.35 of YCbCr chroma distance.
  const kY = lumaOf(r, g, b);
  const kCb = 0.5 + (b - kY) * 0.5643;
  const kCr = 0.5 + (r - kY) * 0.7132;
  let dSum = 0;
  let dSq = 0;
  for (const p of cluster) {
    const Y = lumaOf(p.r, p.g, p.b);
    const Cb = 0.5 + (p.b - Y) * 0.5643;
    const Cr = 0.5 + (p.r - Y) * 0.7132;
    const d = Math.hypot(Cb - kCb, Cr - kCr);
    dSum += d;
    dSq += d * d;
  }
  const mean = dSum / cluster.length;
  const std = Math.sqrt(Math.max(0, dSq / cluster.length - mean * mean));
  const reach = mean + 2 * std;
  const tolerance = Math.round(Math.max(12, Math.min(85, (reach / 0.35) * 100)));
  return { color: [r, g, b], tolerance, softness: 12, spill: 55, coverage };
}

export interface KeyPreviewOptions {
  color: [number, number, number];
  tolerance: number;
  softness: number;
  pedestal: number;
  spill: number;
  mode: 'result' | 'matte';
}

const smoothstepJs = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / Math.max(1e-6, e1 - e0)));
  return t * t * (3 - 2 * t);
};

function rgb2h(r: number, g: number, b: number): number {
  return rgbToHsv(r, g, b)[0];
}
function satOf(r: number, g: number, b: number): number {
  return rgbToHsv(r, g, b)[1];
}

/** Render the key preview for one frame. Mirrors the Ultra Key shader. */
export function renderKeyPreview(src: ImageData, opts: KeyPreviewOptions): ImageData {
  const w = src.width;
  const h = src.height;
  const out = new ImageData(w, h);
  const s = src.data;
  const d = out.data;
  const [kr, kg, kb] = opts.color;
  const kY = lumaOf(kr, kg, kb);
  const kCb = 0.5 + (kb - kY) * 0.5643;
  const kCr = 0.5 + (kr - kY) * 0.7132;
  const kHue = rgb2h(kr, kg, kb);
  const tol = (opts.tolerance / 100) * 0.35;
  const sf = Math.max((opts.softness / 100) * 0.2, 0.001);
  const ped = Math.min(0.95, opts.pedestal / 100);
  const spill = opts.spill / 100;
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    const r = s[p] / 255;
    const g = s[p + 1] / 255;
    const b = s[p + 2] / 255;
    const a = s[p + 3] / 255;
    const Y = lumaOf(r, g, b);
    const Cb = 0.5 + (b - Y) * 0.5643;
    const Cr = 0.5 + (r - Y) * 0.7132;
    const dist = Math.hypot(Cb - kCb, Cr - kCr);
    let m = smoothstepJs(tol, tol + sf, dist);
    m = Math.max(0, Math.min(1, (m - ped) / Math.max(1 - ped, 0.001)));
    // Spill suppression: desaturate pixels near the key hue.
    let rr = r;
    let gg = g;
    let bb = b;
    if (spill > 0) {
      let hd = Math.abs(rgb2h(r, g, b) - kHue);
      hd = Math.min(hd, 1 - hd);
      const mask = (1 - smoothstepJs(0, 0.12, hd)) * satOf(r, g, b) * spill;
      if (mask > 0) {
        rr = r + (Y - r) * mask;
        gg = g + (Y - g) * mask;
        bb = b + (Y - b) * mask;
      }
    }
    const oa = a * m;
    if (opts.mode === 'matte') {
      d[p] = d[p + 1] = d[p + 2] = Math.round(m * 255);
      d[p + 3] = 255;
    } else {
      // Composite over an 8px checkerboard.
      const x = i % w;
      const y = (i / w) | 0;
      const cell = (((x / 8) | 0) + ((y / 8) | 0)) % 2 === 0 ? 0.227 : 0.165;
      d[p] = Math.round((rr * oa + cell * (1 - oa)) * 255);
      d[p + 1] = Math.round((gg * oa + cell * (1 - oa)) * 255);
      d[p + 2] = Math.round((bb * oa + cell * (1 - oa)) * 255);
      d[p + 3] = 255;
    }
  }
  return out;
}
