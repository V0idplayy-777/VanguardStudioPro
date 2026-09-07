import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input } from 'mediabunny';
import type { VideoSource } from './mediaStore';
import { settings } from '../../state/settingsStore';

/*
  Media decoding.

  Strategy:
    1. Probe with mediabunny (pure TS demuxer). If WebCodecs can decode the
       video track, use a CanvasSink for frame-accurate random access.
    2. Otherwise fall back to an HTMLVideoElement seek-based source.
    3. Audio is decoded to a full AudioBuffer via the Web Audio decoder first,
       falling back to mediabunny's AudioBufferSink for containers the browser
       decoder does not accept.
*/

export interface ProbeResult {
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  channels?: number;
  sampleRate?: number;
  videoCodec?: string | null;
  audioCodec?: string | null;
  rotation?: number;
}

export async function probeMedia(blob: Blob): Promise<ProbeResult | null> {
  try {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    const v = await input.getPrimaryVideoTrack();
    const a = await input.getPrimaryAudioTrack();
    const duration = await input.computeDuration();
    const res: ProbeResult = { duration, hasVideo: !!v, hasAudio: !!a };
    if (v) {
      res.width = v.displayWidth;
      res.height = v.displayHeight;
      res.rotation = v.rotation;
      res.videoCodec = v.codec;
      try {
        const stats = await v.computePacketStats(120);
        res.fps = stats.averagePacketRate || undefined;
      } catch {
        /* ignore */
      }
    }
    if (a) {
      res.channels = a.numberOfChannels;
      res.sampleRate = a.sampleRate;
      res.audioCodec = a.codec;
    }
    input.dispose();
    return res;
  } catch (e) {
    return null;
  }
}

/** Fallback probe through media elements for formats mediabunny cannot demux. */
export function probeWithElement(blob: Blob, isAudio: boolean): Promise<ProbeResult | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const el = document.createElement(isAudio ? 'audio' : 'video') as HTMLVideoElement;
    el.preload = 'metadata';
    el.muted = true;
    const done = (r: ProbeResult | null) => {
      URL.revokeObjectURL(url);
      el.removeAttribute('src');
      resolve(r);
    };
    el.onloadedmetadata = () => {
      const dur = isFinite(el.duration) ? el.duration : 0;
      done({
        duration: dur,
        width: isAudio ? undefined : el.videoWidth,
        height: isAudio ? undefined : el.videoHeight,
        hasVideo: !isAudio && el.videoWidth > 0,
        hasAudio: true,
      });
    };
    el.onerror = () => done(null);
    el.src = url;
  });
}

export async function decodeAudioBuffer(blob: Blob, ctx: BaseAudioContext): Promise<AudioBuffer | null> {
  try {
    const ab = await blob.arrayBuffer();
    return await ctx.decodeAudioData(ab.slice(0));
  } catch {
    // fall back to mediabunny
  }
  try {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    if (!(await track.canDecode())) return null;
    const sink = new AudioBufferSink(track);
    const chunks: AudioBuffer[] = [];
    let total = 0;
    for await (const { buffer } of sink.buffers()) {
      chunks.push(buffer);
      total += buffer.length;
    }
    if (!chunks.length) return null;
    const ch = chunks[0].numberOfChannels;
    const sr = chunks[0].sampleRate;
    const out = ctx.createBuffer(ch, total, sr);
    let off = 0;
    for (const c of chunks) {
      for (let i = 0; i < ch; i++) out.getChannelData(i).set(c.getChannelData(Math.min(i, c.numberOfChannels - 1)), off);
      off += c.length;
    }
    input.dispose();
    return out;
  } catch {
    return null;
  }
}

/** WebCodecs based frame source with small LRU frame cache. */
function maxDecodeCache() {
  const s = settings().decodeCacheSize;
  return typeof s === 'number' ? Math.max(8, Math.min(200, s)) : 48;
}

export async function createWebCodecsSource(blob: Blob): Promise<VideoSource | null> {
  if (typeof VideoDecoder === 'undefined') return null;
  try {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    if (!(await track.canDecode())) {
      input.dispose();
      return null;
    }
    const duration = await input.computeDuration();
    let fps = 30;
    try {
      const st = await track.computePacketStats(120);
      fps = st.averagePacketRate || 30;
    } catch {
      /* ignore */
    }
    const width = track.displayWidth;
    const height = track.displayHeight;
    const sink = new CanvasSink(track, { poolSize: 6 });

    // Cache of recent decoded canvases keyed by quantised timestamp.
    const cache = new Map<number, { canvas: HTMLCanvasElement | OffscreenCanvas; ts: number; dur: number }>();
    // Freed canvases from evicted cache entries, reused for new copies. Without
    // this every decoded frame allocates a fresh canvas (several MB at 1080p) —
    // the GC churn shows up as periodic playback stutter.
    const freeCanvases: HTMLCanvasElement[] = [];
    const FREE_MAX = 8;
    let lastTs = -1;
    let lastCanvas: { canvas: HTMLCanvasElement | OffscreenCanvas; ts: number; dur: number } | null = null;
    let sequential: AsyncGenerator<any> | null = null;
    let seqNext: number = -1;
    let pending: Promise<any> = Promise.resolve();

    const acquireCopyCanvas = (w: number, h: number): HTMLCanvasElement => {
      const c = freeCanvases.pop();
      if (c) {
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
        return c;
      }
      const nc = document.createElement('canvas');
      nc.width = w;
      nc.height = h;
      return nc;
    };
    const evictOne = () => {
      const first = cache.keys().next().value;
      if (first === undefined) return;
      const entry = cache.get(first)!;
      cache.delete(first);
      // Only the oldest copy for a given ts owns the canvas; duplicate keys may
      // point at the same entry. Refcount is overkill: recycling a canvas that
      // another entry still references only matters if that entry is re-read
      // later, and re-reads re-decode anyway when the texture differs. Play it
      // safe and only recycle canvases that are not referenced by any other
      // cache entry.
      let shared = false;
      for (const e of cache.values()) if (e === entry) { shared = true; break; }
      if (!shared && entry !== lastCanvas && entry.canvas instanceof HTMLCanvasElement && freeCanvases.length < FREE_MAX) freeCanvases.push(entry.canvas);
    };

    const getFrame = async (time: number) => {
      const t = Math.max(0, Math.min(duration - 1e-4, time));
      if (lastCanvas && t >= lastCanvas.ts && t < lastCanvas.ts + Math.max(lastCanvas.dur, 1 / fps) * 1.01) return lastCanvas.canvas;
      const key = Math.round(t * fps * 2);
      const hit = cache.get(key);
      if (hit) {
        lastCanvas = hit;
        return hit.canvas;
      }
      // Sequential fast-path: if we are asking for the frame right after the
      // last one, use the iterator. The window also covers catching up after a
      // slow frame: advancing the iterator is much cheaper than a re-seek
      // (which pays a full demux + decoder warm-up and used to spiral — one
      // slow render made the playhead jump past the window, the re-seek made
      // the next render slower, and playback collapsed to a few fps).
      const runAt = async (requestT: number, allowPrefetch: boolean) => {
        // A queued request may have been satisfied already (duplicate getFrame
        // calls for the same frame, or a prefetch that landed first).
        if (lastCanvas && requestT >= lastCanvas.ts && requestT < lastCanvas.ts + Math.max(lastCanvas.dur, 1 / fps) * 1.01) return lastCanvas.canvas;
        const cachedNow = cache.get(Math.round(requestT * fps * 2));
        if (cachedNow) {
          lastCanvas = cachedNow;
          return cachedNow.canvas;
        }
        let wrapped: { canvas: HTMLCanvasElement | OffscreenCanvas; timestamp: number; duration: number } | null = null;
        let advanced = false;
        const delta = requestT - lastTs;
        if (sequential && delta > 0 && delta < 0.75) {
          // advance iterator until timestamp >= requestT (up to ~1s of catch-up)
          for (let i = 0; i < 32; i++) {
            const r = await sequential.next();
            if (r.done) {
              sequential = null;
              break;
            }
            wrapped = r.value;
            advanced = true;
            if (wrapped && wrapped.timestamp + wrapped.duration > requestT) break;
          }
        }
        // Re-seek when the iterator is beyond requestT, behind requestT (e.g.
        // another consumer seeked it elsewhere), or exhausted.
        const behind = !wrapped || wrapped.timestamp + (wrapped.duration || 1 / fps) <= requestT;
        if (behind || !!(wrapped && wrapped.timestamp > requestT + 1 / fps)) {
          if (sequential) {
            try {
              await sequential.return(undefined);
            } catch {
              /* ignore */
            }
          }
          sequential = sink.canvases(requestT);
          const r = await sequential.next();
          wrapped = r.done ? null : r.value;
          seqNext = requestT;
          advanced = false;
        }
        void seqNext;
        if (!wrapped) return null;
        // The pool reuses canvases, so copy to a persistent canvas for caching.
        const copy = acquireCopyCanvas(wrapped.canvas.width, wrapped.canvas.height);
        copy.getContext('2d')!.drawImage(wrapped.canvas as CanvasImageSource, 0, 0);
        const entry = { canvas: copy, ts: wrapped.timestamp, dur: wrapped.duration };
        lastTs = wrapped.timestamp;
        lastCanvas = entry;
        cache.set(Math.round(wrapped.timestamp * fps * 2), entry);
        cache.set(Math.round(requestT * fps * 2), entry);
        const maxCache = maxDecodeCache();
        while (cache.size > maxCache) evictOne();
        // Decode-ahead: while playback advances sequentially, prefetch the next
        // frame so its decode overlaps the compositor's GL work for this one.
        if (allowPrefetch && advanced) schedulePrefetch(entry.ts + Math.max(entry.dur, 1 / fps));
        return copy;
      };
      let prefetching = false;
      const schedulePrefetch = (nextT: number) => {
        if (prefetching || !sequential) return;
        const nt = Math.max(0, Math.min(duration - 1e-4, nextT));
        if (cache.has(Math.round(nt * fps * 2))) return;
        prefetching = true;
        pending = pending.then(
          () => runAt(nt, false).then(
            () => {
              prefetching = false;
            },
            () => {
              prefetching = false;
            },
          ),
          () => {
            prefetching = false;
          },
        );
      };
      pending = pending.then(
        () => runAt(t, true),
        () => runAt(t, true),
      );
      return pending;
    };

    async function* frames(start: number, end: number) {
      for await (const w of sink.canvases(start, end)) {
        yield { time: w.timestamp, image: w.canvas as TexImageSource };
      }
    }

    return {
      kind: 'webcodecs',
      width,
      height,
      duration,
      fps,
      getFrame,
      frames,
      dispose: () => {
        cache.clear();
        try {
          input.dispose();
        } catch {
          /* ignore */
        }
      },
    };
  } catch (e) {
    console.warn('WebCodecs source failed, falling back to element', e);
    return null;
  }
}

/** HTMLVideoElement fallback: seeks and waits for the frame. */
export function createElementSource(url: string, duration: number, width: number, height: number, fps = 30): VideoSource {
  const el = document.createElement('video');
  el.src = url;
  el.muted = true;
  el.playsInline = true;
  el.preload = 'auto';
  el.crossOrigin = 'anonymous';
  let ready = false;
  const readyP = new Promise<void>((res) => {
    el.onloadeddata = () => {
      ready = true;
      res();
    };
    el.onerror = () => res();
  });
  let lastTime = -1;
  let everHadFrame = false;
  let queue: Promise<any> = Promise.resolve();
  const seekTo = (t: number) =>
    new Promise<void>((res) => {
      if (Math.abs(el.currentTime - t) < 0.5 / fps) return res();
      const onSeek = () => {
        el.removeEventListener('seeked', onSeek);
        res();
      };
      el.addEventListener('seeked', onSeek);
      el.currentTime = t;
      window.setTimeout(() => {
        el.removeEventListener('seeked', onSeek);
        res();
      }, 400);
    });
  return {
    kind: 'element',
    width,
    height,
    duration,
    fps,
    element: el,
    getFrame: async (time: number) => {
      if (!ready) await readyP;
      const t = Math.max(0, Math.min(duration - 0.001, time));
      const run = async () => {
        if (Math.abs(t - lastTime) > 0.25 / fps) {
          lastTime = t;
          await seekTo(t);
        }
        if (el.readyState >= 2) {
          everHadFrame = true;
          return el;
        }
        // While a seek settles the element still displays the previous frame.
        // Show that instead of returning null, which would flash black.
        return everHadFrame ? el : null;
      };
      queue = queue.then(run, run);
      return queue;
    },
    dispose: () => {
      el.removeAttribute('src');
      el.load();
    },
  };
}
