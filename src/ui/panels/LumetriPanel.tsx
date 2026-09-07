import React, { useEffect, useRef, useState } from 'react';
import { useProject, useActiveSequence } from '../../state/projectStore';
import { useUI, toast } from '../../state/uiStore';
import { usePlayback } from '../../engine/playback/playback';
import { HotText, Slider, Select, Checkbox, Button, IconButton, Empty } from '../controls';
import { Icon } from '../icons';
import type { Clip, Param, ParamValue, Sequence } from '../../types/project';
import { param as mkParam } from '../../types/project';
import { getEffectDef } from '../../engine/effects/registry';
import { evalParam, setKeyframe } from '../../engine/keyframes';
import { uid, clamp } from '../../engine/util';
import { cmd } from '../../app/commands';

/*
  Lumetri Color: a focused UI over the 'lumetri' and 'colorWheels' effects.
  It edits the same EffectInstance params that Effect Controls shows, so both
  views stay in sync and everything is keyframable there.
*/

const LUMETRI = 'lumetri';
const WHEELS = 'colorWheels';

export function LumetriPanel() {
  const seq = useActiveSequence();
  const sel = useUI((s) => s.selection.clipIds);
  const playhead = usePlayback((s) => s.playhead);
  const [open, setOpen] = useState<Record<string, boolean>>({ basic: true, creative: false, curves: false, wheels: false, hsl: false, vignette: false });
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  const clip = seq?.clips.find((c) => c.id === sel[0]) ?? null;
  const track = clip ? seq!.tracks.find((t) => t.id === clip.trackId) : null;
  if (!seq || !clip || track?.kind !== 'video') {
    return (
      <div className="lumetri" style={{ height: '100%' }}>
        <Empty title="Lumetri Color" icon="color">
          Select a video clip to grade it. Lumetri adds a Lumetri Color effect to the clip on first edit; everything it does is also visible and keyframable in Effect Controls.
        </Empty>
      </div>
    );
  }
  const local = playhead - clip.start;
  const lum = clip.effects.find((e) => e.type === LUMETRI);
  const wheels = clip.effects.find((e) => e.type === WHEELS);
  const def = getEffectDef(LUMETRI)!;
  const wdef = getEffectDef(WHEELS)!;

  const ensure = (type: string, c: Clip) => {
    let fx = c.effects.find((e) => e.type === type);
    if (!fx) {
      const d = getEffectDef(type)!;
      const params: Record<string, Param> = {};
      for (const p of d.params) params[p.key] = mkParam(p.default as ParamValue);
      fx = { id: uid('fx'), type, enabled: true, params, masks: [] };
      c.effects.push(fx);
    }
    return fx;
  };
  const setP = (type: string, key: string, v: ParamValue, commit: boolean) => {
    const run = (p: any) => {
      const s = p.sequences.find((x: Sequence) => x.id === seq.id)!;
      const c = s.clips.find((x: Clip) => x.id === clip.id);
      if (!c) return;
      const fx = ensure(type, c);
      const cur = fx.params[key];
      fx.params[key] = cur?.animated ? { ...setKeyframe(cur as any, local, v as any), animated: true } : { ...(cur ?? {}), value: v };
    };
    if (commit) useProject.getState().update(`Lumetri ${key}`, run);
    else useProject.getState().updateTransient(run);
  };
  const get = (type: string, key: string): any => {
    const fx = type === LUMETRI ? lum : wheels;
    const d = type === LUMETRI ? def : wdef;
    const p = fx?.params[key];
    return p ? evalParam(p as any, local) : d.params.find((x) => x.key === key)!.default;
  };
  const begin = () => useProject.getState().beginBatch('Lumetri');
  const end = () => useProject.getState().endBatch();
  const reset = (type: string, keys: string[]) =>
    useProject.getState().update('Reset', (p) => {
      const c = p.sequences.find((x) => x.id === seq.id)!.clips.find((x) => x.id === clip.id);
      const fx = c?.effects.find((e) => e.type === type);
      const d = getEffectDef(type)!;
      if (!fx) return;
      for (const k of keys) fx.params[k] = mkParam(d.params.find((x) => x.key === k)!.default as ParamValue);
    });

  const row = (key: string, label: string, min: number, max: number, step = 0.5, opts: { type?: string; decimals?: number; center?: number; unit?: string } = {}) => {
    const type = opts.type ?? LUMETRI;
    const v = get(type, key) as number;
    return (
      <div className="lm-row" key={key}>
        <span className="label">{label}</span>
        <Slider value={v} min={min} max={max} step={step} zero={opts.center ?? (min < 0 ? 0 : undefined)} onChange={(x, c) => setP(type, key, x, c)} onBegin={begin} onEnd={end} style={{ flex: 1 }} />
        <HotText value={v} min={min} max={max} step={step} decimals={opts.decimals} unit={opts.unit} width={56} onChange={(x, c) => setP(type, key, x, c)} onBeginDrag={begin} onEndDrag={end} />
      </div>
    );
  };

  const section = (key: string, title: string, keys: string[], body: React.ReactNode, type = LUMETRI) => (
    <div className="lm-section">
      <div className="lm-head" onClick={() => toggle(key)} role="button">
        <Icon name={open[key] ? 'chevronDown' : 'chevronRight'} size={10} />
        <span style={{ flex: 1 }}>{title}</span>
        <button type="button" className="ibtn sm noline" title="Reset section" onClick={(e) => { e.stopPropagation(); reset(type, keys); }}><Icon name="reset" size={10} /></button>
      </div>
      {open[key] ? <div className="lm-body">{body}</div> : null}
    </div>
  );

  const enabled = lum ? lum.enabled : true;
  return (
    <div className="lumetri" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="toolbar">
        <span style={{ color: 'var(--c-text-bright)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{clip.name}</span>
        <span className="spacer" />
        <Checkbox checked={enabled} onChange={(v) => useProject.getState().update('Toggle Lumetri', (p) => { const c = p.sequences.find((x) => x.id === seq.id)!.clips.find((x) => x.id === clip.id); const fx = c?.effects.find((e) => e.type === LUMETRI); if (fx) fx.enabled = v; })} label="fx" title="Bypass Lumetri" disabled={!lum} />
        <IconButton icon="effectFx" label="Open in Effect Controls" sm onClick={() => useUI.getState().setFocusedPanel('effectControls')} />
      </div>
      <div className="scroll-y" style={{ flex: 1 }}>
        {section('basic', 'Basic Correction', ['temperature', 'tint', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'saturation'], (
          <>
            <div className="lm-sub">White Balance</div>
            <div className="lm-row"><span className="label">WB Selector</span><EyedropperWB onPick={(t, ti) => { setP(LUMETRI, 'temperature', t, true); setP(LUMETRI, 'tint', ti, true); }} /></div>
            {row('temperature', 'Temperature', -100, 100)}
            {row('tint', 'Tint', -100, 100)}
            <div className="lm-sub">Tone</div>
            {row('exposure', 'Exposure', -5, 5, 0.01, { decimals: 2 })}
            {row('contrast', 'Contrast', -100, 100)}
            {row('highlights', 'Highlights', -100, 100)}
            {row('shadows', 'Shadows', -100, 100)}
            {row('whites', 'Whites', -100, 100)}
            {row('blacks', 'Blacks', -100, 100)}
            <div className="lm-row" style={{ justifyContent: 'flex-end' }}>
              <Button sm onClick={() => autoTone(seq, clip, setP)}>Auto</Button>
            </div>
            {row('saturation', 'Saturation', 0, 300, 0.5, { center: 100 })}
          </>
        ))}
        {section('creative', 'Creative', ['vibrance', 'fadedFilm', 'sharpen', 'shadowTint', 'highlightTint', 'tintBalance'], (
          <>
            <div className="lm-row">
              <span className="label">Look</span>
              <Select value="" options={[{ value: '', label: 'None / choose...' }, ...(def.presets ?? []).map((p) => ({ value: p.name, label: p.name }))]} onChange={(name) => { const pr = def.presets?.find((p) => p.name === name); if (!pr) return; useProject.getState().update(`Look ${pr.name}`, (p) => { const c = p.sequences.find((x) => x.id === seq.id)!.clips.find((x) => x.id === clip.id)!; const fx = ensure(LUMETRI, c); for (const [k, v] of Object.entries(pr.values)) fx.params[k] = mkParam(v); }); }} style={{ flex: 1 }} />
            </div>
            {row('fadedFilm', 'Faded Film', 0, 100)}
            {row('sharpen', 'Sharpen', -100, 100)}
            {row('vibrance', 'Vibrance', -100, 100)}
            <div className="lm-sub">Color Tinting</div>
            <div className="wheels">
              <TintWheel label="Shadow Tint" value={get(LUMETRI, 'shadowTint')} onChange={(v, c) => setP(LUMETRI, 'shadowTint', v, c)} onBegin={begin} onEnd={end} />
              <TintWheel label="Highlight Tint" value={get(LUMETRI, 'highlightTint')} onChange={(v, c) => setP(LUMETRI, 'highlightTint', v, c)} onBegin={begin} onEnd={end} />
            </div>
            {row('tintBalance', 'Tint Balance', -100, 100)}
          </>
        ))}
        {section('curves', 'Curves', ['lumaGamma', 'lumaLift', 'lumaGain'], (
          <>
            <div className="lm-sub">Luma (lift / gamma / gain)</div>
            {row('lumaLift', 'Lift', -1, 1, 0.005, { decimals: 3 })}
            {row('lumaGamma', 'Gamma', 0.2, 3, 0.01, { decimals: 2, center: 1 })}
            {row('lumaGain', 'Gain', 0, 3, 0.005, { decimals: 3, center: 1 })}
            <CurvePreview lift={get(LUMETRI, 'lumaLift')} gamma={get(LUMETRI, 'lumaGamma')} gain={get(LUMETRI, 'lumaGain')} />
            <div className="lm-sub" style={{ marginTop: 6 }}>For per-channel RGB curves, add the Levels or Channel Mixer effect from the Effects panel.</div>
          </>
        ))}
        {section('wheels', 'Color Wheels & Match', ['lift', 'gamma', 'gain', 'liftLuma', 'gammaLuma', 'gainLuma'], (
          <>
            <div className="wheels">
              <TintWheel label="Shadows" value={get(WHEELS, 'lift')} onChange={(v, c) => setP(WHEELS, 'lift', v, c)} onBegin={begin} onEnd={end} level={{ value: get(WHEELS, 'liftLuma'), min: -1, max: 1, step: 0.005, onChange: (v, c) => setP(WHEELS, 'liftLuma', v, c) }} />
              <TintWheel label="Midtones" value={get(WHEELS, 'gamma')} onChange={(v, c) => setP(WHEELS, 'gamma', v, c)} onBegin={begin} onEnd={end} level={{ value: get(WHEELS, 'gammaLuma'), min: 0.2, max: 3, step: 0.005, onChange: (v, c) => setP(WHEELS, 'gammaLuma', v, c) }} />
              <TintWheel label="Highlights" value={get(WHEELS, 'gain')} onChange={(v, c) => setP(WHEELS, 'gain', v, c)} onBegin={begin} onEnd={end} level={{ value: get(WHEELS, 'gainLuma'), min: 0, max: 3, step: 0.005, onChange: (v, c) => setP(WHEELS, 'gainLuma', v, c) }} />
            </div>
            <div className="lm-row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
              <Button sm onClick={() => cmd.colorMatch()} title="Match this clip's average color and brightness to the clip under the playhead in the reference sequence position">Match to previous clip</Button>
            </div>
          </>
        ), WHEELS)}
        {section('hsl', 'HSL Secondary', ['hueShift'], <>{row('hueShift', 'Hue Shift', -180, 180, 0.5, { unit: '°' })}<div className="lm-sub">Use Hue/Saturation (Effects panel) for per-range secondary corrections with colorize.</div></>)}
        {section('vignette', 'Vignette', ['vignetteAmount', 'vignetteMidpoint', 'vignetteRoundness', 'vignetteFeather'], (
          <>
            {row('vignetteAmount', 'Amount', -5, 5, 0.05, { decimals: 2 })}
            {row('vignetteMidpoint', 'Midpoint', 0, 100)}
            {row('vignetteRoundness', 'Roundness', -100, 100)}
            {row('vignetteFeather', 'Feather', 0, 100)}
          </>
        ))}
      </div>
    </div>
  );
}

/** Color wheel: picks a tint offset around neutral 0.5,0.5,0.5. */
function TintWheel({ label, value, onChange, onBegin, onEnd, level }: { label: string; value: [number, number, number, number] | string; onChange: (v: [number, number, number, number], commit: boolean) => void; onBegin: () => void; onEnd: () => void; level?: { value: number; min: number; max: number; step: number; onChange: (v: number, c: boolean) => void } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = 72;
  const val: [number, number, number, number] = Array.isArray(value) ? value : [0.5, 0.5, 0.5, 1];
  // encode offset as hue angle + radius from rgb offset
  const ox = val[0] - 0.5,
    oy = val[1] - 0.5,
    oz = val[2] - 0.5;
  // project to 2D: x = R - (G+B)/2, y = (G - B) * sqrt(3)/2
  const px = ox - (oy + oz) / 2;
  const py = ((oy - oz) * Math.sqrt(3)) / 2;
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = size * dpr;
    cv.height = size * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const c = size / 2;
    const img = ctx.createImageData(size * dpr, size * dpr);
    for (let y = 0; y < size * dpr; y++) {
      for (let x = 0; x < size * dpr; x++) {
        const dx = x / dpr - c,
          dy = y / dpr - c;
        const r = Math.hypot(dx, dy) / c;
        const i = (y * size * dpr + x) * 4;
        if (r > 1) {
          img.data[i + 3] = 0;
          continue;
        }
        const ang = Math.atan2(dy, dx);
        const h = ((ang * 180) / Math.PI + 360) % 360;
        const s = r;
        const l = 0.5;
        const [rr, gg, bb] = hsl(h, s, l);
        img.data[i] = rr * 255;
        img.data[i + 1] = gg * 255;
        img.data[i + 2] = bb * 255;
        img.data[i + 3] = 255 * (r > 0.97 ? (1 - r) / 0.03 : 1);
      }
    }
    ctx.putImageData(img, 0, 0);
    // crosshair at current
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const kx = c + px * c * 2,
      ky = c - py * c * 2;
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(kx, ky, 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 1;
    ctx.stroke();
  }, [px, py]);
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = ref.current!.getBoundingClientRect();
    onBegin();
    const apply = (ev: PointerEvent, commit: boolean) => {
      let x = (ev.clientX - r.left - size / 2) / (size / 2) / 2;
      let y = -(ev.clientY - r.top - size / 2) / (size / 2) / 2;
      const m = Math.hypot(x, y);
      if (m > 0.5) {
        x *= 0.5 / m;
        y *= 0.5 / m;
      }
      // invert projection: R = x*2/3, G = -x/3 + y/sqrt3, B = -x/3 - y/sqrt3
      const R = (x * 2) / 3,
        G = -x / 3 + y / Math.sqrt(3),
        B = -x / 3 - y / Math.sqrt(3);
      onChange([clamp(0.5 + R, 0, 1), clamp(0.5 + G, 0, 1), clamp(0.5 + B, 0, 1), 1], commit);
    };
    apply(e.nativeEvent, false);
    const move = (ev: PointerEvent) => apply(ev, false);
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      apply(ev, true);
      onEnd();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="wheel">
      <span className="wl">{label}</span>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <canvas ref={ref} style={{ width: size, height: size }} onPointerDown={down} onDoubleClick={() => onChange([0.5, 0.5, 0.5, 1], true)} title="Drag to tint; double-click to reset" />
        {level ? <Slider vertical value={level.value} min={level.min} max={level.max} step={level.step} onChange={level.onChange} onBegin={onBegin} onEnd={onEnd} style={{ height: size }} title="Level" /> : null}
      </div>
      <span className="row" style={{ fontSize: 9, color: 'var(--c-text-faint)', display: 'flex' }}>
        {((val[0] - 0.5) * 200).toFixed(0)} {((val[1] - 0.5) * 200).toFixed(0)} {((val[2] - 0.5) * 200).toFixed(0)}
      </span>
    </div>
  );
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

function CurvePreview({ lift, gamma, gain }: { lift: number; gamma: number; gain: number }) {
  const W = 160,
    H = 100;
  const pts: string[] = [];
  for (let i = 0; i <= 32; i++) {
    const x = i / 32;
    const y = clamp(Math.pow(clamp(x * gain + lift, 0, 1), 1 / gamma), 0, 1);
    pts.push(`${(x * W).toFixed(1)},${((1 - y) * H).toFixed(1)}`);
  }
  return (
    <div className="curve-editor" style={{ marginTop: 6 }}>
      <svg width={W} height={H} style={{ background: '#141414', border: '1px solid var(--c-line)', display: 'block' }}>
        <line x1={0} y1={H} x2={W} y2={0} stroke="#333" strokeDasharray="3 3" />
        <polyline points={pts.join(' ')} fill="none" stroke="#e0e0e0" strokeWidth={1.5} />
      </svg>
    </div>
  );
}

/** White balance picker: samples a neutral pixel from the program monitor and derives temperature/tint offsets. */
function EyedropperWB({ onPick }: { onPick: (temp: number, tint: number) => void }) {
  const [arming, setArming] = useState(false);
  useEffect(() => {
    if (!arming) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const canvas = target.closest('.monitor.program canvas') as HTMLCanvasElement | null;
      setArming(false);
      document.body.classList.remove('picking');
      if (!canvas) return toast('info', 'Pick cancelled', 'Click a neutral (gray/white) area in the Program Monitor.');
      e.preventDefault();
      e.stopPropagation();
      const r = canvas.getBoundingClientRect();
      const x = Math.floor(((e.clientX - r.left) / r.width) * canvas.width);
      const y = Math.floor(((e.clientY - r.top) / r.height) * canvas.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const d = ctx.getImageData(Math.max(0, x - 2), Math.max(0, y - 2), 5, 5).data;
      let rr = 0,
        gg = 0,
        bb = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        rr += d[i];
        gg += d[i + 1];
        bb += d[i + 2];
      }
      rr /= n;
      gg /= n;
      bb /= n;
      const avg = (rr + gg + bb) / 3 || 1;
      // Blue-yellow axis -> temperature, green-magenta -> tint (scaled to slider range)
      const temp = clamp(((bb - rr) / avg) * 120, -100, 100);
      const tint = clamp(((gg - (rr + bb) / 2) / avg) * 120, -100, 100);
      onPick(+temp.toFixed(1), +tint.toFixed(1));
    };
    window.addEventListener('click', handler, true);
    document.body.classList.add('picking');
    return () => {
      window.removeEventListener('click', handler, true);
      document.body.classList.remove('picking');
    };
  }, [arming, onPick]);
  return (
    <Button sm icon="eyedropper" onClick={() => setArming(!arming)} primary={arming} title="Click, then click a neutral area in the Program Monitor">
      {arming ? 'Click a neutral area...' : 'Pick neutral'}
    </Button>
  );
}

function autoTone(seq: Sequence, clip: Clip, setP: (type: string, key: string, v: ParamValue, commit: boolean) => void) {
  const canvas = document.querySelector('.monitor.program canvas') as HTMLCanvasElement | null;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  const w = 64,
    h = 36;
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext('2d')!;
  tctx.drawImage(canvas, 0, 0, w, h);
  const d = tctx.getImageData(0, 0, w, h).data;
  const lum: number[] = [];
  for (let i = 0; i < d.length; i += 4) lum.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
  lum.sort((a, b) => a - b);
  const p1 = lum[Math.floor(lum.length * 0.01)] / 255,
    p99 = lum[Math.floor(lum.length * 0.99)] / 255;
  const mean = lum.reduce((a, b) => a + b, 0) / lum.length / 255;
  const exposure = clamp(Math.log2(0.45 / Math.max(0.02, mean)), -2, 2);
  const blacks = clamp(-p1 * 200, -60, 0);
  const whites = clamp((1 - p99) * 120, 0, 60);
  setP(LUMETRI, 'exposure', +exposure.toFixed(2), true);
  setP(LUMETRI, 'blacks', +blacks.toFixed(1), true);
  setP(LUMETRI, 'whites', +whites.toFixed(1), true);
  toast('success', 'Auto tone applied', `Exposure ${exposure >= 0 ? '+' : ''}${exposure.toFixed(2)}, blacks ${blacks.toFixed(0)}, whites +${whites.toFixed(0)}`);
  void seq;
  void clip;
}
