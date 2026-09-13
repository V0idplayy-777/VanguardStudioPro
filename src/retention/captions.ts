/*
  Retention toolkit - smart captions.

  "Visual Friction Elimination": bold, animated captions in the exact centre of
  the frame, one to three words per line, with a highlighted power word
  (kicker). These helpers turn ordinary captions into retention captions.
*/

import type { CaptionItem, CaptionStyle } from '../types/project';
import { DEFAULT_CAPTION_STYLE } from '../types/project';
import { uid } from '../engine/util';

/** The retention caption look: bold, centred, outlined, animated, with a kicker word. */
export const RETENTION_CAPTION_STYLE: CaptionStyle = {
  ...DEFAULT_CAPTION_STYLE,
  fontWeight: 800,
  color: '#ffffff',
  backgroundColor: '#000000',
  backgroundOpacity: 0.55,
  edge: 'outline',
  edgeColor: '#000000',
  align: 'center',
  position: 0.5,
  maxWidth: 0.9,
  letterSpacing: 0,
  animation: 'pop',
  kicker: true,
  kickerColor: '#ffd54a',
};

/** A copy of the retention style sized to the sequence height. */
export function retentionStyleFor(height: number): CaptionStyle {
  return { ...RETENTION_CAPTION_STYLE, fontSize: Math.round(height * 0.065) };
}

export function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Split text into chunks of 1..maxWords words each (short, punchy micro-captions). */
export function microChunks(text: string, maxWords = 2): string[] {
  const words = splitWords(text);
  const out: string[] = [];
  let cur: string[] = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= maxWords) {
      out.push(cur.join(' '));
      cur = [];
    }
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
}

/**
 * Convert ordinary captions into micro-captions. Each caption is split into
 * 1..maxWords word chunks and its time span is distributed across the chunks
 * proportionally to their word count.
 */
export function buildMicroCaptions(source: CaptionItem[], maxWords: number, style: Partial<CaptionStyle> = {}): CaptionItem[] {
  const out: CaptionItem[] = [];
  for (const c of source) {
    const words = splitWords(c.text);
    if (!words.length) continue;
    const chunks = microChunks(c.text, maxWords);
    const span = Math.max(1, c.end - c.start);
    let acc = 0;
    chunks.forEach((chunk, i) => {
      const wc = splitWords(chunk).length;
      const t0 = c.start + Math.round((span * acc) / words.length);
      acc += wc;
      const t1 = i === chunks.length - 1 ? c.end : c.start + Math.round((span * acc) / words.length);
      out.push({ id: uid('cap'), start: t0, end: Math.max(t0 + 1, t1), text: chunk, style: { ...style } });
    });
  }
  return out;
}
