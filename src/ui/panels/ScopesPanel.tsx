import React, { useEffect, useRef, useState } from 'react';
import { usePlayback, currentRenderTarget, getCompositor, getTimelineAudio } from '../../engine/playback/playback';
import { Checkbox, Select, useLocalToggle } from '../controls';
import { Empty } from '../controls';

type ScopeKind = 'waveform' | 'vectorscope' | 'histogram' | 'parade' | 'spectrum';
const ALL: { id: ScopeKind; label: string }[] = [
  { id: 'waveform', label: 'Waveform (Luma)' },
  { id: 'parade', label: 'RGB Parade' },
  { id: 'vectorscope', label: 'Vectorscope' },
  { id: 'histogram', label: 'Histogram' },
  { id: 'spectrum', label: 'Audio Spectrum' },
];

/** Video scopes computed on the CPU from a downsampled readback of the last rendered frame. */
export function ScopesPanel() {
  const [enabled, setEnabled] = useState<ScopeKind[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('vsp.scopes') || '["waveform","vectorscope"]');
    } catch {
      return ['waveform', 'vectorscope'];
    }
  });
  const [ire, setIre] = useLocalToggle('vsp.scopes.ire', false);
  const [intensity, setIntensity] = useState(1);
  const frameVersion = usePlayback((s) => s.frameVersion);
  const [pixels, setPixels] = useState<ImageData | null>(null);
  const lastAt = useRef(0);

  useEffect(() => {
    const t = performance.now();
    if (t - lastAt.current < 66) return; // ~15 fps cap for CPU readback
    lastAt.current = t;
    const rt = currentRenderTarget();
    if (!rt) {
      setPixels(null);
      return;
    }
    try {
      const comp = getCompositor();
      const small = comp.readPixelsScaled(rt, 160);
      setPixels(small);
    } catch {
      /* context lost */
    }
  }, [frameVersion]);

  const toggle = (k: ScopeKind) => {
    const next = enabled.includes(k) ? enabled.filter((x) => x !== k) : [...enabled, k];
    setEnabled(next);
    localStorage.setItem('vsp.scopes', JSON.stringify(next));
  };
  const cols = enabled.length <= 1 ? 1 : 2;
  return (
    <div className="scopes">
      <div className="toolbar">
        <Select value="" options={[{ value: '', label: `Scopes (${enabled.length})` }, ...ALL.map((s) => ({ value: s.id, label: `${enabled.includes(s.id) ? '[x] ' : '[ ] '}${s.label}` }))]} onChange={(v) => v && toggle(v as ScopeKind)} style={{ width: 150 }} title="Choose which scopes are shown" />
        <Checkbox checked={ire} onChange={setIre} label="IRE" title="Show 0-100 IRE scale instead of 8-bit levels" />
        <span className="spacer" />
        <span style={{ color: 'var(--c-text-dim)', fontSize: 11 }}>Brightness</span>
        <input type="range" min={0.3} max={3} step={0.1} value={intensity} onChange={(e) => setIntensity(Number(e.target.value))} style={{ width: 70 }} title="Scope trace brightness" />
      </div>
      <div className="scope-area" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {enabled.length === 0 ? <Empty title="No scopes selected">Pick a scope from the dropdown.</Empty> : null}
        {enabled.map((k) => (
          <div className="scope" key={k}>
            <Scope kind={k} pixels={pixels} ire={ire} intensity={intensity} />
            <span className="scope-title">{ALL.find((s) => s.id === k)!.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Scope({ kind, pixels, ire, intensity }: { kind: ScopeKind; pixels: ImageData | null; ire: boolean; intensity: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const playing = usePlayback((s) => s.playing);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const W = Math.max(64, Math.floor(rect.width)),
      H = Math.max(48, Math.floor(rect.height));
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
    }
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#0e0e0e';
    ctx.fillRect(0, 0, W, H);
    if (kind === 'spectrum') return; // animated separately
    if (!pixels) {
      ctx.fillStyle = '#555';
      ctx.font = '11px Inter, sans-serif';
      ctx.fillText('No frame', 8, H - 8);
      return;
    }
    const { data, width: pw, height: ph } = pixels;
    const pad = 22;
    const gain = intensity;
    switch (kind) {
      case 'waveform':
      case 'parade': {
        const img = ctx.createImageData(W, H);
        const plotH = H - 8;
        const chans = kind === 'parade' ? 3 : 1;
        const colW = (W - pad) / chans;
        for (let y = 0; y < ph; y++) {
          for (let x = 0; x < pw; x++) {
            const i = (y * pw + x) * 4;
            for (let c = 0; c < chans; c++) {
              const v = kind === 'parade' ? data[i + c] : 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
              const px = Math.floor(pad + c * colW + (x / pw) * colW);
              const py = Math.floor(4 + (1 - v / 255) * plotH);
              const o = (py * W + px) * 4;
              if (o < 0 || o >= img.data.length) continue;
              const add = 22 * gain;
              if (kind === 'parade') {
                img.data[o + c] = Math.min(255, img.data[o + c] + add * 1.6);
                img.data[o + ((c + 1) % 3)] = Math.min(255, img.data[o + ((c + 1) % 3)] + add * 0.25);
                img.data[o + ((c + 2) % 3)] = Math.min(255, img.data[o + ((c + 2) % 3)] + add * 0.25);
              } else {
                img.data[o] = Math.min(255, img.data[o] + add * 0.7);
                img.data[o + 1] = Math.min(255, img.data[o + 1] + add);
                img.data[o + 2] = Math.min(255, img.data[o + 2] + add * 0.7);
              }
              img.data[o + 3] = 255;
            }
          }
        }
        ctx.putImageData(img, 0, 0);
        // graticule
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.fillStyle = '#8d8d8d';
        ctx.font = '9px Inter, sans-serif';
        ctx.textAlign = 'right';
        const marks = ire ? [0, 20, 40, 60, 80, 100] : [0, 64, 128, 192, 255];
        for (const m of marks) {
          const y = 4 + (1 - (ire ? m / 100 : m / 255)) * plotH;
          ctx.beginPath();
          ctx.moveTo(pad, y + 0.5);
          ctx.lineTo(W, y + 0.5);
          ctx.stroke();
          ctx.fillText(String(m), pad - 3, y + 3);
        }
        break;
      }
      case 'vectorscope': {
        const img = ctx.createImageData(W, H);
        const cx = W / 2,
          cy = H / 2,
          R = Math.min(W, H) / 2 - 6;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i] / 255,
            g = data[i + 1] / 255,
            b = data[i + 2] / 255;
          const cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
          const cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
          const px = Math.floor(cx + cb * 2 * R * 0.9);
          const py = Math.floor(cy - cr * 2 * R * 0.9);
          if (px < 0 || py < 0 || px >= W || py >= H) continue;
          const o = (py * W + px) * 4;
          img.data[o] = Math.min(255, img.data[o] + 30 * gain * (0.4 + r));
          img.data[o + 1] = Math.min(255, img.data[o + 1] + 30 * gain * (0.4 + g));
          img.data[o + 2] = Math.min(255, img.data[o + 2] + 30 * gain * (0.4 + b));
          img.data[o + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, R * 0.75, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - R, cy);
        ctx.lineTo(cx + R, cy);
        ctx.moveTo(cx, cy - R);
        ctx.lineTo(cx, cy + R);
        ctx.stroke();
        // 75% color targets
        const targets: [string, number, number, number][] = [
          ['R', 0.75, 0, 0],
          ['Yl', 0.75, 0.75, 0],
          ['G', 0, 0.75, 0],
          ['Cy', 0, 0.75, 0.75],
          ['B', 0, 0, 0.75],
          ['Mg', 0.75, 0, 0.75],
        ];
        ctx.fillStyle = '#9a9a9a';
        ctx.font = '9px Inter, sans-serif';
        ctx.textAlign = 'center';
        for (const [n, r, g, b] of targets) {
          const cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
          const cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
          const px = cx + cb * 2 * R * 0.9,
            py = cy - cr * 2 * R * 0.9;
          ctx.strokeRect(px - 4, py - 4, 8, 8);
          ctx.fillText(n, px, py - 7);
        }
        // skin tone line (I axis ~ 123 deg)
        ctx.strokeStyle = 'rgba(255,200,160,0.35)';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        const ang = (-123 * Math.PI) / 180;
        ctx.lineTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R);
        ctx.stroke();
        break;
      }
      case 'histogram': {
        const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
        for (let i = 0; i < data.length; i += 4) {
          bins[0][data[i]]++;
          bins[1][data[i + 1]]++;
          bins[2][data[i + 2]]++;
          bins[3][Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])]++;
        }
        let max = 1;
        for (const b of bins) for (let i = 1; i < 255; i++) max = Math.max(max, b[i]);
        const plotH = H - 16,
          plotW = W - 8;
        ctx.globalCompositeOperation = 'lighter';
        const colors = ['rgba(220,70,60,0.75)', 'rgba(70,200,90,0.75)', 'rgba(70,110,230,0.75)', 'rgba(200,200,200,0.4)'];
        bins.forEach((b, ci) => {
          ctx.fillStyle = colors[ci];
          ctx.beginPath();
          ctx.moveTo(4, 4 + plotH);
          for (let i = 0; i < 256; i++) {
            const h = Math.min(1, (Math.log1p(b[i] * gain) / Math.log1p(max)) * 1.05);
            ctx.lineTo(4 + (i / 255) * plotW, 4 + plotH - h * plotH);
          }
          ctx.lineTo(4 + plotW, 4 + plotH);
          ctx.closePath();
          ctx.fill();
        });
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#8d8d8d';
        ctx.font = '9px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(ire ? '0' : '0', 4, H - 4);
        ctx.textAlign = 'right';
        ctx.fillText(ire ? '100' : '255', W - 4, H - 4);
        break;
      }
    }
  }, [kind, pixels, ire, intensity]);

  // audio spectrum animates from the analyser
  useEffect(() => {
    if (kind !== 'spectrum') return;
    const cv = ref.current;
    if (!cv) return;
    const buf = new Uint8Array(512);
    let raf = 0;
    const tick = () => {
      const rect = cv.getBoundingClientRect();
      const W = Math.max(64, Math.floor(rect.width)),
        H = Math.max(48, Math.floor(rect.height));
      if (cv.width !== W || cv.height !== H) {
        cv.width = W;
        cv.height = H;
      }
      const ctx = cv.getContext('2d')!;
      ctx.fillStyle = '#0e0e0e';
      ctx.fillRect(0, 0, W, H);
      if (playing) getTimelineAudio().readSpectrum(buf);
      else buf.fill(0);
      const bars = 64;
      const bw = (W - 8) / bars;
      for (let i = 0; i < bars; i++) {
        // log frequency mapping
        const f0 = Math.floor(Math.pow(buf.length, i / bars)),
          f1 = Math.max(f0 + 1, Math.floor(Math.pow(buf.length, (i + 1) / bars)));
        let v = 0;
        for (let j = f0; j < f1 && j < buf.length; j++) v = Math.max(v, buf[j]);
        const h = ((v / 255) * (H - 20)) * Math.min(1, intensity);
        ctx.fillStyle = v > 235 ? '#d94a3d' : v > 200 ? '#d9a441' : '#4da58a';
        ctx.fillRect(4 + i * bw, H - 14 - h, Math.max(1, bw - 1), h);
      }
      ctx.fillStyle = '#8d8d8d';
      ctx.font = '9px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('20 Hz', 4, H - 3);
      ctx.textAlign = 'center';
      ctx.fillText('1 kHz', W * 0.55, H - 3);
      ctx.textAlign = 'right';
      ctx.fillText('20 kHz', W - 4, H - 3);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [kind, playing, intensity]);

  return <canvas ref={ref} />;
}
