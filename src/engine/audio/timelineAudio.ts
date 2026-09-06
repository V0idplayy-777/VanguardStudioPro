import type { Clip, Project, Sequence, Track } from '../../types/project';
import { getMedia } from '../media/mediaStore';
import { evalNumber } from '../keyframes';
import { dbToGain } from '../util';
import { buildAudioChain, type AudioChain } from './effectGraph';
import { audioFadeGain } from '../effects/transitions';
import { transitionAtCut, transitionRange, clipEnd, sourceTimeAt } from '../timeline/edits';

/*
  Realtime timeline audio. For each audio clip intersecting the playback window
  we create an AudioBufferSourceNode -> clip gain -> pan -> clip effects ->
  track chain -> master.  Automation (rubber bands, fades, keyframes) is applied
  by sampling the value curves at a fixed rate and scheduling gain ramps.
*/

interface ActiveClip {
  clip: Clip;
  src: AudioBufferSourceNode;
  gain: GainNode;
  pan: StereoPannerNode;
  chain: AudioChain;
  startedAt: number; // ctx time
  timelineStart: number; // seconds in sequence where this source began
  endsAt: number;
}

interface TrackNodes {
  track: Track;
  input: GainNode;
  chain: AudioChain;
  fader: GainNode;
  pan: StereoPannerNode;
  analyser: AnalyserNode;
  effectsKey: string;
}

export interface MeterReading {
  /** Peak per channel, linear 0..1+ */
  peak: [number, number];
  rms: [number, number];
}

export class TimelineAudio {
  ctx: AudioContext;
  master: GainNode;
  masterAnalyserL: AnalyserNode;
  masterAnalyserR: AnalyserNode;
  masterSplitter: ChannelSplitterNode;
  private tracks = new Map<string, TrackNodes>();
  private active = new Map<string, ActiveClip>();
  private playing = false;
  private rate = 1;
  private seqStartTime = 0; // sequence seconds when playback started
  private ctxStartTime = 0;
  private timer: number | null = null;
  private getProject: () => Project;
  private getSequence: () => Sequence | null;
  private soloActive = false;
  private muted = false;
  private meterBuf = new Float32Array(2048);
  private timeSampleL = new Float32Array(2048);
  private timeSampleR = new Float32Array(2048);
  private masterGainValue = 1;

  constructor(ctx: AudioContext, getProject: () => Project, getSequence: () => Sequence | null) {
    this.ctx = ctx;
    this.getProject = getProject;
    this.getSequence = getSequence;
    this.master = ctx.createGain();
    this.masterSplitter = ctx.createChannelSplitter(2);
    this.masterAnalyserL = ctx.createAnalyser();
    this.masterAnalyserR = ctx.createAnalyser();
    this.masterAnalyserL.fftSize = 2048;
    this.masterAnalyserR.fftSize = 2048;
    this.master.connect(ctx.destination);
    this.master.connect(this.masterSplitter);
    this.masterSplitter.connect(this.masterAnalyserL, 0);
    this.masterSplitter.connect(this.masterAnalyserR, 1);
  }

  setMasterGain(db: number) {
    this.masterGainValue = dbToGain(db);
    this.master.gain.setTargetAtTime(this.masterGainValue, this.ctx.currentTime, 0.01);
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.master.gain.setTargetAtTime(m ? 0 : this.masterGainValue, this.ctx.currentTime, 0.01);
  }

  private trackNodes(track: Track): TrackNodes {
    const key = JSON.stringify(track.effects.map((e) => [e.type, e.enabled, e.params]));
    let tn = this.tracks.get(track.id);
    if (tn && tn.effectsKey !== key) {
      tn.chain.dispose();
      tn.input.disconnect();
      tn.fader.disconnect();
      tn.pan.disconnect();
      this.tracks.delete(track.id);
      tn = undefined;
    }
    if (!tn) {
      const input = this.ctx.createGain();
      const chain = buildAudioChain(this.ctx, track.effects);
      const fader = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      input.connect(chain.input);
      chain.output.connect(fader).connect(pan).connect(this.master);
      pan.connect(analyser);
      tn = { track, input, chain, fader, pan, analyser, effectsKey: key };
      this.tracks.set(track.id, tn);
    }
    tn.track = track;
    return tn;
  }

  get isPlaying() {
    return this.playing;
  }

  /** Current sequence time in seconds derived from the audio clock. */
  currentTime(): number {
    if (!this.playing) return this.seqStartTime;
    return this.seqStartTime + (this.ctx.currentTime - this.ctxStartTime) * this.rate;
  }

  play(fromSeconds: number, rate = 1) {
    this.stop();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    this.playing = true;
    this.rate = rate;
    this.seqStartTime = fromSeconds;
    this.ctxStartTime = this.ctx.currentTime + 0.02;
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), 200);
  }

  stop() {
    this.playing = false;
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    for (const a of this.active.values()) this.teardown(a);
    this.active.clear();
  }

  /** Called when the sequence changes during playback to rebuild sources. */
  invalidate() {
    if (!this.playing) return;
    const t = this.currentTime();
    this.play(t, this.rate);
  }

  private teardown(a: ActiveClip) {
    try {
      a.src.stop();
    } catch {
      /* ignore */
    }
    try {
      a.src.disconnect();
      a.gain.disconnect();
      a.pan.disconnect();
      a.chain.dispose();
    } catch {
      /* ignore */
    }
  }

  private schedule() {
    const seq = this.getSequence();
    if (!seq || !this.playing) return;
    const fps = seq.settings.fps;
    const now = this.currentTime();
    const horizon = now + 1.0 * Math.max(1, Math.abs(this.rate));
    const tracks = seq.tracks.filter((t) => t.kind === 'audio');
    this.soloActive = tracks.some((t) => t.solo);
    // Update track state
    for (const t of tracks) {
      const tn = this.trackNodes(t);
      const audible = !t.muted && (!this.soloActive || t.solo);
      const nowFrame = Math.round(now * fps);
      const fader = audible ? dbToGain(evalNumber(t.volume, nowFrame)) : 0;
      tn.fader.gain.setTargetAtTime(fader, this.ctx.currentTime, 0.02);
      tn.pan.pan.setTargetAtTime(evalNumber(t.pan, nowFrame), this.ctx.currentTime, 0.02);
      tn.chain.update(nowFrame);
    }
    // Remove finished
    for (const [id, a] of this.active) {
      if (a.endsAt < this.ctx.currentTime - 0.1 || !seq.clips.includes(a.clip)) {
        this.teardown(a);
        this.active.delete(id);
      }
    }
    if (this.rate <= 0 || this.rate > 4) return; // reverse/fast shuttle: silent
    for (const clip of seq.clips) {
      const track = tracks.find((t) => t.id === clip.trackId);
      if (!track || !clip.enabled || clip.audio.muted) continue;
      if (this.active.has(clip.id)) continue;
      const media = getMedia(clip.assetId);
      let buffer = media?.audio;
      let nestedOffset = 0;
      if (!buffer && clip.nestedSequenceId) {
        // Nested sequences play their own audio through a flattened prerender when exported; for
        // realtime preview we mix the nested clips inline.
        continue;
      }
      if (!buffer) continue;
      const cs = clip.start / fps;
      const ce = clipEnd(clip) / fps;
      if (ce <= now || cs >= horizon) continue;
      const startSeq = Math.max(cs, now);
      const when = this.ctxStartTime + (startSeq - this.seqStartTime) / this.rate;
      const srcTime = sourceTimeAt(clip, startSeq * fps, fps) + nestedOffset;
      if (clip.reversed) continue; // reverse audio is not scheduled in realtime
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = clip.speed * this.rate;
      const gain = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      const chain = buildAudioChain(this.ctx, clip.effects);
      const tn = this.trackNodes(track);
      src.connect(gain).connect(pan).connect(chain.input);
      chain.output.connect(tn.input);
      // channel mode via channel splitting
      if (clip.audio.channelMode !== 'stereo' && buffer.numberOfChannels >= 2) {
        src.disconnect();
        const split = this.ctx.createChannelSplitter(2);
        const merge = this.ctx.createChannelMerger(2);
        src.connect(split);
        const mode = clip.audio.channelMode;
        if (mode === 'left') {
          split.connect(merge, 0, 0);
          split.connect(merge, 0, 1);
        } else if (mode === 'right') {
          split.connect(merge, 1, 0);
          split.connect(merge, 1, 1);
        } else if (mode === 'swap') {
          split.connect(merge, 0, 1);
          split.connect(merge, 1, 0);
        } else {
          split.connect(merge, 0, 0);
          split.connect(merge, 1, 0);
          split.connect(merge, 0, 1);
          split.connect(merge, 1, 1);
        }
        merge.connect(gain);
      }
      if (clip.audio.invertPhase) {
        gain.gain.value = -1;
      }
      // automation: sample every 1/20 s over the clip remaining duration up to horizon+2s
      const stepSec = 0.05;
      const endSeq = Math.min(ce, horizon + 3);
      const staticGain = dbToGain(clip.audio.gain);
      const sign = clip.audio.invertPhase ? -1 : 1;
      const values: number[] = [];
      const pans: number[] = [];
      const inRange = transitionRange(seq, clip, 'in');
      const outRange = transitionRange(seq, clip, 'out');
      const inInfo = transitionAtCut(seq, clip, 'in');
      const outInfo = transitionAtCut(seq, clip, 'out');
      for (let s = startSeq; s <= endSeq + stepSec; s += stepSec) {
        const f = s * fps;
        const local = f - clip.start;
        let g = dbToGain(evalNumber(clip.audio.volume, local)) * staticGain;
        if (inRange && f >= inRange[0] && f < inRange[1]) g *= audioFadeGain(inInfo!.transition.type, (f - inRange[0]) / (inRange[1] - inRange[0]), true);
        if (outRange && f >= outRange[0] && f < outRange[1]) g *= audioFadeGain(outInfo!.transition.type, (f - outRange[0]) / (outRange[1] - outRange[0]), false);
        values.push(g * sign);
        pans.push(Math.max(-1, Math.min(1, evalNumber(clip.audio.pan, local))));
      }
      const dur = (endSeq - startSeq) / this.rate;
      try {
        gain.gain.setValueCurveAtTime(new Float32Array(values.length ? values : [staticGain]), when, Math.max(dur, 0.01));
        pan.pan.setValueCurveAtTime(new Float32Array(pans.length ? pans : [0]), when, Math.max(dur, 0.01));
      } catch {
        gain.gain.value = values[0] ?? staticGain;
      }
      const playDur = (ce - startSeq) / this.rate;
      const offset = Math.max(0, Math.min(buffer.duration - 0.001, srcTime));
      try {
        src.start(when, offset, Math.max(0.001, Math.min(playDur * clip.speed * this.rate, buffer.duration - offset)));
      } catch {
        continue;
      }
      chain.update(Math.round(startSeq * fps - clip.start));
      this.active.set(clip.id, { clip, src, gain, pan, chain, startedAt: when, timelineStart: startSeq, endsAt: when + playDur });
    }
  }

  /** Master peak/rms meter reading. */
  readMaster(): MeterReading {
    this.masterAnalyserL.getFloatTimeDomainData(this.timeSampleL);
    this.masterAnalyserR.getFloatTimeDomainData(this.timeSampleR);
    const calc = (d: Float32Array) => {
      let peak = 0,
        sum = 0;
      for (let i = 0; i < d.length; i++) {
        const v = Math.abs(d[i]);
        if (v > peak) peak = v;
        sum += d[i] * d[i];
      }
      return { peak, rms: Math.sqrt(sum / d.length) };
    };
    const l = calc(this.timeSampleL),
      r = calc(this.timeSampleR);
    return { peak: [l.peak, r.peak], rms: [l.rms, r.rms] };
  }

  readTrack(trackId: string): MeterReading | null {
    const tn = this.tracks.get(trackId);
    if (!tn) return null;
    const d = this.meterBuf.subarray(0, tn.analyser.fftSize);
    tn.analyser.getFloatTimeDomainData(d);
    let peak = 0,
      sum = 0;
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
      sum += d[i] * d[i];
    }
    const rms = Math.sqrt(sum / d.length);
    return { peak: [peak, peak], rms: [rms, rms] };
  }

  /** Frequency data for the spectrum scope. */
  readSpectrum(out: Uint8Array) {
    this.masterAnalyserL.getByteFrequencyData(out as Uint8Array<ArrayBuffer>);
  }

  dispose() {
    this.stop();
    for (const tn of this.tracks.values()) {
      tn.chain.dispose();
      tn.input.disconnect();
    }
    this.tracks.clear();
  }
}

/** Offline mix of a sequence range into an AudioBuffer (used by export and loudness analysis). */
export async function renderSequenceAudio(project: Project, seq: Sequence, startFrame: number, endFrame: number, sampleRate = 48000, onProgress?: (p: number) => void): Promise<AudioBuffer> {
  const fps = seq.settings.fps;
  const durationSec = Math.max(0.01, (endFrame - startFrame) / fps);
  const length = Math.ceil(durationSec * sampleRate);
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  const master = ctx.createGain();
  master.connect(ctx.destination);
  const tracks = seq.tracks.filter((t) => t.kind === 'audio');
  const soloActive = tracks.some((t) => t.solo);
  const trackChains = new Map<string, { input: GainNode; chain: AudioChain }>();
  for (const t of tracks) {
    const input = ctx.createGain();
    const chain = buildAudioChain(ctx, t.effects);
    const fader = ctx.createGain();
    const pan = ctx.createStereoPanner();
    input.connect(chain.input);
    chain.output.connect(fader).connect(pan).connect(master);
    const audible = !t.muted && (!soloActive || t.solo);
    // sample track automation
    const step = 0.05;
    const gains: number[] = [],
      pans: number[] = [];
    for (let s = 0; s <= durationSec + step; s += step) {
      const f = startFrame + s * fps;
      gains.push(audible ? dbToGain(evalNumber(t.volume, f)) : 0);
      pans.push(evalNumber(t.pan, f));
    }
    fader.gain.setValueCurveAtTime(new Float32Array(gains), 0, durationSec + step);
    pan.pan.setValueCurveAtTime(new Float32Array(pans), 0, durationSec + step);
    chain.update(startFrame);
    trackChains.set(t.id, { input, chain });
  }
  const buffers = await collectClipBuffers(project, seq, ctx, startFrame, endFrame);
  for (const { clip, buffer } of buffers) {
    const tc = trackChains.get(clip.trackId);
    if (!tc) continue;
    const cs = clip.start / fps,
      ce = clipEnd(clip) / fps;
    const winStart = startFrame / fps,
      winEnd = endFrame / fps;
    const s0 = Math.max(cs, winStart),
      s1 = Math.min(ce, winEnd);
    if (s1 <= s0) continue;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = clip.speed;
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    const chain = buildAudioChain(ctx, clip.effects);
    src.connect(gain).connect(pan).connect(chain.input);
    chain.output.connect(tc.input);
    const staticGain = dbToGain(clip.audio.gain) * (clip.audio.invertPhase ? -1 : 1);
    const step = 0.02;
    const values: number[] = [],
      pans: number[] = [];
    const inRange = transitionRange(seq, clip, 'in');
    const outRange = transitionRange(seq, clip, 'out');
    const inInfo = transitionAtCut(seq, clip, 'in');
    const outInfo = transitionAtCut(seq, clip, 'out');
    for (let s = s0; s <= s1 + step; s += step) {
      const f = s * fps;
      const local = f - clip.start;
      let g = dbToGain(evalNumber(clip.audio.volume, local)) * staticGain;
      if (inRange && f >= inRange[0] && f < inRange[1]) g *= audioFadeGain(inInfo!.transition.type, (f - inRange[0]) / (inRange[1] - inRange[0]), true);
      if (outRange && f >= outRange[0] && f < outRange[1]) g *= audioFadeGain(outInfo!.transition.type, (f - outRange[0]) / (outRange[1] - outRange[0]), false);
      values.push(g);
      pans.push(Math.max(-1, Math.min(1, evalNumber(clip.audio.pan, local))));
    }
    const when = s0 - winStart;
    const dur = s1 - s0;
    gain.gain.setValueCurveAtTime(new Float32Array(values), when, dur + step);
    pan.pan.setValueCurveAtTime(new Float32Array(pans), when, dur + step);
    const offset = clip.reversed ? 0 : Math.max(0, Math.min(buffer.duration - 0.001, sourceTimeAt(clip, s0 * fps, fps)));
    try {
      src.start(when, offset, Math.min(dur * clip.speed, buffer.duration - offset));
    } catch {
      /* ignore */
    }
    chain.update(Math.round(s0 * fps - clip.start));
  }
  onProgress?.(0.5);
  const out = await ctx.startRendering();
  onProgress?.(1);
  return out;
}

async function collectClipBuffers(project: Project, seq: Sequence, ctx: BaseAudioContext, startFrame: number, endFrame: number): Promise<{ clip: Clip; buffer: AudioBuffer }[]> {
  const fps = seq.settings.fps;
  const out: { clip: Clip; buffer: AudioBuffer }[] = [];
  const audioTrackIds = new Set(seq.tracks.filter((t) => t.kind === 'audio').map((t) => t.id));
  for (const clip of seq.clips) {
    if (!audioTrackIds.has(clip.trackId) || !clip.enabled || clip.audio.muted) continue;
    if (clipEnd(clip) <= startFrame || clip.start >= endFrame) continue;
    let buffer = getMedia(clip.assetId)?.audio;
    if (!buffer && clip.nestedSequenceId) {
      const nested = project.sequences.find((s) => s.id === clip.nestedSequenceId);
      if (nested) {
        const frames = Math.round(clip.duration * clip.speed + clip.inPoint * fps);
        buffer = await renderSequenceAudio(project, nested, 0, Math.max(1, frames), ctx.sampleRate);
      }
    }
    if (!buffer) continue;
    if (clip.reversed) buffer = reverseBuffer(ctx, buffer);
    out.push({ clip, buffer });
  }
  return out;
}

export function reverseBuffer(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const s = buf.getChannelData(c);
    const d = out.getChannelData(c);
    for (let i = 0, n = s.length; i < n; i++) d[i] = s[n - 1 - i];
  }
  return out;
}

/* ---------- loudness (ITU-R BS.1770 style) ---------- */

export function measureLoudness(buf: AudioBuffer): { integrated: number; shortTermMax: number; momentaryMax: number; truePeak: number; range: number } {
  const sr = buf.sampleRate;
  const ch = Math.min(2, buf.numberOfChannels);
  // K-weighting: high shelf + high pass, biquad coefficients for 48k approximated per sample rate
  const filt = (data: Float32Array): Float32Array => {
    // Stage 1: shelving
    const f0 = 1681.974450955533,
      G = 3.999843853973347,
      Q = 0.7071752369554196;
    const K = Math.tan((Math.PI * f0) / sr);
    const Vh = Math.pow(10, G / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;
    const b0 = (Vh + (Vb * K) / Q + K * K) / a0,
      b1 = (2 * (K * K - Vh)) / a0,
      b2 = (Vh - (Vb * K) / Q + K * K) / a0;
    const a1 = (2 * (K * K - 1)) / a0,
      a2 = (1 - K / Q + K * K) / a0;
    // Stage 2: highpass
    const f1 = 38.13547087602444,
      Q1 = 0.5003270373238773;
    const K1 = Math.tan((Math.PI * f1) / sr);
    const a01 = 1 + K1 / Q1 + K1 * K1;
    const hb0 = 1 / a01,
      hb1 = -2 / a01,
      hb2 = 1 / a01;
    const ha1 = (2 * (K1 * K1 - 1)) / a01,
      ha2 = (1 - K1 / Q1 + K1 * K1) / a01;
    const out = new Float32Array(data.length);
    let x1 = 0,
      x2 = 0,
      y1 = 0,
      y2 = 0;
    let X1 = 0,
      X2 = 0,
      Y1 = 0,
      Y2 = 0;
    for (let i = 0; i < data.length; i++) {
      const x = data[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      const z = hb0 * y + hb1 * X1 + hb2 * X2 - ha1 * Y1 - ha2 * Y2;
      X2 = X1;
      X1 = y;
      Y2 = Y1;
      Y1 = z;
      out[i] = z;
    }
    return out;
  };
  const chans: Float32Array[] = [];
  let truePeak = 0;
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i]);
      if (v > truePeak) truePeak = v;
    }
    chans.push(filt(d));
  }
  // 400ms blocks with 75% overlap
  const block = Math.floor(sr * 0.4);
  const hop = Math.floor(block / 4);
  const blocks: number[] = [];
  const n = chans[0].length;
  const prefix = chans.map((d) => {
    const p = new Float64Array(d.length + 1);
    for (let i = 0; i < d.length; i++) p[i + 1] = p[i] + d[i] * d[i];
    return p;
  });
  for (let s = 0; s + block <= n; s += hop) {
    let z = 0;
    for (let c = 0; c < ch; c++) z += (prefix[c][s + block] - prefix[c][s]) / block;
    blocks.push(-0.691 + 10 * Math.log10(Math.max(z, 1e-12)));
  }
  const abs = blocks.filter((l) => l > -70);
  const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + Math.pow(10, (b + 0.691) / 10), 0) / arr.length : 1e-12);
  const gateRel = -0.691 + 10 * Math.log10(mean(abs)) - 10;
  const gated = abs.filter((l) => l > gateRel);
  const integrated = gated.length ? -0.691 + 10 * Math.log10(mean(gated)) : -Infinity;
  const momentaryMax = blocks.length ? Math.max(...blocks) : -Infinity;
  // short-term: 3s windows
  const sBlock = Math.floor(sr * 3);
  const sBlocks: number[] = [];
  for (let s = 0; s + sBlock <= n; s += Math.floor(sr * 0.1)) {
    let z = 0;
    for (let c = 0; c < ch; c++) z += (prefix[c][s + sBlock] - prefix[c][s]) / sBlock;
    sBlocks.push(-0.691 + 10 * Math.log10(Math.max(z, 1e-12)));
  }
  const shortTermMax = sBlocks.length ? Math.max(...sBlocks) : momentaryMax;
  const sorted = sBlocks.filter((l) => l > -70 && l > gateRel - 10).sort((a, b) => a - b);
  const range = sorted.length > 10 ? sorted[Math.floor(sorted.length * 0.95)] - sorted[Math.floor(sorted.length * 0.1)] : 0;
  return { integrated, shortTermMax, momentaryMax, truePeak: 20 * Math.log10(Math.max(truePeak, 1e-9)), range };
}
