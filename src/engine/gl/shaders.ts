import { GLSL_COMMON, type EffectDef, type ParamDef } from '../effects/registry';
import { TRANSITION_GLSL_PRELUDE, type TransitionDef } from '../effects/transitions';

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform sampler2D u_orig;
uniform sampler2D u_prev;
uniform sampler2D u_prev1;
uniform sampler2D u_prev2;
uniform sampler2D u_matte;
uniform sampler2D u_texB;
uniform highp sampler3D u_lut;
uniform vec2 u_res;
uniform float u_time;
uniform float u_seqTime;
uniform float u_frame;
uniform float u_lutSize;
uniform float u_alpha;

/* Trilinear 3D LUT lookup, inset by half a texel so CLAMP_TO_EDGE never
   extrapolates past the first or last cube entry. Operates on straight alpha. */
vec3 applyLut3D(vec3 c) {
  float s = max(u_lutSize, 2.0);
  vec3 q = clamp(c, vec3(0.0), vec3(1.0)) * ((s - 1.0) / s) + (0.5 / s);
  return texture(u_lut, q).rgb;
}

/* Exact 3x3 inverse (gl-matrix formulation; GLSL mat3 is column-major, so
   a01 means row 0 column 1). Used by Corner Pin. Verified in tests/gl-maths.ts,
   which mirrors these index conventions exactly. */
mat3 invert3(mat3 m) {
  float a00 = m[0][0], a01 = m[1][0], a02 = m[2][0];
  float a10 = m[0][1], a11 = m[1][1], a12 = m[2][1];
  float a20 = m[0][2], a21 = m[1][2], a22 = m[2][2];
  float b01 =  a22 * a11 - a12 * a21;
  float b11 = -a22 * a10 + a12 * a20;
  float b21 =  a21 * a10 - a11 * a20;
  float det = a00 * b01 + a01 * b11 + a02 * b21;
  if (abs(det) < 1e-9) return mat3(1.0);
  float id = 1.0 / det;
  return mat3(
    b01 * id, b11 * id, b21 * id,
    (-a22 * a01 + a02 * a21) * id, (a22 * a00 - a02 * a20) * id, (-a21 * a00 + a01 * a20) * id,
    (a12 * a01 - a02 * a11) * id, (-a12 * a00 + a02 * a10) * id, (a11 * a00 - a01 * a10) * id
  );
}

/* Projective map taking the unit square to the quad (tl, tr, br, bl). */
mat3 quadMatrix(vec2 tl, vec2 tr, vec2 br, vec2 bl) {
  float dx1 = tr.x - br.x, dx2 = bl.x - br.x, dx3 = tl.x - tr.x + br.x - bl.x;
  float dy1 = tr.y - br.y, dy2 = bl.y - br.y, dy3 = tl.y - tr.y + br.y - bl.y;
  float den = dx1 * dy2 - dx2 * dy1;
  if (abs(den) < 1e-9) return mat3(1.0);
  float g = (dx3 * dy2 - dx2 * dy3) / den;
  float h = (dx1 * dy3 - dx3 * dy1) / den;
  return mat3(
    tr.x - tl.x + g * tr.x, tr.y - tl.y + g * tr.y, g,
    bl.x - tl.x + h * bl.x, bl.y - tl.y + h * bl.y, h,
    tl.x, tl.y, 1.0
  );
}
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
  // half is a reserved word in GLSL ES 3.00, so it cannot name a local.
  vec2 halfRes = u_size * u_res * 0.5 + u_expansion;
  float d;
  if (u_shape == 0) { vec2 q = abs(p) - halfRes; d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0); }
  else { vec2 q = p / max(halfRes, vec2(1e-3)); float r = length(q); d = (r - 1.0) * min(halfRes.x, halfRes.y); }
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
/**
 * Exposure monitoring aids.
 *
 * False colour maps display-referred luma onto the ALEXA-style exposure scale:
 * middle gray reads green and each step away from it is a distinct colour.
 * Zebras hatch the ranges that clip or crush.
 *
 * Both are applied ONLY in this present path. `readPixels` (scopes, export,
 * thumbnails) forces u_display to 0, so a monitoring aid can never be baked
 * into a rendered file.
 */
const DISPLAY_GLSL = `
uniform int u_display;      // 0 none, 1 false colour, 2 zebras, 3 both
uniform float u_zebraHi;    // over threshold in display code values; -1 = off
uniform float u_zebraLo;    // under threshold; -1 = off

vec3 falseColor(float y) {
  if (y >= 1.000) return vec3(1.00, 0.72, 0.90);  // pink: clipping
  if (y >= 0.610) return vec3(0.85, 0.15, 0.10);  // red: ~1 stop over gray
  if (y >= 0.500) return vec3(0.95, 0.75, 0.10);  // yellow: half stop over
  if (y >= 0.450) return vec3(0.55, 0.75, 0.25);  // yellow-green
  if (y >= 0.380) return vec3(0.20, 0.80, 0.30);  // green: middle gray
  if (y >= 0.280) return vec3(0.10, 0.55, 0.45);  // dark green: ~1 stop under
  if (y >= 0.180) return vec3(0.15, 0.30, 0.75);  // blue: ~2 stops under
  if (y >= 0.090) return vec3(0.35, 0.15, 0.60);  // indigo: ~3 stops under
  if (y >= 0.030) return vec3(0.10, 0.05, 0.20);  // near black: crushed
  return vec3(0.0);                               // black: no signal
}

vec4 displayMode(vec3 rgb) {
  if (u_display == 0) return vec4(rgb, 1.0);
  float y = dot(clamp(rgb, vec3(0.0), vec3(4.0)), vec3(0.2126, 0.7152, 0.0722));
  vec3 base = rgb;
  if (u_display == 1 || u_display == 3) base = falseColor(y);
  if (u_display == 2 || u_display == 3) {
    // Diagonal hatch so the overlay reads as an aid, not as picture content.
    float stripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 6.0));
    if (u_zebraHi >= 0.0 && y >= u_zebraHi) base = mix(base, vec3(1.0), stripe);
    else if (u_zebraLo >= 0.0 && y <= u_zebraLo) base = mix(base, vec3(0.25, 0.55, 1.0), stripe);
  }
  return vec4(base, 1.0);
}
`;

export const PRESENT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec3 u_bg;
uniform int u_channel;   // 0 rgb, 1 alpha, 2 r, 3 g, 4 b, 5 luma
uniform float u_checker;
${DISPLAY_GLSL}
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
  outColor = displayMode(rgb);
}`;

/**
 * Optical-flow interpolation: warp the two bracketing source frames to the
 * requested sub-frame time and blend, with an occlusion test so newly revealed
 * areas fall back to a single frame instead of smearing.
 *
 * The flow texture holds A->B motion in normalized frame units (dx*W, dy*H
 * pixels) with R,G as (v*0.5+0.5) and confidence in B. All coordinates here are
 * in image space (y down) because that is how the source textures and the flow
 * grid are stored. See engine/time/opticalFlow.ts.
 */
export const FLOW_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_flow;
uniform vec2 u_res;
uniform float u_alpha;      // 0 = show A, 1 = show B
uniform float u_occlusion;  // consistency threshold, in fraction of frame width
vec2 decodeFlow(vec4 e) { return (e.rg - 0.5) * 2.0; }
void main() {
  vec2 p = vec2(v_uv.x, 1.0 - v_uv.y);
  vec4 f = texture(u_flow, p);
  vec2 flow = decodeFlow(f);
  vec2 pA = p - flow * u_alpha;
  vec2 pB = p + flow * (1.0 - u_alpha);
  bool inA = pA.x >= 0.0 && pA.x <= 1.0 && pA.y >= 0.0 && pA.y <= 1.0;
  bool inB = pB.x >= 0.0 && pB.x <= 1.0 && pB.y >= 0.0 && pB.y <= 1.0;
  if (!inA && !inB) { outColor = vec4(0.0); return; }
  vec4 A = inA ? texture(u_a, pA) : vec4(0.0);
  vec4 B = inB ? texture(u_b, pB) : vec4(0.0);
  if (!inA) { outColor = B; return; }
  if (!inB) { outColor = A; return; }
  // Disocclusion test. Only one field (A->B) is available, so compare the flow
  // at the two warped positions: where the field changes sharply across the warp
  // distance we are on an occlusion boundary, and blending the two frames there
  // produces the classic ghost smear. Snap to the nearer frame instead.
  vec2 vA = decodeFlow(texture(u_flow, pA));
  vec2 vB = decodeFlow(texture(u_flow, pB));
  float err = length((vA - vB) * u_res) / max(u_res.x, 1.0);
  float occ = smoothstep(u_occlusion * 0.5, u_occlusion * 2.0, err);
  // Low-confidence cells (flat or repetitive texture) have no reliable vector,
  // so dissolve them rather than warping noise.
  occ = max(occ, 1.0 - clamp(f.b * 1.5, 0.0, 1.0));
  float wA = mix(1.0 - u_alpha, u_alpha < 0.5 ? 1.0 : 0.0, occ);
  outColor = A * wA + B * (1.0 - wA);
}`;

/** Plain cross-dissolve between two bracketing source frames. */
export const LERP_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform float u_alpha;
void main() {
  vec2 p = vec2(v_uv.x, 1.0 - v_uv.y);
  outColor = mix(texture(u_a, p), texture(u_b, p), clamp(u_alpha, 0.0, 1.0));
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
