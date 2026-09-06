import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useUI, toast, type ModalRequest, type WorkspaceId } from '../../state/uiStore';
import { useProject, useActiveSequence, findAsset, createSequence, sequenceDuration } from '../../state/projectStore';
import { usePlayback, renderFrameToCanvas } from '../../engine/playback/playback';
import { useLayout } from '../../state/layoutStore';
import { Modal, Button, Select, Checkbox, HotText, TextField, TextArea, TimecodeField, ColorChip, Segmented, Kbd, Slider } from '../controls';
import { Icon, Swatch, type IconName } from '../icons';
import { cmd } from '../../app/commands';
import { SHORTCUTS } from '../../app/shortcuts';
import { ExportPanel } from '../panels/ExportPanel';
import { LABEL_COLORS, MARKER_COLORS, DEFAULT_SEQUENCE_SETTINGS, type LabelColor, type Marker, type MarkerKind, type SequenceSettings, type Clip } from '../../types/project';
import { framesToTimecode } from '../../engine/timecode';
import { getMedia } from '../../engine/media/mediaStore';
import { pickFiles, relinkAsset, MEDIA_ACCEPT } from '../../engine/media/importer';
import { autosaveInfo, loadAutosavedProject, restoreProjectMedia, discardAutosave } from '../../engine/project/serialize';
import { estimateStorage } from '../../engine/media/mediaDb';
import { formatBytes, uid, isMac } from '../../engine/util';
import { aboutVersionClick, foundCount, EGG_TOTAL, checkSpeedEgg, checkSequenceNameEgg } from '../../easter/eggs';
import { TRANSITIONS, AUDIO_TRANSITIONS } from '../../engine/effects/transitions';
import { blankTextDocument, shapeLayer } from '../graphics/templates';
import * as E from '../../engine/timeline/edits';
import { evalNumber } from '../../engine/keyframes';

export const APP_VERSION = '1.0.0';
export const BUILD_ID = '2026.09.06';

export function ModalHost() {
  const modal = useUI((s) => s.modal);
  const close = useUI((s) => s.closeModal);
  if (!modal) return null;
  const props = { modal, close };
  switch (modal.kind) {
    case 'newSequence':
      return <NewSequenceModal {...props} />;
    case 'sequenceSettings':
      return <SequenceSettingsModal {...props} />;
    case 'export':
      return (
        <Modal title="Export" icon="export" onClose={close} width={860}>
          <div style={{ height: 'min(640px, 78vh)', margin: '-12px -14px -12px', display: 'flex', flexDirection: 'column' }}>
            <ExportPanel inModal onClose={close} />
          </div>
        </Modal>
      );
    case 'keyboardShortcuts':
      return <ShortcutsModal {...props} />;
    case 'preferences':
      return <PreferencesModal {...props} />;
    case 'about':
      return <AboutModal {...props} />;
    case 'projectSettings':
      return <ProjectSettingsModal {...props} />;
    case 'newBin':
      return <RenameModal modal={{ kind: 'rename', payload: { title: 'New Bin', label: 'Bin name', value: 'New Bin', onSubmit: (n: string) => cmd.newBin(n) } }} close={close} />;
    case 'rename':
      return <RenameModal {...props} />;
    case 'audioGain':
      return <AudioGainModal {...props} />;
    case 'speedDuration':
      return <SpeedDurationModal {...props} />;
    case 'newItem':
      return <NewGraphicModal {...props} />;
    case 'colorMatte':
      return <ColorMatteModal {...props} />;
    case 'markerEdit':
      return <MarkerModal {...props} />;
    case 'captionsImport':
      return <CaptionsImportModal {...props} />;
    case 'nest':
      return <NestModal {...props} />;
    case 'confirm':
      return <ConfirmModal {...props} />;
    case 'linkMedia':
      return <LinkMediaModal {...props} />;
    case 'projectManager':
      return <ProjectManagerModal {...props} />;
    case 'sceneDetect':
      return <SceneDetectModal {...props} />;
    case 'autoDucking':
      return <AutoDuckingModal {...props} />;
    case 'interpretFootage':
      return <InterpretFootageModal {...props} />;
    case 'labelPicker':
      return <LabelPickerModal {...props} />;
    case 'generateCountdown':
      return <CountdownModal {...props} />;
    case 'workspaceManager':
      return <WorkspaceManagerModal {...props} />;
    case 'timeRemap':
      return <TimeRemapModal {...props} />;
    case 'welcome':
      return <WelcomeModal {...props} />;
    case 'easter':
      return null;
    default:
      return null;
  }
}

type P = { modal: ModalRequest; close: () => void };

/* ---------- helpers ---------- */
const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120];
const SIZE_PRESETS: { label: string; w: number; h: number }[] = [
  { label: 'UHD 4K 3840x2160', w: 3840, h: 2160 },
  { label: 'DCI 4K 4096x2160', w: 4096, h: 2160 },
  { label: 'QHD 2560x1440', w: 2560, h: 1440 },
  { label: 'Full HD 1920x1080', w: 1920, h: 1080 },
  { label: 'HD 1280x720', w: 1280, h: 720 },
  { label: 'Vertical 1080x1920', w: 1080, h: 1920 },
  { label: 'Square 1080x1080', w: 1080, h: 1080 },
  { label: 'Cinema 2.39 2048x858', w: 2048, h: 858 },
  { label: 'SD PAL 720x576', w: 720, h: 576 },
  { label: 'SD NTSC 720x480', w: 720, h: 480 },
];

function SequenceSettingsForm({ value, onChange, lockedNote }: { value: SequenceSettings; onChange: (s: SequenceSettings) => void; lockedNote?: string }) {
  const set = (patch: Partial<SequenceSettings>) => onChange({ ...value, ...patch });
  const sizeId = SIZE_PRESETS.find((p) => p.w === value.width && p.h === value.height)?.label ?? 'custom';
  return (
    <div className="prop-grid">
      <span className="label">Frame size</span>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Select value={sizeId} options={[...SIZE_PRESETS.map((p) => ({ value: p.label, label: p.label })), { value: 'custom', label: 'Custom' }]} onChange={(v) => { const p = SIZE_PRESETS.find((x) => x.label === v); if (p) set({ width: p.w, height: p.h }); }} />
        <HotText value={value.width} min={16} max={8192} step={2} width={60} onChange={(v, c) => c && set({ width: Math.round(v / 2) * 2 })} />
        <span className="label">x</span>
        <HotText value={value.height} min={16} max={8192} step={2} width={60} onChange={(v, c) => c && set({ height: Math.round(v / 2) * 2 })} />
      </span>
      <span className="label">Timebase</span>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <Select value={String(value.fps)} options={FPS_OPTIONS.map((f) => ({ value: String(f), label: `${f} fps` }))} onChange={(v) => set({ fps: Number(v), dropFrame: Number(v) === 29.97 || Number(v) === 59.94 ? value.dropFrame : false })} />
        <Checkbox checked={value.dropFrame} onChange={(v) => set({ dropFrame: v })} label="Drop-frame timecode" disabled={!(value.fps === 29.97 || value.fps === 59.94)} />
      </span>
      <span className="label">Pixel aspect</span>
      <Select value={String(value.pixelAspect)} options={[{ value: '1', label: 'Square pixels (1.0)' }, { value: '0.9091', label: 'D1/DV NTSC (0.9091)' }, { value: '1.0940', label: 'D1/DV PAL (1.0940)' }, { value: '1.3333', label: 'HD Anamorphic 1080 (1.3333)' }, { value: '2', label: 'Anamorphic 2:1 (2.0)' }]} onChange={(v) => set({ pixelAspect: Number(v) })} />
      <span className="label">Fields</span>
      <Select value={value.fieldOrder} options={[{ value: 'progressive', label: 'No fields (progressive)' }, { value: 'upper', label: 'Upper field first' }, { value: 'lower', label: 'Lower field first' }]} onChange={(v) => set({ fieldOrder: v as SequenceSettings['fieldOrder'] })} />
      <span className="label">Audio</span>
      <Select value={String(value.sampleRate)} options={[{ value: '48000', label: '48000 Hz' }, { value: '44100', label: '44100 Hz' }, { value: '96000', label: '96000 Hz' }]} onChange={(v) => set({ sampleRate: Number(v) })} />
      <span className="label">Color</span>
      <Select value={value.colorSpace} options={[{ value: 'rec709', label: 'Rec. 709' }, { value: 'srgb', label: 'sRGB' }]} onChange={(v) => set({ colorSpace: v as SequenceSettings['colorSpace'] })} />
      <span className="label">Preview</span>
      <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Segmented value={value.previewScale} options={[{ value: 1, label: 'Full' }, { value: 2, label: '1/2' }, { value: 4, label: '1/4' }]} onChange={(v) => set({ previewScale: v as 1 | 2 | 4 })} />
        <Checkbox checked={value.maxRenderQuality} onChange={(v) => set({ maxRenderQuality: v })} label="Maximum render quality" />
        <Checkbox checked={value.maxBitDepth} onChange={(v) => set({ maxBitDepth: v })} label="Maximum bit depth" />
      </span>
      {lockedNote ? <><span /><span style={{ color: 'var(--c-text-dim)', fontSize: 11 }}>{lockedNote}</span></> : null}
    </div>
  );
}

/* ---------- New Sequence ---------- */
function NewSequenceModal({ close }: P) {
  const project = useProject((s) => s.project);
  const [name, setName] = useState(() => `Sequence ${String(project.sequences.length + 1).padStart(2, '0')}`);
  const [settings, setSettings] = useState<SequenceSettings>({ ...project.settings.defaultSequence });
  const [video, setVideo] = useState(3);
  const [audio, setAudio] = useState(3);
  const [tab, setTab] = useState<'presets' | 'settings' | 'tracks'>('presets');
  const [preset, setPreset] = useState<string | null>(null);
  const presets = useMemo(() => {
    const out: { id: string; group: string; label: string; s: Partial<SequenceSettings>; note: string }[] = [];
    for (const [w, h, g] of [[1920, 1080, 'HD'], [3840, 2160, 'UHD'], [1280, 720, 'HD'], [1080, 1920, 'Social'], [1080, 1080, 'Social'], [2048, 858, 'Cinema']] as [number, number, string][]) {
      for (const f of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]) {
        if (g === 'Social' && ![24, 25, 30, 60].includes(f)) continue;
        if (g === 'Cinema' && ![23.976, 24].includes(f)) continue;
        out.push({ id: `${w}x${h}@${f}`, group: g, label: `${w}x${h} ${f}p`, s: { width: w, height: h, fps: f, dropFrame: f === 29.97 || f === 59.94 }, note: `${w} x ${h}, ${f} fps, square pixels, 48 kHz stereo` });
      }
    }
    return out;
  }, []);
  const groups = [...new Set(presets.map((p) => p.group))];
  const create = () => {
    const nm = name.trim() || 'Sequence';
    cmd.createSequence(nm, settings, { video, audio });
    checkSequenceNameEgg(nm);
    close();
  };
  return (
    <Modal title="New Sequence" icon="sequence" onClose={close} width={640} footer={<><span className="spacer" /><Button onClick={close}>Cancel</Button><Button primary onClick={create}>Create</Button></>}>
      <div className="tabs" style={{ marginBottom: 10 }}>
        <button type="button" className={tab === 'presets' ? 'on' : ''} onClick={() => setTab('presets')}>Sequence Presets</button>
        <button type="button" className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>Settings</button>
        <button type="button" className={tab === 'tracks' ? 'on' : ''} onClick={() => setTab('tracks')}>Tracks</button>
      </div>
      {tab === 'presets' ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 12, height: 300 }}>
          <div className="scroll-y" style={{ border: '1px solid var(--c-line)' }}>
            {groups.map((g) => (
              <div key={g}>
                <div style={{ padding: '6px 8px 2px', color: 'var(--c-text-dim)', fontSize: 11 }}>{g}</div>
                {presets.filter((p) => p.group === g).map((p) => (
                  <div key={p.id} className={`list-row${preset === p.id ? ' selected' : ''}`} onClick={() => { setPreset(p.id); setSettings((s) => ({ ...s, ...p.s })); }} onDoubleClick={create}>
                    <Icon name="sequence" size={12} style={{ color: 'var(--c-text-dim)' }} />
                    <span className="grow">{p.label}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--c-text-dim)', lineHeight: 1.5 }}>
            <div style={{ color: 'var(--c-text)', marginBottom: 4 }}>Preset description</div>
            {preset ? presets.find((p) => p.id === preset)?.note : 'Pick a preset, or set everything by hand under Settings. New sequences start empty.'}
            <div style={{ marginTop: 10, color: 'var(--c-text)' }}>Current</div>
            {settings.width} x {settings.height}, {settings.fps} fps{settings.dropFrame ? ' DF' : ''}, {settings.sampleRate / 1000} kHz
          </div>
        </div>
      ) : null}
      {tab === 'settings' ? <SequenceSettingsForm value={settings} onChange={setSettings} /> : null}
      {tab === 'tracks' ? (
        <div className="prop-grid">
          <span className="label">Video tracks</span>
          <HotText value={video} min={1} max={32} step={1} width={50} onChange={(v, c) => c && setVideo(Math.round(v))} />
          <span className="label">Audio tracks</span>
          <HotText value={audio} min={0} max={32} step={1} width={50} onChange={(v, c) => c && setAudio(Math.round(v))} />
          <span />
          <span style={{ color: 'var(--c-text-dim)', fontSize: 11 }}>Tracks can be added and removed later from the timeline header context menu.</span>
        </div>
      ) : null}
      <div className="prop-grid" style={{ marginTop: 12, borderTop: '1px solid var(--c-line-faint)', paddingTop: 10 }}>
        <span className="label">Sequence name</span>
        <TextField value={name} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && create()} />
      </div>
    </Modal>
  );
}

/* ---------- Sequence Settings (existing) ---------- */
function SequenceSettingsModal({ close }: P) {
  const seq = useActiveSequence();
  const [settings, setSettings] = useState<SequenceSettings>(seq ? { ...seq.settings } : { ...DEFAULT_SEQUENCE_SETTINGS });
  const [name, setName] = useState(seq?.name ?? '');
  if (!seq) return null;
  const apply = () => {
    const fpsChanged = settings.fps !== seq.settings.fps;
    useProject.getState().update('Sequence settings', (p) => {
      const s = p.sequences.find((x) => x.id === seq.id);
      if (!s) return;
      if (fpsChanged) {
        const ratio = settings.fps / s.settings.fps;
        for (const c of s.clips) {
          c.start = Math.round(c.start * ratio);
          c.duration = Math.max(1, Math.round(c.duration * ratio));
        }
        s.markers.forEach((m) => { m.time = Math.round(m.time * ratio); m.duration = Math.round(m.duration * ratio); });
        s.captions.forEach((c) => { c.start = Math.round(c.start * ratio); c.end = Math.round(c.end * ratio); });
        if (s.inPoint != null) s.inPoint = Math.round(s.inPoint * ratio);
        if (s.outPoint != null) s.outPoint = Math.round(s.outPoint * ratio);
      }
      s.settings = settings;
      const nm = name.trim();
      if (nm && nm !== s.name) {
        s.name = nm;
        const a = p.assets.find((x) => x.kind === 'sequence' && x.sequenceId === s.id);
        if (a) a.name = nm;
      }
    });
    checkSequenceNameEgg(name);
    close();
  };
  return (
    <Modal title="Sequence Settings" icon="sequence" onClose={close} width={620} footer={<><span className="spacer" /><Button onClick={close}>Cancel</Button><Button primary onClick={apply}>OK</Button></>}>
      <div className="prop-grid" style={{ marginBottom: 10 }}>
        <span className="label">Name</span>
        <TextField value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <SequenceSettingsForm value={settings} onChange={setSettings} lockedNote={settings.fps !== seq.settings.fps ? 'Changing the timebase re-times all clips, markers and captions to keep their positions in seconds.' : undefined} />
    </Modal>
  );
}

/* ---------- Rename / text prompt ---------- */
function RenameModal({ modal, close }: P) {
  const payload = modal.payload ?? {};
  const seq = useActiveSequence();
  const clip = payload.clipId && seq ? seq.clips.find((c) => c.id === payload.clipId) : null;
  const [value, setValue] = useState<string>(payload.value ?? clip?.name ?? '');
  const title = payload.title ?? 'Rename Clip';
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    if (payload.onSubmit) payload.onSubmit(v);
    else if (clip) cmd.renameClip(clip.id, v);
    close();
  };
  return (
    <Modal title={title} onClose={close} width={380} footer={<><span className="spacer" /><Button onClick={close}>Cancel</Button><Button primary onClick={submit} disabled={!value.trim()}>OK</Button></>}>
      <div className="prop-grid">
        <span className="label">{payload.label ?? 'Name'}</span>
        <TextField value={value} onChange={(e) => setValue(e.target.value)} autoFocus onFocus={(e) => e.target.select()} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
    </Modal>
  );
}

/* ---------- Audio gain ---------- */
function AudioGainModal({ close }: P) {
  const seq = useActiveSequence();
  const ids = useUI((s) => s.selection.clipIds);
  const clips = seq ? seq.clips.filter((c) => ids.includes(c.id)) : [];
  const first = clips[0];
  const [mode, setMode] = useState<'set' | 'adjust' | 'normalizePeak' | 'normalizeAll'>('set');
  const [db, setDb] = useState(first?.audio.gain ?? 0);
  const [adj, setAdj] = useState(0);
  const [peak, setPeak] = useState(-1);
  const peakOf = (c: Clip) => {
    const rec = getMedia(c.assetId);
    if (!rec?.peaks) return null;
    const p = Math.max(0.0001, ...rec.peaks.map((ch) => ch.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
    return 20 * Math.log10(p);
  };
  const apply = () => {
    if (mode === 'set') cmd.setAudioGain(db);
    else if (mode === 'adjust') {
      useProject.getState().update('Adjust gain', (p) => {
        const s = p.sequences.find((x) => x.id === seq?.id);
        s?.clips.forEach((c) => ids.includes(c.id) && (c.audio.gain = Math.max(-96, Math.min(96, c.audio.gain + adj))));
      });
    } else if (mode === 'normalizePeak') cmd.setAudioGain(0, peak);
    else {
      // normalise all to the same peak: apply one common gain based on the loudest clip
      const peaks = clips.map(peakOf).filter((x): x is number => x != null);
      const loudest = peaks.length ? Math.max(...peaks) : 0;
      const g = peak - loudest;
      useProject.getState().update('Normalize all peaks', (p) => {
        const s = p.sequences.find((x) => x.id === seq?.id);
        s?.clips.forEach((c) => ids.includes(c.id) && (c.audio.gain = g));
      });
    }
    close();
  };
  const measured = first ? peakOf(first) : null;
  return (
    <Modal title="Audio Gain" icon="audio" onClose={close} width={380} footer={<><span className="spacer" /><Button onClick={close}>Cancel</Button><Button primary onClick={apply}>OK</Button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 10px', alignItems: 'center' }}>
        <Checkbox radio checked={mode === 'set'} onChange={() => setMode('set')} label="Set gain to" />
        <HotText value={db} min={-96} max={96} step={0.5} decimals={1} unit=" dB" width={80} onChange={(v, c) => c && setDb(v)} disabled={mode !== 'set'} />
        <Checkbox radio checked={mode === 'adjust'} onChange={() => setMode('adjust')} label="Adjust gain by" />
        <HotText value={adj} min={-96} max={96} step={0.5} decimals={1} unit=" dB" width={80} onChange={(v, c) => c && setAdj(v)} disabled={mode !== 'adjust'} />
        <Checkbox radio checked={mode === 'normalizePeak'} onChange={() => setMode('normalizePeak')} label="Normalize max peak to" />
        <HotText value={peak} min={-60} max={0} step={0.5} decimals={1} unit=" dB" width={80} onChange={(v, c) => c && setPeak(v)} disabled={!(mode === 'normalizePeak' || mode === 'normalizeAll')} />
        <Checkbox radio checked={mode === 'normalizeAll'} onChange={() => setMode('normalizeAll')} label="Normalize all peaks to" />
        <span />
      </div>
      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--c-text-dim)' }}>
        {clips.length} clip{clips.length === 1 ? '' : 's'} selected. Peak amplitude: {measured == null ? 'not analysed yet' : `${measured.toFixed(1)} dB`}
      </div>
    </Modal>
  );
}

/* ---------- Speed / Duration ---------- */
function SpeedDurationModal({ close }: P) {
  const seq = useActiveSequence();
  const ids = useUI((s) => s.selection.clipIds);
  const clip = seq?.clips.find((c) => ids.includes(c.id));
  const fps = seq?.settings.fps ?? 30;
  const [speed, setSpeed] = useState(clip ? clip.speed * 100 : 100);
  const [duration, setDuration] = useState(clip?.duration ?? 0);
  const [linked, setLinked] = useState(true);
  const [reverse, setReverse] = useState(clip?.reversed ?? false);
  const [pitch, setPitch] = useState(clip?.maintainPitch ?? false);
  const [ripple, setRipple] = useState(false);
  if (!clip || !seq) return null;
  const srcSpan = E.sourceSpan(clip, fps);
  const onSpeed = (s: number) => {
    setSpeed(s);
    if (linked) setDuration(Math.max(1, Math.round((srcSpan / (s / 100)) * fps)));
  };
  const onDuration = (d: number) => {
    setDuration(d);
    if (linked) setSpeed(Math.max(1, (srcSpan / (d / fps)) * 100));
  };
  const apply = () => {
    if (linked) cmd.setSpeed(speed / 100, reverse, ripple, pitch);
    else {
      useProject.getState().update('Speed/Duration', (p) => {
        const s = p.sequences.find((x) => x.id === seq.id);
        if (!s) return;
        for (const id of ids) {
          const c = s.clips.find((x) => x.id === id);
          if (!c) continue;
          E.setClipSpeed(s, id, speed / 100, { reverse, maintainPitch: pitch, keepDuration: true });
          const oldEnd = E.clipEnd(c);
          c.duration = Math.max(1, duration);
          if (ripple && E.clipEnd(c) !== oldEnd) E.ripple(s, oldEnd, E.clipEnd(c) - oldEnd, undefined, new Set([c.id]));
        }
      });
    }
    checkSpeedEgg(speed, reverse, pitch);
    close();
  };
  return (
    <Modal title="Clip Speed / Duration" icon="stopwatch" onClose={close} width={380} footer={<><span className="spacer" /><Button onClick={close}>Cancel</Button><Button primary onClick={apply}>OK</Button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 28px', gap: '8px 8px', alignItems: 'center' }}>
        <span className="label">Speed</span>
        <HotText value={speed} min={1} max={10000} step={1} decimals={2} unit="%" width={110} onChange={(v, c) => c && onSpeed(v)} />
        <button type="button" className={`ibtn sm${linked ? ' on' : ''}`} title={linked ? 'Speed and duration are linked' : 'Speed and duration are independent'} onClick={() => setLinked(!linked)} style={{ gridRow: 'span 2' }}><Icon name={linked ? 'link' : 'unlink'} size={12} /></button>
        <span className="label">Duration</span>
        <TimecodeField frames={duration} fps={fps} dropFrame={seq.settings.dropFrame} onChange={(f) => onDuration(Math.max(1, f))} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        <Checkbox checked={reverse} onChange={setReverse} label="Reverse speed" />
        <Checkbox checked={pitch} onChange={setPitch} label="Maintain audio pitch" />
        <Checkbox checked={ripple} onChange={setRipple} label="Ripple edit, shifting trailing clips" />
      </div>
      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--c-text-dim)' }}>{ids.length} clip{ids.length === 1 ? '' : 's'}. Source span {srcSpan.toFixed(2)} s.</div>
    </Modal>
  );
}

/* ---------- New graphic ---------- */
function NewGraphicModal({ modal, close }: P) {
  const seq = useActiveSequence();
  const layer: 'text' | 'rect' | 'ellipse' = modal.payload?.layer ?? 'text';
  const [name, setName] = useState(layer === 'text' ? 'Title' : layer === 'rect' ? 'Rectangle' : 'Ellipse');
  const [text, setText] = useState('Title');
  const [seconds, setSeconds] = useState(5);
  const [place, setPlace] = useState(true);
  if (!seq) return null;
  const W = seq.settings.width,
    H = seq.settings.height;
  const create = () => {
    const asset = cmd.newGenerator('graphic', {}, name.trim() || 'Graphic');
    const ph = usePlayback.getState().playhead;
    useProject.getState().update('New graphic', (p) => {
      const a = p.assets.find((x) => x.id === asset.id)!;
      const doc = blankTextDocument(W, H, text || 'Title');
      if (layer !== 'text') doc.layers = [shapeLayer(layer, W / 2, H / 2, Math.round(W * 0.3), Math.round(H * 0.3), { anchor: 'center', pin: 'center' } as any)];
      a.graphic = doc;
      if (place) {
        const s = p.sequences.find((x) => x.id === seq.id)!;
        const ids = E.placeAsset(p, s, a, ph, { mode: 'overwrite', stillFrames: Math.round(seconds * seq.settings.fps) });
        useUI.getState().selectClips(ids);
      }
    });
    if (place) useUI.getState().setWorkspace('graphics');
    close();
  };
  return (
    <Modal title="New Graphic" icon="clipTitle" onClose={close} width={400} footer={<><span className="spacer" /><Button onClick={close}>Cancel</Button><Button primary onClick={create}>Create</Button></>}>
      <div className="prop-grid">
        <span className="label">Name</span>
        <TextField value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        {layer === 'text' ? (
          <>
            <span className="label">Text</span>
            <TextArea value={text} onChange={(e) => setText(e.target.value)} rows={2} />
          </>
        ) : null}
        <span className="label">Duration</span>
        <HotText value={seconds} min={0.2} max={600} step={0.5} decimals={1} unit=" s" width={70} onChange={(v, c) => c && setSeconds(v)} />
        <span />
        <Checkbox checked={place} onChange={setPlace} label="Add to the timeline at the playhead" />
      </div>
      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--c-text-dim)' }}>{W} x {H}. Edit layers, fonts and animation in the Essential Graphics panel.</div>
    </Modal>
  );
}

/* ---------- Color matte ---------- */
function ColorMatteModal({ close }: P) {
  const [color, setColor] = useState('#808080');
  const [name, setName] = useState('Color Matte');
  const create = () => {
    cmd.newGenerator('colorMatte', { color }, name.trim() || 'Color Matte');
    close();
  };
  return (
    <Modal title="New Color Matte" onClose={close} width={360} footer={<><span className="spacer" /><Button onClick={close}>Cancel</Button><Button primary onClick={create}>OK</Button></>}>
      <div className="prop-grid">
        <span className="label">Color</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <ColorChip color={color} onChange={(h) => setColor(h)} />
          <TextField value={color} onChange={(e) => /^#[0-9a-f]{0,6}$/i.test(e.target.value) && setColor(e.target.value)} style={{ width: 90 }} />
          <div style={{ width: 60, height: 22, background: color, border: '1px solid var(--c-line)' }} />
        </span>
        <span className="label">Name</span>
        <TextField value={name} onChange={(e) => setName(e.target.value)} />
      </div>
    </Modal>
  );
}

/* ---------- Countdown ---------- */
function CountdownModal({ close }: P) {
  const [bg, setBg] = useState('#3a3a3a');
  const [wipe, setWipe] = useState('#8a8a8a');
  const [cue, setCue] = useState(true);
  const create = () => {
    cmd.newGenerator('countdown', { background: bg, wipe, cueBlip: cue, tone: 1000, level: -12 }, 'Universal Counting Leader');
    close();
  };
  return (
    <Modal title="Universal Counting Leader" onClose={close} width={380} footer={<><span className="spacer" /><Button onClick={close}>Cancel</Button><Button primary onClick={create}>OK</Button></>}>
      <div className="prop-grid">
        <span className="label">Background</span>
        <span style={{ display: 'flex', gap: 8 }}><ColorChip color={bg} onChange={(h) => setBg(h)} /><span className="dim">{bg}</span></span>
        <span className="label">Wipe</span>
        <span style={{ display: 'flex', gap: 8 }}><ColorChip color={wipe} onChange={(h) => setWipe(h)} /><span className="dim">{wipe}</span></span>
        <span />
        <Checkbox checked={cue} onChange={setCue} label="Cue blip on each second (1 kHz)" />
      </div>
      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--c-text-dim)' }}>11 second leader counting down from 10, with 2-pop at the end.</div>
    </Modal>
  );
}

/* ---------- Marker ---------- */
function MarkerModal({ modal, close }: P) {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const id: string | undefined = modal.payload?.markerId;
  const clipId: string | undefined = modal.payload?.clipId;
  const owner = clipId && seq ? seq.clips.find((c) => c.id === clipId) : null;
  const marker = owner ? owner.markers.find((m) => m.id === id) : seq?.markers.find((m) => m.id === id);
  const [m, setM] = useState<Marker | null>(marker ? { ...marker } : null);
  if (!seq || !m) return null;
  const fps = seq.settings.fps;
  const all = owner ? owner.markers : seq.markers;
  const idx = all.findIndex((x) => x.id === m.id);
  const write = (mm: Marker) => {
    useProject.getState().update('Edit marker', (p) => {
      const s = p.sequences.find((x) => x.id === seq.id);
      if (!s) return;
      const list = owner ? s.clips.find((c) => c.id === owner.id)?.markers : s.markers;
      if (!list) return;
      const i = list.findIndex((x) => x.id === mm.id);
      if (i >= 0) list[i] = mm;
      list.sort((a, b) => a.time - b.time);
    });
  };
  const ok = () => {
    write(m);
    close();
  };
  const go = (d: number) => {
    write(m);
    const nx = all[idx + d];
    if (nx) setM({ ...nx });
  };
  const del = () => {
    useProject.getState().update('Delete marker', (p) => {
      const s = p.sequences.find((x) => x.id === seq.id);
      if (!s) return;
      if (owner) {
        const c = s.clips.find((x) => x.id === owner.id);
        if (c) c.markers = c.markers.filter((x) => x.id !== m.id);
      } else s.markers = s.markers.filter((x) => x.id !== m.id);
    });
    close();
  };
  const kinds: { value: MarkerKind; label: string }[] = [{ value: 'comment', label: 'Comment Marker' }, { value: 'chapter', label: 'Chapter Marker' }, { value: 'segmentation', label: 'Segmentation Marker' }, { value: 'webLink', label: 'Web Link' }, { value: 'flashCue', label: 'Flash Cue Point' }];
  void project;
  return (
    <Modal title={owner ? 'Clip Marker' : 'Sequence Marker'} icon="marker" onClose={ok} width={460} footer={<><Button danger onClick={del}>Delete</Button><span className="spacer" /><Button onClick={() => go(-1)} disabled={idx <= 0}>Previous</Button><Button onClick={() => go(1)} disabled={idx >= all.length - 1}>Next</Button><Button primary onClick={ok}>OK</Button></>}>
      <div className="prop-grid">
        <span className="label">Name</span>
        <TextField value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} autoFocus onFocus={(e) => e.target.select()} onKeyDown={(e) => e.key === 'Enter' && ok()} />
        <span className="label">Time</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <TimecodeField frames={m.time} fps={fps} dropFrame={seq.settings.dropFrame} onChange={(f) => setM({ ...m, time: Math.max(0, f) })} />
          <span className="label">Duration</span>
          <TimecodeField frames={m.duration} fps={fps} dropFrame={seq.settings.dropFrame} onChange={(f) => setM({ ...m, duration: Math.max(0, f) })} />
        </span>
        <span className="label">Comments</span>
        <TextArea value={m.comment} onChange={(e) => setM({ ...m, comment: e.target.value })} rows={3} />
        <span className="label">Color</span>
        <span style={{ display: 'flex', gap: 4 }}>
          {Object.entries(MARKER_COLORS).map(([k, hex]) => (
            <button key={k} type="button" className={`swatch-btn${m.color === k ? ' on' : ''}`} title={k} onClick={() => setM({ ...m, color: k as Marker['color'] })} style={{ width: 20, height: 20, background: hex, border: m.color === k ? '2px solid var(--c-text-bright)' : '1px solid var(--c-line)' }} />
          ))}
        </span>
        <span className="label">Type</span>
        <Select value={m.kind} options={kinds} onChange={(v) => setM({ ...m, kind: v as MarkerKind })} />
        {m.kind === 'webLink' ? (
          <>
            <span className="label">URL</span>
            <TextField value={m.url ?? ''} onChange={(e) => setM({ ...m, url: e.target.value })} placeholder="https://" />
          </>
        ) : null}
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--c-text-dim)' }}>Marker {idx + 1} of {all.length}. Chapter markers export to YouTube chapters (Markers panel).</div>
    </Modal>
  );
}

/* ---------- Captions import / create ---------- */
function CaptionsImportModal({ close }: P) {
  const seq = useActiveSequence();
  const [mode, setMode] = useState<'file' | 'transcript'>('file');
  const [text, setText] = useState('');
  const [chars, setChars] = useState(42);
  const [secs, setSecs] = useState(3);
  const [gap, setGap] = useState(0.15);
  if (!seq) return null;
  const importFile = async () => {
    close();
    await cmd.importCaptions();
  };
  const fromTranscript = async () => {
    const { chunkTranscript } = await import('../../engine/captions/subtitles');
    const lines = chunkTranscript(text, chars);
    if (!lines.length) return toast('warning', 'Nothing to caption', 'Paste or type a transcript first.');
    const fps = seq.settings.fps;
    const start0 = usePlayback.getState().playhead;
    useProject.getState().update('Create captions', (p) => {
      const s = p.sequences.find((x) => x.id === seq.id);
      if (!s) return;
      let t = start0;
      for (const line of lines) {
        const dur = Math.max(1, Math.round(Math.max(1, Math.min(secs, line.length / 14)) * fps));
        s.captions.push({ id: uid('cap'), start: t, end: t + dur, text: line });
        t += dur + Math.round(gap * fps);
      }
      s.captions.sort((a, b) => a.start - b.start);
      s.captionTrack.enabled = true;
    });
    toast('success', 'Captions created', `${lines.length} caption${lines.length === 1 ? '' : 's'} from transcript`);
    close();
  };
  return (
    <Modal title="Captions" icon="captions" onClose={close} width={520} footer={<><span className="spacer" /><Button onClick={close}>Cancel</Button>{mode === 'file' ? <Button primary onClick={() => void importFile()}>Choose file...</Button> : <Button primary onClick={() => void fromTranscript()} disabled={!text.trim()}>Create captions</Button>}</>}>
      <Segmented value={mode} options={[{ value: 'file', label: 'Import SRT / WebVTT' }, { value: 'transcript', label: 'Create from transcript' }]} onChange={setMode} />
      {mode === 'file' ? (
        <p style={{ color: 'var(--c-text-dim)', fontSize: 12, lineHeight: 1.5, margin: '12px 0 0' }}>Import a sidecar caption file. Timings are converted to the sequence timebase ({seq.settings.fps} fps) and appended to the caption track. Style them in the Captions panel; burn them in at export or leave them as an overlay.</p>
      ) : (
        <div style={{ marginTop: 12 }}>
          <TextArea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder="Paste a transcript. Sentences are split into caption-sized lines, starting at the playhead." autoFocus />
          <div className="prop-grid" style={{ marginTop: 8 }}>
            <span className="label">Max characters per line</span>
            <HotText value={chars} min={16} max={80} step={1} width={50} onChange={(v, c) => c && setChars(Math.round(v))} />
            <span className="label">Max duration</span>
            <HotText value={secs} min={1} max={10} step={0.5} decimals={1} unit=" s" width={60} onChange={(v, c) => c && setSecs(v)} />
            <span className="label">Gap</span>
            <HotText value={gap} min={0} max={2} step={0.05} decimals={2} unit=" s" width={60} onChange={(v, c) => c && setGap(v)} />
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ---------- Nest ---------- */
function NestModal({ close }: P) {
  const project = useProject((s) => s.project);
  const [name, setName] = useState(`Nested Sequence ${String(project.sequences.length + 1).padStart(2, '0')}`);
  const ok = () => {
    cmd.nestSelection(name.trim() || undefined);
    close();
  };
  return (
    <Modal title="Nested Sequence Name" icon="sequence" onClose={close} width={380} footer={<><span className="spacer" /><Button onClick={close}>Cancel</Button><Button primary onClick={ok}>OK</Button></>}>
      <div className="prop-grid">
        <span className="label">Name</span>
        <TextField value={name} onChange={(e) => setName(e.target.value)} autoFocus onFocus={(e) => e.target.select()} onKeyDown={(e) => e.key === 'Enter' && ok()} />
      </div>
    </Modal>
  );
}

/* ---------- Confirm / paste attributes / clip info ---------- */
function ConfirmModal({ modal, close }: P) {
  const p = modal.payload ?? {};
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const [motion, setMotion] = useState(true);
  const [audio, setAudio] = useState(true);
  const [effects, setEffects] = useState(true);
  if (p.kind === 'pasteAttributes') {
    return (
      <Modal title="Paste Attributes" onClose={close} width={360} footer={<><span className="spacer" /><Button onClick={close}>Cancel</Button><Button primary onClick={() => { cmd.pasteAttributes({ motion, audio, effects }); close(); }}>OK</Button></>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Checkbox checked={motion} onChange={setMotion} label="Motion and opacity (position, scale, rotation, anchor, opacity, blend mode)" />
          <Checkbox checked={effects} onChange={setEffects} label="Effects (video and audio effects, with keyframes)" />
          <Checkbox checked={audio} onChange={setAudio} label="Audio (volume, pan, channel mapping)" />
        </div>
      </Modal>
    );
  }
  if (p.kind === 'clipInfo' && seq) {
    const clip = seq.clips.find((c) => c.id === p.clipId);
    if (!clip) return null;
    const asset = findAsset(project, clip.assetId);
    const fps = seq.settings.fps;
    const rows: [string, string][] = [
      ['Name', clip.name],
      ['Track', seq.tracks.find((t) => t.id === clip.trackId)?.name ?? ''],
      ['Start', framesToTimecode(clip.start, fps, seq.settings.dropFrame)],
      ['End', framesToTimecode(clip.start + clip.duration, fps, seq.settings.dropFrame)],
      ['Duration', framesToTimecode(clip.duration, fps, seq.settings.dropFrame)],
      ['Source in', `${clip.inPoint.toFixed(3)} s`],
      ['Speed', `${(clip.speed * 100).toFixed(1)}%${clip.reversed ? ' reversed' : ''}`],
      ['Media', asset ? `${asset.name}${asset.width ? ` (${asset.width}x${asset.height}${asset.fps ? `, ${asset.fps} fps` : ''})` : ''}` : clip.nestedSequenceId ? 'Nested sequence' : 'Generator'],
      ['Effects', clip.effects.map((e) => e.type).join(', ') || 'none'],
      ['Volume', `${evalNumber(clip.audio.volume, 0).toFixed(1)} dB (gain ${clip.audio.gain.toFixed(1)} dB)`],
    ];
    return (
      <Modal title="Clip Properties" onClose={close} width={420} footer={<><span className="spacer" /><Button primary onClick={close}>Close</Button></>}>
        <div className="kv">
          {rows.map(([k, v]) => (
            <React.Fragment key={k}>
              <span className="k">{k}</span>
              <span className="v wrap">{v}</span>
            </React.Fragment>
          ))}
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={p.title ?? 'Confirm'} onClose={close} width={380} footer={<><span className="spacer" /><Button onClick={close}>{p.cancelLabel ?? 'Cancel'}</Button><Button primary={!p.danger} danger={!!p.danger} onClick={() => { p.onConfirm?.(); close(); }}>{p.okLabel ?? 'OK'}</Button></>}>
      <div style={{ fontSize: 12, lineHeight: 1.5 }}>{p.message ?? 'Are you sure?'}</div>
    </Modal>
  );
}

/* ---------- Link media ---------- */
function LinkMediaModal({ modal, close }: P) {
  const project = useProject((s) => s.project);
  const ids: string[] | undefined = modal.payload?.assetIds;
  const offline = project.assets.filter((a) => (ids ? ids.includes(a.id) : a.offline) && a.kind !== 'sequence' && a.kind !== 'generator');
  const [busy, setBusy] = useState<string | null>(null);
  const relinkOne = async (id: string) => {
    const a = findAsset(useProject.getState().project, id);
    if (!a) return;
    const files = await pickFiles(MEDIA_ACCEPT, false);
    if (!files[0]) return;
    setBusy(id);
    await relinkAsset(a, files[0]);
    setBusy(null);
  };
  const relinkAll = async () => {
    const files = await pickFiles(MEDIA_ACCEPT, true);
    if (!files.length) return;
    let n = 0;
    for (const a of offline) {
      const f = files.find((x) => x.name === a.file?.name) ?? files.find((x) => x.name.replace(/\.[^.]+$/, '') === a.name.replace(/\.[^.]+$/, ''));
      if (f) {
        setBusy(a.id);
        await relinkAsset(a, f, true);
        n++;
      }
    }
    setBusy(null);
    toast(n ? 'success' : 'warning', n ? 'Media relinked' : 'No matches', n ? `${n} of ${offline.length} matched by file name.` : 'Pick files whose names match the offline items, or relink them one by one.');
  };
  const makeOffline = () => {
    close();
  };
  return (
    <Modal title="Link Media" icon="link" onClose={close} width={560} footer={<><Button onClick={makeOffline}>Keep offline</Button><span className="spacer" /><Button onClick={() => void relinkAll()} disabled={!offline.length}>Locate all (match by name)...</Button><Button primary onClick={close}>Done</Button></>}>
      {offline.length === 0 ? (
        <div className="empty"><strong>All media is online</strong>Nothing needs relinking.</div>
      ) : (
        <>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--c-text-dim)' }}>Browsers cannot reopen files on their own after a reload. Pick the original files again; the timeline keeps every edit.</p>
          <div className="list-head"><span className="grow">Clip name</span><span style={{ width: 200 }}>File name</span><span style={{ width: 90 }} /></div>
          <div className="scroll-y" style={{ maxHeight: 300 }}>
            {offline.map((a) => (
              <div key={a.id} className="list-row">
                <Icon name={a.offline ? 'warning' : 'check'} size={12} style={{ color: a.offline ? 'var(--c-warn)' : 'var(--c-ok)' }} />
                <span className="grow">{a.name}</span>
                <span style={{ width: 200 }} className="dim">{a.file?.name ?? '-'}</span>
                <span style={{ width: 90, textAlign: 'right' }}><Button sm onClick={() => void relinkOne(a.id)} disabled={busy === a.id}>{busy === a.id ? 'Reading...' : 'Locate...'}</Button></span>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

/* ---------- Project manager: autosave and storage ---------- */
function ProjectManagerModal({ close }: P) {
  const project = useProject((s) => s.project);
  const [auto, setAuto] = useState<{ at: number; name: string } | null>(null);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  useEffect(() => {
    autosaveInfo().then(setAuto);
    estimateStorage().then(setStorage);
  }, []);
  const restore = async () => {
    const p = await loadAutosavedProject();
    if (!p) return toast('warning', 'No autosave found');
    const { restored, missing } = await restoreProjectMedia(p);
    useProject.getState().loadProject(p);
    usePlayback.setState({ playhead: 0 });
    useUI.getState().clearSelection();
    toast('success', 'Autosave restored', `${restored} media item${restored === 1 ? '' : 's'} restored${missing.length ? `, ${missing.length} offline` : ''}.`);
    close();
    if (missing.length) useUI.getState().openModal({ kind: 'linkMedia', payload: { assetIds: missing.map((m) => m.id) } });
  };
  const counts = { assets: project.assets.filter((a) => a.kind !== 'sequence').length, sequences: project.sequences.length, clips: project.sequences.reduce((n, s) => n + s.clips.length, 0), effects: project.sequences.reduce((n, s) => n + s.clips.reduce((m, c) => m + c.effects.length, 0), 0) };
  const cached = project.assets.filter((a) => getMedia(a.id)).length;
  return (
    <Modal title="Project Manager" icon="project" onClose={close} width={520} footer={<><span className="spacer" /><Button primary onClick={close}>Close</Button></>}>
      <div className="kv">
        <h5>This project</h5>
        <span className="k">Name</span><span className="v">{project.settings.name}</span>
        <span className="k">Contents</span><span className="v">{counts.sequences} sequences, {counts.assets} media items, {counts.clips} clips, {counts.effects} effect instances</span>
        <span className="k">Media cached</span><span className="v">{cached} of {counts.assets} items are held in browser storage for reload</span>
        <span className="k">Revision</span><span className="v">{project.revision}</span>
        <h5>Autosave</h5>
        <span className="k">Last autosave</span><span className="v">{auto ? `${new Date(auto.at).toLocaleString()} - ${auto.name}` : 'none yet'}</span>
        <span className="k" />
        <span className="v" style={{ display: 'flex', gap: 6 }}>
          <Button sm onClick={() => void restore()} disabled={!auto}>Open autosaved version</Button>
          <Button sm onClick={() => void cmd.autosave().then(() => autosaveInfo().then(setAuto))}>Autosave now</Button>
          <Button sm danger onClick={() => void discardAutosave().then(() => setAuto(null))} disabled={!auto}>Discard</Button>
        </span>
        <h5>Storage</h5>
        <span className="k">Browser quota</span><span className="v">{storage ? `${formatBytes(storage.usage)} used of ${formatBytes(storage.quota)}` : 'unknown'}</span>
        <span className="k">Consolidate</span>
        <span className="v" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Button sm onClick={() => { cmd.removeUnused(); }}>Remove unused media</Button>
          <Button sm onClick={() => void cmd.saveProject(true)}>Save project with media embedded (.vsproj)</Button>
        </span>
      </div>
    </Modal>
  );
}

/* ---------- Scene detect (real luma-difference cut detection) ---------- */
function SceneDetectModal({ modal, close }: P) {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const sel = useUI((s) => s.selection.clipIds);
  const assetId: string | undefined = modal.payload?.assetId;
  const clips = seq ? seq.clips.filter((c) => (assetId ? c.assetId === assetId : sel.includes(c.id))).filter((c) => findAsset(project, c.assetId)?.hasVideo) : [];
  const [threshold, setThreshold] = useState(30);
  const [minLen, setMinLen] = useState(0.5);
  const [action, setAction] = useState<'cut' | 'markers' | 'both'>('cut');
  const [progress, setProgress] = useState<number | null>(null);
  const [found, setFound] = useState<number | null>(null);
  const cancel = useRef(false);
  if (!seq) return null;
  const run = async () => {
    cancel.current = false;
    setProgress(0);
    const fps = seq.settings.fps;
    const cuts: { clipId: string; frame: number }[] = [];
    const cv = document.createElement('canvas');
    const total = clips.reduce((n, c) => n + c.duration, 0);
    let done = 0;
    for (const clip of clips) {
      let prev: Uint8ClampedArray | null = null;
      let lastCut = clip.start;
      const step = Math.max(1, Math.round(fps / 10)); // sample ~10 fps
      for (let f = clip.start; f < clip.start + clip.duration; f += step) {
        if (cancel.current) break;
        await renderFrameToCanvas(project, seq, f, cv, { scale: 16, soloClipId: clip.id, captions: false });
        const ctx = cv.getContext('2d', { willReadFrequently: true })!;
        const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
        if (prev) {
          let diff = 0;
          for (let i = 0; i < data.length; i += 4) diff += Math.abs(data[i] - prev[i]) + Math.abs(data[i + 1] - prev[i + 1]) + Math.abs(data[i + 2] - prev[i + 2]);
          diff /= (data.length / 4) * 3;
          if (diff > threshold && (f - lastCut) / fps >= minLen) {
            cuts.push({ clipId: clip.id, frame: f });
            lastCut = f;
          }
        }
        prev = new Uint8ClampedArray(data);
        done += step;
        setProgress(done / Math.max(1, total));
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    setProgress(null);
    setFound(cuts.length);
    if (!cuts.length || cancel.current) return;
    useProject.getState().update('Scene edit detection', (p) => {
      const s = p.sequences.find((x) => x.id === seq.id);
      if (!s) return;
      if (action !== 'cut') for (const c of cuts) s.markers.push({ id: uid('mk'), time: c.frame, duration: 0, name: 'Scene', comment: 'Detected cut', color: 'cyan', kind: 'comment' });
      if (action !== 'markers') {
        // razor from the end backwards so earlier frames still refer to the original clip ids
        const byFrame = [...cuts].sort((a, b) => b.frame - a.frame);
        for (const c of byFrame) E.razorAt(s, c.frame, undefined, undefined);
      }
    });
    toast('success', 'Scene edit detection', `${cuts.length} cut${cuts.length === 1 ? '' : 's'} found.`);
    close();
  };
  return (
    <Modal title="Scene Edit Detection" icon="razor" onClose={() => { cancel.current = true; close(); }} width={420} footer={<><span className="spacer" /><Button onClick={() => { cancel.current = true; close(); }}>Cancel</Button><Button primary onClick={() => void run()} disabled={!clips.length || progress != null}>{progress != null ? `Analysing ${Math.round(progress * 100)}%` : 'Analyse'}</Button></>}>
      <div className="prop-grid">
        <span className="label">Clips</span>
        <span>{clips.length ? clips.map((c) => c.name).join(', ') : 'Select video clips in the timeline first.'}</span>
        <span className="label">Sensitivity</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Slider value={100 - threshold} min={20} max={95} step={1} onChange={(v) => setThreshold(100 - v)} style={{ width: 160 }} /><span className="dim">{100 - threshold}</span></span>
        <span className="label">Minimum shot</span>
        <HotText value={minLen} min={0.1} max={10} step={0.1} decimals={1} unit=" s" width={60} onChange={(v, c) => c && setMinLen(v)} />
        <span className="label">Result</span>
        <Segmented value={action} options={[{ value: 'cut', label: 'Cut clips' }, { value: 'markers', label: 'Add markers' }, { value: 'both', label: 'Both' }]} onChange={setAction} />
      </div>
      {progress != null ? <div className="progress" style={{ marginTop: 10 }}><div style={{ width: `${progress * 100}%` }} /></div> : null}
      {found === 0 ? <div style={{ marginTop: 8, color: 'var(--c-warn)', fontSize: 11 }}>No cuts found. Try a higher sensitivity.</div> : null}
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--c-text-dim)' }}>Frames are compared at 10 samples per second on a reduced-size render, so long clips take a while.</div>
    </Modal>
  );
}

/* ---------- Auto ducking (real, keyframes the music volume under dialogue) ---------- */
function AutoDuckingModal({ close }: P) {
  const seq = useActiveSequence();
  const sel = useUI((s) => s.selection.clipIds);
  const [amount, setAmount] = useState(-18);
  const [sens, setSens] = useState(-30);
  const [fade, setFade] = useState(0.4);
  const [dialogueTrack, setDialogueTrack] = useState<string>('');
  if (!seq) return null;
  const audioTracks = seq.tracks.filter((t) => t.kind === 'audio');
  const music = seq.clips.filter((c) => sel.includes(c.id) && audioTracks.some((t) => t.id === c.trackId));
  const dlgTrack = dialogueTrack || audioTracks.find((t) => !music.some((m) => m.trackId === t.id))?.id || '';
  const run = () => {
    const fps = seq.settings.fps;
    const speech = seq.clips.filter((c) => c.trackId === dlgTrack && !sel.includes(c.id));
    if (!speech.length) return toast('warning', 'No dialogue clips', 'The chosen dialogue track has no clips.');
    // Build a per-frame "speech present" map from decoded peaks of the dialogue clips.
    const thresholdLin = Math.pow(10, sens / 20);
    const present = new Map<number, boolean>();
    for (const sc of speech) {
      const rec = getMedia(sc.assetId);
      const peaks = rec?.peaks?.[0];
      for (let f = sc.start; f < sc.start + sc.duration; f++) {
        let on = true;
        if (peaks) {
          const t = E.sourceTimeAt(sc, f, fps);
          const i = Math.min(peaks.length - 1, Math.max(0, Math.floor(t * 200)));
          on = Math.abs(peaks[i]) > thresholdLin;
        }
        if (on) present.set(f, true);
      }
    }
    // Merge into speech regions with a small hold.
    const hold = Math.round(fps * 0.35);
    const regions: [number, number][] = [];
    let start: number | null = null,
      last = -1;
    const frames = [...present.keys()].sort((a, b) => a - b);
    for (const f of frames) {
      if (start == null) { start = f; last = f; continue; }
      if (f - last > hold) { regions.push([start, last]); start = f; }
      last = f;
    }
    if (start != null) regions.push([start, last]);
    if (!regions.length) return toast('warning', 'No speech detected', 'Lower the sensitivity threshold.');
    const fadeF = Math.max(1, Math.round(fade * fps));
    useProject.getState().update('Auto ducking', (p) => {
      const s = p.sequences.find((x) => x.id === seq.id);
      if (!s) return;
      for (const m of s.clips) {
        if (!sel.includes(m.id)) continue;
        const base = evalNumber(m.audio.volume, 0);
        const kfs: { t: number; v: number; interp: 'linear' }[] = [];
        const add = (t: number, v: number) => kfs.push({ t, v, interp: 'linear' });
        add(0, base);
        for (const [a, b] of regions) {
          const ra = a - m.start,
            rb = b - m.start;
          if (rb < 0 || ra > m.duration) continue;
          add(ra - fadeF, base);
          add(ra, base + amount);
          add(rb, base + amount);
          add(rb + fadeF, base);
        }
        kfs.sort((x, y) => x.t - y.t);
        // dedupe monotonic
        const clean = kfs.filter((k, i) => i === 0 || k.t > kfs[i - 1].t);
        m.audio.volume = { value: base, keyframes: clean };
      }
    });
    toast('success', 'Auto ducking applied', `${regions.length} dialogue region${regions.length === 1 ? '' : 's'} ducked by ${amount} dB.`);
    close();
  };
  return (
    <Modal title="Auto Ducking" icon="audio" onClose={close} width={440} footer={<><span className="spacer" /><Button onClick={close}>Cancel</Button><Button primary onClick={run} disabled={!music.length || !dlgTrack}>Generate keyframes</Button></>}>
      <div className="prop-grid">
        <span className="label">Music clips</span>
        <span>{music.length ? `${music.length} selected clip${music.length === 1 ? '' : 's'} will be ducked` : 'Select the music clip(s) in the timeline first.'}</span>
        <span className="label">Duck against</span>
        <Select value={dlgTrack} options={audioTracks.map((t) => ({ value: t.id, label: t.name }))} onChange={setDialogueTrack} />
        <span className="label">Duck amount</span>
        <HotText value={amount} min={-60} max={0} step={1} unit=" dB" width={64} onChange={(v, c) => c && setAmount(v)} />
        <span className="label">Sensitivity</span>
        <HotText value={sens} min={-60} max={-6} step={1} unit=" dB" width={64} onChange={(v, c) => c && setSens(v)} title="Peaks above this level count as speech" />
        <span className="label">Fades</span>
        <HotText value={fade} min={0.05} max={3} step={0.05} decimals={2} unit=" s" width={64} onChange={(v, c) => c && setFade(v)} />
      </div>
      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--c-text-dim)' }}>Writes volume keyframes on the music clips (the rubber band). Existing volume keyframes on those clips are replaced.</div>
    </Modal>
  );
}

/* ---------- Interpret footage ---------- */
function InterpretFootageModal({ modal, close }: P) {
  const project = useProject((s) => s.project);
  const asset = findAsset(project, modal.payload?.assetId);
  const [fps, setFps] = useState<number | ''>(asset?.interpret?.fps ?? '');
  const [par, setPar] = useState(asset?.interpret?.pixelAspect ?? 1);
  const [alpha, setAlpha] = useState<'straight' | 'premultiplied' | 'ignore'>(asset?.interpret?.alpha ?? 'straight');
  if (!asset) return null;
  const ok = () => {
    useProject.getState().update('Interpret footage', (p) => {
      const a = p.assets.find((x) => x.id === asset.id);
      if (!a) return;
      a.interpret = { fps: fps === '' ? undefined : Number(fps), pixelAspect: par, alpha };
      if (fps !== '' && a.fps && a.duration) {
        // conform: duration changes with the assumed frame rate
        const frames = a.duration * a.fps;
        a.duration = frames / Number(fps);
        a.fps = Number(fps);
      }
    });
    close();
  };
  return (
    <Modal title={`Interpret Footage - ${asset.name}`} onClose={close} width={440} footer={<><span className="spacer" /><Button onClick={close}>Cancel</Button><Button primary onClick={ok}>OK</Button></>}>
      <div className="prop-grid">
        <span className="label">Frame rate</span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Checkbox radio checked={fps === ''} onChange={() => setFps('')} label={`Use file frame rate (${asset.fps ?? 'unknown'})`} />
          <Checkbox radio checked={fps !== ''} onChange={() => setFps(asset.fps ?? 30)} label="Assume" />
          <HotText value={fps === '' ? asset.fps ?? 30 : Number(fps)} min={1} max={240} step={0.001} decimals={3} width={70} onChange={(v, c) => c && setFps(v)} disabled={fps === ''} />
        </span>
        <span className="label">Pixel aspect</span>
        <Select value={String(par)} options={[{ value: '1', label: 'Square pixels (1.0)' }, { value: '0.9091', label: 'D1/DV NTSC (0.9091)' }, { value: '1.0940', label: 'D1/DV PAL (1.0940)' }, { value: '1.3333', label: 'HD Anamorphic 1080 (1.3333)' }, { value: '2', label: 'Anamorphic 2:1 (2.0)' }]} onChange={(v) => setPar(Number(v))} />
        <span className="label">Alpha</span>
        <Segmented value={alpha} options={[{ value: 'straight', label: 'Straight' }, { value: 'premultiplied', label: 'Premultiplied' }, { value: 'ignore', label: 'Ignore' }]} onChange={setAlpha} />
      </div>
      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--c-text-dim)' }}>Conforming the frame rate re-times the clip (24 fps footage interpreted as 30 plays faster). Applies to clips added after this change.</div>
    </Modal>
  );
}

/* ---------- Label picker ---------- */
function LabelPickerModal({ modal, close }: P) {
  const onPick: ((l: LabelColor) => void) | undefined = modal.payload?.onPick;
  return (
    <Modal title="Label" onClose={close} width={320}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {(Object.keys(LABEL_COLORS) as LabelColor[]).map((l) => (
          <button key={l} type="button" className="btn sm" onClick={() => { (onPick ?? cmd.setLabel)(l); close(); }} style={{ justifyContent: 'flex-start', gap: 6 }}>
            <Swatch color={LABEL_COLORS[l]} size={10} />
            {l}
          </button>
        ))}
      </div>
    </Modal>
  );
}

/* ---------- Workspace manager ---------- */
const WS_LABELS: Record<WorkspaceId, string> = { editing: 'Editing', assembly: 'Assembly', color: 'Color', effects: 'Effects', audio: 'Audio', graphics: 'Graphics', captions: 'Captions', review: 'Review', export: 'Export', custom: 'Custom' };
function WorkspaceManagerModal({ close }: P) {
  const workspace = useUI((s) => s.workspace);
  const setWorkspace = useUI((s) => s.setWorkspace);
  const layout = useLayout();
  const [, force] = useState(0);
  const saved = Object.keys(layout.layouts) as WorkspaceId[];
  const exportLayouts = () => {
    const blob = new Blob([JSON.stringify(useLayout.getState().layouts, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vanguard-workspaces.json';
    a.click();
  };
  const importLayouts = async () => {
    const files = await pickFiles('.json', false);
    if (!files[0]) return;
    try {
      const data = JSON.parse(await files[0].text());
      for (const k of Object.keys(data)) useLayout.getState().set(k as WorkspaceId, data[k]);
      useUI.getState().bumpLayout();
      force((n) => n + 1);
      toast('success', 'Workspaces imported');
    } catch (e) {
      toast('error', 'Import failed', String(e));
    }
  };
  return (
    <Modal title="Workspaces" onClose={close} width={460} footer={<><Button onClick={() => void importLayouts()}>Import...</Button><Button onClick={exportLayouts}>Export...</Button><span className="spacer" /><Button primary onClick={close}>Done</Button></>}>
      <div className="list-head"><span className="grow">Workspace</span><span style={{ width: 90 }}>State</span><span style={{ width: 150 }} /></div>
      {(Object.keys(WS_LABELS) as WorkspaceId[]).map((w) => (
        <div key={w} className={`list-row${workspace === w ? ' selected' : ''}`} onClick={() => setWorkspace(w)}>
          <Icon name="layout" size={12} style={{ color: 'var(--c-text-dim)' }} />
          <span className="grow">{WS_LABELS[w]}</span>
          <span style={{ width: 90 }} className="dim">{saved.includes(w) ? 'modified' : 'default'}</span>
          <span style={{ width: 150, display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
            <Button sm onClick={(e) => { e.stopPropagation(); layout.reset(w); useUI.getState().bumpLayout(); force((n) => n + 1); }} disabled={!saved.includes(w)}>Reset</Button>
            <Button sm onClick={(e) => { e.stopPropagation(); const cur = useLayout.getState().get(workspace); useLayout.getState().set(w, JSON.parse(JSON.stringify(cur))); useUI.getState().bumpLayout(); force((n) => n + 1); toast('success', `Saved current layout as ${WS_LABELS[w]}`); }}>Save current here</Button>
          </span>
        </div>
      ))}
      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--c-text-dim)' }}>Layouts are stored in this browser. Drag panel tabs to rearrange; double-click a tab to maximise it.</div>
    </Modal>
  );
}

/* ---------- Time remapping ---------- */
function TimeRemapModal({ close }: P) {
  const seq = useActiveSequence();
  const sel = useUI((s) => s.selection.clipIds);
  const clip = seq?.clips.find((c) => sel.includes(c.id));
  const fps = seq?.settings.fps ?? 30;
  const [points, setPoints] = useState<{ t: number; v: number }[]>(() => clip?.timeRemap?.map((k) => ({ t: k.t, v: k.v })) ?? [{ t: 0, v: 100 }, { t: clip?.duration ?? fps, v: 100 }]);
  if (!clip || !seq) return null;
  const set = (i: number, patch: Partial<{ t: number; v: number }>) => setPoints((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)).sort((a, b) => a.t - b.t));
  const preset = (kind: 'rampUp' | 'rampDown' | 'slowMiddle' | 'reset') => {
    const d = clip.duration;
    if (kind === 'rampUp') setPoints([{ t: 0, v: 100 }, { t: Math.round(d * 0.4), v: 100 }, { t: Math.round(d * 0.6), v: 400 }, { t: d, v: 400 }]);
    if (kind === 'rampDown') setPoints([{ t: 0, v: 100 }, { t: Math.round(d * 0.4), v: 100 }, { t: Math.round(d * 0.6), v: 25 }, { t: d, v: 25 }]);
    if (kind === 'slowMiddle') setPoints([{ t: 0, v: 100 }, { t: Math.round(d * 0.3), v: 100 }, { t: Math.round(d * 0.4), v: 20 }, { t: Math.round(d * 0.6), v: 20 }, { t: Math.round(d * 0.7), v: 100 }, { t: d, v: 100 }]);
    if (kind === 'reset') setPoints([{ t: 0, v: 100 }, { t: d, v: 100 }]);
  };
  const apply = (remove = false) => {
    useProject.getState().update('Time remapping', (p) => {
      const s = p.sequences.find((x) => x.id === seq.id);
      const c = s?.clips.find((x) => x.id === clip.id);
      if (!c) return;
      c.timeRemap = remove ? undefined : points.map((pt) => ({ t: pt.t, v: Math.max(1, pt.v), interp: 'linear' as const }));
    });
    close();
  };
  // integrate speed to show the source span used
  const span = (() => {
    let t = 0;
    for (let i = 1; i < points.length; i++) t += ((points[i].t - points[i - 1].t) / fps) * ((points[i - 1].v + points[i].v) / 200);
    return t;
  })();
  const W = 380,
    H = 120;
  const maxV = Math.max(200, ...points.map((p) => p.v)) * 1.1;
  return (
    <Modal title={`Time Remapping - ${clip.name}`} icon="stopwatch" onClose={close} width={440} footer={<><Button danger onClick={() => apply(true)} disabled={!clip.timeRemap}>Remove remap</Button><span className="spacer" /><Button onClick={close}>Cancel</Button><Button primary onClick={() => apply(false)}>Apply</Button></>}>
      <svg width={W} height={H} style={{ display: 'block', background: 'var(--c-well)', border: '1px solid var(--c-line)', marginBottom: 8 }}>
        <line x1={0} x2={W} y1={H - (100 / maxV) * H} y2={H - (100 / maxV) * H} stroke="var(--c-line-strong)" strokeDasharray="3 3" />
        <polyline fill="none" stroke="var(--c-accent)" strokeWidth={1.5} points={points.map((p) => `${(p.t / clip.duration) * W},${H - (p.v / maxV) * H}`).join(' ')} />
        {points.map((p, i) => (
          <circle key={i} cx={(p.t / clip.duration) * W} cy={H - (p.v / maxV) * H} r={3.5} fill="var(--c-text-bright)" style={{ cursor: 'ns-resize' }} onPointerDown={(e) => {
            const startY = e.clientY,
              startX = e.clientX,
              v0 = p.v,
              t0 = p.t;
            const move = (ev: PointerEvent) => set(i, { v: Math.max(1, Math.round(v0 + ((startY - ev.clientY) / H) * maxV)), t: i === 0 || i === points.length - 1 ? t0 : Math.max(0, Math.min(clip.duration, Math.round(t0 + ((ev.clientX - startX) / W) * clip.duration))) });
            const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
          }} />
        ))}
      </svg>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
        <Button sm onClick={() => preset('rampUp')}>Speed ramp up</Button>
        <Button sm onClick={() => preset('rampDown')}>Ramp down</Button>
        <Button sm onClick={() => preset('slowMiddle')}>Slow middle</Button>
        <Button sm onClick={() => preset('reset')}>Flat 100%</Button>
        <span className="spacer" />
        <Button sm onClick={() => setPoints((ps) => [...ps, { t: Math.round(clip.duration / 2), v: 100 }].sort((a, b) => a.t - b.t))}>Add point</Button>
      </div>
      <div className="scroll-y" style={{ maxHeight: 130 }}>
        {points.map((p, i) => (
          <div key={i} className="list-row" style={{ gap: 8 }}>
            <span className="dim" style={{ width: 20 }}>{i + 1}</span>
            <TimecodeField frames={p.t} fps={fps} onChange={(f) => set(i, { t: Math.max(0, Math.min(clip.duration, f)) })} />
            <HotText value={p.v} min={1} max={2000} step={1} unit="%" width={70} onChange={(v, c) => c && set(i, { v })} />
            <span className="spacer" />
            {points.length > 2 ? <button type="button" className="ibtn sm" title="Remove point" onClick={() => setPoints((ps) => ps.filter((_, j) => j !== i))}><Icon name="close" size={10} /></button> : null}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--c-text-dim)' }}>Speed is interpolated between points. This clip will consume {span.toFixed(2)} s of source over its {(clip.duration / fps).toFixed(2)} s duration.</div>
    </Modal>
  );
}

/* ---------- Keyboard shortcuts ---------- */
function ShortcutsModal({ close }: P) {
  const [q, setQ] = useState('');
  const cats = [...new Set(SHORTCUTS.map((s) => s.category))];
  const match = (s: (typeof SHORTCUTS)[number]) => !q || s.label.toLowerCase().includes(q.toLowerCase()) || s.keys.toLowerCase().includes(q.toLowerCase());
  return (
    <Modal title="Keyboard Shortcuts" icon="keyboard" onClose={close} width={760}>
      <TextField value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter shortcuts" icon="search" autoFocus style={{ marginBottom: 10, width: 260 }} />
      <div className="scroll-y" style={{ maxHeight: '60vh' }}>
        <div className="kbd-grid">
          {cats.map((c) => {
            const list = SHORTCUTS.filter((s) => s.category === c && match(s));
            if (!list.length) return null;
            return (
              <React.Fragment key={c}>
                <div className="kb-cat">{c}</div>
                {list.map((s) => (
                  <div key={s.id} className="kb-row">
                    <span className="nm">{s.label}</span>
                    <span className="spacer" />
                    <span style={{ display: 'flex', gap: 3 }}>{s.keys.split('+').map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
                  </div>
                ))}
              </React.Fragment>
            );
          })}
        </div>
        <div className="kb-cat" style={{ marginTop: 10 }}>Tools</div>
        <div className="kbd-grid">
          {[['V', 'Selection'], ['A', 'Track Select Forward'], ['Shift+A', 'Track Select Backward'], ['B', 'Ripple Edit'], ['N', 'Rolling Edit'], ['R', 'Rate Stretch'], ['C', 'Razor'], ['Y', 'Slip'], ['U', 'Slide'], ['P', 'Pen'], ['H', 'Hand'], ['Z', 'Zoom']].map(([k, n]) => (
            <div key={k} className="kb-row"><span className="nm">{n}</span><span className="spacer" /><span style={{ display: 'flex', gap: 3 }}>{k.split('+').map((x) => <Kbd key={x}>{x}</Kbd>)}</span></div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Preferences ---------- */
function PreferencesModal({ close }: P) {
  const ui = useUI();
  const project = useProject((s) => s.project);
  const [tab, setTab] = useState<'general' | 'timeline' | 'audio' | 'playback' | 'autosave'>('general');
  const set = (label: string, fn: (s: typeof project.settings) => void) => useProject.getState().update(label, (p) => fn(p.settings));
  const S = project.settings;
  return (
    <Modal title="Preferences" icon="settings" onClose={close} width={640} footer={<><span className="spacer" /><Button primary onClick={close}>Done</Button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: 14, minHeight: 300 }}>
        <div style={{ borderRight: '1px solid var(--c-line)' }}>
          {(['general', 'timeline', 'audio', 'playback', 'autosave'] as const).map((t) => (
            <div key={t} className={`list-row${tab === t ? ' selected' : ''}`} onClick={() => setTab(t)} style={{ textTransform: 'capitalize' }}>{t}</div>
          ))}
        </div>
        <div>
          {tab === 'general' ? (
            <div className="prop-grid">
              <span className="label">Still image duration</span>
              <HotText value={S.defaultStillDuration / S.defaultSequence.fps} min={0.1} max={600} step={0.5} decimals={1} unit=" s" width={70} onChange={(v, c) => c && set('Preferences', (s) => (s.defaultStillDuration = Math.round(v * s.defaultSequence.fps)))} />
              <span className="label">Video transition</span>
              <span style={{ display: 'flex', gap: 6 }}>
                <Select value={S.defaultVideoTransition} options={TRANSITIONS.map((t) => ({ value: t.type, label: t.name }))} onChange={(v) => set('Preferences', (s) => (s.defaultVideoTransition = v))} />
                <HotText value={S.defaultTransitionDuration} min={2} max={600} step={1} unit=" fr" width={60} onChange={(v, c) => c && set('Preferences', (s) => (s.defaultTransitionDuration = Math.round(v)))} />
              </span>
              <span className="label">Audio transition</span>
              <span style={{ display: 'flex', gap: 6 }}>
                <Select value={S.defaultAudioTransition} options={AUDIO_TRANSITIONS.map((t) => ({ value: t.type, label: t.name }))} onChange={(v) => set('Preferences', (s) => (s.defaultAudioTransition = v))} />
                <HotText value={S.defaultAudioTransitionDuration} min={2} max={600} step={1} unit=" fr" width={60} onChange={(v, c) => c && set('Preferences', (s) => (s.defaultAudioTransitionDuration = Math.round(v)))} />
              </span>
              <span className="label">Timecode display</span>
              <Segmented value={ui.timecodeMode} options={[{ value: 'timecode', label: 'Timecode' }, { value: 'frames', label: 'Frames' }, { value: 'seconds', label: 'Seconds' }]} onChange={(v) => ui.setTimecodeMode(v)} />
              <span className="label">Label defaults</span>
              <span style={{ display: 'grid', gridTemplateColumns: 'repeat(2, auto 1fr)', gap: '4px 8px', alignItems: 'center' }}>
                {(Object.keys(S.labelDefaults) as (keyof typeof S.labelDefaults)[]).map((k) => (
                  <React.Fragment key={k}>
                    <span className="dim" style={{ textTransform: 'capitalize' }}>{k}</span>
                    <Select value={S.labelDefaults[k]} options={(Object.keys(LABEL_COLORS) as LabelColor[]).map((l) => ({ value: l, label: l }))} onChange={(v) => set('Preferences', (s) => (s.labelDefaults[k] = v as LabelColor))} />
                  </React.Fragment>
                ))}
              </span>
            </div>
          ) : null}
          {tab === 'timeline' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Checkbox checked={ui.snapping} onChange={ui.setSnapping} label="Snap while dragging (S)" />
              <Checkbox checked={ui.linkedSelection} onChange={ui.setLinkedSelection} label="Linked selection - select audio and video together" />
              <Checkbox checked={ui.rippleDelete} onChange={(v) => useUI.setState({ rippleDelete: v })} label="Delete key ripples (closes the gap)" />
              <Checkbox checked={ui.showAudioWaveforms} onChange={(v) => ui.setTimelineDisplay({ showAudioWaveforms: v })} label="Show audio waveforms" />
              <Checkbox checked={ui.showVideoThumbnails} onChange={(v) => ui.setTimelineDisplay({ showVideoThumbnails: v })} label="Show video thumbnails" />
              <Checkbox checked={ui.showClipNames} onChange={(v) => ui.setTimelineDisplay({ showClipNames: v })} label="Show clip names" />
              <div className="prop-grid" style={{ marginTop: 4 }}>
                <span className="label">Nudge distance</span>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <HotText value={ui.nudgeFrames} min={1} max={100} step={1} unit=" fr" width={60} onChange={(v, c) => c && useUI.setState({ nudgeFrames: Math.round(v) })} />
                  <span className="dim">Alt+Left/Right nudges by this; Alt+Shift by 5x.</span>
                </span>
              </div>
            </div>
          ) : null}
          {tab === 'audio' ? (
            <div className="prop-grid">
              <span className="label">Latency</span>
              <Segmented value={S.audioHardware.latencyHint} options={[{ value: 'interactive', label: 'Interactive (low)' }, { value: 'balanced', label: 'Balanced' }, { value: 'playback', label: 'Playback (stable)' }]} onChange={(v) => set('Preferences', (s) => (s.audioHardware.latencyHint = v))} />
              <span />
              <span className="dim" style={{ fontSize: 11 }}>Takes effect for new audio sessions (reload). Sample rate follows the sequence, 48 kHz by default.</span>
              <span className="label">Master</span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <HotText value={usePlayback.getState().masterDb} min={-60} max={12} step={0.5} decimals={1} unit=" dB" width={70} onChange={(v, c) => c && usePlayback.getState().setMaster(v)} />
                <Button sm onClick={() => usePlayback.getState().setMaster(0)}>Reset</Button>
              </span>
            </div>
          ) : null}
          {tab === 'playback' ? (
            <div className="prop-grid">
              <span className="label">Program quality</span>
              <Segmented value={ui.programQuality} options={[{ value: 'full', label: 'Full' }, { value: 'half', label: '1/2' }, { value: 'quarter', label: '1/4' }]} onChange={(v) => ui.setProgramQuality(v)} />
              <span className="label">Shuttle</span>
              <span className="dim" style={{ fontSize: 11 }}>J/K/L step through 1x, 2x, 4x, 8x. Space plays at 1x, Shift+Space plays around the playhead.</span>
              <span className="label">Loop</span>
              <Checkbox checked={usePlayback.getState().loop} onChange={(v) => usePlayback.getState().setLoop(v)} label="Loop playback between In and Out (or the whole sequence)" />
            </div>
          ) : null}
          {tab === 'autosave' ? (
            <div className="prop-grid">
              <span className="label">Autosave</span>
              <Checkbox checked={S.autoSaveEnabled} onChange={(v) => set('Preferences', (s) => (s.autoSaveEnabled = v))} label="Automatically save the project in browser storage" />
              <span className="label">Interval</span>
              <HotText value={S.autoSaveIntervalMinutes} min={1} max={60} step={1} unit=" min" width={70} onChange={(v, c) => c && set('Preferences', (s) => (s.autoSaveIntervalMinutes = Math.round(v)))} disabled={!S.autoSaveEnabled} />
              <span />
              <span className="dim" style={{ fontSize: 11 }}>Autosaves only when something changed. Imported media is cached in IndexedDB so a reload restores the project; use File, Save Project for a portable .vsproj file.</span>
              <span className="label">Reset UI</span>
              <span style={{ display: 'flex', gap: 6 }}>
                <Button sm onClick={() => { useLayout.getState().resetAll(); useUI.getState().bumpLayout(); toast('info', 'Workspaces reset'); }}>Reset all workspaces</Button>
                <Button sm danger onClick={() => { localStorage.clear(); toast('info', 'Local preferences cleared', 'Reload to apply.'); }}>Clear local preferences</Button>
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Project settings ---------- */
function ProjectSettingsModal({ close }: P) {
  const project = useProject((s) => s.project);
  const [name, setName] = useState(project.settings.name);
  const [defaults, setDefaults] = useState<SequenceSettings>({ ...project.settings.defaultSequence });
  const [note, setNote] = useState(project.settings.scratchNote);
  const ok = () => {
    useProject.getState().update('Project settings', (p) => {
      p.settings.name = name.trim() || p.settings.name;
      p.settings.defaultSequence = defaults;
      p.settings.scratchNote = note;
    });
    close();
  };
  return (
    <Modal title="Project Settings" icon="project" onClose={close} width={620} footer={<><span className="spacer" /><Button onClick={close}>Cancel</Button><Button primary onClick={ok}>OK</Button></>}>
      <div className="prop-grid" style={{ marginBottom: 10 }}>
        <span className="label">Project name</span>
        <TextField value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <span className="label">Notes</span>
        <TextArea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Scratch notes for this project (saved in the project file)" />
      </div>
      <div className="section-title" style={{ color: 'var(--c-text-dim)', fontSize: 11, margin: '6px 0' }}>Defaults for new sequences</div>
      <SequenceSettingsForm value={defaults} onChange={setDefaults} />
    </Modal>
  );
}

/* ---------- About ---------- */
function AboutModal({ close }: P) {
  const [, force] = useState(0);
  const gl = useMemo(() => {
    try {
      const c = document.createElement('canvas');
      const g = c.getContext('webgl2');
      if (!g) return 'WebGL2 unavailable';
      const dbg = g.getExtension('WEBGL_debug_renderer_info');
      return dbg ? String(g.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'WebGL2';
    } catch {
      return 'unknown';
    }
  }, []);
  const eggs = foundCount();
  return (
    <Modal title="About Vanguard Studio Pro" icon="logo" onClose={close} width={440}>
      <div style={{ display: 'flex', gap: 14 }}>
        <div style={{ width: 56, height: 56, border: '1px solid var(--c-line-strong)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Icon name="logo" size={34} />
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.55 }}>
          <div style={{ fontSize: 15, color: 'var(--c-text-bright)' }}>Vanguard Studio Pro</div>
          <button type="button" onClick={() => { aboutVersionClick(); force((n) => n + 1); }} style={{ color: 'var(--c-text-dim)', cursor: 'default' }} title="Version">
            Version {APP_VERSION} (build {BUILD_ID})
          </button>
          <div style={{ color: 'var(--c-text-dim)', marginTop: 6 }}>Non-linear editor running entirely in the browser: WebGL2 compositing, WebCodecs decode and encode, Web Audio mixing. No servers, no uploads.</div>
          <div className="kv" style={{ marginTop: 10 }}>
            <span className="k">Renderer</span><span className="v wrap">{gl}</span>
            <span className="k">WebCodecs</span><span className="v">{typeof VideoDecoder !== 'undefined' ? 'available' : 'not available (element decode fallback)'}</span>
            <span className="k">Platform</span><span className="v">{isMac() ? 'macOS' : navigator.platform || 'web'} - {navigator.hardwareConcurrency ?? '?'} threads</span>
            <span className="k">Unlisted</span><span className="v">{eggs} of {EGG_TOTAL} discovered</span>
          </div>
          <div style={{ color: 'var(--c-text-faint)', marginTop: 10, fontSize: 11 }}>Licensed under the MIT-with-hamburger licence. See LICENSE.</div>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Welcome ---------- */
function WelcomeModal({ close }: P) {
  const [auto, setAuto] = useState<{ at: number; name: string } | null>(null);
  const [skip, setSkip] = useState(() => localStorage.getItem('vsp.skipWelcome') === '1');
  useEffect(() => {
    autosaveInfo().then(setAuto);
  }, []);
  useEffect(() => {
    localStorage.setItem('vsp.skipWelcome', skip ? '1' : '0');
  }, [skip]);
  const restore = async () => {
    const p = await loadAutosavedProject();
    if (!p) return;
    const { restored, missing } = await restoreProjectMedia(p);
    useProject.getState().loadProject(p);
    usePlayback.setState({ playhead: 0 });
    toast('success', 'Project restored', `${restored} media item${restored === 1 ? '' : 's'} restored${missing.length ? `, ${missing.length} offline` : ''}.`);
    close();
    if (missing.length) useUI.getState().openModal({ kind: 'linkMedia', payload: { assetIds: missing.map((m) => m.id) } });
  };
  const actions: { icon: IconName; t: string; d: string; run: () => void }[] = [
    { icon: 'import', t: 'Import media', d: 'Video, audio, images, SRT captions. You can also drop files anywhere in the window.', run: () => { close(); void cmd.importMedia(); } },
    { icon: 'sequence', t: 'New sequence', d: 'Pick a frame size and timebase. Sequence 01 (1080p30) is already open and empty.', run: () => { close(); cmd.newSequence(); } },
    { icon: 'open', t: 'Open project', d: 'A .vsproj file saved from Vanguard, with or without embedded media.', run: () => { close(); void cmd.openProject(); } },
    { icon: 'keyboard', t: 'Keyboard shortcuts', d: 'Premiere-style keys: JKL shuttle, I/O marks, comma and period to insert and overwrite.', run: () => { close(); useUI.getState().openModal({ kind: 'keyboardShortcuts' }); } },
  ];
  return (
    <Modal title="Welcome" icon="logo" onClose={close} width={700} footer={<><Checkbox checked={skip} onChange={setSkip} label="Do not show again" /><span className="spacer" />{auto ? <Button onClick={() => void restore()}>Open autosave ({new Date(auto.at).toLocaleTimeString()})</Button> : null}<Button primary onClick={close}>Start editing</Button></>}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 15, color: 'var(--c-text-bright)' }}>Vanguard Studio Pro</div>
        <div style={{ color: 'var(--c-text-dim)', fontSize: 12, marginTop: 2 }}>A full non-linear editor in a browser tab. Your media never leaves this machine.</div>
      </div>
      <div className="welcome">
        {actions.map((a) => (
          <button key={a.t} type="button" className="big-btn" onClick={a.run}>
            <Icon name={a.icon} size={16} />
            <span>
              <span className="t" style={{ display: 'block' }}>{a.t}</span>
              <span className="d" style={{ display: 'block' }}>{a.d}</span>
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

export { createSequence };
