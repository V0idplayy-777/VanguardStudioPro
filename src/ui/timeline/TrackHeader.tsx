import React, { useEffect, useRef, useState } from 'react';
import type { Sequence, Track } from '../../types/project';
import { useProject } from '../../state/projectStore';
import { useUI, type ContextMenuItem } from '../../state/uiStore';
import { Icon } from '../icons';
import { usePointerDrag, HotText } from '../controls';
import { cmd } from '../../app/commands';
import { getTimelineAudio, usePlayback } from '../../engine/playback/playback';
import { clamp } from '../../engine/util';

export const TrackHeader = React.memo(function TrackHeader({ track, seq, top, height }: { track: Track; seq: Sequence; top: number; height: number }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(track.name);
  const setTextEditing = useUI((s) => s.setTextEditing);
  const sourceAssetId = useUI((s) => s.sourceAssetId);
  const isAudio = track.kind === 'audio';
  const startH = useRef(height);
  const tall = height >= 40;

  const resize = usePointerDrag({
    onStart: () => {
      startH.current = track.height;
      useProject.getState().beginBatch('Track height');
    },
    onMove: (d) => {
      const nh = clamp(startH.current + (isAudio ? d.dy : -d.dy), 20, 200);
      useProject.getState().updateTransient((p) => {
        const s = p.sequences.find((x) => x.id === seq.id);
        const t = s?.tracks.find((x) => x.id === track.id);
        if (t) t.height = nh;
      });
    },
    onEnd: () => useProject.getState().endBatch(),
    cursorClass: 'dragging-ns',
  });

  const set = (patch: Partial<Track>, label = 'Track') => cmd.setTrackProp(track.id, patch, label);

  const commitName = () => {
    setEditing(false);
    setTextEditing(false);
    if (name.trim() && name !== track.name) set({ name: name.trim() }, 'Rename track');
  };

  const ctx = (e: React.MouseEvent) => {
    e.preventDefault();
    const items: ContextMenuItem[] = [
      { label: 'Rename...', onSelect: () => { setName(track.name); setEditing(true); setTextEditing(true); } },
      { separator: true },
      { label: 'Add Track Above', onSelect: () => cmd.addTrack(track.kind as 'video' | 'audio', seq.tracks.filter((t) => t.kind === track.kind).findIndex((t) => t.id === track.id) + 1) },
      { label: 'Add Track Below', onSelect: () => cmd.addTrack(track.kind as 'video' | 'audio', seq.tracks.filter((t) => t.kind === track.kind).findIndex((t) => t.id === track.id)) },
      { label: 'Delete Track', danger: true, disabled: seq.tracks.filter((t) => t.kind === track.kind).length <= 1, onSelect: () => cmd.deleteTrack(track.id) },
      { label: 'Delete Empty Tracks', onSelect: () => cmd.deleteEmptyTracks() },
      { separator: true },
      { label: 'Show Keyframes: Clip', checked: track.showKeyframes === 'clip', onSelect: () => set({ showKeyframes: 'clip' }) },
      { label: 'Show Keyframes: None', checked: track.showKeyframes === 'none', onSelect: () => set({ showKeyframes: 'none' }) },
      { separator: true },
      { label: track.height >= 80 ? 'Minimize Track' : 'Expand Track', onSelect: () => set({ height: track.height >= 80 ? (isAudio ? 44 : 48) : isAudio ? 80 : 96 }) },
      { label: 'Sync Lock', checked: track.syncLocked, onSelect: () => set({ syncLocked: !track.syncLocked }) },
      ...(isAudio ? [{ separator: true }, { label: 'Track Effects (Audio Track Mixer)', onSelect: () => useUI.getState().setWorkspace('audio') }] : []),
    ];
    useUI.getState().openContextMenu(e.clientX, e.clientY, items);
  };

  // source patch label: V1/A1 depending on source clip
  const patchLabel = isAudio ? 'A1' : 'V1';
  const showPatch = !!sourceAssetId;

  return (
    <div className={`track-hdr ${track.locked ? 'locked' : ''}`} style={{ top, height: height + 1 }} onContextMenu={ctx} data-track-hdr={track.id}>
      <div className="hdr-left">
        {showPatch ? (
          <button type="button" className={`source-patch ${track.targeted ? 'on' : ''}`} title={`Source patching (${patchLabel}) - which track receives Insert / Overwrite`} onClick={() => cmd.toggleTrackTarget(track.id)}>
            {patchLabel}
          </button>
        ) : null}
        <button type="button" className={`tbtn target ${track.targeted ? 'on' : ''}`} title="Toggle track targeting (affects Insert/Overwrite, Match Frame, Add Edit, Lift/Extract)" onClick={() => cmd.toggleTrackTarget(track.id)} aria-pressed={track.targeted}>
          <span style={{ fontSize: 10, fontWeight: 460 }}>{track.name.slice(0, 3)}</span>
        </button>
      </div>
      <div className="hdr-main">
        <div className="hdr-row">
          <button type="button" className={`tbtn syncLock ${track.syncLocked ? 'on' : ''}`} title="Toggle Sync Lock" onClick={() => set({ syncLocked: !track.syncLocked })} aria-pressed={track.syncLocked}>
            <Icon name="syncLock" size={12} />
          </button>
          <button type="button" className={`tbtn lock ${track.locked ? 'on' : ''}`} title="Toggle Track Lock" onClick={() => set({ locked: !track.locked }, track.locked ? 'Unlock track' : 'Lock track')} aria-pressed={track.locked}>
            <Icon name={track.locked ? 'lock' : 'unlock'} size={12} />
          </button>
          {isAudio ? (
            <>
              <button type="button" className={`tbtn mute ${track.muted ? 'on' : ''}`} title="Mute Track" onClick={() => set({ muted: !track.muted }, 'Mute track')} aria-pressed={track.muted}>
                <span style={{ fontSize: 10, fontWeight: 460 }}>M</span>
              </button>
              <button type="button" className={`tbtn solo ${track.solo ? 'on' : ''}`} title="Solo Track" onClick={() => set({ solo: !track.solo }, 'Solo track')} aria-pressed={track.solo}>
                <span style={{ fontSize: 10, fontWeight: 460 }}>S</span>
              </button>
            </>
          ) : (
            <button type="button" className={`tbtn ${track.visible ? 'on' : ''}`} title="Toggle Track Output" onClick={() => set({ visible: !track.visible }, 'Track output')} aria-pressed={track.visible}>
              <Icon name={track.visible ? 'eye' : 'eyeOff'} size={12} />
            </button>
          )}
          {editing ? (
            <span className="track-name">
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commitName(); if (e.key === 'Escape') { setEditing(false); setTextEditing(false); } }} />
            </span>
          ) : (
            <span className="track-name" onDoubleClick={() => { setName(track.name); setEditing(true); setTextEditing(true); }} title="Double-click to rename">
              {track.name}
            </span>
          )}
        </div>
        {tall ? (
          <div className="hdr-row2">
            {isAudio ? (
              <>
                <TrackMeter trackId={track.id} height={height - 26} />
                <div className="track-fader" title="Track volume (dB)">
                  <Icon name="volume" size={10} />
                  <HotText value={track.volume.value as number} min={-60} max={12} step={0.5} decimals={1} unit=" dB" width={52} onChange={(v, commit) => (commit ? set({ volume: { ...track.volume, value: v } }, 'Track volume') : useProject.getState().updateTransient((p) => { const t = p.sequences.find((x) => x.id === seq.id)?.tracks.find((x) => x.id === track.id); if (t) t.volume = { ...t.volume, value: v }; }))} />
                </div>
              </>
            ) : (
              <span className="label tiny" style={{ paddingLeft: 2 }}>
                {track.showKeyframes === 'clip' ? 'Opacity' : ''}
              </span>
            )}
          </div>
        ) : null}
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, height: 5, cursor: 'ns-resize', ...(isAudio ? { bottom: 0 } : { top: 0 }) }} onPointerDown={resize} title="Drag to resize track" />
    </div>
  );
});

function TrackMeter({ trackId, height }: { trackId: string; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const playing = usePlayback((s) => s.playing);
  useEffect(() => {
    if (!playing) {
      if (ref.current) ref.current.style.height = '0%';
      return;
    }
    let raf = 0;
    const tick = () => {
      const r = getTimelineAudio().readTrack(trackId);
      if (ref.current) {
        const lin = r ? Math.max(r.peak[0], r.peak[1]) : 0;
        const db = lin > 0 ? 20 * Math.log10(lin) : -60;
        const pct = clamp(((db + 60) / 60) * 100, 0, 100);
        ref.current.style.height = `${pct}%`;
        ref.current.style.background = db > -3 ? '#d94a3d' : db > -12 ? '#d9a441' : 'var(--c-ok)';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, trackId]);
  return (
    <div className="track-meter" style={{ height: Math.max(8, height) }} title="Track level">
      <div ref={ref} />
    </div>
  );
}
