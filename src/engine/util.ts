let counter = 0;

/** Compact unique id. Sortable-ish by creation time, safe for object keys. */
export function uid(prefix = ''): string {
  counter = (counter + 1) % 0xffff;
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0xffffff).toString(36);
  const c = counter.toString(36).padStart(3, '0');
  return prefix ? `${prefix}_${t}${r}${c}` : `${t}${r}${c}`;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const mix = lerp;
export const round = (v: number, d = 0) => {
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
};

export function dbToGain(db: number): number {
  if (db <= -96) return 0;
  return Math.pow(10, db / 20);
}
export function gainToDb(g: number): number {
  if (g <= 0) return -Infinity;
  return 20 * Math.log10(g);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDurationShort(seconds: number): string {
  if (!isFinite(seconds)) return '--:--';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => clamp(Math.round(v * 255), 0, 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0,
    g = 0,
    b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

/** Deep clone for plain project data. JSON round-trip on purpose: it also unwraps immer draft proxies, which structuredClone rejects. */
export function deepClone<T>(v: T): T {
  if (v === undefined || v === null) return v;
  return JSON.parse(JSON.stringify(v));
}

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export function debounce<F extends (...a: any[]) => void>(fn: F, ms: number): F & { cancel: () => void } {
  let t: number | undefined;
  const d = ((...args: any[]) => {
    if (t) window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), ms);
  }) as F & { cancel: () => void };
  d.cancel = () => {
    if (t) window.clearTimeout(t);
  };
  return d;
}

export function throttleRaf<F extends (...a: any[]) => void>(fn: F): F {
  let scheduled = false;
  let lastArgs: any[] = [];
  return ((...args: any[]) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...lastArgs);
    });
  }) as F;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'untitled';
}

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}

export function stripExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Deterministic hash of a string to 32 bits. */
export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 2000);
}

export function pluralize(n: number, one: string, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}
