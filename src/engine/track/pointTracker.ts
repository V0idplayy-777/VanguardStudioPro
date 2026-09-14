/**
 * 2D point and planar tracker - analysis driver.
 *
 * Pins something to a moving object: a callout or title that follows a face, a
 * censor blur that stays over a plate number, a replacement screen driven through
 * Corner Pin. The user clicks the thing they want to follow, the tracker walks it
 * frame by frame, and the resulting path can be written to an effect parameter,
 * an effect mask or a graphic layer.
 *
 * Method: per-point template matching on a luma plane. The patch found in the
 * previous frame is searched for in the next one, starting from a position
 * predicted by the current velocity, and the best match is refined to sub-pixel
 * accuracy with a parabolic fit on the match surface. Velocity prediction is what
 * lets the search window stay small, which is what makes this fast enough to run
 * on a few hundred frames without a worker.
 *
 * Planar tracks follow eight points - the four seeded corners plus the four edge
 * midpoints - and fit a single homography through all of them each frame. That is
 * the difference between four independently jittering corners and a rigid plane,
 * and it is what makes a screen replacement sit still on the surface instead of
 * wobbling with every match that lands a pixel out.
 *
 * Frames are obtained by rendering the clip soloed through the compositor, exactly
 * as the stabilizer does, so what gets tracked is what is actually on screen
 * (including the clip's own motion transform) rather than the raw source pixels.
 */
import type { Clip, Id, Project, Sequence, TrackAnalysis } from '../../types/project';
import { uid } from '../util';
// The maths this driver is built on. Re-exported so callers keep one import
// path, and so the driver can be lazy-loaded while the small helpers stay
// statically importable from './trackMaths'.
export * from './trackMaths';
import { applyHomography, fitHomography, findPatch, patchZNCC, quadMidpoints, toLumaPlane, type LumaPlane } from './trackMaths';

/* ======================================================================== */
/*  Analysis driver                                                          */
/* ======================================================================== */

export interface TrackOptions {
  /** Frames per second to analyse. Default: the sequence rate, capped. */
  sampleFps?: number;
  /** Hard cap on analysed frames. Default 600. */
  maxSamples?: number;
  /** Half-width of the matched patch, in analysis pixels. Default 10. */
  patchRadius?: number;
  /** Half-width of the integer search window, in analysis pixels. Default 12. */
  searchRadius?: number;
  /** Analysis width in pixels. Default 480. */
  analysisWidth?: number;
  /** Fit one homography per frame from all tracked points (planar only). */
  planar?: boolean;
}

export interface TrackProgress {
  done: number;
  total: number;
}

/**
 * Track `seed` through `clip`. Seeds and results are normalized 0..1 in the
 * rendered frame with y DOWN (ImageData convention) - flip y when writing to
 * anything expressed in GL uv space, such as Corner Pin.
 *
 * Returns null when the clip is too short or cannot be rendered.
 */
export async function analyzeTrack(
  project: Project,
  seq: Sequence,
  clip: Clip,
  seed: [number, number][],
  kind: 'point' | 'planar',
  opts: TrackOptions = {},
  onProgress?: (p: TrackProgress) => void,
  isCancelled?: () => boolean,
): Promise<TrackAnalysis | null> {
  if (!seed.length) return null;
  const { getCompositor } = await import('../playback/playback');
  const comp = getCompositor();
  const fps = seq.settings.fps;
  const durSec = clip.duration / fps;
  if (durSec < 0.15) return null;

  const maxSamples = opts.maxSamples ?? 600;
  let sampleFps = Math.min(opts.sampleFps ?? fps, fps);
  if (durSec * sampleFps > maxSamples) sampleFps = Math.max(1, maxSamples / durSec);
  const step = 1 / sampleFps;
  const times: number[] = [];
  for (let t = 0; t < durSec - 1e-4; t += step) times.push(t);
  if (times.length < 2) times.push(durSec);
  if (times.length < 2) return null;

  const analysisWidth = opts.analysisWidth ?? 480;
  const renderScale = Math.max(1, Math.min(8, Math.round(seq.settings.width / analysisWidth) || 1));
  const r = Math.max(3, opts.patchRadius ?? 10);
  const searchBase = Math.max(2, opts.searchRadius ?? 12);

  // Planar tracks follow the four seeded corners plus the four edge midpoints and
  // fit one homography through all eight, so a single bad match cannot drag a
  // corner off the surface.
  const planar = kind === 'planar' && seed.length === 4 && (opts.planar ?? true);
  const tracked: [number, number][] = planar ? [...seed, ...quadMidpoints(seed)] : seed.slice(0, kind === 'planar' ? 4 : 1);
  const nPts = tracked.length;

  const positions: [number, number][][] = [];
  const confidence: number[] = [];
  const frames: number[] = [];
  const cur = tracked.map((p) => [p[0], p[1]] as [number, number]);
  const vel = tracked.map(() => [0, 0] as [number, number]);
  const scores = new Array<number>(nPts).fill(1);

  let prevPlane: LumaPlane | null = null;
  let aw = 0;
  let ah = 0;

  for (let i = 0; i < times.length; i++) {
    if (isCancelled?.()) return null;
    const t = times[i];
    const frame = Math.round(clip.start + t * fps);
    const rt = await comp.renderFrame(project, seq, frame, { soloClipId: clip.id, effects: false, captions: false, scale: renderScale });
    let img: ImageData;
    try {
      img = comp.readPixels(rt, [0, 0, 0]);
    } finally {
      comp.release(rt);
    }
    const plane = toLumaPlane(img);
    // Search window grows with the measured speed: a fast pan needs a wider
    // window, and keeping it tight when nothing moves is what makes this fast.
    const speed = Math.max(...vel.map((v) => Math.hypot(v[0], v[1])));
    const search = Math.max(searchBase, Math.min(40, Math.round(searchBase + speed * aw * 1.5)));

    if (prevPlane && prevPlane.w === plane.w && prevPlane.h === plane.h) {
      for (let p = 0; p < nPts; p++) {
        const px = cur[p][0] * plane.w;
        const py = cur[p][1] * plane.h;
        const m = findPatch(prevPlane, plane, px, py, r, search, vel[p][0] * plane.w, vel[p][1] * plane.h);
        // A weak match means the feature left, was occluded or was never
        // distinctive. Coast on the current velocity rather than snapping to
        // wherever the noise scored highest, and report the low confidence so the
        // UI can flag the frame range.
        if (m.score < 0.35) {
          cur[p] = [cur[p][0] + vel[p][0], cur[p][1] + vel[p][1]];
          scores[p] = Math.min(scores[p], m.score);
        } else {
          const nx = px + m.dx;
          const ny = py + m.dy;
          const nvx = m.dx / Math.max(1, plane.w);
          const nvy = m.dy / Math.max(1, plane.h);
          // Smooth the velocity so one bad frame does not throw the predictor off
          // for the rest of the track.
          vel[p] = [vel[p][0] * 0.4 + nvx * 0.6, vel[p][1] * 0.4 + nvy * 0.6];
          cur[p] = [nx / plane.w, ny / plane.h];
          scores[p] = scores[p] * 0.6 + m.score * 0.4;
        }
      }
    }
    prevPlane = plane;
    aw = plane.w;
    ah = plane.h;

    let outPts: [number, number][] = cur.map((p) => [p[0], p[1]] as [number, number]);
    if (planar && i > 0) {
      const h = fitHomography(tracked, outPts.slice(0, tracked.length));
      if (h) {
        // Re-derive every point from the fitted plane, which averages the noise
        // of all eight matches into each output corner.
        outPts = tracked.map((p) => applyHomography(h, p));
        for (let p = 0; p < nPts; p++) cur[p] = outPts[p];
      }
    }

    positions.push(outPts.slice(0, seed.length));
    confidence.push(scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length));
    frames.push(frame);
    onProgress?.({ done: i + 1, total: times.length });
    // Yield so the UI stays responsive and the progress bar actually repaints.
    if ((i & 3) === 3) await new Promise((res) => setTimeout(res, 0));
  }
  void ah;

  if (positions.length < 2) return null;
  return {
    id: uid('track'),
    name: kind === 'planar' ? 'Planar track' : 'Point track',
    kind,
    seed: seed.slice(0, seed.length) as [number, number][],
    positions,
    frames,
    confidence,
    startSec: times[0],
    endSec: times[times.length - 1],
    at: Date.now(),
  };
}
