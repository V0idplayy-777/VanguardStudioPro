import { analyzeFrame, hannWindow, synthFrame } from './fft';

/*
  Spectral voice cleanup DSP (offline render).

  - learnNoiseProfile: average magnitude spectrum of a "silence" span.
  - spectralGate: per-bin Wiener-ish suppression vs the profile, with attack/
    release smoothing to avoid musical noise.
  - notchHum: narrow IIR notches at mains harmonics (50/60 Hz + harmonics).
  - softenReverb: light spectral-decay gate that pushes low-energy tails down.
  - autoLevel: slow RMS leveler toward a target with makeup + soft limiting.

  All functions are pure Float32Array transforms so the same code renders the
  dialog preview and the baked "cleaned" asset copy.
*/

export interface NoiseProfile {
  size: number;
  sampleRate: number;
  spectrum: Float32Array; // avg magnitude per bin (half+1)
}

export function learnNoiseProfile(channel: Float32Array, sampleRate: number, fromSample: number, toSample: number, size = 2048): NoiseProfile {
  const window = hannWindow(size);
  const half = size / 2;
  const acc = new Float32Array(half + 1);
  const hop = size / 2;
  let n = 0;
  for (let o = fromSample - size / 2; o < toSample; o += hop) {
    const f = analyzeFrame(channel, Math.round(o), size, window);
    for (let k = 0; k <= half; k++) acc[k] += f.mag[k];
    n++;
  }
  if (n > 0) for (let k = 0; k <= half; k++) acc[k] /= n;
  return { size, sampleRate, spectrum: acc };
}

export interface GateOptions {
  /** 0..100 strength. */
  amount: number;
  /** dB above the noise floor that counts as signal. */
  thresholdDb?: number;
  /** Max suppression in dB. */
  maxSuppressDb?: number;
  /** Smoothing 0..1 (higher = gentler, fewer artifacts). */
  smoothing?: number;
}

export function spectralGate(channel: Float32Array, sampleRate: number, profile: NoiseProfile, opts: GateOptions, onProgress?: (p: number) => void): Float32Array {
  const size = profile.size;
  const window = hannWindow(size);
  const half = size / 2;
  const hop = size / 4; // 75% overlap for clean resynthesis
  const out = new Float32Array(channel.length + size);
  const amount = Math.max(0, Math.min(100, opts.amount)) / 100;
  const thresh = Math.pow(10, (opts.thresholdDb ?? 4) / 20);
  const floor = Math.pow(10, -(opts.maxSuppressDb ?? 18) / 20);
  const smooth = opts.smoothing ?? 0.75;
  const gainMem = new Float32Array(half + 1).fill(1);
  const mag = new Float32Array(half + 1);
  const winGain = new Float32Array(channel.length + size); // WOLA normalization
  for (let o = -size; o < channel.length + size; o += hop) {
    const f = analyzeFrame(channel, o, size, window);
    for (let k = 0; k <= half; k++) {
      const noise = profile.spectrum[k] * thresh + 1e-9;
      // Wiener-style gain
      const w = (f.mag[k] * f.mag[k]) / (f.mag[k] * f.mag[k] + noise * noise);
      let g = Math.max(floor, w);
      g = 1 - (1 - g) * amount;
      // attack/release smoothing across frames
      const prev = gainMem[k];
      gainMem[k] = g < prev ? g : prev + (g - prev) * (1 - smooth);
      mag[k] = f.mag[k] * gainMem[k];
    }
    synthFrame(mag, f.phase, size, window, out, o);
    for (let i = 0; i < size; i++) {
      const idx = o + i;
      if (idx >= 0 && idx < winGain.length) winGain[idx] += window[i] * window[i];
    }
    if (onProgress && ((o / hop) & 31) === 0) onProgress(Math.max(0, Math.min(1, o / channel.length)));
  }
  const result = new Float32Array(channel.length);
  for (let i = 0; i < channel.length; i++) result[i] = winGain[i] > 1e-6 ? out[i] / winGain[i] : 0;
  onProgress?.(1);
  return result;
}

/** Narrow notches at `base` Hz and its harmonics (mains hum removal). */
export function notchHum(channel: Float32Array, sampleRate: number, base = 50, harmonics = 5, q = 25): Float32Array {
  const out = Float32Array.from(channel);
  for (let h = 1; h <= harmonics; h++) {
    const f0 = base * h;
    if (f0 >= sampleRate / 2 - 10) break;
    const w0 = (2 * Math.PI * f0) / sampleRate;
    const alpha = Math.sin(w0) / (2 * q);
    const b0 = 1,
      b1 = -2 * Math.cos(w0),
      b2 = 1;
    const a0 = 1 + alpha,
      a1 = -2 * Math.cos(w0),
      a2 = 1 - alpha;
    let x1 = 0,
      x2 = 0,
      y1 = 0,
      y2 = 0;
    for (let i = 0; i < out.length; i++) {
      const x = out[i];
      const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      out[i] = y;
    }
  }
  return out;
}

/**
 * "De-reverb lite": push late low-energy content down by gating short-time
 * energy below a slowly-following floor. Subtle by design — real
 * dereverberation needs blind deconvolution; this just dries up tails.
 */
export function softenReverb(channel: Float32Array, sampleRate: number, amount = 50): Float32Array {
  const amt = Math.max(0, Math.min(100, amount)) / 100;
  if (amt <= 0) return channel;
  const win = Math.floor(sampleRate * 0.02);
  const out = new Float32Array(channel.length);
  let floor = 1e-6;
  const alpha = 1 - Math.exp(-1 / (sampleRate * 0.15));
  for (let i = 0; i < channel.length; i++) {
    const e = Math.abs(channel[i]);
    floor += (e - floor) * (e < floor ? alpha * 4 : alpha * 0.1);
    const gate = e < floor * 1.6 ? 0.55 : 1;
    // smooth with a short lookaround average
    let s = 0,
      n = 0;
    const r = Math.min(win, i);
    for (let j = i - r; j <= i; j += 4) {
      s += Math.abs(channel[j]);
      n++;
    }
    const avg = s / Math.max(1, n);
    const g = avg < floor * 1.4 ? gate : 1;
    out[i] = channel[i] * (1 - (1 - g) * amt);
  }
  return out;
}

export interface LevelOptions {
  /** Target RMS in dBFS. */
  targetDb?: number;
  /** Max makeup gain in dB. */
  maxGainDb?: number;
  /** Compressor-ish ceiling in dBFS. */
  ceilingDb?: number;
}

export function autoLevel(channel: Float32Array, sampleRate: number, opts: LevelOptions = {}): Float32Array {
  const target = Math.pow(10, (opts.targetDb ?? -20) / 20);
  const maxGain = Math.pow(10, (opts.maxGainDb ?? 12) / 20);
  const ceiling = Math.pow(10, (opts.ceilingDb ?? -1.5) / 20);
  const out = new Float32Array(channel.length);
  const win = Math.floor(sampleRate * 0.4);
  let sum = 0;
  const buf = new Float32Array(win);
  let idx = 0,
    filled = 0;
  let gain = 1;
  const attack = 1 - Math.exp(-1 / (sampleRate * 0.01));
  const release = 1 - Math.exp(-1 / (sampleRate * 0.4));
  for (let i = 0; i < channel.length; i++) {
    const e = channel[i] * channel[i];
    sum += e - (filled >= win ? buf[idx] : 0);
    buf[idx] = e;
    idx = (idx + 1) % win;
    if (filled < win) filled++;
    const rms = Math.sqrt(sum / filled + 1e-12);
    const want = Math.min(maxGain, rms > 1e-5 ? target / rms : maxGain);
    gain += (want - gain) * (want < gain ? attack : release);
    let v = channel[i] * gain;
    if (Math.abs(v) > ceiling) v = Math.sign(v) * (ceiling + (Math.abs(v) - ceiling) * 0.1);
    out[i] = Math.max(-1, Math.min(1, v));
  }
  return out;
}

/** High-pass to remove rumble/plosive energy below `freq` Hz (12 dB/oct). */
export function highPass(channel: Float32Array, sampleRate: number, freq = 80): Float32Array {
  const out = Float32Array.from(channel);
  const rc = 1 / (2 * Math.PI * freq);
  const dt = 1 / sampleRate;
  const a = rc / (rc + dt);
  for (let pass = 0; pass < 2; pass++) {
    let y = 0,
      xPrev = 0;
    for (let i = 0; i < out.length; i++) {
      const x = out[i];
      y = a * (y + x - xPrev);
      xPrev = x;
      out[i] = y;
    }
  }
  return out;
}

/** Find the quietest span of at least `minSeconds` — the noise-fingerprint source. */
export function findQuietestSpan(channel: Float32Array, sampleRate: number, minSeconds = 0.4): { from: number; to: number } {
  const block = Math.floor(sampleRate * 0.1);
  const blocks = Math.max(1, Math.floor(channel.length / block));
  const energy = new Float32Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let s = 0;
    const s0 = b * block,
      s1 = Math.min(channel.length, s0 + block);
    for (let i = s0; i < s1; i++) s += channel[i] * channel[i];
    energy[b] = s / Math.max(1, s1 - s0);
  }
  const need = Math.max(1, Math.ceil(minSeconds / 0.1));
  let best = 0,
    bestE = Infinity;
  for (let b = 0; b + need <= blocks; b++) {
    let s = 0;
    for (let k = 0; k < need; k++) s += energy[b + k];
    if (s < bestE) {
      bestE = s;
      best = b;
    }
  }
  return { from: best * block, to: Math.min(channel.length, (best + need) * block) };
}
