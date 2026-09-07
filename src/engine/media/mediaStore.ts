import type { Id, MediaAsset } from '../../types/project';

/*
  In-memory store of file handles / blobs for imported media. Project JSON only
  stores asset metadata; the binary data lives here (and optionally in IndexedDB
  so a page reload can relink automatically).
*/

export interface MediaRecord {
  assetId: Id;
  blob: Blob;
  url: string;
  /** Decoded still image for image assets. */
  image?: ImageBitmap;
  /** Decoded full audio buffer (mono/stereo) for waveform + playback. */
  audio?: AudioBuffer;
  /** Waveform peaks per channel at PEAK_RES samples per second. */
  peaks?: Float32Array[];
  /** Video frame source. */
  video?: VideoSource;
  /** Independent decode session for random-access consumers (thumbnails,
   *  source monitor, analysis) so their seeks never re-seek the sequential
   *  iterator the program monitor plays through. */
  scratchVideo?: VideoSource;
  scratchVideoPromise?: Promise<VideoSource | null> | null;
  /** Error if decoding failed. */
  error?: string;
  ready: Promise<void>;
  resolveReady: () => void;
}

export interface VideoSource {
  width: number;
  height: number;
  duration: number;
  fps: number;
  /** Get a frame at time (seconds). Returns an image source usable as a texture. */
  getFrame(time: number): Promise<TexImageSource | VideoFrame | null>;
  /** Sequential iteration for export. */
  frames?(start: number, end: number): AsyncGenerator<{ time: number; image: TexImageSource | VideoFrame }>;
  /** The <video> element when using element-based decoding. */
  element?: HTMLVideoElement;
  kind: 'webcodecs' | 'element';
  dispose(): void;
}

export const PEAK_RES = 200;

const records = new Map<Id, MediaRecord>();
const listeners = new Set<() => void>();

export function onMediaChange(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function emit() {
  for (const l of listeners) l();
}

export function getMedia(assetId: Id | null | undefined): MediaRecord | undefined {
  if (!assetId) return undefined;
  return records.get(assetId);
}

export function hasMedia(assetId: Id) {
  return records.has(assetId);
}

export function registerMedia(assetId: Id, blob: Blob): MediaRecord {
  const existing = records.get(assetId);
  if (existing) return existing;
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));
  const rec: MediaRecord = { assetId, blob, url: URL.createObjectURL(blob), ready, resolveReady };
  records.set(assetId, rec);
  emit();
  return rec;
}

export function updateMedia(assetId: Id, patch: Partial<MediaRecord>) {
  const rec = records.get(assetId);
  if (!rec) return;
  Object.assign(rec, patch);
  emit();
}

export function removeMedia(assetId: Id) {
  const rec = records.get(assetId);
  if (!rec) return;
  URL.revokeObjectURL(rec.url);
  rec.video?.dispose();
  rec.scratchVideo?.dispose();
  rec.image?.close?.();
  records.delete(assetId);
  emit();
}

/**
 * Random-access decode session, separate from the playback source.
 *
 * Timeline thumbnails, the source monitor and analysis passes seek all over
 * the file; each far seek invalidates the sequential decode iterator that
 * program-monitor playback relies on (a re-seek costs a full demux+decode
 * warm-up and stalls the next playback frame behind it). Consumers that jump
 * around should use this independent session instead.
 */
export async function getScratchVideo(rec: MediaRecord): Promise<VideoSource | null> {
  if (!rec.video) return null;
  // Element sources seek on their own <video>; sharing is fine and cheap.
  if (rec.video.kind === 'element') return rec.video;
  if (rec.scratchVideo) return rec.scratchVideo;
  if (!rec.scratchVideoPromise) {
    rec.scratchVideoPromise = (async () => {
      const { createWebCodecsSource, createElementSource } = await import('./decoder');
      const wc = await createWebCodecsSource(rec.blob);
      const src = wc ?? createElementSource(rec.url, rec.video!.duration, rec.video!.width, rec.video!.height, rec.video!.fps);
      rec.scratchVideo = src;
      return src;
    })().catch(() => null);
  }
  return rec.scratchVideoPromise;
}

export function allMedia(): MediaRecord[] {
  return [...records.values()];
}

export function computePeaks(buffer: AudioBuffer, res = PEAK_RES): Float32Array[] {
  const out: Float32Array[] = [];
  const spp = Math.max(1, Math.floor(buffer.sampleRate / res));
  for (let ch = 0; ch < Math.min(2, buffer.numberOfChannels); ch++) {
    const data = buffer.getChannelData(ch);
    const n = Math.ceil(data.length / spp);
    const peaks = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      let mn = 1,
        mx = -1;
      const s = i * spp,
        e = Math.min(data.length, s + spp);
      for (let j = s; j < e; j++) {
        const v = data[j];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      peaks[i * 2] = mn;
      peaks[i * 2 + 1] = mx;
    }
    out.push(peaks);
  }
  return out;
}

export function isVideoAsset(a: MediaAsset) {
  return a.kind === 'video';
}
