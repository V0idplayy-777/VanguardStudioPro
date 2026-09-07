import type { CaptionItem } from '../../types/project';

function tsToFrames(ts: string, fps: number): number | null {
  const m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const mi = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, '0'), 10);
  return Math.round((h * 3600 + mi * 60 + s + ms / 1000) * fps);
}

function stripTags(s: string) {
  return s.replace(/<[^>]+>/g, '').replace(/\{\\[^}]+\}/g, '').trim();
}

export function parseSRT(text: string, fps: number): Omit<CaptionItem, 'id'>[] {
  const out: Omit<CaptionItem, 'id'>[] = [];
  const blocks = text.replace(/\r/g, '').split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim().length);
    if (lines.length < 2) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0].trim())) i = 1;
    const m = lines[i]?.match(/(\S+)\s*-->\s*(\S+)/);
    if (!m) continue;
    const start = tsToFrames(m[1], fps);
    const end = tsToFrames(m[2], fps);
    if (start == null || end == null) continue;
    const body = stripTags(lines.slice(i + 1).join('\n'));
    if (body) out.push({ start, end: Math.max(end, start + 1), text: body });
  }
  return out;
}

export function parseVTT(text: string, fps: number): Omit<CaptionItem, 'id'>[] {
  const body = text.replace(/\r/g, '').replace(/^WEBVTT[^\n]*\n/, '');
  // Drop NOTE/STYLE blocks
  const cleaned = body
    .split(/\n\n+/)
    .filter((b) => !/^(NOTE|STYLE|REGION)/.test(b.trim()))
    .join('\n\n');
  return parseSRT(cleaned, fps);
}

/** Split long text into caption-sized chunks (used by "Create captions from transcript"). */
export function chunkTranscript(text: string, maxChars = 42): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      out.push(cur.trim());
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur.trim());
  return out;
}
