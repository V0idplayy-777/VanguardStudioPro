import type { CaptionItem, CaptionStyle, Project, Sequence } from '../../types/project';
import { uid } from '../util';
import { useSettings } from '../../state/settingsStore';
import { renderSequenceAudio } from '../audio/timelineAudio';

/*
  Real speech-to-text captions, powered by OpenAI Whisper running locally in
  the browser (Transformers.js + ONNX). The model downloads once from a CDN
  and is cached by the browser; transcription itself never leaves the machine.

  No server, no API key, no fake placeholder text: if the model cannot load,
  the dialog reports the exact failure instead of inventing captions.
*/

const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

export type SttModelId = 'tiny.en' | 'tiny' | 'base' | 'small';

export const STT_MODELS: { id: SttModelId; name: string; size: string; desc: string; repo: string }[] = [
  { id: 'tiny.en', name: 'Tiny English', size: '~150 MB', desc: 'Fastest. Best for clear English dialogue.', repo: 'Xenova/whisper-tiny.en' },
  { id: 'tiny', name: 'Tiny Multilingual', size: '~150 MB', desc: 'Fast, understands 90+ languages.', repo: 'Xenova/whisper-tiny' },
  { id: 'base', name: 'Base Multilingual', size: '~200 MB', desc: 'Noticeably more accurate, still quick.', repo: 'Xenova/whisper-base' },
  { id: 'small', name: 'Small Multilingual', size: '~500 MB', desc: 'Most accurate here — but slow on modest machines.', repo: 'Xenova/whisper-small' },
];

export const STT_LANGUAGES: { id: string; name: string }[] = [
  { id: 'auto', name: 'Auto-detect' },
  { id: 'english', name: 'English' },
  { id: 'spanish', name: 'Spanish' },
  { id: 'french', name: 'French' },
  { id: 'german', name: 'German' },
  { id: 'italian', name: 'Italian' },
  { id: 'portuguese', name: 'Portuguese' },
  { id: 'dutch', name: 'Dutch' },
  { id: 'russian', name: 'Russian' },
  { id: 'japanese', name: 'Japanese' },
  { id: 'chinese', name: 'Chinese' },
  { id: 'korean', name: 'Korean' },
  { id: 'hindi', name: 'Hindi' },
  { id: 'arabic', name: 'Arabic' },
];

export interface SttSegment {
  /** Seconds relative to the transcribed window. */
  start: number;
  end: number;
  text: string;
}

type ProgressFn = (phase: 'model' | 'audio' | 'transcribe', progress: number, message: string) => void;

let transcriberPromise: Promise<any> | null = null;
let transcriberModel: SttModelId | null = null;
let cancelFlag = false;
export function cancelTranscription() {
  cancelFlag = true;
}

async function loadTranscriber(model: SttModelId, onProgress: ProgressFn): Promise<any> {
  if (transcriberPromise && transcriberModel === model) return transcriberPromise;
  transcriberModel = model;
  transcriberPromise = (async () => {
    const meta = STT_MODELS.find((m) => m.id === model) ?? STT_MODELS[0];
    onProgress('model', 0, 'Loading transcription engine…');
    const mod = await import(/* @vite-ignore */ TRANSFORMERS_CDN);
    if (mod.env) {
      mod.env.allowLocalModels = false;
      mod.env.useBrowserCache = true;
    }
    onProgress('model', 0.05, `Downloading ${meta.name} model (once)…`);
    const pipe = await mod.pipeline('automatic-speech-recognition', meta.repo, {
      progress_callback: (info: any) => {
        if (info && typeof info.progress === 'number') {
          onProgress('model', 0.05 + Math.min(0.9, info.progress * 0.9), `Downloading model… ${Math.round(info.progress * 100)}%`);
        }
      },
    });
    onProgress('model', 1, 'Model ready');
    return pipe;
  })().catch((e) => {
    transcriberPromise = null;
    transcriberModel = null;
    throw e;
  });
  return transcriberPromise;
}

function mixdownTo16kMono(buf: AudioBuffer): Float32Array {
  const sr = buf.sampleRate;
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const targetLen = Math.floor((buf.length / sr) * 16000);
  const out = new Float32Array(targetLen);
  const ratio = sr / 16000;
  for (let i = 0; i < targetLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src),
      frac = src - i0;
    const a0 = ch0[Math.min(ch0.length - 1, i0)] ?? 0;
    const a1 = ch0[Math.min(ch0.length - 1, i0 + 1)] ?? 0;
    let v = a0 + (a1 - a0) * frac;
    if (ch1) {
      const b0 = ch1[Math.min(ch1.length - 1, i0)] ?? 0;
      const b1 = ch1[Math.min(ch1.length - 1, i0 + 1)] ?? 0;
      v = (v + (b0 + (b1 - b0) * frac)) / 2;
    }
    out[i] = v;
  }
  // normalize lightly so quiet dialogue still transcribes
  let peak = 0;
  for (let i = 0; i < out.length; i += 7) {
    const v = Math.abs(out[i]);
    if (v > peak) peak = v;
  }
  if (peak > 0.02 && peak < 0.5) {
    const g = 0.5 / peak;
    for (let i = 0; i < out.length; i++) out[i] *= g;
  }
  return out;
}

export interface TranscribeOptions {
  model?: SttModelId;
  language?: string;
  onProgress?: ProgressFn;
}

/** Transcribe a sequence frame range into timed segments. */
export async function transcribeRange(project: Project, seq: Sequence, startFrame: number, endFrame: number, opts: TranscribeOptions = {}): Promise<SttSegment[]> {
  cancelFlag = false;
  const onProgress = opts.onProgress ?? (() => undefined);
  const model = opts.model ?? useSettings.getState().sttModel ?? 'tiny.en';
  const language = opts.language ?? useSettings.getState().sttLanguage ?? 'auto';
  onProgress('audio', 0, 'Mixing sequence audio…');
  const mix = await renderSequenceAudio(project, seq, startFrame, endFrame, 48000, (p) => onProgress('audio', p * 0.9, 'Mixing sequence audio…'));
  if (cancelFlag) throw new Error('cancelled');
  // Silence check — refuse to hallucinate on mute tracks.
  let energy = 0;
  const probe = mix.getChannelData(0);
  for (let i = 0; i < probe.length; i += 97) energy += probe[i] * probe[i];
  energy /= Math.max(1, Math.floor(probe.length / 97));
  if (energy < 1e-8) throw new Error('silent');
  const audio = mixdownTo16kMono(mix);
  onProgress('audio', 1, 'Audio ready');
  const transcriber = await loadTranscriber(model, onProgress);
  if (cancelFlag) throw new Error('cancelled');
  onProgress('transcribe', 0, 'Transcribing… (this runs on your machine)');
  const isEnOnly = model === 'tiny.en';
  const options: Record<string, unknown> = {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: 'sentence',
    sampling_rate: 16000,
  };
  if (!isEnOnly && language && language !== 'auto') {
    options.language = language;
    options.task = 'transcribe';
  }
  // Approximate progress: whisper decodes ~realtime; tick while it works.
  let tick = 0;
  const tickTimer = window.setInterval(() => {
    tick = Math.min(0.95, tick + 0.02);
    onProgress('transcribe', tick, 'Transcribing… (this runs on your machine)');
  }, 800);
  try {
    const result = await transcriber(audio, options);
    if (cancelFlag) throw new Error('cancelled');
    const chunks = (result?.chunks ?? []) as { timestamp: [number | null, number | null]; text: string }[];
    const segments: SttSegment[] = [];
    for (const c of chunks) {
      const text = (c.text ?? '').trim();
      if (!text) continue;
      const start = Math.max(0, c.timestamp?.[0] ?? 0);
      const end = Math.max(start + 0.4, c.timestamp?.[1] ?? start + 2);
      segments.push({ start, end, text });
    }
    // Fallback: some builds return plain text when timestamps fail.
    if (!segments.length && typeof result?.text === 'string' && result.text.trim()) {
      const dur = mix.duration;
      segments.push({ start: 0, end: dur, text: result.text.trim() });
    }
    onProgress('transcribe', 1, `Found ${segments.length} caption${segments.length === 1 ? '' : 's'}`);
    return mergeShortSegments(segments);
  } finally {
    window.clearInterval(tickTimer);
  }
}

function mergeShortSegments(segs: SttSegment[]): SttSegment[] {
  const out: SttSegment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && s.start - last.end < 0.25 && (last.text + ' ' + s.text).length < 90) {
      last.end = s.end;
      last.text = `${last.text} ${s.text}`;
    } else out.push({ ...s });
  }
  return out;
}

/** Wrap segment text to broadcast-safe two-liners and map to sequence frames. */
export function segmentsToCaptions(segments: SttSegment[], windowStartFrame: number, fps: number, style?: Partial<CaptionStyle>): CaptionItem[] {
  const captions: CaptionItem[] = [];
  for (const s of segments) {
    const startF = windowStartFrame + Math.round(s.start * fps);
    const endF = windowStartFrame + Math.round(s.end * fps);
    const lines = wrapText(s.text, 42);
    if (lines.length <= 2) {
      captions.push(makeCaption(startF, endF, lines.join('\n'), style));
    } else {
      // split long sentences across captions, proportionally in time
      const span = Math.max(1, endF - startF);
      for (let i = 0; i < lines.length; i += 2) {
        const chunk = lines.slice(i, i + 2).join('\n');
        const t0 = startF + Math.round((span * i) / lines.length);
        const t1 = startF + Math.round((span * Math.min(lines.length, i + 2)) / lines.length);
        captions.push(makeCaption(t0, Math.max(t0 + 1, t1), chunk, style));
      }
    }
  }
  return captions;
}

function makeCaption(start: number, end: number, text: string, style?: Partial<CaptionStyle>): CaptionItem {
  return { id: uid('cap'), start, end, text, style: { align: 'center', ...style } };
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}
