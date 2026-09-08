import type { Param, ParamValue } from '../../types/project';
import { param } from '../../types/project';

/*
  Effect registry.

  Every video effect is a GLSL fragment program run by the compositor with a
  standard set of uniforms:
    uniform sampler2D u_tex;      // input
    uniform vec2 u_res;           // input resolution in px
    uniform float u_time;         // clip-relative time (seconds)
    uniform float u_seqTime;      // sequence time (seconds)
    + one uniform per parameter (name = p_<key>)

  The main function receives the input color as `vec4 c` and uv as `vec2 uv`
  and writes `outColor`.  Multi-pass effects (blur) declare `passes`.
*/

export type ParamKind = 'number' | 'angle' | 'percent' | 'color' | 'point' | 'bool' | 'select' | 'curve';

export interface ParamDef {
  key: string;
  label: string;
  kind: ParamKind;
  default: ParamValue;
  min?: number;
  max?: number;
  step?: number;
  /** For select. */
  options?: { value: number | string; label: string }[];
  /** UI grouping header. */
  group?: string;
  /** Slider softmax when the param is technically unbounded. */
  softMax?: number;
  softMin?: number;
  /** Uniform type override (default float / vec2 / vec3 depending on kind). */
  uniform?: 'float' | 'vec2' | 'vec3' | 'vec4' | 'int' | 'bool';
  /** Not shown in the UI (derived/hidden). */
  hidden?: boolean;
  /** Units suffix in UI. */
  unit?: string;
}

export interface EffectPass {
  frag: string;
  /** Scale of render target relative to input (for downsampled blur passes). */
  scale?: number;
  /** Extra per-pass uniforms, keyed by name -> function of params. */
  uniforms?: Record<string, (p: Record<string, ParamValue>, res: [number, number]) => number | number[]>;
  /** Whether this pass samples the ORIGINAL input texture as u_orig. */
  needsOriginal?: boolean;
}

export interface EffectDef {
  type: string;
  name: string;
  category: EffectCategory;
  description: string;
  params: ParamDef[];
  passes: EffectPass[];
  /** Only for audio effects: the graph builder id. */
  audio?: boolean;
  /** Whether the effect can render outside the clip's frame bounds (e.g. transforms). */
  gpuOnly?: boolean;
  /** Whether keyframing is allowed (all video effects). */
  keyframable?: boolean;
  /** Time based effect needs continuous redraw. */
  animated?: boolean;
  /** Presets shipped with the effect. */
  presets?: { name: string; values: Record<string, ParamValue> }[];
}

export type EffectCategory =
  | 'Color Correction'
  | 'Blur & Sharpen'
  | 'Distort'
  | 'Stylize'
  | 'Keying'
  | 'Generate'
  | 'Transform'
  | 'Noise & Grain'
  | 'Time'
  | 'Utility'
  | 'Audio: Dynamics'
  | 'Audio: EQ'
  | 'Audio: Reverb & Delay'
  | 'Audio: Modulation'
  | 'Audio: Utility';

export const GLSL_COMMON = `
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise2(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  f = f*f*(3.0-2.0*f);
  float a = hash12(i), b = hash12(i+vec2(1,0)), c = hash12(i+vec2(0,1)), d = hash12(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0; float a = 0.5;
  for(int i=0;i<5;i++){ v += a*noise2(p); p *= 2.02; a *= 0.5; }
  return v;
}
vec3 srgb2lin(vec3 c){ return pow(max(c, 0.0), vec3(2.2)); }
vec3 lin2srgb(vec3 c){ return pow(max(c, 0.0), vec3(1.0/2.2)); }
vec4 sampleClamped(sampler2D t, vec2 uv){ return texture(t, clamp(uv, vec2(0.0), vec2(1.0))); }
vec4 sampleEdge(sampler2D t, vec2 uv){ if(uv.x<0.0||uv.y<0.0||uv.x>1.0||uv.y>1.0) return vec4(0.0); return texture(t, uv); }
`;

function def(
  type: string,
  name: string,
  category: EffectCategory,
  description: string,
  params: ParamDef[],
  passes: EffectPass[],
  extra: Partial<EffectDef> = {},
): EffectDef {
  return { type, name, category, description, params, passes, keyframable: true, ...extra };
}

const P = {
  num: (key: string, label: string, d: number, min: number, max: number, step = 0.1, extra: Partial<ParamDef> = {}): ParamDef => ({
    key,
    label,
    kind: 'number',
    default: d,
    min,
    max,
    step,
    ...extra,
  }),
  pct: (key: string, label: string, d: number, min = 0, max = 100, extra: Partial<ParamDef> = {}): ParamDef => ({
    key,
    label,
    kind: 'percent',
    default: d,
    min,
    max,
    step: 0.5,
    unit: '%',
    ...extra,
  }),
  ang: (key: string, label: string, d: number, extra: Partial<ParamDef> = {}): ParamDef => ({ key, label, kind: 'angle', default: d, min: -3600, max: 3600, step: 0.5, unit: '°', ...extra }),
  col: (key: string, label: string, d: [number, number, number, number] | string, extra: Partial<ParamDef> = {}): ParamDef => ({
    key,
    label,
    kind: 'color',
    default: typeof d === 'string' ? d : (d as unknown as ParamValue),
    ...extra,
  }),
  pt: (key: string, label: string, d: [number, number], extra: Partial<ParamDef> = {}): ParamDef => ({ key, label, kind: 'point', default: d, min: -2, max: 3, step: 0.001, ...extra }),
  bool: (key: string, label: string, d: boolean, extra: Partial<ParamDef> = {}): ParamDef => ({ key, label, kind: 'bool', default: d, ...extra }),
  sel: (key: string, label: string, d: number, options: { value: number; label: string }[], extra: Partial<ParamDef> = {}): ParamDef => ({
    key,
    label,
    kind: 'select',
    default: d,
    options,
    ...extra,
  }),
};

/* ---------- blur helpers ---------- */

const gaussianPass = (dir: 'x' | 'y') => `
  float r = p_blurriness;
  if (r < 0.01) { outColor = c; return; }
  vec2 texel = 1.0 / u_res;
  vec2 d = ${dir === 'x' ? 'vec2(texel.x, 0.0)' : 'vec2(0.0, texel.y)'};
  float dirMode = p_direction;
  if (dirMode == 1.0 && ${dir === 'x' ? 'true' : 'false'} == false) { outColor = c; return; }
  if (dirMode == 2.0 && ${dir === 'y' ? 'true' : 'false'} == false) { outColor = c; return; }
  float sigma = max(r * 0.5, 0.5);
  int taps = int(min(ceil(sigma * 3.0), 64.0));
  vec4 sum = vec4(0.0); float wsum = 0.0;
  for (int i = -64; i <= 64; i++) {
    if (i < -taps || i > taps) continue;
    float w = exp(-float(i*i) / (2.0 * sigma * sigma));
    vec2 uv2 = uv + d * float(i);
    vec4 s = (p_repeatEdge > 0.5) ? sampleClamped(u_tex, uv2) : sampleEdge(u_tex, uv2);
    sum += s * w; wsum += w;
  }
  outColor = sum / wsum;
`;

/* ---------- the registry ---------- */

export const EFFECTS: EffectDef[] = [
  /* ===== Color Correction ===== */
  def(
    'lumetri',
    'Lumetri Color',
    'Color Correction',
    'Primary color correction: exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, saturation, vibrance, curves and creative looks.',
    [
      P.num('exposure', 'Exposure', 0, -5, 5, 0.01, { group: 'Basic Correction' }),
      P.num('contrast', 'Contrast', 0, -100, 100, 0.5, { group: 'Basic Correction' }),
      P.num('highlights', 'Highlights', 0, -100, 100, 0.5, { group: 'Basic Correction' }),
      P.num('shadows', 'Shadows', 0, -100, 100, 0.5, { group: 'Basic Correction' }),
      P.num('whites', 'Whites', 0, -100, 100, 0.5, { group: 'Basic Correction' }),
      P.num('blacks', 'Blacks', 0, -100, 100, 0.5, { group: 'Basic Correction' }),
      P.num('temperature', 'Temperature', 0, -100, 100, 0.5, { group: 'White Balance' }),
      P.num('tint', 'Tint', 0, -100, 100, 0.5, { group: 'White Balance' }),
      P.num('saturation', 'Saturation', 100, 0, 300, 0.5, { group: 'Basic Correction' }),
      P.num('vibrance', 'Vibrance', 0, -100, 100, 0.5, { group: 'Creative' }),
      P.num('fadedFilm', 'Faded Film', 0, 0, 100, 0.5, { group: 'Creative' }),
      P.num('sharpen', 'Sharpen', 0, -100, 100, 0.5, { group: 'Creative' }),
      P.col('shadowTint', 'Shadow Tint', [0.5, 0.5, 0.5, 1], { group: 'Creative' }),
      P.col('highlightTint', 'Highlight Tint', [0.5, 0.5, 0.5, 1], { group: 'Creative' }),
      P.num('tintBalance', 'Tint Balance', 0, -100, 100, 0.5, { group: 'Creative' }),
      P.num('vignetteAmount', 'Vignette Amount', 0, -5, 5, 0.05, { group: 'Vignette' }),
      P.num('vignetteMidpoint', 'Vignette Midpoint', 50, 0, 100, 0.5, { group: 'Vignette' }),
      P.num('vignetteRoundness', 'Vignette Roundness', 0, -100, 100, 0.5, { group: 'Vignette' }),
      P.num('vignetteFeather', 'Vignette Feather', 50, 0, 100, 0.5, { group: 'Vignette' }),
      P.num('hueShift', 'Hue Shift', 0, -180, 180, 0.5, { group: 'HSL Secondary' }),
      P.num('lumaGamma', 'Gamma', 1, 0.2, 3, 0.01, { group: 'Curves' }),
      P.num('lumaLift', 'Lift', 0, -1, 1, 0.005, { group: 'Curves' }),
      P.num('lumaGain', 'Gain', 1, 0, 3, 0.005, { group: 'Curves' }),
    ],
    [
      {
        frag: `
  vec3 col = c.rgb;
  float a = c.a;
  // Un-premultiply
  if (a > 0.0001) col /= a;
  // White balance
  float temp = p_temperature / 100.0; float tnt = p_tint / 100.0;
  col.r *= 1.0 + temp * 0.25; col.b *= 1.0 - temp * 0.25; col.g *= 1.0 + tnt * 0.2; col.r *= 1.0 - tnt * 0.05; col.b *= 1.0 - tnt * 0.05;
  // Exposure (stops)
  col *= pow(2.0, p_exposure);
  // Blacks / whites
  float bl = p_blacks / 100.0 * 0.15; float wh = p_whites / 100.0 * 0.2;
  col = (col + bl) / (1.0 + bl - wh);
  // Shadows / highlights via luma masks
  float L = luma(col);
  float shMask = 1.0 - smoothstep(0.0, 0.5, L);
  float hiMask = smoothstep(0.4, 1.0, L);
  col += (p_shadows / 100.0) * 0.25 * shMask;
  col += (p_highlights / 100.0) * 0.25 * hiMask;
  // Contrast around 0.5 in perceptual space
  float ct = 1.0 + p_contrast / 100.0;
  col = (col - 0.5) * ct + 0.5;
  // Lift/gamma/gain
  col = pow(max(col * p_lumaGain + p_lumaLift, 0.0), vec3(1.0 / max(p_lumaGamma, 0.01)));
  // Saturation + vibrance
  float l2 = luma(col);
  float sat = p_saturation / 100.0;
  col = mix(vec3(l2), col, sat);
  float maxc = max(col.r, max(col.g, col.b)); float minc = min(col.r, min(col.g, col.b));
  float curSat = maxc - minc;
  float vib = p_vibrance / 100.0;
  col = mix(vec3(luma(col)), col, 1.0 + vib * (1.0 - curSat));
  // Hue shift
  if (abs(p_hueShift) > 0.01) { vec3 h = rgb2hsv(col); h.x = fract(h.x + p_hueShift / 360.0); col = hsv2rgb(h); }
  // Split tone
  float bal = p_tintBalance / 100.0;
  float lm = luma(col);
  vec3 shT = (p_shadowTint.rgb - 0.5) * 0.4; vec3 hiT = (p_highlightTint.rgb - 0.5) * 0.4;
  float shW = (1.0 - smoothstep(0.0, 0.6 + bal * 0.3, lm)); float hiW = smoothstep(0.4 + bal * 0.3, 1.0, lm);
  col += shT * shW + hiT * hiW;
  // Faded film: lift the blacks and compress
  float ff = p_fadedFilm / 100.0;
  col = mix(col, col * 0.85 + 0.1, ff);
  // Sharpen (unsharp mask)
  if (abs(p_sharpen) > 0.01) {
    vec2 t = 1.0 / u_res;
    vec3 blur = (texture(u_tex, uv + vec2(t.x, 0.0)).rgb + texture(u_tex, uv - vec2(t.x, 0.0)).rgb + texture(u_tex, uv + vec2(0.0, t.y)).rgb + texture(u_tex, uv - vec2(0.0, t.y)).rgb) * 0.25;
    if (a > 0.0001) blur /= a;
    col += (col - blur) * (p_sharpen / 100.0) * 1.5;
  }
  // Vignette
  if (abs(p_vignetteAmount) > 0.001) {
    vec2 q = uv - 0.5;
    float aspect = u_res.x / u_res.y;
    float rnd = p_vignetteRoundness / 100.0;
    q.x *= mix(aspect, 1.0, clamp(rnd, 0.0, 1.0));
    float d = length(q) * 1.4142;
    float mid = p_vignetteMidpoint / 100.0;
    float fe = max(p_vignetteFeather / 100.0, 0.001);
    float v = smoothstep(mid - fe * 0.5, mid + fe * 0.5 + 0.001, d);
    col = mix(col, col * (1.0 - clamp(p_vignetteAmount, 0.0, 1.0) * 0.9), v * step(0.0, p_vignetteAmount));
    col = mix(col, col + clamp(-p_vignetteAmount, 0.0, 1.0) * 0.6, v * step(p_vignetteAmount, 0.0));
  }
  col = clamp(col, 0.0, 1.0);
  outColor = vec4(col * a, a);
`,
      },
    ],
    {
      presets: [
        { name: 'Warm Film', values: { temperature: 18, contrast: 12, fadedFilm: 22, saturation: 92, vignetteAmount: 0.6 } },
        { name: 'Cool Teal', values: { temperature: -22, tint: -6, contrast: 10, saturation: 105, shadowTint: [0.42, 0.5, 0.56, 1], highlightTint: [0.56, 0.52, 0.45, 1] } },
        { name: 'Bleach Bypass', values: { contrast: 35, saturation: 45, blacks: -20, whites: 10 } },
        { name: 'Night Lift', values: { exposure: 0.6, shadows: 40, blacks: 15, saturation: 85 } },
        { name: 'Punchy', values: { contrast: 25, vibrance: 35, sharpen: 30 } },
      ],
    },
  ),
  def(
    'brightnessContrast',
    'Brightness & Contrast',
    'Color Correction',
    'Simple brightness offset and contrast scaling.',
    [P.num('brightness', 'Brightness', 0, -150, 150, 0.5), P.num('contrast', 'Contrast', 0, -100, 100, 0.5)],
    [
      {
        frag: `
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  col += p_brightness / 255.0;
  float ct = p_contrast >= 0.0 ? 1.0 + p_contrast / 100.0 * 2.0 : 1.0 + p_contrast / 100.0;
  col = (col - 0.5) * ct + 0.5;
  outColor = vec4(clamp(col, 0.0, 1.0) * a, a);`,
      },
    ],
  ),
  def(
    'levels',
    'Levels',
    'Color Correction',
    'Input/output black and white points with gamma.',
    [
      P.num('inBlack', 'Input Black', 0, 0, 255, 0.5),
      P.num('inWhite', 'Input White', 255, 0, 255, 0.5),
      P.num('gamma', 'Gamma', 1, 0.1, 10, 0.01),
      P.num('outBlack', 'Output Black', 0, 0, 255, 0.5),
      P.num('outWhite', 'Output White', 255, 0, 255, 0.5),
      P.sel('channel', 'Channel', 0, [
        { value: 0, label: 'RGB' },
        { value: 1, label: 'Red' },
        { value: 2, label: 'Green' },
        { value: 3, label: 'Blue' },
      ]),
    ],
    [
      {
        frag: `
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  vec3 v = (col - p_inBlack / 255.0) / max((p_inWhite - p_inBlack) / 255.0, 0.001);
  v = pow(clamp(v, 0.0, 1.0), vec3(1.0 / p_gamma));
  v = v * (p_outWhite - p_outBlack) / 255.0 + p_outBlack / 255.0;
  if (p_channel == 1.0) col.r = v.r; else if (p_channel == 2.0) col.g = v.g; else if (p_channel == 3.0) col.b = v.b; else col = v;
  outColor = vec4(clamp(col, 0.0, 1.0) * a, a);`,
      },
    ],
  ),
  def(
    'hueSaturation',
    'Hue / Saturation',
    'Color Correction',
    'Rotate hue, scale saturation and lightness, optionally colorize.',
    [
      P.ang('hue', 'Master Hue', 0),
      P.num('saturation', 'Master Saturation', 0, -100, 100, 0.5),
      P.num('lightness', 'Master Lightness', 0, -100, 100, 0.5),
      P.bool('colorize', 'Colorize', false),
      P.ang('colorizeHue', 'Colorize Hue', 0),
      P.num('colorizeSat', 'Colorize Saturation', 25, 0, 100, 0.5),
    ],
    [
      {
        frag: `
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  vec3 h = rgb2hsv(col);
  if (p_colorize > 0.5) { h.x = fract(p_colorizeHue / 360.0); h.y = p_colorizeSat / 100.0; }
  else { h.x = fract(h.x + p_hue / 360.0); h.y = clamp(h.y * (1.0 + p_saturation / 100.0), 0.0, 1.0); }
  col = hsv2rgb(h);
  float li = p_lightness / 100.0;
  col = li >= 0.0 ? mix(col, vec3(1.0), li) : col * (1.0 + li);
  outColor = vec4(col * a, a);`,
      },
    ],
  ),
  def(
    'colorBalance',
    'Color Balance',
    'Color Correction',
    'Three-way RGB balance across shadows, midtones and highlights.',
    [
      P.num('shR', 'Shadow Red', 0, -100, 100, 0.5, { group: 'Shadows' }),
      P.num('shG', 'Shadow Green', 0, -100, 100, 0.5, { group: 'Shadows' }),
      P.num('shB', 'Shadow Blue', 0, -100, 100, 0.5, { group: 'Shadows' }),
      P.num('midR', 'Midtone Red', 0, -100, 100, 0.5, { group: 'Midtones' }),
      P.num('midG', 'Midtone Green', 0, -100, 100, 0.5, { group: 'Midtones' }),
      P.num('midB', 'Midtone Blue', 0, -100, 100, 0.5, { group: 'Midtones' }),
      P.num('hiR', 'Highlight Red', 0, -100, 100, 0.5, { group: 'Highlights' }),
      P.num('hiG', 'Highlight Green', 0, -100, 100, 0.5, { group: 'Highlights' }),
      P.num('hiB', 'Highlight Blue', 0, -100, 100, 0.5, { group: 'Highlights' }),
      P.bool('preserveLuma', 'Preserve Luminosity', true),
    ],
    [
      {
        frag: `
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  float L = luma(col);
  float sw = 1.0 - smoothstep(0.0, 0.5, L); float hw = smoothstep(0.5, 1.0, L); float mw = 1.0 - sw - hw;
  vec3 adj = vec3(p_shR, p_shG, p_shB) / 100.0 * sw * 0.3 + vec3(p_midR, p_midG, p_midB) / 100.0 * mw * 0.3 + vec3(p_hiR, p_hiG, p_hiB) / 100.0 * hw * 0.3;
  vec3 res = col + adj;
  if (p_preserveLuma > 0.5) { float L2 = luma(res); res += (L - L2); }
  outColor = vec4(clamp(res, 0.0, 1.0) * a, a);`,
      },
    ],
  ),
  def(
    'colorWheels',
    'Three-Way Color Wheels',
    'Color Correction',
    'Lift / gamma / gain color wheels in the classic ASC-CDL style.',
    [
      P.col('lift', 'Lift', [0.5, 0.5, 0.5, 1]),
      P.num('liftLuma', 'Lift Level', 0, -1, 1, 0.005),
      P.col('gamma', 'Gamma', [0.5, 0.5, 0.5, 1]),
      P.num('gammaLuma', 'Gamma Level', 1, 0.2, 3, 0.005),
      P.col('gain', 'Gain', [0.5, 0.5, 0.5, 1]),
      P.num('gainLuma', 'Gain Level', 1, 0, 3, 0.005),
    ],
    [
      {
        frag: `
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  vec3 lift = (p_lift.rgb - 0.5) * 0.5 + p_liftLuma;
  vec3 gain = (p_gain.rgb - 0.5) * 1.0 + p_gainLuma;
  vec3 gam = 1.0 / max((p_gamma.rgb - 0.5) * 1.0 + p_gammaLuma, 0.01);
  col = pow(max(col * gain + lift * (1.0 - col), 0.0), gam);
  outColor = vec4(clamp(col, 0.0, 1.0) * a, a);`,
      },
    ],
  ),
  def(
    'tint',
    'Tint',
    'Color Correction',
    'Map blacks and whites to two colors.',
    [P.col('black', 'Map Black To', [0, 0, 0, 1]), P.col('white', 'Map White To', [1, 1, 1, 1]), P.pct('amount', 'Amount to Tint', 100)],
    [
      {
        frag: `
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  float L = luma(col);
  vec3 t = mix(p_black.rgb, p_white.rgb, L);
  col = mix(col, t, p_amount / 100.0);
  outColor = vec4(col * a, a);`,
      },
    ],
  ),
  def(
    'blackWhite',
    'Black & White',
    'Color Correction',
    'Channel mixer style monochrome conversion with per-hue weights.',
    [
      P.num('reds', 'Reds', 40, -200, 300, 1),
      P.num('yellows', 'Yellows', 60, -200, 300, 1),
      P.num('greens', 'Greens', 40, -200, 300, 1),
      P.num('cyans', 'Cyans', 60, -200, 300, 1),
      P.num('blues', 'Blues', 20, -200, 300, 1),
      P.num('magentas', 'Magentas', 80, -200, 300, 1),
    ],
    [
      {
        frag: `
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  vec3 h = rgb2hsv(col);
  float hue = h.x * 6.0;
  float w[6]; w[0] = p_reds; w[1] = p_yellows; w[2] = p_greens; w[3] = p_cyans; w[4] = p_blues; w[5] = p_magentas;
  int i0 = int(floor(hue)) % 6; int i1 = (i0 + 1) % 6; float f = fract(hue);
  float wt = mix(w[i0], w[i1], f) / 100.0;
  float g = mix(luma(col), h.z * wt, h.y);
  outColor = vec4(vec3(clamp(g, 0.0, 1.0)) * a, a);`,
      },
    ],
  ),
  def(
    'invert',
    'Invert',
    'Color Correction',
    'Invert RGB, individual channels, or luminance.',
    [
      P.sel('channel', 'Channel', 0, [
        { value: 0, label: 'RGB' },
        { value: 1, label: 'Red' },
        { value: 2, label: 'Green' },
        { value: 3, label: 'Blue' },
        { value: 4, label: 'Hue' },
        { value: 5, label: 'Luminance' },
        { value: 6, label: 'Alpha' },
      ]),
      P.pct('blend', 'Blend With Original', 0),
    ],
    [
      {
        frag: `
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  vec3 r = col;
  if (p_channel == 0.0) r = 1.0 - col; else if (p_channel == 1.0) r.r = 1.0 - col.r; else if (p_channel == 2.0) r.g = 1.0 - col.g; else if (p_channel == 3.0) r.b = 1.0 - col.b;
  else if (p_channel == 4.0) { vec3 h = rgb2hsv(col); h.x = fract(h.x + 0.5); r = hsv2rgb(h); }
  else if (p_channel == 5.0) { vec3 h = rgb2hsv(col); h.z = 1.0 - h.z; r = hsv2rgb(h); }
  else if (p_channel == 6.0) { a = 1.0 - a; }
  r = mix(r, col, p_blend / 100.0);
  outColor = vec4(r * a, a);`,
      },
    ],
  ),
  def(
    'posterize',
    'Posterize',
    'Stylize',
    'Quantize each channel into a number of levels.',
    [P.num('levels', 'Levels', 7, 2, 64, 1)],
    [
      {
        frag: `
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  float n = max(p_levels - 1.0, 1.0);
  col = floor(col * n + 0.5) / n;
  outColor = vec4(col * a, a);`,
      },
    ],
  ),
  def(
    'threshold',
    'Threshold',
    'Stylize',
    'Hard black/white cut at a luminance level.',
    [P.num('level', 'Level', 127, 0, 255, 0.5), P.num('softness', 'Softness', 0, 0, 100, 0.5)],
    [
      {
        frag: `
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  float L = luma(col); float t = p_level / 255.0; float s = p_softness / 255.0 + 0.0005;
  float v = smoothstep(t - s, t + s, L);
  outColor = vec4(vec3(v) * a, a);`,
      },
    ],
  ),
  def(
    'channelMixer',
    'Channel Mixer',
    'Color Correction',
    'Rebuild each output channel from a weighted mix of input channels.',
    [
      P.num('rr', 'Red - Red', 100, -200, 200, 1, { group: 'Red' }),
      P.num('rg', 'Red - Green', 0, -200, 200, 1, { group: 'Red' }),
      P.num('rb', 'Red - Blue', 0, -200, 200, 1, { group: 'Red' }),
      P.num('gr', 'Green - Red', 0, -200, 200, 1, { group: 'Green' }),
      P.num('gg', 'Green - Green', 100, -200, 200, 1, { group: 'Green' }),
      P.num('gb', 'Green - Blue', 0, -200, 200, 1, { group: 'Green' }),
      P.num('br', 'Blue - Red', 0, -200, 200, 1, { group: 'Blue' }),
      P.num('bg', 'Blue - Green', 0, -200, 200, 1, { group: 'Blue' }),
      P.num('bb', 'Blue - Blue', 100, -200, 200, 1, { group: 'Blue' }),
      P.bool('monochrome', 'Monochrome', false),
    ],
    [
      {
        frag: `
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  vec3 r = vec3(dot(col, vec3(p_rr, p_rg, p_rb)), dot(col, vec3(p_gr, p_gg, p_gb)), dot(col, vec3(p_br, p_bg, p_bb))) / 100.0;
  if (p_monochrome > 0.5) r = vec3(r.r);
  outColor = vec4(clamp(r, 0.0, 1.0) * a, a);`,
      },
    ],
  ),
  def(
    'gamma',
    'Gamma Correction',
    'Color Correction',
    'Adjust midtones without touching black and white.',
    [P.num('gamma', 'Gamma', 1, 0.1, 5, 0.01)],
    [
      {
        frag: `
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  col = pow(max(col, 0.0), vec3(1.0 / p_gamma));
  outColor = vec4(col * a, a);`,
      },
    ],
  ),
  def(
    'lut3d',
    'Creative Look (LUT)',
    'Color Correction',
    'Built-in film emulation looks with intensity control.',
    [
      P.sel('look', 'Look', 0, [
        { value: 0, label: 'Kodak 2383' },
        { value: 1, label: 'Fuji 3510' },
        { value: 2, label: 'Teal & Orange' },
        { value: 3, label: 'Cinematic Cool' },
        { value: 4, label: 'Vintage Fade' },
        { value: 5, label: 'Cross Process' },
        { value: 6, label: 'Cyberpunk' },
        { value: 7, label: 'Sepia' },
      ]),
      P.pct('intensity', 'Intensity', 100),
    ],
    [
      {
        frag: `
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  vec3 r = col; float L = luma(col);
  int look = int(p_look);
  if (look == 0) { r = pow(col, vec3(1.05, 1.0, 0.95)); r = (r - 0.5) * 1.12 + 0.5; r.r += 0.02; r.b -= 0.01; }
  else if (look == 1) { r = pow(col, vec3(0.98, 1.0, 1.04)); r = (r - 0.5) * 1.08 + 0.5; r.g += 0.015; }
  else if (look == 2) { float sh = 1.0 - smoothstep(0.0, 0.6, L); float hi = smoothstep(0.4, 1.0, L); r += vec3(-0.08, 0.02, 0.10) * sh + vec3(0.10, 0.03, -0.08) * hi; r = (r - 0.5) * 1.1 + 0.5; }
  else if (look == 3) { r = mix(vec3(L), col, 0.85); r += vec3(-0.03, 0.0, 0.06); r = (r - 0.5) * 1.15 + 0.5; }
  else if (look == 4) { r = col * 0.82 + 0.09; r = mix(vec3(L), r, 0.7); r += vec3(0.04, 0.02, -0.02); }
  else if (look == 5) { r = vec3(pow(col.r, 0.8), pow(col.g, 1.1), pow(col.b, 1.4)); r = (r - 0.5) * 1.25 + 0.5; }
  else if (look == 6) { vec3 h = rgb2hsv(col); h.y = min(h.y * 1.4, 1.0); r = hsv2rgb(h); float sh = 1.0 - smoothstep(0.0, 0.5, L); r += vec3(0.1, -0.05, 0.15) * sh; }
  else if (look == 7) { r = vec3(L) * vec3(1.2, 1.0, 0.8); }
  r = mix(col, clamp(r, 0.0, 1.0), p_intensity / 100.0);
  outColor = vec4(r * a, a);`,
      },
    ],
  ),

  /* ===== Blur & Sharpen ===== */
  def(
    'gaussianBlur',
    'Gaussian Blur',
    'Blur & Sharpen',
    'Separable gaussian blur with edge repeat option.',
    [
      P.num('blurriness', 'Blurriness', 0, 0, 500, 0.5),
      P.sel('direction', 'Blur Dimensions', 0, [
        { value: 0, label: 'Horizontal and Vertical' },
        { value: 1, label: 'Horizontal' },
        { value: 2, label: 'Vertical' },
      ]),
      P.bool('repeatEdge', 'Repeat Edge Pixels', true),
    ],
    [{ frag: gaussianPass('x') }, { frag: gaussianPass('y') }],
  ),
  def(
    'directionalBlur',
    'Directional Blur',
    'Blur & Sharpen',
    'Motion-style blur along an angle.',
    [P.ang('direction', 'Direction', 0), P.num('length', 'Blur Length', 0, 0, 200, 0.5)],
    [
      {
        frag: `
  float len = p_length; if (len < 0.01) { outColor = c; return; }
  float ang = radians(p_direction);
  vec2 d = vec2(sin(ang), -cos(ang)) / u_res * len;
  const int N = 24; vec4 sum = vec4(0.0);
  for (int i = 0; i < N; i++) { float t = float(i) / float(N - 1) - 0.5; sum += sampleClamped(u_tex, uv + d * t); }
  outColor = sum / float(N);`,
      },
    ],
  ),
  def(
    'radialBlur',
    'Radial Blur',
    'Blur & Sharpen',
    'Spin or zoom blur around a center point.',
    [
      P.num('amount', 'Amount', 10, 0, 100, 0.5),
      P.pt('center', 'Center', [0.5, 0.5]),
      P.sel('type', 'Type', 0, [
        { value: 0, label: 'Spin' },
        { value: 1, label: 'Zoom' },
      ]),
    ],
    [
      {
        frag: `
  float amt = p_amount / 100.0; if (amt < 0.001) { outColor = c; return; }
  vec2 ctr = p_center; vec2 q = uv - ctr; q.x *= u_res.x / u_res.y;
  const int N = 32; vec4 sum = vec4(0.0);
  for (int i = 0; i < N; i++) {
    float t = (float(i) / float(N - 1) - 0.5);
    vec2 s;
    if (p_type < 0.5) { float a = t * amt * 1.2; float cs = cos(a), sn = sin(a); s = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs); }
    else { s = q * (1.0 + t * amt * 0.6); }
    s.x /= u_res.x / u_res.y;
    sum += sampleClamped(u_tex, s + ctr);
  }
  outColor = sum / float(N);`,
      },
    ],
  ),
  def(
    'boxBlur',
    'Box Blur',
    'Blur & Sharpen',
    'Fast box blur with configurable iterations.',
    [P.num('radius', 'Blur Radius', 0, 0, 100, 0.5), P.num('iterations', 'Iterations', 1, 1, 3, 1)],
    [
      {
        frag: `
  float r = p_radius; if (r < 0.5) { outColor = c; return; }
  vec2 t = 1.0 / u_res; int R = int(min(r, 24.0)); vec4 sum = vec4(0.0); float n = 0.0;
  for (int x = -24; x <= 24; x++) { if (x < -R || x > R) continue; sum += sampleClamped(u_tex, uv + vec2(float(x) * t.x * (r / float(R)), 0.0)); n += 1.0; }
  outColor = sum / n;`,
      },
      {
        frag: `
  float r = p_radius; if (r < 0.5) { outColor = c; return; }
  vec2 t = 1.0 / u_res; int R = int(min(r, 24.0)); vec4 sum = vec4(0.0); float n = 0.0;
  for (int y = -24; y <= 24; y++) { if (y < -R || y > R) continue; sum += sampleClamped(u_tex, uv + vec2(0.0, float(y) * t.y * (r / float(R)))); n += 1.0; }
  outColor = sum / n;`,
      },
    ],
  ),
  def(
    'sharpen',
    'Sharpen',
    'Blur & Sharpen',
    'Laplacian sharpening.',
    [P.num('amount', 'Sharpen Amount', 25, 0, 400, 0.5)],
    [
      {
        frag: `
  vec2 t = 1.0 / u_res;
  vec4 n = texture(u_tex, uv + vec2(0.0, t.y)) + texture(u_tex, uv - vec2(0.0, t.y)) + texture(u_tex, uv + vec2(t.x, 0.0)) + texture(u_tex, uv - vec2(t.x, 0.0));
  vec4 r = c + (c * 4.0 - n) * (p_amount / 100.0) * 0.5;
  outColor = vec4(clamp(r.rgb, 0.0, max(c.a, 0.0001)), c.a);`,
      },
    ],
  ),
  def(
    'unsharpMask',
    'Unsharp Mask',
    'Blur & Sharpen',
    'Sharpen by subtracting a blurred copy, with threshold.',
    [P.num('amount', 'Amount', 50, 0, 500, 0.5), P.num('radius', 'Radius', 2, 0.1, 50, 0.1), P.num('threshold', 'Threshold', 0, 0, 255, 0.5)],
    [
      {
        frag: `
  vec2 t = p_radius / u_res; vec4 b = vec4(0.0);
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) b += sampleClamped(u_tex, uv + vec2(float(x), float(y)) * t * 0.5);
  b /= 25.0;
  vec4 d = c - b;
  float th = p_threshold / 255.0;
  float m = step(th, abs(luma(d.rgb)));
  outColor = vec4(clamp(c.rgb + d.rgb * (p_amount / 100.0) * m, 0.0, max(c.a, 0.0001)), c.a);`,
      },
    ],
  ),

  /* ===== Distort ===== */
  def(
    'transform',
    'Transform',
    'Distort',
    'Additional position, scale, rotation, skew and shutter angle motion blur, separate from the fixed Motion effect.',
    [
      P.pt('anchor', 'Anchor Point', [0.5, 0.5]),
      P.pt('position', 'Position', [0.5, 0.5]),
      P.num('scale', 'Scale', 100, 0, 1000, 0.5, { unit: '%' }),
      P.num('scaleW', 'Scale Width', 100, 0, 1000, 0.5, { unit: '%' }),
      P.bool('uniform', 'Uniform Scale', true),
      P.num('skew', 'Skew', 0, -85, 85, 0.5),
      P.ang('skewAxis', 'Skew Axis', 0),
      P.ang('rotation', 'Rotation', 0),
      P.pct('opacity', 'Opacity', 100),
    ],
    [
      {
        frag: `
  float aspect = u_res.x / u_res.y;
  vec2 p = uv - p_position; p.x *= aspect;
  float rot = radians(-p_rotation); float cs = cos(rot), sn = sin(rot);
  p = vec2(p.x * cs - p.y * sn, p.x * sn + p.y * cs);
  float sk = tan(radians(p_skew)); float sa = radians(p_skewAxis);
  vec2 sp = vec2(p.x * cos(sa) + p.y * sin(sa), -p.x * sin(sa) + p.y * cos(sa)); sp.x -= sp.y * sk; p = vec2(sp.x * cos(-sa) + sp.y * sin(-sa), -sp.x * sin(-sa) + sp.y * cos(-sa));
  float sy = p_scale / 100.0; float sx = (p_uniform > 0.5 ? p_scale : p_scaleW) / 100.0;
  p /= vec2(max(sx, 0.0001), max(sy, 0.0001));
  p.x /= aspect; p += p_anchor;
  outColor = sampleEdge(u_tex, p) * (p_opacity / 100.0);`,
      },
    ],
  ),
  def(
    'mirror',
    'Mirror',
    'Distort',
    'Reflect the image across a line through a point.',
    [P.pt('center', 'Reflection Center', [0.5, 0.5]), P.ang('angle', 'Reflection Angle', 0)],
    [
      {
        frag: `
  float aspect = u_res.x / u_res.y;
  vec2 n = vec2(cos(radians(p_angle)), sin(radians(p_angle)));
  vec2 q = uv - p_center; q.x *= aspect;
  float d = dot(q, n);
  if (d > 0.0) { q -= 2.0 * d * n; }
  q.x /= aspect;
  outColor = sampleClamped(u_tex, q + p_center);`,
      },
    ],
  ),
  def(
    'wave',
    'Wave Warp',
    'Distort',
    'Animated sinusoidal displacement.',
    [
      P.num('height', 'Wave Height', 10, 0, 200, 0.5),
      P.num('width', 'Wave Width', 40, 1, 500, 0.5),
      P.ang('direction', 'Direction', 90),
      P.num('speed', 'Wave Speed', 1, -10, 10, 0.05),
      P.sel('type', 'Wave Type', 0, [
        { value: 0, label: 'Sine' },
        { value: 1, label: 'Square' },
        { value: 2, label: 'Triangle' },
        { value: 3, label: 'Noise' },
      ]),
    ],
    [
      {
        frag: `
  vec2 px = uv * u_res;
  float ang = radians(p_direction);
  vec2 dir = vec2(cos(ang), sin(ang));
  float ph = dot(px, vec2(-dir.y, dir.x)) / max(p_width, 1.0) * 6.2831 + u_time * p_speed * 6.2831;
  float w;
  if (p_type == 1.0) w = sign(sin(ph)); else if (p_type == 2.0) w = abs(fract(ph / 6.2831) * 2.0 - 1.0) * 2.0 - 1.0; else if (p_type == 3.0) w = noise2(vec2(ph * 0.3, u_time)) * 2.0 - 1.0; else w = sin(ph);
  vec2 off = dir * w * p_height;
  outColor = sampleClamped(u_tex, (px + off) / u_res);`,
      },
    ],
    { animated: true },
  ),
  def(
    'lensDistortion',
    'Lens Distortion',
    'Distort',
    'Barrel / pincushion curvature with chromatic aberration.',
    [P.num('curvature', 'Curvature', 0, -100, 100, 0.5), P.num('aberration', 'Chromatic Aberration', 0, 0, 20, 0.05), P.num('scale', 'Fill Scale', 100, 50, 200, 0.5)],
    [
      {
        frag: `
  vec2 q = (uv - 0.5) * 2.0; float aspect = u_res.x / u_res.y; q.x *= aspect;
  float r2 = dot(q, q); float k = p_curvature / 100.0 * 0.5;
  vec2 dq = q * (1.0 + k * r2) / (p_scale / 100.0);
  float ab = p_aberration / 1000.0;
  vec2 dr = dq * (1.0 + ab), dg = dq, db = dq * (1.0 - ab);
  dr.x /= aspect; dg.x /= aspect; db.x /= aspect;
  vec2 ur = dr * 0.5 + 0.5, ug = dg * 0.5 + 0.5, ub = db * 0.5 + 0.5;
  vec4 cr = sampleEdge(u_tex, ur), cg = sampleEdge(u_tex, ug), cb = sampleEdge(u_tex, ub);
  outColor = vec4(cr.r, cg.g, cb.b, cg.a);`,
      },
    ],
  ),
  def(
    'twirl',
    'Twirl',
    'Distort',
    'Rotate pixels around a point, more towards the center.',
    [P.ang('angle', 'Angle', 90), P.num('radius', 'Twirl Radius', 50, 0, 100, 0.5), P.pt('center', 'Center', [0.5, 0.5])],
    [
      {
        frag: `
  float aspect = u_res.x / u_res.y;
  vec2 q = uv - p_center; q.x *= aspect;
  float r = length(q); float R = p_radius / 100.0 * 0.7071 * max(aspect, 1.0);
  float f = smoothstep(R, 0.0, r);
  float a = radians(p_angle) * f;
  float cs = cos(a), sn = sin(a);
  q = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs); q.x /= aspect;
  outColor = sampleClamped(u_tex, q + p_center);`,
      },
    ],
  ),
  def(
    'spherize',
    'Spherize',
    'Distort',
    'Bulge or pinch a circular region.',
    [P.num('radius', 'Radius', 30, 0, 100, 0.5), P.num('amount', 'Amount', 50, -100, 100, 0.5), P.pt('center', 'Center', [0.5, 0.5])],
    [
      {
        frag: `
  float aspect = u_res.x / u_res.y;
  vec2 q = uv - p_center; q.x *= aspect;
  float R = max(p_radius / 100.0, 0.001); float r = length(q) / R;
  if (r < 1.0) { float k = p_amount / 100.0; float f = pow(r, 1.0 + k * 0.9) / max(r, 1e-5); q *= f; }
  q.x /= aspect;
  outColor = sampleClamped(u_tex, q + p_center);`,
      },
    ],
  ),
  def(
    'cornerPin',
    'Corner Pin',
    'Distort',
    'Map the four corners of the image to arbitrary points (planar homography).',
    [P.pt('ul', 'Upper Left', [0, 0]), P.pt('ur', 'Upper Right', [1, 0]), P.pt('ll', 'Lower Left', [0, 1]), P.pt('lr', 'Lower Right', [1, 1])],
    [
      {
        frag: `
  // Inverse bilinear mapping of uv into the quad (ul, ur, lr, ll)
  vec2 a = p_ul, b = p_ur, cc = p_lr, d = p_ll;
  vec2 e = b - a, f = d - a, g = a - b + cc - d, h = uv - a;
  float k2 = g.x * f.y - g.y * f.x;
  float k1 = e.x * f.y - e.y * f.x + h.x * g.y - h.y * g.x;
  float k0 = h.x * e.y - h.y * e.x;
  vec2 res;
  if (abs(k2) < 1e-5) { res = vec2((h.x * k1 + f.x * k0) / (e.x * k1 - g.x * k0), -k0 / k1); }
  else {
    float w = k1 * k1 - 4.0 * k0 * k2; if (w < 0.0) { outColor = vec4(0.0); return; }
    w = sqrt(w);
    float v = (-k1 - w) / (2.0 * k2);
    float u = (h.x - f.x * v) / (e.x + g.x * v);
    if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) { v = (-k1 + w) / (2.0 * k2); u = (h.x - f.x * v) / (e.x + g.x * v); }
    res = vec2(u, v);
  }
  outColor = sampleEdge(u_tex, res);`,
      },
    ],
  ),
  def(
    'offset',
    'Offset',
    'Distort',
    'Shift the image with wrap-around.',
    [P.pt('shift', 'Shift Center To', [0.5, 0.5]), P.pct('blend', 'Blend With Original', 0)],
    [
      {
        frag: `
  vec2 q = fract(uv - (p_shift - 0.5));
  outColor = mix(texture(u_tex, q), c, p_blend / 100.0);`,
      },
    ],
  ),
  def(
    'ripple',
    'Ripple',
    'Distort',
    'Concentric animated ripples from a center point.',
    [P.num('amplitude', 'Amplitude', 8, 0, 100, 0.5), P.num('frequency', 'Frequency', 20, 1, 100, 0.5), P.num('speed', 'Speed', 2, -10, 10, 0.05), P.pt('center', 'Center', [0.5, 0.5]), P.num('decay', 'Decay', 2, 0, 10, 0.05)],
    [
      {
        frag: `
  float aspect = u_res.x / u_res.y;
  vec2 q = uv - p_center; q.x *= aspect; float r = length(q);
  float w = sin(r * p_frequency * 6.2831 - u_time * p_speed * 6.2831) * exp(-r * p_decay);
  vec2 n = r > 1e-5 ? q / r : vec2(0.0);
  vec2 off = n * w * p_amplitude / u_res.y; off.x /= aspect;
  outColor = sampleClamped(u_tex, uv + off);`,
      },
    ],
    { animated: true },
  ),

  /* ===== Stylize ===== */
  def(
    'mosaic',
    'Mosaic',
    'Stylize',
    'Pixelate into blocks.',
    [P.num('hBlocks', 'Horizontal Blocks', 24, 1, 400, 1), P.num('vBlocks', 'Vertical Blocks', 14, 1, 400, 1), P.bool('sharp', 'Sharp Colors', false)],
    [
      {
        frag: `
  vec2 n = vec2(p_hBlocks, p_vBlocks);
  vec2 cell = (floor(uv * n) + 0.5) / n;
  if (p_sharp > 0.5) outColor = texture(u_tex, cell);
  else { vec2 s = 0.25 / n; outColor = (texture(u_tex, cell + s) + texture(u_tex, cell - s) + texture(u_tex, cell + vec2(s.x, -s.y)) + texture(u_tex, cell + vec2(-s.x, s.y))) * 0.25; }`,
      },
    ],
  ),
  def(
    'findEdges',
    'Find Edges',
    'Stylize',
    'Sobel edge detection.',
    [P.bool('invert', 'Invert', false), P.pct('blend', 'Blend With Original', 0), P.num('strength', 'Strength', 1, 0.1, 10, 0.05)],
    [
      {
        frag: `
  vec2 t = 1.0 / u_res;
  float tl = luma(texture(u_tex, uv + vec2(-t.x, -t.y)).rgb), tc = luma(texture(u_tex, uv + vec2(0.0, -t.y)).rgb), tr = luma(texture(u_tex, uv + vec2(t.x, -t.y)).rgb);
  float ml = luma(texture(u_tex, uv + vec2(-t.x, 0.0)).rgb), mr = luma(texture(u_tex, uv + vec2(t.x, 0.0)).rgb);
  float bl = luma(texture(u_tex, uv + vec2(-t.x, t.y)).rgb), bc = luma(texture(u_tex, uv + vec2(0.0, t.y)).rgb), br = luma(texture(u_tex, uv + vec2(t.x, t.y)).rgb);
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br; float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  float e = clamp(sqrt(gx * gx + gy * gy) * p_strength, 0.0, 1.0);
  if (p_invert < 0.5) e = 1.0 - e;
  outColor = mix(vec4(vec3(e) * c.a, c.a), c, p_blend / 100.0);`,
      },
    ],
  ),
  def(
    'emboss',
    'Emboss',
    'Stylize',
    'Directional relief.',
    [P.ang('direction', 'Direction', 45), P.num('relief', 'Relief', 1, 0, 10, 0.05), P.num('contrast', 'Contrast', 100, 0, 300, 1), P.pct('blend', 'Blend With Original', 0)],
    [
      {
        frag: `
  vec2 d = vec2(cos(radians(p_direction)), sin(radians(p_direction))) * p_relief / u_res;
  float a = luma(sampleClamped(u_tex, uv + d).rgb), b = luma(sampleClamped(u_tex, uv - d).rgb);
  float e = clamp(0.5 + (a - b) * p_contrast / 100.0, 0.0, 1.0);
  outColor = mix(vec4(vec3(e) * c.a, c.a), c, p_blend / 100.0);`,
      },
    ],
  ),
  def(
    'solarize',
    'Solarize',
    'Stylize',
    'Invert tones above a threshold.',
    [P.num('threshold', 'Threshold', 50, 0, 100, 0.5)],
    [
      {
        frag: `
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  float t = p_threshold / 100.0;
  col = mix(col, 1.0 - col, step(t, col));
  outColor = vec4(col * a, a);`,
      },
    ],
  ),
  def(
    'glow',
    'Glow',
    'Stylize',
    'Bloom bright areas.',
    [P.num('threshold', 'Glow Threshold', 60, 0, 100, 0.5), P.num('radius', 'Glow Radius', 20, 0, 200, 0.5), P.num('intensity', 'Glow Intensity', 1, 0, 5, 0.05), P.col('color', 'Glow Color Tint', [1, 1, 1, 1])],
    [
      {
        frag: `
  float th = p_threshold / 100.0; vec2 t = p_radius / u_res; vec4 sum = vec4(0.0); float n = 0.0;
  for (int y = -4; y <= 4; y++) for (int x = -4; x <= 4; x++) {
    vec4 s = sampleClamped(u_tex, uv + vec2(float(x), float(y)) * t * 0.25);
    float l = luma(s.rgb); float w = exp(-float(x*x+y*y) / 10.0);
    sum += s * smoothstep(th, 1.0, l) * w; n += w;
  }
  vec4 g = sum / n * p_intensity; g.rgb *= p_color.rgb;
  outColor = vec4(min(c.rgb + g.rgb, 1.0), max(c.a, g.a));`,
      },
    ],
  ),
  def(
    'dropShadow',
    'Drop Shadow',
    'Stylize',
    'Shadow behind the clip alpha.',
    [P.col('color', 'Shadow Color', [0, 0, 0, 1]), P.pct('opacity', 'Opacity', 50), P.ang('direction', 'Direction', 135), P.num('distance', 'Distance', 10, 0, 500, 0.5), P.num('softness', 'Softness', 10, 0, 200, 0.5), P.bool('shadowOnly', 'Shadow Only', false)],
    [
      {
        frag: `
  vec2 off = vec2(cos(radians(p_direction)), sin(radians(p_direction))) * p_distance / u_res;
  float sa = 0.0; float n = 0.0; vec2 t = max(p_softness, 0.5) / u_res;
  for (int y = -3; y <= 3; y++) for (int x = -3; x <= 3; x++) { float w = exp(-float(x*x+y*y)/6.0); sa += sampleEdge(u_tex, uv - off + vec2(float(x), float(y)) * t * 0.33).a * w; n += w; }
  sa = sa / n * (p_opacity / 100.0);
  vec4 sh = vec4(p_color.rgb * sa, sa);
  outColor = (p_shadowOnly > 0.5) ? sh : (c + sh * (1.0 - c.a));`,
      },
    ],
  ),
  def(
    'halftone',
    'Halftone',
    'Stylize',
    'Print-style dot screen.',
    [P.num('size', 'Dot Size', 8, 2, 64, 0.5), P.ang('angle', 'Screen Angle', 45), P.bool('color', 'CMYK Color', false)],
    [
      {
        frag: `
  float s = p_size; float a = radians(p_angle); mat2 R = mat2(cos(a), -sin(a), sin(a), cos(a));
  vec2 px = uv * u_res; vec2 rp = R * px;
  vec2 cell = floor(rp / s) * s + s * 0.5; vec2 cp = transpose(R) * cell;
  vec4 sc = sampleClamped(u_tex, cp / u_res);
  float d = length(rp - cell) / (s * 0.5);
  if (p_color > 0.5) {
    vec3 rad = 1.0 - sc.rgb; vec3 dot3 = 1.0 - smoothstep(rad * 1.2 - 0.05, rad * 1.2 + 0.05, vec3(d));
    outColor = vec4((1.0 - dot3) * c.a, c.a);
  } else {
    float rad = (1.0 - luma(sc.rgb)) * 1.2; float dotv = 1.0 - smoothstep(rad - 0.05, rad + 0.05, d);
    outColor = vec4(vec3(1.0 - dotv) * c.a, c.a);
  }`,
      },
    ],
  ),
  def(
    'crtScanlines',
    'Scanlines / CRT',
    'Stylize',
    'Scanlines, RGB mask and barrel curvature.',
    [P.num('lineStrength', 'Line Strength', 40, 0, 100, 0.5), P.num('lineCount', 'Line Density', 480, 50, 2160, 1), P.num('maskStrength', 'RGB Mask', 20, 0, 100, 0.5), P.num('curvature', 'Curvature', 6, 0, 30, 0.5), P.num('vignette', 'Vignette', 30, 0, 100, 0.5)],
    [
      {
        frag: `
  vec2 q = uv * 2.0 - 1.0; float k = p_curvature / 100.0; q *= 1.0 + k * dot(q, q); vec2 cuv = q * 0.5 + 0.5;
  vec4 s = sampleEdge(u_tex, cuv);
  float ln = 0.5 + 0.5 * sin(cuv.y * p_lineCount * 3.14159 * 2.0);
  s.rgb *= 1.0 - (1.0 - ln) * p_lineStrength / 100.0;
  float px = mod(floor(cuv.x * u_res.x), 3.0);
  vec3 m = vec3(px == 0.0 ? 1.0 : 0.7, px == 1.0 ? 1.0 : 0.7, px == 2.0 ? 1.0 : 0.7);
  s.rgb *= mix(vec3(1.0), m, p_maskStrength / 100.0);
  float vg = 1.0 - dot(q * 0.5, q * 0.5) * p_vignette / 100.0 * 1.5;
  s.rgb *= clamp(vg, 0.0, 1.0);
  outColor = s;`,
      },
    ],
  ),
  def(
    'chromaticAberration',
    'Chromatic Aberration',
    'Stylize',
    'Split RGB channels radially or by offset.',
    [P.num('amount', 'Amount', 4, 0, 50, 0.1), P.ang('angle', 'Angle', 0), P.bool('radial', 'Radial', true)],
    [
      {
        frag: `
  vec2 d;
  if (p_radial > 0.5) d = (uv - 0.5) * p_amount / u_res.x * 4.0; else d = vec2(cos(radians(p_angle)), sin(radians(p_angle))) * p_amount / u_res;
  vec4 r = sampleClamped(u_tex, uv + d), g = c, b = sampleClamped(u_tex, uv - d);
  outColor = vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));`,
      },
    ],
  ),
  def(
    'tiles',
    'Tiles / Kaleidoscope',
    'Stylize',
    'Repeat or mirror the frame into segments.',
    [P.num('segments', 'Segments', 6, 1, 32, 1), P.ang('rotation', 'Rotation', 0), P.pt('center', 'Center', [0.5, 0.5]), P.num('zoom', 'Zoom', 100, 10, 400, 0.5)],
    [
      {
        frag: `
  float aspect = u_res.x / u_res.y;
  vec2 q = uv - p_center; q.x *= aspect;
  float r = length(q) / (p_zoom / 100.0); float a = atan(q.y, q.x) + radians(p_rotation);
  float seg = 6.2831 / max(p_segments, 1.0);
  a = mod(a, seg); a = abs(a - seg * 0.5);
  vec2 s = vec2(cos(a), sin(a)) * r; s.x /= aspect;
  outColor = sampleClamped(u_tex, s + p_center);`,
      },
    ],
  ),
  def(
    'oilPaint',
    'Oil Paint',
    'Stylize',
    'Kuwahara style painterly smoothing.',
    [P.num('radius', 'Brush Size', 4, 1, 12, 1), P.num('detail', 'Detail', 50, 0, 100, 0.5)],
    [
      {
        frag: `
  int R = int(p_radius); vec2 t = 1.0 / u_res;
  vec3 m[4]; vec3 s[4]; for (int k = 0; k < 4; k++) { m[k] = vec3(0.0); s[k] = vec3(0.0); }
  float n = float((R + 1) * (R + 1));
  for (int j = -12; j <= 0; j++) for (int i = -12; i <= 0; i++) { if (i < -R || j < -R) continue; vec3 cc = sampleClamped(u_tex, uv + vec2(float(i), float(j)) * t).rgb; m[0] += cc; s[0] += cc * cc; }
  for (int j = -12; j <= 0; j++) for (int i = 0; i <= 12; i++) { if (i > R || j < -R) continue; vec3 cc = sampleClamped(u_tex, uv + vec2(float(i), float(j)) * t).rgb; m[1] += cc; s[1] += cc * cc; }
  for (int j = 0; j <= 12; j++) for (int i = 0; i <= 12; i++) { if (i > R || j > R) continue; vec3 cc = sampleClamped(u_tex, uv + vec2(float(i), float(j)) * t).rgb; m[2] += cc; s[2] += cc * cc; }
  for (int j = 0; j <= 12; j++) for (int i = -12; i <= 0; i++) { if (i < -R || j > R) continue; vec3 cc = sampleClamped(u_tex, uv + vec2(float(i), float(j)) * t).rgb; m[3] += cc; s[3] += cc * cc; }
  float minS = 1e9; vec3 best = c.rgb;
  for (int k = 0; k < 4; k++) { m[k] /= n; s[k] = abs(s[k] / n - m[k] * m[k]); float sg = s[k].r + s[k].g + s[k].b; if (sg < minS) { minS = sg; best = m[k]; } }
  outColor = vec4(mix(best, c.rgb, (100.0 - p_detail) / 100.0 * 0.0), c.a);`,
      },
    ],
  ),
  def(
    'strobe',
    'Strobe Light',
    'Stylize',
    'Periodically flash a color or invert.',
    [
      P.col('color', 'Strobe Color', [1, 1, 1, 1]),
      P.num('period', 'Strobe Period (s)', 1, 0.05, 10, 0.01),
      P.num('duration', 'Strobe Duration (s)', 0.1, 0.01, 10, 0.01),
      P.sel('mode', 'Operator', 0, [
        { value: 0, label: 'Color Flash' },
        { value: 1, label: 'Invert' },
        { value: 2, label: 'Transparent' },
      ]),
    ],
    [
      {
        frag: `
  float ph = mod(u_time, max(p_period, 0.01));
  if (ph < p_duration) {
    if (p_mode == 0.0) outColor = vec4(p_color.rgb * c.a, c.a);
    else if (p_mode == 1.0) { vec3 col = c.rgb; if (c.a > 0.0001) col /= c.a; outColor = vec4((1.0 - col) * c.a, c.a); }
    else outColor = vec4(0.0);
  } else outColor = c;`,
      },
    ],
    { animated: true },
  ),
  def(
    'alphaGlow',
    'Alpha Edge Glow',
    'Stylize',
    'Glow at the edges of the alpha channel.',
    [P.num('glow', 'Glow', 10, 0, 100, 0.5), P.num('brightness', 'Brightness', 100, 0, 300, 1), P.col('startColor', 'Start Color', [1, 1, 1, 1]), P.col('endColor', 'End Color', [1, 0.5, 0, 1])],
    [
      {
        frag: `
  vec2 t = p_glow / u_res; float acc = 0.0; float n = 0.0;
  for (int y = -3; y <= 3; y++) for (int x = -3; x <= 3; x++) { float w = exp(-float(x*x+y*y)/5.0); acc += sampleEdge(u_tex, uv + vec2(float(x), float(y)) * t * 0.33).a * w; n += w; }
  acc /= n;
  float edge = clamp(acc - c.a, 0.0, 1.0) * p_brightness / 100.0;
  vec3 gc = mix(p_startColor.rgb, p_endColor.rgb, 1.0 - acc);
  outColor = c + vec4(gc * edge, edge) * (1.0 - c.a);`,
      },
    ],
  ),

  /* ===== Keying ===== */
  def(
    'ultraKey',
    'Ultra Key (Chroma)',
    'Keying',
    'Chroma key with matte cleanup and spill suppression.',
    [
      P.col('keyColor', 'Key Color', [0.0, 0.8, 0.2, 1]),
      P.num('tolerance', 'Tolerance', 40, 0, 100, 0.5, { group: 'Matte Generation' }),
      P.num('softness', 'Softness', 10, 0, 100, 0.5, { group: 'Matte Generation' }),
      P.num('pedestal', 'Pedestal', 0, 0, 100, 0.5, { group: 'Matte Cleanup' }),
      P.num('contrast', 'Contrast', 0, 0, 100, 0.5, { group: 'Matte Cleanup' }),
      P.num('choke', 'Choke', 0, -100, 100, 0.5, { group: 'Matte Cleanup' }),
      P.num('spill', 'Spill Suppression', 50, 0, 100, 0.5, { group: 'Spill Suppression' }),
      P.sel('output', 'Output', 0, [
        { value: 0, label: 'Composite' },
        { value: 1, label: 'Alpha Channel' },
        { value: 2, label: 'Color Channel' },
      ]),
    ],
    [
      {
        frag: `
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  vec3 kc = p_keyColor.rgb;
  // Distance in YCbCr chroma plane
  float kY = luma(kc); float kCb = 0.5 + (kc.b - kY) * 0.5643; float kCr = 0.5 + (kc.r - kY) * 0.7132;
  float Y = luma(col); float Cb = 0.5 + (col.b - Y) * 0.5643; float Cr = 0.5 + (col.r - Y) * 0.7132;
  float d = distance(vec2(Cb, Cr), vec2(kCb, kCr));
  float tol = p_tolerance / 100.0 * 0.35; float sf = max(p_softness / 100.0 * 0.2, 0.001);
  float m = smoothstep(tol, tol + sf, d);
  // cleanup
  m = clamp((m - p_pedestal / 100.0) / max(1.0 - p_pedestal / 100.0, 0.001), 0.0, 1.0);
  float ct = 1.0 + p_contrast / 100.0 * 4.0; m = clamp((m - 0.5) * ct + 0.5, 0.0, 1.0);
  m = clamp(m + p_choke / 100.0 * -0.5 * (1.0 - m) * 2.0 * step(0.0, p_choke) + p_choke / 100.0 * -0.5 * m * step(p_choke, 0.0), 0.0, 1.0);
  // spill
  float sp = p_spill / 100.0;
  vec3 hs = rgb2hsv(kc); vec3 cs = rgb2hsv(col);
  float hd = abs(cs.x - hs.x); hd = min(hd, 1.0 - hd);
  float spillMask = (1.0 - smoothstep(0.0, 0.12, hd)) * cs.y * sp;
  col = mix(col, vec3(luma(col)), spillMask);
  float outA = a * m;
  if (p_output == 1.0) outColor = vec4(vec3(m), 1.0);
  else if (p_output == 2.0) outColor = vec4(col, 1.0);
  else outColor = vec4(col * outA, outA);`,
      },
    ],
  ),
  def(
    'lumaKey',
    'Luma Key',
    'Keying',
    'Key out pixels by luminance.',
    [
      P.num('threshold', 'Threshold', 20, 0, 100, 0.5),
      P.num('cutoff', 'Cutoff', 40, 0, 100, 0.5),
      P.sel('mode', 'Key Type', 0, [
        { value: 0, label: 'Key Out Darker' },
        { value: 1, label: 'Key Out Brighter' },
      ]),
      P.bool('invert', 'Invert Matte', false),
    ],
    [
      {
        frag: `
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  float L = luma(col); float t0 = p_threshold / 100.0; float t1 = max(p_cutoff / 100.0, t0 + 0.001);
  float m = smoothstep(t0, t1, L);
  if (p_mode > 0.5) m = 1.0 - m;
  if (p_invert > 0.5) m = 1.0 - m;
  float oa = a * m;
  outColor = vec4(col * oa, oa);`,
      },
    ],
  ),
  def(
    'colorKey',
    'Color Key',
    'Keying',
    'Simple RGB distance key.',
    [P.col('keyColor', 'Key Color', [0, 0, 1, 1]), P.num('tolerance', 'Color Tolerance', 30, 0, 255, 0.5), P.num('edgeThin', 'Edge Thin', 0, -5, 5, 0.05), P.num('feather', 'Edge Feather', 10, 0, 100, 0.5)],
    [
      {
        frag: `
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  float d = distance(col, p_keyColor.rgb) * 255.0 / 1.7321;
  float t = p_tolerance; float f = max(p_feather, 0.5);
  float m = smoothstep(t - p_edgeThin * 5.0, t + f, d);
  float oa = a * m;
  outColor = vec4(col * oa, oa);`,
      },
    ],
  ),
  def(
    'trackMatteKey',
    'Track Matte Key',
    'Keying',
    'Use the clip on the track above as a luma or alpha matte. Resolved by the compositor.',
    [
      P.sel('matteSource', 'Matte', 0, [
        { value: 0, label: 'Track above' },
        { value: 1, label: 'Two tracks above' },
      ]),
      P.sel('composite', 'Composite Using', 0, [
        { value: 0, label: 'Matte Alpha' },
        { value: 1, label: 'Matte Luma' },
      ]),
      P.bool('reverse', 'Reverse', false),
    ],
    [
      {
        needsOriginal: true,
        frag: `
  vec4 m = texture(u_matte, uv);
  float mv = (p_composite > 0.5) ? luma(m.rgb / max(m.a, 0.0001)) * m.a : m.a;
  if (p_reverse > 0.5) mv = 1.0 - mv;
  outColor = c * mv;`,
      },
    ],
  ),
  def(
    'alphaAdjust',
    'Alpha Adjust',
    'Keying',
    'Scale, invert or ignore the alpha channel.',
    [P.pct('opacity', 'Opacity', 100), P.bool('ignoreAlpha', 'Ignore Alpha', false), P.bool('invertAlpha', 'Invert Alpha', false), P.bool('maskOnly', 'Mask Only', false)],
    [
      {
        frag: `
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  if (p_ignoreAlpha > 0.5) a = 1.0;
  if (p_invertAlpha > 0.5) a = 1.0 - a;
  a *= p_opacity / 100.0;
  if (p_maskOnly > 0.5) outColor = vec4(vec3(a), 1.0); else outColor = vec4(col * a, a);`,
      },
    ],
  ),

  def(
    'magicMask',
    'Magic Mask (AI)',
    'Keying',
    'AI person mask tracked through the clip - no green screen needed. Analyze first with Clip > Magic Mask, then tune the matte here.',
    [
      P.sel('mode', 'Keep', 0, [
        { value: 0, label: 'Subject (background transparent)' },
        { value: 1, label: 'Background (subject transparent)' },
        { value: 2, label: 'Show Matte Only' },
      ]),
      P.num('feather', 'Edge Feather', 2, 0, 20, 0.1, { group: 'Matte Refinement' }),
      P.num('contract', 'Matte Contract', 0, 0, 100, 0.5, { group: 'Matte Refinement' }),
      P.bool('invert', 'Invert Matte', false, { group: 'Matte Refinement' }),
      P.pct('opacity', 'Matte Opacity', 100),
    ],
    [
      {
        frag: `
  float m = texture(u_matte, uv).r;
  if (p_feather > 0.01) {
    vec2 px = p_feather / u_res * 2.0;
    m = (m
      + texture(u_matte, uv + vec2(px.x, 0.0)).r + texture(u_matte, uv - vec2(px.x, 0.0)).r
      + texture(u_matte, uv + vec2(0.0, px.y)).r + texture(u_matte, uv - vec2(0.0, px.y)).r) / 5.0;
  }
  float ct = p_contract / 100.0 * 0.5;
  m = smoothstep(ct, 1.0 - ct, m);
  if (p_invert > 0.5) m = 1.0 - m;
  if (p_mode > 1.5) { outColor = vec4(vec3(m), 1.0); }
  else {
    vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
    float keep = (p_mode > 0.5) ? (1.0 - m) : m;
    float oa = a * mix(1.0, keep, p_opacity / 100.0);
    outColor = vec4(col * oa, oa);
  }`,
      },
    ],
  ),

  /* ===== Generate ===== */
  def(
    'fourColorGradient',
    '4-Color Gradient',
    'Generate',
    'Blend four colors from four points over the clip.',
    [
      P.pt('p1', 'Point 1', [0.1, 0.1]),
      P.col('c1', 'Color 1', [1, 0.2, 0.2, 1]),
      P.pt('p2', 'Point 2', [0.9, 0.1]),
      P.col('c2', 'Color 2', [1, 0.9, 0.2, 1]),
      P.pt('p3', 'Point 3', [0.1, 0.9]),
      P.col('c3', 'Color 3', [0.2, 0.6, 1, 1]),
      P.pt('p4', 'Point 4', [0.9, 0.9]),
      P.col('c4', 'Color 4', [0.6, 0.2, 1, 1]),
      P.pct('blend', 'Blend', 100),
      P.pct('opacity', 'Opacity', 100),
      P.sel('mode', 'Blending Mode', 0, [
        { value: 0, label: 'Normal' },
        { value: 1, label: 'Multiply' },
        { value: 2, label: 'Screen' },
        { value: 3, label: 'Overlay' },
      ]),
    ],
    [
      {
        frag: `
  float bl = max(p_blend / 100.0, 0.01) * 2.0;
  float w1 = 1.0 / pow(max(distance(uv, p_p1), 1e-3), bl), w2 = 1.0 / pow(max(distance(uv, p_p2), 1e-3), bl), w3 = 1.0 / pow(max(distance(uv, p_p3), 1e-3), bl), w4 = 1.0 / pow(max(distance(uv, p_p4), 1e-3), bl);
  vec3 g = (p_c1.rgb * w1 + p_c2.rgb * w2 + p_c3.rgb * w3 + p_c4.rgb * w4) / (w1 + w2 + w3 + w4);
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  vec3 r = g;
  if (p_mode == 1.0) r = col * g; else if (p_mode == 2.0) r = 1.0 - (1.0 - col) * (1.0 - g); else if (p_mode == 3.0) r = mix(2.0 * col * g, 1.0 - 2.0 * (1.0 - col) * (1.0 - g), step(0.5, col));
  float op = p_opacity / 100.0;
  vec3 o = mix(col, r, op);
  float oa = (p_mode == 0.0) ? max(a, op) : a;
  outColor = vec4(o * oa, oa);`,
      },
    ],
  ),
  def(
    'ramp',
    'Ramp',
    'Generate',
    'Linear or radial gradient.',
    [
      P.pt('start', 'Start of Ramp', [0.5, 0]),
      P.col('startColor', 'Start Color', [0, 0, 0, 1]),
      P.pt('end', 'End of Ramp', [0.5, 1]),
      P.col('endColor', 'End Color', [1, 1, 1, 1]),
      P.sel('shape', 'Ramp Shape', 0, [
        { value: 0, label: 'Linear' },
        { value: 1, label: 'Radial' },
      ]),
      P.num('scatter', 'Ramp Scatter', 0, 0, 100, 0.5),
      P.pct('blend', 'Blend With Original', 0),
    ],
    [
      {
        frag: `
  float t;
  if (p_shape < 0.5) { vec2 d = p_end - p_start; t = dot(uv - p_start, d) / max(dot(d, d), 1e-6); }
  else { t = distance(uv, p_start) / max(distance(p_end, p_start), 1e-6); }
  t += (hash12(uv * u_res) - 0.5) * p_scatter / 100.0 * 0.2;
  vec3 g = mix(p_startColor.rgb, p_endColor.rgb, clamp(t, 0.0, 1.0));
  float ga = mix(p_startColor.a, p_endColor.a, clamp(t, 0.0, 1.0));
  vec4 r = vec4(g * ga, ga);
  outColor = mix(r, c, p_blend / 100.0);`,
      },
    ],
  ),
  def(
    'grid',
    'Grid',
    'Generate',
    'Overlay a line grid.',
    [P.num('cellW', 'Cell Width', 96, 4, 2000, 1), P.num('cellH', 'Cell Height', 96, 4, 2000, 1), P.num('border', 'Border', 2, 0.5, 50, 0.5), P.col('color', 'Color', [1, 1, 1, 1]), P.pct('opacity', 'Opacity', 100), P.bool('invert', 'Invert Grid', false)],
    [
      {
        frag: `
  vec2 px = uv * u_res; vec2 m = mod(px, vec2(p_cellW, p_cellH));
  float onLine = (m.x < p_border || m.y < p_border) ? 1.0 : 0.0;
  if (p_invert > 0.5) onLine = 1.0 - onLine;
  vec4 g = vec4(p_color.rgb, 1.0) * onLine * (p_opacity / 100.0);
  outColor = g + c * (1.0 - g.a);`,
      },
    ],
  ),
  def(
    'lensFlare',
    'Lens Flare',
    'Generate',
    'Procedural anamorphic style flare.',
    [P.pt('center', 'Flare Center', [0.3, 0.3]), P.num('brightness', 'Flare Brightness', 100, 0, 300, 1), P.col('color', 'Flare Color', [1, 0.9, 0.7, 1]), P.num('streak', 'Streak Length', 40, 0, 100, 0.5), P.pct('blend', 'Blend With Original', 0)],
    [
      {
        frag: `
  float aspect = u_res.x / u_res.y;
  vec2 q = uv - p_center; q.x *= aspect;
  float d = length(q);
  float core = exp(-d * d * 60.0) * 1.5;
  float halo = exp(-abs(d - 0.18) * 40.0) * 0.25;
  float streak = exp(-abs(q.y) * 220.0) * exp(-abs(q.x) * (12.0 / max(p_streak / 100.0, 0.02))) * 0.6;
  float ghosts = 0.0;
  for (int i = 1; i <= 4; i++) { vec2 gp = -q * (0.35 * float(i)); ghosts += exp(-dot(q + gp, q + gp) * 400.0 / float(i)) * 0.12; }
  float f = (core + halo + streak + ghosts) * p_brightness / 100.0;
  vec3 fc = p_color.rgb * f;
  fc += vec3(0.2, 0.4, 1.0) * streak * 0.3 * p_brightness / 100.0;
  vec4 r = vec4(c.rgb + fc, max(c.a, clamp(f, 0.0, 1.0)));
  outColor = mix(r, c, p_blend / 100.0);`,
      },
    ],
  ),
  def(
    'checkerboard',
    'Checkerboard',
    'Generate',
    'Two-color checker pattern.',
    [P.num('size', 'Size', 64, 2, 1024, 1), P.col('c1', 'Color 1', [0.2, 0.2, 0.2, 1]), P.col('c2', 'Color 2', [0.8, 0.8, 0.8, 1]), P.pct('blend', 'Blend With Original', 0)],
    [
      {
        frag: `
  vec2 px = floor(uv * u_res / max(p_size, 1.0));
  float k = mod(px.x + px.y, 2.0);
  vec4 r = mix(vec4(p_c1.rgb, 1.0), vec4(p_c2.rgb, 1.0), k);
  outColor = mix(r, c, p_blend / 100.0);`,
      },
    ],
  ),

  /* ===== Noise & Grain ===== */
  def(
    'noise',
    'Noise',
    'Noise & Grain',
    'Random per-pixel noise.',
    [P.num('amount', 'Amount of Noise', 20, 0, 100, 0.5), P.bool('color', 'Use Color Noise', true), P.bool('clip', 'Clip Result Values', true)],
    [
      {
        frag: `
  float seed = u_seqTime * 60.0;
  vec3 n = p_color > 0.5 ? vec3(hash12(uv * u_res + seed), hash12(uv * u_res + seed + 17.0), hash12(uv * u_res + seed + 31.0)) : vec3(hash12(uv * u_res + seed));
  n = (n - 0.5) * p_amount / 100.0;
  vec3 r = c.rgb + n * c.a;
  if (p_clip > 0.5) r = clamp(r, 0.0, 1.0);
  outColor = vec4(r, c.a);`,
      },
    ],
    { animated: true },
  ),
  def(
    'filmGrain',
    'Film Grain',
    'Noise & Grain',
    'Luma-weighted soft grain with size control.',
    [P.num('intensity', 'Intensity', 30, 0, 100, 0.5), P.num('size', 'Grain Size', 1.5, 0.5, 6, 0.05), P.num('shadowsWeight', 'Shadows Emphasis', 60, 0, 100, 0.5), P.num('saturation', 'Color Amount', 20, 0, 100, 0.5)],
    [
      {
        frag: `
  float seed = floor(u_seqTime * 24.0) * 7.31;
  vec2 gp = uv * u_res / max(p_size, 0.5);
  float g1 = noise2(gp + seed), g2 = noise2(gp + seed + 41.7), g3 = noise2(gp + seed + 93.1);
  vec3 g = (vec3(g1, g2, g3) - 0.5);
  g = mix(vec3(dot(g, vec3(0.333))), g, p_saturation / 100.0);
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  float L = luma(col);
  float w = mix(1.0, 1.0 - L, p_shadowsWeight / 100.0);
  col += g * (p_intensity / 100.0) * 0.6 * w;
  outColor = vec4(clamp(col, 0.0, 1.0) * a, a);`,
      },
    ],
    { animated: true },
  ),
  def(
    'dust',
    'Dust & Scratches',
    'Noise & Grain',
    'Old film artifacts: dust specks, vertical scratches and flicker.',
    [P.num('dust', 'Dust Amount', 30, 0, 100, 0.5), P.num('scratches', 'Scratch Amount', 30, 0, 100, 0.5), P.num('flicker', 'Flicker', 20, 0, 100, 0.5), P.num('jitter', 'Gate Weave', 20, 0, 100, 0.5)],
    [
      {
        frag: `
  float fr = floor(u_seqTime * 24.0);
  vec2 jit = (vec2(hash12(vec2(fr, 1.0)), hash12(vec2(fr, 2.0))) - 0.5) * p_jitter / 100.0 * 6.0 / u_res;
  vec4 s = sampleClamped(u_tex, uv + jit);
  vec3 col = s.rgb; float a = s.a; if (a > 0.0001) col /= a;
  float fl = 1.0 + (hash12(vec2(fr, 3.0)) - 0.5) * p_flicker / 100.0 * 0.4;
  col *= fl;
  // scratches
  for (int i = 0; i < 3; i++) {
    float sx = hash12(vec2(fr * 0.7 + float(i) * 13.0, 5.0));
    float on = step(1.0 - p_scratches / 100.0 * 0.6, hash12(vec2(fr, 7.0 + float(i))));
    float w = 1.2 / u_res.x;
    float sc = (1.0 - smoothstep(0.0, w, abs(uv.x - sx))) * on * 0.7;
    col = mix(col, vec3(0.9), sc);
  }
  // dust
  vec2 cell = floor(uv * vec2(24.0, 14.0)); vec2 cp = (cell + vec2(hash12(cell + fr), hash12(cell + fr + 9.0))) / vec2(24.0, 14.0);
  float on = step(1.0 - p_dust / 100.0 * 0.15, hash12(cell + fr * 3.0));
  float d = distance(uv * vec2(u_res.x / u_res.y, 1.0), cp * vec2(u_res.x / u_res.y, 1.0));
  float r = 0.002 + hash12(cell + fr + 4.0) * 0.004;
  col = mix(col, vec3(0.05), (1.0 - smoothstep(r * 0.5, r, d)) * on);
  outColor = vec4(clamp(col, 0.0, 1.0) * a, a);`,
      },
    ],
    { animated: true },
  ),
  def(
    'vhs',
    'VHS',
    'Noise & Grain',
    'Analog tape artifacts: tracking noise, color bleed, wobble.',
    [P.num('bleed', 'Color Bleed', 40, 0, 100, 0.5), P.num('noise', 'Tape Noise', 40, 0, 100, 0.5), P.num('wobble', 'Wobble', 30, 0, 100, 0.5), P.num('tracking', 'Tracking Bar', 30, 0, 100, 0.5)],
    [
      {
        frag: `
  float t = u_seqTime;
  float wob = sin(uv.y * 30.0 + t * 8.0) * p_wobble / 100.0 * 2.0 / u_res.x + (hash12(vec2(floor(uv.y * u_res.y), floor(t * 30.0))) - 0.5) * p_wobble / 100.0 * 3.0 / u_res.x;
  vec2 q = uv + vec2(wob, 0.0);
  float bl = p_bleed / 100.0 * 6.0 / u_res.x;
  vec4 s = sampleClamped(u_tex, q);
  vec3 col = s.rgb;
  col.r = (sampleClamped(u_tex, q + vec2(bl, 0.0)).r + col.r) * 0.5;
  col.b = (sampleClamped(u_tex, q - vec2(bl, 0.0)).b + col.b) * 0.5;
  vec3 yiq = vec3(luma(col), dot(col, vec3(0.596, -0.274, -0.322)), dot(col, vec3(0.211, -0.523, 0.312)));
  float bar = fract(t * 0.15); float bd = abs(uv.y - bar);
  float barMask = (1.0 - smoothstep(0.0, 0.04, bd)) * p_tracking / 100.0;
  float n = (hash12(uv * u_res + t * 100.0) - 0.5) * (p_noise / 100.0 * 0.3 + barMask * 0.8);
  yiq.x += n; yiq.yz *= 1.0 - barMask * 0.8;
  yiq.yz *= 0.85;
  col = vec3(yiq.x + 0.956 * yiq.y + 0.621 * yiq.z, yiq.x - 0.272 * yiq.y - 0.647 * yiq.z, yiq.x - 1.106 * yiq.y + 1.703 * yiq.z);
  outColor = vec4(clamp(col, 0.0, 1.0), s.a);`,
      },
    ],
    { animated: true },
  ),

  /* ===== Utility ===== */
  def(
    'crop',
    'Crop',
    'Transform',
    'Crop each edge, with optional feather and zoom to fill.',
    [P.pct('left', 'Left', 0), P.pct('top', 'Top', 0), P.pct('right', 'Right', 0), P.pct('bottom', 'Bottom', 0), P.num('feather', 'Edge Feather', 0, 0, 200, 0.5), P.bool('zoom', 'Zoom', false)],
    [
      {
        frag: `
  float l = p_left / 100.0, t = p_top / 100.0, r = 1.0 - p_right / 100.0, b = 1.0 - p_bottom / 100.0;
  vec2 q = uv;
  if (p_zoom > 0.5) { q = vec2(mix(l, r, uv.x), mix(t, b, uv.y)); outColor = sampleClamped(u_tex, q); return; }
  vec2 fe = max(p_feather, 0.001) / u_res;
  float m = smoothstep(l, l + fe.x, uv.x) * smoothstep(t, t + fe.y, uv.y) * (1.0 - smoothstep(r - fe.x, r, uv.x)) * (1.0 - smoothstep(b - fe.y, b, uv.y));
  outColor = c * m;`,
      },
    ],
  ),
  def(
    'flip',
    'Flip',
    'Transform',
    'Horizontal and/or vertical flip.',
    [P.bool('horizontal', 'Horizontal', true), P.bool('vertical', 'Vertical', false)],
    [
      {
        frag: `
  vec2 q = uv;
  if (p_horizontal > 0.5) q.x = 1.0 - q.x;
  if (p_vertical > 0.5) q.y = 1.0 - q.y;
  outColor = texture(u_tex, q);`,
      },
    ],
  ),
  def(
    'roundedCorners',
    'Rounded Corners',
    'Transform',
    'Round the clip corners with anti-aliasing.',
    [P.num('radius', 'Radius', 40, 0, 1000, 0.5), P.num('feather', 'Feather', 1, 0, 100, 0.5)],
    [
      {
        frag: `
  vec2 px = uv * u_res; vec2 half = u_res * 0.5; float r = min(p_radius, min(half.x, half.y));
  vec2 d = abs(px - half) - (half - r);
  float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
  float m = 1.0 - smoothstep(-max(p_feather, 0.5), 0.0, dist);
  outColor = c * m;`,
      },
    ],
  ),
  def(
    'vignette',
    'Vignette',
    'Stylize',
    'Darken or lighten the frame edges.',
    [P.num('amount', 'Amount', 1, -3, 3, 0.05), P.num('size', 'Size', 60, 0, 150, 0.5), P.num('feather', 'Feather', 60, 0, 100, 0.5), P.num('roundness', 'Roundness', 50, 0, 100, 0.5), P.pt('center', 'Center', [0.5, 0.5]), P.col('color', 'Color', [0, 0, 0, 1])],
    [
      {
        frag: `
  float aspect = u_res.x / u_res.y;
  vec2 q = uv - p_center; q.x *= mix(aspect, 1.0, p_roundness / 100.0);
  float d = length(q) / 0.7071;
  float s = p_size / 100.0; float f = max(p_feather / 100.0, 0.001);
  float v = smoothstep(s - f * 0.5, s + f * 0.5, d) * clamp(abs(p_amount), 0.0, 1.0);
  vec3 col = c.rgb; float a = c.a; if (a > 0.0001) col /= a;
  col = p_amount >= 0.0 ? mix(col, p_color.rgb, v) : mix(col, vec3(1.0), v);
  outColor = vec4(col * a, a);`,
      },
    ],
  ),
  def(
    'echo',
    'Echo (Trails)',
    'Time',
    'Blend the current frame with a decayed copy of the previous output frame.',
    [P.num('decay', 'Decay', 0.7, 0, 0.99, 0.01), P.num('intensity', 'Echo Intensity', 0.8, 0, 2, 0.01)],
    [
      {
        needsOriginal: true,
        frag: `
  vec4 prev = texture(u_prev, uv);
  vec4 r = max(c, prev * p_decay * p_intensity);
  outColor = clamp(r, 0.0, 1.0);`,
      },
    ],
    { animated: true },
  ),
  def(
    'posterizeTime',
    'Posterize Time',
    'Time',
    'Lower the effective frame rate of the clip.',
    [P.num('fps', 'Frame Rate', 12, 1, 60, 0.5)],
    [{ frag: `outColor = c;` }],
    { animated: false },
  ),
];

export const EFFECT_MAP: Record<string, EffectDef> = Object.fromEntries(EFFECTS.map((e) => [e.type, e]));

export function getEffectDef(type: string): EffectDef | undefined {
  return EFFECT_MAP[type];
}

export function defaultEffectParams(defn: EffectDef): Record<string, Param> {
  const out: Record<string, Param> = {};
  for (const p of defn.params) out[p.key] = param(p.default as ParamValue);
  return out;
}

export const EFFECT_CATEGORIES: EffectCategory[] = [
  'Color Correction',
  'Blur & Sharpen',
  'Distort',
  'Stylize',
  'Keying',
  'Generate',
  'Noise & Grain',
  'Transform',
  'Time',
  'Utility',
  'Audio: Dynamics',
  'Audio: EQ',
  'Audio: Reverb & Delay',
  'Audio: Modulation',
  'Audio: Utility',
];
