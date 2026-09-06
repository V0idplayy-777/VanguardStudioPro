import type { Interpolation, Keyframe, Param, ParamValue } from '../types/project';

/* ---------- easing ---------- */

function easeIn(t: number) {
  return t * t * t;
}
function easeOut(t: number) {
  const u = 1 - t;
  return 1 - u * u * u;
}
function easeInOut(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Cubic bezier on the unit square with control points (x1,y1),(x2,y2). Solves for y at x. */
export function cubicBezierY(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Newton-Raphson on x(t) = x
  let t = x;
  for (let i = 0; i < 8; i++) {
    const mt = 1 - t;
    const xt = 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t;
    const dxt = 3 * mt * mt * x1 + 6 * mt * t * (x2 - x1) + 3 * t * t * (1 - x2);
    if (Math.abs(dxt) < 1e-6) break;
    const nt = t - (xt - x) / dxt;
    if (Math.abs(nt - t) < 1e-6) {
      t = nt;
      break;
    }
    t = Math.min(1, Math.max(0, nt));
  }
  const mt = 1 - t;
  return 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t;
}

export function applyInterp(interp: Interpolation, t: number, k?: Keyframe<any>): number {
  switch (interp) {
    case 'hold':
      return 0;
    case 'easeIn':
      return easeIn(t);
    case 'easeOut':
      return easeOut(t);
    case 'easeInOut':
      return easeInOut(t);
    case 'bezier': {
      const b = k?.bezier ?? { inX: 0.33, inY: 0, outX: 0.67, outY: 1 };
      return cubicBezierY(b.inX, b.inY, b.outX, b.outY, t);
    }
    default:
      return t;
  }
}

function mixValue(a: ParamValue, b: ParamValue, f: number): ParamValue {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * f;
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: number[] = [];
    for (let i = 0; i < a.length; i++) out.push((a[i] as number) + ((b[i] as number) - (a[i] as number)) * f);
    return out as any;
  }
  if (typeof a === 'boolean') return f < 1 ? a : b;
  return f < 1 ? a : b;
}

/** Evaluate a param at a clip-relative frame. */
export function evalParam<T extends ParamValue>(p: Param<T>, frame: number): T {
  const kfs = p.keyframes;
  if (!p.animated || !kfs || kfs.length === 0) return p.value;
  if (kfs.length === 1) return kfs[0].v;
  if (frame <= kfs[0].t) return kfs[0].v;
  const last = kfs[kfs.length - 1];
  if (frame >= last.t) return last.v;
  // binary search
  let lo = 0,
    hi = kfs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid].t <= frame) lo = mid;
    else hi = mid;
  }
  const a = kfs[lo],
    b = kfs[hi];
  if (b.t === a.t) return b.v;
  const raw = (frame - a.t) / (b.t - a.t);
  const f = applyInterp(a.interp, raw, a);
  return mixValue(a.v, b.v, f) as T;
}

export function evalNumber(p: Param<number>, frame: number): number {
  return evalParam(p, frame);
}

/** Insert or replace a keyframe at frame. Returns a new param object. */
export function setKeyframe<T extends ParamValue>(p: Param<T>, frame: number, value: T, interp?: Interpolation): Param<T> {
  const kfs = [...(p.keyframes ?? [])];
  const idx = kfs.findIndex((k) => k.t === frame);
  if (idx >= 0) {
    kfs[idx] = { ...kfs[idx], v: value, interp: interp ?? kfs[idx].interp };
  } else {
    kfs.push({ t: frame, v: value, interp: interp ?? 'linear' });
    kfs.sort((a, b) => a.t - b.t);
  }
  return { ...p, keyframes: kfs, animated: true, value };
}

export function removeKeyframe<T extends ParamValue>(p: Param<T>, frame: number): Param<T> {
  const kfs = (p.keyframes ?? []).filter((k) => k.t !== frame);
  return { ...p, keyframes: kfs, animated: p.animated && kfs.length > 0, value: kfs.length ? evalParam({ ...p, keyframes: kfs }, frame) : p.value };
}

export function hasKeyframeAt(p: Param<any>, frame: number): boolean {
  return !!p.animated && !!p.keyframes?.some((k) => k.t === frame);
}

export function nearestKeyframes(p: Param<any>, frame: number): { prev: Keyframe | null; next: Keyframe | null } {
  const kfs = p.keyframes ?? [];
  let prev: Keyframe | null = null,
    next: Keyframe | null = null;
  for (const k of kfs) {
    if (k.t < frame) prev = k;
    else if (k.t > frame) {
      next = k;
      break;
    }
  }
  return { prev, next };
}

/** Set value at frame: if animated adds/updates a keyframe, otherwise sets the static value. */
export function writeParam<T extends ParamValue>(p: Param<T>, frame: number, value: T): Param<T> {
  if (p.animated) return setKeyframe(p, frame, value);
  return { ...p, value };
}

export function toggleAnimated<T extends ParamValue>(p: Param<T>, frame: number): Param<T> {
  if (p.animated) {
    // Freeze current value and drop keyframes.
    const v = evalParam(p, frame);
    return { value: v, animated: false, keyframes: [] };
  }
  return { value: p.value, animated: true, keyframes: [{ t: frame, v: p.value, interp: 'linear' }] };
}

export function shiftKeyframes<T extends ParamValue>(p: Param<T>, delta: number): Param<T> {
  if (!p.keyframes) return p;
  return { ...p, keyframes: p.keyframes.map((k) => ({ ...k, t: k.t + delta })) };
}

export function scaleKeyframes<T extends ParamValue>(p: Param<T>, factor: number): Param<T> {
  if (!p.keyframes) return p;
  return { ...p, keyframes: p.keyframes.map((k) => ({ ...k, t: Math.round(k.t * factor) })) };
}

export function setKeyframeInterp<T extends ParamValue>(p: Param<T>, frame: number, interp: Interpolation): Param<T> {
  if (!p.keyframes) return p;
  return { ...p, keyframes: p.keyframes.map((k) => (k.t === frame ? { ...k, interp } : k)) };
}

export function keyframeTimes(params: Record<string, Param>): number[] {
  const set = new Set<number>();
  for (const p of Object.values(params)) if (p.animated) for (const k of p.keyframes ?? []) set.add(k.t);
  return [...set].sort((a, b) => a - b);
}
