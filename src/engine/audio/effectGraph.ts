import type { EffectInstance } from '../../types/project';
import { evalParam } from '../keyframes';
import { dbToGain } from '../util';
import { buildImpulse, makeDistortionCurve } from './audioContext';

/*
  Builds a Web Audio node chain for a list of audio effect instances.
  Returns input/output nodes plus an `update(frame)` to animate keyframed params.
*/

export interface AudioChain {
  input: AudioNode;
  output: AudioNode;
  update: (frame: number) => void;
  dispose: () => void;
}

type Num = (key: string, frame: number) => number;

function makeNum(e: EffectInstance): Num {
  return (key, frame) => {
    const p = e.params[key];
    if (!p) return 0;
    const v = evalParam(p, frame);
    return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0;
  };
}

interface Built {
  input: AudioNode;
  output: AudioNode;
  update?: (frame: number) => void;
  nodes: AudioNode[];
}

function passthrough(ctx: BaseAudioContext): Built {
  const g = ctx.createGain();
  return { input: g, output: g, nodes: [g] };
}

function buildOne(ctx: BaseAudioContext, e: EffectInstance): Built {
  const n = makeNum(e);
  const t = ctx.currentTime;
  switch (e.type) {
    case 'aParametricEq': {
      const low = ctx.createBiquadFilter();
      low.type = 'lowshelf';
      const b1 = ctx.createBiquadFilter();
      b1.type = 'peaking';
      const b2 = ctx.createBiquadFilter();
      b2.type = 'peaking';
      const b3 = ctx.createBiquadFilter();
      b3.type = 'peaking';
      const high = ctx.createBiquadFilter();
      high.type = 'highshelf';
      const out = ctx.createGain();
      low.connect(b1).connect(b2).connect(b3).connect(high).connect(out);
      const update = (f: number) => {
        low.frequency.setTargetAtTime(n('lowFreq', f), t, 0.01);
        low.gain.setTargetAtTime(n('lowGain', f), t, 0.01);
        b1.frequency.setTargetAtTime(n('b1Freq', f), t, 0.01);
        b1.gain.setTargetAtTime(n('b1Gain', f), t, 0.01);
        b1.Q.setTargetAtTime(n('b1Q', f), t, 0.01);
        b2.frequency.setTargetAtTime(n('b2Freq', f), t, 0.01);
        b2.gain.setTargetAtTime(n('b2Gain', f), t, 0.01);
        b2.Q.setTargetAtTime(n('b2Q', f), t, 0.01);
        b3.frequency.setTargetAtTime(n('b3Freq', f), t, 0.01);
        b3.gain.setTargetAtTime(n('b3Gain', f), t, 0.01);
        b3.Q.setTargetAtTime(n('b3Q', f), t, 0.01);
        high.frequency.setTargetAtTime(n('highFreq', f), t, 0.01);
        high.gain.setTargetAtTime(n('highGain', f), t, 0.01);
        out.gain.setTargetAtTime(dbToGain(n('output', f)), t, 0.01);
      };
      update(0);
      return { input: low, output: out, update, nodes: [low, b1, b2, b3, high, out] };
    }
    case 'aHighPass':
    case 'aLowPass':
    case 'aBandPass':
    case 'aNotch': {
      const f = ctx.createBiquadFilter();
      f.type = e.type === 'aHighPass' ? 'highpass' : e.type === 'aLowPass' ? 'lowpass' : e.type === 'aBandPass' ? 'bandpass' : 'notch';
      const key = e.type === 'aBandPass' || e.type === 'aNotch' ? 'center' : 'cutoff';
      const update = (fr: number) => {
        f.frequency.setTargetAtTime(n(key, fr), t, 0.01);
        f.Q.setTargetAtTime(n('q', fr), t, 0.01);
      };
      update(0);
      return { input: f, output: f, update, nodes: [f] };
    }
    case 'aBassTreble': {
      const low = ctx.createBiquadFilter();
      low.type = 'lowshelf';
      low.frequency.value = 200;
      const high = ctx.createBiquadFilter();
      high.type = 'highshelf';
      high.frequency.value = 4000;
      low.connect(high);
      const update = (fr: number) => {
        low.gain.setTargetAtTime(n('bass', fr), t, 0.01);
        high.gain.setTargetAtTime(n('treble', fr), t, 0.01);
      };
      update(0);
      return { input: low, output: high, update, nodes: [low, high] };
    }
    case 'aCompressor': {
      const c = ctx.createDynamicsCompressor();
      const makeup = ctx.createGain();
      c.connect(makeup);
      const update = (fr: number) => {
        c.threshold.setTargetAtTime(n('threshold', fr), t, 0.01);
        c.ratio.setTargetAtTime(Math.max(1, n('ratio', fr)), t, 0.01);
        c.knee.setTargetAtTime(n('knee', fr), t, 0.01);
        c.attack.setTargetAtTime(n('attack', fr) / 1000, t, 0.01);
        c.release.setTargetAtTime(n('release', fr) / 1000, t, 0.01);
        makeup.gain.setTargetAtTime(dbToGain(n('makeup', fr)), t, 0.01);
      };
      update(0);
      return { input: c, output: makeup, update, nodes: [c, makeup] };
    }
    case 'aLimiter': {
      const boost = ctx.createGain();
      const c = ctx.createDynamicsCompressor();
      c.ratio.value = 20;
      c.knee.value = 0;
      c.attack.value = 0.001;
      boost.connect(c);
      const update = (fr: number) => {
        boost.gain.setTargetAtTime(dbToGain(n('inputBoost', fr)), t, 0.01);
        c.threshold.setTargetAtTime(n('ceiling', fr), t, 0.01);
        c.release.setTargetAtTime(n('release', fr) / 1000, t, 0.01);
      };
      update(0);
      return { input: boost, output: c, update, nodes: [boost, c] };
    }
    case 'aGate':
    case 'aExpander': {
      // Envelope follower driven gate using an analyser polled from update().
      const input = ctx.createGain();
      const gate = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      input.connect(gate);
      input.connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      let env = 0;
      let raf = 0;
      const tick = () => {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        const db = rms > 0 ? 20 * Math.log10(rms) : -100;
        const thr = n('threshold', lastFrame);
        const atk = Math.max(1, n('attack', lastFrame)) / 1000;
        const rel = Math.max(5, n('release', lastFrame)) / 1000;
        let target: number;
        if (e.type === 'aGate') {
          const range = dbToGain(n('range', lastFrame));
          target = db > thr ? 1 : range;
        } else {
          const ratio = Math.max(1, n('ratio', lastFrame));
          target = db > thr ? 1 : dbToGain((db - thr) * (ratio - 1));
        }
        const coef = target > env ? atk : rel;
        gate.gain.setTargetAtTime(target, ctx.currentTime, coef);
        env = target;
        raf = requestAnimationFrame(tick);
      };
      let lastFrame = 0;
      raf = requestAnimationFrame(tick);
      const update = (fr: number) => {
        lastFrame = fr;
      };
      const built: Built & { stop?: () => void } = { input, output: gate, update, nodes: [input, gate, analyser] };
      (built as any).stop = () => cancelAnimationFrame(raf);
      return built;
    }
    case 'aDeEsser': {
      const input = ctx.createGain();
      const split = ctx.createBiquadFilter();
      split.type = 'bandpass';
      split.Q.value = 2;
      const comp = ctx.createDynamicsCompressor();
      comp.ratio.value = 8;
      comp.attack.value = 0.001;
      comp.release.value = 0.05;
      const inv = ctx.createGain();
      inv.gain.value = -1;
      const merge = ctx.createGain();
      // Dry + (compressed band - band) approximates reduction of sibilant band
      input.connect(merge);
      input.connect(split);
      split.connect(comp).connect(merge);
      split.connect(inv).connect(merge);
      const update = (fr: number) => {
        split.frequency.setTargetAtTime(n('frequency', fr), t, 0.01);
        comp.threshold.setTargetAtTime(n('threshold', fr), t, 0.01);
        comp.knee.value = 3;
        comp.ratio.setTargetAtTime(1 + n('amount', fr), t, 0.01);
      };
      update(0);
      return { input, output: merge, update, nodes: [input, split, comp, inv, merge] };
    }
    case 'aReverb': {
      const input = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const pre = ctx.createDelay(1);
      const conv = ctx.createConvolver();
      const damp = ctx.createBiquadFilter();
      damp.type = 'lowpass';
      const out = ctx.createGain();
      input.connect(dry).connect(out);
      input.connect(pre).connect(conv).connect(damp).connect(wet).connect(out);
      let lastKey = '';
      const update = (fr: number) => {
        const room = n('room', fr);
        const decay = n('decay', fr);
        const damping = n('damping', fr) / 100;
        const key = `${room}|${decay.toFixed(2)}|${damping.toFixed(2)}`;
        if (key !== lastKey) {
          lastKey = key;
          const roomScale = [0.5, 1, 1.6, 2.4, 0.9, 0.7][room] ?? 1;
          conv.buffer = buildImpulse(ctx, Math.min(10, decay * roomScale), 2.2 - Math.min(1.5, damping), damping, room);
        }
        pre.delayTime.setTargetAtTime(n('preDelay', fr) / 1000, t, 0.01);
        damp.frequency.setTargetAtTime(20000 - damping * 16000, t, 0.01);
        const mix = n('mix', fr) / 100;
        wet.gain.setTargetAtTime(mix, t, 0.01);
        dry.gain.setTargetAtTime(1 - mix * 0.5, t, 0.01);
      };
      update(0);
      return { input, output: out, update, nodes: [input, dry, wet, pre, conv, damp, out] };
    }
    case 'aDelay': {
      const input = ctx.createGain();
      const out = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const dl = ctx.createDelay(5);
      const dr = ctx.createDelay(5);
      const fb = ctx.createGain();
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      input.connect(dry).connect(out);
      input.connect(dl);
      dl.connect(tone).connect(fb);
      fb.connect(dl);
      // ping pong: route feedback through second delay to other channel
      dl.connect(splitter);
      tone.connect(dr);
      dr.connect(merger, 0, 1);
      splitter.connect(merger, 0, 0);
      merger.connect(wet).connect(out);
      const update = (fr: number) => {
        const time = n('time', fr) / 1000;
        dl.delayTime.setTargetAtTime(time, t, 0.02);
        dr.delayTime.setTargetAtTime(n('pingPong', fr) > 0.5 ? time : 0.0001, t, 0.02);
        fb.gain.setTargetAtTime(n('feedback', fr) / 100, t, 0.01);
        tone.frequency.setTargetAtTime(n('tone', fr), t, 0.01);
        const mix = n('mix', fr) / 100;
        wet.gain.setTargetAtTime(mix, t, 0.01);
        dry.gain.setTargetAtTime(1 - mix * 0.3, t, 0.01);
      };
      update(0);
      return { input, output: out, update, nodes: [input, out, dry, wet, dl, dr, fb, tone, splitter, merger] };
    }
    case 'aChorus':
    case 'aFlanger': {
      const input = ctx.createGain();
      const out = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const delay = ctx.createDelay(0.2);
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      const fb = ctx.createGain();
      input.connect(dry).connect(out);
      input.connect(delay).connect(wet).connect(out);
      delay.connect(fb).connect(delay);
      lfo.connect(lfoGain).connect(delay.delayTime);
      lfo.start();
      const update = (fr: number) => {
        lfo.frequency.setTargetAtTime(n('rate', fr), t, 0.01);
        const depth = n('depth', fr) / 1000;
        lfoGain.gain.setTargetAtTime(depth, t, 0.01);
        const base = e.type === 'aChorus' ? n('delay', fr) / 1000 : 0.003;
        delay.delayTime.setTargetAtTime(Math.max(base, depth + 0.0005), t, 0.01);
        fb.gain.setTargetAtTime(e.type === 'aFlanger' ? n('feedback', fr) / 100 : 0, t, 0.01);
        const mix = n('mix', fr) / 100;
        wet.gain.setTargetAtTime(mix, t, 0.01);
        dry.gain.setTargetAtTime(1 - mix * 0.5, t, 0.01);
      };
      update(0);
      const built: Built = { input, output: out, update, nodes: [input, out, dry, wet, delay, lfo, lfoGain, fb] };
      (built as any).stop = () => lfo.stop();
      return built;
    }
    case 'aPhaser': {
      const input = ctx.createGain();
      const out = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const stages: BiquadFilterNode[] = [];
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      let prev: AudioNode = input;
      for (let i = 0; i < 8; i++) {
        const ap = ctx.createBiquadFilter();
        ap.type = 'allpass';
        ap.frequency.value = 800 + i * 300;
        lfo.connect(lfoGain).connect(ap.frequency);
        stages.push(ap);
        prev.connect(ap);
        prev = ap;
      }
      prev.connect(wet).connect(out);
      input.connect(dry).connect(out);
      lfo.start();
      const update = (fr: number) => {
        lfo.frequency.setTargetAtTime(n('rate', fr), t, 0.01);
        lfoGain.gain.setTargetAtTime(n('depth', fr) * 8, t, 0.01);
        const st = Math.round(n('stages', fr));
        stages.forEach((s, i) => {
          // Bypass unused stages by pushing frequency far outside audio band
          if (i >= st) s.frequency.value = 22000;
        });
        const mix = n('mix', fr) / 100;
        wet.gain.setTargetAtTime(mix, t, 0.01);
        dry.gain.setTargetAtTime(1 - mix * 0.5, t, 0.01);
      };
      update(0);
      const built: Built = { input, output: out, update, nodes: [input, out, dry, wet, lfo, lfoGain, ...stages] };
      (built as any).stop = () => lfo.stop();
      return built;
    }
    case 'aTremolo': {
      const g = ctx.createGain();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.connect(lfoGain).connect(g.gain);
      lfo.start();
      const update = (fr: number) => {
        const depth = n('depth', fr) / 100;
        lfo.frequency.setTargetAtTime(n('rate', fr), t, 0.01);
        lfoGain.gain.setTargetAtTime(depth * 0.5, t, 0.01);
        g.gain.setTargetAtTime(1 - depth * 0.5, t, 0.01);
      };
      update(0);
      const built: Built = { input: g, output: g, update, nodes: [g, lfo, lfoGain] };
      (built as any).stop = () => lfo.stop();
      return built;
    }
    case 'aDistortion': {
      const input = ctx.createGain();
      const ws = ctx.createWaveShaper();
      ws.oversample = '4x';
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      const wet = ctx.createGain();
      const dry = ctx.createGain();
      const out = ctx.createGain();
      input.connect(ws).connect(tone).connect(wet).connect(out);
      input.connect(dry).connect(out);
      let last = '';
      const update = (fr: number) => {
        const key = `${n('drive', fr)}|${n('type', fr)}`;
        if (key !== last) {
          last = key;
          ws.curve = makeDistortionCurve(n('drive', fr) / 100, n('type', fr)) as any;
        }
        tone.frequency.setTargetAtTime(n('tone', fr), t, 0.01);
        const mix = n('mix', fr) / 100;
        wet.gain.setTargetAtTime(mix, t, 0.01);
        dry.gain.setTargetAtTime(1 - mix, t, 0.01);
      };
      update(0);
      return { input, output: out, update, nodes: [input, ws, tone, wet, dry, out] };
    }
    case 'aPitchShift': {
      // Granular pitch shift using two crossfaded delay lines with sawtooth modulation.
      const input = ctx.createGain();
      const out = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const grain = 0.1;
      const d1 = ctx.createDelay(1);
      const d2 = ctx.createDelay(1);
      const g1 = ctx.createGain();
      const g2 = ctx.createGain();
      const saw1 = ctx.createOscillator();
      saw1.type = 'sawtooth';
      const saw2 = ctx.createOscillator();
      saw2.type = 'sawtooth';
      const m1 = ctx.createGain();
      const m2 = ctx.createGain();
      const env1 = ctx.createOscillator();
      env1.type = 'triangle';
      const env2 = ctx.createOscillator();
      env2.type = 'triangle';
      const e1 = ctx.createGain();
      const e2 = ctx.createGain();
      saw1.connect(m1).connect(d1.delayTime);
      saw2.connect(m2).connect(d2.delayTime);
      env1.connect(e1).connect(g1.gain);
      env2.connect(e2).connect(g2.gain);
      input.connect(d1).connect(g1).connect(wet);
      input.connect(d2).connect(g2).connect(wet);
      wet.connect(out);
      input.connect(dry).connect(out);
      e1.gain.value = 0.5;
      e2.gain.value = 0.5;
      g1.gain.value = 0.5;
      g2.gain.value = 0.5;
      const now = ctx.currentTime;
      saw1.start(now);
      saw2.start(now + grain / 2);
      env1.start(now);
      env2.start(now + grain / 2);
      const update = (fr: number) => {
        const semis = n('semitones', fr);
        const ratio = Math.pow(2, semis / 12);
        const rate = (1 - ratio) / grain;
        saw1.frequency.setTargetAtTime(Math.abs(rate), t, 0.01);
        saw2.frequency.setTargetAtTime(Math.abs(rate), t, 0.01);
        env1.frequency.setTargetAtTime(Math.abs(rate), t, 0.01);
        env2.frequency.setTargetAtTime(Math.abs(rate), t, 0.01);
        const depth = (grain / 2) * Math.sign(rate || 1);
        m1.gain.setTargetAtTime(depth, t, 0.01);
        m2.gain.setTargetAtTime(depth, t, 0.01);
        d1.delayTime.value = grain / 2;
        d2.delayTime.value = grain / 2;
        const mix = Math.abs(semis) < 0.01 ? 0 : n('mix', fr) / 100;
        wet.gain.setTargetAtTime(mix, t, 0.01);
        dry.gain.setTargetAtTime(1 - mix, t, 0.01);
      };
      update(0);
      const built: Built = { input, output: out, update, nodes: [input, out, dry, wet, d1, d2, g1, g2, saw1, saw2, m1, m2, env1, env2, e1, e2] };
      (built as any).stop = () => {
        saw1.stop();
        saw2.stop();
        env1.stop();
        env2.stop();
      };
      return built;
    }
    case 'aStereoWidth': {
      const input = ctx.createGain();
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      const lToL = ctx.createGain(),
        lToR = ctx.createGain(),
        rToL = ctx.createGain(),
        rToR = ctx.createGain();
      input.connect(split);
      split.connect(lToL, 0).connect(merge, 0, 0);
      split.connect(lToR, 0).connect(merge, 0, 1);
      split.connect(rToL, 1).connect(merge, 0, 0);
      split.connect(rToR, 1).connect(merge, 0, 1);
      const update = (fr: number) => {
        const w = n('width', fr) / 100; // 0 mono, 1 normal, 2 wide
        const mid = (2 - w) / 2;
        const side = w / 2;
        // L' = mid*(L+R)/1 ... simplified mid/side matrix
        lToL.gain.setTargetAtTime(mid + side, t, 0.01);
        rToR.gain.setTargetAtTime(mid + side, t, 0.01);
        lToR.gain.setTargetAtTime(mid - side, t, 0.01);
        rToL.gain.setTargetAtTime(mid - side, t, 0.01);
      };
      update(0);
      return { input, output: merge, update, nodes: [input, split, merge, lToL, lToR, rToL, rToR] };
    }
    case 'aChannelVolume': {
      const input = ctx.createGain();
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      const l = ctx.createGain(),
        r = ctx.createGain();
      input.connect(split);
      split.connect(l, 0).connect(merge, 0, 0);
      split.connect(r, 1).connect(merge, 0, 1);
      const update = (fr: number) => {
        l.gain.setTargetAtTime(dbToGain(n('left', fr)), t, 0.01);
        r.gain.setTargetAtTime(dbToGain(n('right', fr)), t, 0.01);
      };
      update(0);
      return { input, output: merge, update, nodes: [input, split, merge, l, r] };
    }
    case 'aFillLeft':
    case 'aFillRight':
    case 'aSwapChannels': {
      const input = ctx.createGain();
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      input.connect(split);
      if (e.type === 'aFillLeft') {
        split.connect(merge, 1, 0);
        split.connect(merge, 1, 1);
      } else if (e.type === 'aFillRight') {
        split.connect(merge, 0, 0);
        split.connect(merge, 0, 1);
      } else {
        split.connect(merge, 0, 1);
        split.connect(merge, 1, 0);
      }
      return { input, output: merge, nodes: [input, split, merge] };
    }
    case 'aInvert': {
      const g = ctx.createGain();
      g.gain.value = -1;
      return { input: g, output: g, nodes: [g] };
    }
    case 'aDcOffset': {
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      const update = (fr: number) => f.frequency.setTargetAtTime(n('cutoff', fr), t, 0.01);
      update(0);
      return { input: f, output: f, update, nodes: [f] };
    }
    case 'aNoiseReduction': {
      // 3-band downward expander approximation.
      const input = ctx.createGain();
      const out = ctx.createGain();
      const bands: { f: BiquadFilterNode; c: DynamicsCompressorNode; g: GainNode }[] = [];
      const ranges: [BiquadFilterType, number][] = [
        ['lowpass', 250],
        ['bandpass', 1500],
        ['highpass', 5000],
      ];
      for (const [type, freq] of ranges) {
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.value = freq;
        f.Q.value = 0.7;
        const c = ctx.createDynamicsCompressor();
        c.ratio.value = 1;
        const g = ctx.createGain();
        input.connect(f).connect(c).connect(g).connect(out);
        bands.push({ f, c, g });
      }
      const update = (fr: number) => {
        const amount = n('amount', fr);
        const thr = n('threshold', fr);
        const smooth = n('smoothing', fr) / 100;
        for (const b of bands) {
          // Use compressor inverted: lift threshold so quiet content is attenuated via makeup below thr
          b.c.threshold.setTargetAtTime(thr, t, 0.01);
          b.c.knee.setTargetAtTime(10 + smooth * 20, t, 0.01);
          b.c.release.setTargetAtTime(0.05 + smooth * 0.4, t, 0.01);
          b.g.gain.setTargetAtTime(dbToGain(-amount * 0.25), t, 0.01);
        }
        out.gain.setTargetAtTime(dbToGain(amount * 0.25), t, 0.01);
      };
      update(0);
      return { input, output: out, update, nodes: [input, out, ...bands.flatMap((b) => [b.f, b.c, b.g])] };
    }
    case 'aLoudnessNormalize': {
      const c = ctx.createDynamicsCompressor();
      const g = ctx.createGain();
      c.connect(g);
      const update = (fr: number) => {
        const target = [-23, -24, -14, -16][Math.round(n('standard', fr))] ?? -23;
        c.threshold.setTargetAtTime(target + 6, t, 0.01);
        c.ratio.value = 4;
        c.knee.value = 12;
        c.attack.value = 0.02;
        c.release.value = 0.4;
        g.gain.setTargetAtTime(dbToGain(Math.min(0, n('truePeak', fr)) + (-18 - target) * 0.5), t, 0.01);
      };
      update(0);
      return { input: c, output: g, update, nodes: [c, g] };
    }
    default:
      return passthrough(ctx);
  }
}

export function buildAudioChain(ctx: BaseAudioContext, effects: EffectInstance[]): AudioChain {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const parts: Built[] = [];
  let prev: AudioNode = input;
  for (const e of effects) {
    if (!e.enabled) continue;
    try {
      const b = buildOne(ctx, e);
      prev.connect(b.input);
      prev = b.output;
      parts.push(b);
    } catch (err) {
      console.warn('audio effect failed', e.type, err);
    }
  }
  prev.connect(output);
  return {
    input,
    output,
    update: (frame) => {
      for (const p of parts) p.update?.(frame);
    },
    dispose: () => {
      for (const p of parts) {
        (p as any).stop?.();
        for (const nd of p.nodes) {
          try {
            nd.disconnect();
          } catch {
            /* ignore */
          }
        }
      }
      try {
        input.disconnect();
        output.disconnect();
      } catch {
        /* ignore */
      }
    },
  };
}
