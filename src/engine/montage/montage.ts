/*
  Auto Montage planning: turn a beat list into cut slots.

  Pure helpers only - the sequence building lives in app/commands.ts so it can
  use the project store and undo batching.
*/

export interface MontageSlot {
  /** Seconds from the start of the music. */
  start: number;
  end: number;
}

export interface MontagePlanOptions {
  /** Cut on every beat (1), every 2nd (2) or every 4th (4). */
  density: number;
  /** Total montage length cap, seconds. */
  maxSeconds: number;
  /** Discard slots shorter than this, seconds. */
  minSlotSeconds?: number;
  /** Hard cap on the number of slots. */
  maxSlots?: number;
}

/**
 * Cut points are the beat grid thinned by `density`, plus the very start and
 * the capped end. Slots are the spans between consecutive cut points.
 */
export function planMontageSlots(beats: number[], musicDuration: number, opts: MontagePlanOptions): MontageSlot[] {
  const density = Math.max(1, Math.round(opts.density));
  const minSlot = opts.minSlotSeconds ?? 0.35;
  const maxSlots = opts.maxSlots ?? 120;
  const end = Math.min(musicDuration, opts.maxSeconds);
  if (end <= 0.5) return [];
  const cuts: number[] = [0];
  beats.forEach((t, i) => {
    if (i % density === 0 && t > 0.2 && t < end - 0.2) cuts.push(t);
  });
  cuts.push(end);
  const slots: MontageSlot[] = [];
  for (let i = 0; i < cuts.length - 1 && slots.length < maxSlots; i++) {
    const start = cuts[i];
    const endS = cuts[i + 1];
    if (endS - start < minSlot) continue;
    if (slots.length) slots[slots.length - 1].end = start;
    slots.push({ start, end: endS });
  }
  // Merge any slot that got dropped for being too short into its neighbour by
  // extending the previous slot's end to this slot's end.
  const merged: MontageSlot[] = [];
  for (const s of slots) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.start < minSlot) last.end = s.end;
    else merged.push({ ...s });
  }
  if (merged.length && merged[merged.length - 1].end - merged[merged.length - 1].start < minSlot) merged.pop();
  return merged;
}

/** Deterministic 0..1 pseudo-random from a string seed (stable across reloads). */
export function seededUnit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export const MONTAGE_ASPECTS: Record<string, { w: number; h: number; label: string }> = {
  '16:9': { w: 1920, h: 1080, label: '16:9 Landscape (1920x1080)' },
  '9:16': { w: 1080, h: 1920, label: '9:16 Vertical (1080x1920)' },
  '1:1': { w: 1080, h: 1080, label: '1:1 Square (1080x1080)' },
  '4:5': { w: 1080, h: 1350, label: '4:5 Portrait (1080x1350)' },
};
