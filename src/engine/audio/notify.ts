import { getSharedAudioContext } from './audioContext';

/*
  Tiny notification chimes (Web Audio, no assets). Used for "sound when an
  export finishes" and friends. Very quiet by design - it should notify, not
  startle. Fails silently when audio is unavailable.
*/

function tone(ctx: AudioContext, freq: number, at: number, dur: number, gain: number) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, ctx.currentTime + at);
  g.gain.linearRampToValueAtTime(gain, ctx.currentTime + at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(ctx.currentTime + at);
  osc.stop(ctx.currentTime + at + dur + 0.05);
}

export type ChimeKind = 'success' | 'error' | 'info';

/** Play a short chime. Success = rising two-note, error = falling two-note. */
export function playChime(kind: ChimeKind = 'success') {
  try {
    const ctx = getSharedAudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    if (kind === 'success') {
      tone(ctx, 880, 0, 0.16, 0.05);
      tone(ctx, 1318.5, 0.11, 0.28, 0.05);
    } else if (kind === 'error') {
      tone(ctx, 392, 0, 0.18, 0.05);
      tone(ctx, 261.6, 0.13, 0.32, 0.05);
    } else {
      tone(ctx, 659.25, 0, 0.18, 0.04);
    }
  } catch {
    /* audio unavailable - stay silent */
  }
}
