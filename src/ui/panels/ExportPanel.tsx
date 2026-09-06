import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useProject, useActiveSequence, sequenceDuration } from '../../state/projectStore';
import { useUI, toast, logEvent } from '../../state/uiStore';
import { usePlayback, renderFrameToCanvas } from '../../engine/playback/playback';
import { Button, Select, Checkbox, HotText, TextField, TimecodeField, Empty, Segmented } from '../controls';
import { Icon } from '../icons';
import { defaultExportSettings, exportSequence, exportRange, probeEncoders, ExportCancelled, type ExportSettings, type ExportProgress, type ExportContainer } from '../../engine/export/exporter';
import { download, formatBytes, formatDurationShort } from '../../engine/util';
import { framesToTimecode } from '../../engine/timecode';
import type { Sequence } from '../../types/project';

type Preset = { id: string; name: string; apply: (s: ExportSettings, seq: Sequence) => Partial<ExportSettings> };
const PRESETS: Preset[] = [
  { id: 'match', name: 'Match Source - High bitrate', apply: (_s, seq) => ({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: seq.settings.width, height: seq.settings.height, fps: seq.settings.fps, quality: 'high', videoBitrate: Math.round((seq.settings.width * seq.settings.height * seq.settings.fps * 0.12) / 1000) }) },
  { id: 'yt1080', name: 'YouTube 1080p', apply: () => ({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 1920, height: 1080, quality: 'high', videoBitrate: 12000, audioBitrate: 320, keyframeInterval: 2 }) },
  { id: 'yt4k', name: 'YouTube 2160p (4K)', apply: () => ({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 3840, height: 2160, quality: 'veryHigh', videoBitrate: 45000, audioBitrate: 320 }) },
  { id: 'vertical', name: 'Vertical 1080x1920 (Shorts / Reels)', apply: () => ({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 1080, height: 1920, quality: 'high', videoBitrate: 10000, scaleMode: 'fill' }) },
  { id: 'square', name: 'Square 1080x1080', apply: () => ({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 1080, height: 1080, quality: 'high', videoBitrate: 8000, scaleMode: 'fill' }) },
  { id: 'webm', name: 'WebM VP9 (web)', apply: () => ({ container: 'webm', videoCodec: 'vp9', audioCodec: 'opus', quality: 'high' }) },
  { id: 'proxy', name: 'Proxy 720p low bitrate', apply: () => ({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 1280, height: 720, quality: 'low', videoBitrate: 2500, audioBitrate: 128 }) },
  { id: 'gif', name: 'Animated GIF (max 720 px)', apply: () => ({ container: 'gif', width: 720, height: 405, fps: 15, includeAudio: false }) },
  { id: 'wav', name: 'Audio only - WAV 48 kHz', apply: () => ({ container: 'wav', includeVideo: false, includeAudio: true }) },
  { id: 'png', name: 'PNG image sequence', apply: () => ({ container: 'png', includeAudio: false }) },
];

const CONTAINERS: { value: ExportContainer; label: string; group: string }[] = [
  { value: 'mp4', label: 'H.264 / HEVC / AV1 (.mp4)', group: 'Video' },
  { value: 'mov', label: 'QuickTime (.mov)', group: 'Video' },
  { value: 'webm', label: 'VP9 / VP8 / AV1 (.webm)', group: 'Video' },
  { value: 'mkv', label: 'Matroska (.mkv)', group: 'Video' },
  { value: 'gif', label: 'Animated GIF (.gif)', group: 'Image' },
  { value: 'png', label: 'PNG sequence (.zip)', group: 'Image' },
  { value: 'jpeg', label: 'JPEG sequence (.zip)', group: 'Image' },
  { value: 'webp', label: 'WebP sequence (.zip)', group: 'Image' },
  { value: 'wav', label: 'Waveform audio (.wav)', group: 'Audio' },
];

const isVideoContainer = (c: ExportContainer) => c === 'mp4' || c === 'mov' || c === 'webm' || c === 'mkv';
const isImageSeq = (c: ExportContainer) => c === 'png' || c === 'jpeg' || c === 'webp';

export function ExportPanel({ inModal, onClose }: { inModal?: boolean; onClose?: () => void }) {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const playhead = usePlayback((s) => s.playhead);
  const [settings, setSettings] = useState<ExportSettings | null>(null);
  const [encoders, setEncoders] = useState<Awaited<ReturnType<typeof probeEncoders>> | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<{ blob: Blob; filename: string; frames: number; seconds: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [previewFrame, setPreviewFrame] = useState<number | null>(null);
  const [tab, setTab] = useState<'video' | 'audio' | 'advanced'>('video');
  const [lastSeqId, setLastSeqId] = useState<string | null>(null);

  useEffect(() => {
    if (!seq) return;
    if (!settings || lastSeqId !== seq.id) {
      setSettings(defaultExportSettings(seq, seq.name));
      setLastSeqId(seq.id);
      setResult(null);
    }
  }, [seq?.id]);
  useEffect(() => {
    probeEncoders().then(setEncoders);
  }, []);

  // preview: render the frame at the playhead (or scrubbed frame) letterboxed into the output size
  useEffect(() => {
    const cv = previewRef.current;
    if (!cv || !seq || !settings) return;
    const f = previewFrame ?? playhead;
    let cancelled = false;
    (async () => {
      const tmp = document.createElement('canvas');
      await renderFrameToCanvas(project, seq, f, tmp, { scale: 4, captions: settings.burnCaptions });
      if (cancelled) return;
      const ar = settings.width / settings.height;
      const W = 320,
        H = Math.round(W / ar);
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext('2d')!;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      const sar = tmp.width / tmp.height;
      let dw = W,
        dh = H;
      if (settings.scaleMode === 'fit') {
        if (sar > ar) dh = W / sar;
        else dw = H * sar;
      } else if (settings.scaleMode === 'fill') {
        if (sar > ar) dw = H * sar;
        else dh = W / sar;
      }
      ctx.drawImage(tmp, (W - dw) / 2, (H - dh) / 2, dw, dh);
    })();
    return () => {
      cancelled = true;
    };
  }, [seq, settings?.width, settings?.height, settings?.scaleMode, settings?.burnCaptions, playhead, previewFrame, project.revision]);

  const set = (patch: Partial<ExportSettings>) => setSettings((s) => (s ? { ...s, ...patch } : s));

  const summary = useMemo(() => {
    if (!seq || !settings) return null;
    const [a, b] = exportRange(seq, settings);
    const frames = Math.max(0, b - a);
    const secs = frames / seq.settings.fps;
    const vbits = settings.includeVideo && isVideoContainer(settings.container) ? settings.videoBitrate * 1000 : 0;
    const abits = settings.includeAudio && settings.container !== 'gif' && !isImageSeq(settings.container) ? (settings.container === 'wav' ? settings.sampleRate * 16 * settings.channels : settings.audioBitrate * 1000) : 0;
    const bytes = ((vbits + abits) * secs) / 8;
    return { frames, secs, bytes, range: [a, b] as [number, number] };
  }, [seq, settings]);

  if (!seq) return <Empty title="Export" icon="export">Open a sequence to export it.</Empty>;
  if (!settings) return null;

  const start = async () => {
    setResult(null);
    const ac = new AbortController();
    abortRef.current = ac;
    logEvent('info', `Export started: ${settings.filename}.${settings.container}`);
    try {
      const r = await exportSequence(project, seq, settings, setProgress, ac.signal);
      setResult({ blob: r.blob, filename: r.filename, frames: r.frames, seconds: r.durationSeconds });
      download(r.blob, r.filename);
      toast('success', 'Export complete', `${r.filename} (${formatBytes(r.blob.size)}) in ${formatDurationShort(r.durationSeconds)}`);
      logEvent('info', `Export finished: ${r.filename}`, `${formatBytes(r.blob.size)}, ${r.frames} frames`);
    } catch (e) {
      if (e instanceof ExportCancelled) toast('info', 'Export cancelled');
      else {
        toast('error', 'Export failed', String((e as Error).message ?? e));
        logEvent('error', 'Export failed', String((e as Error).stack ?? e));
      }
    } finally {
      abortRef.current = null;
      setProgress((p) => (p && (p.phase === 'done' || p.phase === 'error') ? null : null));
    }
  };
  const busy = !!abortRef.current;
  const dur = sequenceDuration(seq);
  const codecOptions = (settings.container === 'webm' ? ['vp9', 'vp8', 'av1'] : settings.container === 'mkv' ? ['avc', 'hevc', 'vp9', 'av1'] : ['avc', 'hevc', 'av1']) as ExportSettings['videoCodec'][];
  const codecLabel: Record<string, string> = { avc: 'H.264 (AVC)', hevc: 'H.265 (HEVC)', vp9: 'VP9', vp8: 'VP8', av1: 'AV1' };
  const encoderState = (c: string) => (!encoders ? '' : encoders.video[c] ? '' : encoders.webcodecs ? ' - not available on this device' : ' - software fallback');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="scroll-y" style={{ flex: 1, padding: 12 }}>
        <div className="export-layout">
          <div>
            <div className="prop-grid" style={{ marginBottom: 10 }}>
              <span className="label">File name</span>
              <TextField value={settings.filename} onChange={(e) => set({ filename: e.target.value })} />
              <span className="label">Preset</span>
              <Select value="" options={[{ value: '', label: 'Choose a preset...' }, ...PRESETS.map((p) => ({ value: p.id, label: p.name }))]} onChange={(id) => { const p = PRESETS.find((x) => x.id === id); if (p) set(p.apply(settings, seq)); }} />
              <span className="label">Format</span>
              <Select value={settings.container} options={CONTAINERS} onChange={(v) => {
                const c = v as ExportContainer;
                const patch: Partial<ExportSettings> = { container: c };
                if (c === 'webm') { patch.videoCodec = 'vp9'; patch.audioCodec = 'opus'; }
                if (c === 'mp4' || c === 'mov') { if (!['avc', 'hevc', 'av1'].includes(settings.videoCodec)) patch.videoCodec = 'avc'; patch.audioCodec = 'aac'; }
                if (c === 'gif' || isImageSeq(c)) patch.includeAudio = false;
                if (c === 'wav') { patch.includeVideo = false; patch.includeAudio = true; }
                set(patch);
              }} />
            </div>
            <div className="tabs">
              <button type="button" className={tab === 'video' ? 'on' : ''} onClick={() => setTab('video')} disabled={settings.container === 'wav'}>Video</button>
              <button type="button" className={tab === 'audio' ? 'on' : ''} onClick={() => setTab('audio')} disabled={settings.container === 'gif' || isImageSeq(settings.container)}>Audio</button>
              <button type="button" className={tab === 'advanced' ? 'on' : ''} onClick={() => setTab('advanced')}>Range and Options</button>
            </div>
            <div style={{ padding: '10px 0' }}>
              {tab === 'video' && settings.container !== 'wav' ? (
                <div className="prop-grid">
                  {isVideoContainer(settings.container) ? (
                    <>
                      <span className="label">Codec</span>
                      <Select value={settings.videoCodec} options={codecOptions.map((c) => ({ value: c, label: codecLabel[c] + encoderState(c) }))} onChange={(v) => set({ videoCodec: v as any })} />
                    </>
                  ) : null}
                  <span className="label">Frame size</span>
                  <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <HotText value={settings.width} min={16} max={7680} step={2} width={64} onChange={(v, c) => c && set({ width: Math.round(v / 2) * 2 })} />
                    <span className="label">x</span>
                    <HotText value={settings.height} min={16} max={4320} step={2} width={64} onChange={(v, c) => c && set({ height: Math.round(v / 2) * 2 })} />
                    <Button sm onClick={() => set({ width: seq.settings.width, height: seq.settings.height })}>Match</Button>
                    <Button sm onClick={() => set({ width: Math.round(seq.settings.width / 4) * 2, height: Math.round(seq.settings.height / 4) * 2 })}>Half</Button>
                  </span>
                  <span className="label">Frame rate</span>
                  <Select value={String(settings.fps)} options={[seq.settings.fps, 23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 15, 12].filter((v, i, a) => a.indexOf(v) === i).map((f) => ({ value: String(f), label: f === seq.settings.fps ? `${f} (sequence)` : String(f) }))} onChange={(v) => set({ fps: Number(v) })} />
                  <span className="label">Scaling</span>
                  <Segmented value={settings.scaleMode} options={[{ value: 'fit', label: 'Fit (letterbox)' }, { value: 'fill', label: 'Fill (crop)' }, { value: 'stretch', label: 'Stretch' }]} onChange={(v) => set({ scaleMode: v })} />
                  {isVideoContainer(settings.container) ? (
                    <>
                      <span className="label">Quality</span>
                      <Segmented value={settings.quality} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'veryHigh', label: 'Very high' }, { value: 'custom', label: 'Custom' }]} onChange={(v) => {
                        const px = settings.width * settings.height * settings.fps;
                        const factor = { low: 0.04, medium: 0.07, high: 0.12, veryHigh: 0.2, custom: 0 }[v as string] ?? 0;
                        set({ quality: v as any, ...(factor ? { videoBitrate: Math.round((px * factor) / 1000) } : {}) });
                      }} />
                      <span className="label">Bitrate</span>
                      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <HotText value={settings.videoBitrate / 1000} min={0.1} max={400} step={0.5} decimals={1} unit=" Mbps" width={84} onChange={(v, c) => c && set({ videoBitrate: Math.round(v * 1000), quality: 'custom' })} />
                        <Segmented value={settings.bitrateMode} options={[{ value: 'vbr', label: 'VBR' }, { value: 'cbr', label: 'CBR' }]} onChange={(v) => set({ bitrateMode: v })} />
                      </span>
                      <span className="label">Keyframe every</span>
                      <HotText value={settings.keyframeInterval} min={0.5} max={10} step={0.5} decimals={1} unit=" s" width={64} onChange={(v, c) => c && set({ keyframeInterval: v })} />
                      <span className="label">Render</span>
                      <Checkbox checked={settings.useMaxQuality} onChange={(v) => set({ useMaxQuality: v })} label="Maximum render quality (full resolution effects)" />
                    </>
                  ) : null}
                  {settings.container === 'gif' ? (
                    <>
                      <span className="label">Colors</span>
                      <Select value={String(settings.gifColors)} options={[256, 128, 64, 32].map((n) => ({ value: String(n), label: String(n) }))} onChange={(v) => set({ gifColors: Number(v) })} />
                      <span className="label">Options</span>
                      <span style={{ display: 'flex', gap: 10 }}>
                        <Checkbox checked={settings.gifDither} onChange={(v) => set({ gifDither: v })} label="Dither" />
                        <Checkbox checked={settings.gifLoop} onChange={(v) => set({ gifLoop: v })} label="Loop" />
                      </span>
                    </>
                  ) : null}
                  {isImageSeq(settings.container) ? (
                    <>
                      {settings.container !== 'png' ? (
                        <>
                          <span className="label">Image quality</span>
                          <HotText value={settings.imageQuality * 100} min={10} max={100} step={1} unit="%" width={60} onChange={(v, c) => c && set({ imageQuality: v / 100 })} />
                        </>
                      ) : null}
                      <span className="label">Every</span>
                      <HotText value={settings.frameStep} min={1} max={600} step={1} unit=" frame(s)" width={90} onChange={(v, c) => c && set({ frameStep: Math.round(v) })} />
                    </>
                  ) : null}
                </div>
              ) : null}
              {tab === 'audio' && settings.container !== 'gif' && !isImageSeq(settings.container) ? (
                <div className="prop-grid">
                  {isVideoContainer(settings.container) ? (
                    <>
                      <span className="label">Include audio</span>
                      <Checkbox checked={settings.includeAudio} onChange={(v) => set({ includeAudio: v })} />
                      <span className="label">Codec</span>
                      <Select value={settings.audioCodec} options={(settings.container === 'webm' ? ['opus'] : ['aac', 'opus']).map((c) => ({ value: c, label: c.toUpperCase() }))} onChange={(v) => set({ audioCodec: v as any })} disabled={!settings.includeAudio} />
                      <span className="label">Bitrate</span>
                      <Select value={String(settings.audioBitrate)} options={[96, 128, 192, 256, 320].map((b) => ({ value: String(b), label: `${b} kbps` }))} onChange={(v) => set({ audioBitrate: Number(v) })} disabled={!settings.includeAudio} />
                    </>
                  ) : null}
                  <span className="label">Sample rate</span>
                  <Select value={String(settings.sampleRate)} options={[{ value: '48000', label: '48 kHz' }, { value: '44100', label: '44.1 kHz' }]} onChange={(v) => set({ sampleRate: Number(v) as 48000 | 44100 })} />
                  <span className="label">Channels</span>
                  <Segmented value={settings.channels} options={[{ value: 2, label: 'Stereo' }, { value: 1, label: 'Mono' }]} onChange={(v) => set({ channels: v as 1 | 2 })} />
                </div>
              ) : null}
              {tab === 'advanced' ? (
                <div className="prop-grid">
                  <span className="label">Range</span>
                  <Segmented value={settings.range} options={[{ value: 'entire', label: 'Entire sequence' }, { value: 'inOut', label: 'In to Out' }, { value: 'workArea', label: 'Work area' }, { value: 'custom', label: 'Custom' }]} onChange={(v) => set({ range: v })} />
                  {settings.range === 'custom' ? (
                    <>
                      <span className="label">Start / End</span>
                      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <TimecodeField frames={settings.customStart} fps={seq.settings.fps} onChange={(f) => set({ customStart: Math.max(0, Math.min(f, settings.customEnd - 1)) })} />
                        <TimecodeField frames={settings.customEnd} fps={seq.settings.fps} onChange={(f) => set({ customEnd: Math.max(settings.customStart + 1, Math.min(f, dur)) })} />
                        <Button sm onClick={() => set({ customStart: playhead })}>Set start</Button>
                        <Button sm onClick={() => set({ customEnd: playhead })}>Set end</Button>
                      </span>
                    </>
                  ) : null}
                  {settings.range === 'inOut' && seq.inPoint == null && seq.outPoint == null ? <><span /><span style={{ color: 'var(--c-warn)' }}>No In/Out set - the whole sequence will be exported.</span></> : null}
                  <span className="label">Captions</span>
                  <Checkbox checked={settings.burnCaptions} onChange={(v) => set({ burnCaptions: v })} label="Burn captions into video" disabled={!seq.captions.length} />
                  <span className="label">Timecode</span>
                  <Checkbox checked={settings.burnTimecode} onChange={(v) => set({ burnTimecode: v })} label="Burn timecode overlay" />
                  {isVideoContainer(settings.container) ? (
                    <>
                      <span className="label">Include video</span>
                      <Checkbox checked={settings.includeVideo} onChange={(v) => set({ includeVideo: v })} />
                    </>
                  ) : null}
                  <span className="label">Encoder</span>
                  <span style={{ color: 'var(--c-text-dim)' }}>
                    {!encoders ? 'Probing...' : encoders.webcodecs ? `WebCodecs available: ${Object.entries(encoders.video).filter(([, ok]) => ok).map(([c]) => codecLabel[c]).join(', ') || 'none'}` : 'WebCodecs not available - export uses a real-time MediaRecorder capture (WebM)'}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
          <div>
            <div className="export-preview" style={{ aspectRatio: `${settings.width} / ${settings.height}` }} title="Output preview at the playhead. Drag to scrub." onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const seek = (x: number) => setPreviewFrame(Math.round(((x - r.left) / r.width) * dur));
              seek(e.clientX);
              const move = (ev: PointerEvent) => seek(ev.clientX);
              const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
            }}>
              <canvas ref={previewRef} />
            </div>
            <div style={{ fontSize: 10, color: 'var(--c-text-faint)', marginTop: 3, display: 'flex', justifyContent: 'space-between' }}>
              <span>{framesToTimecode(previewFrame ?? playhead, seq.settings.fps, seq.settings.dropFrame)}</span>
              {previewFrame != null ? <button type="button" onClick={() => setPreviewFrame(null)} style={{ color: 'var(--c-accent-text)' }}>follow playhead</button> : null}
            </div>
            {summary ? (
              <div className="export-summary">
                <div><span className="k">Source: </span>{seq.settings.width}x{seq.settings.height}, {seq.settings.fps} fps, {framesToTimecode(dur, seq.settings.fps)}</div>
                <div><span className="k">Output: </span>{settings.container === 'wav' ? `${settings.sampleRate / 1000} kHz ${settings.channels === 2 ? 'stereo' : 'mono'}` : `${settings.width}x${settings.height}, ${settings.fps} fps`}{isVideoContainer(settings.container) ? `, ${codecLabel[settings.videoCodec]}${settings.includeAudio ? ` + ${settings.audioCodec.toUpperCase()}` : ''}` : ''}</div>
                <div><span className="k">Range: </span>{framesToTimecode(summary.range[0], seq.settings.fps)} - {framesToTimecode(summary.range[1], seq.settings.fps)} ({summary.frames} frames, {formatDurationShort(summary.secs)})</div>
                {summary.bytes ? <div><span className="k">Estimated size: </span>{formatBytes(summary.bytes)}</div> : null}
              </div>
            ) : null}
            {progress && progress.phase !== 'done' ? (
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                  <span style={{ textTransform: 'capitalize' }}>{progress.phase}{progress.message ? ` - ${progress.message}` : ''}</span>
                  <span className="tc">{progress.totalFrames ? `${Math.round((progress.frame / progress.totalFrames) * 100)}%` : ''}</span>
                </div>
                <div className="progress"><div style={{ width: `${progress.totalFrames ? (progress.frame / progress.totalFrames) * 100 : 0}%` }} /></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--c-text-dim)', marginTop: 3 }}>
                  <span>{progress.frame} / {progress.totalFrames} frames{progress.fps ? ` at ${progress.fps.toFixed(1)} fps` : ''}</span>
                  <span>{progress.etaSeconds > 0 ? `${formatDurationShort(progress.etaSeconds)} left` : ''}</span>
                </div>
              </div>
            ) : null}
            {result ? (
              <div className="export-summary" style={{ borderColor: 'var(--c-ok)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="check" size={12} style={{ color: 'var(--c-ok)' }} /> {result.filename}</div>
                <div className="k">{formatBytes(result.blob.size)} - {result.frames} frames in {formatDurationShort(result.seconds)}</div>
                <Button sm style={{ marginTop: 6 }} onClick={() => download(result.blob, result.filename)}>Download again</Button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="modal-footer" style={{ display: 'flex', gap: 8, padding: '8px 12px', borderTop: '1px solid var(--c-line)', alignItems: 'center' }}>
        <span style={{ color: 'var(--c-text-dim)', fontSize: 11 }}>{project.settings.name}</span>
        <span className="spacer" />
        {onClose ? <Button onClick={onClose} disabled={busy}>{inModal ? 'Close' : 'Cancel'}</Button> : null}
        {busy ? <Button danger onClick={() => abortRef.current?.abort()}>Stop export</Button> : <Button primary onClick={start} disabled={!summary || summary.frames <= 0} icon="export">Export</Button>}
      </div>
    </div>
  );
}

export { useUI };
