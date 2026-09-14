/**
 * Optical flow: per-cell motion vectors between two decoded frames.
 *
 * Used to synthesise in-between frames when a clip is slowed down or speed-ramped
 * (see Clip.interpolation = 'opticalFlow'). Without it, slow motion strobes
 * because the source simply has no frame to show at the requested time.
 *
 * Method: hierarchical block matching on a downsampled luma grid, mirroring the
 * approach already proven in engine/stabilize/stabilizer.ts. A coarse pass finds
 * large displacements cheaply, then a fine pass refines them. The result is
 * median-filtered so a single bad cell cannot tear the image.
 *
 * This is CPU work, so it is computed asynchronously and cached. The compositor
 * asks for a field, gets `null` while it is pending, falls back to a cross
 * dissolve for that paint, and flags the frame incomplete so playback re-renders
 * once the vectors land. Scrubbing therefore converges in a frame or two rather
 * than blocking the UI thread.
 */

export interface FlowField {
  /** Cell grid width/height. */
  gw: number;
  gh: number;
  /** gw*gh*4 floats, RGBA16: r=gx, g=gy (normalized), b=confidence, a=1. */
  data: Float32Array;
}

const cache = new Map<string, FlowField>();
const inflight = new Set<string>();
const MAX_CACHED = 24;

export function flowAvailable(key: string): boolean {
  return cache.has(key);
}

export function getFlow(key: string): FlowField | null {
  return cache.get(key) ?? null;
}

export function clearFlow(prefix?: string) {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
  for (const k of [...inflight]) if (k.startsWith(prefix)) inflight.delete(k);
}

/** Drop cached fields when the decode cache is reset (proxy swap, reload). */
export function clearAllFlow() {
  cache.clear();
  inflight.clear();
}

/**
 * Request a flow field. Returns it immediately when cached, otherwise kicks off
 * an asynchronous compute and returns null. The caller should re-render when the
 * producer resolves; `onReady` fires once the field is in the cache.
 */
export function requestFlow(
  key: string,
  producer: () => Promise<{ a: ImageData; b: ImageData } | null>,
  gw: number,
  gh: number,
  onReady?: () => void,
): FlowField | null {
  const hit = cache.get(key);
  if (hit) return hit;
  if (inflight.has(key)) return null;
  inflight.add(key);
  void producer()
    .then((frames) => {
      if (!frames) return;
      const field = computeFlow(frames.a, frames.b, gw, gh);
      if (cache.size >= MAX_CACHED) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      cache.set(key, field);
    })
    .catch(() => {})
    .finally(() => {
      inflight.delete(key);
      onReady?.();
    });
  return null;
}

/* ------------------------------------------------------------------ *
 * Pure estimator (unit-tested in tests/gl-maths.ts)
 * ------------------------------------------------------------------ */

/** Downsample to a luma grid in 0..1. */
export function toLuma(src: ImageData, gw: number, gh: number): Float32Array {
  const { data, width: w, height: h } = src;
  const grid = new Float32Array(gw * gh);
  for (let cy = 0; cy < gh; cy++) {
    const sy0 = Math.floor((cy * h) / gh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((cy + 1) * h) / gh));
    for (let cx = 0; cx < gw; cx++) {
      const sx0 = Math.floor((cx * w) / gw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((cx + 1) * w) / gw));
      let s = 0;
      let n = 0;
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          const p = (y * w + x) * 4;
          s += (data[p] * 0.2126 + data[p + 1] * 0.7152 + data[p + 2] * 0.0722) / 255;
          n++;
        }
      }
      grid[cy * gw + cx] = n ? s / n : 0;
    }
  }
  return grid;
}

/** Sum of absolute differences of a 3x3 patch centred on (cx,cy), A vs B shifted by (ox,oy). */
function patchSad(A: Float32Array, B: Float32Array, gw: number, gh: number, cx: number, cy: number, ox: number, oy: number): number {
  let s = 0;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ax = cx + dx;
      const ay = cy + dy;
      if (ax < 0 || ay < 0 || ax >= gw || ay >= gh) continue;
      const bx = ax + ox;
      const by = ay + oy;
      if (bx < 0 || by < 0 || bx >= gw || by >= gh) return Infinity;
      s += Math.abs(A[ay * gw + ax] - B[by * gw + bx]);
      n++;
    }
  }
  return n ? s / n : Infinity;
}

/** Texture energy of a cell - flat areas have no reliable motion signal. */
function energy(A: Float32Array, gw: number, gh: number, cx: number, cy: number): number {
  const c = A[cy * gw + cx];
  let e = 0;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
      const d = A[y * gw + x] - c;
      e += d * d;
      n++;
    }
  }
  return n ? Math.sqrt(e / n) : 0;
}

interface Level {
  vx: Float32Array;
  vy: Float32Array;
  conf: Float32Array;
  /** This level's own grid size - a coarser level cannot be indexed by a finer one. */
  gw: number;
  gh: number;
}

/** A parabola vertex is only trustworthy within half a cell of its centre. */
function clampHalf(v: number): number {
  return v < -0.5 ? -0.5 : v > 0.5 ? 0.5 : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Local RMS luma variation below which a cell is treated as flat. ~2 code values
 * over a 3x3 cell neighbourhood: invisible texture, so nothing to match against.
 */
const FLAT_EPS = 0.008;

/** Block match one level. `hint` is a prior estimate from a coarser level. */
function matchLevel(A: Float32Array, B: Float32Array, gw: number, gh: number, radius: number, hint: Level | null): Level {
  const vx = new Float32Array(gw * gh);
  const vy = new Float32Array(gw * gh);
  const conf = new Float32Array(gw * gh);
  // Reused across cells; sized for the largest window this level will search.
  let sads = new Float64Array((radius * 2 + 1) * (radius * 2 + 1));
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      const i = cy * gw + cx;
      const e = energy(A, gw, gh, cx, cy);
      let hx = 0;
      let hy = 0;
      if (hint) {
        // Resample the coarse estimate into this level's grid. Cells are not
        // square, so x and y scale independently. Reading hint.vx[i] directly
        // would run off the end of the coarser array and NaN the whole search.
        const hxi = Math.min(hint.gw - 1, Math.max(0, Math.floor(((cx + 0.5) * hint.gw) / gw)));
        const hyi = Math.min(hint.gh - 1, Math.max(0, Math.floor(((cy + 0.5) * hint.gh) / gh)));
        const hi = hyi * hint.gw + hxi;
        hx = Math.round(hint.vx[hi] * (gw / hint.gw));
        hy = Math.round(hint.vy[hi] * (gh / hint.gh));
        if (!Number.isFinite(hx)) hx = 0;
        if (!Number.isFinite(hy)) hy = 0;
      }
      // Evaluate the whole search window once and keep it: both the tie-break
      // and the ambiguity measure below need to look at candidates other than
      // the winner, and re-running the SAD for those doubles the cost.
      const side = radius * 2 + 1;
      if (sads.length < side * side) sads = new Float64Array(side * side);
      let best = Infinity;
      let bx = 0;
      let by = 0;
      for (let oy = -radius; oy <= radius; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
          const s = patchSad(A, B, gw, gh, cx, cy, hx + ox, hy + oy);
          sads[(oy + radius) * side + (ox + radius)] = s;
          if (s < best) {
            best = s;
            bx = hx + ox;
            by = hy + oy;
          }
        }
      }
      // Smallest-displacement tie-break. Repeating texture (fences, brickwork,
      // window grids, and the downsampled coarse level generally) gives a SAD
      // surface with several near-equal minima one pattern period apart. Picking
      // the far one throws the warp out by a whole period, which reads as the
      // surface sliding off the object. Among candidates within a few percent of
      // the best match, take the one closest to the prior.
      if (best < Infinity && (bx - hx) * (bx - hx) + (by - hy) * (by - hy) > 1) {
        const tie = best * 0.06 + 1e-6;
        let bestMag = Infinity;
        for (let oy = -radius; oy <= radius; oy++) {
          for (let ox = -radius; ox <= radius; ox++) {
            const mag = ox * ox + oy * oy;
            if (mag >= bestMag) continue;
            if (sads[(oy + radius) * side + (ox + radius)] <= best + tie) {
              bestMag = mag;
              bx = hx + ox;
              by = hy + oy;
            }
          }
        }
      }
      // Sub-pixel refinement: parabolic vertex through the SAD surface on each
      // axis. Integer-only vectors make the warp step in whole cells, which reads
      // as jitter in exactly the slow-motion shots this exists to smooth.
      let rx = 0;
      let ry = 0;
      let refined = best;
      // A zero (or near-zero) SAD is an exact match - the parabolic vertex is
      // meaningless there and would invent motion out of an asymmetric patch.
      if (best < Infinity && best > 1e-6) {
        const sxm = patchSad(A, B, gw, gh, cx, cy, bx - 1, by);
        const sxp = patchSad(A, B, gw, gh, cx, cy, bx + 1, by);
        const sym = patchSad(A, B, gw, gh, cx, cy, bx, by - 1);
        const syp = patchSad(A, B, gw, gh, cx, cy, bx, by + 1);
        const cx2 = sxm + sxp - 2 * best;
        const cy2 = sym + syp - 2 * best;
        if (isFinite(cx2) && cx2 > 1e-6) {
          rx = clampHalf((sxm - sxp) / (2 * cx2));
          refined -= ((sxm - sxp) * (sxm - sxp)) / (8 * cx2);
        }
        if (isFinite(cy2) && cy2 > 1e-6) {
          ry = clampHalf((sym - syp) / (2 * cy2));
          refined -= ((sym - syp) * (sym - syp)) / (8 * cy2);
        }
        if (!isFinite(refined) || refined < 0) refined = best;
      }
      vx[i] = bx + rx;
      vy[i] = by + ry;

      /*
        Confidence, used by the shader to decide whether to warp or dissolve.

        Two independent signals:

        - match quality: the aligned residual against the patch's own contrast.
          A well-aligned patch leaves almost nothing unexplained.
        - ambiguity: how much worse the best candidate is at two or more cells
          away. Measuring this against the *immediate* neighbour is wrong - when
          true motion falls between two cell centres those two are near-equal by
          construction, and the sub-pixel parabola resolves it perfectly. Only a
          distant near-equal minimum means the match is genuinely uncertain
          (repeating texture).

        Both are gated by texture energy: a flat area has no signal to match, so
        it must not report confidence no matter how clean its residual looks.
      */
      const winX = bx - hx;
      const winY = by - hy;
      let far = Infinity;
      for (let oy = -radius; oy <= radius; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
          const dx = ox - winX;
          const dy = oy - winY;
          if (dx * dx + dy * dy < 4) continue;
          const s = sads[(oy + radius) * side + (ox + radius)];
          if (s < far) far = s;
        }
      }
      // Both terms use the residual at the *refined* offset. Judging the match
      // at the best integer cell instead would score sub-cell motion as a poor
      // match even when the parabola nailed the vector, and the shader would
      // dissolve exactly the frames this exists to interpolate.
      const distinct = far === Infinity ? 0 : clamp01((far - refined) / (far + 1e-6));
      const matchQ = e > 1e-4 ? clamp01(1 - refined / e) : 0;
      // Texture gate: kills genuinely flat regions, which carry no motion signal
      // at all. Deliberately saturates at ~2 code values of local variation -
      // smooth, low-contrast texture still matches perfectly well, and demanding
      // high contrast here would dissolve large parts of a normal, well-exposed
      // frame for no reason.
      conf[i] = clamp01(e / FLAT_EPS) * (0.2 + 0.8 * matchQ) * (0.35 + 0.65 * distinct);
    }
  }
  return { vx, vy, conf, gw, gh };
}

/** 3x3 median filter - removes the isolated bad vectors that cause tearing. */
function median3(v: Float32Array, gw: number, gh: number): Float32Array {
  const out = new Float32Array(gw * gh);
  const buf = new Float64Array(9);
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
          buf[n++] = v[y * gw + x];
        }
      }
      const arr = Array.from(buf.subarray(0, n)).sort((a, b) => a - b);
      out[cy * gw + cx] = arr[arr.length >> 1];
    }
  }
  return out;
}

/**
 * Estimate the flow field from frame A to frame B.
 * Vectors are normalized to the frame: dx * frameWidth = pixels of travel.
 */
export function computeFlow(a: ImageData, b: ImageData, gw: number, gh: number): FlowField {
  const GW = Math.max(8, Math.min(128, Math.floor(gw)));
  const GH = Math.max(8, Math.min(128, Math.floor(gh)));
  const A = toLuma(a, GW, GH);
  const B = toLuma(b, GW, GH);
  // Coarse level at half resolution sees twice the displacement for the same
  // search cost, which is what makes fast pans trackable.
  const cgw = Math.max(4, GW >> 1);
  const cgh = Math.max(4, GH >> 1);
  const CA = toLuma(a, cgw, cgh);
  const CB = toLuma(b, cgw, cgh);
  // Radius 3 at half resolution reaches 3*2 + 2 = 8 fine cells, i.e. ~17% of
  // the frame width of inter-frame travel - far more than real footage needs,
  // while keeping the search from leaping onto a periodic alias.
  const coarse = matchLevel(CA, CB, cgw, cgh, 3, null);
  const fine = matchLevel(A, B, GW, GH, 2, coarse);
  const vx = median3(fine.vx, GW, GH);
  const vy = median3(fine.vy, GW, GH);
  const data = new Float32Array(GW * GH * 4);
  // Encode into the 0..1 range the shader decodes with (rg - 0.5) * 2, so a zero
  // vector is 0.5 and +-1 frame of travel saturates at 0 and 1. Clamping rather
  // than wrapping: motion beyond a full frame is meaningless anyway, and a
  // wrapped value would reverse the warp.
  const enc = (v: number) => {
    const e = v * 0.5 + 0.5;
    return e < 0 ? 0 : e > 1 ? 1 : e;
  };
  for (let i = 0; i < GW * GH; i++) {
    data[i * 4] = enc(vx[i] / GW);
    data[i * 4 + 1] = enc(vy[i] / GH);
    data[i * 4 + 2] = fine.conf[i];
    data[i * 4 + 3] = 1;
  }
  return { gw: GW, gh: GH, data };
}
