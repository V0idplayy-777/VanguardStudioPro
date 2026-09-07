let shared: AudioContext | null = null;

export function getSharedAudioContext(): AudioContext {
  if (!shared) {
    shared = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  }
  return shared;
}

export function resumeAudio() {
  const ctx = getSharedAudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
}

/** Build an impulse response for a simple algorithmic reverb. */
export function buildImpulse(ctx: BaseAudioContext, seconds: number, decay: number, damping: number, room: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  // deterministic noise so repeated builds match
  let seed = 1234567 + Math.round(room * 7919);
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    const dampCoef = 0.02 + damping * 0.6;
    // early reflections for room character
    const early: number[] = [];
    const count = 4 + Math.round(room * 3);
    for (let i = 0; i < count; i++) early.push(Math.floor(rate * (0.005 + rnd() * 0.04 * (1 + room))));
    for (let i = 0; i < len; i++) {
      const t = i / len;
      let v = (rnd() * 2 - 1) * Math.pow(1 - t, decay);
      lp += (v - lp) * (1 - dampCoef * t);
      v = lp;
      d[i] = v;
    }
    for (const e of early) if (e < len) d[e] += 0.4 * (rnd() * 2 - 1);
    // plate: brighter, spring: boingy modulation
    if (room === 4) for (let i = 0; i < len; i++) d[i] *= 1 + 0.2 * Math.sin(i / 90);
    if (room === 5) for (let i = 0; i < len; i++) d[i] *= 0.6 + 0.4 * Math.sin(i / 400 + ch);
  }
  return buf;
}

export function makeDistortionCurve(amount: number, type: number): Float32Array {
  const n = 2048;
  const curve = new Float32Array(n);
  const k = amount * 100;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    let y: number;
    switch (type) {
      case 1: // hard clip
        y = Math.max(-1, Math.min(1, x * (1 + k / 10)));
        break;
      case 2: // fuzz
        y = Math.sign(x) * (1 - Math.exp(-Math.abs(x) * (1 + k / 4)));
        break;
      case 3: {
        // bitcrush-ish
        const steps = Math.max(2, 64 - Math.round(k * 0.6));
        y = Math.round(x * steps) / steps;
        break;
      }
      default: // soft clip
        y = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
        y = Math.max(-1, Math.min(1, y));
    }
    curve[i] = y;
  }
  return curve;
}
