import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUI, toast, type ModalRequest } from '../../state/uiStore';
import { useProject, useActiveSequence } from '../../state/projectStore';
import { usePlayback, renderFrameToCanvas } from '../../engine/playback/playback';
import { Modal, Button, IconButton, Select, Segmented, Empty } from '../controls';
import { Icon } from '../icons';
import { cmd, type TrackTarget } from '../../app/commands';
// The small pure helpers are imported statically (they are a few hundred bytes
// and are needed to describe tracks already on the clip); the analysis driver is
// imported on demand the moment the user presses Track, so the frame-by-frame
// matcher stays out of the main bundle until it is actually used.
import { trackQuality, trackReliability } from '../../engine/track/trackMaths';
import { getEffectDef } from '../../engine/effects/registry';
import type { Clip, Id, TrackAnalysis } from '../../types/project';

type P = { modal: ModalRequest; close: () => void };

interface Seed {
  x: number;
  y: number;
}

/**
 * Point / planar tracker.
 *
 * The whole point of this dialog is that the user never has to know what a
 * homography or a ZNCC score is: they click the thing they want to follow, press
 * Track, and then choose what should ride along with it.
 */
export function TrackerModal({ modal, close }: P) {
  const project = useProject((s) => s.project);
  const seq = useActiveSequence();
  const selection = useUI((s) => s.selection.clipIds);

  const [mode, setMode] = useState<'point' | 'planar'>('point');
  const [seeds, setSeeds] = useState<Seed[]>([]);
  const [tracking, setTracking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<TrackAnalysis | null>(null);
  const [target, setTarget] = useState<string>('');
  const cancelRef = useRef(false);

  const frameCanvas = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [previewSize, setPreviewSize] = useState({ w: 0, h: 0 });

  /* ---------- which clip ---------- */
  const clip: Clip | null = useMemo(() => {
    if (!seq) return null;
    const fromPayload = modal.payload?.clipId as Id | undefined;
    const ids = fromPayload ? [fromPayload, ...selection] : selection;
    for (const id of ids) {
      const c = seq.clips.find((x) => x.id === id);
      if (c && seq.tracks.find((t) => t.id === c.trackId)?.kind === 'video') return c;
    }
    return null;
  }, [seq, selection, modal.payload?.clipId]);

  const playhead = usePlayback((s) => s.playhead);
  const fps = seq?.settings.fps ?? 30;

  /* ---------- render the frame under the cursor ---------- */
  const drawFrame = useCallback(async () => {
    if (!seq || !clip) return;
    const cv = frameCanvas.current ?? document.createElement('canvas');
    frameCanvas.current = cv;
    const f = Math.max(clip.start, Math.min(clip.start + clip.duration - 1, playhead));
    // Effects are OFF on purpose: analyzeTrack matches against the un-effected
    // clip, so the picture here must be the very pixels being matched. Showing a
    // graded or blurred frame would let the user click a spot the tracker will
    // never see, and the path would look wrong for no visible reason.
    await renderFrameToCanvas(project, seq, f, cv, { soloClipId: clip.id, effects: false, captions: false, scale: 2 });
    setPreviewSize({ w: cv.width, h: cv.height });
  }, [seq, clip, project, playhead]);

  useEffect(() => {
    void drawFrame();
  }, [drawFrame]);

  /* ---------- overlay: seeds, tracked path, quality flags ---------- */
  useEffect(() => {
    const cv = overlayRef.current;
    const src = frameCanvas.current;
    if (!cv || !src || !src.width) return;
    cv.width = src.width;
    cv.height = src.height;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const W = cv.width;
    const H = cv.height;

    // Tracked path, colour-coded by confidence so a stretch where the feature was
    // occluded is visible at a glance instead of silently coasting.
    if (result) {
      const n = result.positions.length;
      for (let p = 0; p < (result.seed.length || 1); p++) {
        ctx.lineWidth = p === 0 ? 2 : 1;
        for (let i = 1; i < n; i++) {
          const a = result.positions[i - 1]?.[p];
          const b = result.positions[i]?.[p];
          if (!a || !b) continue;
          const c = result.confidence[i] ?? 0;
          ctx.strokeStyle = c > 0.7 ? 'rgba(80,220,120,0.95)' : c > 0.4 ? 'rgba(250,200,60,0.95)' : 'rgba(250,90,80,0.95)';
          ctx.beginPath();
          ctx.moveTo(a[0] * W, a[1] * H);
          ctx.lineTo(b[0] * W, b[1] * H);
          ctx.stroke();
        }
        // Planar: draw the quad outline of the final frame.
        if (result.kind === 'planar' && p === 0) {
          const last = result.positions[n - 1];
          if (last?.length === 4) {
            ctx.strokeStyle = 'rgba(120,190,255,0.9)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let k = 0; k <= 4; k++) {
              const q = last[k % 4];
              if (k === 0) ctx.moveTo(q[0] * W, q[1] * H);
              else ctx.lineTo(q[0] * W, q[1] * H);
            }
            ctx.stroke();
          }
        }
      }
    }

    // Seed markers.
    seeds.forEach((s, i) => {
      const x = s.x * W;
      const y = s.y * H;
      ctx.strokeStyle = '#fff';
      ctx.fillStyle = 'rgba(255,80,80,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 3;
      const label = mode === 'planar' ? ['TL', 'TR', 'BR', 'BL'][i] ?? String(i + 1) : String(i + 1);
      ctx.strokeText(label, x + 10, y - 8);
      ctx.fillText(label, x + 10, y - 8);
    });
  }, [seeds, result, previewSize, mode]);

  /* ---------- picking ---------- */
  const onPick = (e: React.PointerEvent) => {
    if (tracking) return;
    const cv = overlayRef.current;
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    setResult(null);
    setSeeds((prev) => {
      const max = mode === 'planar' ? 4 : 1;
      const next = [...prev, { x, y }];
      return next.length > max ? next.slice(next.length - max) : next;
    });
  };

  /* ---------- targets ---------- */
  const targets = useMemo(() => {
    if (!clip || !seq) return [] as { value: string; label: string; group: string; target: TrackTarget }[];
    const out: { value: string; label: string; group: string; target: TrackTarget }[] = [];
    for (const fx of clip.effects) {
      if (!fx.enabled) continue;
      const def = getEffectDef(fx.type);
      if (!def) continue;
      if (def.audio) continue;
      if (fx.type === 'cornerPin') {
        out.push({ value: `cp:${fx.id}`, label: `Corner Pin (all four corners)`, group: 'Effects', target: { type: 'cornerPin', effectId: fx.id } });
        continue;
      }
      for (const pd of def.params) {
        if (pd.kind !== 'point') continue;
        out.push({
          value: `fx:${fx.id}:${pd.key}`,
          label: `${def.name} \u203A ${pd.label}`,
          group: 'Effects',
          target: { type: 'effect', effectId: fx.id, paramKey: pd.key },
        });
      }
      for (const m of fx.masks) {
        out.push({ value: `mk:${fx.id}:${m.id}`, label: `${def.name} \u203A mask "${m.name}"`, group: 'Effect masks', target: { type: 'mask', effectId: fx.id, maskId: m.id } });
      }
    }
    for (const l of clip.graphic?.layers ?? []) {
      out.push({ value: `gl:${l.id}`, label: `${l.name} position`, group: 'Graphic layers', target: { type: 'graphicLayer', layerId: l.id } });
    }
    return out;
  }, [clip, seq]);

  const existing = clip?.tracks ?? [];
  const ready = seeds.length === (mode === 'planar' ? 4 : 1);

  const runTrack = async () => {
    if (!seq || !clip || !ready) return;
    setTracking(true);
    setProgress(0);
    setResult(null);
    cancelRef.current = false;
    const opts: import('../../engine/track/pointTracker').TrackOptions = { planar: mode === 'planar' };
    const seed = seeds.map((s) => [s.x, s.y] as [number, number]);
    try {
      const { analyzeTrack } = await import('../../engine/track/pointTracker');
      const ta = await analyzeTrack(project, seq, clip, seed, mode, opts, (p) => setProgress(p.done / Math.max(1, p.total)), () => cancelRef.current);
      if (!ta) {
        if (!cancelRef.current) toast('error', 'Tracking failed', 'The clip could not be analysed. It may be too short or its media may be offline.');
        return;
      }
      ta.name = mode === 'planar' ? `Planar track ${existing.length + 1}` : `Point track ${existing.length + 1}`;
      setResult(ta);
      cmd.savePointTrack(clip.id, ta);
      const q = trackQuality(ta);
      if (q < 0.5) {
        toast('warning', 'Track quality is low', `Only ${Math.round(trackReliability(ta) * 100)}% of frames matched well. The feature may be too small, too flat, or leaves the frame. Check the red sections of the path.`);
      } else {
        toast('success', 'Track complete', `${ta.frames.length} frames analysed, ${Math.round(q * 100)}% average match.`);
      }
    } catch (err) {
      toast('error', 'Tracking failed', err instanceof Error ? err.message : String(err));
    } finally {
      setTracking(false);
    }
  };

  const apply = () => {
    if (!clip || !result || !target) return;
    const t = targets.find((x) => x.value === target);
    if (!t) return;
    if (t.target.type === 'cornerPin' && result.kind !== 'planar') {
      toast('error', 'Corner Pin needs a planar track', 'Switch to Four corners, click the four corners of the surface, and track again.');
      return;
    }
    cmd.applyPointTrack(clip.id, result.id, t.target);
  };

  const q = result ? trackQuality(result) : 0;
  const rel = result ? trackReliability(result) : 0;

  return (
    <Modal
      title="Point Tracker"
      icon="pin"
      onClose={close}
      width={820}
      footer={
        <>
          <span className="dim" style={{ fontSize: 11 }}>
            {clip ? clip.name || 'Selected clip' : 'No video clip selected'}
          </span>
          <div className="spacer" />
          {tracking ? <Button danger onClick={() => (cancelRef.current = true)}>Stop</Button> : null}
          <Button icon="pin" onClick={() => void runTrack()} disabled={!ready || tracking}>
            {tracking ? `Tracking... ${Math.round(progress * 100)}%` : mode === 'planar' ? 'Track four corners' : 'Track forward'}
          </Button>
          <Button primary icon="ok" onClick={apply} disabled={!result || !target || tracking}>
            Apply
          </Button>
        </>
      }
    >
      {!clip ? (
        <Empty icon="pin" title="Select a video clip first">
          <div style={{ fontSize: 11, maxWidth: 380 }}>
            Click the clip you want to track in the timeline, then reopen this dialog. Tracking follows something inside
            that clip&rsquo;s picture, so it only works on video.
          </div>
        </Empty>
      ) : (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ flex: '0 0 460px' }}>
            <div
              style={{ position: 'relative', background: '#000', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)', cursor: tracking ? 'default' : 'crosshair' }}
              onPointerDown={onPick}
            >
              <canvas ref={(el) => { if (el) frameCanvas.current = el; }} style={{ display: 'block', width: '100%' }} />
              <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
              {tracking ? (
                <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, background: 'rgba(255,255,255,0.15)' }}>
                  <div style={{ width: `${Math.round(progress * 100)}%`, height: '100%', background: 'var(--accent)' }} />
                </div>
              ) : null}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <Segmented
                value={mode}
                options={[
                  { value: 'point', label: 'Single point', title: 'Follow one spot - good for pinning a callout, an arrow or a censor blur to a moving object.' },
                  { value: 'planar', label: 'Four corners', title: 'Follow a flat surface by its four corners - needed for Corner Pin, e.g. replacing a phone or TV screen.' },
                ]}
                onChange={(v) => {
                  setMode(v);
                  setSeeds([]);
                  setResult(null);
                }}
              />
              <div className="spacer" />
              <IconButton icon="reset" label="Clear the points you clicked" sm onClick={() => { setSeeds([]); setResult(null); }} />
              <IconButton icon="refresh" label="Re-render this frame" sm onClick={() => void drawFrame()} />
            </div>
            <p className="dim" style={{ fontSize: 11, lineHeight: 1.55, marginTop: 8 }}>
              {mode === 'planar'
                ? `Click the four corners of the flat surface you want to follow, in order: ${['top left', 'top right', 'bottom right', 'bottom left'].slice(seeds.length, seeds.length + 1)[0] ?? 'done'}.`
                : 'Click the thing you want to follow. Pick a spot with clear detail and good contrast - a plain sky or a blank wall has nothing for the tracker to hold onto.'}
            </p>
            {result ? (
              <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.6 }}>
                <div>
                  <b>Match quality {Math.round(q * 100)}%</b> &middot; {Math.round(rel * 100)}% of frames tracked cleanly &middot;{' '}
                  {result.frames.length} frames analysed
                </div>
                <div className="dim">
                  Path colour: <span style={{ color: 'rgb(80,220,120)' }}>green</span> = solid match,{' '}
                  <span style={{ color: 'rgb(250,200,60)' }}>amber</span> = weak,{' '}
                  <span style={{ color: 'rgb(250,90,80)' }}>red</span> = lost, carried on by prediction.
                </div>
              </div>
            ) : null}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Apply the track to</div>
            <Select
              value={target}
              options={
                targets.length
                  ? [{ value: '', label: 'Choose what should follow the motion...' }, ...targets]
                  : [{ value: '', label: 'Nothing to drive yet - add an effect first' }]
              }
              onChange={setTarget}
              disabled={!targets.length}
            />
            <p className="dim" style={{ fontSize: 11, lineHeight: 1.55, marginTop: 6 }}>
              This writes keyframes, so the motion is stored on the clip and survives trimming, retiming and moving it to
              another track.
            </p>
            {!targets.length ? (
              <div style={{ marginTop: 8, padding: 8, borderRadius: 4, background: 'var(--c-surface-2, rgba(255,255,255,0.04))', fontSize: 11, lineHeight: 1.55 }}>
                Add an effect with a position control first - for example <b>Drop Shadow</b>, <b>Gaussian Blur</b> with a
                mask, <b>Corner Pin</b>, or a graphic/title clip.
              </div>
            ) : null}

            <div style={{ fontSize: 11, fontWeight: 600, margin: '16px 0 4px' }}>Tracks on this clip</div>
            {!existing.length ? (
              <div className="dim" style={{ fontSize: 11 }}>
                None yet.
              </div>
            ) : (
              existing.map((t) => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 11 }}>
                  <Icon name={t.kind === 'planar' ? 'crop' : 'pin'} size={12} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.name}
                    <span className="dim"> &middot; {Math.round(trackQuality(t) * 100)}%</span>
                    {t.appliedTo ? <span className="dim"> &middot; applied</span> : null}
                  </span>
                  <IconButton icon="refresh" label="Load this track" sm onClick={() => { setResult(t); setSeeds(t.seed.map((s) => ({ x: s[0], y: s[1] }))); setMode(t.kind); }} />
                  <IconButton icon="resetParam" label="Remove the keyframes this track wrote" sm disabled={!t.appliedTo} onClick={() => cmd.clearPointTrack(clip.id, t.id)} />
                  <IconButton icon="error" label="Delete this track" sm onClick={() => { cmd.deletePointTrack(clip.id, t.id); if (result?.id === t.id) setResult(null); }} />
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
