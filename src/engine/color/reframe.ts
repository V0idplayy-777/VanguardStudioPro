/*
  Auto Reframe: find where the action is, per clip.

  Renders the clip solo at a tiny scale on a regular time grid, converts each
  frame to a coarse luma grid, and takes the centroid of the absolute
  frame-to-frame difference. Static scenes (no meaningful difference) hold the
  previous centroid; the series is then smoothed with a short moving average
  so the crop glides instead of twitching. Good enough to follow one moving
  subject; a static centred crop is the deliberate fallback.

  The output feeds position keyframes on the reframed sequence's clips.
*/

import type { Clip, Project, Sequence } from '../../types/project';
import { getCompositor } from '../playback/playback';

export interface ReframeSample {
  /** Clip-local seconds. */
  t: number;
  /** Centroid in clip-space, normalized 0..1. */
  x: number;
  y: number;
}

const SAMPLE_STEP = 0.5; // seconds between analysed frames
const SMOOTH = 2; // samples of moving-average window on either side

/** Analyse motion centroids for one clip. Returns [] when undecodable. */
export async function analyzeMotion(
  project: Project,
  seq: Sequence,
  clip: Clip,
  onProgress?: (done: number, total: number) => void,
): Promise<ReframeSample[]> {
  const comp = getCompositor();
  const fps = seq.settings.fps;
  const durSec = clip.duration / fps;
  if (durSec < 0.3) return [];
  const times: number[] = [];
  for (let t = SAMPLE_STEP / 2; t < durSec; t += SAMPLE_STEP) times.push(t);
  times.push(durSec - 1e-3);

  const raw: ReframeSample[] = [];
  let prev: Float32Array | null = null;
  let prevW = 0;
  let prevH = 0;
  let cx = 0.5;
  let cy = 0.5;
  for (let i = 0; i < times.length; i++) {
    const frame = Math.round(clip.start + times[i] * fps);
    const rt = await comp.renderFrame(project, seq, frame, { soloClipId: clip.id, effects: false, captions: false, scale: 8 });
    let grid: Float32Array | null = null;
    let gw = 0;
    let gh = 0;
    try {
      const img = comp.readPixels(rt, [0, 0, 0]);
      gw = Math.max(2, img.width);
      gh = Math.max(2, img.height);
      grid = new Float32Array(gw * gh);
      const d = img.data;
      for (let p = 0; p < gw * gh; p++) {
        grid[p] = (d[p * 4] * 0.2126 + d[p * 4 + 1] * 0.7152 + d[p * 4 + 2] * 0.0722) / 255;
      }
    } finally {
      comp.release(rt);
    }
    if (!grid) break;
    if (prev && prev.length === grid.length && prevW === gw && prevH === gh) {
      // Centroid of the difference above a small noise threshold.
      let sum = 0;
      let sx = 0;
      let sy = 0;
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          const w = Math.abs(grid[y * gw + x] - prev[y * gw + x]) - 0.04;
          if (w <= 0) continue;
          sum += w;
          sx += w * (x / (gw - 1));
          sy += w * (y / (gh - 1));
        }
      }
      if (sum > gw * gh * 0.004) {
        // Enough movement to trust the centroid.
        cx = 0.5 * cx + 0.5 * (sx / sum);
        cy = 0.5 * cy + 0.5 * (sy / sum);
      }
    }
    raw.push({ t: times[i], x: cx, y: cy });
    prev = grid;
    prevW = gw;
    prevH = gh;
    if (onProgress && (i & 3) === 3) onProgress(i + 1, times.length);
  }
  if (raw.length < 2) return raw;

  // Moving average so the crop glides.
  const out: ReframeSample[] = [];
  for (let i = 0; i < raw.length; i++) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let j = Math.max(0, i - SMOOTH); j <= Math.min(raw.length - 1, i + SMOOTH); j++) {
      sx += raw[j].x;
      sy += raw[j].y;
      n++;
    }
    out.push({ t: raw[i].t, x: sx / n, y: sy / n });
  }
  return out;
}
