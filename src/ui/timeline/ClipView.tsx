import React, { useEffect, useMemo, useRef } from 'react';
import type { Clip, MediaAsset, Sequence, Track } from '../../types/project';
import { LABEL_COLORS } from '../../types/project';
import { getMedia, onMediaChange } from '../../engine/media/mediaStore';
import { Icon, type IconName } from '../icons';
import { useUI } from '../../state/uiStore';
import { evalNumber } from '../../engine/keyframes';
import { thumbnailFor } from './thumbnails';

interface Props {
  clip: Clip;
  track: Track;
  asset: MediaAsset | undefined;
  seq: Sequence;
  left: number;
  width: number;
  height: number;
  selected: boolean;
  dragging: boolean;
  ppf: number;
  scrollFrame: number;
  laneWidth: number;
  showRubber: boolean;
  onPointerDown: (e: React.PointerEvent, part: 'body' | 'trimL' | 'trimR' | 'rubber' | 'kf' | 'transIn' | 'transOut', extra?: any) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
}

const clipColor = (clip: Clip, track: Track, asset?: MediaAsset): [string, string] => {
  if (asset?.label || clip.label) {
    const l = LABEL_COLORS[clip.label] ?? LABEL_COLORS.cerulean;
    return [l, shade(l, -0.25)];
  }
  if (track.kind === 'audio') return ['var(--c-clip-audio-head)', 'var(--c-clip-audio)'];
  return ['var(--c-clip-video-head)', 'var(--c-clip-video)'];
};

function shade(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v + (amt < 0 ? v * amt : (255 - v) * amt))));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

export const ClipView = React.memo(function ClipView({ clip, track, asset, seq, left, width, height, selected, dragging, ppf, scrollFrame, laneWidth, showRubber, onPointerDown, onContextMenu, onDoubleClick }: Props) {
  const showWave = useUI((s) => s.showAudioWaveforms);
  const showThumbs = useUI((s) => s.showVideoThumbnails);
  const showNames = useUI((s) => s.showClipNames);
  const showThrough = useUI((s) => s.showThroughEdits);
  const selKfs = useUI((s) => s.selection.keyframes);
  const selTrans = useUI((s) => s.selection.transitionIds);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isAudio = track.kind === 'audio';
  const [head, body] = clipColor(clip, track, asset);
  const fps = seq.settings.fps;
  const tall = height > 30;
  const offline = !!asset?.offline;
  const icon: IconName = clip.nestedSequenceId ? 'clipNested' : clip.generator === 'adjustmentLayer' ? 'clipAdjust' : clip.generator === 'graphic' ? 'clipTitle' : clip.generator ? 'clipMatte' : isAudio ? 'clipAudio' : asset?.kind === 'image' ? 'clipImage' : 'clipVideo';

  // Visible portion (culling for very long clips)
  const visStart = Math.max(0, -left);
  const visEnd = Math.min(width, laneWidth - left);
  const visW = Math.max(0, visEnd - visStart);

  // Body drawing: waveform or thumbnails
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(visW));
    const h = Math.max(1, Math.round(height - (tall ? 15 : 0) - 2));
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr;
      cv.height = h * dpr;
    }
    cv.style.left = `${visStart}px`;
    cv.style.width = `${w}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    let cancelled = false;
    const rec = getMedia(clip.assetId);
    if (isAudio && showWave) {
      drawWaveform(ctx, w, h, clip, rec?.peaks, fps, ppf, visStart, selected);
    } else if (!isAudio && showThumbs && h >= 14 && (rec?.video || rec?.image || clip.generator || clip.nestedSequenceId)) {
      // draw a strip of thumbnails
      const thumbW = Math.round(h * ((asset?.width ?? 16) / (asset?.height ?? 9)));
      const run = async () => {
        const startPx = visStart;
        for (let x = -((left + startPx) % thumbW); x < w; x += thumbW) {
          if (cancelled) return;
          const frameInClip = Math.floor((startPx + x) / ppf);
          const src = clip.freezeAt ?? sourceTime(clip, frameInClip, fps);
          const img = await thumbnailFor(clip, asset, src, thumbW, h);
          if (cancelled || !img) continue;
          ctx.drawImage(img, x, 0, thumbW, h);
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.fillRect(x + thumbW - 1, 0, 1, h);
        }
      };
      void run();
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visW, visStart, height, clip.inPoint, clip.speed, clip.reversed, clip.freezeAt, clip.assetId, clip.duration, ppf, showWave, showThumbs, isAudio, selected, left, asset?.width, asset?.height, clip.audio.gain, clip.generator, clip.nestedSequenceId]);

  // redraw when media decodes
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  useEffect(() => onMediaChange(() => force()), []);

  // Rubber band (volume/opacity) geometry
  const rubber = useMemo(() => {
    if (!showRubber || !tall) return null;
    const p = isAudio ? clip.audio.volume : clip.motion.opacity;
    const bodyTop = 15;
    const bodyH = height - 17;
    const toY = (v: number) => (isAudio ? bodyTop + bodyH * (1 - dbToPos(v)) : bodyTop + bodyH * (1 - v / 100));
    const kfs = p.keyframes ?? [];
    const pts: { x: number; y: number; t: number }[] = [];
    if (kfs.length) {
      for (const k of kfs) pts.push({ x: k.t * ppf, y: toY(k.v as number), t: k.t });
    }
    const y0 = kfs.length ? toY(evalNumber(p as any, 0)) : toY(p.value as number);
    const y1 = kfs.length ? toY(evalNumber(p as any, clip.duration)) : y0;
    return { pts, y0, y1, keyframed: kfs.length > 0, path: isAudio ? 'audio.volume' : 'motion.opacity' };
  }, [showRubber, tall, clip, height, ppf, isAudio]);

  const badgeText = clip.speed !== 1 || clip.reversed ? `${clip.reversed ? '-' : ''}${Math.round(clip.speed * 100)}%` : null;
  const throughEdit = useMemo(() => {
    if (!showThrough) return false;
    // A through-edit: previous clip on the same track ends exactly here with continuous source
    const prev = seq.clips.find((c) => c.trackId === clip.trackId && c.id !== clip.id && c.start + c.duration === clip.start && c.assetId === clip.assetId && c.speed === clip.speed);
    if (!prev) return false;
    const expected = prev.inPoint + (prev.duration / fps) * prev.speed * (prev.reversed ? -1 : 1);
    return Math.abs(expected - clip.inPoint) < 0.5 / fps;
  }, [seq.clips, clip, fps, showThrough]);

  const trIn = clip.transitionIn;
  const trOut = clip.transitionOut;
  const trW = (d: number) => Math.max(6, d * ppf);
  const trInLeft = trIn ? (trIn.alignment === 'center' ? -trW(trIn.duration) / 2 : trIn.alignment === 'end' ? -trW(trIn.duration) : 0) : 0;
  const trOutLeft = trOut ? width - (trOut.alignment === 'center' ? trW(trOut.duration) / 2 : trOut.alignment === 'start' ? trW(trOut.duration) : 0) - (trOut.alignment === 'end' ? 0 : 0) : 0;
  const trOutLeftFinal = trOut ? (trOut.alignment === 'end' ? width - trW(trOut.duration) : trOutLeft) : 0;

  return (
    <div
      className={['clip', selected ? 'selected' : '', dragging ? 'dragging' : '', clip.enabled ? '' : 'disabled', offline ? 'offline' : ''].filter(Boolean).join(' ')}
      style={{ left, width, background: body }}
      data-clip={clip.id}
      onPointerDown={(e) => onPointerDown(e, 'body')}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      title={showNames ? undefined : clip.name}
    >
      {tall ? (
        <div className="clip-head" style={{ background: head }}>
          <Icon name={icon} className="fx" />
          {showNames ? <span className="clip-name">{clip.name}</span> : null}
          {clip.effects.length ? <Icon name="effectFx" className={`fx ${clip.effects.some((e) => e.enabled) ? '' : 'dim'}`} title={`${clip.effects.length} effect${clip.effects.length === 1 ? '' : 's'}`} /> : null}
          {(clip.motion.position.keyframes?.length || clip.motion.scale.keyframes?.length || clip.motion.rotation.keyframes?.length || clip.motion.opacity.keyframes?.length || clip.audio.volume.keyframes?.length) && width > 60 ? <Icon name="keyframe" className="fx dim" title="Keyframed" /> : null}
          {width > 120 && asset?.kind === 'video' && !isAudio && clip.linkId ? <span className="clip-badge">V</span> : null}
        </div>
      ) : null}
      <div className="clip-body">
        <canvas ref={canvasRef} />
        {!tall && showNames ? (
          <span className="clip-name" style={{ position: 'absolute', left: 4, top: 1, right: 4, fontSize: 10, pointerEvents: 'none' }}>
            {clip.name}
          </span>
        ) : null}
        {badgeText ? <span className="speed-badge">{badgeText}</span> : null}
        {clip.freezeAt != null ? <span className="freeze-badge">HOLD</span> : null}
        {clip.timeRemap && clip.timeRemap.length >= 2 ? <span className="freeze-badge">REMAP</span> : null}
      </div>
      {rubber ? (
        <>
          {rubber.keyframed ? (
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 2 }}>
              <polyline fill="none" stroke="#f0d070" strokeWidth={1} opacity={0.9} points={[[0, rubber.y0], ...rubber.pts.map((p) => [p.x, p.y]), [width, rubber.y1]].map((p) => p.join(',')).join(' ')} />
            </svg>
          ) : (
            <div className="rubber" style={{ top: rubber.y0 }} onPointerDown={(e) => onPointerDown(e, 'rubber', { path: rubber.path })} title={isAudio ? 'Volume - drag up/down, Ctrl+click to add keyframe' : 'Opacity - drag up/down, Ctrl+click to add keyframe'} />
          )}
          {rubber.keyframed ? <div className="rubber" style={{ top: 15, height: height - 17, background: 'transparent', opacity: 1 }} onPointerDown={(e) => onPointerDown(e, 'rubber', { path: rubber.path })} /> : null}
          {rubber.pts.map((p) => (
            <div key={p.t} className={`kf ${selKfs.some((k) => k.clipId === clip.id && k.path === rubber.path && k.t === p.t) ? 'selected' : ''}`} style={{ left: p.x, top: p.y }} onPointerDown={(e) => onPointerDown(e, 'kf', { path: rubber.path, t: p.t })} />
          ))}
        </>
      ) : null}
      {trIn ? (
        <div className={`transition ${selTrans.includes(clip.id + ':in') ? 'selected' : ''}`} style={{ left: trInLeft, width: trW(trIn.duration) }} onPointerDown={(e) => onPointerDown(e, 'transIn')} title={`${trIn.type} (${trIn.duration}f)`}>
          {trW(trIn.duration) > 40 ? trIn.type : ''}
        </div>
      ) : null}
      {trOut ? (
        <div className={`transition ${selTrans.includes(clip.id + ':out') ? 'selected' : ''}`} style={{ left: trOutLeftFinal, width: trW(trOut.duration) }} onPointerDown={(e) => onPointerDown(e, 'transOut')} title={`${trOut.type} (${trOut.duration}f)`}>
          {trW(trOut.duration) > 40 ? trOut.type : ''}
        </div>
      ) : null}
      {throughEdit ? <div className="through-edit" style={{ left: 0 }} /> : null}
      {clip.markers.map((m) => (
        <div key={m.id} className="clip-marker" style={{ left: m.time * ppf }} title={m.name || 'Clip marker'} />
      ))}
      <div className="trim l" onPointerDown={(e) => onPointerDown(e, 'trimL')} />
      <div className="trim r" onPointerDown={(e) => onPointerDown(e, 'trimR')} />
    </div>
  );
});

function sourceTime(clip: Clip, frameInClip: number, fps: number) {
  const s = (frameInClip / fps) * clip.speed;
  return clip.reversed ? clip.inPoint - s : clip.inPoint + s;
}

/** Map dB to 0..1 position for the rubber band (0 dB at ~0.7). */
export function dbToPos(db: number) {
  return Math.max(0, Math.min(1, (db + 60) / 66 * 0.94 + 0.03));
}
export function posToDb(p: number) {
  return Math.max(-60, Math.min(6, ((p - 0.03) / 0.94) * 66 - 60));
}

function drawWaveform(ctx: CanvasRenderingContext2D, w: number, h: number, clip: Clip, peaks: Float32Array[] | undefined, fps: number, ppf: number, visStart: number, selected: boolean) {
  ctx.fillStyle = selected ? 'rgba(224,224,224,0.85)' : 'rgba(200,220,205,0.7)';
  if (!peaks || !peaks.length) {
    // placeholder centre line
    ctx.fillStyle = 'rgba(200,220,205,0.25)';
    ctx.fillRect(0, h / 2, w, 1);
    return;
  }
  const res = 200; // PEAK_RES
  const channels = Math.min(2, peaks.length);
  const chH = h / channels;
  const gain = Math.pow(10, clip.audio.gain / 20);
  for (let ch = 0; ch < channels; ch++) {
    const pk = peaks[ch];
    const n = pk.length / 2;
    const mid = chH * ch + chH / 2;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const frameInClip = (visStart + x) / ppf;
      const srcSec = sourceTime(clip, frameInClip, fps);
      const secPerPx = clip.speed / (ppf * fps);
      let i0 = Math.floor(srcSec * res);
      let i1 = Math.floor((srcSec + secPerPx) * res);
      if (i1 < i0) [i0, i1] = [i1, i0];
      if (i1 === i0) i1 = i0 + 1;
      let mn = 1,
        mx = -1;
      for (let i = Math.max(0, i0); i < Math.min(n, i1); i++) {
        if (pk[i * 2] < mn) mn = pk[i * 2];
        if (pk[i * 2 + 1] > mx) mx = pk[i * 2 + 1];
      }
      if (mn > mx) continue;
      const y0 = mid - Math.min(1, mx * gain) * (chH / 2 - 1);
      const y1 = mid - Math.max(-1, mn * gain) * (chH / 2 - 1);
      ctx.rect(x, y0, 1, Math.max(1, y1 - y0));
    }
    ctx.fill();
  }
}
