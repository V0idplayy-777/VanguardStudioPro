import type { Clip, Project, Sequence } from '../../types/project';
import { getCompositor } from '../playback/playback';

/*
  Auto Color: one-click correction. Renders the clip raw (no effects) at a
  small scale, reads the histogram, then writes Lumetri basic-correction
  values: black/white points, exposure to a sensible mid, and gray-world
  white balance. Conservative by design - it fixes levels, it does not grade.
*/

export interface AutoColorParams {
  exposure: number;
  contrast: number;
  blacks: number;
  whites: number;
  temperature: number;
  tint: number;
  saturation: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Analyze one rendered frame of the clip. Returns null when it has no pixels. */
export async function analyzeClipFrame(project: Project, seq: Sequence, clip: Clip, frame: number): Promise<{ lo: number; hi: number; mid: number; avgR: number; avgG: number; avgB: number; chroma: number } | null> {
  const comp = getCompositor();
  const scale = 4;
  const rt = await comp.renderFrame(project, seq, frame, { soloClipId: clip.id, effects: false, captions: false, scale });
  try {
    const img = comp.readPixels(rt, [0, 0, 0]);
    const d = img.data;
    // Histograms per channel; skip fully transparent pixels (empty frame area).
    const bins = 256;
    const hist = [new Uint32Array(bins), new Uint32Array(bins), new Uint32Array(bins)];
    let count = 0,
      sr = 0,
      sg = 0,
      sb = 0,
      chroma = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 250) continue;
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      hist[0][r]++;
      hist[1][g]++;
      hist[2][b]++;
      sr += r;
      sg += g;
      sb += b;
      const mx = Math.max(r, g, b),
        mn = Math.min(r, g, b);
      chroma += mx - mn;
      count++;
    }
    if (count < 100) return null;
    // Luma histogram from the channel mix (Rec.709).
    const lumaHist = new Uint32Array(bins);
    for (let v = 0; v < bins; v++) {
      lumaHist[v] = Math.round(hist[0][v] * 0.2126 + hist[1][v] * 0.7152 + hist[2][v] * 0.0722);
    }
    let total = 0;
    for (let v = 0; v < bins; v++) total += lumaHist[v];
    const pct = (p: number) => {
      const target = total * p;
      let acc = 0;
      for (let v = 0; v < bins; v++) {
        acc += lumaHist[v];
        if (acc >= target) return v / 255;
      }
      return 1;
    };
    return {
      lo: pct(0.004),
      hi: pct(0.996),
      mid: (0.2126 * (sr / count) + 0.7152 * (sg / count) + 0.0722 * (sb / count)) / 255,
      avgR: sr / count / 255,
      avgG: sg / count / 255,
      avgB: sb / count / 255,
      chroma: chroma / count / 255,
    };
  } finally {
    comp.release(rt);
  }
}

export function autoColorParamsFrom(stats: NonNullable<Awaited<ReturnType<typeof analyzeClipFrame>>>, strength = 1): AutoColorParams {
  const k = clamp(strength, 0, 1);
  const range = stats.hi - stats.lo;
  const params: AutoColorParams = {
    exposure: clamp(Math.log2(0.44 / Math.max(0.03, stats.mid)) * 0.5, -1.2, 1.2) * k,
    contrast: range < 0.55 ? clamp((0.55 - range) * 70, 0, 22) * k : 0,
    blacks: clamp(-(stats.lo - 0.02) * 220, -45, 45) * k,
    whites: clamp((0.97 - stats.hi) * 220, -45, 45) * k,
    temperature: clamp((stats.avgB - stats.avgR) * 150, -40, 40) * k,
    tint: clamp((((stats.avgR + stats.avgB) / 2 - stats.avgG) * -150), -30, 30) * k,
    saturation: stats.chroma < 0.1 ? Math.round((100 + 10 * k) * 10) / 10 : 100,
  };
  // Rounding keeps the values readable in Effect Controls.
  for (const key of Object.keys(params) as (keyof AutoColorParams)[]) {
    params[key] = Math.round(params[key] * 20) / 20;
  }
  return params;
}
