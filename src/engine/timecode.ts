/*
  Timecode utilities. Supports non-drop and drop-frame (29.97 / 59.94) SMPTE
  notation, as well as frame count, seconds, and film feet+frames displays.
*/

export type TimecodeMode = 'timecode' | 'frames' | 'seconds' | 'feet16' | 'feet35';

export function isDropFrameRate(fps: number) {
  return Math.abs(fps - 29.97) < 0.01 || Math.abs(fps - 59.94) < 0.01 || Math.abs(fps - 23.976) < 0.01;
}

function nominal(fps: number) {
  return Math.round(fps);
}

export function framesToTimecode(frames: number, fps: number, dropFrame = false): string {
  const neg = frames < 0;
  let f = Math.abs(Math.round(frames));
  const nom = nominal(fps);
  const sep = dropFrame && (nom === 30 || nom === 60) ? ';' : ':';
  if (dropFrame && (nom === 30 || nom === 60)) {
    // SMPTE drop-frame: drop 2 (or 4) frame numbers every minute except every 10th.
    const dropPerMin = nom === 30 ? 2 : 4;
    const framesPer10Min = Math.round(fps * 600);
    const framesPerMin = nom * 60 - dropPerMin;
    const d = Math.floor(f / framesPer10Min);
    let m = f % framesPer10Min;
    if (m < dropPerMin) m = m + dropPerMin; // keep first minute in block sane
    f = f + dropPerMin * 9 * d + dropPerMin * Math.floor((m - dropPerMin) / framesPerMin);
  }
  const ff = f % nom;
  const totalSec = Math.floor(f / nom);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${neg ? '-' : ''}${p(h)}:${p(m)}:${p(s)}${sep}${p(ff)}`;
}

export function timecodeToFrames(tc: string, fps: number, dropFrame = false): number | null {
  const t = tc.trim();
  if (!t) return null;
  // Plain number: treat as frames when it has no separators.
  if (/^-?\d+$/.test(t)) {
    // Premiere style: typing digits without separators fills from the right (hhmmssff)
    const neg = t.startsWith('-');
    const digits = t.replace('-', '').padStart(8, '0').slice(-8);
    const nom = nominal(fps);
    const h = parseInt(digits.slice(0, 2), 10);
    const m = parseInt(digits.slice(2, 4), 10);
    const s = parseInt(digits.slice(4, 6), 10);
    const f = parseInt(digits.slice(6, 8), 10);
    const frames = ((h * 60 + m) * 60 + s) * nom + f;
    return neg ? -frames : dropCorrect(frames, h, m, fps, dropFrame);
  }
  const m = t.match(/^(-)?(?:(\d+)[:;.])?(?:(\d+)[:;.])?(\d+)[:;.](\d+)$/);
  if (!m) {
    const asNum = parseFloat(t);
    if (!Number.isNaN(asNum) && /s$/.test(t)) return Math.round(asNum * fps);
    return null;
  }
  const neg = !!m[1];
  const parts = [m[2], m[3], m[4], m[5]].map((x) => (x === undefined ? 0 : parseInt(x, 10)));
  let h = 0,
    mi = 0,
    s = 0,
    f = 0;
  if (m[2] !== undefined && m[3] !== undefined) [h, mi, s, f] = parts;
  else if (m[3] !== undefined) [mi, s, f] = [parts[1], parts[2], parts[3]];
  else [s, f] = [parts[2], parts[3]];
  const nom = nominal(fps);
  const frames = ((h * 60 + mi) * 60 + s) * nom + f;
  const r = dropCorrect(frames, h, mi, fps, dropFrame);
  return neg ? -r : r;
}

function dropCorrect(frames: number, h: number, m: number, fps: number, dropFrame: boolean) {
  const nom = nominal(fps);
  if (!dropFrame || !(nom === 30 || nom === 60)) return frames;
  const dropPerMin = nom === 30 ? 2 : 4;
  const totalMinutes = h * 60 + m;
  return frames - dropPerMin * (totalMinutes - Math.floor(totalMinutes / 10));
}

export function formatTime(frames: number, fps: number, mode: TimecodeMode, dropFrame = false): string {
  switch (mode) {
    case 'frames':
      return String(Math.round(frames));
    case 'seconds':
      return (frames / fps).toFixed(3) + 's';
    case 'feet16': {
      const f = Math.round(frames);
      return `${Math.floor(f / 40)}+${String(f % 40).padStart(2, '0')}`;
    }
    case 'feet35': {
      const f = Math.round(frames);
      return `${Math.floor(f / 16)}+${String(f % 16).padStart(2, '0')}`;
    }
    default:
      return framesToTimecode(frames, fps, dropFrame);
  }
}

export function parseTime(text: string, fps: number, mode: TimecodeMode, dropFrame = false): number | null {
  const t = text.trim();
  if (mode === 'frames' && /^-?\d+$/.test(t)) return parseInt(t, 10);
  if (mode === 'seconds') {
    const n = parseFloat(t);
    if (!Number.isNaN(n)) return Math.round(n * fps);
  }
  if (mode === 'feet16' || mode === 'feet35') {
    const m = t.match(/^(\d+)\+(\d+)$/);
    if (m) return parseInt(m[1], 10) * (mode === 'feet16' ? 40 : 16) + parseInt(m[2], 10);
  }
  // relative entry: +12, -12
  if (/^[+-]\d+$/.test(t) && mode !== 'frames') return null;
  return timecodeToFrames(t, fps, dropFrame);
}

export function secondsToFrames(sec: number, fps: number) {
  return Math.round(sec * fps);
}
export function framesToSeconds(frames: number, fps: number) {
  return frames / fps;
}

/** Choose ruler tick intervals (in frames) for a given zoom in pixels per frame. */
export function rulerIntervals(pixelsPerFrame: number, fps: number): { major: number; minor: number } {
  const targetMajorPx = 110;
  const candidatesSeconds = [
    1 / fps,
    2 / fps,
    5 / fps,
    10 / fps,
    0.5,
    1,
    2,
    5,
    10,
    15,
    30,
    60,
    120,
    300,
    600,
    900,
    1800,
    3600,
  ];
  for (const sec of candidatesSeconds) {
    const frames = Math.max(1, Math.round(sec * fps));
    if (frames * pixelsPerFrame >= targetMajorPx) {
      let minor = Math.max(1, Math.round(frames / 5));
      if (sec >= 1 && sec < 60) minor = Math.max(1, Math.round(frames / (sec === 1 ? 2 : sec === 2 ? 4 : 5)));
      if (sec < 1) minor = 1;
      return { major: frames, minor };
    }
  }
  const frames = Math.round(7200 * fps);
  return { major: frames, minor: Math.round(frames / 4) };
}
