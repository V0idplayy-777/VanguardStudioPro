import { GLSL_COMMON, type EffectDef, type ParamDef } from '../effects/registry';
import { TRANSITION_GLSL_PRELUDE, type TransitionDef } from '../effects/transitions';

const HEADER = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform sampler2D u_orig;
uniform sampler2D u_prev;
uniform sampler2D u_matte;
uniform vec2 u_res;
uniform float u_time;
uniform float u_seqTime;
uniform float u_frame;
`;

function uniformDecl(p: ParamDef): string {
  switch (p.kind) {
    case 'color':
      return `uniform vec4 p_${p.key};`;
    case 'point':
      return `uniform vec2 p_${p.key};`;
    default:
      return `uniform float p_${p.key};`;
  }
}

export function buildEffectFrag(def: EffectDef, passIndex: number): string {
  const pass = def.passes[passIndex];
  const decls = def.params.map(uniformDecl).join('\n');
  return `${HEADER}
${decls}
${GLSL_COMMON}
void main() {
  vec2 uv = v_uv;
  vec4 c = texture(u_tex, uv);
${pass.frag}
}`;
}

export function buildTransitionFrag(def: TransitionDef): string {
  const decls = def.params.map(uniformDecl).join('\n');
  return `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float u_progress;
uniform vec2 u_res;
${decls}
${GLSL_COMMON}
${TRANSITION_GLSL_PRELUDE}
void main() {
  vec2 uv = v_uv;
  float p = clamp(u_progress, 0.0, 1.0);
  vec4 A = texture(u_from, uv);
  vec4 B = texture(u_to, uv);
${def.frag}
}`;
}

/* ---------- fixed pipeline shaders ---------- */

/** Draw a source texture into the sequence frame with motion (position/scale/rotation/anchor/opacity), premultiplied. */
export const MOTION_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec2 u_seqRes;     // destination size in px
uniform vec2 u_srcRes;     // source size in px (after scale to fit? no: raw)
uniform vec2 u_position;   // normalised 0..1 in sequence
uniform vec2 u_anchor;     // normalised 0..1 in source
uniform vec2 u_scale;      // x/y scale factor (1 = source pixels map 1:1 to sequence pixels)
uniform float u_rotation;  // radians
uniform float u_opacity;
uniform float u_flipY;
void main() {
  vec2 px = v_uv * u_seqRes;               // destination pixel
  vec2 p = px - u_position * u_seqRes;     // relative to position
  float cs = cos(-u_rotation), sn = sin(-u_rotation);
  p = vec2(p.x * cs - p.y * sn, p.x * sn + p.y * cs);
  p /= max(u_scale, vec2(1e-6));
  vec2 src = p + u_anchor * u_srcRes;      // source pixel
  vec2 suv = src / u_srcRes;
  if (u_flipY > 0.5) suv.y = 1.0 - suv.y;
  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) { outColor = vec4(0.0); return; }
  vec4 c = texture(u_tex, suv);
  outColor = c * u_opacity;
}`;

/** Composite src over dst with blend mode. Both premultiplied. */
export const BLEND_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_dst;
uniform sampler2D u_src;
uniform int u_mode;
uniform float u_seed;
${GLSL_COMMON}
vec3 unpremul(vec4 c) { return c.a > 1e-5 ? c.rgb / c.a : vec3(0.0); }
float blendChannel(float b, float s, int mode) {
  if (mode == 2) return min(b, s);                                  // darken
  if (mode == 3) return b * s;                                      // multiply
  if (mode == 4) return s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s); // color burn
  if (mode == 5) return max(b + s - 1.0, 0.0);                      // linear burn
  if (mode == 6) return max(b, s);                                  // lighten
  if (mode == 7) return b + s - b * s;                              // screen
  if (mode == 8) return s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s));   // color dodge
  if (mode == 9) return min(b + s, 1.0);                            // linear dodge
  if (mode == 10) return b <= 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s); // overlay
  if (mode == 11) { // soft light
    if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
    float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
    return b + (2.0 * s - 1.0) * (d - b);
  }
  if (mode == 12) return s <= 0.5 ? 2.0 * s * b : 1.0 - 2.0 * (1.0 - s) * (1.0 - b); // hard light
  if (mode == 13) return s <= 0.5 ? (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / (2.0 * s))) : (s >= 1.0 ? 1.0 : min(1.0, b / (2.0 * (1.0 - s)))); // vivid light
  if (mode == 14) return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);         // linear light
  if (mode == 15) return s <= 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0); // pin light
  if (mode == 16) return (b + s) >= 1.0 ? 1.0 : 0.0;                 // hard mix
  if (mode == 17) return abs(b - s);                                 // difference
  if (mode == 18) return b + s - 2.0 * b * s;                        // exclusion
  if (mode == 19) return max(b - s, 0.0);                            // subtract
  if (mode == 20) return s <= 0.0 ? 1.0 : min(b / s, 1.0);           // divide
  return s;
}
vec3 setLum(vec3 c, float l) { float d = l - luma(c); c += d; float L = luma(c); float n = min(c.r, min(c.g, c.b)); float x = max(c.r, max(c.g, c.b)); if (n < 0.0) c = L + (c - L) * L / max(L - n, 1e-5); if (x > 1.0) c = L + (c - L) * (1.0 - L) / max(x - L, 1e-5); return c; }
float sat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 setSat(vec3 c, float s) { float mx = max(c.r, max(c.g, c.b)); float mn = min(c.r, min(c.g, c.b)); vec3 r = vec3(0.0); if (mx > mn) { r = (c - mn) * s / (mx - mn); } return r; }
void main() {
  vec4 d = texture(u_dst, v_uv);
  vec4 s = texture(u_src, v_uv);
  if (u_mode == 0) { outColor = s + d * (1.0 - s.a); return; }
  if (u_mode == 1) { // dissolve: stochastic
    float n = hash12(v_uv * 4096.0 + u_seed);
    float a = s.a; vec4 ss = n < a ? vec4(unpremul(s), 1.0) : vec4(0.0);
    outColor = ss + d * (1.0 - ss.a); return;
  }
  vec3 cb = unpremul(d); vec3 cs = unpremul(s);
  vec3 r;
  if (u_mode == 21) r = setLum(setSat(cs, sat(cb)), luma(cb));
  else if (u_mode == 22) r = setLum(setSat(cb, sat(cs)), luma(cb));
  else if (u_mode == 23) r = setLum(cs, luma(cb));
  else if (u_mode == 24) r = setLum(cb, luma(cs));
  else r = vec3(blendChannel(cb.r, cs.r, u_mode), blendChannel(cb.g, cs.g, u_mode), blendChannel(cb.b, cs.b, u_mode));
  // Porter-Duff with blend: result = (1 - ab) * cs + ab * B(cb, cs), then source-over
  vec3 mixed = (1.0 - d.a) * cs + d.a * r;
  vec4 sp = vec4(mixed * s.a, s.a);
  outColor = sp + d * (1.0 - sp.a);
}`;

/** Apply a feathered shape mask to a premultiplied texture. */
export const MASK_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform sampler2D u_maskTex;   // rasterised mask coverage (r)
uniform float u_inverted;
uniform float u_opacity;
void main() {
  vec4 c = texture(u_tex, v_uv);
  float m = texture(u_maskTex, v_uv).r;
  if (u_inverted > 0.5) m = 1.0 - m;
  m = mix(1.0, m, u_opacity);
  outColor = c * m;
}`;

/** Combine original and effected using mask: out = mix(orig, fx, mask). */
export const MASK_MIX_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_orig;
uniform sampler2D u_fx;
uniform sampler2D u_maskTex;
void main() {
  vec4 o = texture(u_orig, v_uv);
  vec4 f = texture(u_fx, v_uv);
  float m = texture(u_maskTex, v_uv).r;
  outColor = mix(o, f, m);
}`;

/** Rasterise ellipse / rect masks with feather directly. */
export const SHAPE_MASK_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec2 u_res;
uniform vec2 u_center;
uniform vec2 u_size;
uniform float u_rotation;
uniform float u_feather;   // px
uniform float u_expansion; // px
uniform int u_shape;       // 0 rect 1 ellipse
uniform float u_inverted;
uniform float u_opacity;
uniform int u_accumulate;  // 1 = max with existing
uniform sampler2D u_prevMask;
void main() {
  vec2 px = v_uv * u_res;
  vec2 c = u_center * u_res;
  vec2 p = px - c;
  float cs = cos(-u_rotation), sn = sin(-u_rotation);
  p = vec2(p.x * cs - p.y * sn, p.x * sn + p.y * cs);
  vec2 half = u_size * u_res * 0.5 + u_expansion;
  float d;
  if (u_shape == 0) { vec2 q = abs(p) - half; d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0); }
  else { vec2 q = p / max(half, vec2(1e-3)); float r = length(q); d = (r - 1.0) * min(half.x, half.y); }
  float f = max(u_feather, 0.5);
  float m = 1.0 - smoothstep(-f * 0.5, f * 0.5, d);
  if (u_inverted > 0.5) m = 1.0 - m;
  m *= u_opacity;
  if (u_accumulate == 1) m = max(m, texture(u_prevMask, v_uv).r);
  outColor = vec4(m, m, m, 1.0);
}`;

export const COPY_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform float u_flipY;
void main() {
  vec2 uv = v_uv; if (u_flipY > 0.5) uv.y = 1.0 - uv.y;
  outColor = texture(u_tex, uv);
}`;

/** Final present: premultiplied -> straight display over a background color, with optional overlays. */
export const PRESENT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec3 u_bg;
uniform int u_channel;   // 0 rgb, 1 alpha, 2 r, 3 g, 4 b, 5 luma
uniform float u_checker;
void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec4 c = texture(u_tex, uv);
  vec3 bg = u_bg;
  if (u_checker > 0.5) { vec2 g = floor(gl_FragCoord.xy / 8.0); float k = mod(g.x + g.y, 2.0); bg = mix(vec3(0.25), vec3(0.4), k); }
  vec3 rgb = c.rgb + bg * (1.0 - c.a);
  if (u_channel == 1) rgb = vec3(c.a);
  else if (u_channel == 2) rgb = vec3(c.r / max(c.a, 1e-4));
  else if (u_channel == 3) rgb = vec3(c.g / max(c.a, 1e-4));
  else if (u_channel == 4) rgb = vec3(c.b / max(c.a, 1e-4));
  else if (u_channel == 5) rgb = vec3(dot(rgb, vec3(0.2126, 0.7152, 0.0722)));
  outColor = vec4(rgb, 1.0);
}`;

export const SOLID_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec4 u_color;
void main() { outColor = vec4(u_color.rgb * u_color.a, u_color.a); }`;

/** SMPTE bars generator. */
export const BARS_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
void main() {
  float x = v_uv.x; float y = v_uv.y;
  vec3 c;
  if (y < 0.67) {
    int i = int(floor(x * 7.0));
    vec3 cols[7]; cols[0] = vec3(0.75); cols[1] = vec3(0.75, 0.75, 0.0); cols[2] = vec3(0.0, 0.75, 0.75); cols[3] = vec3(0.0, 0.75, 0.0); cols[4] = vec3(0.75, 0.0, 0.75); cols[5] = vec3(0.75, 0.0, 0.0); cols[6] = vec3(0.0, 0.0, 0.75);
    c = cols[i];
  } else if (y < 0.75) {
    int i = int(floor(x * 7.0));
    vec3 cols[7]; cols[0] = vec3(0.0, 0.0, 0.75); cols[1] = vec3(0.075); cols[2] = vec3(0.75, 0.0, 0.75); cols[3] = vec3(0.075); cols[4] = vec3(0.0, 0.75, 0.75); cols[5] = vec3(0.075); cols[6] = vec3(0.75);
    c = cols[i];
  } else {
    if (x < 0.125) c = vec3(0.0, 0.13, 0.3); else if (x < 0.25) c = vec3(1.0); else if (x < 0.375) c = vec3(0.2, 0.0, 0.42); else if (x < 0.625) c = vec3(0.075); else if (x < 0.667) c = vec3(0.035); else if (x < 0.708) c = vec3(0.075); else if (x < 0.75) c = vec3(0.115); else c = vec3(0.075);
  }
  outColor = vec4(c, 1.0);
}`;
