import { toast } from '../../state/uiStore';
import { findAsset, useProject } from '../../state/projectStore';
import { getMedia, getScratchVideo } from '../media/mediaStore';
import { sourceTimeAt, clipEnd } from '../timeline/edits';
import { uid } from '../util';
import { MASK_MAX_DIM, saveMaskHeader, saveMaskKey, type MaskTrackHeader } from './maskStore';

/*
  Magic Mask: AI person segmentation ("rotoscope without a green screen").

  Analysis runs MediaPipe's selfie-multiclass model (loaded from a CDN on
  first use, then cached by the browser) over clip keyframes in a worker-free
  async loop. Each keyframe's person matte is downscaled to <=96px, RLE
  compressed and stored in IndexedDB; the compositor uploads the bracketing
  keys as the `u_matte` texture for the `magicMask` effect.

  Everything is optional and honest: if the model cannot load (offline,
  blocked CDN, WebGL delegate failure) the dialog says so and suggests the
  Ultra Key chroma workflow instead.
*/

const VISION_VERSION = '0.10.14';
const VISION_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite';

/** Minimal structural types for the tasks-vision bundle (loaded dynamically). */
interface VisionMask {
  width: number;
  height: number;
  getAsFloat32Array(): Float32Array;
  close(): void;
}
interface VisionSegmenter {
  segmentForVideo(image: CanvasImageSource, timestampMs: number): { confidenceMasks?: VisionMask[] } | undefined;
  close(): void;
}

let segmenterPromise: Promise<VisionSegmenter> | null = null;
let segmenterFailed = '';

export type SegmenterStatus = 'idle' | 'loading' | 'ready' | 'error';

export function segmenterStatus(): SegmenterStatus {
  if (segmenterFailed) return 'error';
  if (!segmenterPromise) return 'idle';
  return 'loading';
}

export function segmenterError(): string {
  return segmenterFailed;
}

async function loadVision(): Promise<any> {
  // Native dynamic import of the ESM bundle; @vite-ignore keeps Vite from
  // trying to resolve the URL at build time.
  return import(/* @vite-ignore */ `${VISION_CDN}/vision_bundle.mjs`);
}

export function ensureSegmenter(onProgress?: (msg: string) => void): Promise<VisionSegmenter> {
  if (segmenterPromise) return segmenterPromise;
  segmenterFailed = '';
  segmenterPromise = (async () => {
    try {
      onProgress?.('Downloading AI model…');
      const vision = await loadVision();
      onProgress?.('Starting vision runtime…');
      const fileset = await vision.FilesetResolver.forVisionTasks(`${VISION_CDN}/wasm`);
      const delegates: Array<'GPU' | 'CPU'> = ['GPU', 'CPU'];
      let lastErr: unknown = null;
      for (const delegate of delegates) {
        try {
          const seg = (await vision.ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: MODEL_URL, delegate },
            runningMode: 'VIDEO',
            outputCategoryMask: false,
            outputConfidenceMasks: true,
          })) as VisionSegmenter;
          return seg;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error('Could not start the segmentation model.');
    } catch (e) {
      segmenterFailed = e instanceof Error ? e.message : String(e);
      segmenterPromise = null;
      throw e;
    }
  })();
  return segmenterPromise;
}

export interface AnalyzeOptions {
  sequenceId: string;
  clipId: string;
  /** Analyze every Nth frame (default 3). */
  step?: number;
  /** Local-frame range override (defaults to the whole clip). */
  fromLocal?: number;
  toLocal?: number;
  onProgress?: (done: number, total: number, phase: string) => void;
  isCancelled?: () => boolean;
}

export interface AnalyzeResult {
  trackId: string;
  keys: number[];
}

/** Combine all non-background class masks into one person probability plane. */
function personPlane(masks: VisionMask[] | undefined): { w: number; h: number; prob: Float32Array } | null {
  if (!masks || masks.length < 2) return null;
  const w = masks[1].width,
    h = masks[1].height;
  const prob = new Float32Array(w * h);
  // Class 0 is background; every other class is part of a person.
  for (let c = 1; c < masks.length; c++) {
    const m = masks[c];
    if (m.width !== w || m.height !== h) continue;
    const arr = m.getAsFloat32Array();
    for (let i = 0; i < prob.length; i++) if (arr[i] > prob[i]) prob[i] = arr[i];
  }
  return { w, h, prob };
}

function planeToAlpha(prob: Float32Array, w: number, h: number): { width: number; height: number; alpha: Uint8Array } {
  const scale = Math.min(1, MASK_MAX_DIM / Math.max(w, h));
  const tw = Math.max(8, Math.round(w * scale)),
    th = Math.max(8, Math.round(h * scale));
  const alpha = new Uint8Array(tw * th);
  // Area-sample with a soft threshold: <0.35 transparent, >0.65 solid.
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(w - 1, Math.floor(((x + 0.5) / tw) * w));
      const sy = Math.min(h - 1, Math.floor(((y + 0.5) / th) * h));
      const p = prob[sy * w + sx];
      const t = Math.max(0, Math.min(1, (p - 0.35) / 0.3));
      alpha[y * tw + x] = Math.round(t * 255);
    }
  }
  return { width: tw, height: th, alpha };
}

/**
 * Analyze a clip and store its matte track. Attaches a `magicMask` effect
 * (fx.data.trackId) to the clip in one undo step when finished.
 */
export async function analyzeClip(opts: AnalyzeOptions): Promise<AnalyzeResult | null> {
  const { sequenceId, clipId } = opts;
  const step = Math.max(1, Math.min(30, opts.step ?? 3));
  const project = useProject.getState().project;
  const seq = project.sequences.find((s) => s.id === sequenceId);
  const clip = seq?.clips.find((c) => c.id === clipId);
  if (!seq || !clip) {
    toast('error', 'Magic Mask', 'Clip not found.');
    return null;
  }
  const asset = clip.assetId ? findAsset(project, clip.assetId) ?? undefined : undefined;
  const rec = clip.assetId ? getMedia(clip.assetId) : undefined;
  if (!rec?.video) {
    toast('warning', 'Magic Mask', 'The clip media is not decoded yet. Try again in a moment.');
    return null;
  }
  const fps = seq.settings.fps;
  const fromLocal = Math.max(0, opts.fromLocal ?? 0);
  const toLocal = Math.min(clip.duration - 1, opts.toLocal ?? clip.duration - 1);
  const frames: number[] = [];
  for (let f = fromLocal; f <= toLocal; f += step) frames.push(f);
  if (!frames.includes(toLocal)) frames.push(toLocal);
  if (!frames.length) return null;

  opts.onProgress?.(0, frames.length, 'Loading AI model…');
  let segmenter: VisionSegmenter;
  try {
    segmenter = await ensureSegmenter((msg) => opts.onProgress?.(0, frames.length, msg));
  } catch (e) {
    toast('error', 'Magic Mask unavailable', 'The AI model could not be loaded. Check your connection and try again — or use Ultra Key for green screens.');
    return null;
  }
  const scratch = await getScratchVideo(rec);
  if (!scratch) {
    toast('error', 'Magic Mask', 'Could not open the clip for analysis.');
    return null;
  }
  const trackId = uid('mask');
  const header: MaskTrackHeader = {
    id: trackId,
    clipId,
    assetId: clip.assetId,
    startLocal: fromLocal,
    endLocal: toLocal,
    fps,
    width: 0,
    height: 0,
    keys: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const keys: number[] = [];
  try {
    for (let i = 0; i < frames.length; i++) {
      if (opts.isCancelled?.()) {
        toast('info', 'Magic Mask', 'Analysis cancelled.');
        return null;
      }
      const local = frames[i];
      opts.onProgress?.(i, frames.length, `Analyzing frame ${local + 1}/${clip.duration}…`);
      const srcTime = sourceTimeAt(clip, clip.start + local, fps);
      const img = await scratch.getFrame(srcTime);
      if (!img) continue;
      let bitmap: ImageBitmap | null = null;
      try {
        bitmap = await createImageBitmap(img as ImageBitmapSource);
      } catch {
        continue;
      }
      try {
        const res = segmenter.segmentForVideo(bitmap, Math.round(srcTime * 1000));
        const plane = personPlane(res?.confidenceMasks);
        res?.confidenceMasks?.forEach((m) => {
          try {
            m.close();
          } catch {
            /* ignore */
          }
        });
        if (!plane) continue;
        const sample = planeToAlpha(plane.prob, plane.w, plane.h);
        if (!header.width) {
          header.width = sample.width;
          header.height = sample.height;
        }
        await saveMaskKey(trackId, local, sample);
        keys.push(local);
      } finally {
        bitmap.close();
      }
      // Yield so progress paints and cancel stays responsive.
      await new Promise((r) => setTimeout(r, 0));
    }
  } catch (e) {
    toast('error', 'Magic Mask failed', e instanceof Error ? e.message : String(e));
    return null;
  }
  if (!keys.length) {
    toast('warning', 'Magic Mask', 'No people were found in this clip. The AI mask only isolates people — for objects, use Ultra Key or a tracked mask.');
    return null;
  }
  header.keys = keys;
  header.updatedAt = Date.now();
  await saveMaskHeader(header);
  // Attach the effect in one undo step.
  const { EFFECT_MAP, defaultEffectParams } = await import('../effects/registry');
  const def = EFFECT_MAP['magicMask'];
  if (!def) {
    toast('error', 'Magic Mask', 'Effect definition missing.');
    return null;
  }
  const params = defaultEffectParams(def);
  // Re-analysis replaces any previous Magic Mask on the clip (and its mattes).
  const stale: string[] = [];
  useProject.getState().update('Magic Mask', (p) => {
    const s = p.sequences.find((x) => x.id === sequenceId);
    const c = s?.clips.find((x) => x.id === clipId);
    if (!c) return;
    for (const fx of c.effects) if (fx.type === 'magicMask' && typeof fx.data?.trackId === 'string' && fx.data.trackId !== trackId) stale.push(fx.data.trackId);
    c.effects = c.effects.filter((fx) => fx.type !== 'magicMask');
    c.effects.push({ id: uid('fx'), type: 'magicMask', enabled: true, params: JSON.parse(JSON.stringify(params)), masks: [], data: { trackId } });
  });
  if (stale.length) {
    const { deleteMaskTrack } = await import('./maskStore');
    await Promise.all(stale.map((t) => deleteMaskTrack(t).catch(() => undefined)));
  }
  toast('success', 'Magic Mask ready', `${keys.length} keyframes tracked. Tune the matte in Effect Controls.`);
  return { trackId, keys };
}

/** Analyze a single frame and return a preview matte (for the dialog). */
export async function analyzeFramePreview(sequenceId: string, clipId: string, localFrame: number): Promise<{ width: number; height: number; alpha: Uint8Array } | null> {
  const project = useProject.getState().project;
  const seq = project.sequences.find((s) => s.id === sequenceId);
  const clip = seq?.clips.find((c) => c.id === clipId);
  const rec = clip?.assetId ? getMedia(clip.assetId) : undefined;
  if (!seq || !clip || !rec?.video) return null;
  const segmenter = await ensureSegmenter();
  const scratch = await getScratchVideo(rec);
  if (!scratch) return null;
  const srcTime = sourceTimeAt(clip, clip.start + localFrame, seq.settings.fps);
  const img = await scratch.getFrame(srcTime);
  if (!img) return null;
  const bitmap = await createImageBitmap(img as ImageBitmapSource);
  try {
    const res = segmenter.segmentForVideo(bitmap, Math.round(srcTime * 1000));
    const plane = personPlane(res?.confidenceMasks);
    res?.confidenceMasks?.forEach((m) => {
      try {
        m.close();
      } catch {
        /* ignore */
      }
    });
    if (!plane) return null;
    return planeToAlpha(plane.prob, plane.w, plane.h);
  } finally {
    bitmap.close();
  }
}

export function clipEndLocal(clip: { duration: number }) {
  return clip.duration - 1;
}

export { clipEnd };
