import type { Clip, EffectInstance, EffectMask, MediaAsset, Project, Sequence, Track, BlendMode } from '../../types/project';
import { BLEND_MODES } from '../../types/project';
import { GLCore, type RenderTarget } from './glcore';
import { BARS_FRAG, BLEND_FRAG, COPY_FRAG, MASK_MIX_FRAG, MOTION_FRAG, PRESENT_FRAG, SHAPE_MASK_FRAG, SOLID_FRAG, buildEffectFrag, buildTransitionFrag } from './shaders';
import { EFFECT_MAP } from '../effects/registry';
import { TRANSITION_MAP } from '../effects/transitions';
import { evalParam } from '../keyframes';
import { getMedia } from '../media/mediaStore';
import { clipEnd, sourceTimeAt, transitionAtCut, transitionRange } from '../timeline/edits';
import { renderCaption, renderGraphic } from '../graphics/graphicRenderer';
import { hexToRgb } from '../util';

/*
  Frame compositor.

  renderFrame(project, sequence, frame) -> RenderTarget with the premultiplied
  composite at sequence resolution (or a divided preview resolution).

  Track order: V1 is the bottom. For each visible video track with a clip at
  `frame`:
     source texture -> clip effects (with masks) -> motion transform into
     sequence space -> blend onto the accumulator.
  Transitions render both clips first then mix.
*/

export interface RenderOptions {
  /** Divide resolution by this for preview (1, 2, 4). */
  scale?: number;
  /** Render the adjustment layers / effects (false = raw for fast scrubbing). */
  effects?: boolean;
  /** Include burned-in captions. */
  captions?: boolean;
  /** Only render this clip (Source monitor style). */
  soloClipId?: string | null;
  /** Nested depth guard. */
  depth?: number;
}

const blendIndex: Record<BlendMode, number> = Object.fromEntries(BLEND_MODES.map((b, i) => [b.id, i])) as any;

interface TexCacheEntry {
  tex: WebGLTexture;
  key: string;
  width: number;
  height: number;
  lastUsed: number;
}

export class Compositor {
  core: GLCore;
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement | OffscreenCanvas;
  private texCache = new Map<string, TexCacheEntry>();
  private graphicCanvas: HTMLCanvasElement;
  private graphicCtx: CanvasRenderingContext2D;
  private captionCanvas: HTMLCanvasElement;
  private captionCtx: CanvasRenderingContext2D;
  private echoBuffers = new Map<string, RenderTarget>();
  private blackTex: WebGLTexture;
  private whiteMaskTex: WebGLTexture;
  frameCounter = 0;
  /** Set true when a texture had to be substituted because media was not ready. */
  lastFrameIncomplete = false;
  onShaderError?: (msg: string) => void;
  private badPrograms = new Set<string>();

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: false, antialias: false, preserveDrawingBuffer: true, desynchronized: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is required');
    this.gl = gl;
    this.core = new GLCore(gl);
    this.graphicCanvas = document.createElement('canvas');
    this.graphicCtx = this.graphicCanvas.getContext('2d', { willReadFrequently: false })!;
    this.captionCanvas = document.createElement('canvas');
    this.captionCtx = this.captionCanvas.getContext('2d')!;
    this.blackTex = this.core.solidTexture(0, 0, 0, 1);
    this.whiteMaskTex = this.core.solidTexture(1, 1, 1, 1);
  }

  /* ---------- texture sourcing ---------- */

  private cacheTexture(key: string, id: string, upload: (tex: WebGLTexture | null) => WebGLTexture, width: number, height: number): WebGLTexture {
    const entry = this.texCache.get(id);
    if (entry && entry.key === key) {
      entry.lastUsed = this.frameCounter;
      return entry.tex;
    }
    const tex = upload(entry?.tex ?? null);
    this.texCache.set(id, { tex, key, width, height, lastUsed: this.frameCounter });
    if (this.texCache.size > 64) {
      let oldest: string | null = null;
      let oldestT = Infinity;
      for (const [k, v] of this.texCache)
        if (v.lastUsed < oldestT) {
          oldestT = v.lastUsed;
          oldest = k;
        }
      if (oldest && oldest !== id) {
        this.core.deleteTexture(this.texCache.get(oldest)!.tex);
        this.texCache.delete(oldest);
      }
    }
    return tex;
  }

  /** Returns source texture + dimensions for a clip at a frame, or null when unavailable. */
  private async clipSource(project: Project, seq: Sequence, clip: Clip, frame: number, asset: MediaAsset | undefined, opts: RenderOptions): Promise<{ tex: WebGLTexture; width: number; height: number; rt?: RenderTarget } | null> {
    const fps = seq.settings.fps;
    const W = seq.settings.width,
      H = seq.settings.height;
    const local = frame - clip.start;
    // Nested sequence
    if (clip.nestedSequenceId) {
      const nested = project.sequences.find((s) => s.id === clip.nestedSequenceId);
      if (!nested || (opts.depth ?? 0) > 4) return null;
      const srcSec = sourceTimeAt(clip, frame, fps);
      const nf = Math.round(srcSec * nested.settings.fps);
      const rt = await this.renderFrame(project, nested, nf, { ...opts, depth: (opts.depth ?? 0) + 1, captions: false, soloClipId: null });
      return { tex: rt.tex, width: rt.width, height: rt.height, rt };
    }
    // Generators
    const gen = clip.generator ?? asset?.generator;
    if (gen) {
      const gp = { ...(asset?.generatorParams ?? {}), ...(clip.generatorParams ?? {}) };
      if (gen === 'graphic') {
        const doc = clip.graphic ?? asset?.graphic;
        if (!doc) return null;
        const gw = Math.round(W / (opts.scale ?? 1)),
          gh = Math.round(H / (opts.scale ?? 1));
        if (this.graphicCanvas.width !== gw || this.graphicCanvas.height !== gh) {
          this.graphicCanvas.width = gw;
          this.graphicCanvas.height = gh;
        }
        this.graphicCtx.setTransform(gw / W, 0, 0, gh / H, 0, 0);
        renderGraphic(this.graphicCtx, doc, local, fps, clip.duration, W, H);
        this.graphicCtx.setTransform(1, 0, 0, 1, 0, 0);
        const tex = this.core.upload(null, this.graphicCanvas, { flipY: false });
        // ephemeral texture: register in cache with unique key so it is deleted eventually
        this.texCache.set('gfx:' + clip.id, { tex, key: String(Math.random()), width: W, height: H, lastUsed: this.frameCounter });
        return { tex, width: W, height: H };
      }
      if (gen === 'colorMatte' || gen === 'blackVideo' || gen === 'adjustmentLayer') {
        const color = gen === 'blackVideo' ? '#000000' : String(gp.color ?? '#808080');
        const [r, g, b] = hexToRgb(color);
        const rt = this.core.acquire(W / (opts.scale ?? 1), H / (opts.scale ?? 1));
        this.core.bindTarget(rt);
        const prog = this.core.program('solid', SOLID_FRAG);
        this.gl.useProgram(prog);
        this.core.setUniform(prog, 'u_color', [r, g, b, gen === 'adjustmentLayer' ? 0 : 1]);
        this.core.drawQuad();
        return { tex: rt.tex, width: W, height: H, rt };
      }
      if (gen === 'barsAndTone') {
        const rt = this.core.acquire(W / (opts.scale ?? 1), H / (opts.scale ?? 1));
        this.core.bindTarget(rt);
        const prog = this.core.program('bars', BARS_FRAG);
        this.gl.useProgram(prog);
        this.core.drawQuad();
        return { tex: rt.tex, width: W, height: H, rt };
      }
      if (gen === 'countdown') {
        const gw = Math.round(W / (opts.scale ?? 1)),
          gh = Math.round(H / (opts.scale ?? 1));
        if (this.graphicCanvas.width !== gw || this.graphicCanvas.height !== gh) {
          this.graphicCanvas.width = gw;
          this.graphicCanvas.height = gh;
        }
        const c = this.graphicCtx;
        c.setTransform(gw / W, 0, 0, gh / H, 0, 0);
        drawCountdown(c, W, H, local / fps, clip.duration / fps, gp);
        c.setTransform(1, 0, 0, 1, 0, 0);
        const tex = this.core.upload(null, this.graphicCanvas);
        this.texCache.set('gfx:' + clip.id, { tex, key: String(Math.random()), width: W, height: H, lastUsed: this.frameCounter });
        return { tex, width: W, height: H };
      }
    }
    if (!asset) return null;
    const media = getMedia(asset.id);
    if (!media) {
      this.lastFrameIncomplete = true;
      return null;
    }
    if (asset.kind === 'image') {
      if (!media.image) {
        this.lastFrameIncomplete = true;
        return null;
      }
      const img = media.image;
      const tex = this.cacheTexture('img', 'asset:' + asset.id, (t) => this.core.upload(t, img), img.width, img.height);
      return { tex, width: img.width, height: img.height };
    }
    if (asset.kind === 'video' || asset.hasVideo) {
      const src = media.video;
      if (!src) {
        this.lastFrameIncomplete = true;
        return null;
      }
      let srcTime = sourceTimeAt(clip, frame, fps);
      // posterize time effect lowers effective fps
      const pt = clip.effects.find((e) => e.type === 'posterizeTime' && e.enabled);
      if (pt) {
        const pfps = Number(evalParam(pt.params.fps, local)) || 12;
        srcTime = Math.floor(srcTime * pfps) / pfps;
      }
      srcTime = Math.max(0, Math.min((asset.duration ?? src.duration) - 1e-3, srcTime));
      const img = await src.getFrame(srcTime);
      if (!img) {
        this.lastFrameIncomplete = true;
        const stale = this.texCache.get('asset:' + asset.id);
        if (stale) return { tex: stale.tex, width: stale.width, height: stale.height };
        return null;
      }
      const key = src.kind === 'element' ? `t${Math.round(srcTime * 1000)}` : `t${Math.round(srcTime * 1000)}`;
      const w = src.width,
        h = src.height;
      const tex = this.cacheTexture(key, 'asset:' + asset.id, (t) => this.core.upload(t, img as TexImageSource), w, h);
      return { tex, width: w, height: h };
    }
    return null;
  }

  /* ---------- effects ---------- */

  private effectProgram(type: string, pass: number): WebGLProgram | null {
    const def = EFFECT_MAP[type];
    if (!def || def.audio) return null;
    const key = `fx:${type}:${pass}`;
    if (this.badPrograms.has(key)) return null;
    try {
      return this.core.program(key, buildEffectFrag(def, pass));
    } catch (e: any) {
      this.badPrograms.add(key);
      this.onShaderError?.(`${def.name}: ${e.message}`);
      return null;
    }
  }

  private setParamUniforms(prog: WebGLProgram, params: EffectInstance['params'], defs: { key: string; kind: string; default: any }[], local: number) {
    for (const d of defs) {
      const p = params[d.key];
      let v: any = p ? evalParam(p, local) : d.default;
      if (d.kind === 'color') {
        if (typeof v === 'string') {
          const [r, g, b] = hexToRgb(v);
          v = [r, g, b, 1];
        }
        if (!Array.isArray(v) || v.length < 4) v = [0.5, 0.5, 0.5, 1];
        this.core.setUniform(prog, 'p_' + d.key, v);
      } else if (d.kind === 'point') {
        this.core.setUniform(prog, 'p_' + d.key, Array.isArray(v) ? [v[0], v[1]] : [0.5, 0.5]);
      } else if (d.kind === 'bool') {
        this.core.setUniform(prog, 'p_' + d.key, v ? 1 : 0);
      } else {
        this.core.setUniform(prog, 'p_' + d.key, typeof v === 'number' ? v : Number(v) || 0);
      }
    }
  }

  /** Rasterise masks into a coverage texture. Returns null if no enabled masks. */
  private rasterMasks(masks: EffectMask[], local: number, width: number, height: number): RenderTarget | null {
    if (!masks.length) return null;
    const gl = this.gl;
    let prev: RenderTarget | null = null;
    for (let i = 0; i < masks.length; i++) {
      const m = masks[i];
      const rt = this.core.acquire(width, height);
      this.core.bindTarget(rt);
      const prog = this.core.program('shapeMask', SHAPE_MASK_FRAG);
      gl.useProgram(prog);
      const center = evalParam(m.center, local) as [number, number];
      const size = evalParam(m.size, local) as [number, number];
      this.core.setUniform(prog, 'u_res', [width, height]);
      this.core.setUniform(prog, 'u_center', [center[0], center[1]]);
      this.core.setUniform(prog, 'u_size', [size[0], size[1]]);
      this.core.setUniform(prog, 'u_rotation', (evalParam(m.rotation, local) * Math.PI) / 180);
      this.core.setUniform(prog, 'u_feather', evalParam(m.feather, local) * (width / 1920));
      this.core.setUniform(prog, 'u_expansion', evalParam(m.expansion, local) * (width / 1920));
      this.core.setInt(prog, 'u_shape', m.shape === 'ellipse' ? 1 : 0);
      this.core.setUniform(prog, 'u_inverted', m.inverted ? 1 : 0);
      this.core.setUniform(prog, 'u_opacity', evalParam(m.opacity, local) / 100);
      this.core.setInt(prog, 'u_accumulate', prev ? 1 : 0);
      this.core.bindTex(0, prev ? prev.tex : this.whiteMaskTex);
      this.core.setInt(prog, 'u_prevMask', 0);
      this.core.drawQuad();
      if (prev) this.core.release(prev);
      prev = rt;
    }
    return prev;
  }

  /** Apply a list of effects to an input texture (premultiplied). Returns a RenderTarget the caller must release. */
  private applyEffects(input: WebGLTexture, width: number, height: number, effects: EffectInstance[], local: number, seqTime: number, fps: number, ownerId: string, matteTex: WebGLTexture | null): RenderTarget {
    const gl = this.gl;
    let cur = this.core.acquire(width, height);
    // copy input
    this.core.bindTarget(cur);
    const copy = this.core.program('copy', COPY_FRAG);
    gl.useProgram(copy);
    this.core.bindTex(0, input);
    this.core.setInt(copy, 'u_tex', 0);
    this.core.setUniform(copy, 'u_flipY', 0);
    this.core.drawQuad();

    for (const fx of effects) {
      if (!fx.enabled) continue;
      const def = EFFECT_MAP[fx.type];
      if (!def || def.audio) continue;
      const orig = cur;
      let src = cur;
      let lastOut: RenderTarget | null = null;
      for (let pi = 0; pi < def.passes.length; pi++) {
        const prog = this.effectProgram(fx.type, pi);
        if (!prog) break;
        const out = this.core.acquire(width, height);
        this.core.bindTarget(out);
        gl.useProgram(prog);
        this.core.bindTex(0, src.tex);
        this.core.setInt(prog, 'u_tex', 0);
        this.core.bindTex(1, orig.tex);
        this.core.setInt(prog, 'u_orig', 1);
        // echo previous frame buffer
        if (fx.type === 'echo') {
          const eb = this.echoBuffers.get(ownerId + fx.id);
          this.core.bindTex(2, eb ? eb.tex : this.blackTex);
          this.core.setInt(prog, 'u_prev', 2);
        }
        if (fx.type === 'trackMatteKey') {
          this.core.bindTex(3, matteTex ?? this.blackTex);
          this.core.setInt(prog, 'u_matte', 3);
        }
        this.core.setUniform(prog, 'u_res', [width, height]);
        this.core.setUniform(prog, 'u_time', local / fps);
        this.core.setUniform(prog, 'u_seqTime', seqTime);
        this.core.setUniform(prog, 'u_frame', local);
        this.setParamUniforms(prog, fx.params, def.params, local);
        this.core.drawQuad();
        if (lastOut && lastOut !== orig) this.core.release(lastOut);
        lastOut = out;
        src = out;
      }
      if (!lastOut) continue;
      // masks: mix original and effected
      const enabledMasks = fx.masks ?? [];
      if (enabledMasks.length) {
        const maskRt = this.rasterMasks(enabledMasks, local, width, height);
        if (maskRt) {
          const mixed = this.core.acquire(width, height);
          this.core.bindTarget(mixed);
          const mp = this.core.program('maskMix', MASK_MIX_FRAG);
          gl.useProgram(mp);
          this.core.bindTex(0, orig.tex);
          this.core.setInt(mp, 'u_orig', 0);
          this.core.bindTex(1, lastOut.tex);
          this.core.setInt(mp, 'u_fx', 1);
          this.core.bindTex(2, maskRt.tex);
          this.core.setInt(mp, 'u_maskTex', 2);
          this.core.drawQuad();
          this.core.release(maskRt);
          this.core.release(lastOut);
          lastOut = mixed;
        }
      }
      if (fx.type === 'echo') {
        // persist output for next frame
        let eb = this.echoBuffers.get(ownerId + fx.id);
        if (!eb || eb.width !== width || eb.height !== height) {
          if (eb) this.core.release(eb);
          eb = this.core.acquire(width, height);
          this.echoBuffers.set(ownerId + fx.id, eb);
        }
        this.core.bindTarget(eb);
        gl.useProgram(copy);
        this.core.bindTex(0, lastOut.tex);
        this.core.setInt(copy, 'u_tex', 0);
        this.core.setUniform(copy, 'u_flipY', 0);
        this.core.drawQuad();
        eb.inUse = true;
      }
      this.core.release(orig);
      cur = lastOut;
    }
    return cur;
  }

  /* ---------- motion ---------- */

  /** Draw src (premultiplied) into a sequence-sized target using clip motion. */
  private drawWithMotion(dst: RenderTarget, srcTex: WebGLTexture, srcW: number, srcH: number, clip: Clip, local: number, seq: Sequence, isSequenceSized: boolean) {
    const gl = this.gl;
    const m = clip.motion;
    const prog = this.core.program('motion', MOTION_FRAG);
    this.core.bindTarget(dst);
    this.core.clear(0, 0, 0, 0);
    gl.useProgram(prog);
    const W = seq.settings.width,
      H = seq.settings.height;
    const pos = evalParam(m.position, local) as [number, number];
    const anchor = evalParam(m.anchor, local) as [number, number];
    const scale = evalParam(m.scale, local) / 100;
    const scaleW = m.uniformScale ? scale : evalParam(m.scaleWidth, local) / 100;
    const rot = (evalParam(m.rotation, local) * Math.PI) / 180;
    const opacity = Math.max(0, Math.min(1, evalParam(m.opacity, local) / 100));
    // Fit rule: sources are placed at native pixel size (like Premiere's default),
    // unless they are sequence-sized generators. Images larger than the frame get "scale to frame" automatically at import in placeAsset? No: keep native, user can Set to Frame Size.
    let baseScale = 1;
    if (isSequenceSized) baseScale = W / srcW;
    const sx = (scaleW * baseScale * dst.width) / W;
    const sy = (scale * baseScale * dst.height) / H;
    this.core.bindTex(0, srcTex);
    this.core.setInt(prog, 'u_tex', 0);
    this.core.setUniform(prog, 'u_seqRes', [dst.width, dst.height]);
    this.core.setUniform(prog, 'u_srcRes', [srcW, srcH]);
    this.core.setUniform(prog, 'u_position', [pos[0], pos[1]]);
    this.core.setUniform(prog, 'u_anchor', [anchor[0], anchor[1]]);
    this.core.setUniform(prog, 'u_scale', [sx, sy]);
    this.core.setUniform(prog, 'u_rotation', rot);
    this.core.setUniform(prog, 'u_opacity', opacity);
    this.core.setUniform(prog, 'u_flipY', 0);
    this.core.drawQuad();
  }

  private blendOnto(acc: RenderTarget, layer: RenderTarget, mode: BlendMode): RenderTarget {
    const gl = this.gl;
    const out = this.core.acquire(acc.width, acc.height);
    this.core.bindTarget(out);
    const prog = this.core.program('blend', BLEND_FRAG);
    gl.useProgram(prog);
    this.core.bindTex(0, acc.tex);
    this.core.setInt(prog, 'u_dst', 0);
    this.core.bindTex(1, layer.tex);
    this.core.setInt(prog, 'u_src', 1);
    this.core.setInt(prog, 'u_mode', blendIndex[mode] ?? 0);
    this.core.setUniform(prog, 'u_seed', (this.frameCounter % 1000) * 0.37);
    this.core.drawQuad();
    this.core.release(acc);
    return out;
  }

  /** Render a single clip into a sequence-sized layer (effects + motion applied). */
  private async renderClipLayer(project: Project, seq: Sequence, clip: Clip, frame: number, W: number, H: number, opts: RenderOptions, matteTex: WebGLTexture | null, below: RenderTarget | null): Promise<RenderTarget | null> {
    const fps = seq.settings.fps;
    const asset = project.assets.find((a) => a.id === clip.assetId);
    const local = frame - clip.start;
    const isAdjustment = (clip.generator ?? asset?.generator) === 'adjustmentLayer';
    if (isAdjustment) {
      // Adjustment layer: apply its effects to everything below.
      if (!below) return null;
      const out = this.applyEffects(below.tex, W, H, opts.effects === false ? [] : clip.effects, local, frame / fps, fps, clip.id, matteTex);
      const layer = this.core.acquire(W, H);
      this.drawWithMotion(layer, out.tex, W, H, clip, local, seq, true);
      this.core.release(out);
      return layer;
    }
    const src = await this.clipSource(project, seq, clip, frame, asset, opts);
    if (!src) return null;
    const isSeqSized = !!clip.nestedSequenceId || !!(clip.generator ?? asset?.generator);
    let effected: RenderTarget | null = null;
    let texToDraw = src.tex;
    let tw = src.width,
      th = src.height;
    // Effects run at source resolution for media, sequence res for generators.
    const fxList = opts.effects === false ? [] : clip.effects;
    if (fxList.some((e) => e.enabled)) {
      const ew = src.rt ? src.rt.width : Math.min(src.width, Math.round(W / (opts.scale ?? 1)) * 2);
      const eh = src.rt ? src.rt.height : Math.round((ew / src.width) * src.height);
      effected = this.applyEffects(src.tex, ew, eh, fxList, local, frame / fps, fps, clip.id, matteTex);
      texToDraw = effected.tex;
      tw = src.width;
      th = src.height;
      void tw;
      void th;
    }
    const layer = this.core.acquire(W, H);
    this.drawWithMotion(layer, texToDraw, src.width, src.height, clip, local, seq, isSeqSized);
    if (effected) this.core.release(effected);
    if (src.rt) this.core.release(src.rt);
    return layer;
  }

  /* ---------- main entry ---------- */

  async renderFrame(project: Project, seq: Sequence, frame: number, opts: RenderOptions = {}): Promise<RenderTarget> {
    this.frameCounter++;
    if ((opts.depth ?? 0) === 0) this.lastFrameIncomplete = false;
    const scale = opts.scale ?? 1;
    const W = Math.max(2, Math.round(seq.settings.width / scale));
    const H = Math.max(2, Math.round(seq.settings.height / scale));
    const fps = seq.settings.fps;
    let acc = this.core.acquire(W, H);
    this.core.bindTarget(acc);
    this.core.clear(0, 0, 0, 0);

    const vtracks = seq.tracks.filter((t) => t.kind === 'video');
    const soloActive = false;
    void soloActive;
    for (let ti = 0; ti < vtracks.length; ti++) {
      const track = vtracks[ti];
      if (!track.visible) continue;
      const clipsHere = seq.clips.filter((c) => c.trackId === track.id && c.enabled && frame >= c.start && frame < clipEnd(c));
      if (opts.soloClipId) {
        if (!clipsHere.some((c) => c.id === opts.soloClipId)) continue;
      }
      // Track matte source: the track directly above (for trackMatteKey users on this track)
      let matteTex: WebGLTexture | null = null;
      let matteRt: RenderTarget | null = null;
      const needsMatte = clipsHere.some((c) => c.effects.some((e) => e.type === 'trackMatteKey' && e.enabled));
      if (needsMatte) {
        const which = clipsHere.flatMap((c) => c.effects.filter((e) => e.type === 'trackMatteKey' && e.enabled)).map((e) => Number(evalParam(e.params.matteSource, 0)) || 0)[0] ?? 0;
        const above = vtracks[ti + 1 + which];
        if (above) {
          const matteClip = seq.clips.find((c) => c.trackId === above.id && c.enabled && frame >= c.start && frame < clipEnd(c));
          if (matteClip) {
            matteRt = await this.renderClipLayer(project, seq, matteClip, frame, W, H, opts, null, null);
            matteTex = matteRt?.tex ?? null;
          }
        }
      }
      for (const clip of clipsHere) {
        // Transition handling: if we're inside a transition range with a partner, render both and mix.
        const inT = transitionAtCut(seq, clip, 'in');
        const inRange = transitionRange(seq, clip, 'in');
        const outT = transitionAtCut(seq, clip, 'out');
        const outRange = transitionRange(seq, clip, 'out');
        let layer: RenderTarget | null = null;
        if (inT && inRange && frame >= inRange[0] && frame < inRange[1] && inT.from && frame >= clip.start) {
          // incoming side of a cut transition: render mix of previous clip + this clip
          const progress = (frame - inRange[0]) / (inRange[1] - inRange[0]);
          const fromLayer = await this.renderClipLayer(project, seq, inT.from, frame, W, H, opts, matteTex, acc);
          const toLayer = await this.renderClipLayer(project, seq, clip, frame, W, H, opts, matteTex, acc);
          layer = this.mixTransition(inT.transition.type, inT.transition.params, fromLayer, toLayer, progress, W, H, frame - inRange[0]);
          if (fromLayer) this.core.release(fromLayer);
          if (toLayer) this.core.release(toLayer);
        } else if (outT && outRange && frame >= outRange[0] && frame < outRange[1] && outT.to && frame >= outT.to.start) {
          // this frame belongs to the incoming clip's iteration (it is also in clipsHere) - skip to avoid double draw
          continue;
        } else if (outT && outRange && frame >= outRange[0] && frame < outRange[1] && outT.to) {
          // outgoing side before the cut: mix with the incoming clip rendered early
          const progress = (frame - outRange[0]) / (outRange[1] - outRange[0]);
          const fromLayer = await this.renderClipLayer(project, seq, clip, frame, W, H, opts, matteTex, acc);
          const toLayer = await this.renderClipLayer(project, seq, outT.to, frame, W, H, opts, matteTex, acc);
          layer = this.mixTransition(outT.transition.type, outT.transition.params, fromLayer, toLayer, progress, W, H, frame - outRange[0]);
          if (fromLayer) this.core.release(fromLayer);
          if (toLayer) this.core.release(toLayer);
        } else if (inT && inRange && !inT.from && frame >= inRange[0] && frame < inRange[1]) {
          // fade in from transparent
          const progress = (frame - inRange[0]) / (inRange[1] - inRange[0]);
          const toLayer = await this.renderClipLayer(project, seq, clip, frame, W, H, opts, matteTex, acc);
          layer = this.mixTransition(inT.transition.type, inT.transition.params, null, toLayer, progress, W, H, frame - inRange[0]);
          if (toLayer) this.core.release(toLayer);
        } else if (outT && outRange && !outT.to && frame >= outRange[0] && frame < outRange[1]) {
          const progress = (frame - outRange[0]) / (outRange[1] - outRange[0]);
          const fromLayer = await this.renderClipLayer(project, seq, clip, frame, W, H, opts, matteTex, acc);
          layer = this.mixTransition(outT.transition.type, outT.transition.params, fromLayer, null, progress, W, H, frame - outRange[0]);
          if (fromLayer) this.core.release(fromLayer);
        } else {
          layer = await this.renderClipLayer(project, seq, clip, frame, W, H, opts, matteTex, acc);
        }
        if (!layer) continue;
        const isAdjustment = (clip.generator ?? project.assets.find((a) => a.id === clip.assetId)?.generator) === 'adjustmentLayer';
        if (isAdjustment) {
          // replace accumulator with adjusted result composited over original (opacity handled by motion)
          acc = this.blendOnto(acc, layer, 'normal');
        } else {
          acc = this.blendOnto(acc, layer, clip.motion.blendMode);
        }
        this.core.release(layer);
      }
      if (matteRt) this.core.release(matteRt);
    }

    // Captions (burn-in or preview when enabled)
    if (opts.captions !== false && seq.captionTrack.enabled && seq.captions.length) {
      const active = seq.captions.filter((c) => frame >= c.start && frame < c.end);
      if (active.length) {
        const cw = W,
          ch = H;
        if (this.captionCanvas.width !== cw || this.captionCanvas.height !== ch) {
          this.captionCanvas.width = cw;
          this.captionCanvas.height = ch;
        }
        this.captionCtx.clearRect(0, 0, cw, ch);
        this.captionCtx.setTransform(cw / seq.settings.width, 0, 0, ch / seq.settings.height, 0, 0);
        for (const c of active) renderCaption(this.captionCtx, c.text, { ...seq.captionTrack.style, ...(c.style ?? {}) }, seq.settings.width, seq.settings.height);
        this.captionCtx.setTransform(1, 0, 0, 1, 0, 0);
        const tex = this.core.upload(this.texCache.get('captions')?.tex ?? null, this.captionCanvas);
        this.texCache.set('captions', { tex, key: 'cap', width: cw, height: ch, lastUsed: this.frameCounter });
        const layer = this.core.acquire(W, H);
        this.core.bindTarget(layer);
        const copy = this.core.program('copy', COPY_FRAG);
        this.gl.useProgram(copy);
        this.core.bindTex(0, tex);
        this.core.setInt(copy, 'u_tex', 0);
        this.core.setUniform(copy, 'u_flipY', 0);
        this.core.drawQuad();
        acc = this.blendOnto(acc, layer, 'normal');
        this.core.release(layer);
      }
    }
    return acc;
  }

  private mixTransition(type: string, params: Record<string, any>, from: RenderTarget | null, to: RenderTarget | null, progress: number, W: number, H: number, local: number): RenderTarget {
    const gl = this.gl;
    const def = TRANSITION_MAP[type];
    const out = this.core.acquire(W, H);
    this.core.bindTarget(out);
    const key = 'tr:' + type;
    let prog: WebGLProgram | null = null;
    if (def && !def.audio && !this.badPrograms.has(key)) {
      try {
        prog = this.core.program(key, buildTransitionFrag(def));
      } catch (e: any) {
        this.badPrograms.add(key);
        this.onShaderError?.(`${def.name}: ${e.message}`);
      }
    }
    if (!prog) prog = this.core.program('tr:crossDissolve', buildTransitionFrag(TRANSITION_MAP.crossDissolve));
    gl.useProgram(prog);
    const empty = this.core.acquire(W, H);
    this.core.bindTarget(empty);
    this.core.clear(0, 0, 0, 0);
    this.core.bindTarget(out);
    this.core.bindTex(0, from ? from.tex : empty.tex);
    this.core.setInt(prog, 'u_from', 0);
    this.core.bindTex(1, to ? to.tex : empty.tex);
    this.core.setInt(prog, 'u_to', 1);
    this.core.setUniform(prog, 'u_progress', progress);
    this.core.setUniform(prog, 'u_res', [W, H]);
    if (def) this.setParamUniforms(prog, params, def.params, local);
    this.core.drawQuad();
    this.core.release(empty);
    return out;
  }

  /* ---------- present ---------- */

  /** Draw a render target to the canvas (default framebuffer). */
  present(rt: RenderTarget, opts: { bg?: [number, number, number]; channel?: number; checker?: boolean; viewport?: { x: number; y: number; w: number; h: number } } = {}) {
    const gl = this.gl;
    const cw = this.canvas.width,
      ch = this.canvas.height;
    this.core.bindTarget(null, cw, ch);
    gl.clearColor(0.06, 0.06, 0.06, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const vp = opts.viewport ?? { x: 0, y: 0, w: cw, h: ch };
    gl.viewport(vp.x, ch - vp.y - vp.h, vp.w, vp.h);
    const prog = this.core.program('present', PRESENT_FRAG);
    gl.useProgram(prog);
    this.core.bindTex(0, rt.tex);
    this.core.setInt(prog, 'u_tex', 0);
    this.core.setUniform(prog, 'u_bg', opts.bg ?? [0, 0, 0]);
    this.core.setInt(prog, 'u_channel', opts.channel ?? 0);
    this.core.setUniform(prog, 'u_checker', opts.checker ? 1 : 0);
    this.core.drawQuad();
  }

  /** Read back a render target as straight-alpha RGBA8 pixels (top-down). */
  readPixels(rt: RenderTarget, bg: [number, number, number] | null = [0, 0, 0]): ImageData {
    const gl = this.gl;
    // render into an RGBA8 target composited over bg, flipped so row 0 is the top
    const tmp = this.core.readbackTarget(rt.width, rt.height);
    this.core.bindTarget(tmp);
    const prog = this.core.program('present', PRESENT_FRAG);
    gl.useProgram(prog);
    this.core.bindTex(0, rt.tex);
    this.core.setInt(prog, 'u_tex', 0);
    this.core.setUniform(prog, 'u_bg', bg ?? [0, 0, 0]);
    this.core.setInt(prog, 'u_channel', 0);
    this.core.setUniform(prog, 'u_checker', 0);
    this.core.drawQuad();
    const px = new Uint8ClampedArray(rt.width * rt.height * 4);
    gl.readPixels(0, 0, rt.width, rt.height, gl.RGBA, gl.UNSIGNED_BYTE, px as unknown as ArrayBufferView);
    // WebGL reads bottom-up; PRESENT flips uv.y so the texture is already top-down in tmp -> readPixels returns bottom-up of that = flip needed
    const flipped = new Uint8ClampedArray(px.length);
    const row = rt.width * 4;
    for (let y = 0; y < rt.height; y++) flipped.set(px.subarray(y * row, (y + 1) * row), (rt.height - 1 - y) * row);
    return new ImageData(flipped, rt.width, rt.height);
  }

  /** Small readback for scopes: renders into a downscaled target first so the CPU work stays tiny. */
  readPixelsScaled(rt: RenderTarget, maxWidth: number, bg: [number, number, number] | null = [0, 0, 0]): ImageData {
    const scale = Math.min(1, maxWidth / rt.width);
    const w = Math.max(2, Math.round(rt.width * scale)),
      h = Math.max(2, Math.round(rt.height * scale));
    const gl = this.gl;
    const tmp = this.core.readbackTarget(w, h);
    this.core.bindTarget(tmp);
    const prog = this.core.program('present', PRESENT_FRAG);
    gl.useProgram(prog);
    this.core.bindTex(0, rt.tex);
    this.core.setInt(prog, 'u_tex', 0);
    this.core.setUniform(prog, 'u_bg', bg ?? [0, 0, 0]);
    this.core.setInt(prog, 'u_channel', 0);
    this.core.setUniform(prog, 'u_checker', 0);
    this.core.drawQuad();
    const px = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px as unknown as ArrayBufferView);
    const flipped = new Uint8ClampedArray(px.length);
    const row = w * 4;
    for (let y = 0; y < h; y++) flipped.set(px.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
    return new ImageData(flipped, w, h);
  }

  /** Copy a render target to a 2D canvas (for export / thumbnails). */
  drawToCanvas(rt: RenderTarget, target: HTMLCanvasElement | OffscreenCanvas, bg: [number, number, number] = [0, 0, 0]) {
    const cw = this.canvas.width,
      ch = this.canvas.height;
    if (cw !== rt.width || ch !== rt.height) {
      this.canvas.width = rt.width;
      this.canvas.height = rt.height;
    }
    this.present(rt, { bg });
    const ctx = target.getContext('2d') as CanvasRenderingContext2D;
    if (target.width !== rt.width || target.height !== rt.height) {
      target.width = rt.width;
      target.height = rt.height;
    }
    ctx.drawImage(this.canvas as CanvasImageSource, 0, 0);
  }

  release(rt: RenderTarget | null) {
    this.core.release(rt);
  }

  releaseAll() {
    this.core.releaseAll();
    for (const eb of this.echoBuffers.values()) eb.inUse = true;
  }

  clearEcho() {
    for (const eb of this.echoBuffers.values()) this.core.release(eb);
    this.echoBuffers.clear();
  }

  invalidateAsset(assetId: string) {
    const e = this.texCache.get('asset:' + assetId);
    if (e) {
      this.core.deleteTexture(e.tex);
      this.texCache.delete('asset:' + assetId);
    }
  }

  dispose() {
    for (const e of this.texCache.values()) this.core.deleteTexture(e.tex);
    this.texCache.clear();
    this.core.dispose();
  }
}

function drawCountdown(c: CanvasRenderingContext2D, W: number, H: number, t: number, dur: number, gp: Record<string, any>) {
  c.clearRect(0, 0, W, H);
  const remaining = Math.max(0, dur - t);
  const n = Math.ceil(remaining);
  c.fillStyle = String(gp.background ?? '#3a3a3a');
  c.fillRect(0, 0, W, H);
  const cx = W / 2,
    cy = H / 2,
    r = Math.min(W, H) * 0.42;
  // crosshair
  c.strokeStyle = 'rgba(255,255,255,0.25)';
  c.lineWidth = Math.max(1, H / 540);
  c.beginPath();
  c.moveTo(0, cy);
  c.lineTo(W, cy);
  c.moveTo(cx, 0);
  c.lineTo(cx, H);
  c.stroke();
  // wipe
  const frac = 1 - (remaining % 1);
  c.fillStyle = String(gp.wipe ?? '#8a8a8a');
  c.beginPath();
  c.moveTo(cx, cy);
  c.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
  c.closePath();
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.7)';
  c.lineWidth = Math.max(2, H / 270);
  c.beginPath();
  c.arc(cx, cy, r, 0, Math.PI * 2);
  c.stroke();
  c.beginPath();
  c.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
  c.stroke();
  c.fillStyle = '#e8e8e8';
  c.font = `500 ${Math.round(H * 0.45)}px "Inter Variable", Inter, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(String(Math.max(1, Math.min(n, 99))), cx, cy + H * 0.02);
}

export function trackVisible(t: Track) {
  return t.visible;
}
