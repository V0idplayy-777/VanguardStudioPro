import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useUI, toast, type ModalRequest, type WorkspaceId } from '../../state/uiStore';
import { useProject, useActiveSequence, findAsset, createSequence, sequenceDuration } from '../../state/projectStore';
import { usePlayback, renderFrameToCanvas } from '../../engine/playback/playback';
import { useLayout } from '../../state/layoutStore';
import { Modal, Button, Select, Checkbox, HotText, TextField, TextArea, TimecodeField, ColorChip, Segmented, Kbd, Slider } from '../controls';
import { Icon, Swatch, type IconName } from '../icons';
import { cmd, pickAudioClip, splitScreenCells } from '../../app/commands';
import { MONTAGE_ASPECTS } from '../../engine/montage/montage';
import { EXPORT_PRESETS } from '../../engine/export/exporter';
import { SHORTCUTS, shortcutFor } from '../../app/shortcuts';
import { ExportPanel } from '../panels/ExportPanel';
import { LABEL_COLORS, MARKER_COLORS, DEFAULT_SEQUENCE_SETTINGS, type LabelColor, type Marker, type MarkerKind, type SequenceSettings, type Clip } from '../../types/project';
import { framesToTimecode } from '../../engine/timecode';
import { getMedia } from '../../engine/media/mediaStore';
import { pickFiles, relinkAsset, MEDIA_ACCEPT } from '../../engine/media/importer';
import { autosaveInfo, loadAutosavedProject, restoreProjectMedia, discardAutosave } from '../../engine/project/serialize';
import { estimateStorage, listMediaKeys, deleteMediaBlob } from '../../engine/media/mediaDb';
import { formatBytes, uid, isMac, rgbToHex, hexToRgb } from '../../engine/util';
import { suggestKeyColor, renderKeyPreview } from '../../engine/color/chromaKey';
import { aboutVersionClick, foundCount, EGG_TOTAL, checkSpeedEgg, checkSequenceNameEgg } from '../../easter/eggs';
import { useSettings, SETTINGS_META, ACCENT_PRESETS } from '../../state/settingsStore';
import { TRANSITIONS, AUDIO_TRANSITIONS } from '../../engine/effects/transitions';
import { blankTextDocument, shapeLayer } from '../graphics/templates';
import * as E from '../../engine/timeline/edits';
import { evalNumber } from '../../engine/keyframes';
import { ProxyManagerModal, TranscribeModal, MagicMaskModal, VoiceCleanupModal, ShortcutEditor } from './FeatureModals';

export const APP_VERSION = '1.1.0';
export const BUILD_ID = '2026.09.07';

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
    case 'recordVoiceover':
      return <VoiceoverModal {...props} />;
    case 'capture':
      return <CaptureModal {...props} />;
    case 'beatDetect':
      return <BeatDetectModal {...props} />;
    case 'removeSilence':
      return <RemoveSilenceModal {...props} />;
    case 'kenBurns':
      return <KenBurnsModal {...props} />;
    case 'autoReframe':
      return <AutoReframeModal {...props} />;
    case 'stabilize':
      return <StabilizeModal {...props} />;
    case 'syncAudio':
      return <SyncAudioModal {...props} />;
    case 'splitScreen':
      return <SplitScreenModal {...props} />;
    case 'autoMontage':
      return <AutoMontageModal {...props} />;
    case 'greenScreen':
      return <GreenScreenModal {...props} />;
    case 'proxyManager':
      return <ProxyManagerModal {...props} />;
    case 'transcribe':
      return <TranscribeModal {...props} />;
    case 'magicMask':
      return <MagicMaskModal {...props} />;
    case 'voiceCleanup':
      return <VoiceCleanupModal {...props} />;
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
  const kinds: { value: MarkerKind; label: string }[] = [{ value: 'comment', label: 'Comment Marker' }, { value: 'chapter', label: 'Chapter Marker' }, { value: 'segmentation', label: 'Segmentation Marker' }, { value: 'webLink', label: 'Web Link' }, { value: 'flashCue', label: 'Flash Cue Point' }, { value: 'beat', label: 'Beat Marker' }];
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
    <Modal title="Keyboard Shortcuts" icon="keyboard" onClose={close} width={760} footer={<><span className="dim" style={{ fontSize: 11 }}>Remapped bindings are marked and apply everywhere.</span><span className="spacer" /><Button onClick={() => useUI.getState().openModal({ kind: 'preferences', payload: { tab: 'keyboard' } })}>Customize…</Button><Button primary onClick={close}>Done</Button></>}>
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
                    <span style={{ display: 'flex', gap: 3, alignItems: 'center' }}>{(() => { const eff = shortcutFor(s.id); const changed = eff !== undefined && eff !== s.keys; const shown = eff ?? (s.keys || '—'); return (<>{shown === '—' ? <span className="dim">—</span> : shown.split('+').map((k) => <Kbd key={k}>{k}</Kbd>)}{changed ? <span className="pill proxy-pill" style={{ marginLeft: 2 }} title={`Default was: ${s.keys || 'unbound'}`}>remapped</span> : null}</>); })()}</span>
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

/* ---------- Settings (categorized, searchable) ---------- */

type SettingsCat = 'general' | 'appearance' | 'import' | 'timeline' | 'playback' | 'audio' | 'export' | 'captions' | 'workspace' | 'notifications' | 'accessibility' | 'performance' | 'storage' | 'autosave' | 'experimental' | 'keyboard';

const SETTINGS_CATS: { id: SettingsCat; label: string; icon: IconName; blurb: string }[] = [
  { id: 'general', label: 'General', icon: 'settings', blurb: 'Project defaults: transitions, timecode, labels.' },
  { id: 'appearance', label: 'Appearance', icon: 'color', blurb: 'Scale, accent color and surface brightness.' },
  { id: 'import', label: 'Import', icon: 'import', blurb: 'How media is scaled and sequenced when it arrives.' },
  { id: 'timeline', label: 'Timeline', icon: 'panelTimeline', blurb: 'Snapping, selection and clip display.' },
  { id: 'playback', label: 'Playback', icon: 'play', blurb: 'Program monitor quality and transport behaviour.' },
  { id: 'audio', label: 'Audio', icon: 'panelAudio', blurb: 'Hardware latency and master level.' },
  { id: 'export', label: 'Export', icon: 'panelExport', blurb: 'Opening preset, file names, captions and downloads.' },
  { id: 'captions', label: 'Captions', icon: 'panelCaptions', blurb: 'Default style for new sequences\' captions.' },
  { id: 'workspace', label: 'Workspace', icon: 'workspace', blurb: 'Startup layout and the welcome screen.' },
  { id: 'notifications', label: 'Notifications', icon: 'bell', blurb: 'Sounds, toast lifetime and verbosity.' },
  { id: 'accessibility', label: 'Accessibility', icon: 'eye', blurb: 'Motion, contrast, text size and photosensitivity options.' },
  { id: 'performance', label: 'Performance', icon: 'panelScopes', blurb: 'Thumbnails, decode cache and diagnostics.' },
  { id: 'storage', label: 'Storage & Privacy', icon: 'database', blurb: 'What lives in this browser, and how to clear it.' },
  { id: 'autosave', label: 'Auto Save', icon: 'panelHistory', blurb: 'Automatic project snapshots.' },
  { id: 'experimental', label: 'Experimental', icon: 'panelEffects', blurb: 'Render pipeline switches. Off by default? Good - leave it.' },
  { id: 'keyboard', label: 'Keyboard', icon: 'keyboard', blurb: 'Remap every shortcut. Click a binding, press keys, done.' },
];

/* ---------- Settings > Storage & Privacy ---------- */
function StorageSettings({ onNavigate }: { onNavigate: (t: SettingsCat) => void }) {
  const project = useProject((s) => s.project);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => {
    estimateStorage().then(setUsage).catch(() => setUsage(null));
  };
  useEffect(refresh, []);

  const SRow = ({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) => (
    <div className="settings-row">
      <span className="lbl">
        <div className="name">{label}</div>
        {desc ? <div className="desc">{desc}</div> : null}
      </span>
      <span className="ctl">{children}</span>
    </div>
  );

  const clearUnused = async () => {
    setBusy('unused');
    try {
      const keys = await listMediaKeys();
      const live = new Set(project.assets.map((a) => a.id));
      let n = 0;
      for (const k of keys) {
        const base = k.startsWith('proxy:') || k.startsWith('clean:') ? k.slice(k.indexOf(':') + 1) : k;
        if (!live.has(base)) {
          await deleteMediaBlob(k);
          n++;
        }
      }
      toast('success', 'Media cache cleaned', n ? `${n} unused item${n === 1 ? '' : 's'} removed.` : 'Nothing unused was cached.');
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const clearAll = async () => {
    if (!confirm('Delete ALL cached media from this browser? Projects reload offline until you re-import or relink their media.')) return;
    setBusy('all');
    try {
      const keys = await listMediaKeys();
      for (const k of keys) await deleteMediaBlob(k);
      toast('info', 'Media cache deleted', `${keys.length} item${keys.length === 1 ? '' : 's'} removed.`);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const pct = usage && usage.quota > 0 ? Math.min(100, (usage.usage / usage.quota) * 100) : 0;

  return (
    <>
      <div className="settings-section-title">Privacy</div>
      <SRow label="Nothing leaves this browser" desc="Vanguard has no server side. Media, projects, autosaves, layouts and settings are stored locally (IndexedDB and localStorage) and are never uploaded anywhere.">
        <span className="dim" style={{ fontSize: 11 }}>100% local</span>
      </SRow>
      <div className="settings-section-title">Browser storage</div>
      <SRow label="Space used" desc="Media cache, autosaves and saved layouts in this browser's storage.">
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 190 }}>
          <span className="progress" style={{ width: 90, margin: 0 }}><div style={{ width: `${pct}%` }} /></span>
          <span className="dim tc" style={{ fontSize: 11 }}>{usage ? `${formatBytes(usage.usage)} of ${formatBytes(usage.quota)}` : 'measuring...'}</span>
        </span>
      </SRow>
      <div className="settings-section-title">Clean up</div>
      <SRow label="Unused media cache" desc="Deletes cached blobs that no asset in the open project references. Safe - current media keeps working after reload.">
        <Button sm onClick={() => void clearUnused()} disabled={busy !== null}>{busy === 'unused' ? 'Cleaning...' : 'Clear unused'}</Button>
      </SRow>
      <SRow label="All cached media" desc="Empties the whole media cache. Reloaded projects will need their files relinked.">
        <Button sm danger onClick={() => void clearAll()} disabled={busy !== null}>{busy === 'all' ? 'Deleting...' : 'Delete all'}</Button>
      </SRow>
      <SRow label="Autosave snapshot" desc="Discard the autosaved project stored in this browser.">
        <Button sm danger onClick={() => { discardAutosave().then(() => toast('info', 'Autosave discarded')); }}>Discard autosave</Button>
      </SRow>
      <SRow label="Local data" desc="Clears layouts, settings and caches kept in this browser (keeps the media cache).">
        <Button sm danger onClick={() => { localStorage.clear(); toast('info', 'Local data cleared', 'Reload to apply.'); }}>Clear local data</Button>
      </SRow>
      <SRow label="Autosave policy" desc="Whether and how often the project snapshots itself.">
        <Button sm onClick={() => onNavigate('autosave')}>Auto Save settings</Button>
      </SRow>
    </>
  );
}

function PreferencesModal({ modal, close }: P) {
  const ui = useUI();
  const project = useProject((s) => s.project);
  const st = useSettings();
  const initialTab = (modal.payload?.tab as SettingsCat | undefined) ?? 'general';
  const [tab, setTab] = useState<SettingsCat>(SETTINGS_CATS.some((c) => c.id === initialTab) ? initialTab : 'general');
  const [q, setQ] = useState('');
  const set = (label: string, fn: (s: typeof project.settings) => void) => useProject.getState().update(label, (p) => fn(p.settings));
  const S = project.settings;

  const Row = ({ label, desc, children, badge }: { label: string; desc?: string; children: React.ReactNode; badge?: string }) => (
    <div className="settings-row">
      <span className="lbl">
        <div className="name">
          {label}
          {badge ? <span className="badge-beta">{badge}</span> : null}
        </div>
        {desc ? <div className="desc">{desc}</div> : null}
      </span>
      <span className="ctl">{children}</span>
    </div>
  );

  const searchHit = (...terms: string[]) => !q.trim() || terms.some((t) => t.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <Modal title="Settings" icon="settings" onClose={close} width={780} footer={<><span className="dim" style={{ fontSize: 11 }}>Settings apply immediately and persist in this browser.</span><span className="spacer" /><Button primary onClick={close}>Done</Button></>}>
      <TextField value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings..." icon="search" style={{ marginBottom: 10, width: 260 }} />
      <div style={{ display: 'grid', gridTemplateColumns: '176px 1fr', gap: 16, minHeight: 340 }}>
        <div className="settings-side" style={{ borderRight: '1px solid var(--c-line)', paddingRight: 8 }}>
          {SETTINGS_CATS.filter((c) => !q.trim() || searchHit(c.label, c.blurb)).map((c) => (
            <div key={c.id} className={`settings-cat${tab === c.id ? ' sel' : ''}`} onClick={() => setTab(c.id)}>
              <Icon name={c.icon} size={13} />
              {c.label}
            </div>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 6, padding: '8px 0' }}>
            <Button sm onClick={() => { st.reset(); useUI.getState().toast({ kind: 'info', title: 'Settings reset', message: 'App settings are back to defaults.' }); }}>Reset app settings</Button>
          </div>
        </div>
        <div className="scroll-y" style={{ maxHeight: '56vh', paddingRight: 6 }}>
          {tab === 'general' ? (
            <>
              <div className="settings-section-title">Editing defaults</div>
              {searchHit('video transition', 'default transition') ? (
                <Row label="Video transition" desc="Applied by Ctrl+D and the Effects panel default.">
                  <span style={{ display: 'flex', gap: 6 }}>
                    <Select value={S.defaultVideoTransition} options={TRANSITIONS.map((t) => ({ value: t.type, label: t.name }))} onChange={(v) => set('Preferences', (s) => (s.defaultVideoTransition = v))} />
                    <HotText value={S.defaultTransitionDuration} min={2} max={600} step={1} unit=" fr" width={60} onChange={(v, c) => c && set('Preferences', (s) => (s.defaultTransitionDuration = Math.round(v)))} />
                  </span>
                </Row>
              ) : null}
              {searchHit('audio transition') ? (
                <Row label="Audio transition">
                  <span style={{ display: 'flex', gap: 6 }}>
                    <Select value={S.defaultAudioTransition} options={AUDIO_TRANSITIONS.map((t) => ({ value: t.type, label: t.name }))} onChange={(v) => set('Preferences', (s) => (s.defaultAudioTransition = v))} />
                    <HotText value={S.defaultAudioTransitionDuration} min={2} max={600} step={1} unit=" fr" width={60} onChange={(v, c) => c && set('Preferences', (s) => (s.defaultAudioTransitionDuration = Math.round(v)))} />
                  </span>
                </Row>
              ) : null}
              {searchHit('timecode') ? (
                <Row label="Timecode display" desc="Shown in monitors, the timeline and exported lists.">
                  <Segmented value={ui.timecodeMode} options={[{ value: 'timecode', label: 'TC' }, { value: 'frames', label: 'Frames' }, { value: 'seconds', label: 'Seconds' }]} onChange={(v) => ui.setTimecodeMode(v)} />
                </Row>
              ) : null}
              {searchHit('label colors', 'label defaults') ? (
                <Row label="Label defaults" desc="Clip label color per media type.">
                  <span style={{ display: 'grid', gridTemplateColumns: 'repeat(2, auto 1fr)', gap: '4px 8px', alignItems: 'center' }}>
                    {(Object.keys(S.labelDefaults) as (keyof typeof S.labelDefaults)[]).map((k) => (
                      <React.Fragment key={k}>
                        <span className="dim" style={{ textTransform: 'capitalize' }}>{k}</span>
                        <Select value={S.labelDefaults[k]} options={(Object.keys(LABEL_COLORS) as LabelColor[]).map((l) => ({ value: l, label: l }))} onChange={(v) => set('Preferences', (s) => (s.labelDefaults[k] = v as LabelColor))} />
                      </React.Fragment>
                    ))}
                  </span>
                </Row>
              ) : null}
            </>
          ) : null}

          {tab === 'appearance' ? (
            <>
              <div className="settings-section-title">Interface</div>
              <Row label="Interface scale" desc={SETTINGS_META.uiScale.hint}>
                <Segmented value={String(st.uiScale)} options={[85, 95, 100, 105, 115, 125].map((v) => ({ value: String(v), label: `${v}%` }))} onChange={(v) => st.set('uiScale', Number(v))} />
              </Row>
              <Row label="Accent color" desc="Playhead, selection and highlights.">
                <span style={{ display: 'flex', gap: 6 }}>
                  {ACCENT_PRESETS.map((a) => (
                    <span key={a.value} title={a.name} onClick={() => st.set('accent', a.value)} style={{ width: 20, height: 20, borderRadius: 3, cursor: 'pointer', background: a.value, outline: st.accent === a.value ? '2px solid #e0e0e0' : '1px solid #0b0b0b', outlineOffset: st.accent === a.value ? 0 : -1 }} />
                  ))}
                </span>
              </Row>
              <Row label="Brighter surfaces" desc={SETTINGS_META.brightSurfaces.hint}>
                <Checkbox checked={st.brightSurfaces} onChange={(v) => st.set('brightSurfaces', v)} />
              </Row>
            </>
          ) : null}

          {tab === 'import' ? (
            <>
              <div className="settings-section-title">Placing media</div>
              {searchHit('default scale', 'media scale', 'fit', 'fill') ? (
                <Row label="Default scale for placed media" desc={SETTINGS_META.importScaleMode.hint + ' Native keeps original pixel size (Premiere-style).'}>
                  <Segmented value={st.importScaleMode} options={[{ value: 'native', label: 'Native' }, { value: 'fit', label: 'Fit frame' }, { value: 'fill', label: 'Fill frame' }]} onChange={(v) => st.set('importScaleMode', v)} />
                </Row>
              ) : null}
              {searchHit('still image duration', 'photo length') ? (
                <Row label="Still image duration" desc="Length used when images are added to the timeline.">
                  <HotText value={S.defaultStillDuration / S.defaultSequence.fps} min={0.1} max={600} step={0.5} decimals={1} unit=" s" width={70} onChange={(v, c) => c && set('Preferences', (s) => (s.defaultStillDuration = Math.round(v * s.defaultSequence.fps)))} />
                </Row>
              ) : null}
              <div className="settings-section-title">Ingest</div>
              {searchHit('auto sequence', 'create sequence on import') ? (
                <Row label="Auto-create sequence on import" desc={SETTINGS_META.importAutoSequence.hint}>
                  <Checkbox checked={st.importAutoSequence} onChange={(v) => st.set('importAutoSequence', v)} />
                </Row>
              ) : null}
              <Row label="Where media lives" desc="Imports are cached in this browser (IndexedDB) so reloads can restore them. Manage that cache under Storage & Privacy.">
                <Button sm onClick={() => setTab('storage')}>Open Storage</Button>
              </Row>
            </>
          ) : null}

          {tab === 'timeline' ? (
            <>
              <div className="settings-section-title">Editing</div>
              <Row label="Snap while dragging (S)" desc="Clips, markers and the playhead attract each other.">
                <Checkbox checked={ui.snapping} onChange={ui.setSnapping} />
              </Row>
              <Row label="Linked selection" desc="Select audio and video parts together.">
                <Checkbox checked={ui.linkedSelection} onChange={ui.setLinkedSelection} />
              </Row>
              <Row label="Delete ripples" desc="The delete key closes the gap instead of leaving one.">
                <Checkbox checked={ui.rippleDelete} onChange={(v) => useUI.setState({ rippleDelete: v })} />
              </Row>
              <div className="settings-section-title">Clip display</div>
              <Row label="Audio waveforms"><Checkbox checked={ui.showAudioWaveforms} onChange={(v) => ui.setTimelineDisplay({ showAudioWaveforms: v })} /></Row>
              <Row label="Video thumbnails"><Checkbox checked={ui.showVideoThumbnails} onChange={(v) => ui.setTimelineDisplay({ showVideoThumbnails: v })} /></Row>
              <Row label="Clip names"><Checkbox checked={ui.showClipNames} onChange={(v) => ui.setTimelineDisplay({ showClipNames: v })} /></Row>
              <Row label="Nudge distance" desc="Alt+Left/Right nudges by this; Alt+Shift by 5x.">
                <HotText value={ui.nudgeFrames} min={1} max={100} step={1} unit=" fr" width={60} onChange={(v, c) => c && useUI.setState({ nudgeFrames: Math.round(v) })} />
              </Row>
            </>
          ) : null}

          {tab === 'playback' ? (
            <>
              <div className="settings-section-title">Program monitor</div>
              <Row label="Resolution for new sessions" desc="Can be changed per session from the monitor toolbar.">
                <Segmented value={st.defaultProgramQuality} options={[{ value: 'full', label: 'Full' }, { value: 'half', label: '1/2' }, { value: 'quarter', label: '1/4' }]} onChange={(v) => st.set('defaultProgramQuality', v)} />
              </Row>
              <Row label="Current session" desc="Applies right now.">
                <Segmented value={ui.programQuality} options={[{ value: 'full', label: 'Full' }, { value: 'half', label: '1/2' }, { value: 'quarter', label: '1/4' }]} onChange={(v) => ui.setProgramQuality(v)} />
              </Row>
              <Row label="Drop quality to keep up" desc={SETTINGS_META.autoQualityDrop.hint}>
                <Checkbox checked={st.autoQualityDrop} onChange={(v) => st.set('autoQualityDrop', v)} />
              </Row>
              <Row label="End on the last video frame" desc={SETTINGS_META.parkOnLastFrame.hint}>
                <Checkbox checked={st.parkOnLastFrame} onChange={(v) => st.set('parkOnLastFrame', v)} />
              </Row>
              <div className="settings-section-title">Proxy media</div>
              {searchHit('proxy', 'proxies', 'playback') ? (
                <>
                  <Row label="Use proxies when available" desc={SETTINGS_META.proxyEnabled.hint}>
                    <Checkbox checked={st.proxyEnabled} onChange={(v) => st.set('proxyEnabled', v)} />
                  </Row>
                  <Row label="Proxy size" desc={SETTINGS_META.proxyScale.hint}>
                    <Segmented value={st.proxyScale} options={[{ value: '720p', label: '720p' }, { value: '540p', label: '540p' }, { value: '360p', label: '360p' }]} onChange={(v) => st.set('proxyScale', v)} />
                  </Row>
                  <Row label="Proxy codec">
                    <Segmented value={st.proxyCodec} options={[{ value: 'h264', label: 'H.264' }, { value: 'vp9', label: 'VP9' }]} onChange={(v) => st.set('proxyCodec', v)} />
                  </Row>
                  <Row label="Offer proxies for HD+ footage" desc={SETTINGS_META.proxyAutoOffer.hint}>
                    <Checkbox checked={st.proxyAutoOffer} onChange={(v) => st.set('proxyAutoOffer', v)} />
                  </Row>
                  <Row label="Manage" desc="Create, attach or delete proxies for any asset.">
                    <Button sm onClick={() => useUI.getState().openModal({ kind: 'proxyManager' })}>Open Proxy Manager…</Button>
                  </Row>
                </>
              ) : null}
              <div className="settings-section-title">Transport</div>
              <Row label="Shuttle" desc="J/K/L step through 1x, 2x, 4x, 8x. Space plays at 1x.">
                <span className="dim" style={{ fontSize: 11 }}>J K L</span>
              </Row>
              <Row label="Loop playback" desc="Loop between In and Out (or the whole sequence).">
                <Checkbox checked={usePlayback.getState().loop} onChange={(v) => usePlayback.getState().setLoop(v)} />
              </Row>
            </>
          ) : null}

          {tab === 'audio' ? (
            <>
              <div className="settings-section-title">Hardware</div>
              <Row label="Latency" desc="Takes effect for new audio sessions (reload). Sample rate follows the sequence, 48 kHz by default.">
                <Segmented value={S.audioHardware.latencyHint} options={[{ value: 'interactive', label: 'Low' }, { value: 'balanced', label: 'Balanced' }, { value: 'playback', label: 'Stable' }]} onChange={(v) => set('Preferences', (s) => (s.audioHardware.latencyHint = v))} />
              </Row>
              <div className="settings-section-title">Master</div>
              <Row label="Master level" desc="Output trim on the audio master bus.">
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <HotText value={usePlayback.getState().masterDb} min={-60} max={12} step={0.5} decimals={1} unit=" dB" width={70} onChange={(v, c) => c && usePlayback.getState().setMaster(v)} />
                  <Button sm onClick={() => usePlayback.getState().setMaster(0)}>Reset</Button>
                </span>
              </Row>
            </>
          ) : null}

          {tab === 'export' ? (
            <>
              <div className="settings-section-title">Defaults</div>
              {searchHit('preset', 'export preset') ? (
                <Row label="Opening preset" desc="Applied when the Export panel opens. 'None' keeps the per-sequence defaults.">
                  <Select value={st.exportDefaultPreset} options={[{ value: 'none', label: 'None (match sequence)' }, ...EXPORT_PRESETS.map((p) => ({ value: p.id, label: p.name }))]} onChange={(v) => st.set('exportDefaultPreset', v)} />
                </Row>
              ) : null}
              {searchHit('file name', 'filename') ? (
                <Row label="File name" desc="Default output name for exports and render queue items.">
                  <Segmented value={st.exportFilenameMode} options={[{ value: 'sequence', label: 'Sequence' }, { value: 'project', label: 'Project - Sequence' }, { value: 'dated', label: 'Sequence + date' }]} onChange={(v) => st.set('exportFilenameMode', v)} />
                </Row>
              ) : null}
              {searchHit('burn captions') ? (
                <Row label="Burn captions by default" desc={SETTINGS_META.exportBurnCaptions.hint}>
                  <Checkbox checked={st.exportBurnCaptions} onChange={(v) => st.set('exportBurnCaptions', v)} />
                </Row>
              ) : null}
              {searchHit('download') ? (
                <Row label="Download automatically" desc={SETTINGS_META.exportAutoDownload.hint}>
                  <Checkbox checked={st.exportAutoDownload} onChange={(v) => st.set('exportAutoDownload', v)} />
                </Row>
              ) : null}
              <div className="settings-section-title">Render queue</div>
              <Row label="Batch exports" desc="Queue several sequences (or the same one with different presets) from the Export panel; they render one after another.">
                <Button sm icon="export" onClick={() => { close(); useUI.getState().openModal({ kind: 'export' }); }}>Open Export</Button>
              </Row>
            </>
          ) : null}

          {tab === 'captions' ? (
            <>
              <div className="settings-section-title">Default style for new sequences</div>
              {searchHit('font') ? (
                <Row label="Font">
                  <span style={{ display: 'flex', gap: 6 }}>
                    <Select value={S.captionDefaults.fontFamily} options={['Inter Variable', 'Arial', 'Helvetica', 'Verdana', 'Georgia', 'Courier New'].map((f) => ({ value: f, label: f === 'Inter Variable' ? 'Inter' : f }))} onChange={(v) => set('Caption defaults', (s) => (s.captionDefaults.fontFamily = v))} />
                    <HotText value={S.captionDefaults.fontSize} min={8} max={300} step={1} unit=" px" width={62} onChange={(v, c) => c && set('Caption defaults', (s) => (s.captionDefaults.fontSize = Math.round(v)))} />
                  </span>
                </Row>
              ) : null}
              {searchHit('caption color', 'text color') ? (
                <Row label="Text color">
                  <ColorChip color={S.captionDefaults.color} onChange={(h) => set('Caption defaults', (s) => (s.captionDefaults.color = h))} />
                </Row>
              ) : null}
              {searchHit('caption background') ? (
                <Row label="Background" desc="Box behind the text; drag the chip's alpha for transparency.">
                  <ColorChip color={S.captionDefaults.backgroundColor} alpha={S.captionDefaults.backgroundOpacity} onChange={(h) => set('Caption defaults', (s) => (s.captionDefaults.backgroundColor = h))} onAlpha={(a) => set('Caption defaults', (s) => (s.captionDefaults.backgroundOpacity = a))} />
                </Row>
              ) : null}
              {searchHit('caption edge', 'outline', 'shadow') ? (
                <Row label="Edge">
                  <Select value={S.captionDefaults.edge} options={[{ value: 'none', label: 'None' }, { value: 'shadow', label: 'Drop shadow' }, { value: 'outline', label: 'Outline' }, { value: 'raised', label: 'Raised' }]} onChange={(v) => set('Caption defaults', (s) => (s.captionDefaults.edge = v as any))} />
                </Row>
              ) : null}
              {searchHit('caption position') ? (
                <Row label="Vertical position" desc="0% is the top of the frame, 100% the bottom.">
                  <HotText value={S.captionDefaults.position * 100} min={0} max={100} step={1} unit="%" width={62} onChange={(v, c) => c && set('Caption defaults', (s) => (s.captionDefaults.position = v / 100))} />
                </Row>
              ) : null}
              {searchHit('caption width') ? (
                <Row label="Max width">
                  <HotText value={S.captionDefaults.maxWidth * 100} min={20} max={100} step={1} unit="%" width={62} onChange={(v, c) => c && set('Caption defaults', (s) => (s.captionDefaults.maxWidth = v / 100))} />
                </Row>
              ) : null}
              <div className="settings-section-title">Speech-to-text</div>
              {searchHit('transcribe', 'transcription', 'speech', 'whisper', 'model', 'language') ? (
                <>
                  <Row label="Transcription model" desc={SETTINGS_META.sttModel.hint}>
                    <Select value={st.sttModel} options={[{ value: 'tiny.en', label: 'Tiny (English)' }, { value: 'tiny', label: 'Tiny (multilingual)' }, { value: 'base', label: 'Base' }, { value: 'small', label: 'Small' }]} onChange={(v) => st.set('sttModel', v)} />
                  </Row>
                  <Row label="Transcription language" desc="Auto-detect works with the multilingual models.">
                    <Select value={st.sttLanguage} options={[{ value: 'auto', label: 'Auto-detect' }, { value: 'en', label: 'English' }, { value: 'es', label: 'Spanish' }, { value: 'fr', label: 'French' }, { value: 'de', label: 'German' }, { value: 'it', label: 'Italian' }, { value: 'pt', label: 'Portuguese' }, { value: 'nl', label: 'Dutch' }, { value: 'ja', label: 'Japanese' }, { value: 'zh', label: 'Chinese' }]} onChange={(v) => st.set('sttLanguage', v)} />
                  </Row>
                  <Row label="Transcribe" desc="Turn the open sequence's audio into captions.">
                    <Button sm onClick={() => useUI.getState().openModal({ kind: 'transcribe', payload: {} })}>Transcribe…</Button>
                  </Row>
                </>
              ) : null}
              <Row label="Current sequence" desc="Copy these defaults onto the open sequence's caption track.">
                <Button sm onClick={() => {
                  const active = project.sequences.find((x) => x.id === project.activeSequenceId);
                  if (!active) return toast('info', 'Captions', 'No sequence is open.');
                  useProject.getState().update('Caption defaults', (p) => {
                    const s = p.sequences.find((x) => x.id === active.id);
                    if (s) s.captionTrack.style = { ...p.settings.captionDefaults };
                  });
                  toast('success', 'Caption style applied', active.name);
                }}>Apply to Sequence</Button>
              </Row>
            </>
          ) : null}

          {tab === 'workspace' ? (
            <>
              <div className="settings-section-title">Startup</div>
              {searchHit('startup workspace', 'launch layout') ? (
                <Row label="Startup workspace" desc={SETTINGS_META.startupWorkspace.hint}>
                  <Select value={st.startupWorkspace} options={[{ value: 'last', label: 'Last used' }, { value: 'assembly', label: 'Assembly' }, { value: 'editing', label: 'Editing' }, { value: 'color', label: 'Color' }, { value: 'effects', label: 'Effects' }, { value: 'audio', label: 'Audio' }, { value: 'graphics', label: 'Graphics' }, { value: 'captions', label: 'Captions' }, { value: 'review', label: 'Review' }, { value: 'export', label: 'Export' }]} onChange={(v) => st.set('startupWorkspace', v as any)} />
                </Row>
              ) : null}
              {searchHit('welcome', 'start screen') ? (
                <Row label="Welcome screen on startup" desc="The start dialog with Import / New Sequence / Open Project.">
                  <Checkbox checked={st.showWelcomeOnStartup} onChange={(v) => st.set('showWelcomeOnStartup', v)} />
                </Row>
              ) : null}
              <div className="settings-section-title">Layouts</div>
              <Row label="Reset workspaces" desc="Bring every workspace layout back to its preset.">
                <Button sm onClick={() => { useLayout.getState().resetAll(); useUI.getState().bumpLayout(); toast('info', 'Workspaces reset'); }}>Reset all workspaces</Button>
              </Row>
            </>
          ) : null}

          {tab === 'notifications' ? (
            <>
              <div className="settings-section-title">Sounds</div>
              {searchHit('export sound', 'chime', 'ding') ? (
                <Row label="Sound when an export finishes" desc={SETTINGS_META.soundOnExport.hint}>
                  <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Checkbox checked={st.soundOnExport} onChange={(v) => st.set('soundOnExport', v)} />
                    <Button sm onClick={() => void import('../../engine/audio/notify').then((m) => m.playChime('success'))}>Preview</Button>
                  </span>
                </Row>
              ) : null}
              <div className="settings-section-title">Toasts</div>
              {searchHit('toast duration', 'notification length') ? (
                <Row label="Notification duration" desc="Seconds a toast stays on screen (errors stay twice as long).">
                  <HotText value={st.toastDuration} min={1.5} max={15} step={0.5} decimals={1} unit=" s" width={70} onChange={(v, c) => c && st.set('toastDuration', v)} />
                </Row>
              ) : null}
              {searchHit('verbose') ? (
                <Row label="Verbose notifications" desc="Confirm more actions with toasts, even when the result is already visible.">
                  <Checkbox checked={st.verboseToasts} onChange={(v) => st.set('verboseToasts', v)} />
                </Row>
              ) : null}
            </>
          ) : null}

          {tab === 'accessibility' ? (
            <>
              <div className="settings-section-title">Vision</div>
              <Row label="Larger text" desc={SETTINGS_META.largerText.hint}>
                <Checkbox checked={st.largerText} onChange={(v) => st.set('largerText', v)} />
              </Row>
              <Row label="High contrast interface" desc={SETTINGS_META.highContrast.hint}>
                <Checkbox checked={st.highContrast} onChange={(v) => st.set('highContrast', v)} />
              </Row>
              <Row label="Strong focus rings" desc={SETTINGS_META.strongFocus.hint}>
                <Checkbox checked={st.strongFocus} onChange={(v) => st.set('strongFocus', v)} />
              </Row>
              <div className="settings-section-title">Motion & photosensitivity</div>
              <Row label="Reduce motion" desc={SETTINGS_META.reduceMotion.hint}>
                <Checkbox checked={st.reduceMotion} onChange={(v) => st.set('reduceMotion', v)} />
              </Row>
              <Row label="Disable flashing effects" desc={SETTINGS_META.disableFlashingEffects.hint}>
                <Checkbox checked={st.disableFlashingEffects} onChange={(v) => st.set('disableFlashingEffects', v)} />
              </Row>
            </>
          ) : null}

          {tab === 'performance' ? (
            <>
              <div className="settings-section-title">Thumbnails & caches</div>
              <Row label="Timeline thumbnails" desc="Off skips thumbnail decoding entirely (useful for huge projects).">
                <Segmented value={st.thumbnailQuality} options={[{ value: 'off', label: 'Off' }, { value: 'low', label: 'Low' }, { value: 'high', label: 'High' }]} onChange={(v) => st.set('thumbnailQuality', v)} />
              </Row>
              <Row label="Decode cache" desc="Decoded frames kept per video source. Higher = smoother scrubbing, more memory.">
                <Segmented value={String(st.decodeCacheSize)} options={[24, 48, 96, 160].map((v) => ({ value: String(v), label: String(v) }))} onChange={(v) => st.set('decodeCacheSize', Number(v))} />
              </Row>
              <div className="settings-section-title">Diagnostics</div>
              <Row label="Performance overlay" desc={SETTINGS_META.showFpsOverlay.hint}>
                <Checkbox checked={st.showFpsOverlay} onChange={(v) => st.set('showFpsOverlay', v)} />
              </Row>
            </>
          ) : null}

          {tab === 'storage' ? (
            <StorageSettings onNavigate={setTab} />
          ) : null}

          {tab === 'keyboard' ? (
            <ShortcutEditor />
          ) : null}

          {tab === 'autosave' ? (
            <>
              <div className="settings-section-title">Auto Save</div>
              <Row label="Autosave" desc="Automatically save the project in browser storage when something changed.">
                <Checkbox checked={S.autoSaveEnabled} onChange={(v) => set('Preferences', (s) => (s.autoSaveEnabled = v))} />
              </Row>
              <Row label="Interval" desc="Autosaves only when something changed. Media is cached in IndexedDB so a reload restores the project.">
                <HotText value={S.autoSaveIntervalMinutes} min={1} max={60} step={1} unit=" min" width={70} onChange={(v, c) => c && set('Preferences', (s) => (s.autoSaveIntervalMinutes = Math.round(v)))} disabled={!S.autoSaveEnabled} />
              </Row>
              <Row label="Saved snapshot" desc="Open or discard the autosaved project from the Project Manager.">
                <Button sm onClick={() => { close(); useUI.getState().openModal({ kind: 'projectManager' }); }}>Project Manager</Button>
              </Row>
            </>
          ) : null}

          {tab === 'experimental' ? (
            <>
              <div className="settings-section-title">Render pipeline</div>
              <Row label="Half-float render pipeline" badge="beta" desc="Higher precision compositing; disable on GPUs that glitch.">
                <Checkbox checked={st.floatPipeline} onChange={(v) => st.set('floatPipeline', v)} />
              </Row>
              <Row label="Snapshot presentation" badge="beta" desc={SETTINGS_META.snapshotPresentation.hint}>
                <Checkbox checked={st.snapshotPresentation} onChange={(v) => st.set('snapshotPresentation', v)} />
              </Row>
              <Row label="Low-latency canvas" desc="Hint that lets the browser composite frames earlier. Turn off if you see tearing.">
                <Checkbox checked={st.desyncCanvas} onChange={(v) => st.set('desyncCanvas', v)} />
              </Row>
              <Row label="Render debug logging" desc="Write render diagnostics to the Events panel (Window, Events).">
                <Checkbox checked={st.debugRenderLogging} onChange={(v) => st.set('debugRenderLogging', v)} />
              </Row>
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Voiceover recording ---------- */
function VoiceoverModal({ close }: P) {
  const seq = useActiveSequence();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [session, setSession] = useState<import('../../engine/media/recorder').CaptureSession | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [roll, setRoll] = useState(true);
  const [preroll, setPreroll] = useState(true);
  const [busy, setBusy] = useState(false);
  const recordFrame = useRef(0);
  const sessionRef = useRef<typeof session>(null);
  sessionRef.current = session;

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then((all) => setDevices(all.filter((d) => d.kind === 'audioinput'))).catch(() => {});
  }, []);

  useEffect(() => {
    if (!session) return;
    const iv = window.setInterval(() => {
      const s = sessionRef.current;
      if (!s) return;
      setElapsed(s.elapsed());
      setLevel(s.level() ?? 0);
    }, 60);
    return () => window.clearInterval(iv);
  }, [session]);

  const start = async () => {
    if (!seq) return;
    try {
      setBusy(true);
      const { startCapture } = await import('../../engine/media/recorder');
      const startFrame = usePlayback.getState().playhead;
      recordFrame.current = startFrame;
      if (preroll) {
        for (let n = 3; n > 0; n--) {
          setCountdown(n);
          await new Promise((r) => setTimeout(r, 800));
        }
        setCountdown(null);
      }
      const s = await startCapture('voiceover', { deviceId: deviceId || undefined });
      setSession(s);
      setBusy(false);
      if (roll) usePlayback.getState().play(1);
    } catch (e: any) {
      setBusy(false);
      setCountdown(null);
      toast('error', 'Microphone unavailable', e?.message ?? String(e));
    }
  };

  const stop = async () => {
    const s = sessionRef.current;
    if (!s) return;
    setBusy(true);
    usePlayback.getState().pause();
    const result = await s.stop();
    setSession(null);
    const { importCapture } = await import('../../engine/media/recorder');
    const stamp = new Date();
    const name = `Voiceover ${stamp.getHours().toString().padStart(2, '0')}.${stamp.getMinutes().toString().padStart(2, '0')}`;
    const assets = await importCapture(result, name);
    if (assets[0] && seq) {
      await new Promise((r) => setTimeout(r, 250));
      const live = useProject.getState().project.assets.find((a) => a.id === assets[0].id);
      if (live) cmd.placeAssetsAt([live], recordFrame.current, 'overwrite');
      toast('success', 'Voiceover recorded', `${result.durationSec.toFixed(1)} s placed on the first audio track at the record position.`);
    }
    setBusy(false);
    close();
  };

  const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${Math.floor((ms % 1000) / 100)}`;
  const meter = (v: number) => Math.max(0, Math.min(1, v * 1.4));

  return (
    <Modal title="Record Voiceover" icon="mic" onClose={() => (session ? void stop() : close())} width={480} footer={
      <>
        <span className="dim" style={{ fontSize: 11 }}>{session ? `Recording${roll ? ' - timeline rolling' : ''}` : 'Records from your microphone onto an audio track'}</span>
        <span className="spacer" />
        {session ? (
          <Button danger onClick={() => void stop()} disabled={busy}>Stop &amp; Add to Timeline</Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button primary onClick={() => void start()} disabled={busy || !seq}>{countdown != null ? `Starting in ${countdown}...` : busy ? 'Requesting microphone...' : preroll ? 'Record (with count-in)' : 'Record'}</Button>
          </>
        )}
      </>
    }>
      {!seq ? <div className="empty">Open a sequence first - the voiceover is placed at the playhead.</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="prop-grid">
            <span className="label">Microphone</span>
            <Select
              value={deviceId}
              options={[{ value: '', label: 'Default microphone' }, ...devices.filter((d) => d.deviceId).map((d) => ({ value: d.deviceId, label: d.label || 'Microphone' }))]}
              onChange={setDeviceId}
              disabled={!!session}
            />
            <span className="label">Starts at</span>
            <span className="dim" style={{ fontSize: 11 }}>The current playhead{seq ? ` (${framesToTimecode(usePlayback.getState().playhead, seq.settings.fps)})` : ''}. Playback rolls while recording so you can narrate to picture.</span>
          </div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <Checkbox checked={roll} onChange={setRoll} label="Roll timeline while recording" disabled={!!session} />
            <Checkbox checked={preroll} onChange={setPreroll} label="3-second count-in" disabled={!!session} />
          </div>
          <div className="vo-meter-wrap">
            <div className={`vo-meter${session ? ' live' : ''}`}>
              {Array.from({ length: 24 }, (_, i) => {
                const on = meter(level) * 24 > i;
                return <span key={i} className={on ? (i > 19 ? 'hot' : 'on') : ''} />;
              })}
            </div>
            <span style={{ fontSize: 13, color: session ? 'var(--c-error)' : 'var(--c-text-faint)', minWidth: 64, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {session ? (countdown != null ? countdown : fmt(elapsed)) : countdown != null ? countdown : '0:00.0'}
            </span>
          </div>
          <div className="dim" style={{ fontSize: 11 }}>
            Tip: keep peaks in the upper green. Red clips are lost - move further from the mic or lower the input level in the OS.
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ---------- Screen / webcam capture ---------- */
function CaptureModal({ modal, close }: P) {
  const kind: 'screen' | 'webcam' = modal.payload?.kind === 'webcam' ? 'webcam' : 'screen';
  const [session, setSession] = useState<import('../../engine/media/recorder').CaptureSession | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<typeof session>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  sessionRef.current = session;

  useEffect(() => {
    if (!session) return;
    const iv = window.setInterval(() => {
      const s = sessionRef.current;
      if (!s) return;
      setElapsed(s.elapsed());
      setLevel(s.level() ?? 0);
    }, 100);
    return () => window.clearInterval(iv);
  }, [session]);

  // Attach live preview once a session and a <video> exist.
  useEffect(() => {
    if (session && videoRef.current) session.attachPreview(videoRef.current);
    else if (!session && videoRef.current) videoRef.current.srcObject = null;
  }, [session]);

  const start = async () => {
    setError(null);
    setBusy(true);
    try {
      const { startCapture } = await import('../../engine/media/recorder');
      const s = await startCapture(kind);
      setSession(s);
      setBusy(false);
    } catch (e: any) {
      setBusy(false);
      if (String(e?.name) === 'NotAllowedError') setError('Permission denied. Allow capture in the browser prompt and try again.');
      else setError(e?.message ?? String(e));
    }
  };

  const stop = async (add: boolean) => {
    const s = sessionRef.current;
    if (!s) return close();
    setBusy(true);
    const result = await s.stop();
    setSession(null);
    if (add) {
      const { importCapture } = await import('../../engine/media/recorder');
      const stamp = new Date();
      const name = kind === 'screen' ? `Screen Recording ${stamp.getHours()}.${stamp.getMinutes()}` : `Webcam ${stamp.getHours()}.${stamp.getMinutes()}`;
      await importCapture(result, name);
      toast('success', 'Capture complete', `${result.durationSec.toFixed(1)} s added to the Project panel. Drag it to the timeline.`);
    }
    setBusy(false);
    close();
  };

  const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

  return (
    <Modal title={kind === 'screen' ? 'Record Screen' : 'Record Webcam'} icon={kind === 'screen' ? 'monitor' : 'camera'} onClose={() => (session ? void stop(true) : close())} width={560} footer={
      <>
        <span className="dim" style={{ fontSize: 11 }}>{kind === 'screen' ? 'Pick a screen, window or tab in the browser dialog. Audio is optional.' : 'Records camera and mic.'}</span>
        <span className="spacer" />
        {session ? (
          <>
            <Button onClick={() => void stop(false)} disabled={busy}>Discard</Button>
            <Button primary onClick={() => void stop(true)} disabled={busy}>Stop &amp; Import</Button>
          </>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button primary onClick={() => void start()} disabled={busy}>{busy ? 'Waiting for permission...' : kind === 'screen' ? 'Choose what to capture' : 'Start Recording'}</Button>
          </>
        )}
      </>
    }>
      {error ? <div className="empty" style={{ color: 'var(--c-danger)', marginBottom: 10 }}>{error}</div> : null}
      <div className="cap-stage">
        {session ? (
          <>
            <video ref={videoRef} className="cap-preview" playsInline muted />
            <div className="cap-live">
              <span className="rec-dot" /> REC {fmt(elapsed)}
              <span className="lvl">{level > 0.005 ? 'audio in' : 'no audio'}</span>
            </div>
          </>
        ) : (
          <div className="dim" style={{ textAlign: 'center', padding: '36px 12px' }}>
            {kind === 'screen' ? 'The browser will ask what to share once you press the button below.' : 'Grant camera access, then press Start Recording.'}
          </div>
        )}
      </div>
      <div className="dim" style={{ fontSize: 11, marginTop: 8 }}>
        Capture runs at up to 30 fps and is saved as WebM in the Project panel. Stop from here or from the browser's own "Stop sharing" bar - both finish the recording safely.
      </div>
    </Modal>
  );
}

/* ---------- Beat detection ---------- */
function BeatDetectModal({ close }: P) {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const sel = useUI((s) => s.selection.clipIds);
  const [sensitivity, setSensitivity] = useState(0.5);
  const [bpmMin, setBpmMin] = useState(70);
  const [result, setResult] = useState<import('../../engine/audio/beats').BeatResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [source, setSource] = useState<{ label: string; buffer: AudioBuffer; clip: Clip | null } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Resolve the analysis source: the selected clip with audio, else the first one found.
  useEffect(() => {
    if (!seq) return;
    const selClip = seq.clips.find((c) => c.id === sel[0]);
    const candidates = [selClip, ...seq.clips.filter((c) => c.id !== selClip?.id)].filter(Boolean) as Clip[];
    const clip = candidates.find((c) => getMedia(c.assetId)?.audio) ?? null;
    if (!clip) {
      setSource(null);
      setNote('No decoded audio found. Import a music file (or wait for its waveform to appear) and try again.');
      return;
    }
    setNote(null);
    const buffer = getMedia(clip.assetId)!.audio!;
    setSource({ label: clip.name, buffer, clip });
  }, [seq, sel[0], project]);

  // Re-analyze when knobs move (fast: ~50ms for a 3-minute track).
  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    setAnalyzing(true);
    const t = window.setTimeout(async () => {
      const { detectBeats } = await import('../../engine/audio/beats');
      const r = detectBeats(source.buffer, { sensitivity, minSpacing: 60 / (bpmMin * 2 + 10) });
      if (!cancelled) {
        setResult(r);
        setAnalyzing(false);
      }
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [source, sensitivity, bpmMin]);

  const addMarkers = () => {
    if (!seq || !result) return;
    const fps = seq.settings.fps;
    useProject.getState().update('Detect beats', (p) => {
      const s = p.sequences.find((x) => x.id === seq.id);
      if (!s || !source?.clip) return;
      const clip = s.clips.find((c) => c.id === source.clip!.id);
      if (!clip) return;
      let n = 0;
      for (const t of result.beats) {
        // Map source time back through the clip's in-point and speed.
        const localSec = (t - clip.inPoint) / Math.max(0.01, clip.speed);
        const frame = Math.round(clip.start + localSec * fps);
        if (frame < clip.start || frame >= E.clipEnd(clip)) continue;
        s.markers.push({ id: uid('mrk'), time: frame, duration: 0, name: `Beat ${++n}`, comment: result.bpm ? `~${result.bpm} BPM` : '', color: 'green', kind: 'beat' });
      }
      s.markers.sort((a, b) => a.time - b.time);
    });
    toast('success', 'Beats marked', `${result.beats.length} markers added${result.bpm ? ` (~${result.bpm} BPM)` : ''}. Timeline snapping now locks to them.`);
    close();
  };

  return (
    <Modal title="Detect Beats" icon="beat" onClose={close} width={520} footer={
      <>
        <span className="dim" style={{ fontSize: 11 }}>{source ? `Analyzing "${source.label}"` : 'No audio'}</span>
        <span className="spacer" />
        <Button onClick={close}>Cancel</Button>
        <Button primary onClick={addMarkers} disabled={!result || !result.beats.length || analyzing}>Add {result?.beats.length ?? 0} Markers</Button>
      </>
    }>
      {note ? <div className="empty">{note}</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="prop-grid">
            <span className="label">Source</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{source?.label}</span>
            <span className="label">Sensitivity</span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Slider value={sensitivity} min={0} max={1} step={0.05} onChange={(v) => setSensitivity(v)} />
              <span className="dim" style={{ fontSize: 11 }}>{sensitivity < 0.3 ? 'Only big hits' : sensitivity > 0.7 ? 'Every nuance' : 'Balanced'}</span>
            </span>
            <span className="label">Density</span>
            <Select value={String(bpmMin)} options={[{ value: '60', label: 'Dense (up to ~130 BPM grid)' }, { value: '70', label: 'Normal' }, { value: '90', label: 'Sparse (strong beats only)' }]} onChange={(v) => setBpmMin(Number(v))} />
          </div>
          <div className="beat-preview">
            {analyzing ? (
              <span className="dim">Analyzing...</span>
            ) : result ? (
              <>
                <span>
                  <strong>{result.beats.length}</strong>&nbsp;beats
                  {result.bpm ? <span> - about <strong>{result.bpm} BPM</strong></span> : null}
                  {result.beats.length ? <span className="dim" style={{ marginLeft: 8 }}>{result.beats[0].toFixed(2)}s ... {result.beats[result.beats.length - 1].toFixed(2)}s</span> : null}
                </span>
                <div className="beat-strip">
                  {result.beats.slice(0, 120).map((t, i) => (
                    <span key={i} style={{ left: `${(t / (result.beats[result.beats.length - 1] || 1)) * 100}%` }} />
                  ))}
                </div>
              </>
            ) : (
              <span className="dim">Waiting for audio...</span>
            )}
          </div>
          <div className="dim" style={{ fontSize: 11 }}>
            Markers land on the selected clip and snapping picks them up automatically - drag cut points and they lock to the beat.
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ---------- Remove Silence ---------- */
function RemoveSilenceModal({ close }: P) {
  const seq = useActiveSequence();
  const sel = useUI((s) => s.selection.clipIds);
  const [sensitivity, setSensitivity] = useState(10);
  const [minSilence, setMinSilence] = useState(0.45);
  const [padding, setPadding] = useState(0.15);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<import('../../engine/audio/silence').SilenceResult | null>(null);
  const [source, setSource] = useState<{ label: string; clipId: string | null } | null>(null);
  const [srcDur, setSrcDur] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!seq) return;
    const clip = pickAudioClip(seq);
    if (!clip) {
      setSource(null);
      setNote('No clip with decoded audio found. Import a clip (or wait for its waveform) and try again.');
      return;
    }
    setNote(null);
    setSource({ label: clip.name, clipId: clip.id });
  }, [seq, sel[0]]);

  useEffect(() => {
    if (!seq || !source?.clipId) return;
    const clip = seq.clips.find((c) => c.id === source.clipId);
    const buffer = clip ? getMedia(clip.assetId)?.audio : undefined;
    if (!buffer) return;
    setSrcDur(buffer.duration);
    let cancelled = false;
    setAnalyzing(true);
    const t = window.setTimeout(async () => {
      const { detectSilence } = await import('../../engine/audio/silence');
      const r = detectSilence(buffer, { sensitivity, minSilence, padding });
      if (!cancelled) {
        setResult(r);
        setAnalyzing(false);
      }
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [seq, source?.clipId, sensitivity, minSilence, padding]);

  const removable = result ? result.silences.reduce((a, [s0, e0]) => a + (e0 - s0), 0) : 0;

  const apply = () => {
    cmd.removeSilence({ sensitivity, minSilence, padding }, result, source?.clipId ?? null);
    close();
  };

  return (
    <Modal title="Remove Silence" icon="wave" onClose={close} width={540} footer={
      <>
        <span className="dim" style={{ fontSize: 11 }}>{source ? `Editing "${source.label}"` : 'No audio'}</span>
        <span className="spacer" />
        <Button onClick={close}>Cancel</Button>
        <Button primary onClick={apply} disabled={!result || !result.silences.length || analyzing}>Remove {result?.silences.length ?? 0} Silences</Button>
      </>
    }>
      {note ? <div className="empty">{note}</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="prop-grid">
            <span className="label">Source</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{source?.label}</span>
            <span className="label">Sensitivity</span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Slider value={sensitivity} min={3} max={30} step={1} onChange={(v) => setSensitivity(v)} />
              <span className="dim" style={{ fontSize: 11 }}>+{sensitivity} dB over noise floor</span>
            </span>
            <span className="label">Min silence</span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Slider value={minSilence} min={0.2} max={2} step={0.05} onChange={(v) => setMinSilence(v)} />
              <span className="dim" style={{ fontSize: 11 }}>{minSilence.toFixed(2)}s</span>
            </span>
            <span className="label">Padding</span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Slider value={padding} min={0} max={0.4} step={0.01} onChange={(v) => setPadding(v)} />
              <span className="dim" style={{ fontSize: 11 }}>{padding.toFixed(2)}s kept around speech</span>
            </span>
          </div>
          <div className="beat-preview">
            {analyzing ? (
              <span className="dim">Analyzing...</span>
            ) : result ? (
              <>
                <span>
                  <strong>{result.silences.length}</strong>&nbsp;silences
                  {result.silences.length ? <span> - about <strong>{removable.toFixed(1)}s</strong> removable <span className="dim">(threshold {result.thresholdDb.toFixed(0)} dBFS)</span></span> : null}
                </span>
                <div className="beat-strip">
                  {result.silences.slice(0, 120).map(([s0, e0], i) => (
                    <span key={i} style={{ left: `${(s0 / (srcDur || 1)) * 100}%`, width: `${Math.max(0.5, ((e0 - s0) / (srcDur || 1)) * 100)}%` }} />
                  ))}
                </div>
              </>
            ) : (
              <span className="dim">Waiting for audio...</span>
            )}
          </div>
          <div className="dim" style={{ fontSize: 11 }}>
            Cuts the silent spans out of the clip and ripples the gaps closed. Linked audio and video are cut together. One undo step.
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ---------- Ken Burns (Pan & Zoom) ---------- */
function KenBurnsModal({ close }: P) {
  const [preset, setPreset] = useState<'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'auto'>('auto');
  const [strength, setStrength] = useState(5);
  const apply = () => {
    cmd.kenBurns(preset, strength);
    close();
  };
  const desc: Record<typeof preset, string> = {
    zoomIn: 'Starts wide, pushes in over the clip',
    zoomOut: 'Starts tight, eases out over the clip',
    panLeft: 'Drifts the framing left',
    panRight: 'Drifts the framing right',
    auto: 'A different move per clip - great over a batch of photos',
  };
  return (
    <Modal title="Pan & Zoom" icon="keyframe" onClose={close} width={480} footer={
      <>
        <span className="dim" style={{ fontSize: 11 }}>Applies to the selection (or all video clips)</span>
        <span className="spacer" />
        <Button onClick={close}>Cancel</Button>
        <Button primary onClick={apply}>Apply</Button>
      </>
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="prop-grid">
          <span className="label">Move</span>
          <Select value={preset} options={[
            { value: 'auto', label: 'Auto (varied per clip)' },
            { value: 'zoomIn', label: 'Zoom In' },
            { value: 'zoomOut', label: 'Zoom Out' },
            { value: 'panLeft', label: 'Pan Left' },
            { value: 'panRight', label: 'Pan Right' },
          ]} onChange={(v) => setPreset(v as any)} />
          <span className="label">Strength</span>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Slider value={strength} min={1} max={10} step={1} onChange={(v) => setStrength(v)} />
            <span className="dim" style={{ fontSize: 11 }}>{preset === 'panLeft' || preset === 'panRight' ? `${(strength * 0.8).toFixed(1)}% drift` : `${(strength * 1.8).toFixed(1)}% zoom`}</span>
          </span>
        </div>
        <div className="beat-preview"><span className="dim">{desc[preset]}</span></div>
        <div className="dim" style={{ fontSize: 11 }}>
          Writes scale / position keyframes with an ease - open Effect Controls to fine-tune. Existing motion keyframes on those two params are replaced.
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Auto Reframe ---------- */
function AutoReframeModal({ close }: P) {
  const [target, setTarget] = useState<'9:16' | '1:1' | '4:5' | '16:9'>('9:16');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      await cmd.autoReframe(target, (label, done, total) => setProgress(`${label} (${Math.round((done / Math.max(1, total)) * 100)}%)`));
    } finally {
      setBusy(false);
      setProgress(null);
    }
    close();
  };
  return (
    <Modal title="Auto Reframe" icon="film" onClose={close} width={480} footer={
      <>
        <span className="dim" style={{ fontSize: 11 }}>{progress ?? 'Creates a reframed copy - original stays untouched'}</span>
        <span className="spacer" />
        <Button onClick={close} disabled={busy}>Cancel</Button>
        <Button primary onClick={run} disabled={busy}>{busy ? 'Analyzing...' : 'Reframe'}</Button>
      </>
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="prop-grid">
          <span className="label">Aspect ratio</span>
          <Select value={target} options={[
            { value: '9:16', label: '9:16 Vertical (Shorts / TikTok / Reels)' },
            { value: '1:1', label: '1:1 Square' },
            { value: '4:5', label: '4:5 Portrait (Instagram feed)' },
            { value: '16:9', label: '16:9 Horizontal (YouTube)' },
          ]} onChange={(v) => setTarget(v as any)} />
        </div>
        <div className="beat-preview"><span className="dim">Each clip is scaled to fill the new frame and keyframed to follow where the action is; static scenes stay centered.</span></div>
        <div className="dim" style={{ fontSize: 11 }}>
          Analysis renders each clip at low resolution every half second - a minute-long sequence takes a few seconds.
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Warp Stabilizer ---------- */
function StabilizeModal({ close }: P) {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const sel = useUI((s) => s.selection.clipIds);
  const playhead = usePlayback((s) => s.playhead);
  const [method, setMethod] = useState<'smooth' | 'lock'>('smooth');
  const [smoothSec, setSmoothSec] = useState(0.5);
  const [zoomLimit, setZoomLimit] = useState(120);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [analysis, setAnalysis] = useState<import('../../engine/stabilize/stabilizer').StabilizeAnalysis | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const clip = useMemo(() => {
    if (!seq) return null;
    const isVideo = (c: Clip) => seq.tracks.find((t) => t.id === c.trackId)?.kind === 'video';
    const selClip = seq.clips.find((c) => c.id === sel[0] && isVideo(c));
    if (selClip) return selClip;
    return seq.clips.find((c) => isVideo(c) && playhead >= c.start && playhead < E.clipEnd(c)) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, sel[0]]);

  // Analyse once per clip (the maths is replayed instantly when knobs move).
  useEffect(() => {
    if (!seq || !clip) return;
    let cancelled = false;
    setBusy(true);
    setAnalysis(null);
    setNote(null);
    setProgress(null);
    (async () => {
      try {
        const { analyzeStabilization } = await import('../../engine/stabilize/stabilizer');
        const a = await analyzeStabilization(project, seq, clip, { sampleFps: 12 }, (done, total) => {
          if (!cancelled) setProgress({ done, total });
        });
        if (cancelled) return;
        if (!a || a.samples.length < 3) setNote('Could not analyse this clip - it may be too short or undecodable.');
        else if (a.texture < 0.01) setNote('Very flat footage - not enough detail to track motion reliably.');
        setAnalysis(a);
      } catch (e: any) {
        if (!cancelled) setNote(`Analysis failed: ${String(e?.message ?? e)}`);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id]);

  const apply = async () => {
    if (!clip || !analysis) return;
    await cmd.applyStabilization(clip.id, analysis, { lock: method === 'lock', smoothSec, zoomLimit: zoomLimit / 100 });
    close();
  };

  const shaky = analysis ? Math.round(analysis.maxShift * 100) : 0;

  return (
    <Modal title="Stabilize Clip" icon="motion" onClose={close} width={540} footer={
      <>
        <span className="dim" style={{ fontSize: 11 }}>
          {busy && progress ? `Analyzing motion ${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` : clip ? `"${clip.name}"` : 'No clip'}
        </span>
        <span className="spacer" />
        <Button onClick={close} disabled={busy}>Cancel</Button>
        <Button primary onClick={() => void apply()} disabled={busy || !analysis || !!note}>Stabilize</Button>
      </>
    }>
      {!clip ? (
        <div className="empty">Select a video clip on the timeline (or park the playhead over one) and reopen this dialog.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="prop-grid">
            <span className="label">Method</span>
            <Segmented value={method} options={[{ value: 'smooth', label: 'Smooth motion' }, { value: 'lock', label: 'No motion (tripod)' }]} onChange={(v) => setMethod(v)} />
            {method === 'smooth' ? (
              <>
                <span className="label">Smoothness</span>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Slider value={smoothSec} min={0.15} max={2} step={0.05} onChange={(v) => setSmoothSec(v)} />
                  <span className="dim" style={{ fontSize: 11 }}>{smoothSec.toFixed(2)}s camera glide</span>
                </span>
              </>
            ) : null}
            <span className="label">Max crop zoom</span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Slider value={zoomLimit} min={102} max={140} step={1} onChange={(v) => setZoomLimit(v)} />
              <span className="dim" style={{ fontSize: 11 }}>{zoomLimit}%</span>
            </span>
          </div>
          <div className="beat-preview">
            {busy ? (
              <span className="dim">Rendering an analysis pass at low resolution...</span>
            ) : note ? (
              <span style={{ color: 'var(--c-warn)' }}>{note}</span>
            ) : analysis ? (
              <span>
                Detected shake: up to <strong>{shaky}%</strong> of the frame across <strong>{analysis.samples.length}</strong> samples.
                {analysis.maxShift < 0.004 ? <span className="dim"> The clip already looks steady - stabilizing will change very little.</span> : null}
              </span>
            ) : (
              <span className="dim">Waiting...</span>
            )}
          </div>
          <div className="dim" style={{ fontSize: 11 }}>
            Writes counteracting position keyframes on the clip and zooms just enough to hide the edges{clip?.motion.position.animated ? ' - existing position keyframes are replaced' : ''}. Effects on the clip are ignored during analysis. Undo restores everything.
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ---------- Green Screen (Chroma Key) ---------- */
/* Common backdrop colors for one-click keying. */
const KEY_PRESETS: { label: string; hex: string }[] = [
  { label: 'Green screen', hex: '#00cc33' },
  { label: 'Blue screen', hex: '#0033cc' },
  { label: 'Red', hex: '#cc2222' },
  { label: 'Magenta', hex: '#cc22cc' },
  { label: 'Cyan', hex: '#22cccc' },
  { label: 'Yellow', hex: '#cccc22' },
  { label: 'White', hex: '#f2f2f2' },
  { label: 'Black', hex: '#0d0d0d' },
];

function GreenScreenModal({ close }: P) {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const sel = useUI((s) => s.selection.clipIds);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const srcRef = useRef<ImageData | null>(null);
  const didAuto = useRef(false);
  const [color, setColor] = useState<[number, number, number]>([0.1, 0.9, 0.2]);
  const [tolerance, setTolerance] = useState(40);
  const [softness, setSoftness] = useState(12);
  const [spill, setSpill] = useState(55);
  const [view, setView] = useState<'source' | 'result' | 'matte'>('result');
  const [note, setNote] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<number | null>(null);
  const [frameStamp, setFrameStamp] = useState(0);
  const [hexDraft, setHexDraft] = useState<string | null>(null);

  const clip = useMemo(() => {
    if (!seq) return null;
    const isVideo = (c: Clip) => seq.tracks.find((t) => t.id === c.trackId)?.kind === 'video';
    const selClip = seq.clips.find((c) => c.id === sel[0] && isVideo(c));
    if (selClip) return selClip;
    const ph = usePlayback.getState().playhead;
    return seq.clips.find((c) => isVideo(c) && ph >= c.start && ph < E.clipEnd(c)) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, sel[0]]);

  const drawPreview = () => {
    const cv = canvasRef.current;
    const src = srcRef.current;
    if (!cv || !src) return;
    if (cv.width !== src.width || cv.height !== src.height) {
      cv.width = src.width;
      cv.height = src.height;
    }
    const ctx = cv.getContext('2d')!;
    if (view === 'source') ctx.putImageData(src, 0, 0);
    else ctx.putImageData(renderKeyPreview(src, { color, tolerance, softness, pedestal: 0, spill, mode: view }), 0, 0);
  };

  // Grab the frame under the playhead (solo render) whenever the clip or the
  // "recapture" stamp changes, then auto-detect the screen color once.
  useEffect(() => {
    if (!seq || !clip) return;
    let cancelled = false;
    (async () => {
      const ph = usePlayback.getState().playhead;
      const frame = Math.max(clip.start, Math.min(E.clipEnd(clip) - 1, ph));
      const off = document.createElement('canvas');
      try {
        await renderFrameToCanvas(project, seq, frame, off, { scale: 4, soloClipId: clip.id, captions: false });
        srcRef.current = off.getContext('2d')!.getImageData(0, 0, off.width, off.height);
        setNote(null);
      } catch {
        srcRef.current = null;
        if (!cancelled) setNote('Could not render a frame from this clip.');
      }
      if (!cancelled) {
        if (!didAuto.current && srcRef.current) {
          didAuto.current = true;
          autoDetect();
        }
        drawPreview();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id, frameStamp]);

  useEffect(drawPreview, [view, color, tolerance, softness, spill]);

  const autoDetect = () => {
    const src = srcRef.current;
    if (!src) return;
    const s = suggestKeyColor(src.data, src.width, src.height);
    if (!s) {
      setCoverage(null);
      setNote('No obvious screen color in this frame - click the preview to sample it manually.');
      return;
    }
    setColor(s.color);
    setTolerance(s.tolerance);
    setSoftness(s.softness);
    setSpill(s.spill);
    setCoverage(s.coverage);
    setHexDraft(null);
    setNote(null);
  };

  const pickColor = (e: React.MouseEvent) => {
    const cv = canvasRef.current;
    const src = srcRef.current;
    if (!cv || !src) return;
    const r = cv.getBoundingClientRect();
    const x = Math.max(0, Math.min(src.width - 1, Math.floor(((e.clientX - r.left) / r.width) * src.width)));
    const y = Math.max(0, Math.min(src.height - 1, Math.floor(((e.clientY - r.top) / r.height) * src.height)));
    const p = (y * src.width + x) * 4;
    setColor([src.data[p] / 255, src.data[p + 1] / 255, src.data[p + 2] / 255]);
    setHexDraft(null);
  };

  const commitHexDraft = () => {
    const raw = hexDraft?.trim();
    if (raw) {
      const h = raw.replace(/^#?/, '#');
      if (/^#[0-9a-fA-F]{6}$/.test(h)) setColor(hexToRgb(h));
      else setNote(`"${raw}" is not a valid hex color - try something like #22cc44.`);
    }
    setHexDraft(null);
  };

  const apply = () => {
    if (!clip) return;
    cmd.applyGreenScreenKey(clip.id, { color, tolerance, softness, spill });
    close();
  };

  const hex = rgbToHex(color[0], color[1], color[2]);

  return (
    <Modal title="Green Screen Key (Chroma)" icon="eyedropper" onClose={close} width={760} footer={
      <>
        <span className="dim" style={{ fontSize: 11 }}>{clip ? `"${clip.name}" - Ultra Key` : 'No clip'}</span>
        <span className="spacer" />
        <Button onClick={close}>Cancel</Button>
        <Button primary onClick={apply} disabled={!clip || !srcRef.current}>Apply Key</Button>
      </>
    }>
      {!clip ? (
        <div className="empty">Select a video clip on the timeline (or park the playhead over one) and reopen this dialog.</div>
      ) : (
        <div style={{ display: 'flex', gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <Segmented value={view} options={[{ value: 'source', label: 'Source' }, { value: 'result', label: 'Result' }, { value: 'matte', label: 'Matte' }]} onChange={(v) => setView(v)} />
              <span className="spacer" />
              <Button sm icon="refresh" onClick={() => setFrameStamp((n) => n + 1)} title="Re-render the preview frame from the current playhead">Recapture frame</Button>
            </div>
            <div style={{ background: '#0a0a0a', border: '1px solid var(--c-line-strong)', display: 'grid', placeItems: 'center' }}>
              <canvas ref={canvasRef} onClick={pickColor} style={{ maxWidth: '100%', cursor: 'crosshair', display: 'block' }} title="Click to sample the screen color" />
            </div>
            <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
              Choose the key color any way you like: click the frame to sample it, use a preset swatch, type a hex value, or open the system colour picker from the chip. {coverage != null ? `Auto-detect found a screen covering ${Math.round(coverage * 100)}% of the frame border.` : 'Auto-detect scans the frame border for a dominant saturated color.'}
            </div>
          </div>
          <div style={{ width: 250, flexShrink: 0 }}>
            <div className="prop-grid">
              <span className="label">Key color</span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <ColorChip color={hex} title="Open the system colour picker" onChange={(h) => { setColor(hexToRgb(h)); setHexDraft(null); }} />
                <TextField
                  className="tc"
                  style={{ width: 78, fontSize: 11 }}
                  spellCheck={false}
                  value={hexDraft ?? hex}
                  onChange={(e) => setHexDraft(e.target.value)}
                  onBlur={commitHexDraft}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setHexDraft(null); e.currentTarget.blur(); } }}
                />
              </span>
              <span className="label">Presets</span>
              <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {KEY_PRESETS.map((p) => (
                  <button
                    key={p.hex}
                    title={p.label}
                    onClick={() => { setColor(hexToRgb(p.hex)); setHexDraft(null); }}
                    style={{
                      width: 20, height: 20, padding: 0, cursor: 'pointer', borderRadius: 3,
                      background: p.hex,
                      border: hex.toLowerCase() === p.hex.toLowerCase() ? '2px solid var(--c-text)' : '1px solid var(--c-line-strong)',
                    }}
                  />
                ))}
              </span>
              <span className="label">Tolerance</span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Slider value={tolerance} min={0} max={100} step={0.5} onChange={(v) => setTolerance(v)} />
                <span className="dim" style={{ fontSize: 11, width: 26, textAlign: 'right' }}>{tolerance.toFixed(0)}</span>
              </span>
              <span className="label">Softness</span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Slider value={softness} min={0} max={100} step={0.5} onChange={(v) => setSoftness(v)} />
                <span className="dim" style={{ fontSize: 11, width: 26, textAlign: 'right' }}>{softness.toFixed(0)}</span>
              </span>
              <span className="label">Spill</span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Slider value={spill} min={0} max={100} step={0.5} onChange={(v) => setSpill(v)} />
                <span className="dim" style={{ fontSize: 11, width: 26, textAlign: 'right' }}>{spill.toFixed(0)}</span>
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6, margin: '10px 0' }}>
              <Button sm icon="eyedropper" onClick={autoDetect}>Auto-detect screen</Button>
            </div>
            {note ? <div className="dim" style={{ fontSize: 11, color: 'var(--c-warn)', marginBottom: 8 }}>{note}</div> : null}
            <div className="dim" style={{ fontSize: 11, lineHeight: 1.5 }}>
              Applies the <strong>Ultra Key</strong> effect with these values - the live preview uses the same maths as the GPU shader. Put a background clip on a video track below, then fine-tune pedestal, choke and matte cleanup in Effect Controls.
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ---------- Sync by Audio ---------- */
function SyncAudioModal({ close }: P) {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const sel = useUI((s) => s.selection.clipIds);
  const [refId, setRefId] = useState<string | null>(null);
  const [maxLag, setMaxLag] = useState(30);
  const [rows, setRows] = useState<{ id: string; name: string; offsetSec: number; confidence: number; deltaFrames: number; include: boolean; warn?: string }[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const audioClips = useMemo(() => {
    if (!seq) return [] as Clip[];
    return seq.clips.filter((c) => !!getMedia(c.assetId)?.audio && !c.reversed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, project.revision]);

  // Default reference: first selected clip with audio, else the first one.
  useEffect(() => {
    if (!audioClips.length) {
      setRefId(null);
      setNote('No clips with decoded audio on the timeline. Import the recordings (and wait for their waveforms) and try again.');
      return;
    }
    setNote(null);
    setRefId((cur) => (cur && audioClips.some((c) => c.id === cur) ? cur : audioClips.find((c) => sel.includes(c.id))?.id ?? audioClips[0].id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioClips]);

  // Correlate every other clip against the reference (fast: envelopes only).
  useEffect(() => {
    if (!seq || !refId) return;
    const ref = seq.clips.find((c) => c.id === refId);
    const refBuf = ref ? getMedia(ref.assetId)?.audio : undefined;
    if (!ref || !refBuf) return;
    let cancelled = false;
    setAnalyzing(true);
    const t = window.setTimeout(async () => {
      const { findSyncOffset } = await import('../../engine/audio/sync');
      const fps = seq.settings.fps;
      const out: typeof rows = [];
      for (const c of audioClips) {
        if (c.id === refId) continue;
        const buf = getMedia(c.assetId)?.audio;
        if (!buf) continue;
        if (Math.abs(c.speed - ref.speed) > 0.001) {
          out.push({ id: c.id, name: c.name, offsetSec: 0, confidence: 0, deltaFrames: 0, include: false, warn: 'Different speeds - cannot align' });
          continue;
        }
        if (c.assetId === ref.assetId) {
          out.push({ id: c.id, name: c.name, offsetSec: 0, confidence: 1, deltaFrames: ref.start - c.start, include: false, warn: 'Same source as the reference' });
          continue;
        }
        const m = findSyncOffset(refBuf, buf, { maxLagSec: maxLag });
        const delta = ref.start - c.start + ((m.offsetSec + c.inPoint - ref.inPoint) / Math.max(0.01, ref.speed)) * fps;
        out.push({ id: c.id, name: c.name, offsetSec: m.offsetSec, confidence: m.confidence, deltaFrames: Math.round(delta), include: m.confidence >= 0.25 });
      }
      if (!cancelled) {
        setRows(out);
        setAnalyzing(false);
      }
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, refId, maxLag, audioClips]);

  const apply = () => {
    if (!refId) return;
    const targets = rows.filter((r) => r.include && !r.warn).map((r) => ({ clipId: r.id, deltaFrames: r.deltaFrames }));
    cmd.syncByAudio(refId, targets);
    close();
  };

  const included = rows.filter((r) => r.include && !r.warn).length;

  return (
    <Modal title="Sync Clips by Audio" icon="syncLock" onClose={close} width={600} footer={
      <>
        <span className="dim" style={{ fontSize: 11 }}>{analyzing ? 'Correlating waveforms...' : `${included} clip${included === 1 ? '' : 's'} will move`}</span>
        <span className="spacer" />
        <Button onClick={close}>Cancel</Button>
        <Button primary onClick={apply} disabled={analyzing || !included}>Sync {included || ''} Clip{included === 1 ? '' : 's'}</Button>
      </>
    }>
      {note ? <div className="empty">{note}</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="prop-grid">
            <span className="label">Reference clip</span>
            <Select value={refId ?? ''} options={audioClips.map((c) => ({ value: c.id, label: c.name }))} onChange={(v) => setRefId(v)} />
            <span className="label">Search range</span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Slider value={maxLag} min={5} max={120} step={5} onChange={(v) => setMaxLag(v)} />
              <span className="dim" style={{ fontSize: 11 }}>+/- {maxLag}s</span>
            </span>
          </div>
          <div className="scroll-y" style={{ maxHeight: 260, border: '1px solid var(--c-line)', padding: '4px 8px' }}>
            {rows.length === 0 ? (
              <div className="dim" style={{ padding: 8 }}>{analyzing ? 'Analyzing...' : 'No other clips with audio to sync against.'}</div>
            ) : rows.map((r) => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--c-line-faint)' }}>
                <Checkbox checked={r.include} disabled={!!r.warn} onChange={(v) => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, include: v } : x)))} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                {r.warn ? (
                  <span className="dim" style={{ fontSize: 11, color: 'var(--c-warn)' }}>{r.warn}</span>
                ) : (
                  <>
                    <span className="dim tc" style={{ fontSize: 11, width: 90, textAlign: 'right' }}>
                      {r.deltaFrames === 0 ? 'already aligned' : `move ${r.deltaFrames > 0 ? 'right' : 'left'} ${Math.abs(r.deltaFrames)} fr`}
                    </span>
                    <span className="dim tc" style={{ fontSize: 11, width: 84, textAlign: 'right' }}>
                      offset {r.offsetSec >= 0 ? '+' : ''}{r.offsetSec.toFixed(2)}s
                    </span>
                    <span style={{ fontSize: 11, width: 76, textAlign: 'right', color: r.confidence >= 0.5 ? 'var(--c-ok)' : r.confidence >= 0.25 ? 'var(--c-text-dim)' : 'var(--c-warn)' }}>
                      {Math.round(r.confidence * 100)}% match
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="dim" style={{ fontSize: 11 }}>
            Loudness envelopes are cross-correlated to find where each recording lines up with the reference. Checked clips (and anything linked to them) move on the timeline; clips that would land before frame 0 are trimmed instead. Low match percentages mean the recordings may not share audio.
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ---------- Split Screen / PIP ---------- */
function SplitScreenModal({ close }: P) {
  const seq = useActiveSequence();
  const sel = useUI((s) => s.selection.clipIds);
  const [layout, setLayout] = useState<'sideBySide' | 'stacked' | 'grid' | 'pip'>('sideBySide');
  const [gap, setGap] = useState(2);
  const [mode, setMode] = useState<'fit' | 'fill'>('fit');

  const clips = useMemo(() => {
    if (!seq) return [] as Clip[];
    return seq.clips.filter((c) => sel.includes(c.id) && seq.tracks.find((t) => t.id === c.trackId)?.kind === 'video').sort((a, b) => a.start - b.start).slice(0, 4);
  }, [seq, sel]);

  const n = clips.length;
  const cells = n >= 2 ? splitScreenCells(layout, n, gap) : [];
  const aspect = seq ? seq.settings.width / seq.settings.height : 16 / 9;

  const apply = () => {
    cmd.splitScreen(layout, gap, mode);
    close();
  };

  return (
    <Modal title="Split Screen / Picture-in-Picture" icon="layout" onClose={close} width={560} footer={
      <>
        <span className="dim" style={{ fontSize: 11 }}>{n >= 2 ? `${n} clips selected` : 'Select 2 to 4 video clips'}</span>
        <span className="spacer" />
        <Button onClick={close}>Cancel</Button>
        <Button primary onClick={apply} disabled={n < 2}>Apply Layout</Button>
      </>
    }>
      <div style={{ display: 'flex', gap: 14 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="prop-grid">
            <span className="label">Layout</span>
            <Select value={layout} options={[
              { value: 'sideBySide', label: 'Side by side (columns)' },
              { value: 'stacked', label: 'Stacked (rows)' },
              { value: 'grid', label: '2 x 2 grid' },
              { value: 'pip', label: 'Picture-in-picture (corners)' },
            ]} onChange={(v) => setLayout(v)} />
            <span className="label">Gap</span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Slider value={gap} min={0} max={8} step={0.5} onChange={(v) => setGap(v)} />
              <span className="dim" style={{ fontSize: 11 }}>{gap.toFixed(1)}%</span>
            </span>
            <span className="label">Scale clips to</span>
            <Segmented value={mode} options={[{ value: 'fit', label: 'Fit cell' }, { value: 'fill', label: 'Fill cell (overlap)' }]} onChange={(v) => setMode(v)} />
          </div>
          <div className="scroll-y" style={{ maxHeight: 120, border: '1px solid var(--c-line)', padding: '4px 8px' }}>
            {n === 0 ? <div className="dim" style={{ padding: 6 }}>No video clips selected.</div> : clips.map((c, i) => (
              <div key={c.id} className="dim" style={{ padding: '3px 0', fontSize: 11, display: 'flex', gap: 6 }}>
                <span style={{ color: 'var(--c-accent-text)' }}>{i + 1}.</span> {c.name}
              </div>
            ))}
          </div>
          <div className="dim" style={{ fontSize: 11 }}>
            All clips align to the earliest start, each gets its own video track, and scale/position are written for the cell. PIP keeps clip 1 full-frame with the others on top. One undo step.
          </div>
        </div>
        <div style={{ width: 220, flexShrink: 0 }}>
          <div style={{ position: 'relative', width: '100%', aspectRatio: String(aspect), background: '#0a0a0a', border: '1px solid var(--c-line-strong)' }}>
            {cells.map((cell, i) => (
              <div key={i} style={{
                position: 'absolute',
                left: `${cell.x * 100}%`,
                top: `${cell.y * 100}%`,
                width: `${cell.w * 100}%`,
                height: `${cell.h * 100}%`,
                background: `color-mix(in srgb, var(--c-accent) ${80 - i * 15}%, #1b1b1b)`,
                border: '1px solid rgba(255,255,255,0.25)',
                display: 'grid',
                placeItems: 'center',
                fontSize: 11,
                color: '#fff',
              }}>{i + 1}</div>
            ))}
            {n < 2 ? <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }} className="dim">select clips</div> : null}
          </div>
          <div className="dim" style={{ fontSize: 10, marginTop: 4, textAlign: 'center' }}>preview</div>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Auto Montage ---------- */
function AutoMontageModal({ close }: P) {
  const project = useProject((s) => s.project);
  const [musicId, setMusicId] = useState<string>('');
  const [visualIds, setVisualIds] = useState<string[] | null>(null);
  const [aspect, setAspect] = useState<string>('16:9');
  const [density, setDensity] = useState(2);
  const [motion, setMotion] = useState(true);
  const [maxSeconds, setMaxSeconds] = useState(60);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const musicOptions = project.assets.filter((a) => (a.kind === 'audio' || (a.kind === 'video' && a.hasAudio)) && !a.offline);
  const visualOptions = project.assets.filter((a) => (a.kind === 'video' || a.kind === 'image') && !a.offline);
  const music = musicOptions.find((a) => a.id === musicId);
  const musicReady = musicId ? !!getMedia(musicId)?.audio : false;
  const chosenVisuals = visualIds ?? visualOptions.map((a) => a.id);
  const fps = project.settings.defaultSequence.fps;

  useEffect(() => {
    if (!musicId && musicOptions.length) setMusicId(musicOptions[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [musicOptions.length]);

  const run = async () => {
    if (!musicId || !chosenVisuals.length) return;
    setBusy(true);
    try {
      await cmd.autoMontage({ musicAssetId: musicId, visualAssetIds: chosenVisuals, aspect, density, motion, maxSeconds, fps }, setProgress);
      close();
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const toggleVisual = (id: string) => setVisualIds((cur) => {
    const list = cur ?? visualOptions.map((a) => a.id);
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  });

  return (
    <Modal title="Auto Montage (Cut to Music)" icon="sparkle" onClose={close} width={620} footer={
      <>
        <span className="dim" style={{ fontSize: 11 }}>{progress ?? (music && !musicReady ? 'Waiting for the music track to decode...' : 'Builds a NEW sequence - nothing is touched') }</span>
        <span className="spacer" />
        <Button onClick={close} disabled={busy}>Cancel</Button>
        <Button primary onClick={() => void run()} disabled={busy || !musicId || !chosenVisuals.length}>{busy ? 'Building...' : 'Build Montage'}</Button>
      </>
    }>
      <div style={{ display: 'flex', gap: 14 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="prop-grid">
            <span className="label">Music</span>
            <Select value={musicId} options={musicOptions.map((a) => ({ value: a.id, label: `${a.name}${a.duration ? ` (${Math.round(a.duration)}s)` : ''}` }))} onChange={(v) => setMusicId(v)} />
            <span className="label">Cut on</span>
            <Select value={String(density)} options={[{ value: '1', label: 'Every beat' }, { value: '2', label: 'Every 2nd beat' }, { value: '4', label: 'Every 4th beat (bar)' }]} onChange={(v) => setDensity(Number(v))} />
            <span className="label">Aspect</span>
            <Select value={aspect} options={Object.entries(MONTAGE_ASPECTS).map(([k, v]) => ({ value: k, label: v.label }))} onChange={(v) => setAspect(v)} />
            <span className="label">Max length</span>
            <HotText value={maxSeconds} min={5} max={600} step={5} unit=" s" width={70} onChange={(v, c) => c && setMaxSeconds(v)} />
            <span className="label">Motion</span>
            <Checkbox checked={motion} onChange={setMotion} label="Ken Burns zoom on every shot" />
          </div>
          <div className="dim" style={{ fontSize: 11 }}>
            Beats are detected on the music, then your photos and clips are cut to the grid (cycling when there are fewer visuals than cuts), scaled to fill, and given gentle moves. Beat markers land on the new sequence so snapping and Cut to Beats keep working.
          </div>
        </div>
        <div style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="dim" style={{ fontSize: 11, flex: 1 }}>Visuals ({chosenVisuals.length})</span>
            <Button sm onClick={() => setVisualIds(visualOptions.map((a) => a.id))}>All</Button>
            <Button sm onClick={() => setVisualIds([])}>None</Button>
          </div>
          <div className="scroll-y" style={{ flex: 1, maxHeight: 220, border: '1px solid var(--c-line)', padding: '4px 6px' }}>
            {visualOptions.length === 0 ? <div className="dim" style={{ padding: 6 }}>Import some photos or clips first.</div> : visualOptions.map((a) => (
              <div key={a.id} style={{ padding: '2px 0' }}>
                <Checkbox checked={chosenVisuals.includes(a.id)} onChange={() => toggleVisual(a.id)} label={<span style={{ fontSize: 11 }}>{a.name}</span>} />
              </div>
            ))}
          </div>
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
  const [skip, setSkip] = useState(() => !useSettings.getState().showWelcomeOnStartup);
  useEffect(() => {
    autosaveInfo().then(setAuto);
  }, []);
  useEffect(() => {
    // The checkbox writes the Workspace > Welcome setting.
    useSettings.getState().set('showWelcomeOnStartup', !skip);
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
