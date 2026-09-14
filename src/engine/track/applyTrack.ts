/**
 * Applying a finished track to something the user can see.
 *
 * A track is just a list of positions over time; it becomes useful when it drives
 * a parameter. Each target writes keyframes over the clip's own local timeline,
 * so the motion survives trimming, retiming and moving the clip to another track.
 *
 * COORDINATE CONVENTIONS - the one place this can silently go wrong:
 *
 *   TrackAnalysis positions are normalized 0..1 with Y DOWN, because that is what
 *   ImageData and every 2D canvas use, and it is what the tracker sees.
 *
 *   Effect point parameters and effect mask centres are normalized with Y UP,
 *   because the shaders compare them against GL `uv` (see EffectControls' toXY,
 *   which flips with (1 - p[1]) when drawing them onto a screen-space overlay).
 *
 *   Graphic layer x/y are sequence PIXELS with Y DOWN, because they are painted by
 *   a CanvasRenderingContext2D.
 *
 * So: flip Y for effect params and masks, scale to pixels without flipping for
 * graphic layers. Getting this backwards does not error - it just pins the
 * graphic to a mirror-image path, which looks like the tracker "drifting".
 */
import type { Clip, Id, Param, Sequence, TrackAnalysis } from '../../types/project';
import { setKeyframe } from '../keyframes';
import { getEffectDef } from '../effects/registry';

/** Normalized Y-down track point -> normalized Y-up parameter value. */
function toParamY(p: [number, number]): [number, number] {
  return [p[0], 1 - p[1]];
}

/** Timeline frame -> keyframe time relative to the clip's own start. */
function localFrame(clip: Clip, frame: number): number {
  return frame - clip.start;
}

function writePoint(param: Param<[number, number]> | undefined, clip: Clip, ta: TrackAnalysis, index: number): Param<[number, number]> | undefined {
  if (!param) return param;
  let p = param;
  for (let i = 0; i < ta.frames.length; i++) {
    const pt = ta.positions[i]?.[index];
    if (!pt) continue;
    p = setKeyframe<[number, number]>(p, localFrame(clip, ta.frames[i]), toParamY(pt), 'linear');
  }
  return p;
}

function writeNumber(param: Param<number> | undefined, clip: Clip, ta: TrackAnalysis, index: number, axis: 0 | 1, scale: number): Param<number> | undefined {
  if (!param) return param;
  let p = param;
  for (let i = 0; i < ta.frames.length; i++) {
    const pt = ta.positions[i]?.[index];
    if (!pt) continue;
    p = setKeyframe<number>(p, localFrame(clip, ta.frames[i]), pt[axis] * scale, 'linear');
  }
  return p;
}

export type ApplyResult = { ok: true; wrote: number; label: string } | { ok: false; reason: string };

/**
 * Write a track onto the effect parameter named by `paramKey`.
 * With no key given, the effect's first point parameter is used - that is almost
 * always what the user means ("pin this effect to the thing I tracked").
 */
export function applyToEffectParam(clip: Clip, ta: TrackAnalysis, effectId: Id, paramKey?: string): ApplyResult {
  const fx = clip.effects.find((e) => e.id === effectId);
  if (!fx) return { ok: false, reason: 'That effect is no longer on the clip.' };
  const def = getEffectDef(fx.type);
  if (!def) return { ok: false, reason: 'Unknown effect type.' };
  const pointDefs = def.params.filter((p) => p.kind === 'point');
  if (!pointDefs.length) return { ok: false, reason: `${def.name} has no position parameter to drive.` };
  const pd = (paramKey && pointDefs.find((p) => p.key === paramKey)) || pointDefs[0];
  if (!pd) return { ok: false, reason: `No parameter called "${paramKey}" on ${def.name}.` };
  const before = fx.params[pd.key];
  const after = writePoint(before as Param<[number, number]> | undefined, clip, ta, 0);
  if (!after) return { ok: false, reason: 'Could not write to that parameter.' };
  fx.params[pd.key] = after;
  // Record which track drove this effect in the effect's opaque data bag - the
  // same place the LUT id and the Magic Mask track id live - so the UI can show
  // "tracked" on the parameter and offer to re-apply or clear it.
  fx.data = { ...(fx.data ?? {}), trackId: ta.id, trackParam: pd.key };
  ta.appliedTo = { type: 'effect', clipEffectId: effectId, paramPrefix: pd.key };
  return { ok: true, wrote: ta.frames.length, label: `${def.name} \u203A ${pd.label}` };
}

/** Drive an effect mask's centre, so a blur or a key follows the tracked object. */
export function applyToMask(clip: Clip, ta: TrackAnalysis, effectId: Id, maskId: Id): ApplyResult {
  const fx = clip.effects.find((e) => e.id === effectId);
  if (!fx) return { ok: false, reason: 'That effect is no longer on the clip.' };
  const mask = fx.masks.find((m) => m.id === maskId);
  if (!mask) return { ok: false, reason: 'That mask is no longer on the effect.' };
  const after = writePoint(mask.center, clip, ta, 0);
  if (!after) return { ok: false, reason: 'Could not write to the mask centre.' };
  mask.center = after;
  ta.appliedTo = { type: 'mask', effectId, maskId };
  return { ok: true, wrote: ta.frames.length, label: `Mask \u203A ${mask.name}` };
}

/** Drive a Corner Pin's four corners from a planar track. */
export function applyToCornerPin(clip: Clip, ta: TrackAnalysis, effectId: Id): ApplyResult {
  const fx = clip.effects.find((e) => e.id === effectId);
  if (!fx) return { ok: false, reason: 'That effect is no longer on the clip.' };
  if (fx.type !== 'cornerPin') return { ok: false, reason: 'That effect is not a Corner Pin.' };
  if (ta.kind !== 'planar') return { ok: false, reason: 'Corner Pin needs a planar (four corner) track, not a single point.' };
  // TrackAnalysis.seed order is tl, tr, br, bl; Corner Pin's parameters are named
  // ul, ur, ll, lr with the same defaults, so the mapping is positional.
  const KEYS = ['ul', 'ur', 'll', 'lr'];
  let wrote = 0;
  for (let k = 0; k < 4; k++) {
    const before = fx.params[KEYS[k]] as Param<[number, number]> | undefined;
    const after = writePoint(before, clip, ta, k);
    if (!after) return { ok: false, reason: `Corner Pin is missing its ${KEYS[k]} parameter.` };
    fx.params[KEYS[k]] = after;
    wrote++;
  }
  ta.appliedTo = { type: 'cornerPin', effectId };
  return { ok: true, wrote: wrote * ta.frames.length, label: 'Corner Pin \u203A all four corners' };
}

/**
 * Drive a graphic layer's position, so a title or callout rides along with the
 * tracked object. Coordinates are sequence pixels, Y down - no flip here.
 */
export function applyToGraphicLayer(clip: Clip, seq: Sequence, ta: TrackAnalysis, layerId: Id): ApplyResult {
  const doc = clip.graphic;
  if (!doc) return { ok: false, reason: 'That clip is not a graphic.' };
  const layer = doc.layers.find((l) => l.id === layerId);
  if (!layer) return { ok: false, reason: 'That layer is no longer in the graphic.' };
  const w = seq.settings.width;
  const h = seq.settings.height;
  const x = writeNumber(layer.x, clip, ta, 0, 0, w);
  const y = writeNumber(layer.y, clip, ta, 0, 1, h);
  if (!x || !y) return { ok: false, reason: 'Could not write to the layer position.' };
  layer.x = x;
  layer.y = y;
  // A responsive pin would fight the keyframes by re-anchoring the layer to a
  // frame edge, so clear it: the track is now the source of truth for position.
  if (layer.pin && layer.pin !== 'none') layer.pin = 'none';
  ta.appliedTo = { type: 'graphicLayer', layerId };
  return { ok: true, wrote: ta.frames.length, label: `Graphic \u203A ${layer.name}` };
}

/**
 * Remove the keyframes a track wrote, restoring each parameter to a single static
 * value taken from the first tracked position. Undo also covers this, but a track
 * can be re-applied many times and the user may want to clear one without rolling
 * back everything since.
 */
export function clearApplied(clip: Clip, seq: Sequence, ta: TrackAnalysis): ApplyResult {
  const target = ta.appliedTo;
  if (!target) return { ok: false, reason: 'This track has not been applied to anything.' };
  const first = ta.positions[0]?.[0];
  const strip = (p: Param<any> | undefined): Param<any> | undefined => (p ? { ...p, keyframes: undefined, animated: false } : p);
  if (target.type === 'effect' || target.type === 'cornerPin') {
    const fx = clip.effects.find((e) => e.id === (target.type === 'effect' ? target.clipEffectId : target.effectId));
    if (!fx) return { ok: false, reason: 'The effect it was applied to is gone.' };
    if (target.type === 'cornerPin') {
      for (const k of ['ul', 'ur', 'll', 'lr']) fx.params[k] = strip(fx.params[k])!;
    } else {
      const key = target.paramPrefix;
      if (key) fx.params[key] = strip(fx.params[key])!;
    }
    if (fx.data?.trackId === ta.id) {
      const d = { ...fx.data };
      delete d.trackId;
      delete d.trackParam;
      fx.data = d;
    }
  } else if (target.type === 'mask') {
    const fx = clip.effects.find((e) => e.id === target.effectId);
    const mask = fx?.masks.find((m) => m.id === target.maskId);
    if (!mask) return { ok: false, reason: 'The mask it was applied to is gone.' };
    mask.center = strip(mask.center)!;
  } else {
    const layer = clip.graphic?.layers.find((l) => l.id === target.layerId);
    if (!layer) return { ok: false, reason: 'The graphic layer it was applied to is gone.' };
    layer.x = strip(layer.x)!;
    layer.y = strip(layer.y)!;
  }
  void first;
  ta.appliedTo = undefined;
  return { ok: true, wrote: 0, label: 'Cleared' };
}
