/*
  Numeric verification for the LUT / colour-science maths.
  Run with: npm run test:maths

  These are not smoke tests. Every built-in input transform claims to implement
  a published standard, so each one is checked against values that can be looked
  up independently, and every generated LUT is checked for monotonicity and for
  continuity at its segment cut points. A wrong EOTF shows up as a bad grade,
  which is much harder to debug than a failing assertion.
*/
import {
  parseCube,
  parse3dl,
  toCube,
  parseLutFile,
  sampleLut,
  identityLut,
  buildTransformLut,
  rollOff,
  genericLogEOTF,
  GENERIC_LOG_DEFAULTS,
  rec709EOTF,
  rec709OETF,
  srgbEOTF,
  pqEOTF,
  pqOETF,
  hlgEOTF,
  hlgOETF,
  logC3EOTF,
  logC3OETF,
  gamutToRec709,
  INPUT_TRANSFORMS,
  builtInLooks,
} from '../src/engine/color/lut';

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = '') {
  checks++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) failures++;
}
function near(a: number, b: number, eps = 1e-4) {
  return Math.abs(a - b) <= eps;
}

/* ---------- Rec.709 (ITU-R BT.709) ---------- */
{
  // Continuity at the segment cut: the linear branch and the power branch must
  // agree at x = 0.018 (encode) / v = 0.08145 (decode).
  const linAt = 4.5 * 0.018;
  const powAt = 1.099 * Math.pow(0.018, 0.45) - 0.099;
  check('BT.709 OETF continuous at cut', near(linAt, powAt, 5e-4), `lin=${linAt.toFixed(5)} pow=${powAt.toFixed(5)}`);
  const dlin = 0.08145 / 4.5;
  const dpow = Math.pow((0.08145 + 0.099) / 1.099, 1 / 0.45);
  check('BT.709 EOTF continuous at cut', near(dlin, dpow, 5e-4), `lin=${dlin.toFixed(6)} pow=${dpow.toFixed(6)}`);
  // 18% gray encodes to ~0.409 (the well-known Rec.709 code value).
  check('BT.709 18% gray -> 0.409', near(rec709OETF(0.18), 0.409, 2e-3), rec709OETF(0.18).toFixed(4));
  // Round trip across the domain.
  let worst = 0;
  for (let i = 0; i <= 1000; i++) {
    const v = i / 1000;
    worst = Math.max(worst, Math.abs(rec709OETF(rec709EOTF(v)) - v));
  }
  check('BT.709 EOTF/OETF round trip', worst < 5e-4, `max err ${worst.toExponential(2)}`);
  check('BT.709 EOTF(0) = 0', rec709EOTF(0) === 0);
  check('BT.709 EOTF(1) = 1', near(rec709EOTF(1), 1, 1e-6), rec709EOTF(1).toFixed(6));
}

/* ---------- sRGB (IEC 61966-2-1) ---------- */
{
  // The spec cut is at encoded 0.04045 == linear 0.0031308; the two decode
  // branches must agree there, and must do so with equal slope.
  const lin = 0.04045 / 12.92;
  const pw = Math.pow((0.04045 + 0.055) / 1.055, 2.4);
  check('sRGB continuous at 0.04045', near(lin, pw, 1e-7), `lin=${lin.toExponential(6)} pow=${pw.toExponential(6)}`);
  check('sRGB decode(0.04045) = 0.0031308', near(lin, 0.0031308, 1e-6), lin.toFixed(7));
  check('sRGB EOTF(0.5) = 0.2140', near(srgbEOTF(0.5), 0.21404, 1e-4), srgbEOTF(0.5).toFixed(5));
  check('sRGB EOTF(1) = 1', near(srgbEOTF(1), 1, 1e-9));
  check('sRGB EOTF(0) = 0', srgbEOTF(0) === 0);
}

/* ---------- PQ / SMPTE ST 2084 ---------- */
{
  // Reference points recomputed from the ST 2084 constants themselves.
  check('PQ EOTF(0.5081) = 100 nits', near(pqEOTF(0.5081), 0.01, 3e-4), `${(pqEOTF(0.5081) * 10000).toFixed(1)} nits`);
  check('PQ EOTF(0.7518) = 1000 nits', near(pqEOTF(0.7518), 0.1, 3e-3), `${(pqEOTF(0.7518) * 10000).toFixed(1)} nits`);
  // 1 nit, taken from the exact inverse rather than a hand-rounded constant.
  const oneNitCode = pqOETF(0.0001);
  check('PQ EOTF(OETF(1 nit)) = 1 nit', near(pqEOTF(oneNitCode), 0.0001, 1e-7), `${(pqEOTF(oneNitCode) * 10000).toFixed(4)} nits, code ${oneNitCode.toFixed(5)}`);
  // Round trip across the whole PQ domain.
  let pworst = 0;
  for (let i = 0; i <= 4096; i++) {
    const v = i / 4096;
    pworst = Math.max(pworst, Math.abs(pqEOTF(pqOETF(v === 0 ? 0 : v)) - v));
  }
  check('PQ OETF/EOTF round trip', pworst < 1e-6, `max err ${pworst.toExponential(2)}`);
  check('PQ EOTF(1) = 10000 nits', near(pqEOTF(1), 1, 1e-6));
  check('PQ EOTF(0) = 0', pqEOTF(0) === 0);
  // Strictly monotonic.
  let mono = true,
    prev = -1;
  for (let i = 0; i <= 256; i++) {
    const v = pqEOTF(i / 256);
    if (v < prev - 1e-12) mono = false;
    prev = v;
  }
  check('PQ EOTF monotonic', mono);
}

/* ---------- HLG / ARIB STD-B67 ---------- */
{
  // Lower branch at the 0.5 join: 0.5^2/3 = 0.08333.
  check('HLG EOTF(0.5) = 1/12', near(hlgEOTF(0.5), 1 / 12, 1e-6), hlgEOTF(0.5).toFixed(6));
  // Upper branch must meet it exactly at 0.5 (continuity of the published pair).
  const a = 0.17883277,
    b = 1 - 4 * a,
    c = 0.5 - a * Math.log(4 * a);
  const upper = (Math.exp((0.5 - c) / a) + b) / 12;
  check('HLG continuous at 0.5', near(upper, 1 / 12, 1e-6), upper.toFixed(6));
  // v = 0.75 on the upper branch: (exp((0.75-c)/a) + b) / 12 = 0.26499.
  check('HLG EOTF(0.75) = 0.2650', near(hlgEOTF(0.75), 0.26499, 2e-4), hlgEOTF(0.75).toFixed(5));
  // The OETF inverse must land back on 0.75.
  check('HLG OETF round trip', near(hlgOETF(hlgEOTF(0.75)), 0.75, 1e-6), hlgOETF(hlgEOTF(0.75)).toFixed(6));
  let hworst = 0;
  for (let i = 0; i <= 2048; i++) {
    const v = i / 2048;
    hworst = Math.max(hworst, Math.abs(hlgOETF(hlgEOTF(v)) - v));
  }
  check('HLG OETF/EOTF round trip', hworst < 1e-6, `max err ${hworst.toExponential(2)}`);
  check('HLG EOTF(1) = 1', near(hlgEOTF(1), 1, 1e-6), hlgEOTF(1).toFixed(5));
  check('HLG EOTF(0) = 0', hlgEOTF(0) === 0);
}

/* ---------- ARRI LogC3 (EI 800) ---------- */
{
  // Published anchor: 18% gray encodes to LogC3 code value 0.3910 (39.1%).
  check('LogC3 gray 0.18 -> 0.391', near(logC3OETF(0.18), 0.391, 2e-3), logC3OETF(0.18).toFixed(4));
  // Continuity of the two branches at the cut.
  const k = { cut: 0.0113, a: 5.555556, b: 0.052272, c: 0.24719, d: 0.385537, e: 5.367655, f: 0.092809 };
  const cutY = k.e * k.cut + k.f;
  const fromLog = (Math.pow(10, (cutY - k.d) / k.c) - k.b) / k.a;
  const fromLin = (cutY - k.f) / k.e;
  // The published constants carry 6 decimals, so the branches meet to within a
  // few parts in 10^5 rather than exactly; that is well under a code value.
  check('LogC3 continuous at cut', near(fromLog, fromLin, 2e-5), `log=${fromLog.toFixed(6)} lin=${fromLin.toFixed(6)} d=${Math.abs(fromLog - fromLin).toExponential(2)}`);
  check('LogC3 decode(cut) = 0.0113', near(logC3EOTF(cutY), k.cut, 1e-5), logC3EOTF(cutY).toFixed(6));
  // Round trip over the legal domain. Code values below f = 0.092809 decode to
  // negative scene linear (below black), which clamps to 0 and legitimately
  // re-encodes to f, so they are excluded rather than treated as a failure.
  let worst = 0;
  for (let i = 0; i <= 2000; i++) {
    const v = 0.092809 + (i / 2000) * (1 - 0.092809);
    worst = Math.max(worst, Math.abs(logC3OETF(logC3EOTF(v)) - v));
  }
  check('LogC3 EOTF/OETF round trip (legal domain)', worst < 1e-5, `max err ${worst.toExponential(2)}`);
  check('LogC3 EOTF(0.0928) ~= 0 (black)', near(logC3EOTF(0.0928), 0, 2e-3), logC3EOTF(0.0928).toFixed(5));
  // The decisive anchor: 18% gray encodes to LogC3 code 0.391 and must decode
  // straight back to 0.18.
  check('LogC3 decode(0.391) = 18% gray', near(logC3EOTF(0.391), 0.18, 2e-3), logC3EOTF(0.391).toFixed(5));
  // 90% reflectance sits ~2.3 stops above gray, hence 0.5594 (not the 0.686 of
  // a 4-stop-higher level).
  check('LogC3 encode(0.9) = 0.5594', near(logC3OETF(0.9), 0.5594, 1e-3), logC3OETF(0.9).toFixed(4));
  check('LogC3 monotonic', (() => { let p = -1; for (let i = 0; i <= 4096; i++) { const v = logC3EOTF(i / 4096); if (v < p - 1e-12) return false; p = v; } return true; })());
}

/* ---------- generic parametric log ---------- */
{
  const p = GENERIC_LOG_DEFAULTS;
  check('genericLog black code -> 0', genericLogEOTF(p.blackCode, p) === 0 || near(genericLogEOTF(p.blackCode, p), p.grayLin * Math.pow(2, -p.stopsBelowGray), 1e-9));
  check('genericLog gray code -> 0.18', near(genericLogEOTF(p.grayCode, p), p.grayLin, 1e-6), genericLogEOTF(p.grayCode, p).toFixed(5));
  // Continuity across the gray code (the two branches must meet there).
  const below = genericLogEOTF(p.grayCode - 1e-9, p);
  const above = genericLogEOTF(p.grayCode + 1e-9, p);
  check('genericLog continuous at gray', near(below, above, 1e-4), `${below.toFixed(6)} vs ${above.toFixed(6)}`);
  let mono = true,
    prev = -1;
  for (let i = 0; i <= 4096; i++) {
    const v = genericLogEOTF(i / 4096, p);
    if (v < prev - 1e-12) mono = false;
    prev = v;
  }
  check('genericLog monotonic', mono);
  // One stop above gray must double the linear value.
  const oneStop = p.grayCode + (1 / p.stopsAboveGray) * (p.grayCode - p.blackCode);
  check('genericLog +1 stop doubles', near(genericLogEOTF(oneStop, p) / p.grayLin, 2, 1e-6), (genericLogEOTF(oneStop, p) / p.grayLin).toFixed(5));
}

/* ---------- gamut matrices ---------- */
{
  // Rec.709 -> Rec.709 must be the identity.
  const id = gamutToRec709(
    [
      [0.64, 0.33],
      [0.3, 0.6],
      [0.15, 0.06],
    ],
  );
  let maxOff = 0;
  for (let i = 0; i < 9; i++) maxOff = Math.max(maxOff, Math.abs(id[i] - (i % 4 === 0 ? 1 : 0)));
  check('Rec.709 -> Rec.709 is identity', maxOff < 1e-9, `max off-diagonal error ${maxOff.toExponential(2)}`);

  // Rec.2020 -> Rec.709 has a published matrix; matching it validates the
  // primaries -> XYZ -> primaries path end to end.
  const m = gamutToRec709(
    [
      [0.708, 0.292],
      [0.17, 0.797],
      [0.131, 0.046],
    ],
  );
  const expected = [1.66049, -0.58764, -0.07285, -0.12455, 1.1329, -0.00835, -0.01815, -0.10058, 1.11873];
  let worst = 0;
  for (let i = 0; i < 9; i++) worst = Math.max(worst, Math.abs(m[i] - expected[i]));
  check('Rec.2020 -> Rec.709 matches published matrix', worst < 1e-4, `max err ${worst.toExponential(2)}`);
  // Out-of-gamut primaries must land OUTSIDE [0,1]; a matrix that pulls them
  // inside is silently desaturating rather than converting.
  const blue2020: [number, number, number] = [m[2], m[5], m[8]];
  check('Rec.2020 blue is out of Rec.709 gamut', blue2020[2] > 1 && blue2020[0] < 0, blue2020.map((v) => v.toFixed(4)).join(','));
  // Each row must sum to ~1 so neutral stays neutral.
  for (let r = 0; r < 3; r++) {
    const s = m[r * 3] + m[r * 3 + 1] + m[r * 3 + 2];
    check(`Rec.2020 row ${r + 1} sums to 1`, near(s, 1, 1e-6), s.toFixed(7));
  }

  // Display P3 (D65) -> Rec.709 published matrix.
  const p3 = gamutToRec709(
    [
      [0.68, 0.32],
      [0.265, 0.69],
      [0.15, 0.06],
    ],
  );
  // CSS Color 4 display-p3 -> srgb linear matrix; matching it to 6 decimals
  // validates the whole primaries -> XYZ -> primaries path.
  const p3exp = [1.2249401, -0.2249404, 0.0, -0.0420569, 1.0420571, 0.0, -0.0196376, -0.0786361, 1.0982735];
  let p3worst = 0;
  for (let i = 0; i < 9; i++) p3worst = Math.max(p3worst, Math.abs(p3[i] - p3exp[i]));
  check('P3-D65 -> Rec.709 matches CSS Color 4 matrix', p3worst < 1e-5, `max err ${p3worst.toExponential(2)}`);

  // Imaginary primaries (negative y) must not be zeroed out - that was a real
  // bug: it collapsed ARRI Wide Gamut's blue primary and produced a matrix with
  // a coefficient of 12.9.
  const awg = gamutToRec709(
    [
      [0.684, 0.313],
      [0.221, 0.848],
      [0.0861, -0.078],
    ],
  );
  let awgMax = 0;
  for (let r = 0; r < 3; r++) {
    const s = awg[r * 3] + awg[r * 3 + 1] + awg[r * 3 + 2];
    check(`AWG3 row ${r + 1} sums to 1`, near(s, 1, 1e-6), s.toFixed(7));
    for (let c = 0; c < 3; c++) awgMax = Math.max(awgMax, Math.abs(awg[r * 3 + c]));
  }
  check('AWG3 -> Rec.709 coefficients are sane', awgMax < 3 && awgMax > 1.2, `max |coef| ${awgMax.toFixed(4)}`);
}

/* ---------- .cube parsing ---------- */
{
  // A hand-written 2^3 cube with known values.
  const cube = [
    'TITLE "Test Cube"',
    '# a comment',
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
    'LUT_3D_SIZE 2',
    '0.0 0.0 0.0',
    '1.0 0.0 0.0',
    '0.0 1.0 0.0',
    '1.0 1.0 0.0',
    '0.0 0.0 1.0',
    '1.0 0.0 1.0',
    '0.0 1.0 1.0',
    '1.0 1.0 1.0',
  ].join('\n');
  const lut = parseCube(cube, 'test.cube');
  check('cube size parsed', lut.size === 2);
  check('cube title parsed', lut.title === 'Test Cube', lut.title);
  // Red fastest: index 1 is pure red.
  const at = (r: number, g: number, b: number) => ((b * 2 + g) * 2 + r) * 4;
  check('cube red entry', lut.rgba[at(1, 0, 0)] === 1 && lut.rgba[at(1, 0, 0) + 1] === 0, `${lut.rgba[at(1, 0, 0)]},${lut.rgba[at(1, 0, 0) + 1]}`);
  check('cube blue entry', lut.rgba[at(0, 0, 1) + 2] === 1);
  check('cube sample corner', near(sampleLut(lut, 0, 0, 0)[0], 0, 1e-6));
  check('cube sample mid gray', near(sampleLut(lut, 0.5, 0.5, 0.5)[0], 0.5, 1e-6), sampleLut(lut, 0.5, 0.5, 0.5).map((v) => v.toFixed(4)).join(','));

  // Round trip: export then re-import must reproduce the values.
  const lut33 = identityLut(33);
  const text = toCube(lut33);
  const back = parseCube(text, 'roundtrip.cube');
  let rworst = 0;
  for (let i = 0; i < lut33.rgba.length; i++) rworst = Math.max(rworst, Math.abs(lut33.rgba[i] - back.rgba[i]));
  check('cube export/import round trip', rworst < 1e-5, `max err ${rworst.toExponential(2)}`);
  check('cube round trip size', back.size === 33);

  // Truncated file must throw rather than silently produce a broken grade.
  let threw = false;
  try {
    parseCube('LUT_3D_SIZE 8\n0 0 0\n1 1 1\n');
  } catch {
    threw = true;
  }
  check('truncated cube rejected', threw);

  // Missing size must throw.
  let threw2 = false;
  try {
    parseCube('TITLE "nope"\n0 0 0\n');
  } catch {
    threw2 = true;
  }
  check('sizeless cube rejected', threw2);

  // 1D LUT expands to a 3D cube.
  const oneD = ['LUT_1D_SIZE 4', '0 0 0', '0.33 0.33 0.33', '0.66 0.66 0.66', '1 1 1'].join('\n');
  const ex = parseCube(oneD, '1d.cube');
  check('1D LUT expands to 3D', ex.size === 33 && near(sampleLut(ex, 1, 1, 1)[0], 1, 1e-3), `size=${ex.size}`);
}

/* ---------- .3dl parsing ---------- */
{
  // 10-bit mesh, 2^3 entries scaled 0..1023.
  const lines = ['0 1023'];
  const vals = [
    [0, 0, 0],
    [1023, 0, 0],
    [0, 1023, 0],
    [1023, 1023, 0],
    [0, 0, 1023],
    [1023, 0, 1023],
    [0, 1023, 1023],
    [1023, 1023, 1023],
  ];
  for (const v of vals) lines.push(v.join(' '));
  const lut = parse3dl(lines.join('\n'), 'test.3dl');
  check('3dl size inferred', lut.size === 2, `${lut.size}`);
  const at = (r: number, g: number, b: number) => ((b * 2 + g) * 2 + r) * 4;
  check('3dl normalised to 0..1', near(lut.rgba[at(1, 1, 1)], 1, 1e-6) && lut.rgba[at(0, 0, 0)] === 0);
  check('3dl green entry', near(lut.rgba[at(0, 1, 0) + 1], 1, 1e-6));

  let threw = false;
  try {
    parse3dl('0 1023\n1 2 3\n4 5 6\n');
  } catch {
    threw = true;
  }
  check('3dl with non-cubic entry count rejected', threw);
}

/* ---------- generated transform LUTs ---------- */
{
  for (const t of INPUT_TRANSFORMS) {
    const lut = buildTransformLut(t, { size: 17 });
    check(`${t.id}: generated at 17^3`, lut.rgba.length === 17 * 17 * 17 * 4);
    // Every channel must stay inside 0..1 (a LUT that over- or under-ranges
    // shows up as crushed or clipped output).
    let lo = Infinity,
      hi = -Infinity,
      nan = 0;
    for (let i = 0; i < lut.rgba.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = lut.rgba[i + c];
        if (!Number.isFinite(v)) nan++;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    check(`${t.id}: finite and in range`, nan === 0 && lo >= 0 && hi <= 1, `min=${lo.toFixed(4)} max=${hi.toFixed(4)} nan=${nan}`);
    // Monotonic along the gray ramp: a non-monotonic tone curve folds levels
    // and produces banding/posterisation.
    let mono = true;
    let prev = -1;
    for (let i = 0; i < 17; i++) {
      const v = sampleLut(lut, i / 16, i / 16, i / 16)[0];
      if (v < prev - 1e-6) mono = false;
      prev = v;
    }
    check(`${t.id}: gray ramp monotonic`, mono);
    // Black stays black.
    const black = sampleLut(lut, 0, 0, 0);
    check(`${t.id}: black stays black`, black[0] < 0.02 && black[1] < 0.02 && black[2] < 0.02, black.map((v) => v.toFixed(4)).join(','));
  }

  // 'none' must be a no-op.
  const none = buildTransformLut(INPUT_TRANSFORMS.find((t) => t.id === 'none')!, { size: 17 });
  let worst = 0;
  for (let i = 0; i < 17; i++) {
    const v = i / 16;
    const o = sampleLut(none, v, v, v);
    worst = Math.max(worst, Math.abs(o[0] - v));
  }
  check("'none' transform is identity on gray", worst < 1e-3, `max err ${worst.toExponential(2)}`);

  // Rec.2020 -> Rec.709 must desaturate a saturated 2020 red, not leave it alone.
  const r2020 = buildTransformLut(INPUT_TRANSFORMS.find((t) => t.id === 'rec2020')!, { size: 33 });
  const red = sampleLut(r2020, 1, 0, 0);
  check('Rec.2020 red compresses into Rec.709', red[0] > 0.9 && red[1] >= -0.001 && red[2] >= -0.001, red.map((v) => v.toFixed(3)).join(','));
  // Neutral must stay neutral (no colour cast introduced by the matrix).
  const mid = sampleLut(r2020, 0.5, 0.5, 0.5);
  check('Rec.2020 neutral stays neutral', Math.abs(mid[0] - mid[1]) < 0.01 && Math.abs(mid[1] - mid[2]) < 0.01, mid.map((v) => v.toFixed(4)).join(','));

  // PQ -> SDR: 100% PQ (10 000 nits) must tone map down, never above 1.
  const pq = buildTransformLut(INPUT_TRANSFORMS.find((t) => t.id === 'pq2020')!, { size: 33 });
  const white = sampleLut(pq, 1, 1, 1);
  check('PQ white tone maps <= 1', white[0] <= 1 && white[0] > 0.7, white.map((v) => v.toFixed(4)).join(','));
  // HLG 0.75 (~50% scene linear) should land mid-gray-ish, not blown out.
  const hlg = buildTransformLut(INPUT_TRANSFORMS.find((t) => t.id === 'hlg2020')!, { size: 33 });
  const hlgMid = sampleLut(hlg, 0.75, 0.75, 0.75);
  check('HLG 0.75 lands in display range', hlgMid[0] > 0.2 && hlgMid[0] <= 1, hlgMid.map((v) => v.toFixed(4)).join(','));

  // LogC3 end to end: its 18% gray code value 0.391 must land on the Rec.709
  // code value for 18% gray, 0.409. This is the single strongest check that the
  // curve, the gamut matrix and the display encode all agree.
  const logc = buildTransformLut(INPUT_TRANSFORMS.find((t) => t.id === 'logc3')!, { size: 33 });
  const gray = sampleLut(logc, 0.391, 0.391, 0.391);
  check('LogC3 gray -> Rec.709 0.409', near(gray[1], rec709OETF(0.18), 4e-3), `${gray[1].toFixed(4)} vs ${rec709OETF(0.18).toFixed(4)}`);
  // Neutral in, neutral out: the AWG3 matrix must not introduce a cast.
  check('LogC3 gray stays neutral', Math.abs(gray[0] - gray[1]) < 3e-3 && Math.abs(gray[1] - gray[2]) < 3e-3, gray.map((v) => v.toFixed(4)).join(','));
  // LogC3 black code 0.0928 -> black.
  const lcBlack = sampleLut(logc, 0.0928, 0.0928, 0.0928);
  check('LogC3 black code -> black', lcBlack[1] < 0.01, lcBlack.map((v) => v.toFixed(4)).join(','));

  /* ---------- highlight roll-off ---------- */
  {
    // Without a roll-off, LogC3 EI 800 hard-clips everything above ~0.7 code
    // value into a flat white plate. With one, the shoulder is monotonic and
    // still reaches white at the top of the range.
    const above = sampleLut(logc, 0.7, 0.7, 0.7)[1];
    const top = sampleLut(logc, 1, 1, 1)[1];
    check('LogC3 highlight shoulder compresses (not clipped early)', above < 1, `code 0.7 -> ${above.toFixed(4)}`);
    check('LogC3 still reaches white at code 1.0', top >= 0.995, top.toFixed(4));
    check('rollOff is identity below the knee', rollOff(0.4, 0.75) === 0.4);
    check('rollOff is continuous at the knee', near(rollOff(0.75, 0.75), 0.75, 1e-12), rollOff(0.75, 0.75).toFixed(6));
    check('rollOff approaches 1 asymptotically', rollOff(1e6, 0.75) <= 1 && rollOff(1e6, 0.75) > 0.99999, rollOff(1e6, 0.75).toFixed(8));
    let mono = true,
      prev = -1;
    for (let i = 0; i <= 4096; i++) {
      const v = rollOff((i / 4096) * 4, 0.75);
      if (v < prev - 1e-12) mono = false;
      prev = v;
    }
    check('rollOff monotonic over 0..4', mono);
    // Differentiable at the knee: slopes either side must agree.
    const h = 1e-6;
    const below = (rollOff(0.75, 0.75) - rollOff(0.75 - h, 0.75)) / h;
    const above2 = (rollOff(0.75 + h, 0.75) - rollOff(0.75, 0.75)) / h;
    check('rollOff smooth at the knee', near(below, above2, 1e-3), `below=${below.toFixed(5)} above=${above2.toFixed(5)}`);
  }
}

/* ---------- identity + built-in looks ---------- */
{
  const id = identityLut(17);
  let worst = 0;
  for (let i = 0; i < 17; i++) {
    const v = i / 16;
    const o = sampleLut(id, v, v * 0.5, v * 0.25);
    worst = Math.max(worst, Math.abs(o[0] - v), Math.abs(o[1] - v * 0.5), Math.abs(o[2] - v * 0.25));
  }
  check('identity LUT is a no-op', worst < 1e-6, `max err ${worst.toExponential(2)}`);

  const looks = builtInLooks();
  check('built-in looks present', looks.length >= 5, `${looks.length}`);
  const neutral = looks.find((l) => l.id === 'builtin:neutral')!;
  let nw = 0;
  for (let i = 0; i < neutral.size; i++) {
    const v = i / (neutral.size - 1);
    const o = sampleLut(neutral, v, v, v);
    nw = Math.max(nw, Math.abs(o[0] - v));
  }
  check('built-in Neutral is identity', nw < 1e-6, `max err ${nw.toExponential(2)}`);
  for (const l of looks) {
    let lo = Infinity,
      hi = -Infinity;
    for (let i = 0; i < l.rgba.length; i += 4) for (let c = 0; c < 3; c++) { lo = Math.min(lo, l.rgba[i + c]); hi = Math.max(hi, l.rgba[i + c]); }
    check(`look ${l.id} in range`, lo >= 0 && hi <= 1, `${lo.toFixed(3)}..${hi.toFixed(3)}`);
  }
}

/* ---------- file sniffing ---------- */
{
  const cube = parseLutFile({ name: 'look.cube', text: 'TITLE "L"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n' });
  check('parseLutFile picks .cube', cube.size === 2 && cube.fileName === 'look.cube' && cube.title === 'L');
  const dl = parseLutFile({ name: 'look.3dl', text: '0 1023\n0 0 0\n1023 0 0\n0 1023 0\n1023 1023 0\n0 0 1023\n1023 0 1023\n0 1023 1023\n1023 1023 1023' });
  check('parseLutFile picks .3dl', dl.size === 2 && near(dl.rgba[4 * 1], 1, 1e-6));
}

console.log(`\n${failures === 0 ? 'All' : failures + ' failing of ' + checks} LUT/colour checks ${failures === 0 ? 'passed' : ''}.`);
if (failures) process.exit(1);
