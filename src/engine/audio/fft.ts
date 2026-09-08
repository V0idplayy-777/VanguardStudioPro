/*
  Small radix-2 FFT over interleaved complex buffers, plus Hann-windowed STFT
  helpers for the spectral voice-cleanup pass. No dependencies.
*/

export function isPowerOfTwo(n: number) {
  return n > 0 && (n & (n - 1)) === 0;
}

/** In-place FFT/IFFT on separate real/imag arrays (length must be a power of two). */
export function fft(re: Float32Array | Float64Array, im: Float32Array | Float64Array, inverse = false) {
  const n = re.length;
  // bit-reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang),
      wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1,
        curI = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j],
          ui = im[i + j];
        const vr = re[i + j + len / 2] * curR - im[i + j + len / 2] * curI;
        const vi = re[i + j + len / 2] * curI + im[i + j + len / 2] * curR;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr;
        im[i + j + len / 2] = ui - vi;
        const nr = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, n - 1)));
  return w;
}

export interface StftFrame {
  re: Float32Array;
  im: Float32Array;
  mag: Float32Array;
  phase: Float32Array;
}

const frameCache = new Map<number, StftFrame>();

/** Analyze one windowed frame. Returns cached scratch buffers — copy out what you keep. */
export function analyzeFrame(signal: Float32Array, offset: number, size: number, window: Float32Array): StftFrame {
  let f = frameCache.get(size);
  if (!f) {
    f = { re: new Float32Array(size), im: new Float32Array(size), mag: new Float32Array(size / 2 + 1), phase: new Float32Array(size / 2 + 1) };
    frameCache.set(size, f);
  }
  for (let i = 0; i < size; i++) {
    const s = offset + i;
    f.re[i] = (s >= 0 && s < signal.length ? signal[s] : 0) * window[i];
    f.im[i] = 0;
  }
  fft(f.re, f.im);
  const half = size / 2;
  for (let k = 0; k <= half; k++) {
    const r = f.re[k],
      im = f.im[k];
    f.mag[k] = Math.sqrt(r * r + im * im);
    f.phase[k] = Math.atan2(im, r);
  }
  return f;
}

/** Resynthesize one frame from modified magnitudes + original phases into `out` (overlap-add). */
export function synthFrame(mag: Float32Array, phase: Float32Array, size: number, window: Float32Array, out: Float32Array, offset: number) {
  const re = new Float32Array(size),
    im = new Float32Array(size);
  const half = size / 2;
  for (let k = 0; k <= half; k++) {
    re[k] = mag[k] * Math.cos(phase[k]);
    im[k] = mag[k] * Math.sin(phase[k]);
    if (k > 0 && k < half) {
      re[size - k] = re[k];
      im[size - k] = -im[k];
    }
  }
  fft(re, im, true);
  for (let i = 0; i < size; i++) {
    const o = offset + i;
    if (o >= 0 && o < out.length) out[o] += re[i] * window[i];
  }
}
