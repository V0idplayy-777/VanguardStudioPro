import { importFiles } from './importer';
import { getSharedAudioContext } from '../audio/audioContext';
import { toast, logEvent } from '../../state/uiStore';
import type { MediaAsset } from '../../types/project';

/*
  In-app capture: voiceover from the microphone, screen/tab capture and
  webcam. Everything records through MediaRecorder into a webm/mp4 blob that
  goes through the normal import pipeline, so captured media behaves like any
  other file (waveforms, thumbnails, relinking, export).
*/

export type CaptureKind = 'voiceover' | 'screen' | 'webcam';

export interface CaptureSession {
  kind: CaptureKind;
  /** ms since recording actually started (after the count-in) */
  elapsed: () => number;
  /** Peak level 0..1 from the input (null when there is no audio track). */
  level: () => number | null;
  /** True once the user stopped the shared screen from the browser bar. */
  externallyEnded: () => boolean;
  /** Live preview into a <video> element. */
  attachPreview: (el: HTMLVideoElement | null) => void;
  stop: () => Promise<CaptureResult>;
}

export interface CaptureResult {
  blob: Blob;
  mime: string;
  durationSec: number;
  extension: string;
}

function pickMime(audioOnly: boolean): string {
  const candidates = audioOnly
    ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4']
    : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'];
  return candidates.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ?? '';
}

function makeLevelMeter(stream: MediaStream): () => number | null {
  try {
    const ctx = getSharedAudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let peak: number | null = 0;
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let p = 0;
      for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
      peak = p;
    };
    const iv = window.setInterval(tick, 50);
    return () => {
      window.clearInterval(iv);
      try {
        src.disconnect();
      } catch {
        /* already gone */
      }
      return peak;
    };
  } catch {
    return () => null;
  }
}

export async function startCapture(kind: CaptureKind, opts: { videoWidth?: number; videoHeight?: number; deviceId?: string } = {}): Promise<CaptureSession> {
  if (typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record (MediaRecorder unavailable).');

  const audioConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
    ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
  };
  let stream: MediaStream;
  if (kind === 'voiceover') {
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  } else if (kind === 'screen') {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true, // user opt-in in the picker; optional
    });
  } else {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: opts.videoWidth ?? 1280 }, height: { ideal: opts.videoHeight ?? 720 }, frameRate: { ideal: 30 } },
      audio: audioConstraints,
    });
  }

  const hasAudio = stream.getAudioTracks().length > 0;
  const hasVideo = stream.getVideoTracks().length > 0;
  const mime = pickMime(!hasVideo);
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, ...(hasVideo ? { videoBitsPerSecond: 8_000_000 } : {}), ...(hasAudio ? { audioBitsPerSecond: 192_000 } : {}) } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
  const stopped = new Promise<void>((res) => {
    rec.onstop = () => res();
  });

  let externalEnd = false;
  const trackEnd = () => {
    externalEnd = true;
    try {
      if (rec.state !== 'inactive') rec.stop();
    } catch {
      /* ignore */
    }
  };
  for (const t of stream.getTracks()) t.addEventListener('ended', trackEnd, { once: true });

  const level = hasAudio ? makeLevelMeter(stream) : () => null;
  const t0 = performance.now();
  rec.start(500);

  const cleanup = () => {
    for (const t of stream.getTracks()) {
      t.removeEventListener('ended', trackEnd);
      t.stop();
    }
    level(); // clears the meter interval
    if (previewEl) previewEl.srcObject = null;
  };

  let previewEl: HTMLVideoElement | null = null;
  return {
    kind,
    elapsed: () => performance.now() - t0,
    level,
    externallyEnded: () => externalEnd,
    attachPreview: (el) => {
      if (previewEl && previewEl !== el) {
        previewEl.srcObject = null;
      }
      previewEl = el;
      if (el) {
        el.srcObject = stream;
        el.muted = true;
        void el.play().catch(() => {});
      }
    },
    stop: async () => {
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      cleanup();
      const type = mime || (hasVideo ? 'video/webm' : 'audio/webm');
      const blob = new Blob(chunks, { type });
      const durationSec = (performance.now() - t0) / 1000;
      const extension = type.includes('mp4') ? 'mp4' : 'webm';
      logEvent('info', `Captured ${kind}`, `${blob.size} bytes, ${durationSec.toFixed(1)} s`);
      return { blob, mime: type, durationSec, extension };
    },
  };
}

/** Import a finished capture into the project. */
export async function importCapture(result: CaptureResult, name: string): Promise<MediaAsset[]> {
  const ext = result.extension;
  const file = new File([result.blob], `${name}.${ext}`, { type: result.mime, lastModified: Date.now() });
  return importFiles([file]);
}
