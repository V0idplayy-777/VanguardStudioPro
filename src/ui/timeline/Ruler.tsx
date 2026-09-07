import React, { useEffect, useRef } from 'react';
import type { Sequence } from '../../types/project';
import { rulerIntervals, formatTime } from '../../engine/timecode';
import { useUI } from '../../state/uiStore';
import { useProject } from '../../state/projectStore';
import { usePlayback } from '../../engine/playback/playback';
import { usePointerDrag } from '../controls';
import { cmd } from '../../app/commands';

import { markerColor } from '../../types/project';

export function Ruler({ seq, ppf, scrollFrame, width, onPointerDown }: { seq: Sequence; ppf: number; scrollFrame: number; width: number; onPointerDown: (e: React.PointerEvent) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mode = useUI((s) => s.timecodeMode);
  const selMarkers = useUI((s) => s.selection.markerIds);
  const fps = seq.settings.fps;

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !width) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const h = 28;
    if (cv.width !== Math.round(width * dpr) || cv.height !== h * dpr) {
      cv.width = Math.round(width * dpr);
      cv.height = h * dpr;
    }
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);
    const { major, minor } = rulerIntervals(ppf, fps);
    ctx.font = '380 10px "Inter Variable", Inter, sans-serif';
    ctx.fillStyle = '#8d8d8d';
    ctx.strokeStyle = '#3d3d3d';
    ctx.textBaseline = 'top';
    const startF = Math.floor(scrollFrame / minor) * minor;
    const endF = scrollFrame + width / ppf;
    ctx.beginPath();
    for (let f = startF; f <= endF; f += minor) {
      const x = Math.round((f - scrollFrame) * ppf) + 0.5;
      const isMajor = Math.abs(f / major - Math.round(f / major)) < 1e-6;
      ctx.moveTo(x, isMajor ? 14 : 22);
      ctx.lineTo(x, h);
      if (isMajor) {
        const label = formatTime(Math.round(f), fps, mode === 'frames' ? 'frames' : mode === 'seconds' ? 'seconds' : 'timecode', seq.settings.dropFrame);
        ctx.fillText(mode === 'timecode' || mode === 'feet16' || mode === 'feet35' ? shortTc(label, major, fps) : label, x + 3, 3);
      }
    }
    ctx.stroke();
  }, [width, ppf, scrollFrame, fps, mode, seq.settings.dropFrame]);

  const frameAt = (clientX: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return Math.max(0, Math.round(scrollFrame + (clientX - r.left) / ppf));
  };

  const dragIn = usePointerDrag({
    onStart: () => useProject.getState().beginBatch('Set in point'),
    onMove: (d) => useProject.getState().updateTransient((p) => { const s = p.sequences.find((x) => x.id === seq.id)!; s.inPoint = Math.min(frameAt(d.x), (s.outPoint ?? Infinity) - 1); }),
    onEnd: () => useProject.getState().endBatch(),
    cursorClass: 'dragging-ew',
  });
  const dragOut = usePointerDrag({
    onStart: () => useProject.getState().beginBatch('Set out point'),
    onMove: (d) => useProject.getState().updateTransient((p) => { const s = p.sequences.find((x) => x.id === seq.id)!; s.outPoint = Math.max(frameAt(d.x), (s.inPoint ?? -1) + 1); }),
    onEnd: () => useProject.getState().endBatch(),
    cursorClass: 'dragging-ew',
  });

  const markerDown = (id: string, e: React.PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const ui = useUI.getState();
    ui.setSelection({ markerIds: e.shiftKey ? [...selMarkers, id] : [id], clipIds: [], transitionIds: [] });
    const start = seq.markers.find((m) => m.id === id)!.time;
    const x0 = e.clientX;
    let began = false;
    const move = (ev: PointerEvent) => {
      if (!began) {
        if (Math.abs(ev.clientX - x0) < 3) return;
        began = true;
        useProject.getState().beginBatch('Move marker');
      }
      useProject.getState().updateTransient((p) => {
        const m = p.sequences.find((x) => x.id === seq.id)!.markers.find((x) => x.id === id);
        if (m) m.time = Math.max(0, start + Math.round((ev.clientX - x0) / ppf));
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (began) useProject.getState().endBatch();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const ctx = (e: React.MouseEvent) => {
    e.preventDefault();
    const f = frameAt(e.clientX);
    const hit = seq.markers.find((m) => Math.abs(m.time - f) * ppf < 6);
    useUI.getState().openContextMenu(e.clientX, e.clientY, [
      ...(hit
        ? [
            { label: 'Edit Marker...', onSelect: () => useUI.getState().openModal({ kind: 'markerEdit', payload: { markerId: hit.id } }) },
            { label: 'Delete Marker', onSelect: () => useProject.getState().update('Delete marker', (p) => { const s = p.sequences.find((x) => x.id === seq.id)!; s.markers = s.markers.filter((m) => m.id !== hit.id); }) },
            { separator: true },
          ]
        : [{ label: 'Add Marker Here', onSelect: () => { const id = cmd.addMarker({ time: f }); void id; } }, { label: 'Add Chapter Marker Here', onSelect: () => cmd.addMarker({ time: f, kind: 'chapter', color: 'purple', name: 'Chapter' }) }, { separator: true }]),
      { label: 'Mark In Here', onSelect: () => useProject.getState().update('Mark in', (p) => { p.sequences.find((x) => x.id === seq.id)!.inPoint = f; }) },
      { label: 'Mark Out Here', onSelect: () => useProject.getState().update('Mark out', (p) => { p.sequences.find((x) => x.id === seq.id)!.outPoint = f; }) },
      { label: 'Clear In and Out', disabled: seq.inPoint == null && seq.outPoint == null, onSelect: () => cmd.clearInOut('both') },
      { separator: true },
      { label: 'Set Work Area to In/Out', disabled: seq.inPoint == null || seq.outPoint == null, onSelect: () => useProject.getState().update('Work area', (p) => { const s = p.sequences.find((x) => x.id === seq.id)!; s.workArea = { enabled: true, start: s.inPoint!, end: s.outPoint! }; }) },
      { label: 'Clear Work Area', disabled: !seq.workArea.enabled, onSelect: () => useProject.getState().update('Work area', (p) => { p.sequences.find((x) => x.id === seq.id)!.workArea.enabled = false; }) },
    ]);
  };

  const fx = (f: number) => (f - scrollFrame) * ppf;
  return (
    <div className="tl-ruler" onPointerDown={onPointerDown} onContextMenu={ctx} onDoubleClick={(e) => { const f = frameAt(e.clientX); cmd.addMarker({ time: f }); }} title="Click/drag to scrub. Double-click to add a marker.">
      <canvas ref={canvasRef} style={{ width, height: 28 }} />
      {seq.workArea.enabled ? <div className="workarea" style={{ left: fx(seq.workArea.start), width: (seq.workArea.end - seq.workArea.start) * ppf }} title="Work area" /> : null}
      {seq.inPoint != null || seq.outPoint != null ? (
        <div className="inout" style={{ left: fx(seq.inPoint ?? 0), width: ((seq.outPoint ?? scrollFrame + width / ppf) - (seq.inPoint ?? 0)) * ppf }}>
          {seq.inPoint != null ? <div className="handle in" onPointerDown={(e) => { e.stopPropagation(); dragIn(e); }} title="In point (drag)" /> : null}
          {seq.outPoint != null ? <div className="handle out" onPointerDown={(e) => { e.stopPropagation(); dragOut(e); }} title="Out point (drag)" /> : null}
        </div>
      ) : null}
      {seq.markers.map((m) => (
        <div
          key={m.id}
          className={['seq-marker', m.duration > 0 ? 'ranged' : '', selMarkers.includes(m.id) ? 'selected' : ''].filter(Boolean).join(' ')}
          style={{ left: fx(m.time), width: m.duration > 0 ? Math.max(6, m.duration * ppf) : undefined, background: markerColor(m) }}
          title={`${m.name || 'Marker'}${m.comment ? ' - ' + m.comment : ''}`}
          onPointerDown={(e) => markerDown(m.id, e)}
          onDoubleClick={(e) => { e.stopPropagation(); useUI.getState().openModal({ kind: 'markerEdit', payload: { markerId: m.id } }); }}
        />
      ))}
      <RulerPlayhead fx={fx} />
    </div>
  );
}

/** Drop leading zero groups when the interval is small enough that they never change on screen. */
function shortTc(label: string, major: number, fps: number) {
  if (major >= fps * 60) return label;
  return label.replace(/^00:/, '');
}


/** Playhead head in the ruler; subscribes so frame moves never re-render Ruler. */
function RulerPlayhead({ fx }: { fx: (f: number) => number }) {
  const ph = usePlayback((s) => s.playhead);
  return <div className="ph-head" style={{ left: fx(ph) }} />;
}
