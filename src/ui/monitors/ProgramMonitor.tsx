import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useProject, useActiveSequence, sequenceDuration, findAsset } from '../../state/projectStore';
import { useUI, type ContextMenuItem } from '../../state/uiStore';
import { usePlayback, presentTo, scheduleRender } from '../../engine/playback/playback';
import { IconButton, MenuButton, TimecodeField, useElementSize, Select } from '../controls';
import { cmd } from '../../app/commands';
import { Icon } from '../icons';
import type { Clip, Sequence } from '../../types/project';
import { evalParam } from '../../engine/keyframes';
import { clamp } from '../../engine/util';
import { MIME_ASSETS, useTimelineView } from '../timeline/timelineState';
import * as E from '../../engine/timeline/edits';
import { importFiles } from '../../engine/media/importer';
import { renderGraphic, layerBounds } from '../../engine/graphics/graphicRenderer';

const CHANNEL_INDEX: Record<string, number> = { rgb: 0, alpha: 1, r: 2, g: 3, b: 4, luma: 5 };

export function ProgramMonitor() {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const playhead = usePlayback((s) => s.playhead);
  const playing = usePlayback((s) => s.playing);
  const rate = usePlayback((s) => s.rate);
  const loop = usePlayback((s) => s.loop);
  const frameVersion = usePlayback((s) => s.frameVersion);
  const fpsActual = usePlayback((s) => s.fpsActual);
  const renderMs = usePlayback((s) => s.renderMs);
  const pb = usePlayback;
  const ui = useUI();
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [dragOver, setDragOver] = useState<'insert' | 'overwrite' | null>(null);
  const selection = useUI((s) => s.selection.clipIds);
  const fps = seq?.settings.fps ?? 30;
  const dur = seq ? sequenceDuration(seq) : 0;

  // Fit canvas into viewport
  const geom = useMemo(() => {
    if (!seq || !size.width || !size.height) return { w: 0, h: 0, x: 0, y: 0 };
    const zoom = ui.programZoom;
    const ar = seq.settings.width / seq.settings.height;
    let w: number, h: number;
    if (zoom === 'fit') {
      const pad = 8;
      w = size.width - pad * 2;
      h = w / ar;
      if (h > size.height - pad * 2) {
        h = size.height - pad * 2;
        w = h * ar;
      }
    } else {
      w = seq.settings.width * zoom;
      h = seq.settings.height * zoom;
    }
    return { w: Math.max(2, Math.floor(w)), h: Math.max(2, Math.floor(h)), x: Math.floor((size.width - w) / 2), y: Math.floor((size.height - h) / 2) };
  }, [seq?.settings.width, seq?.settings.height, size.width, size.height, ui.programZoom]);

  // Present latest render
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !seq || !geom.w) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(geom.w * dpr),
      ph = Math.round(geom.h * dpr);
    if (cv.width !== pw || cv.height !== ph) {
      cv.width = pw;
      cv.height = ph;
    }
    presentTo(cv, { channel: CHANNEL_INDEX[ui.programChannel], checker: ui.transparencyGrid, bg: [0, 0, 0] });
  }, [frameVersion, geom, seq?.id, ui.programChannel, ui.transparencyGrid]);

  useEffect(() => {
    scheduleRender(true);
  }, [seq?.id]);

  // Overlays: safe margins, grid, rulers, selection transform handles
  const selClip = useMemo(() => {
    if (!seq || selection.length !== 1) return null;
    const c = seq.clips.find((x) => x.id === selection[0]);
    if (!c) return null;
    const t = seq.tracks.find((x) => x.id === c.trackId);
    if (t?.kind !== 'video') return null;
    if (playhead < c.start || playhead >= c.start + c.duration) return null;
    return c;
  }, [seq, selection, playhead]);

  useEffect(() => {
    const cv = overlayRef.current;
    if (!cv || !seq || !geom.w) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(geom.w * dpr);
    cv.height = Math.round(geom.h * dpr);
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, geom.w, geom.h);
    const W = geom.w,
      H = geom.h;
    if (ui.programOverlay.includes('safeMargins')) {
      ctx.strokeStyle = 'rgba(224,224,224,0.55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(W * 0.05 + 0.5, H * 0.05 + 0.5, W * 0.9, H * 0.9);
      ctx.strokeRect(W * 0.1 + 0.5, H * 0.1 + 0.5, W * 0.8, H * 0.8);
      ctx.beginPath();
      ctx.moveTo(W / 2, H / 2 - 10);
      ctx.lineTo(W / 2, H / 2 + 10);
      ctx.moveTo(W / 2 - 10, H / 2);
      ctx.lineTo(W / 2 + 10, H / 2);
      ctx.stroke();
    }
    if (ui.programOverlay.includes('grid')) {
      ctx.strokeStyle = 'rgba(224,224,224,0.25)';
      ctx.beginPath();
      for (let i = 1; i < 3; i++) {
        ctx.moveTo((W * i) / 3 + 0.5, 0);
        ctx.lineTo((W * i) / 3 + 0.5, H);
        ctx.moveTo(0, (H * i) / 3 + 0.5);
        ctx.lineTo(W, (H * i) / 3 + 0.5);
      }
      ctx.stroke();
    }
    if (ui.programOverlay.includes('rulers')) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, W, 12);
      ctx.fillRect(0, 0, 12, H);
      ctx.fillStyle = '#c5c5c5';
      ctx.font = '380 9px "Inter Variable", Inter, sans-serif';
      const step = seq.settings.width >= 3000 ? 500 : 200;
      for (let px = 0; px <= seq.settings.width; px += step) {
        const x = (px / seq.settings.width) * W;
        ctx.fillRect(x, 8, 1, 4);
        ctx.fillText(String(px), x + 2, 8);
      }
      for (let py = 0; py <= seq.settings.height; py += step) {
        const y = (py / seq.settings.height) * H;
        ctx.fillRect(8, y, 4, 1);
        ctx.save();
        ctx.translate(8, y + 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'right';
        ctx.fillText(String(py), 0, 0);
        ctx.restore();
      }
    }
    if (selClip && !playing) drawTransformHandles(ctx, selClip, seq, project, W, H, playhead);
  }, [frameVersion, geom, ui.programOverlay, selClip, seq, project, playhead, playing]);

  /* ---------- direct manipulation (move / scale / rotate selected clip) ---------- */
  const dragRef = useRef<{ mode: 'move' | 'scale' | 'rotate'; startX: number; startY: number; pos: [number, number]; scale: number; rot: number; began: boolean; corner?: number } | null>(null);
  const onViewportDown = (e: React.PointerEvent) => {
    if (!seq || !selClip || playing || e.button !== 0) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    const box = clipBox(selClip, seq, project, playhead);
    const local = clamp01(nx, ny);
    void local;
    const hit = hitHandle(nx, ny, box, rect.width, rect.height);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    const m = selClip.motion;
    dragRef.current = { mode: hit.kind, startX: e.clientX, startY: e.clientY, pos: evalParam(m.position, playhead - selClip.start), scale: evalParam(m.scale, playhead - selClip.start), rot: evalParam(m.rotation, playhead - selClip.start), began: false, corner: hit.corner };
    useProject.getState().beginBatch(hit.kind === 'move' ? 'Move clip' : hit.kind === 'scale' ? 'Scale clip' : 'Rotate clip');
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      d.began = true;
      const dx = (ev.clientX - d.startX) / rect.width;
      const dy = (ev.clientY - d.startY) / rect.height;
      useProject.getState().updateTransient((p) => {
        const s = p.sequences.find((x) => x.id === seq.id)!;
        const c = s.clips.find((x) => x.id === selClip.id)!;
        const local = playhead - c.start;
        if (d.mode === 'move') {
          const v: [number, number] = ev.shiftKey ? (Math.abs(dx) > Math.abs(dy) ? [d.pos[0] + dx, d.pos[1]] : [d.pos[0], d.pos[1] + dy]) : [d.pos[0] + dx, d.pos[1] + dy];
          c.motion.position = writeKf(c.motion.position, local, v);
        } else if (d.mode === 'scale') {
          const cx = (d.pos[0] - 0.5) * rect.width + rect.width / 2;
          const cy = (d.pos[1] - 0.5) * rect.height + rect.height / 2;
          const r0 = Math.hypot(d.startX - rect.left - cx, d.startY - rect.top - cy);
          const r1 = Math.hypot(ev.clientX - rect.left - cx, ev.clientY - rect.top - cy);
          c.motion.scale = writeKf(c.motion.scale, local, clamp(d.scale * (r1 / Math.max(1, r0)), 1, 10000));
        } else {
          const cx = rect.left + d.pos[0] * rect.width;
          const cy = rect.top + d.pos[1] * rect.height;
          const a0 = Math.atan2(d.startY - cy, d.startX - cx);
          const a1 = Math.atan2(ev.clientY - cy, ev.clientX - cx);
          let deg = d.rot + ((a1 - a0) * 180) / Math.PI;
          if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
          c.motion.rotation = writeKf(c.motion.rotation, local, deg);
        }
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (dragRef.current?.began) useProject.getState().endBatch();
      else useProject.getState().cancelBatch();
      dragRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /* ---------- drop media onto the monitor: insert / overwrite ---------- */
  const onDragOver = (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types);
    if (!types.includes(MIME_ASSETS) && !types.includes('Files')) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setDragOver(e.clientX - r.left < r.width / 2 ? 'insert' : 'overwrite');
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const mode = dragOver ?? 'overwrite';
    setDragOver(null);
    const types = Array.from(e.dataTransfer.types);
    let assets = [] as any[];
    if (types.includes(MIME_ASSETS)) {
      const ids = JSON.parse(e.dataTransfer.getData(MIME_ASSETS)) as string[];
      assets = ids.map((id) => findAsset(project, id)).filter(Boolean);
    } else if (types.includes('Files')) {
      const created = await importFiles(Array.from(e.dataTransfer.files));
      await new Promise((r) => setTimeout(r, 400));
      const p = useProject.getState().project;
      assets = created.map((a) => findAsset(p, a.id)).filter(Boolean);
    }
    if (!assets.length) return;
    if (!seq) {
      cmd.newSequenceFromClip(assets[0]);
      return;
    }
    cmd.addClipsToSequenceAtPlayhead(assets, mode);
    useTimelineView.getState().setExternalDrag(null);
  };

  const ctxMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const items: ContextMenuItem[] = [
      { label: 'Playback Resolution', submenu: (['full', 'half', 'quarter'] as const).map((q) => ({ label: q === 'full' ? 'Full' : q === 'half' ? '1/2' : '1/4', checked: ui.programQuality === q, onSelect: () => ui.setProgramQuality(q) })) },
      { label: 'Display Mode', submenu: (['rgb', 'alpha', 'r', 'g', 'b', 'luma'] as const).map((c) => ({ label: { rgb: 'Composite (RGB)', alpha: 'Alpha', r: 'Red channel', g: 'Green channel', b: 'Blue channel', luma: 'Luma' }[c], checked: ui.programChannel === c, onSelect: () => ui.setProgramChannel(c) })) },
      { label: 'Transparency Grid', checked: ui.transparencyGrid, onSelect: () => ui.setTransparencyGrid(!ui.transparencyGrid) },
      { separator: true },
      { label: 'Safe Margins', checked: ui.programOverlay.includes('safeMargins'), onSelect: () => ui.toggleProgramOverlay('safeMargins') },
      { label: 'Rule of Thirds Grid', checked: ui.programOverlay.includes('grid'), onSelect: () => ui.toggleProgramOverlay('grid') },
      { label: 'Rulers', checked: ui.programOverlay.includes('rulers'), onSelect: () => ui.toggleProgramOverlay('rulers') },
      { separator: true },
      { label: 'Export Frame...', shortcut: 'Ctrl+Shift+E', onSelect: () => void cmd.exportFrame() },
      { label: 'Loop Playback', checked: loop, onSelect: () => pb.getState().setLoop(!loop) },
    ];
    useUI.getState().openContextMenu(e.clientX, e.clientY, items);
  };

  const zoomOptions = [
    { value: 'fit', label: 'Fit' },
    { value: '0.25', label: '25%' },
    { value: '0.5', label: '50%' },
    { value: '1', label: '100%' },
    { value: '2', label: '200%' },
  ];

  const hasContent = !!seq && (seq.clips.length > 0 || seq.captions.length > 0);

  return (
    <div className="monitor program" onContextMenu={ctxMenu}>
      <div className="mon-toolbar">
        <span style={{ color: 'var(--c-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{seq ? seq.name : 'No sequence'}</span>
        <div className="spacer" />
        <Select value={String(ui.programZoom)} options={zoomOptions} onChange={(v) => ui.setProgramZoom(v === 'fit' ? 'fit' : Number(v))} style={{ width: 62, height: 18, fontSize: 11 }} title="Zoom level" />
        <Select value={ui.programQuality} options={[{ value: 'full', label: 'Full' }, { value: 'half', label: '1/2' }, { value: 'quarter', label: '1/4' }]} onChange={(v) => ui.setProgramQuality(v as any)} style={{ width: 58, height: 18, fontSize: 11 }} title="Playback resolution" />
        <IconButton icon="safeMargins" label="Safe margins" sm on={ui.programOverlay.includes('safeMargins')} onClick={() => ui.toggleProgramOverlay('safeMargins')} />
        <IconButton icon="grid" label="Grid" sm on={ui.programOverlay.includes('grid')} onClick={() => ui.toggleProgramOverlay('grid')} />
        <IconButton icon="transparent" label="Transparency grid" sm on={ui.transparencyGrid} onClick={() => ui.setTransparencyGrid(!ui.transparencyGrid)} />
        <MenuButton icon="settings" label="Monitor settings" className="ibtn sm" items={() => [
          { label: 'Display Mode', submenu: (['rgb', 'alpha', 'r', 'g', 'b', 'luma'] as const).map((c) => ({ label: { rgb: 'Composite (RGB)', alpha: 'Alpha', r: 'Red', g: 'Green', b: 'Blue', luma: 'Luma' }[c], checked: ui.programChannel === c, onSelect: () => ui.setProgramChannel(c) })) },
          { label: 'Rulers', checked: ui.programOverlay.includes('rulers'), onSelect: () => ui.toggleProgramOverlay('rulers') },
          { separator: true },
          { label: `Render ${renderMs.toFixed(1)} ms / frame`, disabled: true },
        ]} />
      </div>
      <div ref={wrapRef} className={`viewport ${dragOver ? 'dragover' : ''}`} onDragOver={onDragOver} onDragLeave={() => setDragOver(null)} onDrop={onDrop} onPointerDown={onViewportDown}>
        {seq ? (
          <>
            <canvas ref={canvasRef} style={{ left: geom.x, top: geom.y, width: geom.w, height: geom.h }} />
            <canvas ref={overlayRef} className="overlay-svg" style={{ left: geom.x, top: geom.y, width: geom.w, height: geom.h }} />
            {!hasContent && !dragOver ? (
              <div className="empty-mon" style={{ position: 'absolute' }}>
                <div className="big">{seq.name}</div>
                {seq.settings.width} x {seq.settings.height} at {seq.settings.fps} fps
                <br />
                Drop media here to insert (left half) or overwrite (right half) at the playhead.
              </div>
            ) : null}
          </>
        ) : (
          <div className="empty-mon">
            <div className="big">No sequence</div>
            Drop a clip here to create a sequence that matches it.
          </div>
        )}
        {dragOver ? (
          <div className="drop-zones">
            <div className={dragOver === 'insert' ? 'hot' : ''}>Insert</div>
            <div className={dragOver === 'overwrite' ? 'hot' : ''}>Overwrite</div>
          </div>
        ) : null}
      </div>
      <Scrubber seq={seq} playhead={playhead} dur={dur} onSeek={(f) => pb.getState().setPlayhead(f, { fromUser: true })} />
      <div className="transport">
        <TimecodeField frames={playhead} fps={fps} dropFrame={seq?.settings.dropFrame} onChange={(f) => pb.getState().setPlayhead(f, { fromUser: true })} />
        <span className="rate-badge">{playing && rate !== 1 ? `${rate > 0 ? '' : '-'}${Math.abs(rate)}x` : ''}</span>
        <div className="center">
          <IconButton icon="markIn" label="Mark In (I)" onClick={() => cmd.markIn()} />
          <IconButton icon="markOut" label="Mark Out (O)" onClick={() => cmd.markOut()} />
          <IconButton icon="marker" label="Add Marker (M)" onClick={() => cmd.addMarker()} />
          <div className="vsep" />
          <IconButton icon="goIn" label="Go to In (Shift+I)" onClick={() => cmd.goTo('in')} />
          <IconButton icon="prevEdit" label="Go to Previous Edit (Up)" onClick={() => cmd.goTo('prevEdit')} />
          <IconButton icon="stepBack" label="Step Back (Left)" onClick={() => pb.getState().step(-1)} />
          <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Stop (Space)' : 'Play (Space)'} lg onClick={() => pb.getState().toggle()} />
          <IconButton icon="stepFwd" label="Step Forward (Right)" onClick={() => pb.getState().step(1)} />
          <IconButton icon="nextEdit" label="Go to Next Edit (Down)" onClick={() => cmd.goTo('nextEdit')} />
          <IconButton icon="goOut" label="Go to Out (Shift+O)" onClick={() => cmd.goTo('out')} />
          <div className="vsep" />
          <IconButton icon="lift" label="Lift (;)" onClick={() => cmd.liftExtract(false)} />
          <IconButton icon="extract" label="Extract (')" onClick={() => cmd.liftExtract(true)} />
          <IconButton icon="loop" label="Loop Playback" on={loop} onClick={() => pb.getState().setLoop(!loop)} />
          <IconButton icon="frameExport" label="Export Frame (Ctrl+Shift+E)" onClick={() => void cmd.exportFrame()} />
        </div>
        <span className="badge-dim" title="Actual playback frame rate / render time">
          {playing ? `${fpsActual.toFixed(0)} fps` : `${renderMs.toFixed(0)} ms`}
        </span>
        <TimecodeField frames={dur} fps={fps} dropFrame={seq?.settings.dropFrame} muted title="Sequence duration" />
      </div>
    </div>
  );
}

export function Scrubber({ seq, playhead, dur, onSeek, markers = true }: { seq: Sequence | null; playhead: number; dur: number; onSeek: (f: number) => void; markers?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const total = Math.max(dur, 1);
  const pos = (f: number) => `${clamp((f / total) * 100, 0, 100)}%`;
  const seek = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    onSeek(Math.round(clamp((clientX - r.left) / r.width, 0, 1) * total));
  };
  return (
    <div
      ref={ref}
      className="scrub"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        seek(e.clientX);
        const move = (ev: PointerEvent) => seek(ev.clientX);
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    >
      {seq?.inPoint != null || seq?.outPoint != null ? <div className="range" style={{ left: pos(seq.inPoint ?? 0), width: `calc(${pos(seq.outPoint ?? dur)} - ${pos(seq.inPoint ?? 0)})` }} /> : null}
      {markers && seq ? seq.markers.map((m) => <div key={m.id} className="mk" style={{ left: pos(m.time) }} />) : null}
      <div className="head" style={{ left: pos(playhead) }} />
    </div>
  );
}

/* ---------- transform overlay helpers ---------- */

function clipBox(clip: Clip, seq: Sequence, project: { assets: any[] }, frame: number) {
  const local = frame - clip.start;
  const m = clip.motion;
  const pos = evalParam(m.position, local);
  const scale = evalParam(m.scale, local) / 100;
  const sw = m.uniformScale ? scale : evalParam(m.scaleWidth, local) / 100;
  const rot = evalParam(m.rotation, local);
  const anchor = evalParam(m.anchor, local);
  const asset = project.assets.find((a) => a.id === clip.assetId);
  const aw = asset?.width ?? seq.settings.width,
    ah = asset?.height ?? seq.settings.height;
  return { pos, w: (aw * sw) / seq.settings.width, h: (ah * scale) / seq.settings.height, rot, anchor };
}

function corners(box: ReturnType<typeof clipBox>, W: number, H: number) {
  const cx = box.pos[0] * W,
    cy = box.pos[1] * H;
  const hw = (box.w * W) / 2,
    hh = (box.h * H) / 2;
  const r = (box.rot * Math.PI) / 180;
  const ax = (box.anchor[0] - 0.5) * box.w * W,
    ay = (box.anchor[1] - 0.5) * box.h * H;
  const pts = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => {
    const px = x - ax,
      py = y - ay;
    return [cx + px * Math.cos(r) - py * Math.sin(r), cy + px * Math.sin(r) + py * Math.cos(r)];
  });
  return { pts, cx, cy };
}

function drawTransformHandles(ctx: CanvasRenderingContext2D, clip: Clip, seq: Sequence, project: { assets: any[] }, W: number, H: number, frame: number) {
  const box = clipBox(clip, seq, project, frame);
  const { pts, cx, cy } = corners(box, W, H);
  ctx.strokeStyle = 'rgba(224,224,224,0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = '#e0e0e0';
  for (const [x, y] of pts) ctx.fillRect(x - 3, y - 3, 6, 6);
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.stroke();
  // graphic layer boxes
  if (clip.generator === 'graphic' && clip.graphic) {
    const gctx = document.createElement('canvas').getContext('2d')!;
    ctx.save();
    ctx.scale(W / seq.settings.width, H / seq.settings.height);
    ctx.strokeStyle = 'rgba(61,123,217,0.9)';
    ctx.lineWidth = seq.settings.width / W;
    ctx.setLineDash([6 * (seq.settings.width / W), 4 * (seq.settings.width / W)]);
    for (const l of clip.graphic.layers) {
      if (!l.visible) continue;
      const b = layerBounds(gctx, l, frame - clip.start);
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    }
    ctx.restore();
  }
  void renderGraphic;
}

function hitHandle(nx: number, ny: number, box: ReturnType<typeof clipBox>, W: number, H: number): { kind: 'move' | 'scale' | 'rotate'; corner?: number } | null {
  const { pts } = corners(box, W, H);
  const px = nx * W,
    py = ny * H;
  for (let i = 0; i < 4; i++) {
    if (Math.abs(pts[i][0] - px) < 7 && Math.abs(pts[i][1] - py) < 7) return { kind: 'scale', corner: i };
  }
  // rotate: just outside the corners
  for (let i = 0; i < 4; i++) {
    if (Math.abs(pts[i][0] - px) < 18 && Math.abs(pts[i][1] - py) < 18) return { kind: 'rotate', corner: i };
  }
  // inside polygon
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = pts[i],
      [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside ? { kind: 'move' } : null;
}

function clamp01(x: number, y: number): [number, number] {
  return [clamp(x, 0, 1), clamp(y, 0, 1)];
}

function writeKf<T extends number | [number, number]>(p: { value: T; keyframes?: any[]; animated?: boolean }, local: number, v: T) {
  if (p.animated || p.keyframes?.length) {
    const kfs = (p.keyframes ?? []).filter((k) => k.t !== local);
    kfs.push({ t: local, v, interp: 'linear' });
    kfs.sort((a, b) => a.t - b.t);
    return { ...p, keyframes: kfs, animated: true };
  }
  return { ...p, value: v };
}

export { E };
