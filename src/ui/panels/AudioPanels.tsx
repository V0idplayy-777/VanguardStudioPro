import React, { useEffect, useRef, useState } from 'react';
import { useProject, useActiveSequence } from '../../state/projectStore';
import { useUI, toast } from '../../state/uiStore';
import { usePlayback, getTimelineAudio } from '../../engine/playback/playback';
import { Slider, HotText, IconButton, Empty, Button, Select, Checkbox, MenuButton } from '../controls';
import { Icon } from '../icons';
import type { Sequence, Track, Clip } from '../../types/project';
import { param as mkParam } from '../../types/project';
import { AUDIO_EFFECTS, AUDIO_EFFECT_MAP } from '../../engine/effects/audioRegistry';
import { clamp, uid, gainToDb } from '../../engine/util';
import { renderSequenceAudio, measureLoudness } from '../../engine/audio/timelineAudio';
import { evalParam, setKeyframe } from '../../engine/keyframes';
import { defaultEffectParams } from '../../engine/effects/registry';
import { cmd } from '../../app/commands';

const DB_MARKS = [12, 6, 0, -6, -12, -24, -48];
const dbToPos = (db: number) => clamp((db + 60) / 72, 0, 1); // -60..12 maps 0..1

function levelColor(db: number) {
  return db > -3 ? '#d94a3d' : db > -12 ? '#d9a441' : '#4da58a';
}

/** Small stereo meter driven by an analyser reading each frame. */
function LiveMeter({ read, height = 120, width = 8, showScale }: { read: () => { peak: number[]; rms: number[] } | null; height?: number; width?: number; showScale?: boolean }) {
  const lRef = useRef<HTMLDivElement>(null),
    rRef = useRef<HTMLDivElement>(null),
    lpRef = useRef<HTMLDivElement>(null),
    rpRef = useRef<HTMLDivElement>(null),
    clipRef = useRef<HTMLDivElement>(null);
  const playing = usePlayback((s) => s.playing);
  useEffect(() => {
    let raf = 0;
    let holdL = -60,
      holdR = -60,
      holdT = 0;
    const paint = (l: number, r: number) => {
      const t = performance.now();
      if (l >= holdL || t - holdT > 1200) {
        holdL = l;
        holdT = t;
      }
      if (r >= holdR || t - holdT > 1200) holdR = r;
      if (lRef.current) {
        lRef.current.style.height = `${dbToPos(l) * 100}%`;
        lRef.current.style.background = levelColor(l);
      }
      if (rRef.current) {
        rRef.current.style.height = `${dbToPos(r) * 100}%`;
        rRef.current.style.background = levelColor(r);
      }
      if (lpRef.current) lpRef.current.style.bottom = `${dbToPos(holdL) * 100}%`;
      if (rpRef.current) rpRef.current.style.bottom = `${dbToPos(holdR) * 100}%`;
      if (clipRef.current && (l > -0.1 || r > -0.1)) clipRef.current.classList.add('on');
    };
    if (!playing) {
      paint(-60, -60);
      return;
    }
    const tick = () => {
      const m = read();
      const l = m ? gainToDb(m.peak[0]) : -60;
      const r = m ? gainToDb(m.peak[1] ?? m.peak[0]) : -60;
      paint(Math.max(-60, l), Math.max(-60, r));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, read]);
  return (
    <div className="vu" style={{ height, alignItems: 'stretch' }}>
      {showScale ? (
        <div className="db-scale" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', fontSize: 9, color: 'var(--c-text-faint)', width: 20, textAlign: 'right', position: 'relative' }}>
          {DB_MARKS.map((d) => (
            <span key={d} style={{ position: 'absolute', right: 2, bottom: `calc(${dbToPos(d) * 100}% - 5px)` }}>{d}</span>
          ))}
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div ref={clipRef} className="clip-ind" title="Clip indicator (click to reset)" onClick={(e) => (e.currentTarget as HTMLElement).classList.remove('on')} style={{ width: width * 2 + 2 }} />
        <div style={{ display: 'flex', gap: 2, flex: 1 }}>
          <div className="bar" style={{ width }}>
            <div ref={lRef} className="lvl" style={{ bottom: 0, height: 0 }} />
            <div ref={lpRef} className="pk" style={{ height: 1, background: '#e0e0e0', bottom: 0 }} />
          </div>
          <div className="bar" style={{ width }}>
            <div ref={rRef} className="lvl" style={{ bottom: 0, height: 0 }} />
            <div ref={rpRef} className="pk" style={{ height: 1, background: '#e0e0e0', bottom: 0 }} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Audio Track Mixer ---------- */

export function AudioTrackMixer() {
  const seq = useActiveSequence();
  const masterDb = usePlayback((s) => s.masterDb);
  const masterMute = usePlayback((s) => s.masterMute);
  const [showFx, setShowFx] = useState(true);
  if (!seq) return <Empty title="Audio Track Mixer" icon="mixer">Open a sequence to mix its audio tracks.</Empty>;
  const tracks = seq.tracks.filter((t) => t.kind === 'audio');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="toolbar">
        <span style={{ color: 'var(--c-text-dim)' }}>{seq.name}</span>
        <span className="spacer" />
        <IconButton icon="effectFx" label="Show/hide track effect slots" sm on={showFx} onClick={() => setShowFx(!showFx)} />
        <IconButton icon="trackAdd" label="Add audio track" sm onClick={() => cmd.addTrack('audio')} />
      </div>
      <div className="mixer" style={{ flex: 1 }}>
        {tracks.map((t) => (
          <TrackStrip key={t.id} track={t} seq={seq} showFx={showFx} />
        ))}
        <div className="strip master">
          <span className="strip-name" title="Master output">Master</span>
          {showFx ? <div style={{ height: 4 * 20 + 4, width: 68 }} /> : null}
          <div className="pan-knob" style={{ height: 22 }} />
          <div className="fader-area">
            <div className="db-scale">
              {DB_MARKS.map((d) => (
                <span key={d}>{d}</span>
              ))}
            </div>
            <Slider vertical value={masterDb} min={-60} max={12} step={0.1} zero={0} onChange={(v) => usePlayback.getState().setMaster(v)} style={{ height: '100%' }} title="Master fader (dB)" />
            <LiveMeter read={() => getTimelineAudio().readMaster()} height={undefined as any} />
          </div>
          <span className="db-readout">{masterDb.toFixed(1)} dB</span>
          <div className="btns">
            <button type="button" className={`m ${masterMute ? 'on' : ''}`} title="Mute master" onClick={() => usePlayback.getState().setMasterMute(!masterMute)}>M</button>
            <button type="button" title="Reset master fader to 0 dB" onClick={() => usePlayback.getState().setMaster(0)}>0</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TrackStrip({ track, seq, showFx }: { track: Track; seq: Sequence; showFx: boolean }) {
  const set = (patch: Partial<Track>, label = 'Track') => cmd.setTrackProp(track.id, patch, label);
  const vol = track.volume.value;
  const pan = track.pan.value;
  const setVol = (v: number, commit: boolean) => {
    if (commit) set({ volume: { ...track.volume, value: v } }, 'Track volume');
    else useProject.getState().updateTransient((p) => { const t = p.sequences.find((s) => s.id === seq.id)?.tracks.find((x) => x.id === track.id); if (t) t.volume = { ...t.volume, value: v }; });
  };
  const setPan = (v: number, commit: boolean) => {
    if (commit) set({ pan: { ...track.pan, value: v } }, 'Track pan');
    else useProject.getState().updateTransient((p) => { const t = p.sequences.find((s) => s.id === seq.id)?.tracks.find((x) => x.id === track.id); if (t) t.pan = { ...t.pan, value: v }; });
  };
  const slots = [0, 1, 2, 3];
  const addFx = (type: string, slot: number) => {
    const def = AUDIO_EFFECT_MAP[type];
    if (!def) return;
    useProject.getState().update(`Track effect ${def.name}`, (p) => {
      const t = p.sequences.find((s) => s.id === seq.id)?.tracks.find((x) => x.id === track.id);
      if (!t) return;
      const inst = { id: uid('tfx'), type, enabled: true, params: defaultEffectParams(def), masks: [] };
      if (t.effects[slot]) t.effects[slot] = inst;
      else t.effects.push(inst);
    });
  };
  return (
    <div className="strip">
      <span className="strip-name" title={track.name} onDoubleClick={() => useUI.getState().openModal({ kind: 'rename', payload: { title: 'Rename Track', label: 'Track name', value: track.name, onSubmit: (n: string) => set({ name: n }, 'Rename track') } })}>{track.name}</span>
      {showFx ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, width: 68 }}>
          {slots.map((i) => {
            const fx = track.effects[i];
            const def = fx ? AUDIO_EFFECT_MAP[fx.type] : null;
            return (
              <MenuButton
                key={i}
                className="btn sm"
                title={def ? `${def.name} (click to change/remove)` : 'Insert a track effect'}
                items={() => [
                  ...(fx ? [{ label: fx.enabled ? 'Bypass' : 'Enable', onSelect: () => useProject.getState().update('Bypass track effect', (p) => { const t = p.sequences.find((s) => s.id === seq.id)?.tracks.find((x) => x.id === track.id); const f = t?.effects.find((e) => e.id === fx.id); if (f) f.enabled = !f.enabled; }) }, { label: 'Edit in Effect Controls (select a clip on this track first)', disabled: true }, { label: 'Remove', danger: true, onSelect: () => useProject.getState().update('Remove track effect', (p) => { const t = p.sequences.find((s) => s.id === seq.id)?.tracks.find((x) => x.id === track.id); if (t) t.effects = t.effects.filter((e) => e.id !== fx.id); }) }, { separator: true }] : []),
                  ...AUDIO_EFFECTS.map((d) => ({ label: d.name, checked: fx?.type === d.type, onSelect: () => addFx(d.type, i) })),
                ]}
              >
                <span style={{ fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 58, color: fx && !fx.enabled ? 'var(--c-text-faint)' : undefined }}>{def ? def.name : '-'}</span>
              </MenuButton>
            );
          })}
        </div>
      ) : null}
      <div className="pan-knob" title="Pan (drag; double-click to center)">
        <PanKnob value={pan} onChange={setPan} />
      </div>
      <div className="fader-area">
        <div className="db-scale">
          {DB_MARKS.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        <Slider vertical value={vol} min={-60} max={12} step={0.1} zero={0} onChange={setVol} onBegin={() => useProject.getState().beginBatch('Track volume')} onEnd={() => useProject.getState().endBatch()} style={{ height: '100%' }} title={`${track.name} fader (dB)`} />
        <LiveMeter read={() => getTimelineAudio().readTrack(track.id)} height={undefined as any} />
      </div>
      <HotText value={vol} min={-60} max={12} step={0.1} unit=" dB" width={60} onChange={setVol} />
      <div className="btns">
        <button type="button" className={`m ${track.muted ? 'on' : ''}`} title="Mute" onClick={() => set({ muted: !track.muted }, 'Mute track')}>M</button>
        <button type="button" className={`s ${track.solo ? 'on' : ''}`} title="Solo" onClick={() => set({ solo: !track.solo }, 'Solo track')}>S</button>
        <button type="button" className={track.locked ? 'on r' : ''} title="Lock" onClick={() => set({ locked: !track.locked }, 'Lock track')}><Icon name="lock" size={9} /></button>
      </div>
    </div>
  );
}

function PanKnob({ value, onChange }: { value: number; onChange: (v: number, commit: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const y0 = e.clientY,
      x0 = e.clientX,
      v0 = value;
    useProject.getState().beginBatch('Pan');
    const move = (ev: PointerEvent) => onChange(clamp(v0 + ((ev.clientX - x0) - (ev.clientY - y0)) / 60, -1, 1), false);
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onChange(clamp(v0 + ((ev.clientX - x0) - (ev.clientY - y0)) / 60, -1, 1), true);
      useProject.getState().endBatch();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const ang = value * 135;
  return (
    <>
      <div ref={ref} onPointerDown={down} onDoubleClick={() => onChange(0, true)} style={{ width: 24, height: 24, borderRadius: 12, border: '1px solid var(--c-line-strong)', background: '#1c1c1c', position: 'relative', cursor: 'ns-resize' }}>
        <div style={{ position: 'absolute', left: 11, top: 2, width: 2, height: 9, background: '#e0e0e0', transformOrigin: '1px 10px', transform: `rotate(${ang}deg)` }} />
      </div>
      <span style={{ fontSize: 9, color: 'var(--c-text-faint)' }}>{value === 0 ? 'C' : value < 0 ? `L${Math.round(-value * 100)}` : `R${Math.round(value * 100)}`}</span>
    </>
  );
}

/* ---------- Audio Clip Mixer ---------- */

export function AudioClipMixer() {
  const seq = useActiveSequence();
  const playhead = usePlayback((s) => s.playhead);
  if (!seq) return <Empty title="Audio Clip Mixer" icon="mixer">Open a sequence to mix the clips under the playhead.</Empty>;
  const tracks = seq.tracks.filter((t) => t.kind === 'audio');
  const clipsUnder = tracks.map((t) => ({ track: t, clip: seq.clips.find((c) => c.trackId === t.id && playhead >= c.start && playhead < c.start + c.duration) ?? null }));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="toolbar">
        <span style={{ color: 'var(--c-text-dim)' }}>Clips under the playhead - faders write clip volume (keyframed when animation is on)</span>
      </div>
      <div className="mixer" style={{ flex: 1 }}>
        {clipsUnder.map(({ track, clip }) => (
          <ClipStrip key={track.id} track={track} clip={clip} seq={seq} playhead={playhead} />
        ))}
        {!tracks.length ? <Empty>No audio tracks.</Empty> : null}
      </div>
    </div>
  );
}

function ClipStrip({ track, clip, seq, playhead }: { track: Track; clip: Clip | null; seq: Sequence; playhead: number }) {
  const cleanedPreset = useProject((s) => (clip?.assetId ? s.project.assets.find((a) => a.id === clip.assetId)?.cleanedAudio?.preset : undefined));
  const local = clip ? playhead - clip.start : 0;
  const vol = clip ? evalParam(clip.audio.volume, local) : -60;
  const pan = clip ? evalParam(clip.audio.pan, local) / 100 : 0;
  const write = (label: string, fn: (c: Clip) => void, transient: boolean) => {
    if (!clip) return;
    const run = (p: any) => {
      const c = p.sequences.find((s: Sequence) => s.id === seq.id)?.clips.find((x: Clip) => x.id === clip.id);
      if (c) fn(c);
    };
    if (transient) useProject.getState().updateTransient(run);
    else useProject.getState().update(label, run);
  };
  const setVol = (v: number, commit: boolean) => write('Clip volume', (c) => { c.audio.volume = c.audio.volume.animated ? { ...setKeyframe(c.audio.volume, local, v), animated: true } : { ...c.audio.volume, value: v }; }, !commit);
  const setPan = (v: number, commit: boolean) => write('Clip pan', (c) => { const pv = Math.round(v * 100); c.audio.pan = c.audio.pan.animated ? { ...setKeyframe(c.audio.pan, local, pv), animated: true } : { ...c.audio.pan, value: pv }; }, !commit);
  return (
    <div className="strip" style={{ opacity: clip ? 1 : 0.5 }}>
      <span className="strip-name" title={clip ? clip.name : `${track.name}: no clip at playhead`}>{clip ? clip.name : track.name}</span>
      <div className="pan-knob"><PanKnob value={pan} onChange={setPan} /></div>
      <div className="fader-area">
        <div className="db-scale">{DB_MARKS.map((d) => <span key={d}>{d}</span>)}</div>
        <Slider vertical value={vol} min={-60} max={12} step={0.1} zero={0} disabled={!clip} onChange={setVol} onBegin={() => useProject.getState().beginBatch('Clip volume')} onEnd={() => useProject.getState().endBatch()} style={{ height: '100%' }} title="Clip volume (dB)" />
        <LiveMeter read={() => getTimelineAudio().readTrack(track.id)} height={undefined as any} />
      </div>
      <HotText value={vol} min={-60} max={12} step={0.1} unit=" dB" width={60} disabled={!clip} onChange={setVol} />
      <div className="btns">
        <button type="button" className={`m ${clip?.audio.muted ? 'on' : ''}`} title="Mute clip" disabled={!clip} onClick={() => write('Mute clip', (c) => { c.audio.muted = !c.audio.muted; }, false)}>M</button>
        <button type="button" className={clip?.audio.volume.animated ? 'on s' : ''} title="Write keyframes (toggle volume animation)" disabled={!clip} onClick={() => write('Toggle volume animation', (c) => { c.audio.volume = c.audio.volume.animated ? { value: evalParam(c.audio.volume, local), keyframes: [], animated: false } : { ...setKeyframe(c.audio.volume, local, evalParam(c.audio.volume, local)), animated: true }; }, false)}>W</button>
        <button type="button" className={`m ${clip?.audio.enhanced ? 'on' : ''}`} title={cleanedPreset ? `Cleaned audio (${cleanedPreset}) — toggle to A/B against the original` : 'No cleaned take yet — select the clip and run Clip > Clean Up Voice'} disabled={!clip || !cleanedPreset} onClick={() => write('Toggle cleaned audio', (c) => { c.audio.enhanced = !c.audio.enhanced; }, false)}>C</button>
      </div>
    </div>
  );
}

/* ---------- Audio Meters (master) ---------- */

export function AudioMetersPanel() {
  const masterDb = usePlayback((s) => s.masterDb);
  const masterMute = usePlayback((s) => s.masterMute);
  const [peakText, setPeakText] = useState<[number, number]>([-60, -60]);
  const playing = usePlayback((s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let max: [number, number] = [-60, -60];
    const tick = () => {
      const m = getTimelineAudio().readMaster();
      const l = gainToDb(m.peak[0]),
        r = gainToDb(m.peak[1]);
      if (l > max[0] || r > max[1]) {
        max = [Math.max(max[0], l), Math.max(max[1], r)];
        setPeakText([...max] as [number, number]);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="meters" style={{ flex: 1 }}>
        <LiveMeter read={() => getTimelineAudio().readMaster()} height={undefined as any} width={12} showScale />
      </div>
      <div className="toolbar" style={{ borderTop: '1px solid var(--c-line)', borderBottom: 0, fontSize: 10, justifyContent: 'space-between' }}>
        <span className="tc" title="Session peak L / R (reset on click)" onClick={() => setPeakText([-60, -60])} style={{ cursor: 'pointer' }}>{peakText[0] <= -60 ? '-inf' : peakText[0].toFixed(1)} / {peakText[1] <= -60 ? '-inf' : peakText[1].toFixed(1)}</span>
        <button type="button" className={`ibtn sm ${masterMute ? 'on' : ''}`} title={masterMute ? 'Unmute master' : 'Mute master'} onClick={() => usePlayback.getState().setMasterMute(!masterMute)}><Icon name={masterMute ? 'volumeOff' : 'volume'} size={11} /></button>
        <HotText value={masterDb} min={-60} max={12} step={0.5} unit=" dB" width={56} onChange={(v) => usePlayback.getState().setMaster(v)} />
      </div>
    </div>
  );
}

/* ---------- Loudness (offline measurement, ITU BS.1770) ---------- */

export function LoudnessPanel() {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ReturnType<typeof measureLoudness> | null>(null);
  const [target, setTarget] = useState<number>(-14);
  const [useInOut, setUseInOut] = useState(true);
  const measure = async () => {
    if (!seq) return;
    const start = useInOut && seq.inPoint != null ? seq.inPoint : 0;
    const end = useInOut && seq.outPoint != null ? seq.outPoint : Math.max(...seq.clips.map((c) => c.start + c.duration), 1);
    if (end - start > 30 * 60 * seq.settings.fps) return toast('warning', 'Range too long', 'Measure up to 30 minutes at a time (set In/Out to narrow it).');
    setBusy(true);
    setProgress(0);
    try {
      const buf = await renderSequenceAudio(project, seq, start, end, 48000, setProgress);
      setResult(measureLoudness(buf));
    } catch (e) {
      toast('error', 'Loudness measurement failed', String(e));
    } finally {
      setBusy(false);
    }
  };
  const applyGain = () => {
    if (!result || !seq || !isFinite(result.integrated)) return;
    const delta = target - result.integrated;
    useProject.getState().update('Normalize loudness', (p) => {
      const s = p.sequences.find((x) => x.id === seq.id)!;
      const audioTrackIds = new Set(s.tracks.filter((t) => t.kind === 'audio').map((t) => t.id));
      for (const c of s.clips) if (audioTrackIds.has(c.trackId)) c.audio.gain = +(c.audio.gain + delta).toFixed(2);
    });
    setResult({ ...result, integrated: target, shortTermMax: result.shortTermMax + delta, momentaryMax: result.momentaryMax + delta, truePeak: result.truePeak + delta });
    toast('success', 'Gain applied', `All audio clips adjusted by ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} dB.`);
  };
  const fmt = (v: number) => (isFinite(v) ? v.toFixed(1) : '-inf');
  return (
    <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button primary sm onClick={measure} disabled={!seq || busy} icon="loudness">{busy ? `Measuring ${Math.round(progress * 100)}%` : 'Measure'}</Button>
        <Checkbox checked={useInOut} onChange={setUseInOut} label="Use In/Out range" />
        <span className="spacer" />
        <span style={{ color: 'var(--c-text-dim)' }}>Target</span>
        <Select value={String(target)} options={[{ value: '-14', label: '-14 LUFS (streaming)' }, { value: '-16', label: '-16 LUFS (podcast)' }, { value: '-23', label: '-23 LUFS (EBU R128)' }, { value: '-24', label: '-24 LKFS (ATSC A/85)' }]} onChange={(v) => setTarget(Number(v))} />
      </div>
      {result ? (
        <div className="kv" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px', maxWidth: 360 }}>
          <span className="label">Integrated</span><span className="tc" style={{ fontSize: 20, color: Math.abs(result.integrated - target) <= 1 ? 'var(--c-ok)' : 'var(--c-text-bright)' }}>{fmt(result.integrated)} LUFS</span>
          <span className="label">Short-term max</span><span className="tc">{fmt(result.shortTermMax)} LUFS</span>
          <span className="label">Momentary max</span><span className="tc">{fmt(result.momentaryMax)} LUFS</span>
          <span className="label">True peak</span><span className="tc" style={{ color: result.truePeak > -1 ? 'var(--c-danger)' : undefined }}>{fmt(result.truePeak)} dBTP</span>
          <span className="label">Loudness range</span><span className="tc">{fmt(result.range)} LU</span>
          <span className="label">Offset to target</span><span className="tc">{isFinite(result.integrated) ? `${target - result.integrated >= 0 ? '+' : ''}${(target - result.integrated).toFixed(1)} dB` : '-'}</span>
        </div>
      ) : (
        <div className="empty" style={{ marginTop: 8 }}>
          <strong>Loudness Meter</strong>
          Renders the sequence audio offline and measures it with K-weighting and gating (ITU-R BS.1770-4). Nothing plays back while measuring.
        </div>
      )}
      {result && isFinite(result.integrated) ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button sm onClick={applyGain} icon="volume">Match target ({target} LUFS)</Button>
          <Button sm onClick={() => setResult(null)}>Clear</Button>
        </div>
      ) : null}
    </div>
  );
}

export { mkParam };
