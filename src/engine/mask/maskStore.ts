import { kvGet, kvSet, maskKvKey, kvDel } from '../media/mediaDb';

/*
  Magic Mask matte storage.

  Each analyzed clip owns a MaskTrack: a header (clip/asset geometry) plus
  low-resolution (<=96px) per-keyframe alpha mattes stored RLE-compressed in
  IndexedDB. Keyframes are decoded on demand and interpolated in-memory, so a
  10s 24fps analysis costs ~3-4 MB instead of ~90 MB.
*/

export const MASK_MAX_DIM = 96;

export interface MaskTrackHeader {
  id: string;
  clipId: string;
  assetId: string | null;
  /** Clip-local frame range covered. */
  startLocal: number;
  endLocal: number;
  fps: number;
  /** Matte resolution. */
  width: number;
  height: number;
  /** Sorted local frames that have stored keyframes. */
  keys: number[];
  /** Person / class labels per keyframe group (index-aligned with keys when present). */
  labels?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MaskSample {
  width: number;
  height: number;
  /** Alpha 0..255, row-major. */
  alpha: Uint8Array;
}

interface KeyPayload {
  w: number;
  h: number;
  rle: string; // base64 of RLE bytes
}

/** RLE over the alpha plane: [value, runLo, runHi] triples. */
export function encodeRle(alpha: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < alpha.length) {
    const v = alpha[i];
    let run = 1;
    while (i + run < alpha.length && alpha[i + run] === v && run < 65535) run++;
    out.push(v, run & 0xff, (run >> 8) & 0xff);
    i += run;
  }
  return Uint8Array.from(out);
}

export function decodeRle(rle: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let o = 0;
  for (let i = 0; i + 2 < rle.length + 1 && o < expected; i += 3) {
    const v = rle[i];
    const run = rle[i + 1] | (rle[i + 2] << 8);
    out.fill(v, o, Math.min(expected, o + run));
    o += run;
  }
  return out;
}

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- persistence ---------- */

export async function saveMaskHeader(h: MaskTrackHeader): Promise<void> {
  await kvSet(maskKvKey(h.id), h);
}

export async function loadMaskHeader(trackId: string): Promise<MaskTrackHeader | undefined> {
  return kvGet<MaskTrackHeader>(maskKvKey(trackId));
}

export async function saveMaskKey(trackId: string, localFrame: number, sample: MaskSample): Promise<void> {
  const rle = encodeRle(sample.alpha);
  const payload: KeyPayload = { w: sample.width, h: sample.height, rle: b64encode(rle) };
  await kvSet(maskKvKey(trackId, localFrame), payload);
}

async function loadMaskKey(trackId: string, localFrame: number): Promise<MaskSample | null> {
  const payload = await kvGet<KeyPayload>(maskKvKey(trackId, localFrame));
  if (!payload) return null;
  const expected = payload.w * payload.h;
  return { width: payload.w, height: payload.h, alpha: decodeRle(b64decode(payload.rle), expected) };
}

export async function deleteMaskTrack(trackId: string): Promise<void> {
  const header = await loadMaskHeader(trackId).catch(() => undefined);
  if (header) {
    for (const k of header.keys) await kvDel(maskKvKey(trackId, k)).catch(() => undefined);
  }
  await kvDel(maskKvKey(trackId)).catch(() => undefined);
  keyCache.clear();
  headerCache.delete(trackId);
}

/** All known track ids that still have headers (for the manager UI). */
export async function listMaskTrackIds(): Promise<string[]> {
  // kv store has no key enumeration helper; tracks are referenced from
  // effect instances, so callers pass ids they discover in the document.
  return [];
}

/* ---------- in-memory interpolation ---------- */

const headerCache = new Map<string, MaskTrackHeader>();
const keyCache = new Map<string, MaskSample>(); // `${trackId}:${frame}`

async function header(trackId: string): Promise<MaskTrackHeader | null> {
  let h = headerCache.get(trackId);
  if (!h) {
    h = (await loadMaskHeader(trackId).catch(() => undefined)) ?? undefined;
    if (h) headerCache.set(trackId, h);
  }
  return h ?? null;
}

async function key(trackId: string, frame: number): Promise<MaskSample | null> {
  const ck = `${trackId}:${frame}`;
  let s = keyCache.get(ck);
  if (!s) {
    s = (await loadMaskKey(trackId, frame).catch(() => null)) ?? undefined;
    if (s) {
      if (keyCache.size > 48) keyCache.clear();
      keyCache.set(ck, s);
    }
  }
  return s ?? null;
}

/**
 * Matte for a clip-local frame. Exact keyframes are returned as-is;
 * in-between frames are a per-pixel blend of the bracketing keys.
 */
export async function getMaskSample(trackId: string, localFrame: number): Promise<MaskSample | null> {
  const h = await header(trackId);
  if (!h || !h.keys.length) return null;
  const f = Math.round(localFrame);
  if (f <= h.keys[0]) return key(trackId, h.keys[0]);
  const last = h.keys[h.keys.length - 1];
  if (f >= last) return key(trackId, last);
  let i = 0;
  while (i < h.keys.length - 2 && h.keys[i + 1] < f) i++;
  const k0 = h.keys[i],
    k1 = h.keys[i + 1];
  if (k0 === f) return key(trackId, k0);
  if (k1 === f) return key(trackId, k1);
  const [s0, s1] = await Promise.all([key(trackId, k0), key(trackId, k1)]);
  if (!s0) return s1;
  if (!s1) return s0;
  const t = (f - k0) / Math.max(1, k1 - k0);
  const w = Math.min(s0.width, s1.width),
    hh = Math.min(s0.height, s1.height);
  const out = new Uint8Array(w * hh);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const a = s0.alpha[y * s0.width + x],
        b = s1.alpha[y * s1.width + x];
      out[y * w + x] = a + (b - a) * t;
    }
  }
  return { width: w, height: hh, alpha: out };
}

/** Synchronous cache probe for the render hot path (null = not loaded yet). */
export function peekMaskSample(trackId: string, localFrame: number): MaskSample | null {
  const h = headerCache.get(trackId);
  if (!h || !h.keys.length) return null;
  const f = Math.round(localFrame);
  // nearest cached key at or around f
  let best = -1,
    bestDist = Infinity;
  for (const k of h.keys) {
    if (!keyCache.has(`${trackId}:${k}`)) continue;
    const d = Math.abs(k - f);
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  if (best < 0) return null;
  return keyCache.get(`${trackId}:${best}`) ?? null;
}

/** Warm the cache around a frame (called on seek / before playback). */
export function prefetchMask(trackId: string, localFrame: number) {
  void getMaskSample(trackId, localFrame).catch(() => null);
}

/** Delete a removed effect's matte track, if it had one. Safe to call for any effect. */
export function cleanupRemovedEffect(fx: { type: string; data?: Record<string, string | number | boolean> }) {
  if (fx.type === 'magicMask' && typeof fx.data?.trackId === 'string') {
    const t = fx.data.trackId;
    dropMaskCache(t);
    void deleteMaskTrack(t).catch(() => undefined);
  }
}

export function dropMaskCache(trackId?: string) {
  if (trackId) {
    headerCache.delete(trackId);
    for (const k of [...keyCache.keys()]) if (k.startsWith(trackId + ':')) keyCache.delete(k);
  } else {
    headerCache.clear();
    keyCache.clear();
  }
}
