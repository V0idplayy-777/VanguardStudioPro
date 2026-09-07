import type { Clip, MediaAsset } from '../../types/project';
import { getMedia } from '../../engine/media/mediaStore';
import { renderGraphic } from '../../engine/graphics/graphicRenderer';
import { settings } from '../../state/settingsStore';

/**
 * Small LRU cache of thumbnail bitmaps used by timeline clips, the project
 * panel and the source monitor scrubber. Keys quantise time to 0.5s to keep
 * the cache small; the timeline draws many frames while zoomed in.
 */
const cache = new Map<string, ImageBitmap | HTMLCanvasElement>();
const pending = new Map<string, Promise<ImageBitmap | HTMLCanvasElement | null>>();
const MAX = 600;

function put(key: string, v: ImageBitmap | HTMLCanvasElement) {
  cache.set(key, v);
  if (cache.size > MAX) {
    const first = cache.keys().next().value as string;
    const old = cache.get(first);
    if (old && 'close' in old) old.close();
    cache.delete(first);
  }
}

export function invalidateThumbnails(assetId?: string) {
  for (const k of [...cache.keys()]) {
    if (!assetId || k.startsWith(assetId + '|')) {
      const v = cache.get(k);
      if (v && 'close' in v) v.close();
      cache.delete(k);
    }
  }
}

export async function thumbnailFor(clip: Clip, asset: MediaAsset | undefined, srcTime: number, w: number, h: number): Promise<ImageBitmap | HTMLCanvasElement | null> {
  const quality = settings().thumbnailQuality;
  if (quality === 'off') {
    // Cheap placeholder instead of decoded frames.
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 2;
    const cx = c.getContext('2d')!;
    cx.fillStyle = '#262626';
    cx.fillRect(0, 0, 2, 2);
    return c;
  }
  const q = Math.max(0, Math.round(srcTime * 2) / 2);
  let bucketH = h <= 32 ? 32 : h <= 64 ? 64 : 128;
  if (quality === 'low') bucketH = Math.min(bucketH, 32);
  const key = `${clip.assetId ?? clip.generator ?? clip.nestedSequenceId ?? 'x'}|${q}|${bucketH}|${clip.generator === 'graphic' ? hashDoc(clip) : ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = pending.get(key);
  if (p) return p;
  const promise = (async () => {
    try {
      const bw = Math.round(bucketH * (w / h));
      if (clip.generator === 'graphic' && clip.graphic) {
        const c = document.createElement('canvas');
        c.width = Math.max(2, bw);
        c.height = bucketH;
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#222';
        ctx.fillRect(0, 0, c.width, c.height);
        const W = asset?.width ?? 1920,
          H = asset?.height ?? 1080;
        ctx.save();
        ctx.scale(c.width / W, c.height / H);
        renderGraphic(ctx, clip.graphic, 0, 30, clip.duration, W, H);
        ctx.restore();
        put(key, c);
        return c;
      }
      if (clip.generator) {
        const c = document.createElement('canvas');
        c.width = Math.max(2, bw);
        c.height = bucketH;
        const ctx = c.getContext('2d')!;
        const col = typeof clip.generatorParams?.color === 'string' ? (clip.generatorParams.color as string) : clip.generator === 'adjustmentLayer' ? '#575757' : '#111';
        ctx.fillStyle = col;
        ctx.fillRect(0, 0, c.width, c.height);
        if (clip.generator === 'barsAndTone') {
          const cols = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
          cols.forEach((cc, i) => {
            ctx.fillStyle = cc;
            ctx.fillRect((i * c.width) / 7, 0, c.width / 7 + 1, c.height);
          });
        }
        put(key, c);
        return c;
      }
      const rec = getMedia(clip.assetId);
      if (!rec) return null;
      await rec.ready;
      if (rec.image) {
        const bmp = await createImageBitmap(rec.image, { resizeHeight: bucketH, resizeWidth: Math.max(2, bw), resizeQuality: 'low' });
        put(key, bmp);
        return bmp;
      }
      if (rec.video) {
        // Random-access seeks here must not re-seq the sequential decode
        // iterator the program monitor plays through — use the scratch session.
        const { getScratchVideo } = await import('../../engine/media/mediaStore');
        const v = (await getScratchVideo(rec).catch(() => null)) ?? rec.video;
        const frame = await v.getFrame(Math.min(Math.max(0, q), Math.max(0, v.duration - 0.05)));
        if (!frame) return null;
        const bmp = await createImageBitmap(frame as any, { resizeHeight: bucketH, resizeWidth: Math.max(2, bw), resizeQuality: 'low' });
        put(key, bmp);
        return bmp;
      }
      return null;
    } catch {
      return null;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, promise);
  return promise;
}

function hashDoc(clip: Clip) {
  const s = JSON.stringify(clip.graphic?.layers.map((l) => [l.id, (l as any).text, l.fill, l.x.value, l.y.value, l.scale.value]));
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

/** Poster frame for the project panel. */
export async function assetPoster(asset: MediaAsset, w: number, h: number, time = 0): Promise<ImageBitmap | HTMLCanvasElement | null> {
  const fake: Clip = { assetId: asset.id, generator: asset.generator, graphic: asset.graphic, generatorParams: asset.generatorParams, duration: 30 } as Clip;
  return thumbnailFor(fake, asset, time, w, h);
}
