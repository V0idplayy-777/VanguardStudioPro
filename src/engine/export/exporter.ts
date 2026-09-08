import { AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, MovOutputFormat, MkvOutputFormat, Output, QUALITY_HIGH, QUALITY_LOW, QUALITY_MEDIUM, QUALITY_VERY_HIGH, WebMOutputFormat, canEncodeAudio, canEncodeVideo, type VideoCodec, type AudioCodec } from 'mediabunny';
import { zipSync } from 'fflate';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import type { Project, Sequence } from '../../types/project';
import { getCompositor } from '../playback/playback';
import { renderSequenceAudio } from '../audio/timelineAudio';
import { sequenceDuration } from '../../state/projectStore';
import { sanitizeFilename } from '../util';

export type ExportContainer = 'mp4' | 'webm' | 'mov' | 'mkv' | 'gif' | 'png' | 'jpeg' | 'webp' | 'wav' | 'mp3';

export interface ExportSettings {
  container: ExportContainer;
  videoCodec: 'avc' | 'hevc' | 'vp9' | 'av1' | 'vp8';
  audioCodec: 'aac' | 'opus';
  width: number;
  height: number;
  fps: number;
  /** kbps */
  videoBitrate: number;
  bitrateMode: 'cbr' | 'vbr';
  quality: 'low' | 'medium' | 'high' | 'veryHigh' | 'custom';
  audioBitrate: number;
  sampleRate: 48000 | 44100;
  channels: 1 | 2;
  range: 'entire' | 'inOut' | 'workArea' | 'custom';
  customStart: number;
  customEnd: number;
  includeVideo: boolean;
  includeAudio: boolean;
  keyframeInterval: number; // seconds
  burnCaptions: boolean;
  /** Image sequence / gif options */
  imageQuality: number;
  gifColors: number;
  gifLoop: boolean;
  gifDither: boolean;
  filename: string;
  useMaxQuality: boolean;
  /** Stretch / letterbox behaviour when output aspect differs. */
  scaleMode: 'fit' | 'fill' | 'stretch';
  /** Timecode overlay burn-in. */
  burnTimecode: boolean;
  /** Frame step for image sequences (1 = every frame). */
  frameStep: number;
}

export function defaultExportSettings(seq: Sequence, name: string): ExportSettings {
  return {
    container: 'mp4',
    videoCodec: 'avc',
    audioCodec: 'aac',
    width: seq.settings.width,
    height: seq.settings.height,
    fps: seq.settings.fps,
    videoBitrate: Math.round((seq.settings.width * seq.settings.height * seq.settings.fps * 0.12) / 1000),
    bitrateMode: 'vbr',
    quality: 'high',
    audioBitrate: 192,
    sampleRate: 48000,
    channels: 2,
    range: 'entire',
    customStart: 0,
    customEnd: sequenceDuration(seq),
    includeVideo: true,
    includeAudio: true,
    keyframeInterval: 2,
    burnCaptions: true,
    imageQuality: 0.92,
    gifColors: 256,
    gifLoop: true,
    gifDither: true,
    filename: sanitizeFilename(name),
    useMaxQuality: true,
    scaleMode: 'fit',
    burnTimecode: false,
    frameStep: 1,
  };
}

export interface ExportProgress {
  phase: 'preparing' | 'audio' | 'video' | 'muxing' | 'done' | 'error' | 'cancelled';
  frame: number;
  totalFrames: number;
  fps: number;
  etaSeconds: number;
  message?: string;
  bytes?: number;
}

/* ---------- presets & app defaults ---------- */

export type ExportPreset = { id: string; name: string; apply: (s: ExportSettings, seq: Sequence) => Partial<ExportSettings> };

/** Preset list shared by the Export panel and the Settings > Export category. */
export const EXPORT_PRESETS: ExportPreset[] = [
  { id: 'match', name: 'Match Source - High bitrate', apply: (_s, seq) => ({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: seq.settings.width, height: seq.settings.height, fps: seq.settings.fps, quality: 'high', videoBitrate: Math.round((seq.settings.width * seq.settings.height * seq.settings.fps * 0.12) / 1000) }) },
  { id: 'yt1080', name: 'YouTube 1080p', apply: () => ({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 1920, height: 1080, quality: 'high', videoBitrate: 12000, audioBitrate: 320, keyframeInterval: 2 }) },
  { id: 'yt4k', name: 'YouTube 2160p (4K)', apply: () => ({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 3840, height: 2160, quality: 'veryHigh', videoBitrate: 45000, audioBitrate: 320 }) },
  { id: 'vertical', name: 'Vertical 1080x1920 (Shorts / Reels)', apply: () => ({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 1080, height: 1920, quality: 'high', videoBitrate: 10000, scaleMode: 'fill' }) },
  { id: 'square', name: 'Square 1080x1080', apply: () => ({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 1080, height: 1080, quality: 'high', videoBitrate: 8000, scaleMode: 'fill' }) },
  { id: 'webm', name: 'WebM VP9 (web)', apply: () => ({ container: 'webm', videoCodec: 'vp9', audioCodec: 'opus', quality: 'high' }) },
  { id: 'proxy', name: 'Proxy 720p low bitrate', apply: () => ({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 1280, height: 720, quality: 'low', videoBitrate: 2500, audioBitrate: 128 }) },
  { id: 'gif', name: 'Animated GIF (max 720 px)', apply: () => ({ container: 'gif', width: 720, height: 405, fps: 15, includeAudio: false }) },
  { id: 'wav', name: 'Audio only - WAV 48 kHz', apply: () => ({ container: 'wav', includeVideo: false, includeAudio: true }) },
  { id: 'png', name: 'PNG image sequence', apply: () => ({ container: 'png', includeAudio: false }) },
];

export type ExportFilenameMode = 'sequence' | 'project' | 'dated';

export function exportFilenameFor(mode: ExportFilenameMode, seqName: string, projectName: string): string {
  switch (mode) {
    case 'project':
      return sanitizeFilename(`${projectName} - ${seqName}`);
    case 'dated':
      return sanitizeFilename(`${seqName} ${new Date().toISOString().slice(0, 10)}`);
    default:
      return sanitizeFilename(seqName);
  }
}

/**
 * Apply the app-level export preferences (Settings > Export) on top of the
 * per-sequence defaults. Used by the Export panel and the render queue.
 */
export function applyAppExportDefaults(
  base: ExportSettings,
  seq: Sequence,
  prefs: { exportDefaultPreset: string; exportFilenameMode: ExportFilenameMode; exportBurnCaptions: boolean; projectName: string },
): ExportSettings {
  let out = { ...base };
  const preset = EXPORT_PRESETS.find((p) => p.id === prefs.exportDefaultPreset);
  if (preset) out = { ...out, ...preset.apply(out, seq) };
  out.filename = exportFilenameFor(prefs.exportFilenameMode, seq.name, prefs.projectName);
  out.burnCaptions = prefs.exportBurnCaptions && seq.captions.length > 0;
  return out;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
  durationSeconds: number;
  frames: number;
}

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled');
  }
}

export function exportRange(seq: Sequence, s: ExportSettings): [number, number] {
  const dur = sequenceDuration(seq);
  switch (s.range) {
    case 'inOut':
      return [seq.inPoint ?? 0, seq.outPoint ?? dur];
    case 'workArea':
      return [seq.workArea.start, Math.min(seq.workArea.end, dur)];
    case 'custom':
      return [Math.max(0, s.customStart), Math.min(dur, s.customEnd)];
    default:
      return [0, dur];
  }
}

export async function probeEncoders(): Promise<{ video: Record<string, boolean>; audio: Record<string, boolean>; webcodecs: boolean }> {
  const webcodecs = typeof VideoEncoder !== 'undefined';
  const video: Record<string, boolean> = {};
  const audio: Record<string, boolean> = {};
  for (const c of ['avc', 'hevc', 'vp9', 'av1', 'vp8'] as VideoCodec[]) {
    try {
      video[c] = webcodecs ? await canEncodeVideo(c, { width: 1280, height: 720 }) : false;
    } catch {
      video[c] = false;
    }
  }
  for (const c of ['aac', 'opus'] as AudioCodec[]) {
    try {
      audio[c] = typeof AudioEncoder !== 'undefined' ? await canEncodeAudio(c) : false;
    } catch {
      audio[c] = false;
    }
  }
  return { video, audio, webcodecs };
}

function qualityFor(q: ExportSettings['quality']) {
  switch (q) {
    case 'low':
      return QUALITY_LOW;
    case 'medium':
      return QUALITY_MEDIUM;
    case 'veryHigh':
      return QUALITY_VERY_HIGH;
    default:
      return QUALITY_HIGH;
  }
}

/** Draw a rendered frame (sequence aspect) into the export canvas honouring scale mode. */
function fitDraw(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, W: number, H: number, mode: ExportSettings['scaleMode']) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (mode === 'stretch') {
    ctx.drawImage(src, 0, 0, W, H);
    return;
  }
  const sa = src.width / src.height,
    da = W / H;
  let w = W,
    h = H;
  if (mode === 'fit' ? sa > da : sa < da) {
    w = W;
    h = W / sa;
  } else {
    h = H;
    w = H * sa;
  }
  if (mode === 'fill') {
    if (sa > da) {
      h = H;
      w = H * sa;
    } else {
      w = W;
      h = W / sa;
    }
  }
  ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
}

function tcOverlay(ctx: CanvasRenderingContext2D, W: number, H: number, frame: number, fps: number) {
  const nom = Math.round(fps);
  const ff = frame % nom;
  const s = Math.floor(frame / nom);
  const tc = `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
  const fs = Math.round(H * 0.035);
  ctx.font = `500 ${fs}px "Inter Variable", Inter, sans-serif`;
  const tw = ctx.measureText(tc).width;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(W / 2 - tw / 2 - fs * 0.5, H - fs * 2.2, tw + fs, fs * 1.5);
  ctx.fillStyle = '#e8e8e8';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(tc, W / 2, H - fs * 1.45);
}

/**
 * Main export. Renders each frame through the compositor at full quality,
 * encodes with WebCodecs via mediabunny, muxes into the chosen container.
 */
export async function exportSequence(project: Project, seq: Sequence, settings: ExportSettings, onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<ExportResult> {
  const [startF, endF] = exportRange(seq, settings);
  const seqFps = seq.settings.fps;
  const outFps = settings.fps;
  const totalOut = Math.max(1, Math.round(((endF - startF) / seqFps) * outFps));
  const started = performance.now();
  const check = () => {
    if (signal.aborted) throw new ExportCancelled();
  };
  const W = Math.max(2, Math.round(settings.width / 2) * 2);
  const H = Math.max(2, Math.round(settings.height / 2) * 2);
  onProgress({ phase: 'preparing', frame: 0, totalFrames: totalOut, fps: 0, etaSeconds: 0 });

  const ext = settings.container;
  const filename = `${settings.filename || 'export'}.${ext === 'jpeg' ? 'zip' : ext === 'png' || ext === 'webp' ? 'zip' : ext}`;

  // ---- audio only ----
  if (ext === 'wav' || ext === 'mp3') {
    onProgress({ phase: 'audio', frame: 0, totalFrames: 1, fps: 0, etaSeconds: 0 });
    const buf = await renderSequenceAudio(project, seq, startF, endF, settings.sampleRate);
    check();
    const blob = ext === 'wav' ? encodeWav(buf, settings.channels) : await encodeCompressedAudio(buf, settings, 'mp3');
    onProgress({ phase: 'done', frame: 1, totalFrames: 1, fps: 0, etaSeconds: 0, bytes: blob.size });
    return { blob, filename: `${settings.filename}.${ext === 'mp3' ? (blob.type.includes('mp4') ? 'm4a' : 'webm') : 'wav'}`, durationSeconds: buf.duration, frames: 0 };
  }

  const comp = getCompositor();
  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = W;
  frameCanvas.height = H;
  const fctx = frameCanvas.getContext('2d', { willReadFrequently: ext === 'gif' })!;
  const tmp = document.createElement('canvas');

  const renderOut = async (i: number) => {
    const seqFrame = Math.round(startF + (i / outFps) * seqFps);
    comp.releaseAll();
    const rt = await comp.renderFrame(project, seq, seqFrame, { scale: 1, captions: settings.burnCaptions });
    comp.drawToCanvas(rt, tmp);
    comp.release(rt);
    fitDraw(fctx, tmp, W, H, settings.scaleMode);
    if (settings.burnTimecode) tcOverlay(fctx, W, H, seqFrame, seqFps);
  };

  const report = (i: number, phase: ExportProgress['phase'] = 'video') => {
    const elapsed = (performance.now() - started) / 1000;
    const fps = i / Math.max(elapsed, 0.001);
    onProgress({ phase, frame: i, totalFrames: totalOut, fps, etaSeconds: fps > 0 ? (totalOut - i) / fps : 0 });
  };

  // ---- image sequence ----
  if (ext === 'png' || ext === 'jpeg' || ext === 'webp') {
    const files: Record<string, Uint8Array> = {};
    const mime = ext === 'png' ? 'image/png' : ext === 'jpeg' ? 'image/jpeg' : 'image/webp';
    const step = Math.max(1, settings.frameStep);
    for (let i = 0; i < totalOut; i += step) {
      check();
      await renderOut(i);
      const blob: Blob = await new Promise((res) => frameCanvas.toBlob((b) => res(b!), mime, settings.imageQuality));
      files[`${settings.filename}_${String(i).padStart(5, '0')}.${ext === 'jpeg' ? 'jpg' : ext}`] = new Uint8Array(await blob.arrayBuffer());
      report(i);
    }
    onProgress({ phase: 'muxing', frame: totalOut, totalFrames: totalOut, fps: 0, etaSeconds: 0 });
    const zipped = zipSync(files, { level: 0 });
    const blob = new Blob([zipped as BlobPart], { type: 'application/zip' });
    onProgress({ phase: 'done', frame: totalOut, totalFrames: totalOut, fps: 0, etaSeconds: 0, bytes: blob.size });
    return { blob, filename, durationSeconds: totalOut / outFps, frames: totalOut };
  }

  // ---- GIF ----
  if (ext === 'gif') {
    const gif = GIFEncoder();
    const delay = Math.round(1000 / outFps);
    for (let i = 0; i < totalOut; i++) {
      check();
      await renderOut(i);
      const data = fctx.getImageData(0, 0, W, H).data;
      const palette = quantize(data, Math.max(2, Math.min(256, settings.gifColors)), { format: 'rgb565' });
      const index = applyPalette(data, palette, 'rgb565');
      gif.writeFrame(index, W, H, { palette, delay, repeat: settings.gifLoop ? 0 : -1, dispose: 0 });
      report(i);
    }
    gif.finish();
    const bytes = gif.bytes();
    const blob = new Blob([bytes as BlobPart], { type: 'image/gif' });
    onProgress({ phase: 'done', frame: totalOut, totalFrames: totalOut, fps: 0, etaSeconds: 0, bytes: blob.size });
    return { blob, filename, durationSeconds: totalOut / outFps, frames: totalOut };
  }

  // ---- video containers ----
  const haveWebCodecs = typeof VideoEncoder !== 'undefined';
  const videoOk = haveWebCodecs && settings.includeVideo ? await canEncodeVideo(settings.videoCodec as VideoCodec, { width: W, height: H }).catch(() => false) : false;
  if (settings.includeVideo && !videoOk) {
    // Fallback: MediaRecorder realtime capture (WebM only).
    return exportWithMediaRecorder(project, seq, settings, onProgress, signal, startF, endF, W, H, frameCanvas, renderOut, report);
  }

  // Audio first (offline render)
  let audioBuffer: AudioBuffer | null = null;
  if (settings.includeAudio) {
    onProgress({ phase: 'audio', frame: 0, totalFrames: totalOut, fps: 0, etaSeconds: 0 });
    audioBuffer = await renderSequenceAudio(project, seq, startF, endF, settings.sampleRate);
    check();
  }

  const format =
    ext === 'webm' ? new WebMOutputFormat() : ext === 'mov' ? new MovOutputFormat({ fastStart: 'in-memory' }) : ext === 'mkv' ? new MkvOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' });
  const target = new BufferTarget();
  const output = new Output({ format, target });

  let videoSource: CanvasSource | null = null;
  if (settings.includeVideo) {
    const bitrate = settings.quality === 'custom' ? settings.videoBitrate * 1000 : qualityFor(settings.quality);
    videoSource = new CanvasSource(frameCanvas, {
      codec: settings.videoCodec as VideoCodec,
      bitrate,
      keyFrameInterval: settings.keyframeInterval,
      bitrateMode: settings.bitrateMode === 'cbr' ? 'constant' : 'variable',
      latencyMode: 'quality',
    });
    output.addVideoTrack(videoSource, { frameRate: outFps });
  }
  let audioSource: AudioBufferSource | null = null;
  if (audioBuffer && settings.includeAudio) {
    const wantCodec: AudioCodec = ext === 'webm' || ext === 'mkv' ? 'opus' : settings.audioCodec;
    const ok = await canEncodeAudio(wantCodec).catch(() => false);
    const codec: AudioCodec = ok ? wantCodec : (await canEncodeAudio('opus').catch(() => false)) ? 'opus' : 'aac';
    audioSource = new AudioBufferSource({ codec, bitrate: settings.audioBitrate * 1000 });
    output.addAudioTrack(audioSource);
  }
  await output.start();
  try {
    if (audioSource && audioBuffer) {
      let buf = audioBuffer;
      if (settings.channels === 1 && buf.numberOfChannels > 1) buf = downmixMono(buf);
      await audioSource.add(buf);
      audioSource.close();
    }
    if (videoSource) {
      const frameDur = 1 / outFps;
      for (let i = 0; i < totalOut; i++) {
        check();
        await renderOut(i);
        await videoSource.add(i * frameDur, frameDur);
        report(i);
      }
      videoSource.close();
    }
    onProgress({ phase: 'muxing', frame: totalOut, totalFrames: totalOut, fps: 0, etaSeconds: 0 });
    await output.finalize();
  } catch (e) {
    try {
      await output.cancel();
    } catch {
      /* ignore */
    }
    throw e;
  }
  const buffer = target.buffer!;
  const mime = ext === 'webm' ? 'video/webm' : ext === 'mkv' ? 'video/x-matroska' : ext === 'mov' ? 'video/quicktime' : 'video/mp4';
  const blob = new Blob([buffer], { type: mime });
  onProgress({ phase: 'done', frame: totalOut, totalFrames: totalOut, fps: 0, etaSeconds: 0, bytes: blob.size });
  return { blob, filename, durationSeconds: totalOut / outFps, frames: totalOut };
}

async function exportWithMediaRecorder(
  project: Project,
  seq: Sequence,
  settings: ExportSettings,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
  startF: number,
  endF: number,
  W: number,
  H: number,
  frameCanvas: HTMLCanvasElement,
  renderOut: (i: number) => Promise<void>,
  report: (i: number, phase?: ExportProgress['phase']) => void,
): Promise<ExportResult> {
  if (typeof MediaRecorder === 'undefined') throw new Error('Neither WebCodecs nor MediaRecorder is available in this browser.');
  const outFps = settings.fps;
  const totalOut = Math.max(1, Math.round(((endF - startF) / seq.settings.fps) * outFps));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const cctx = canvas.getContext('2d')!;
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as any;
  let audioCtx: AudioContext | null = null;
  if (settings.includeAudio) {
    onProgress({ phase: 'audio', frame: 0, totalFrames: totalOut, fps: 0, etaSeconds: 0 });
    const buf = await renderSequenceAudio(project, seq, startF, endF, settings.sampleRate);
    audioCtx = new AudioContext({ sampleRate: settings.sampleRate });
    const dest = audioCtx.createMediaStreamDestination();
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(dest);
    src.start();
    for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
  }
  const mimeCandidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  const mime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: settings.videoBitrate * 1000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((res) => (rec.onstop = () => res()));
  rec.start(250);
  const frameMs = 1000 / outFps;
  // Realtime pacing: MediaRecorder timestamps frames by wall clock.
  const t0 = performance.now();
  for (let i = 0; i < totalOut; i++) {
    if (signal.aborted) {
      rec.stop();
      audioCtx?.close();
      throw new ExportCancelled();
    }
    await renderOut(i);
    cctx.drawImage(frameCanvas, 0, 0, W, H);
    track.requestFrame?.();
    report(i);
    const target = t0 + (i + 1) * frameMs;
    const wait = target - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  rec.stop();
  await done;
  audioCtx?.close();
  const blob = new Blob(chunks, { type: mime || 'video/webm' });
  onProgress({ phase: 'done', frame: totalOut, totalFrames: totalOut, fps: 0, etaSeconds: 0, bytes: blob.size });
  return { blob, filename: `${settings.filename}.webm`, durationSeconds: totalOut / outFps, frames: totalOut };
}

export function downmixMono(buf: AudioBuffer): AudioBuffer {
  const ctx = new OfflineAudioContext(1, buf.length, buf.sampleRate);
  const out = ctx.createBuffer(1, buf.length, buf.sampleRate);
  const d = out.getChannelData(0);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const s = buf.getChannelData(c);
    for (let i = 0; i < s.length; i++) d[i] += s[i] / buf.numberOfChannels;
  }
  return out;
}

export function encodeWav(buf: AudioBuffer, channels: 1 | 2 = 2, bits: 16 | 24 = 16): Blob {
  const ch = Math.min(channels, buf.numberOfChannels);
  const n = buf.length;
  const bytesPer = bits / 8;
  const dataSize = n * ch * bytesPer;
  const ab = new ArrayBuffer(44 + dataSize);
  const v = new DataView(ab);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, buf.sampleRate, true);
  v.setUint32(28, buf.sampleRate * ch * bytesPer, true);
  v.setUint16(32, ch * bytesPer, true);
  v.setUint16(34, bits, true);
  str(36, 'data');
  v.setUint32(40, dataSize, true);
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      if (bits === 16) {
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      } else {
        const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        v.setUint8(o, x & 255);
        v.setUint8(o + 1, (x >> 8) & 255);
        v.setUint8(o + 2, (x >> 16) & 255);
        o += 3;
      }
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/** Compressed audio via mediabunny (AAC in m4a, or Opus in webm when AAC is unavailable). */
export async function encodeCompressedAudio(buf: AudioBuffer, settings: ExportSettings, _kind: 'mp3'): Promise<Blob> {
  const aac = await canEncodeAudio('aac').catch(() => false);
  const opus = !aac && (await canEncodeAudio('opus').catch(() => false));
  if (!aac && !opus) return encodeWav(buf, settings.channels);
  const target = new BufferTarget();
  const output = new Output({ format: aac ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(), target });
  const src = new AudioBufferSource({ codec: aac ? 'aac' : 'opus', bitrate: settings.audioBitrate * 1000 });
  output.addAudioTrack(src);
  await output.start();
  await src.add(settings.channels === 1 ? downmixMono(buf) : buf);
  src.close();
  await output.finalize();
  return new Blob([target.buffer!], { type: aac ? 'audio/mp4' : 'audio/webm' });
}

/** Export a single frame as PNG/JPEG. */
export async function exportFrame(project: Project, seq: Sequence, frame: number, format: 'png' | 'jpeg' = 'png'): Promise<Blob> {
  const comp = getCompositor();
  comp.releaseAll();
  const rt = await comp.renderFrame(project, seq, frame, { scale: 1, captions: true });
  const c = document.createElement('canvas');
  comp.drawToCanvas(rt, c);
  comp.release(rt);
  return new Promise((res) => c.toBlob((b) => res(b!), format === 'png' ? 'image/png' : 'image/jpeg', 0.95));
}

/* ---------- interchange formats ---------- */

export function exportEDL(project: Project, seq: Sequence): string {
  const fps = seq.settings.fps;
  const tc = (f: number) => {
    const nom = Math.round(fps);
    const ff = f % nom;
    const s = Math.floor(f / nom);
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
  };
  const lines: string[] = [`TITLE: ${seq.name}`, `FCM: ${seq.settings.dropFrame ? 'DROP FRAME' : 'NON-DROP FRAME'}`, ''];
  let n = 1;
  const vtracks = seq.tracks.filter((t) => t.kind === 'video');
  const atracks = seq.tracks.filter((t) => t.kind === 'audio');
  const clips = [...seq.clips].sort((a, b) => a.start - b.start);
  for (const c of clips) {
    const asset = project.assets.find((a) => a.id === c.assetId);
    const isV = vtracks.some((t) => t.id === c.trackId);
    const isA = atracks.some((t) => t.id === c.trackId);
    const chan = isV && isA ? 'B' : isV ? 'V' : 'A';
    const reel = (asset?.name ?? c.name).replace(/[^A-Za-z0-9]/g, '').slice(0, 8).padEnd(8, ' ') || 'AX      ';
    const srcIn = Math.round(c.inPoint * fps);
    const srcOut = srcIn + Math.round(c.duration * c.speed);
    lines.push(`${String(n).padStart(3, '0')}  ${reel} ${chan}     C        ${tc(srcIn)} ${tc(srcOut)} ${tc(c.start)} ${tc(c.start + c.duration)}`);
    lines.push(`* FROM CLIP NAME: ${c.name}`);
    if (c.speed !== 1) lines.push(`M2   ${reel}       ${(c.speed * fps).toFixed(1)}                ${tc(srcIn)}`);
    lines.push('');
    n++;
  }
  return lines.join('\n');
}

export function exportMarkersCSV(seq: Sequence): string {
  const fps = seq.settings.fps;
  const rows = [['Name', 'Comment', 'In (frames)', 'Out (frames)', 'In (s)', 'Duration (s)', 'Type', 'Color']];
  for (const m of [...seq.markers].sort((a, b) => a.time - b.time)) rows.push([m.name, m.comment, String(m.time), String(m.time + m.duration), (m.time / fps).toFixed(3), (m.duration / fps).toFixed(3), m.kind, m.color]);
  return rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
}

export function exportChaptersYouTube(seq: Sequence): string {
  const fps = seq.settings.fps;
  return [...seq.markers]
    .filter((m) => m.kind === 'chapter' || m.kind === 'comment')
    .sort((a, b) => a.time - b.time)
    .map((m) => {
      const s = Math.floor(m.time / fps);
      const h = Math.floor(s / 3600),
        mi = Math.floor((s % 3600) / 60),
        se = s % 60;
      return `${h ? h + ':' : ''}${String(mi).padStart(h ? 2 : 1, '0')}:${String(se).padStart(2, '0')} ${m.name || 'Chapter'}`;
    })
    .join('\n');
}
