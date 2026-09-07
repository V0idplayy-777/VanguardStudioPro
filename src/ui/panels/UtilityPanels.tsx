import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useProject, useActiveSequence, findAsset, sequenceDuration } from '../../state/projectStore';
import { useUI, toast, type ContextMenuItem } from '../../state/uiStore';
import { usePlayback } from '../../engine/playback/playback';
import { Button, IconButton, TextField, Select, Checkbox, HotText, ColorChip, Empty, TimecodeField, Kbd } from '../controls';
import { Icon, Swatch } from '../icons';
import type { CaptionItem, CaptionStyle, Marker, MediaAsset, Sequence } from '../../types/project';
import { LABEL_COLORS, DEFAULT_CAPTION_STYLE, markerColor } from '../../types/project';
import { framesToTimecode } from '../../engine/timecode';
import { cmd, projectSelection } from '../../app/commands';
import { chunkTranscript } from '../../engine/captions/subtitles';
import { uid, formatBytes } from '../../engine/util';
import { getMedia } from '../../engine/media/mediaStore';
import { SHORTCUTS } from '../../app/shortcuts';

/* ============================== Captions ============================== */

export function CaptionsPanel() {
  const seq = useActiveSequence();
  const playhead = usePlayback((s) => s.playhead);
  const capSel = useUI((s) => s.selection.captionIds);
  const [tab, setTab] = useState<'items' | 'style' | 'transcript'>('items');
  const [transcript, setTranscript] = useState('');
  const [maxChars, setMaxChars] = useState(42);
  const [secondsPer, setSecondsPer] = useState(3);
  const listRef = useRef<HTMLDivElement>(null);
  const fps = seq?.settings.fps ?? 30;

  if (!seq) return <Empty title="Captions" icon="captions">Open a sequence to add captions.</Empty>;

  const write = (label: string, fn: (s: Sequence) => void) => useProject.getState().update(label, (p) => { const s = p.sequences.find((x) => x.id === seq.id); if (s) fn(s); });
  const current = seq.captions.find((c) => playhead >= c.start && playhead < c.end);

  const addAtPlayhead = () => {
    const id = uid('cap');
    write('Add caption', (s) => {
      const next = s.captions.filter((c) => c.start > playhead).sort((a, b) => a.start - b.start)[0];
      const end = Math.min(playhead + fps * secondsPer, next ? next.start : Infinity);
      s.captions.push({ id, start: playhead, end: Math.max(playhead + 1, end), text: '' });
      s.captions.sort((a, b) => a.start - b.start);
    });
    useUI.getState().setSelection({ captionIds: [id] });
    setTimeout(() => (listRef.current?.querySelector(`[data-cap="${id}"] textarea`) as HTMLTextAreaElement | null)?.focus(), 30);
  };
  const splitCurrent = () => {
    if (!current) return;
    write('Split caption', (s) => {
      const c = s.captions.find((x) => x.id === current.id)!;
      const words = c.text.split(/\s+/);
      const half = Math.ceil(words.length / 2);
      const end = c.end;
      c.end = playhead;
      c.text = words.slice(0, half).join(' ');
      s.captions.push({ id: uid('cap'), start: playhead, end, text: words.slice(half).join(' ') });
      s.captions.sort((a, b) => a.start - b.start);
    });
  };
  const fromTranscript = () => {
    const chunks = chunkTranscript(transcript, maxChars);
    if (!chunks.length) return;
    write('Captions from transcript', (s) => {
      let t = playhead;
      for (const text of chunks) {
        const dur = Math.max(fps, Math.round((text.length / 15) * fps)); // ~15 chars/sec reading speed
        s.captions.push({ id: uid('cap'), start: t, end: t + dur, text });
        t += dur;
      }
      s.captions.sort((a, b) => a.start - b.start);
    });
    setTranscript('');
    setTab('items');
    toast('success', 'Captions created', `${chunks.length} captions timed at about 15 characters per second. Adjust timing in the list.`);
  };
  const style = seq.captionTrack.style;
  const setStyle = (patch: Partial<CaptionStyle>, label = 'Caption style') => write(label, (s) => { s.captionTrack.style = { ...s.captionTrack.style, ...patch }; });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="tabs">
        <button type="button" className={tab === 'items' ? 'on' : ''} onClick={() => setTab('items')}>Captions ({seq.captions.length})</button>
        <button type="button" className={tab === 'style' ? 'on' : ''} onClick={() => setTab('style')}>Style</button>
        <button type="button" className={tab === 'transcript' ? 'on' : ''} onClick={() => setTab('transcript')}>From Text</button>
      </div>
      {tab === 'items' ? (
        <>
          <div className="toolbar">
            <Button sm icon="add" onClick={addAtPlayhead}>Add at playhead</Button>
            <Button sm onClick={splitCurrent} disabled={!current}>Split</Button>
            <Button sm onClick={() => void cmd.importCaptions()}>Import SRT/VTT</Button>
            <span className="spacer" />
            <Checkbox checked={seq.captionTrack.enabled} onChange={(v) => write('Caption track', (s) => { s.captionTrack.enabled = v; })} label="Show" title="Show captions in the Program Monitor and export" />
            <Checkbox checked={seq.captionTrack.burnIn} onChange={(v) => write('Caption burn-in', (s) => { s.captionTrack.burnIn = v; })} label="Burn in" title="Burn captions into exported video" />
            <IconButton icon="export" label="Export captions" sm onClick={() => useUI.getState().openContextMenu(window.innerWidth / 2, 120, [{ label: 'SubRip (.srt)', onSelect: () => cmd.exportCaptions('srt') }, { label: 'WebVTT (.vtt)', onSelect: () => cmd.exportCaptions('vtt') }])} />
          </div>
          <div ref={listRef} className="scroll-y" style={{ flex: 1 }} onKeyDown={(e) => { if ((e.key === 'Delete' || e.key === 'Backspace') && capSel.length && (e.target as HTMLElement).tagName !== 'TEXTAREA') { write('Delete captions', (s) => { s.captions = s.captions.filter((c) => !capSel.includes(c.id)); }); useUI.getState().setSelection({ captionIds: [] }); } }} tabIndex={0}>
            {seq.captions.length === 0 ? (
              <div className="empty" style={{ marginTop: 30 }}>
                <strong>No captions</strong>
                Add one at the playhead, import an SRT or VTT file, or paste a transcript under "From Text".
              </div>
            ) : (
              seq.captions.map((c) => <CaptionRow key={c.id} c={c} fps={fps} selected={capSel.includes(c.id)} current={current?.id === c.id} write={write} seqId={seq.id} />)
            )}
          </div>
        </>
      ) : null}
      {tab === 'style' ? (
        <div className="scroll-y" style={{ flex: 1, padding: 10 }}>
          <div className="prop-grid">
            <span className="label">Font</span>
            <Select value={style.fontFamily} options={['Inter Variable', 'Arial', 'Helvetica', 'Verdana', 'Georgia', 'Courier New'].map((f) => ({ value: f, label: f === 'Inter Variable' ? 'Inter' : f }))} onChange={(v) => setStyle({ fontFamily: v })} />
            <span className="label">Size</span>
            <HotText value={style.fontSize} min={8} max={300} step={1} unit=" px" width={60} onChange={(v, c) => c && setStyle({ fontSize: v })} />
            <span className="label">Weight</span>
            <HotText value={style.fontWeight} min={100} max={900} step={10} width={60} onChange={(v, c) => c && setStyle({ fontWeight: v })} />
            <span className="label">Italic</span>
            <Checkbox checked={style.italic} onChange={(v) => setStyle({ italic: v })} />
            <span className="label">Text color</span>
            <ColorChip color={style.color} onChange={(h, c) => c && setStyle({ color: h })} />
            <span className="label">Background</span>
            <ColorChip color={style.backgroundColor} onChange={(h, c) => c && setStyle({ backgroundColor: h })} alpha={style.backgroundOpacity} onAlpha={(a) => setStyle({ backgroundOpacity: a })} />
            <span className="label">Edge</span>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <Select value={style.edge} options={[{ value: 'none', label: 'None' }, { value: 'shadow', label: 'Drop shadow' }, { value: 'outline', label: 'Outline' }, { value: 'raised', label: 'Raised' }]} onChange={(v) => setStyle({ edge: v as any })} />
              <ColorChip color={style.edgeColor} onChange={(h, c) => c && setStyle({ edgeColor: h })} />
            </span>
            <span className="label">Align</span>
            <Select value={style.align} options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }]} onChange={(v) => setStyle({ align: v as any })} />
            <span className="label">Vertical position</span>
            <HotText value={style.position * 100} min={0} max={100} step={1} unit="%" width={60} onChange={(v, c) => c && setStyle({ position: v / 100 })} />
            <span className="label">Max width</span>
            <HotText value={style.maxWidth * 100} min={20} max={100} step={1} unit="%" width={60} onChange={(v, c) => c && setStyle({ maxWidth: v / 100 })} />
            <span className="label">Letter spacing</span>
            <HotText value={style.letterSpacing} min={-5} max={30} step={0.5} unit=" px" width={60} onChange={(v, c) => c && setStyle({ letterSpacing: v })} />
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <Button sm onClick={() => setStyle({ ...DEFAULT_CAPTION_STYLE }, 'Reset caption style')}>Reset to default</Button>
          </div>
        </div>
      ) : null}
      {tab === 'transcript' ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 10, gap: 8 }}>
          <div style={{ color: 'var(--c-text-dim)' }}>Paste a transcript. It is split into caption-sized lines and laid out from the playhead at a reading speed of about 15 characters per second.</div>
          <textarea className="field" value={transcript} onChange={(e) => setTranscript(e.target.value)} onKeyDown={(e) => e.stopPropagation()} onFocus={() => useUI.getState().setTextEditing(true)} onBlur={() => useUI.getState().setTextEditing(false)} style={{ flex: 1, resize: 'none', height: 'auto', padding: 6, lineHeight: 1.5, fontFamily: 'inherit' }} placeholder="Type or paste text here..." />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span className="label">Max characters per caption</span>
            <HotText value={maxChars} min={16} max={120} step={1} width={48} onChange={(v) => setMaxChars(Math.round(v))} />
            <span className="label">Default length</span>
            <HotText value={secondsPer} min={0.5} max={15} step={0.5} unit=" s" width={52} onChange={(v) => setSecondsPer(v)} />
            <span className="spacer" />
            <Button primary sm onClick={fromTranscript} disabled={!transcript.trim()}>Create captions</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CaptionRow({ c, fps, selected, current, write, seqId }: { c: CaptionItem; fps: number; selected: boolean; current: boolean; write: (label: string, fn: (s: Sequence) => void) => void; seqId: string }) {
  const [text, setText] = useState(c.text);
  useEffect(() => setText(c.text), [c.text]);
  const commit = () => {
    if (text !== c.text) write('Edit caption', (s) => { const x = s.captions.find((y) => y.id === c.id); if (x) x.text = text; });
  };
  return (
    <div className={`cap-row ${selected ? 'selected' : ''} ${current ? 'current' : ''}`} data-cap={c.id} onClick={() => useUI.getState().setSelection({ captionIds: [c.id] })} onDoubleClick={() => usePlayback.getState().setPlayhead(c.start, { fromUser: true })}>
      <TimecodeField frames={c.start} fps={fps} onChange={(f) => write('Caption start', (s) => { const x = s.captions.find((y) => y.id === c.id); if (x) x.start = Math.min(f, x.end - 1); s.captions.sort((a, b) => a.start - b.start); })} style={{ fontSize: 11 }} />
      <TimecodeField frames={c.end} fps={fps} onChange={(f) => write('Caption end', (s) => { const x = s.captions.find((y) => y.id === c.id); if (x) x.end = Math.max(f, x.start + 1); })} style={{ fontSize: 11 }} />
      <textarea value={text} rows={2} onChange={(e) => setText(e.target.value)} onBlur={() => { commit(); useUI.getState().setTextEditing(false); }} onFocus={() => useUI.getState().setTextEditing(true)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }} placeholder="Caption text" />
      <IconButton icon="close" label="Delete caption" sm noline onClick={(e) => { e.stopPropagation(); write('Delete caption', (s) => { s.captions = s.captions.filter((y) => y.id !== c.id); }); }} />
      <span style={{ gridColumn: '1 / -1', fontSize: 10, color: text.length > 42 * 2 ? 'var(--c-warn)' : 'var(--c-text-faint)' }}>{text.length} chars, {((c.end - c.start) / fps).toFixed(1)} s, {(text.length / Math.max(0.1, (c.end - c.start) / fps)).toFixed(0)} cps{void seqId}</span>
    </div>
  );
}

/* ============================== Markers ============================== */

export function MarkersPanel() {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const playhead = usePlayback((s) => s.playhead);
  const markerSel = useUI((s) => s.selection.markerIds);
  const [filter, setFilter] = useState<'all' | Marker['kind']>('all');
  const [q, setQ] = useState('');
  if (!seq) return <Empty title="Markers" icon="marker">Open a sequence to see its markers.</Empty>;
  const fps = seq.settings.fps;
  // Sequence markers + clip markers (with clip context)
  const rows = [
    ...seq.markers.map((m) => ({ m, clipName: null as string | null, abs: m.time })),
    ...seq.clips.flatMap((c) => c.markers.map((m) => ({ m, clipName: c.name, abs: c.start + m.time }))),
  ]
    .filter((r) => filter === 'all' || r.m.kind === filter)
    .filter((r) => !q || r.m.name.toLowerCase().includes(q.toLowerCase()) || (r.m.comment ?? '').toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.abs - b.abs);
  const write = (label: string, fn: (s: Sequence) => void) => useProject.getState().update(label, (p) => { const s = p.sequences.find((x) => x.id === seq.id); if (s) fn(s); });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="toolbar">
        <TextField value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search markers" icon="search" style={{ flex: 1 }} />
        <Select value={filter} options={[{ value: 'all', label: 'All kinds' }, { value: 'comment', label: 'Comment' }, { value: 'chapter', label: 'Chapter' }, { value: 'segmentation', label: 'Segmentation' }, { value: 'webLink', label: 'Web link' }, { value: 'flashCue', label: 'Cue' }, { value: 'beat', label: 'Beat' }]} onChange={(v) => setFilter(v as any)} />
        <IconButton icon="marker" label="Add marker at playhead (M)" sm onClick={() => cmd.addMarker()} />
        <Button sm icon="beat" onClick={() => useUI.getState().openModal({ kind: 'beatDetect' })} title="Detect beats in a music clip and mark them">Detect Beats</Button>
        <IconButton icon="export" label="Export markers" sm onClick={(e) => useUI.getState().openContextMenu(e.clientX, e.clientY, [{ label: 'CSV', onSelect: () => cmd.exportMarkers('csv') }, { label: 'YouTube chapters (text)', onSelect: () => cmd.exportMarkers('chapters') }])} />
      </div>
      <div className="scroll-y" style={{ flex: 1 }}>
        {rows.length === 0 ? (
          <div className="empty" style={{ marginTop: 30 }}>
            <strong>No markers</strong>
            Press M during playback or at the playhead to drop a marker. Double-click a marker in the ruler to edit it.
          </div>
        ) : (
          rows.map(({ m, clipName, abs }) => (
            <div key={m.id} className={`list-row ${markerSel.includes(m.id) ? 'selected' : ''}`} style={{ height: 'auto', padding: '4px 8px', alignItems: 'flex-start' }} onClick={() => { useUI.getState().setSelection({ markerIds: [m.id] }); usePlayback.getState().setPlayhead(abs, { fromUser: true }); }} onDoubleClick={() => useUI.getState().openModal({ kind: 'markerEdit', payload: { markerId: m.id } })} onContextMenu={(e) => { e.preventDefault(); useUI.getState().openContextMenu(e.clientX, e.clientY, [{ label: 'Edit...', onSelect: () => useUI.getState().openModal({ kind: 'markerEdit', payload: { markerId: m.id } }) }, { label: 'Go to Marker', onSelect: () => usePlayback.getState().setPlayhead(abs, { fromUser: true }) }, { separator: true }, { label: 'Delete', danger: true, onSelect: () => write('Delete marker', (s) => { s.markers = s.markers.filter((x) => x.id !== m.id); for (const c of s.clips) c.markers = c.markers.filter((x) => x.id !== m.id); }) }]); }}>
              <Swatch color={markerColor(m)} size={10} style={{ marginTop: 4 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span style={{ color: 'var(--c-text-bright)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name || (m.kind === 'chapter' ? 'Chapter' : 'Marker')}</span>
                  <span className="tc dim" style={{ marginLeft: 'auto' }}>{framesToTimecode(abs, fps, seq.settings.dropFrame)}{m.duration ? ` +${framesToTimecode(m.duration, fps)}` : ''}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--c-text-dim)', whiteSpace: 'pre-wrap' }}>{m.comment}{clipName ? <span style={{ color: 'var(--c-text-faint)' }}> (in clip {clipName})</span> : null}{m.kind !== 'comment' ? <span style={{ color: 'var(--c-text-faint)' }}> [{m.kind}]</span> : null}{m.url ? <span> {m.url}</span> : null}</div>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="toolbar" style={{ borderTop: '1px solid var(--c-line)', borderBottom: 0, fontSize: 11, color: 'var(--c-text-dim)' }}>
        {rows.length} marker{rows.length === 1 ? '' : 's'} - playhead {framesToTimecode(playhead, fps, seq.settings.dropFrame)}{void project}
      </div>
    </div>
  );
}

/* ============================== History ============================== */

export function HistoryPanel() {
  const past = useProject((s) => s.past);
  const future = useProject((s) => s.future);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('.hist-row.current')?.scrollIntoView({ block: 'nearest' });
  }, [past.length]);
  const rows = [
    { label: 'Open project', idx: -1, future: false },
    ...past.map((h, i) => ({ label: h.label, idx: i, future: false })),
    ...[...future].reverse().map((h, i) => ({ label: h.label, idx: past.length + i, future: true })),
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="toolbar">
        <span style={{ color: 'var(--c-text-dim)' }}>{past.length} step{past.length === 1 ? '' : 's'}{future.length ? `, ${future.length} redoable` : ''}</span>
        <span className="spacer" />
        <IconButton icon="undo" label="Undo (Ctrl+Z)" sm disabled={!past.length} onClick={() => cmd.undo()} />
        <IconButton icon="redo" label="Redo (Ctrl+Shift+Z)" sm disabled={!future.length} onClick={() => cmd.redo()} />
      </div>
      <div ref={ref} className="scroll-y" style={{ flex: 1 }}>
        {rows.map((r, i) => (
          <div key={i} className={`hist-row ${r.future ? 'future' : ''} ${!r.future && r.idx === past.length - 1 ? 'current' : ''}`} onClick={() => useProject.getState().jumpHistory(r.idx)} title="Click to jump to this state">
            <span className="n" style={{ width: 26, textAlign: 'right', color: 'var(--c-text-faint)', fontSize: 10 }}>{i}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================== Info ============================== */

export function InfoPanel() {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const sel = useUI((s) => s.selection.clipIds);
  const projSel = useSyncExternalStore(
    (cb) => projectSelection.subscribe(cb),
    () => projectSelection.get(),
  );
  const playhead = usePlayback((s) => s.playhead);
  const focused = useUI((s) => s.focusedPanel);
  const clip = seq?.clips.find((c) => c.id === sel[0]);
  const asset: MediaAsset | undefined = focused === 'project' && projSel.length ? findAsset(project, projSel[0]) : clip?.assetId ? findAsset(project, clip.assetId) : undefined;
  const fps = seq?.settings.fps ?? 30;
  const kv = (rows: [string, React.ReactNode][]) => (
    <div className="kv">
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <span className="label">{k}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{v}</span>
        </React.Fragment>
      ))}
    </div>
  );
  return (
    <div className="scroll-y" style={{ height: '100%', padding: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {clip && seq ? (
        <>
          <div className="section-title" style={{ color: 'var(--c-text-bright)' }}>{clip.name}</div>
          {kv([
            ['Type', clip.generator ? clip.generator : asset?.kind ?? 'clip'],
            ['Start', framesToTimecode(clip.start, fps, seq.settings.dropFrame)],
            ['End', framesToTimecode(clip.start + clip.duration, fps, seq.settings.dropFrame)],
            ['Duration', framesToTimecode(clip.duration, fps)],
            ['Source in', `${clip.inPoint.toFixed(3)} s`],
            ['Speed', `${(clip.speed * 100).toFixed(0)}%${clip.reversed ? ' reversed' : ''}`],
            ['Effects', String(clip.effects.length)],
            ['Track', seq.tracks.find((t) => t.id === clip.trackId)?.name ?? ''],
            ['Label', <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><Swatch color={LABEL_COLORS[clip.label]} />{clip.label}</span>],
          ])}
        </>
      ) : null}
      {asset ? (
        <>
          <div className="section-title" style={{ color: 'var(--c-text-bright)' }}>{asset.name}</div>
          {kv([
            ['Kind', asset.kind],
            ...(asset.file ? ([['File', asset.file.name], ['Size', formatBytes(asset.file.size)], ['MIME', asset.file.type || '-']] as [string, React.ReactNode][]) : []),
            ...(asset.width ? ([['Frame size', `${asset.width} x ${asset.height}`]] as [string, React.ReactNode][]) : []),
            ...(asset.fps ? ([['Frame rate', `${+asset.fps.toFixed(3)} fps`]] as [string, React.ReactNode][]) : []),
            ...(asset.duration != null ? ([['Duration', `${asset.duration.toFixed(2)} s`]] as [string, React.ReactNode][]) : []),
            ...(asset.hasAudio ? ([['Audio', `${asset.audioChannels ?? '?'} ch, ${asset.sampleRate ? asset.sampleRate + ' Hz' : '?'}`]] as [string, React.ReactNode][]) : []),
            ['Status', asset.offline ? 'Offline' : getMedia(asset.id)?.error ? `Error: ${getMedia(asset.id)!.error}` : 'Online'],
            ['Used', `${project.sequences.reduce((n, s) => n + s.clips.filter((c) => c.assetId === asset.id).length, 0)} clip(s)`],
          ])}
        </>
      ) : null}
      {seq ? (
        <>
          <div className="section-title" style={{ color: 'var(--c-text-bright)' }}>{seq.name}</div>
          {kv([
            ['Frame size', `${seq.settings.width} x ${seq.settings.height}`],
            ['Frame rate', `${seq.settings.fps} fps${seq.settings.dropFrame ? ' (drop frame)' : ''}`],
            ['Audio', `${seq.settings.sampleRate} Hz`],
            ['Duration', framesToTimecode(sequenceDuration(seq), fps, seq.settings.dropFrame)],
            ['Playhead', framesToTimecode(playhead, fps, seq.settings.dropFrame)],
            ['Clips', String(seq.clips.length)],
            ['Tracks', `${seq.tracks.filter((t) => t.kind === 'video').length} video, ${seq.tracks.filter((t) => t.kind === 'audio').length} audio`],
            ...(seq.inPoint != null || seq.outPoint != null ? ([['In / Out', `${seq.inPoint != null ? framesToTimecode(seq.inPoint, fps) : '-'} / ${seq.outPoint != null ? framesToTimecode(seq.outPoint, fps) : '-'}`]] as [string, React.ReactNode][]) : []),
          ])}
        </>
      ) : (
        <Empty title="Info">Details about the selected clip, project item and sequence appear here.</Empty>
      )}
    </div>
  );
}

/* ============================== Metadata ============================== */

export function MetadataPanel() {
  const project = useProject((s) => s.project);
  const projSel = useSyncExternalStore(
    (cb) => projectSelection.subscribe(cb),
    () => projectSelection.get(),
  );
  const seq = useActiveSequence();
  const clipSel = useUI((s) => s.selection.clipIds);
  const focused = useUI((s) => s.focusedPanel);
  const clip = seq?.clips.find((c) => c.id === clipSel[0]);
  const assetId = focused === 'project' && projSel.length ? projSel[0] : clip?.assetId ?? projSel[0];
  const asset = assetId ? findAsset(project, assetId) : undefined;
  const [tags, setTags] = useState('');
  useEffect(() => setTags((asset?.meta.tags ?? []).join(', ')), [asset?.id, asset?.meta.tags]);
  if (!asset) return <Empty title="Metadata" icon="metadata">Select a project item to edit its log notes, scene/shot/take and tags. Search in the Project panel finds tags and comments.</Empty>;
  const set = (patch: Partial<MediaAsset['meta']>, label = 'Metadata') => useProject.getState().update(label, (p) => { const a = p.assets.find((x) => x.id === asset.id); if (a) a.meta = { ...a.meta, ...patch }; });
  const field = (key: keyof MediaAsset['meta'], label: string, multiline = false) => (
    <>
      <span className="label">{label}</span>
      {multiline ? (
        <textarea className="field" defaultValue={(asset.meta[key] as string) ?? ''} key={asset.id + key} rows={3} style={{ height: 'auto', padding: 4, resize: 'vertical', fontFamily: 'inherit' }} onKeyDown={(e) => e.stopPropagation()} onFocus={() => useUI.getState().setTextEditing(true)} onBlur={(e) => { useUI.getState().setTextEditing(false); if (e.target.value !== (asset.meta[key] ?? '')) set({ [key]: e.target.value }); }} />
      ) : (
        <TextField defaultValue={(asset.meta[key] as string) ?? ''} key={asset.id + key} onBlur={(e) => { if (e.target.value !== (asset.meta[key] ?? '')) set({ [key]: e.target.value }); }} />
      )}
    </>
  );
  return (
    <div className="scroll-y" style={{ height: '100%', padding: 10 }}>
      <div style={{ color: 'var(--c-text-bright)', marginBottom: 8 }}>{asset.name}</div>
      <div className="prop-grid">
        <span className="label">Name</span>
        <TextField defaultValue={asset.name} key={asset.id + 'name'} onBlur={(e) => e.target.value.trim() && e.target.value !== asset.name && cmd.renameAsset(asset.id, e.target.value.trim())} />
        {field('description', 'Description', true)}
        {field('logNote', 'Log note', true)}
        {field('scene', 'Scene')}
        {field('shot', 'Shot')}
        {field('take', 'Take')}
        <span className="label">Good take</span>
        <Checkbox checked={!!asset.meta.good} onChange={(v) => set({ good: v })} />
        <span className="label">Tags</span>
        <TextField value={tags} onChange={(e) => setTags(e.target.value)} onBlur={() => set({ tags: tags.split(',').map((t) => t.trim()).filter(Boolean) })} placeholder="comma, separated, tags" />
        {field('comment', 'Comment', true)}
        <span className="label">Label</span>
        <Select value={asset.label} options={(Object.keys(LABEL_COLORS) as (keyof typeof LABEL_COLORS)[]).map((l) => ({ value: l, label: l }))} onChange={(v) => useProject.getState().update('Label', (p) => { const a = p.assets.find((x) => x.id === asset.id); if (a) a.label = v as any; })} />
      </div>
    </div>
  );
}

/* ============================== Events ============================== */

export function EventsPanel() {
  const events = useUI((s) => s.events);
  const clear = useUI((s) => s.clearEvents);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="toolbar">
        <span style={{ color: 'var(--c-text-dim)' }}>{events.length} event{events.length === 1 ? '' : 's'}</span>
        <span className="spacer" />
        <Button sm onClick={clear} disabled={!events.length}>Clear</Button>
      </div>
      <div className="scroll-y" style={{ flex: 1 }}>
        {events.length === 0 ? <div className="empty" style={{ marginTop: 30 }}><strong>No events</strong>Warnings, import results and export logs are listed here.</div> : null}
        {[...events].reverse().map((e) => (
          <div key={e.id} className="list-row" style={{ height: 'auto', padding: '4px 8px', alignItems: 'flex-start' }} title={e.detail}>
            <Icon name={e.kind === 'error' ? 'error' : e.kind === 'warning' ? 'warning' : 'info'} size={12} style={{ color: e.kind === 'error' ? 'var(--c-danger)' : e.kind === 'warning' ? 'var(--c-warn)' : 'var(--c-text-dim)', marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>{e.message}</div>
              {e.detail ? <div style={{ fontSize: 11, color: 'var(--c-text-dim)', whiteSpace: 'pre-wrap' }}>{e.detail}</div> : null}
            </div>
            <span className="dim tc" style={{ fontSize: 10 }}>{new Date(e.at).toLocaleTimeString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================== Learn ============================== */

const LESSONS: { title: string; body: React.ReactNode }[] = [
  { title: 'Import and organise', body: <>Press <Kbd>Ctrl+I</Kbd> or drop files onto the Project panel. Create bins with <Kbd>Ctrl+B</Kbd>; drag items between bins. Double-click a clip to open it in the Source Monitor.</> },
  { title: 'Three-point editing', body: <>In the Source Monitor mark In <Kbd>I</Kbd> and Out <Kbd>O</Kbd>, then press <Kbd>,</Kbd> to insert or <Kbd>.</Kbd> to overwrite at the playhead. Track targeting buttons (V1/A1) in the track headers decide where the clip lands.</> },
  { title: 'Trimming', body: <>Drag a clip edge to trim. Hold <Kbd>Ctrl</Kbd> while dragging for a ripple trim, or use the Ripple <Kbd>B</Kbd> and Rolling <Kbd>N</Kbd> tools. Slip <Kbd>Y</Kbd> and Slide <Kbd>U</Kbd> change what part of the media shows without moving neighbours.</> },
  { title: 'Cutting and removing', body: <>Razor <Kbd>C</Kbd> cuts where you click; <Kbd>Ctrl+K</Kbd> adds an edit at the playhead on targeted tracks. <Kbd>Delete</Kbd> lifts a clip and leaves a gap; <Kbd>Shift+Delete</Kbd> ripple-deletes and closes it.</> },
  { title: 'Effects and keyframes', body: <>Drag any effect from the Effects panel onto a clip, or double-click to apply to the selection. In Effect Controls, click a stopwatch to animate a value - every edit at a new time adds a keyframe. Right-click a keyframe to change its interpolation.</> },
  { title: 'Transitions', body: <><Kbd>Ctrl+D</Kbd> applies the default video transition to selected edit points, <Kbd>Ctrl+Shift+D</Kbd> the audio one. Drag transition edges in the timeline to change duration; right-click for alignment.</> },
  { title: 'Colour', body: <>The Lumetri Color panel grades the selected clip. Use Scopes (Window menu) to read levels: waveform for exposure, vectorscope for hue and saturation, with a skin tone line.</> },
  { title: 'Audio', body: <>The Audio Track Mixer sets track levels, pan and four insert effects per track; the Clip Mixer writes clip volume. Loudness measures integrated LUFS and can match a delivery target.</> },
  { title: 'Titles', body: <>Essential Graphics has templates you can drag onto a video track; the Edit tab changes text, fonts, alignment, animation in/out and responsive pinning.</> },
  { title: 'Export', body: <><Kbd>Ctrl+M</Kbd> opens Export. Choose MP4/WebM, resolution, bitrate, and In/Out range. Hardware encoders are used through WebCodecs when available; otherwise a real-time capture path is used.</> },
  { title: 'Workspaces', body: <>Switch layouts from the Workspaces bar or <Kbd>Alt+Shift+1..9</Kbd>. Drag a panel tab to another group, or grab the group handle to float it. Press <Kbd>`</Kbd> to maximise the panel under the mouse.</> },
];

export function LearnPanel() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="scroll-y" style={{ height: '100%' }}>
      {LESSONS.map((l, i) => (
        <div key={i} className="section" style={{ borderBottom: '1px solid var(--c-line-faint)' }}>
          <div className="section-head" onClick={() => setOpen(open === i ? null : i)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', cursor: 'default' }}>
            <Icon name={open === i ? 'chevronDown' : 'chevronRight'} size={10} />
            <span style={{ color: 'var(--c-text-bright)' }}>{i + 1}. {l.title}</span>
          </div>
          {open === i ? <div style={{ padding: '0 8px 10px 24px', lineHeight: 1.6, color: 'var(--c-text)' }}>{l.body}</div> : null}
        </div>
      ))}
      <div style={{ padding: '10px 8px', color: 'var(--c-text-faint)', fontSize: 11 }}>{SHORTCUTS.length} keyboard shortcuts - see Help, Keyboard Shortcuts (Ctrl+Alt+K).</div>
    </div>
  );
}

export function useContextItems(): ContextMenuItem[] {
  return useMemo(() => [], []);
}
