import type { MediaAsset } from '../../types/project';
import { uid, ext, stripExt } from '../util';
import { computePeaks, registerMedia, updateMedia, getMedia } from './mediaStore';
import { createElementSource, createWebCodecsSource, decodeAudioBuffer, probeMedia, probeWithElement } from './decoder';
import { getSharedAudioContext } from '../audio/audioContext';
import { useProject, createSequence } from '../../state/projectStore';
import { logEvent, toast, useUI } from '../../state/uiStore';
import { settings } from '../../state/settingsStore';
import { persistMediaBlob } from './mediaDb';

const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mts', 'm2ts', 'ts', 'mxf', 'ogv', '3gp']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'wma']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'tif', 'tiff', 'heic']);

export function classifyFile(file: File): 'video' | 'audio' | 'image' | 'project' | 'captions' | 'unknown' {
  const e = ext(file.name);
  if (e === 'vsproj' || e === 'vsp' || e === 'vspproj') return 'project';
  if (e === 'srt' || e === 'vtt') return 'captions';
  if (file.type.startsWith('video/') || VIDEO_EXT.has(e)) return 'video';
  if (file.type.startsWith('audio/') || AUDIO_EXT.has(e)) return 'audio';
  if (file.type.startsWith('image/') || IMAGE_EXT.has(e)) return 'image';
  return 'unknown';
}

export interface ImportOptions {
  binId?: string | null;
  /** Called when an asset has been created (before decoding completes). */
  onAsset?: (a: MediaAsset) => void;
}

/** Import a list of files. Returns created assets. */
export async function importFiles(files: File[], opts: ImportOptions = {}): Promise<MediaAsset[]> {
  const created: MediaAsset[] = [];
  const settings = useProject.getState().project.settings;
  for (const file of files) {
    const kind = classifyFile(file);
    if (kind === 'project' || kind === 'captions' || kind === 'unknown') {
      if (kind === 'unknown') {
        toast('warning', 'Unsupported file', `${file.name} is not a recognised media type.`);
        logEvent('warning', `Skipped unsupported file ${file.name}`);
      }
      continue;
    }
    const asset: MediaAsset = {
      id: uid('ast'),
      kind,
      name: stripExt(file.name),
      binId: opts.binId ?? null,
      label: settings.labelDefaults[kind],
      file: { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified },
      hasVideo: kind !== 'audio',
      hasAudio: kind !== 'image',
      offline: false,
      createdAt: Date.now(),
      meta: {},
    };
    created.push(asset);
    registerMedia(asset.id, file);
    useProject.getState().update('Import', (p) => {
      p.assets.push(asset);
    });
    opts.onAsset?.(asset);
    // decode in the background
    void decodeAsset(asset, file);
    void persistMediaBlob(asset.id, file);
  }
  if (created.length) logEvent('info', `Imported ${created.length} file${created.length === 1 ? '' : 's'}`);
  return created;
}

function patchAsset(id: string, patch: Partial<MediaAsset>) {
  useProject.getState().updateTransient((p) => {
    const a = p.assets.find((x) => x.id === id);
    if (a) Object.assign(a, patch);
  });
}

/**
 * Settings > Import: when the project has no sequence at all, the first
 * decoded video/image creates one matching its size and rate.
 */
function maybeAutoSequence(asset: MediaAsset, patch: Partial<MediaAsset>) {
  if (!settings().importAutoSequence) return;
  if (asset.kind !== 'video' && asset.kind !== 'image') return;
  const w = patch.width ?? asset.width;
  const h = patch.height ?? asset.height;
  if (!w || !h) return;
  if (useProject.getState().project.sequences.length) return;
  const fps = patch.fps && isFinite(patch.fps) ? Math.round(patch.fps * 1000) / 1000 : 30;
  const seq = createSequence('Sequence 01', { width: w, height: h, fps }, { video: 2, audio: 2 });
  useProject.getState().update('New sequence from import', (p) => {
    if (p.sequences.length) return; // another import won the race
    p.sequences.push(seq);
    p.openSequenceIds.push(seq.id);
    p.activeSequenceId = seq.id;
    p.assets.push({ id: uid('ast'), kind: 'sequence', name: seq.name, binId: null, label: 'iris', sequenceId: seq.id, hasVideo: true, hasAudio: true, width: w, height: h, fps, duration: 0, offline: false, createdAt: Date.now(), meta: {} });
  });
  logEvent('info', 'Sequence created from import', `${w}x${h} @ ${fps} fps to match "${asset.name}"`);
}

export async function decodeAsset(asset: MediaAsset, blob: Blob) {
  const rec = getMedia(asset.id);
  if (!rec) return;
  try {
    if (asset.kind === 'image') {
      const bmp = await createImageBitmap(blob).catch(async () => {
        // SVG or odd formats: go through an <img>
        const url = URL.createObjectURL(blob);
        const img = new Image();
        await new Promise<void>((res, rej) => {
          img.onload = () => res();
          img.onerror = () => rej(new Error('image decode failed'));
          img.src = url;
        });
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || 1920;
        c.height = img.naturalHeight || 1080;
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        return createImageBitmap(c);
      });
      updateMedia(asset.id, { image: bmp });
      patchAsset(asset.id, { width: bmp.width, height: bmp.height });
      rec.resolveReady();
      return;
    }
    const probe = (await probeMedia(blob)) ?? (await probeWithElement(blob, asset.kind === 'audio'));
    if (!probe) throw new Error('Could not read media container');
    const patch: Partial<MediaAsset> = {
      duration: probe.duration,
      hasVideo: probe.hasVideo,
      hasAudio: probe.hasAudio,
      width: probe.width,
      height: probe.height,
      fps: probe.fps ? Math.round(probe.fps * 1000) / 1000 : undefined,
      audioChannels: probe.channels,
      sampleRate: probe.sampleRate,
    };
    if (probe.hasVideo && !probe.hasAudio && asset.kind === 'video') patch.hasAudio = false;
    if (!probe.hasVideo && asset.kind === 'video') patch.kind = 'audio';
    patchAsset(asset.id, patch);
    maybeAutoSequence(asset, patch);

    // Video source
    if (probe.hasVideo) {
      const wc = await createWebCodecsSource(blob);
      const w = probe.width ?? 1920,
        h = probe.height ?? 1080;
      const src = wc ?? createElementSource(rec.url, probe.duration, w, h, probe.fps ?? 30);
      updateMedia(asset.id, { video: src });
      if (!wc) logEvent('info', `${asset.name}: using browser video element for decode (WebCodecs not available for this codec).`);
    }
    rec.resolveReady();

    // Audio (may take a while for long files)
    if (probe.hasAudio) {
      const ctx = getSharedAudioContext();
      const buf = await decodeAudioBuffer(blob, ctx);
      if (buf) {
        updateMedia(asset.id, { audio: buf, peaks: computePeaks(buf) });
        if (!probe.duration || !isFinite(probe.duration)) patchAsset(asset.id, { duration: buf.duration });
        patchAsset(asset.id, { audioChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
      } else {
        logEvent('warning', `${asset.name}: audio track could not be decoded.`);
        patchAsset(asset.id, { hasAudio: false });
      }
    }
  } catch (e: any) {
    updateMedia(asset.id, { error: String(e?.message ?? e) });
    patchAsset(asset.id, { offline: true });
    rec.resolveReady();
    toast('error', 'Import failed', `${asset.name}: ${e?.message ?? e}`);
    logEvent('error', `Decode failed for ${asset.name}`, String(e?.stack ?? e));
  }
}

/** Relink an offline asset to a new file. */
export async function relinkAsset(asset: MediaAsset, file: File, quiet = false) {
  registerMedia(asset.id, file);
  patchAsset(asset.id, { offline: false, file: { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified } });
  await decodeAsset({ ...asset, offline: false }, file);
  void persistMediaBlob(asset.id, file);
  if (!quiet) useUI.getState().toast({ kind: 'success', title: 'Media relinked', message: asset.name });
}

export function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      resolve(files);
    };
    // If the dialog is cancelled there is no reliable event; clean up later.
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => {
          if (document.body.contains(input)) {
            input.remove();
            resolve([]);
          }
        }, 1000);
      },
      { once: true },
    );
    input.click();
  });
}

export const MEDIA_ACCEPT = 'video/*,audio/*,image/*,.mkv,.mov,.mp4,.webm,.mp3,.wav,.flac,.aac,.m4a,.ogg,.png,.jpg,.jpeg,.gif,.webp,.svg';
