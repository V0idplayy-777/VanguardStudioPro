/*
  Retention toolkit - dopamine SFX.

  Short sound effects (swooshes, pops, dings, whooshes...) synthesised entirely
  in the browser and written to WAV, so they drop into the project through the
  normal import pipeline and behave like any other audio clip. Nothing is
  downloaded; the "casino floor" energy is generated on the machine.
*/

export interface SfxDef {
  id: string;
  name: string;
  desc: string;
}

export const SFX: SfxDef[] = [
  { id: 'pop', name: 'Pop', desc: 'Short percussive pop - punchlines and text hits.' },
  { id: 'ding', name: 'Ding', desc: 'Bright bell ding - correct answers, reveals.' },
  { id: 'swoosh', name: 'Swoosh', desc: 'Fast air sweep - text transitions.' },
  { id: 'whoosh', name: 'Whoosh', desc: 'Longer air whoosh - B-roll resets.' },
  { id: 'riser', name: 'Riser', desc: 'Tension riser into a drop.' },
  { id: 'boom', name: 'Boom', desc: 'Deep impact boom - punchlines, slams.' },
  { id: 'tick', name: 'Tick', desc: 'Tiny UI tick - subtle emphasis.' },
];

const SR = 48000;

function osc(
  ctx: OfflineAudioContext,
  type: OscillatorType,
  freqFrom: number,
  freqTo: number,
  t0: number,
  dur: number,
  gainFrom: number,
  gainTo: number,
) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(1, freqFrom), t0);
  if (freqTo !== freqFrom) o.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.max(1e-4, gainFrom), t0);
  g.gain.exponentialRampToValueAtTime(Math.max(1e-4, gainTo), t0 + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.03);
}

/** Noise through a bandpass filter with arbitrary frequency/gain breakpoints (time fractions 0..1). */
function noiseSweep(
  ctx: OfflineAudioContext,
  t0: number,
  dur: number,
  points: { at: number; freq: number; gain: number }[],
  q = 1,
) {
  const len = Math.ceil(ctx.sampleRate * (dur + 0.06));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = q;
  for (const pt of points) bp.frequency.setValueAtTime(Math.max(20, pt.freq), t0 + dur * pt.at);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  for (const pt of points) g.gain.setValueAtTime(Math.max(1e-4, pt.gain), t0 + dur * pt.at);
  g.gain.setValueAtTime(0.0001, t0 + dur);
  src.connect(bp).connect(g).connect(ctx.destination);
  src.start(t0);
  src.stop(t0 + dur + 0.06);
}

export async function synthesizeSfx(id: string): Promise<AudioBuffer> {
  const spec: { dur: number; build: (ctx: OfflineAudioContext) => void } = { dur: 0.3, build: () => undefined };
  const target = SFX.find((s) => s.id === id) ?? SFX[0];
  switch (target.id) {
    case 'pop':
      spec.dur = 0.2;
      spec.build = (ctx) => {
        osc(ctx, 'sine', 520, 90, 0, 0.16, 0.9, 0.001);
        noiseSweep(ctx, 0, 0.12, [{ at: 0, freq: 900, gain: 0.5 }, { at: 1, freq: 250, gain: 0.001 }], 0.8);
      };
      break;
    case 'ding':
      spec.dur = 1.0;
      spec.build = (ctx) => {
        osc(ctx, 'sine', 1318.5, 1318.5, 0, 0.9, 0.6, 0.001);
        osc(ctx, 'sine', 2637, 2637, 0, 0.5, 0.18, 0.001);
      };
      break;
    case 'swoosh':
      spec.dur = 0.32;
      spec.build = (ctx) => {
        noiseSweep(ctx, 0, 0.3, [{ at: 0, freq: 250, gain: 0.0001 }, { at: 0.45, freq: 3400, gain: 0.5 }, { at: 1, freq: 400, gain: 0.001 }], 0.7);
      };
      break;
    case 'whoosh':
      spec.dur = 0.85;
      spec.build = (ctx) => {
        noiseSweep(ctx, 0, 0.8, [{ at: 0, freq: 160, gain: 0.0001 }, { at: 0.6, freq: 2100, gain: 0.4 }, { at: 1, freq: 500, gain: 0.001 }], 0.6);
      };
      break;
    case 'riser':
      spec.dur = 1.4;
      spec.build = (ctx) => {
        osc(ctx, 'sawtooth', 140, 1250, 0, 1.3, 0.001, 0.45);
        noiseSweep(ctx, 0, 1.3, [{ at: 0, freq: 300, gain: 0.0001 }, { at: 1, freq: 6000, gain: 0.3 }], 0.5);
      };
      break;
    case 'boom':
      spec.dur = 1.1;
      spec.build = (ctx) => {
        osc(ctx, 'sine', 70, 36, 0, 1.0, 0.9, 0.001);
        osc(ctx, 'sine', 52, 30, 0, 0.9, 0.4, 0.001);
        noiseSweep(ctx, 0, 0.5, [{ at: 0, freq: 900, gain: 0.7 }, { at: 1, freq: 90, gain: 0.001 }], 0.9);
      };
      break;
    case 'tick':
      spec.dur = 0.08;
      spec.build = (ctx) => {
        osc(ctx, 'square', 2200, 2200, 0, 0.05, 0.4, 0.001);
      };
      break;
  }

  const ctx = new OfflineAudioContext(2, Math.ceil(SR * spec.dur), SR);
  spec.build(ctx);
  return ctx.startRendering();
}

/** Render an SFX to a WAV File ready for import. */
export async function sfxWavFile(id: string): Promise<{ file: File; duration: number; name: string }> {
  const buffer = await synthesizeSfx(id);
  const { encodeWav } = await import('../engine/export/exporter');
  const blob = encodeWav(buffer, buffer.numberOfChannels as 1 | 2, 16);
  const def = SFX.find((s) => s.id === id) ?? SFX[0];
  return { file: new File([blob], `sfx-${def.id}.wav`, { type: 'audio/wav' }), duration: buffer.duration, name: def.name };
}
