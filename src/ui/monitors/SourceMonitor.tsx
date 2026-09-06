import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useProject, findAsset } from '../../state/projectStore';
import { useUI } from '../../state/uiStore';
import { IconButton, TimecodeField, useElementSize, Select, Empty } from '../controls';
import { cmd } from '../../app/commands';
import { getMedia, onMediaChange, isVideoAsset } from '../../engine/media/mediaStore';
import { assetPoster } from '../timeline/thumbnails';
import { getSharedAudioContext, resumeAudio } from '../../engine/audio/audioContext';
import { MIME_ASSETS, MIME_SOURCE, useTimelineView } from '../timeline/timelineState';
import { clamp } from '../../engine/util';
import { Scrubber } from './ProgramMonitor';
import { usePlayback } from '../../engine/playback/playback';
import type { MediaAsset, Sequence } from '../../types/project';
import { Icon } from '../icons';
import { PEAK_RES } from '../../engine/media/mediaStore';

/** Source monitor: previews one project item, marks in/out on it and drags it to the timeline. */
export function SourceMonitor() {
  const project = useProject((s) => s.project);
  const assetId = useUI((s) => s.sourceAssetId);
  const time = useUI((s) => s.sourceTime);
  const setTime = useUI((s) => s.setSourceTime);
  const sourceMode = useUI((s) => s.sourceMode);
  const setSourceMode = useUI((s) => s.setSourceMode);
  const asset = assetId ? findAsset(project, assetId) : null;
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);
  const [mediaTick, setMediaTick] = useState(0);
  const [loop, setLoop] = useState(false);
  const audioNode = useRef<{ src: AudioBufferSourceNode; startedAt: number; from: number } | null>(null);
  const fps = asset?.fps && asset.fps > 0 ? asset.fps : 30;
  const dur = asset?.duration ?? (asset ? 5 : 0);
  const durFrames = Math.max(1, Math.round(dur * fps));
  const recent = useUI((s) => s.recentSources);

  useEffect(() => onMediaChange(() => setMediaTick((t) => t + 1)), []);

  // Geometry
  const geom = useMemo(() => {
    if (!asset || !size.width || !size.height) return { w: 0, h: 0, x: 0, y: 0 };
    const aw = asset.width || 1920,
      ah = asset.height || 1080;
    const ar = asset.kind === 'audio' ? 16 / 9 : aw / ah;
    const pad = 8;
    let w = size.width - pad * 2,
      h = w / ar;
    if (h > size.height - pad * 2) {
      h = size.height - pad * 2;
      w = h * ar;
    }
    return { w: Math.floor(w), h: Math.floor(h), x: Math.floor((size.width - w) / 2), y: Math.floor((size.height - h) / 2) };
  }, [asset?.id, asset?.width, asset?.height, size.width, size.height]);

  // Draw the current frame
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !asset || !geom.w) return;
    let cancelled = false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(geom.w * dpr),
      H = Math.round(geom.h * dpr);
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
    }
    const ctx = cv.getContext('2d')!;
    const rec = getMedia(asset.id);
    (async () => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      if (asset.kind === 'audio' || sourceMode === 'audio') {
        drawWaveformFull(ctx, rec?.peaks, W, H, time / Math.max(0.01, dur));
        return;
      }
      if (rec?.video) {
        try {
          const img = await rec.video.getFrame(time);
          if (cancelled || !img) return;
          ctx.drawImage(img as CanvasImageSource, 0, 0, W, H);
          if ((img as VideoFrame).close && rec.video.kind === 'webcodecs') (img as VideoFrame).close();
          return;
        } catch {
          /* fall through */
        }
      }
      const poster = await assetPoster(asset, W, H, time);
      if (cancelled || !poster) return;
      ctx.drawImage(poster, 0, 0, W, H);
    })();
    return () => {
      cancelled = true;
    };
  }, [asset?.id, time, geom, mediaTick, sourceMode]);

  // Playback loop (video via rAF, audio via WebAudio)
  useEffect(() => {
    if (!playing || !asset) return;
    const rec = getMedia(asset.id);
    const ac = getSharedAudioContext();
    resumeAudio();
    const from = time >= dur - 1 / fps ? 0 : time;
    const t0 = performance.now();
    if (rec?.audio && sourceMode !== 'video') {
      const src = ac.createBufferSource();
      src.buffer = rec.audio;
      src.connect(ac.destination);
      src.start(0, from);
      audioNode.current = { src, startedAt: ac.currentTime, from };
    }
    let raf = 0;
    const tick = () => {
      const elapsed = (performance.now() - t0) / 1000;
      let t = from + elapsed;
      const end = asset.srcOut != null && loop ? asset.srcOut : dur;
      if (t >= end) {
        if (loop) {
          setPlaying(false);
          setTimeout(() => {
            setTime(asset.srcIn ?? 0);
            setPlaying(true);
          }, 0);
          return;
        }
        setTime(Math.max(0, end - 1 / fps));
        setPlaying(false);
        return;
      }
      setTime(Math.round(t * fps) / fps);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      try {
        audioNode.current?.src.stop();
      } catch {
        /* already stopped */
      }
      audioNode.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, asset?.id]);

  useEffect(() => setPlaying(false), [asset?.id]);

  const frame = Math.round(time * fps);
  const seek = (f: number) => {
    setPlaying(false);
    setTime(clamp(f, 0, durFrames - 1) / fps);
  };

  const setIn = () => {
    if (!asset) return;
    useProject.getState().update('Source in', (p) => {
      const a = p.assets.find((x) => x.id === asset.id)!;
      a.srcIn = time;
      if (a.srcOut != null && a.srcOut <= time) a.srcOut = undefined;
    });
  };
  const setOut = () => {
    if (!asset) return;
    useProject.getState().update('Source out', (p) => {
      const a = p.assets.find((x) => x.id === asset.id)!;
      a.srcOut = time;
      if (a.srcIn != null && a.srcIn >= time) a.srcIn = undefined;
    });
  };
  const clearInOut = () => {
    if (!asset) return;
    useProject.getState().update('Clear source in/out', (p) => {
      const a = p.assets.find((x) => x.id === asset.id)!;
      a.srcIn = undefined;
      a.srcOut = undefined;
    });
  };

  const onDragStart = (e: React.DragEvent, part: 'composite' | 'video' | 'audio') => {
    if (!asset) return;
    e.dataTransfer.setData(MIME_ASSETS, JSON.stringify([asset.id]));
    e.dataTransfer.setData(MIME_SOURCE, JSON.stringify({ assetId: asset.id, part, srcIn: asset.srcIn ?? 0, srcOut: asset.srcOut ?? dur }));
    e.dataTransfer.effectAllowed = 'copy';
    useTimelineView.getState().setExternalDrag({ kind: 'asset', ids: [asset.id], part });
  };
  const onDragEnd = () => useTimelineView.getState().setExternalDrag(null);

  const pseudoSeq = useMemo<Sequence | null>(() => {
    if (!asset) return null;
    return { inPoint: asset.srcIn != null ? Math.round(asset.srcIn * fps) : null, outPoint: asset.srcOut != null ? Math.round(asset.srcOut * fps) : null, markers: [] } as unknown as Sequence;
  }, [asset?.srcIn, asset?.srcOut, asset?.id, fps]);

  const recentOptions = recent.map((id) => ({ value: id, label: findAsset(project, id)?.name ?? '(deleted)' })).filter((o) => o.label !== '(deleted)');

  return (
    <div className="monitor source">
      <div className="mon-toolbar">
        {recentOptions.length ? (
          <Select value={assetId ?? ''} options={[{ value: '', label: 'Source: (none)' }, ...recentOptions]} onChange={(v) => useUI.getState().setSourceAssetId(v || null)} style={{ maxWidth: 220, height: 18, fontSize: 11 }} title="Recent source clips" />
        ) : (
          <span style={{ color: 'var(--c-text-dim)' }}>Source</span>
        )}
        <div className="spacer" />
        {asset && asset.kind !== 'image' ? (
          <div className="seg" role="group" aria-label="Source display">
            <button type="button" className={sourceMode === 'composite' ? 'on' : ''} onClick={() => setSourceMode('composite')} title="Show video">Video</button>
            <button type="button" className={sourceMode === 'audio' ? 'on' : ''} onClick={() => setSourceMode('audio')} title="Show audio waveform">Audio</button>
          </div>
        ) : null}
        {asset ? <IconButton icon="close" label="Close source clip" sm onClick={() => useUI.getState().setSourceAssetId(null)} /> : null}
      </div>
      <div ref={wrapRef} className="viewport" onDoubleClick={() => asset && cmd.revealAsset(asset.id)}>
        {asset ? (
          <canvas ref={canvasRef} style={{ left: geom.x, top: geom.y, width: geom.w, height: geom.h }} draggable onDragStart={(e) => onDragStart(e, 'composite')} onDragEnd={onDragEnd} title="Drag to the timeline to edit this clip in" />
        ) : (
          <Empty title="Source Monitor">Double-click a clip in the Project panel to load it here. Mark In and Out, then press , (comma) to insert or . (period) to overwrite into the sequence.</Empty>
        )}
      </div>
      <Scrubber seq={pseudoSeq} playhead={frame} dur={durFrames} onSeek={seek} markers={false} />
      <div className="transport">
        <TimecodeField frames={frame} fps={fps} onChange={seek} />
        <div className="center">
          <IconButton icon="markIn" label="Mark In (I)" onClick={setIn} disabled={!asset} />
          <IconButton icon="markOut" label="Mark Out (O)" onClick={setOut} disabled={!asset} />
          <IconButton icon="clearInOut" label="Clear In and Out" onClick={clearInOut} disabled={!asset || (asset.srcIn == null && asset.srcOut == null)} />
          <div className="vsep" />
          <IconButton icon="goIn" label="Go to In" onClick={() => asset && seek(Math.round((asset.srcIn ?? 0) * fps))} disabled={!asset} />
          <IconButton icon="stepBack" label="Step Back" onClick={() => seek(frame - 1)} disabled={!asset} />
          <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Stop' : 'Play'} lg onClick={() => asset && setPlaying(!playing)} disabled={!asset} />
          <IconButton icon="stepFwd" label="Step Forward" onClick={() => seek(frame + 1)} disabled={!asset} />
          <IconButton icon="goOut" label="Go to Out" onClick={() => asset && seek(Math.round((asset.srcOut ?? dur) * fps) - 1)} disabled={!asset} />
          <div className="vsep" />
          <IconButton icon="insert" label="Insert (,)" onClick={() => cmd.insertOverwriteFromSource('insert')} disabled={!asset} />
          <IconButton icon="overwrite" label="Overwrite (.)" onClick={() => cmd.insertOverwriteFromSource('overwrite')} disabled={!asset} />
          <IconButton icon="loop" label="Loop between In and Out" on={loop} onClick={() => setLoop(!loop)} />
        </div>
        {asset && asset.kind !== 'image' && asset.kind !== 'audio' ? (
          <span className="drag-handles" title="Drag only video or only audio to the timeline">
            <span draggable onDragStart={(e) => onDragStart(e, 'video')} onDragEnd={onDragEnd} className="handle" title="Drag video only"><Icon name="clipVideo" size={12} /></span>
            <span draggable onDragStart={(e) => onDragStart(e, 'audio')} onDragEnd={onDragEnd} className="handle" title="Drag audio only"><Icon name="clipAudio" size={12} /></span>
          </span>
        ) : null}
        <TimecodeField frames={asset ? Math.round(((asset.srcOut ?? dur) - (asset.srcIn ?? 0)) * fps) : 0} fps={fps} muted title="In to Out duration" />
      </div>
    </div>
  );
}

function drawWaveformFull(ctx: CanvasRenderingContext2D, peaks: Float32Array[] | undefined, W: number, H: number, progress: number) {
  ctx.fillStyle = '#121212';
  ctx.fillRect(0, 0, W, H);
  if (!peaks?.length) {
    ctx.fillStyle = '#5a5a5a';
    ctx.font = `${12 * (W / 600 + 0.5)}px Inter, sans-serif`;
    ctx.fillText('Decoding audio...', 12, H / 2);
    return;
  }
  const chans = peaks.length;
  const laneH = H / chans;
  for (let c = 0; c < chans; c++) {
    const pk = peaks[c];
    const n = pk.length / 2;
    const mid = laneH * c + laneH / 2;
    ctx.fillStyle = '#3f8f67';
    for (let x = 0; x < W; x++) {
      const i0 = Math.floor((x / W) * n),
        i1 = Math.max(i0 + 1, Math.floor(((x + 1) / W) * n));
      let mn = 1,
        mx = -1;
      for (let i = i0; i < i1 && i < n; i++) {
        mn = Math.min(mn, pk[i * 2]);
        mx = Math.max(mx, pk[i * 2 + 1]);
      }
      if (mx < mn) continue;
      ctx.fillRect(x, mid - mx * laneH * 0.48, 1, Math.max(1, (mx - mn) * laneH * 0.48));
    }
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(0, laneH * (c + 1) - 1, W, 1);
  }
  ctx.fillStyle = 'rgba(224,224,224,0.85)';
  ctx.fillRect(Math.round(progress * W), 0, 1, H);
  void PEAK_RES;
}

export function useSourceAsset(): MediaAsset | null {
  const project = useProject((s) => s.project);
  const assetId = useUI((s) => s.sourceAssetId);
  return (assetId ? findAsset(project, assetId) : null) ?? null;
}

export { isVideoAsset, usePlayback };
