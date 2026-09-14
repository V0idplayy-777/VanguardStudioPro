/*
  Static validation of every GLSL source the compositor can compile.

  Shader errors are the worst class of bug in this codebase: the compositor
  catches a failed compile, records the program key in `badPrograms` and carries
  on, so a typo silently turns an effect into a no-op with nothing in the UI to
  say why. Two real ones shipped this way (`vec3 out` and `vec2 half` - both
  reserved words in GLSL ES 3.00) and were only found by reading the spec.

  There is no GL context under `node`, so this cannot link a program. What it can
  do is catch everything that does not depend on the driver: reserved-word
  identifiers, undeclared or duplicated uniforms, `p_*` uniforms referenced with
  no matching parameter (which compiles fine and reads as 0), a `#version`
  directive that is not on the first line, unbalanced delimiters, and ES 1.00
  builtins that were removed in ES 3.00.

  Run with: npm run test:shaders
*/
import { buildEffectFrag, buildTransitionFrag, MOTION_FRAG, BLEND_FRAG, MASK_FRAG, MASK_MIX_FRAG, SHAPE_MASK_FRAG, COPY_FRAG, PRESENT_FRAG, FLOW_FRAG, LERP_FRAG, SOLID_FRAG, BARS_FRAG } from '../src/engine/gl/shaders';
import { EFFECTS, GLSL_COMMON } from '../src/engine/effects/registry';
import { TRANSITIONS } from '../src/engine/effects/transitions';

let failures = 0;
let checks = 0;
const failList: string[] = [];

function fail(name: string, detail: string) {
  failures++;
  checks++;
  failList.push(`FAIL  ${name}: ${detail}`);
}
function pass(name: string) {
  checks++;
  void name;
}

/*
  Reserved words, GLSL ES 3.00 spec section 3.9. These may never be used as
  identifiers. `out`/`in`/`uniform` and friends are keywords; the rest are
  reserved for future use but are equally illegal as names.
*/
const RESERVED = new Set(
  (`common partition active asm class union enum typedef template this packed resource ` +
    `goto inline noinline public static extern external interface long short half fixed unsigned ` +
    `input output hvec2 hvec3 hvec4 dvec2 dvec3 dvec4 fvec2 fvec3 fvec4 ` +
    `sampler1D sampler3DRect filter image1D image3DRect sizeof cast namespace using ` +
    `attribute varying superp sampler2DRect sampler1DShadow sampler2DRectShadow`).split(/\s+/),
);

/** Types a declaration could start with, used to spot `<type> <reserved> =`. */
const TYPES = `(?:float|int|bool|uint|vec2|vec3|vec4|ivec2|ivec3|ivec4|bvec2|bvec3|bvec4|mat2|mat3|mat4|mat2x2|mat3x3|mat4x4)`;

interface Target {
  name: string;
  src: string;
  /** Parameter keys this source is allowed to reference as p_<key>. */
  params?: string[];
}

const targets: Target[] = [];

// Fixed pipeline shaders.
for (const [name, src] of Object.entries({ MOTION_FRAG, BLEND_FRAG, MASK_FRAG, MASK_MIX_FRAG, SHAPE_MASK_FRAG, COPY_FRAG, PRESENT_FRAG, FLOW_FRAG, LERP_FRAG, SOLID_FRAG, BARS_FRAG })) {
  targets.push({ name, src });
}

// Every pass of every video effect, built exactly as the compositor builds it.
for (const def of EFFECTS) {
  if (def.audio) continue;
  def.passes.forEach((_p, i) => {
    targets.push({
      name: `effect ${def.type} pass ${i}`,
      src: buildEffectFrag(def, i),
      params: def.params.map((pd) => pd.key),
    });
  });
}

for (const def of TRANSITIONS) {
  targets.push({ name: `transition ${def.type}`, src: buildTransitionFrag(def), params: def.params.map((pd) => pd.key) });
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

for (const t of targets) {
  const raw = t.src;
  const src = stripComments(raw);

  // 1. #version must be the first token in the file. Anything before it - even a
  //    newline introduced by a template literal - is a compile error on every
  //    driver, and it is easy to introduce when concatenating shader fragments.
  if (!/^#version\s+300\s+es\s*\n/.test(raw)) {
    fail(t.name, `#version 300 es is not the first line (starts with ${JSON.stringify(raw.slice(0, 24))})`);
  } else pass(t.name);

  // 2. Reserved words used as identifiers.
  const reservedHits = new Set<string>();
  for (const m of src.matchAll(new RegExp(`\\b${TYPES}\\s+(${[...RESERVED].join('|')})\\b`, 'g'))) reservedHits.add(m[1]);
  // Also catch assignment to a bare reserved name (`out = ...`).
  for (const m of src.matchAll(new RegExp(`(?:^|[;{}\\n])\\s*(${[...RESERVED].join('|')})\\s*=[^=]`, 'gm'))) reservedHits.add(m[1]);
  if (reservedHits.size) fail(t.name, `reserved word(s) used as identifier: ${[...reservedHits].join(', ')}`);
  else pass(t.name);

  // 3. Balanced delimiters. An unbalanced brace usually means a template literal
  //    was edited mid-block.
  for (const [open, close, label] of [['{', '}', 'braces'], ['(', ')', 'parens'], ['[', ']', 'brackets']] as const) {
    let depth = 0;
    for (const ch of src) {
      if (ch === open) depth++;
      else if (ch === close) depth--;
      if (depth < 0) break;
    }
    if (depth !== 0) fail(t.name, `unbalanced ${label} (net ${depth})`);
    else pass(t.name);
  }

  // 4. Exactly one outColor declaration and one main().
  const outDecls = (src.match(/\bout\s+vec4\s+outColor\s*;/g) ?? []).length;
  if (outDecls !== 1) fail(t.name, `expected exactly one 'out vec4 outColor;', found ${outDecls}`);
  else pass(t.name);
  const mains = (src.match(/\bvoid\s+main\s*\(\s*\)\s*\{/g) ?? []).length;
  if (mains !== 1) fail(t.name, `expected exactly one main(), found ${mains}`);
  else pass(t.name);

  // 5. ES 1.00 builtins that no longer exist in ES 3.00.
  for (const banned of ['gl_FragColor', 'texture2D', 'textureCube', 'texture2DProj', 'varying ', 'attribute ']) {
    if (src.includes(banned)) fail(t.name, `uses ES 1.00 builtin '${banned.trim()}' which does not exist in #version 300 es`);
    else pass(t.name);
  }

  // 6. Every u_* referenced must be declared. An undeclared uniform is a hard
  //    compile error.
  const declared = new Set<string>();
  for (const m of src.matchAll(/\buniform\s+(?:lowp\s+|mediump\s+|highp\s+)?(?:\w+)\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/g)) declared.add(m[1]);
  const usedU = new Set<string>();
  for (const m of src.matchAll(/\b(u_\w+)\b/g)) usedU.add(m[1]);
  const undeclared = [...usedU].filter((u) => !declared.has(u));
  if (undeclared.length) fail(t.name, `uniform(s) used but never declared: ${undeclared.join(', ')}`);
  else pass(t.name);

  // 7. No duplicate declarations of the same uniform - a redefinition error.
  const declNames: string[] = [];
  for (const m of src.matchAll(/\buniform\s+(?:lowp\s+|mediump\s+|highp\s+)?(?:\w+)\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/g)) declNames.push(m[1]);
  const dupes = declNames.filter((n, i) => declNames.indexOf(n) !== i);
  if (dupes.length) fail(t.name, `uniform(s) declared more than once: ${[...new Set(dupes)].join(', ')}`);
  else pass(t.name);

  // 8. Every p_* referenced must have a parameter in the effect definition.
  //    This one compiles happily and silently reads 0, so the effect renders
  //    wrong with no error anywhere - the nastiest failure mode in the file.
  if (t.params) {
    const usedP = new Set<string>();
    for (const m of src.matchAll(/\bp_(\w+)\b/g)) usedP.add(m[1]);
    const unknown = [...usedP].filter((k) => !t.params!.includes(k));
    if (unknown.length) fail(t.name, `p_* uniform(s) with no matching parameter (would silently read 0): ${unknown.map((u) => 'p_' + u).join(', ')}`);
    else pass(t.name);
  }

  // 9. Helpers from GLSL_COMMON must not be redeclared in the body, and must be
  //    present when used by an effect.
  if (t.params) {
    // buildEffectFrag / buildTransitionFrag splice GLSL_COMMON in, which declares
    // each helper exactly once. A second declaration anywhere in the assembled
    // source is a redefinition error - typically a helper copy-pasted into an
    // effect body.
    for (const fn of ['luma', 'hash12', 'noise2', 'fbm', 'rgb2hsv', 'hsv2rgb', 'srgb2lin', 'lin2srgb', 'sampleClamped', 'sampleEdge']) {
      const decls = (src.match(new RegExp(`\\b(?:float|vec2|vec3|vec4)\\s+${fn}\\s*\\(`, 'g')) ?? []).length;
      if (decls > 1) fail(t.name, `GLSL_COMMON helper '${fn}' is declared ${decls} times`);
      else pass(t.name);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Registry-level invariants
 * ------------------------------------------------------------------ */

{
  const types = EFFECTS.map((e) => e.type);
  const dupes = types.filter((t, i) => types.indexOf(t) !== i);
  if (dupes.length) fail('registry', `duplicate effect type ids: ${[...new Set(dupes)].join(', ')}`);
  else pass('registry');

  // Duplicate effect ids mean the second definition silently wins in EFFECT_MAP.
  for (const def of EFFECTS) {
    if (def.audio) continue;
    const keys = def.params.map((p) => p.key);
    const dupKeys = keys.filter((k, i) => keys.indexOf(k) !== i);
    if (dupKeys.length) fail(`effect ${def.type}`, `duplicate parameter keys: ${[...new Set(dupKeys)].join(', ')}`);
    else pass(`effect ${def.type}`);
    if (!def.passes.length) fail(`effect ${def.type}`, 'has no passes, so it can never render');
    else pass(`effect ${def.type}`);
  }

  const tids = TRANSITIONS.map((t) => t.type);
  const tdupes = tids.filter((t, i) => tids.indexOf(t) !== i);
  if (tdupes.length) fail('transitions', `duplicate transition ids: ${[...new Set(tdupes)].join(', ')}`);
  else pass('transitions');
}

console.log(`Validated ${targets.length} shader sources (${EFFECTS.filter((e) => !e.audio).length} effects, ${TRANSITIONS.length} transitions).`);
if (failures) {
  console.log('');
  for (const f of failList) console.log(f);
  console.log('');
  console.log(`${failures} of ${checks} shader checks FAILED.`);
  process.exitCode = 1;
} else {
  console.log(`All ${checks} shader checks passed.`);
}
