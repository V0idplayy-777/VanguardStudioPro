import { create } from 'zustand';
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, WebMOutputFormat, canEncodeVideo, type VideoCodec } from 'mediabunny';
import type { Id, MediaAsset } from '../../types/project';
import { useProject, findAsset } from '../../state/projectStore';
import { useSettings } from '../../state/settingsStore';
import { toast, logEvent } from '../../state/uiStore';
import { getMedia, updateMedia, bumpProxyVersion, type MediaRecord } from './mediaStore';
import { createElementSource, createWebCodecsSource } from './decoder';
import { deleteProxyBlob, loadProxyBlob, persistProxyBlob } from './mediaDb';
import { scheduleRender } from '../playback/playback';

/*
  Proxy media workflow.

  A proxy is a small video-only encode of an asset cached in IndexedDB
  (`proxy:<assetId>`) and decoded into `rec.proxyVideo`. When the global
  "use proxies" toggle is on and a ready proxy exists, the compositor, source
  monitor and program monitor decode the proxy while audio keeps coming from
  the original; export ALWAYS renders from the original.

  Generation transcodes the original through a CanvasSource at full decode
  speed (no realtime capture), reporting progress to `useProxyJobs`.
*/

export const PROXY_HEIGHTS: Record<string, number> = { '720p': 720, '540p': 540, '360p': 360 };

export interface ProxyJob {
  assetId: Id;
  phase: 'decoding' | 'encoding' | 'saving' | 'done' | 'error';
  progress: number; // 0..1
  message?: string;
}

interface ProxyJobStore {
  jobs: Record<string, ProxyJob>;
  setJob: (assetId: Id, job: ProxyJob | null) => void;
}

export const useProxyJobs = create<ProxyJobStore>((set) => ({
  jobs: {},
  setJob: (assetId, job) =>
    set((s) => {
      const jobs = { ...s.jobs };
      if (job) jobs[assetId] = job;
      else delete jobs[assetId];
      return { jobs };
    }),
}));

const cancelFlags = new Map<Id, boolean>();
export function cancelProxyJob(assetId: Id) {
  cancelFlags.set(assetId, true);
}

export function proxyTargetSize(asset: MediaAsset): { width: number; height: number } {
  const srcW = asset.width ?? 1280,
    srcH = asset.height ?? 720;
  const targetH = Math.min(srcH, PROXY_HEIGHTS[useSettings.getState().proxyScale] ?? 540);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  if (srcH <= targetH) return { width: even(srcW), height: even(srcH) };
  return { width: even((srcW * targetH) / srcH), height: even(targetH) };
}

/** Attach an already-encoded proxy blob to the media record + document. */
export async function attachProxyBlob(assetId: Id, blob: Blob, opts: { silent?: boolean } = {}): Promise<boolean> {
  const project = useProject.getState().project;
  const asset = findAsset(project, assetId);
  const rec = getMedia(assetId);
  if (!asset || !rec) return false;
  const url = URL.createObjectURL(blob);
  try {
    const wc = await createWebCodecsSource(blob);
    const src = wc ?? createElementSource(url, asset.duration ?? rec.video?.duration ?? 0, blob ? asset.width ?? 0 : 0, asset.height ?? 0, asset.fps ?? 30);
    if (rec.proxyUrl) URL.revokeObjectURL(rec.proxyUrl);
    rec.proxyVideo?.dispose();
    updateMedia(assetId, { proxyBlob: blob, proxyUrl: url, proxyVideo: src });
    const { width, height } = proxyTargetSize(asset);
    useProject.getState().update('Attach Proxy', (p) => {
      const a = p.assets.find((x) => x.id === assetId);
      if (a) a.proxy = { status: 'ready', width, height, bytes: blob.size, createdAt: Date.now() };
    });
    bumpProxyVersion();
    scheduleRender(true);
    if (!opts.silent) {
      toast('success', 'Proxy attached', `${asset.name} will now play from its proxy.`);
      logEvent('info', `Proxy attached for ${asset.name} (${(blob.size / 1048576).toFixed(1)} MB)`);
    }
    return true;
  } catch (e) {
    URL.revokeObjectURL(url);
    if (!opts.silent) toast('error', 'Proxy attach failed', e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** Restore cached proxies / cleaned audio after a project load. Runs in the background. */
export async function restoreAssetDerivatives(asset: MediaAsset): Promise<void> {
  if (asset.proxy?.status !== 'ready' && !asset.cleanedAudio) return;
  const rec = getMedia(asset.id);
  if (!rec) return;
  if (asset.proxy?.status === 'ready' && !rec.proxyVideo) {
    try {
      const blob = await loadProxyBlob(asset.id);
      if (blob) {
        const url = URL.createObjectURL(blob);
        const wc = await createWebCodecsSource(blob).catch(() => null);
        const src = wc ?? createElementSource(url, asset.duration ?? rec.video?.duration ?? 0, asset.proxy.width, asset.proxy.height, asset.fps ?? 30);
        updateMedia(asset.id, { proxyBlob: blob, proxyUrl: url, proxyVideo: src });
        bumpProxyVersion();
      } else {
        // Cached file is gone (quota eviction) — mark the proxy missing.
        useProject.getState().update('Proxy Missing', (p) => {
          const a = p.assets.find((x) => x.id === asset.id);
          if (a) a.proxy = undefined;
        });
      }
    } catch {
      /* proxies are best-effort */
    }
  }
  if (asset.cleanedAudio && !rec.enhancedAudio) {
    try {
      const { restoreCleanedAudio } = await import('../audio/voiceCleanup');
      await restoreCleanedAudio(asset.id);
    } catch {
      /* best-effort */
    }
  }
}

/** Global "+1 / Proxy" toggle. */
export function toggleProxyPlayback() {
  const st = useSettings.getState();
  st.set('proxyEnabled', !st.proxyEnabled);
  bumpProxyVersion();
  scheduleRender(true);
  toast('info', st.proxyEnabled ? 'Proxy playback on' : 'Proxy playback off', st.proxyEnabled ? 'Clips with proxies play the lightweight files.' : 'Playing original media.');
}

function checkCancel(assetId: Id) {
  if (cancelFlags.get(assetId)) {
    cancelFlags.delete(assetId);
    throw new Error('cancelled');
  }
}

/**
 * Generate a proxy for one asset. Transcodes at full decode speed through a
 * fresh decode session so playback is never disturbed.
 */
export async function createProxyForAsset(assetId: Id): Promise<boolean> {
  const job = useProxyJobs.getState().setJob;
  const project = useProject.getState().project;
  const asset = findAsset(project, assetId);
  const rec = getMedia(assetId);
  if (!asset || !rec) return false;
  if (!asset.hasVideo || asset.kind === 'sequence' || asset.kind === 'generator') {
    toast('warning', 'No video to proxy', `${asset.name} has no video track.`);
    return false;
  }
  if (useProxyJobs.getState().jobs[assetId]) return false; // already running
  cancelFlags.delete(assetId);
  const { width: PW, height: PH } = proxyTargetSize(asset);
  const setPhase = (phase: ProxyJob['phase'], progress: number, message?: string) => job(assetId, { assetId, phase, progress, message });
  setPhase('decoding', 0, 'Opening source…');
  // Mark pending in the document so badges update immediately.
  useProject.getState().update('Create Proxy', (p) => {
    const a = p.assets.find((x) => x.id === assetId);
    if (a) a.proxy = { status: 'pending', width: PW, height: PH, bytes: 0, createdAt: Date.now() };
  });
  bumpProxyVersion();

  let decodeSrc: Awaited<ReturnType<typeof createWebCodecsSource>> | null = null;
  let elementSrc: ReturnType<typeof createElementSource> | null = null;
  try {
    decodeSrc = await createWebCodecsSource(rec.blob).catch(() => null);
    checkCancel(assetId);
    const wantVp9 = useSettings.getState().proxyCodec === 'vp9';
    let codec: VideoCodec = 'avc';
    let format: Mp4OutputFormat | WebMOutputFormat = new Mp4OutputFormat({ fastStart: 'in-memory' });
    if (wantVp9 && (await canEncodeVideo('vp9', { width: PW, height: PH }).catch(() => false))) {
      codec = 'vp9';
      format = new WebMOutputFormat();
    } else {
      const avcOk = await canEncodeVideo('avc', { width: PW, height: PH }).catch(() => false);
      if (!avcOk && (await canEncodeVideo('vp9', { width: PW, height: PH }).catch(() => false))) {
        codec = 'vp9';
        format = new WebMOutputFormat();
      } else if (!avcOk) {
        throw new Error('This browser cannot encode H.264 or VP9 video.');
      }
    }
    const duration = decodeSrc?.duration ?? asset.duration ?? rec.video?.duration ?? 0;
    const fps = decodeSrc?.fps ?? asset.fps ?? 30;
    if (!(duration > 0)) throw new Error('Could not read the duration of this file.');
    const totalFrames = Math.max(1, Math.ceil(duration * fps));
    const canvas = document.createElement('canvas');
    canvas.width = PW;
    canvas.height = PH;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, PW, PH);
    const target = new BufferTarget();
    const output = new Output({ format, target });
    const videoSource = new CanvasSource(canvas, { codec, bitrate: Math.max(400_000, PW * PH * fps * 0.12), keyFrameInterval: 2, bitrateMode: 'variable', latencyMode: 'quality' });
    output.addVideoTrack(videoSource, { frameRate: fps });
    await output.start();
    setPhase('encoding', 0, `Encoding ${PW}×${PH}…`);
    const t0 = performance.now();
    let encoded = 0;
    try {
      if (decodeSrc?.frames) {
        for await (const f of decodeSrc.frames(0, duration)) {
          checkCancel(assetId);
          g.drawImage(f.image as CanvasImageSource, 0, 0, PW, PH);
          if (f.image instanceof VideoFrame) {
            try {
              f.image.close();
            } catch {
              /* ignore */
            }
          }
          const ts = Math.min(f.time, duration);
          await videoSource.add(ts, Math.max(1 / fps, duration / totalFrames));
          encoded++;
          if (encoded % 12 === 0) setPhase('encoding', Math.min(0.99, ts / duration), `Encoding ${PW}×${PH}…`);
        }
      } else {
        // Element fallback: step through the file (slower, still faster than realtime).
        elementSrc = createElementSource(rec.url, duration, asset.width ?? PW, asset.height ?? PH, fps);
        for (let i = 0; i < totalFrames; i++) {
          checkCancel(assetId);
          const t = Math.min(duration - 1e-3, (i / totalFrames) * duration);
          const img = await elementSrc.getFrame(t);
          if (img) g.drawImage(img as CanvasImageSource, 0, 0, PW, PH);
          await videoSource.add(t, duration / totalFrames);
          encoded++;
          if (encoded % 12 === 0) setPhase('encoding', Math.min(0.99, i / totalFrames), `Encoding ${PW}×${PH}…`);
        }
      }
    } catch (e) {
      try {
        await output.cancel();
      } catch {
        /* ignore */
      }
      throw e;
    }
    if (encoded === 0) {
      try {
        await output.cancel();
      } catch {
        /* ignore */
      }
      throw new Error('No frames could be decoded from this file.');
    }
    videoSource.close();
    setPhase('saving', 1, 'Finalizing…');
    await output.finalize();
    const blob = new Blob([target.buffer as BlobPart], { type: codec === 'vp9' ? 'video/webm' : 'video/mp4' });
    await persistProxyBlob(assetId, blob);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    job(assetId, null);
    const ok = await attachProxyBlob(assetId, blob, { silent: true });
    if (ok) {
      toast('success', 'Proxy ready', `${asset.name} → ${PW}×${PH} in ${secs}s (${(blob.size / 1048576).toFixed(1)} MB).`);
      logEvent('info', `Proxy created for ${asset.name}: ${PW}×${PH}, ${(blob.size / 1048576).toFixed(1)} MB in ${secs}s`);
    }
    return ok;
  } catch (e) {
    const cancelled = e instanceof Error && e.message === 'cancelled';
    job(assetId, null);
    useProject.getState().update(cancelled ? 'Cancel Proxy' : 'Proxy Failed', (p) => {
      const a = p.assets.find((x) => x.id === assetId);
      if (a && a.proxy?.status === 'pending') a.proxy = undefined;
    });
    bumpProxyVersion();
    if (!cancelled) {
      toast('error', 'Proxy failed', e instanceof Error ? e.message : String(e));
      logEvent('error', `Proxy failed for ${asset?.name ?? assetId}: ${e instanceof Error ? e.message : e}`);
    }
    return false;
  } finally {
    try {
      decodeSrc?.dispose();
    } catch {
      /* ignore */
    }
    try {
      elementSrc?.dispose();
    } catch {
      /* ignore */
    }
  }
}

/** Queue proxies for many assets, two at a time. */
export async function createProxiesForAssets(assetIds: Id[]): Promise<void> {
  const queue = assetIds.filter((id) => !useProxyJobs.getState().jobs[id]);
  if (!queue.length) return;
  toast('info', 'Creating proxies', `${queue.length} file${queue.length === 1 ? '' : 's'} queued.`);
  const workers = [0, 1].map(async () => {
    while (queue.length) {
      const id = queue.shift()!;
      await createProxyForAsset(id);
    }
  });
  await Promise.all(workers);
  scheduleRender(true);
}

/** Detach (and optionally delete the cached file of) an asset's proxy. */
export async function detachProxy(assetId: Id, deleteFile = true): Promise<void> {
  const rec: MediaRecord | undefined = getMedia(assetId);
  if (rec?.proxyUrl) URL.revokeObjectURL(rec.proxyUrl);
  try {
    rec?.proxyVideo?.dispose();
  } catch {
    /* ignore */
  }
  if (rec) updateMedia(assetId, { proxyBlob: undefined, proxyUrl: undefined, proxyVideo: undefined });
  if (deleteFile) await deleteProxyBlob(assetId).catch(() => undefined);
  useProject.getState().update('Detach Proxy', (p) => {
    const a = p.assets.find((x) => x.id === assetId);
    if (a) a.proxy = undefined;
  });
  bumpProxyVersion();
  scheduleRender(true);
}

/** Assets eligible for proxy creation. */
export function proxyCandidates(project: { assets: MediaAsset[] }): MediaAsset[] {
  return project.assets.filter((a) => a.hasVideo && a.kind !== 'sequence' && a.kind !== 'generator' && !a.offline && a.proxy?.status !== 'ready' && !useProxyJobs.getState().jobs[a.id]);
}
