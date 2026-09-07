import type { ParamDef } from './registry';

/*
  Video transitions. Each is a GLSL program that receives:
    u_from  - outgoing clip
    u_to    - incoming clip
    u_progress 0..1
    u_res   - resolution
    p_*     - params
  and writes outColor.
*/

export interface TransitionDef {
  type: string;
  name: string;
  category: 'Dissolve' | 'Wipe' | 'Slide' | 'Zoom' | 'Iris' | '3D Motion' | 'Page Peel' | 'Stylize' | 'Audio';
  description: string;
  params: ParamDef[];
  frag: string;
  audio?: boolean;
}

const sel = (key: string, label: string, d: number, options: { value: number; label: string }[]): ParamDef => ({ key, label, kind: 'select', default: d, options });
const num = (key: string, label: string, d: number, min: number, max: number, step = 0.1): ParamDef => ({ key, label, kind: 'number', default: d, min, max, step });
const col = (key: string, label: string, d: [number, number, number, number]): ParamDef => ({ key, label, kind: 'color', default: d });
const bool = (key: string, label: string, d: boolean): ParamDef => ({ key, label, kind: 'bool', default: d });

const dirOptions = [
  { value: 0, label: 'Left to Right' },
  { value: 1, label: 'Right to Left' },
  { value: 2, label: 'Top to Bottom' },
  { value: 3, label: 'Bottom to Top' },
];

const dirVec = `
vec2 dirVec(float d) { if (d == 0.0) return vec2(1.0, 0.0); if (d == 1.0) return vec2(-1.0, 0.0); if (d == 2.0) return vec2(0.0, 1.0); return vec2(0.0, -1.0); }
float dirCoord(vec2 uv, float d) { if (d == 0.0) return uv.x; if (d == 1.0) return 1.0 - uv.x; if (d == 2.0) return uv.y; return 1.0 - uv.y; }
`;

function t(type: string, name: string, category: TransitionDef['category'], description: string, params: ParamDef[], frag: string): TransitionDef {
  return { type, name, category, description, params, frag };
}

export const TRANSITIONS: TransitionDef[] = [
  t('crossDissolve', 'Cross Dissolve', 'Dissolve', 'Linear blend between clips.', [], `outColor = mix(A, B, p);`),
  t(
    'filmDissolve',
    'Film Dissolve',
    'Dissolve',
    'Dissolve in linear light for a more natural film-like blend.',
    [],
    `vec3 a = srgb2lin(A.rgb), b = srgb2lin(B.rgb); outColor = vec4(lin2srgb(mix(a, b, p)), mix(A.a, B.a, p));`,
  ),
  t(
    'dipToBlack',
    'Dip to Black',
    'Dissolve',
    'Fade out to black then in.',
    [col('color', 'Color', [0, 0, 0, 1])],
    `float k = p < 0.5 ? 1.0 - p * 2.0 : (p - 0.5) * 2.0; vec4 src = p < 0.5 ? A : B; outColor = mix(vec4(p_color.rgb, 1.0), src, k);`,
  ),
  t(
    'dipToWhite',
    'Dip to White',
    'Dissolve',
    'Fade out to white then in.',
    [],
    `float k = p < 0.5 ? 1.0 - p * 2.0 : (p - 0.5) * 2.0; vec4 src = p < 0.5 ? A : B; outColor = mix(vec4(1.0), src, k);`,
  ),
  t(
    'additiveDissolve',
    'Additive Dissolve',
    'Dissolve',
    'Blend with brightened overlap.',
    [],
    `vec4 add = min(A + B, 1.0); float w = 1.0 - abs(p * 2.0 - 1.0); outColor = mix(mix(A, B, p), add, w * 0.6);`,
  ),
  t(
    'nonAdditiveDissolve',
    'Non-Additive Dissolve',
    'Dissolve',
    'Brighter pixels win during the overlap.',
    [],
    `float la = luma(A.rgb) * (1.0 - p), lb = luma(B.rgb) * p; outColor = la > lb ? A : B; outColor = mix(mix(A, B, p), outColor, 1.0 - abs(p * 2.0 - 1.0));`,
  ),
  t(
    'ditherDissolve',
    'Dither Dissolve',
    'Dissolve',
    'Stochastic pixel dissolve.',
    [num('size', 'Pixel Size', 2, 1, 32, 1)],
    `float n = hash12(floor(uv * u_res / p_size)); outColor = n < p ? B : A;`,
  ),
  t(
    'morphCut',
    'Morph Cut (Blur Dissolve)',
    'Dissolve',
    'Dissolve through a soft blur to hide jump cuts.',
    [num('blur', 'Max Blur', 12, 0, 60, 0.5)],
    `float w = 1.0 - abs(p * 2.0 - 1.0); vec2 t2 = p_blur * w / u_res; vec4 sa = vec4(0.0), sb = vec4(0.0);
     for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) { vec2 o = vec2(float(x), float(y)) * t2 * 0.5; sa += texture(u_from, clamp(uv + o, 0.0, 1.0)); sb += texture(u_to, clamp(uv + o, 0.0, 1.0)); }
     outColor = mix(sa / 25.0, sb / 25.0, p);`,
  ),
  t(
    'wipe',
    'Wipe',
    'Wipe',
    'Hard-edged directional wipe with optional feather and border.',
    [sel('direction', 'Direction', 0, dirOptions), num('feather', 'Feather', 0, 0, 0.5, 0.005), num('border', 'Border Width', 0, 0, 0.05, 0.001), col('borderColor', 'Border Color', [1, 1, 1, 1])],
    `float x = dirCoord(uv, p_direction); float e = p * (1.0 + p_feather * 2.0) - p_feather; float m = smoothstep(e - p_feather, e + p_feather + 0.0001, x);
     outColor = mix(B, A, m); float bd = 1.0 - smoothstep(0.0, p_border + 0.0001, abs(x - e)); if (p_border > 0.0 && p > 0.0 && p < 1.0) outColor = mix(outColor, vec4(p_borderColor.rgb, 1.0), bd);`,
  ),
  t(
    'barnDoors',
    'Barn Doors',
    'Wipe',
    'Open from the center outwards.',
    [bool('vertical', 'Vertical', false), num('feather', 'Feather', 0.01, 0, 0.3, 0.005)],
    `float x = p_vertical > 0.5 ? abs(uv.y - 0.5) : abs(uv.x - 0.5); float e = p * 0.5; float m = smoothstep(e - p_feather, e + p_feather + 0.0001, x); outColor = mix(B, A, m);`,
  ),
  t(
    'clockWipe',
    'Clock Wipe',
    'Wipe',
    'Radial sweep around the center.',
    [num('feather', 'Feather', 0.01, 0, 0.2, 0.005), bool('clockwise', 'Clockwise', true)],
    `vec2 q = uv - 0.5; q.x *= u_res.x / u_res.y; float a = atan(q.x, -q.y); a = (a + 3.14159265) / 6.2831853; if (p_clockwise < 0.5) a = 1.0 - a; float m = smoothstep(p - p_feather, p + p_feather + 0.0001, a); outColor = mix(B, A, m);`,
  ),
  t(
    'venetianBlinds',
    'Venetian Blinds',
    'Wipe',
    'Strips reveal the incoming clip.',
    [num('count', 'Blinds', 8, 1, 64, 1), bool('vertical', 'Vertical', false)],
    `float x = fract((p_vertical > 0.5 ? uv.x : uv.y) * p_count); outColor = x < p ? B : A;`,
  ),
  t(
    'checkerWipe',
    'Checker Wipe',
    'Wipe',
    'Alternating checker cells flip over time.',
    [num('cells', 'Cells', 8, 2, 40, 1)],
    `vec2 g = floor(uv * vec2(p_cells, p_cells * u_res.y / u_res.x)); float k = mod(g.x + g.y, 2.0); float local = fract(uv.x * p_cells); float th = k > 0.5 ? p * 2.0 : p * 2.0 - 1.0; outColor = local < th ? B : A;`,
  ),
  t(
    'radialWipe',
    'Radial Wipe',
    'Wipe',
    'Circle grows from the center.',
    [num('feather', 'Feather', 0.02, 0, 0.3, 0.005), num('cx', 'Center X', 0.5, 0, 1, 0.01), num('cy', 'Center Y', 0.5, 0, 1, 0.01)],
    `vec2 q = uv - vec2(p_cx, p_cy); q.x *= u_res.x / u_res.y; float d = length(q) / 1.2; float m = smoothstep(p - p_feather, p + p_feather + 0.0001, d); outColor = mix(B, A, m);`,
  ),
  t(
    'irisBox',
    'Iris Box',
    'Iris',
    'Rectangle grows from center.',
    [num('feather', 'Feather', 0.01, 0, 0.3, 0.005)],
    `vec2 q = abs(uv - 0.5) * 2.0; float d = max(q.x, q.y); float m = smoothstep(p - p_feather, p + p_feather + 0.0001, d); outColor = mix(B, A, m);`,
  ),
  t(
    'irisDiamond',
    'Iris Diamond',
    'Iris',
    'Diamond grows from center.',
    [num('feather', 'Feather', 0.01, 0, 0.3, 0.005)],
    `vec2 q = abs(uv - 0.5) * 2.0; float d = (q.x + q.y) * 0.5; float m = smoothstep(p - p_feather, p + p_feather + 0.0001, d); outColor = mix(B, A, m);`,
  ),
  t(
    'irisCross',
    'Iris Cross',
    'Iris',
    'Cross shape opens.',
    [num('thickness', 'Arm Ratio', 0.3, 0.05, 1, 0.01)],
    `vec2 q = abs(uv - 0.5) * 2.0; float inside = (q.x < p && q.y < p * p_thickness) || (q.y < p && q.x < p * p_thickness) ? 1.0 : 0.0; outColor = mix(A, B, inside);`,
  ),
  t(
    'push',
    'Push',
    'Slide',
    'Incoming clip pushes the outgoing one out.',
    [sel('direction', 'Direction', 0, dirOptions)],
    `vec2 d = dirVec(p_direction); vec2 ua = uv - d * p; vec2 ub = uv - d * p + d; bool inA = ua.x >= 0.0 && ua.x <= 1.0 && ua.y >= 0.0 && ua.y <= 1.0; outColor = inA ? texture(u_from, ua) : texture(u_to, clamp(ub, 0.0, 1.0));`,
  ),
  t(
    'slide',
    'Slide',
    'Slide',
    'Incoming clip slides over the outgoing one.',
    [sel('direction', 'Direction', 0, dirOptions)],
    `vec2 d = dirVec(p_direction); vec2 ub = uv + d * (1.0 - p) * -1.0; ub = uv - d * (1.0 - p); bool inB = ub.x >= 0.0 && ub.x <= 1.0 && ub.y >= 0.0 && ub.y <= 1.0; outColor = inB ? texture(u_to, ub) : A;`,
  ),
  t(
    'slideOut',
    'Slide Out',
    'Slide',
    'Outgoing clip slides away revealing the incoming one.',
    [sel('direction', 'Direction', 0, dirOptions)],
    `vec2 d = dirVec(p_direction); vec2 ua = uv - d * p; bool inA = ua.x >= 0.0 && ua.x <= 1.0 && ua.y >= 0.0 && ua.y <= 1.0; outColor = inA ? texture(u_from, ua) : B;`,
  ),
  t(
    'split',
    'Split',
    'Slide',
    'Outgoing clip splits and slides apart.',
    [bool('vertical', 'Vertical', false)],
    `float c2 = p_vertical > 0.5 ? uv.y : uv.x; float side = c2 < 0.5 ? -1.0 : 1.0; vec2 off = (p_vertical > 0.5 ? vec2(0.0, 1.0) : vec2(1.0, 0.0)) * side * p * 0.5; vec2 ua = uv - off; bool inA = (p_vertical > 0.5 ? (ua.y >= 0.0 && ua.y <= 1.0 && ((c2 < 0.5 && ua.y < 0.5) || (c2 >= 0.5 && ua.y >= 0.5))) : (ua.x >= 0.0 && ua.x <= 1.0 && ((c2 < 0.5 && ua.x < 0.5) || (c2 >= 0.5 && ua.x >= 0.5)))); outColor = inA ? texture(u_from, ua) : B;`,
  ),
  t(
    'whipPan',
    'Whip Pan',
    'Slide',
    'Fast directional motion blur transition.',
    [sel('direction', 'Direction', 0, dirOptions), num('blur', 'Blur Amount', 0.3, 0, 1, 0.01)],
    `vec2 d = dirVec(p_direction); float e = p < 0.5 ? 2.0 * p * p : 1.0 - pow(-2.0 * p + 2.0, 2.0) / 2.0; float w = 1.0 - abs(p * 2.0 - 1.0);
     vec4 acc = vec4(0.0); const int N = 16;
     for (int i = 0; i < N; i++) { float s = (float(i) / float(N - 1) - 0.5) * p_blur * w; vec2 ua = uv - d * (e + s); vec2 ub = ua + d;
       if (ua.x >= 0.0 && ua.x <= 1.0 && ua.y >= 0.0 && ua.y <= 1.0) acc += texture(u_from, ua); else acc += texture(u_to, clamp(ub, 0.0, 1.0)); }
     outColor = acc / float(N);`,
  ),
  t(
    'zoomIn',
    'Zoom In',
    'Zoom',
    'Outgoing clip scales up and fades into the incoming one.',
    [num('amount', 'Zoom Amount', 2, 1.1, 6, 0.05)],
    `float e = p * p; vec2 ua = (uv - 0.5) / mix(1.0, p_amount, e) + 0.5; vec4 a = texture(u_from, ua); outColor = mix(a, B, smoothstep(0.3, 1.0, p));`,
  ),
  t(
    'zoomOut',
    'Zoom Out',
    'Zoom',
    'Incoming clip scales down from large.',
    [num('amount', 'Zoom Amount', 2, 1.1, 6, 0.05)],
    `float e = 1.0 - (1.0 - p) * (1.0 - p); vec2 ub = (uv - 0.5) / mix(p_amount, 1.0, e) + 0.5; vec4 b = texture(u_to, ub); outColor = mix(A, b, smoothstep(0.0, 0.7, p));`,
  ),
  t(
    'crossZoom',
    'Cross Zoom',
    'Zoom',
    'Zoom blur through the cut.',
    [num('strength', 'Strength', 0.4, 0, 1, 0.01)],
    `float w = 1.0 - abs(p * 2.0 - 1.0); float s = p_strength * w; vec4 acc = vec4(0.0); const int N = 12;
     for (int i = 0; i < N; i++) { float k = 1.0 + s * float(i) / float(N); vec2 q = (uv - 0.5) / k + 0.5; acc += mix(texture(u_from, q), texture(u_to, q), p); }
     outColor = acc / float(N);`,
  ),
  t(
    'spin',
    'Spin',
    'Zoom',
    'Outgoing clip spins and shrinks away.',
    [num('turns', 'Turns', 1, 0.25, 4, 0.25)],
    `float e = p * p * (3.0 - 2.0 * p); float ang = e * 6.2831853 * p_turns; float sc = max(1.0 - e, 0.0001); vec2 q = uv - 0.5; q.x *= u_res.x / u_res.y; float cs = cos(ang), sn = sin(ang); q = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs) / sc; q.x /= u_res.x / u_res.y; q += 0.5;
     bool inA = q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0; outColor = inA ? texture(u_from, q) : B;`,
  ),
  t(
    'cube',
    'Cube Spin',
    '3D Motion',
    'Clips rotate as faces of a cube.',
    [bool('vertical', 'Vertical', false), num('perspective', 'Perspective', 0.5, 0, 1, 0.01)],
    `float e = p * p * (3.0 - 2.0 * p); float persp = p_perspective; float ang = e * 1.5707963;
     float c2 = cos(ang), s2 = sin(ang);
     // Face A rotates away, face B rotates in. Project x.
     vec2 uvA = uv; vec2 uvB = uv;
     float x = p_vertical > 0.5 ? uv.y : uv.x;
     // face A occupies [0, c2] after rotation, B occupies [c2, 1]
     float wA = c2; float wB = s2;
     bool onA = x < wA / (wA + wB);
     float total = wA + wB;
     if (onA) { float lx = x / (wA / total); float depth = mix(1.0, 1.0 - persp * 0.5, lx * s2); vec2 q = uv; if (p_vertical > 0.5) q.y = lx; else q.x = lx; q = (q - 0.5) / depth + 0.5; if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) outColor = vec4(0.0); else outColor = texture(u_from, q) * mix(1.0, 0.6, e); }
     else { float lx = (x - wA / total) / (wB / total); float depth = mix(1.0 - persp * 0.5, 1.0, lx); vec2 q = uv; if (p_vertical > 0.5) q.y = lx; else q.x = lx; q = (q - 0.5) / mix(depth, 1.0, e) + 0.5; if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) outColor = vec4(0.0); else outColor = texture(u_to, q) * mix(0.6, 1.0, e); }`,
  ),
  t(
    'flipOver',
    'Flip Over',
    '3D Motion',
    'Card flip around the vertical axis.',
    [bool('vertical', 'Vertical', false)],
    `float e = p * p * (3.0 - 2.0 * p); float ang = e * 3.14159265; float sc = abs(cos(ang)); bool front = ang < 1.5707963;
     vec2 q = uv - 0.5; if (p_vertical > 0.5) q.y /= max(sc, 0.001); else q.x /= max(sc, 0.001); q += 0.5;
     bool inside = q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0;
     if (!inside) { outColor = vec4(0.0); return; }
     if (front) outColor = texture(u_from, q) * mix(1.0, 0.7, e); else { if (p_vertical > 0.5) q.y = 1.0 - q.y; else q.x = 1.0 - q.x; outColor = texture(u_to, q) * mix(0.7, 1.0, e); }`,
  ),
  t(
    'pagePeel',
    'Page Peel',
    'Page Peel',
    'Corner peels away like a page.',
    [num('radius', 'Curl Radius', 0.12, 0.02, 0.4, 0.005)],
    `vec2 q = uv; float pr = p * 1.6; vec2 dir = normalize(vec2(1.0, 1.0)); float d = dot(q, dir) - pr * 1.4142 + 0.2; float r = p_radius;
     if (d > 0.0) { outColor = B; }
     else if (d > -r * 3.14159) { float th = -d / r; vec2 back = q - dir * (sin(th) * r * 2.0); vec4 bc = texture(u_from, clamp(back, 0.0, 1.0)); float shade = 0.7 + 0.3 * cos(th); outColor = mix(B, vec4(vec3(0.85) * shade, 1.0), 1.0); if (th > 3.14159 * 0.5) outColor = vec4(vec3(0.9) * shade, 1.0); }
     else { float sh = 1.0 - smoothstep(-r * 3.4, -r * 3.14159, d) * 0.4; outColor = A * vec4(vec3(sh), 1.0); }`,
  ),
  t(
    'lumaFade',
    'Luma Fade',
    'Stylize',
    'Dissolve driven by the brightness of the outgoing frame.',
    [num('softness', 'Softness', 0.2, 0.01, 1, 0.01), bool('invert', 'Invert', false)],
    `float l = luma(A.rgb); if (p_invert > 0.5) l = 1.0 - l; float th = p * (1.0 + p_softness) - p_softness; float m = smoothstep(th, th + p_softness, l); outColor = mix(B, A, m);`,
  ),
  t(
    'glitch',
    'Glitch',
    'Stylize',
    'Digital tearing and channel splits through the cut.',
    [num('intensity', 'Intensity', 0.6, 0, 1, 0.01)],
    `float w = 1.0 - abs(p * 2.0 - 1.0); float row = floor(uv.y * 40.0); float n = hash12(vec2(row, floor(u_progress * 30.0))); float shift = (n - 0.5) * 0.3 * w * p_intensity * step(0.6, n);
     vec2 q = vec2(uv.x + shift, uv.y); vec4 src = mix(texture(u_from, clamp(q, 0.0, 1.0)), texture(u_to, clamp(q, 0.0, 1.0)), step(hash12(vec2(row, 7.0)), p));
     float ca = 0.02 * w * p_intensity; src.r = mix(texture(u_from, clamp(q + vec2(ca, 0.0), 0.0, 1.0)), texture(u_to, clamp(q + vec2(ca, 0.0), 0.0, 1.0)), p).r; src.b = mix(texture(u_from, clamp(q - vec2(ca, 0.0), 0.0, 1.0)), texture(u_to, clamp(q - vec2(ca, 0.0), 0.0, 1.0)), p).b;
     outColor = src;`,
  ),
  t(
    'pixelate',
    'Pixelate',
    'Stylize',
    'Mosaic in, mosaic out.',
    [num('maxBlocks', 'Max Block Size', 48, 4, 200, 1)],
    `float w = 1.0 - abs(p * 2.0 - 1.0); float bs = max(1.0, p_maxBlocks * w); vec2 cell = (floor(uv * u_res / bs) + 0.5) * bs / u_res; outColor = mix(texture(u_from, cell), texture(u_to, cell), p);`,
  ),
  t(
    'lightLeak',
    'Light Leak',
    'Stylize',
    'Warm flare washes through the cut.',
    [col('color', 'Leak Color', [1, 0.7, 0.4, 1])],
    `float w = sin(p * 3.14159); vec2 q = uv - vec2(0.8, 0.3); float f = exp(-dot(q, q) * 3.0) * w * 1.5; vec4 base = mix(A, B, smoothstep(0.35, 0.65, p)); outColor = vec4(base.rgb + p_color.rgb * f, max(base.a, f));`,
  ),
  t(
    'colorWash',
    'Flash',
    'Stylize',
    'Quick white flash at the cut.',
    [col('color', 'Flash Color', [1, 1, 1, 1])],
    `float k = p < 0.5 ? p * 2.0 : 2.0 - p * 2.0; k = pow(k, 0.5); vec4 src = p < 0.5 ? A : B; outColor = mix(src, vec4(p_color.rgb, 1.0), k);`,
  ),
  t(
    'bandSlide',
    'Band Slide',
    'Slide',
    'Alternating bands slide in from both sides.',
    [num('bands', 'Bands', 7, 1, 40, 1)],
    `float band = floor(uv.y * p_bands); float dir = mod(band, 2.0) == 0.0 ? 1.0 : -1.0; float x = uv.x - dir * (1.0 - p); bool inB = x >= 0.0 && x <= 1.0; outColor = inB ? texture(u_to, vec2(x, uv.y)) : A;`,
  ),
  t(
    'swirl',
    'Swirl',
    'Stylize',
    'Twist the image through the cut.',
    [num('strength', 'Strength', 3, 0.5, 10, 0.1)],
    `float w = 1.0 - abs(p * 2.0 - 1.0); vec2 q = uv - 0.5; q.x *= u_res.x / u_res.y; float r = length(q); float a = atan(q.y, q.x) + w * p_strength * (1.0 - r); q = vec2(cos(a), sin(a)) * r; q.x /= u_res.x / u_res.y; q += 0.5; outColor = mix(texture(u_from, clamp(q, 0.0, 1.0)), texture(u_to, clamp(q, 0.0, 1.0)), p);`,
  ),
];

export const AUDIO_TRANSITIONS: TransitionDef[] = [
  { type: 'constantPower', name: 'Constant Power', category: 'Audio', description: 'Equal-power crossfade.', params: [], frag: '', audio: true },
  { type: 'constantGain', name: 'Constant Gain', category: 'Audio', description: 'Linear crossfade.', params: [], frag: '', audio: true },
  { type: 'exponentialFade', name: 'Exponential Fade', category: 'Audio', description: 'Logarithmic curve crossfade.', params: [], frag: '', audio: true },
];

export const TRANSITION_MAP: Record<string, TransitionDef> = Object.fromEntries([...TRANSITIONS, ...AUDIO_TRANSITIONS].map((t) => [t.type, t]));

export const TRANSITION_GLSL_PRELUDE = dirVec;

export function audioFadeGain(type: string, progress: number, incoming: boolean): number {
  const p = Math.min(1, Math.max(0, progress));
  switch (type) {
    case 'constantGain':
      return incoming ? p : 1 - p;
    case 'exponentialFade':
      return incoming ? p * p : (1 - p) * (1 - p);
    default:
      return incoming ? Math.sin((p * Math.PI) / 2) : Math.cos((p * Math.PI) / 2);
  }
}
