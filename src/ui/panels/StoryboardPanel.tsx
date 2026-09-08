import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { findAsset, useActiveSequence, useProject } from '../../state/projectStore';
import { useUI } from '../../state/uiStore';
import { usePlayback } from '../../engine/playback/playback';
import { onMediaChange } from '../../engine/media/mediaStore';
import { thumbnailFor } from '../timeline/thumbnails';
import { MIME_ASSETS } from '../timeline/timelineState';
import { IconButton, Select } from '../controls';
import { Icon } from '../icons';
import * as E from '../../engine/timeline/edits';
import { sourceTimeAt } from '../../engine/timeline/edits';
import type { Clip, Id, MediaAsset } from '../../types/project';
import { framesToTimecode } from '../../engine/timecode';
import { toast } from '../../state/uiStore';

const MIME_STORYBOARD = 'application/x-vsp-storyboard';

/*
  Storyboard mode: the sequence as a wall of cards.

  Cards on the chosen video track can be rearranged by drag and drop (ripple
  semantics — linked audio follows), double-clicked to cue, and toggled.
  Dragging assets from the Project panel between cards inserts them. It is the
  same sequence the Timeline shows, so every change is live in both views.
*/

export function StoryboardPanel() {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const selection = useUI((s) => s.selection.clipIds);
  const [trackId, setTrackId] = useState<Id | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const videoTracks = useMemo(() => (seq ? seq.tracks.filter((t) => t.kind === 'video') : []), [seq]);
  const track = videoTracks.find((t) => t.id === trackId) ?? videoTracks.find((t) => t.targeted) ?? videoTracks[0] ?? null;
  useEffect(() => {
    if (!trackId && track) setTrackId(track.id);
  }, [track, trackId]);
  const cards = useMemo(() => {
    if (!seq || !track) return [];
    return seq.clips.filter((c) => c.trackId === track.id).sort((a, b) => a.start - b.start);
  }, [seq, track]);

  const seek = (f: number) => usePlayback.getState().setPlayhead(f, { fromUser: true });

  const reorder = useCallback(
    (movingId: Id, toIndex: number) => {
      if (!seq || !track) return;
      const sorted = seq.clips.filter((c) => c.trackId === track.id).sort((a, b) => a.start - b.start);
      const from = sorted.findIndex((c) => c.id === movingId);
      if (from < 0) return;
      const moving = sorted[from];
      const rest = sorted.filter((c) => c.id !== movingId);
      const to = Math.max(0, Math.min(rest.length, toIndex));
      if (to === from || (to === from + 1 && rest.length === sorted.length - 1 && toIndex > from)) {
        // Dropped back where it came from (accounting for removal shift).
        if (toIndex === from || toIndex === from + 1) return;
      }
      const dur = moving.duration;
      // Adjusted starts: close the hole at `from`, open one at `to`.
      const adjusted = new Map<Id, number>();
      for (const c of rest) {
        const origIdx = sorted.indexOf(c);
        const newIdx = rest.indexOf(c);
        let s = c.start;
        if (origIdx > from) s -= dur;
        if (newIdx >= to) s += dur;
        adjusted.set(c.id, s);
      }
      const movingStart = to >= rest.length ? Math.max(...rest.map((c) => adjusted.get(c.id)! + c.duration), 0) : adjusted.get(rest[to].id)!;
      const delta = movingStart - moving.start;
      if (delta === 0) return;
      useProject.getState().update('Storyboard Reorder', (p) => {
        const s = p.sequences.find((x) => x.id === seq.id)!;
        for (const c of s.clips) {
          if (c.id === movingId) c.start = Math.max(0, movingStart);
          else if (adjusted.has(c.id)) c.start = Math.max(0, adjusted.get(c.id)!);
          else if (moving.linkId && c.linkId === moving.linkId && c.id !== movingId) c.start = Math.max(0, c.start + delta);
        }
      });
    },
    [seq, track],
  );

  const insertAssetsAt = useCallback(
    (assets: MediaAsset[], index: number) => {
      if (!seq || !track || !assets.length) return;
      const sorted = seq.clips.filter((c) => c.trackId === track.id).sort((a, b) => a.start - b.start);
      const frame = index >= sorted.length ? Math.max(0, ...sorted.map((c) => E.clipEnd(c))) : sorted[index].start;
      let cursor = frame;
      const ids: Id[] = [];
      useProject.getState().update('Storyboard Insert', (p) => {
        const s = p.sequences.find((x) => x.id === seq.id)!;
        for (const a of assets) {
          const out = E.placeAsset(p, s, a, cursor, { mode: 'insert', videoTrackId: track.id });
          ids.push(...out);
          const c = s.clips.find((x) => x.id === out[0]);
          if (c) cursor = c.start + c.duration;
        }
      });
      if (ids.length) {
        useUI.getState().selectClips(ids);
        toast('success', 'Inserted', `${ids.length} clip${ids.length === 1 ? '' : 's'} added to ${track.name}.`);
      }
    },
    [seq, track],
  );

  const onCardDrop = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    setDropIndex(null);
    const types = Array.from(e.dataTransfer.types);
    if (types.includes(MIME_STORYBOARD)) {
      const id = e.dataTransfer.getData(MIME_STORYBOARD);
      if (id) reorder(id, index);
    } else if (types.includes(MIME_ASSETS)) {
      try {
        const ids = JSON.parse(e.dataTransfer.getData(MIME_ASSETS)) as string[];
        const assets = ids.map((id) => findAsset(project, id)).filter((a): a is MediaAsset => !!a && (a.hasVideo || a.kind === 'image' || a.kind === 'generator'));
        if (!assets.length) toast('warning', 'Nothing to insert', 'Only video, image or graphic assets can join the storyboard.');
        else insertAssetsAt(assets, index);
      } catch {
        /* ignore */
      }
    }
  };

  const gapProps = (index: number) => ({
    onDragOver: (e: React.DragEvent) => {
      const types = Array.from(e.dataTransfer.types);
      if (!types.includes(MIME_STORYBOARD) && !types.includes(MIME_ASSETS)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropIndex(index);
    },
    onDragLeave: () => setDropIndex((d) => (d === index ? null : d)),
    onDrop: (e: React.DragEvent) => onCardDrop(e, index),
  });

  if (!seq) {
    return (
      <div className="empty">
        <div className="big">No sequence</div>
        Open or create a sequence to arrange it as a storyboard.
      </div>
    );
  }

  return (
    <div className="storyboard">
      <div className="sb-toolbar">
        <Select value={track?.id ?? ''} options={videoTracks.map((t) => ({ value: t.id, label: t.name }))} onChange={(v) => setTrackId(v)} style={{ width: 130, height: 22 }} title="Storyboard track" />
        <span className="badge-dim">
          {cards.length} shot{cards.length === 1 ? '' : 's'}
        </span>
        <div className="spacer" />
        <span className="badge-dim" title="Drag cards to rearrange (ripple). Double-click a card to cue it. Drag assets from the Project panel between cards to insert them.">
          Drag to rearrange · Double-click to cue
        </span>
      </div>
      <div className="sb-grid" onDragOver={(e) => {
        // End-of-track drop zone highlight is handled per-gap; allow the tail gap.
        if (Array.from(e.dataTransfer.types).includes(MIME_ASSETS) || Array.from(e.dataTransfer.types).includes(MIME_STORYBOARD)) e.preventDefault();
      }}>
        {cards.length === 0 ? (
          <div className="empty" style={{ gridColumn: '1/-1' }} {...gapProps(0)}>
            <div className="big">{track?.name ?? 'Track'} is empty</div>
            Drag assets here from the Project panel to build the story.
            {dropIndex === 0 ? <div className="sb-drop-hint">Release to insert</div> : null}
          </div>
        ) : (
          cards.map((clip, i) => (
            <React.Fragment key={clip.id}>
              <div className={`sb-gap${dropIndex === i ? ' hot' : ''}`} {...gapProps(i)} />
              <StoryboardCard clip={clip} index={i} selected={selection.includes(clip.id)} onSeek={() => seek(clip.start)} />
            </React.Fragment>
          ))
        )}
        {cards.length > 0 ? <div className={`sb-gap tail${dropIndex === cards.length ? ' hot' : ''}`} {...gapProps(cards.length)} /> : null}
      </div>
    </div>
  );
}

function StoryboardCard({ clip, index, selected, onSeek }: { clip: Clip; index: number; selected: boolean; onSeek: () => void }) {
  const seq = useActiveSequence()!;
  const project = useProject((s) => s.project);
  const asset = clip.assetId ? findAsset(project, clip.assetId) : undefined;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [, setTick] = useState(0);
  useEffect(() => onMediaChange(() => setTick((t) => t + 1)), []);

  useEffect(() => {
    let live = true;
    (async () => {
      const cv = canvasRef.current;
      if (!cv) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(196 * dpr),
        h = Math.round(110 * dpr);
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext('2d')!;
      ctx.fillStyle = '#0d0d0d';
      ctx.fillRect(0, 0, w, h);
      const mid = clip.start + Math.floor(clip.duration / 2);
      const img = await thumbnailFor(clip, asset, sourceTimeAt(clip, mid, seq.settings.fps), w, h).catch(() => null);
      if (!live || !img) return;
      ctx.drawImage(img as CanvasImageSource, 0, 0, w, h);
    })();
    return () => {
      live = false;
    };
  }, [clip, asset, seq]);

  const select = (additive: boolean) => useUI.getState().selectClips([clip.id], additive);

  const ctxMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    select(e.shiftKey ? true : false);
    useUI.getState().openContextMenu(e.clientX, e.clientY, [
      { label: 'Go to Clip Start', shortcut: 'Double-click', onSelect: onSeek },
      { label: clip.enabled ? 'Disable Clip' : 'Enable Clip', checked: clip.enabled, onSelect: () => useProject.getState().update(clip.enabled ? 'Disable Clip' : 'Enable Clip', (p) => {
        const c = p.sequences.find((s) => s.id === seq.id)!.clips.find((x) => x.id === clip.id)!;
        c.enabled = !c.enabled;
      }) },
      { separator: true },
      { label: 'Lift (leave gap)', onSelect: () => {
        useUI.getState().selectClips([clip.id]);
        void import('../../app/commands').then((m) => m.cmd.liftExtract(false));
      } },
      { label: 'Extract (close gap)', onSelect: () => {
        useUI.getState().selectClips([clip.id]);
        void import('../../app/commands').then((m) => m.cmd.liftExtract(true));
      } },
    ]);
  };

  const durTc = framesToTimecode(clip.duration, seq.settings.fps);
  return (
    <div
      className={`sb-card${selected ? ' sel' : ''}${clip.enabled ? '' : ' off'}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(MIME_STORYBOARD, clip.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={(e) => select(e.shiftKey || e.metaKey || e.ctrlKey)}
      onDoubleClick={onSeek}
      onContextMenu={ctxMenu}
      title={`${clip.name}\nDouble-click to cue · Right-click for more`}
    >
      <div className="sb-thumb">
        <canvas ref={canvasRef} style={{ width: 196, height: 110 }} />
        <span className="sb-index">{index + 1}</span>
        {!clip.enabled ? <span className="sb-off-badge">Disabled</span> : null}
        {clip.effects.length > 0 ? (
          <span className="sb-fx" title={`${clip.effects.length} effect${clip.effects.length === 1 ? '' : 's'}`}>
            <Icon name="panelEffects" size={11} />
            {clip.effects.length}
          </span>
        ) : null}
      </div>
      <div className="sb-meta">
        <span className="sb-name">{clip.name}</span>
        <span className="sb-dur">{durTc}</span>
      </div>
      <IconButton icon={clip.enabled ? 'eye' : 'eyeOff'} label={clip.enabled ? 'Disable clip' : 'Enable clip'} sm className="sb-eye" onClick={(e) => {
        e.stopPropagation();
        useProject.getState().update(clip.enabled ? 'Disable Clip' : 'Enable Clip', (p) => {
          const c = p.sequences.find((s) => s.id === seq.id)!.clips.find((x) => x.id === clip.id)!;
          c.enabled = !c.enabled;
        });
      }} />
    </div>
  );
}

export { E };
