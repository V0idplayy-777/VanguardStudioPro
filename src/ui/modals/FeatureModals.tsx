import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useUI, toast, logEvent, type ModalRequest } from '../../state/uiStore';
import { useProject, useActiveSequence, findAsset, sequenceDuration } from '../../state/projectStore';
import { useSettings, SETTINGS_META } from '../../state/settingsStore';
import { useShortcutStore, type ShortcutPresetFile } from '../../state/shortcutStore';
import { usePlayback } from '../../engine/playback/playback';
import { Modal, Button, Select, Checkbox, Segmented, Kbd, TextField, Slider, IconButton } from '../controls';
import { Icon } from '../icons';
import { getMedia, isProxyActive } from '../../engine/media/mediaStore';
import { useProxyJobs, createProxiesForAssets, createProxyForAsset, cancelProxyJob, detachProxy, attachProxyBlob, proxyTargetSize } from '../../engine/media/proxy';
import { persistProxyBlob } from '../../engine/media/mediaDb';
import { pickFiles } from '../../engine/media/importer';
import { transcribeRange, cancelTranscription, segmentsToCaptions, STT_MODELS, STT_LANGUAGES, type SttModelId, type SttSegment } from '../../engine/captions/transcribe';
import { analyzeClip, analyzeFramePreview, segmenterStatus } from '../../engine/mask/magicMask';
import { VOICE_CLEANUP_PRESETS, defaultVoicePlan, renderVoiceCleanup, bakeVoiceCleanup, removeCleanedAudio, type VoiceCleanupPlan } from '../../engine/audio/voiceCleanup';
import { getSharedAudioContext } from '../../engine/audio/audioContext';
import { SHORTCUTS, effectiveShortcuts, shortcutConflict, describeKey } from '../../app/shortcuts';
import { formatBytes, download } from '../../engine/util';
import { framesToTimecode } from '../../engine/timecode';
import { clipEnd } from '../../engine/timeline/edits';
import type { Id, MediaAsset } from '../../types/project';

type P = { modal: ModalRequest; close: () => void };

function Row({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <span className="lbl">
        <div className="name">{label}</div>
        {desc ? <div className="desc">{desc}</div> : null}
      </span>
      <span className="ctl">{children}</span>
    </div>
  );
}

/* ================= Proxy Manager ================= */

export function ProxyManagerModal({ modal, close }: P) {
  const project = useProject((s) => s.project);
  const st = useSettings();
  const jobs = useProxyJobs((s) => s.jobs);
  const offerIds = (modal.payload?.offerIds as Id[] | undefined) ?? [];
  const [showOffer, setShowOffer] = useState(offerIds.length > 0);
  const [attaching, setAttaching] = useState<Id | null>(null);

  const videos = useMemo(() => project.assets.filter((a) => a.hasVideo && a.kind !== 'sequence' && a.kind !== 'generator'), [project]);
  const pending = videos.filter((a) => !a.proxy || a.proxy.status !== 'ready');
  const jobCount = Object.keys(jobs).length;

  const attachFile = async (asset: MediaAsset) => {
    const files = await pickFiles('video/*,.mp4,.mov,.mkv,.webm', false);
    if (!files.length) return;
    setAttaching(asset.id);
    try {
      await persistProxyBlob(asset.id, files[0]);
      await attachProxyBlob(asset.id, files[0]);
    } finally {
      setAttaching(null);
    }
  };

  return (
    <Modal
      title="Proxy Manager"
      icon="film"
      onClose={close}
      width={640}
      footer={
        <>
          <span className="dim" style={{ fontSize: 11 }}>
            {jobCount ? `${jobCount} generating…` : 'Exports always use the original media.'}
          </span>
          <span className="spacer" />
          <Button onClick={close}>Close</Button>
          <Button primary disabled={!pending.length || !!jobCount} onClick={() => void createProxiesForAssets(pending.map((a) => a.id))}>
            Create All ({pending.length})
          </Button>
        </>
      }
    >
      {showOffer && offerIds.length ? (
        <div className="notice info" style={{ marginBottom: 10 }}>
          <div>
            <strong>{offerIds.length} new clip{offerIds.length === 1 ? ' is' : 's are'} larger than 1080p.</strong> Proxies make scrubbing and playback dramatically smoother.
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <Button sm primary onClick={() => { setShowOffer(false); void createProxiesForAssets(offerIds); }}>Create Proxies</Button>
            <Button sm onClick={() => setShowOffer(false)}>Not Now</Button>
          </div>
        </div>
      ) : null}
      <Row label="Use proxies" desc={SETTINGS_META.proxyEnabled.hint}>
        <Checkbox checked={st.proxyEnabled} onChange={(v) => st.set('proxyEnabled', v)} label={st.proxyEnabled ? 'On (Shift+P to toggle)' : 'Off (Shift+P to toggle)'} />
      </Row>
      <Row label="Proxy size" desc="Applies to newly created proxies.">
        <span style={{ display: 'flex', gap: 8 }}>
          <Segmented value={st.proxyScale} options={[{ value: '720p', label: '720p' }, { value: '540p', label: '540p' }, { value: '360p', label: '360p' }]} onChange={(v) => st.set('proxyScale', v)} />
          <Segmented value={st.proxyCodec} options={[{ value: 'h264', label: 'H.264' }, { value: 'vp9', label: 'VP9' }]} onChange={(v) => st.set('proxyCodec', v)} title="Proxy codec" />
        </span>
      </Row>
      <div className="settings-section-title">Project media</div>
      <div className="scroll-y" style={{ maxHeight: 300 }}>
        {!videos.length ? <div className="empty">No video in this project yet.</div> : null}
        {videos.map((a) => {
          const job = jobs[a.id];
          const active = isProxyActive(a, getMedia(a.id));
          const target = proxyTargetSize(a);
          return (
            <div key={a.id} className="proxy-row">
              <span className="nm" title={a.name}>
                <Icon name={a.offline ? 'offline' : 'clipVideo'} size={13} />
                {a.name}
                <span className="dim">
                  {a.width}×{a.height}
                </span>
              </span>
              <span className="st">
                {job ? (
                  <>
                    <span className="progress" style={{ width: 110, margin: 0 }}>
                      <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
                    </span>
                    <span className="dim">{Math.round(job.progress * 100)}%</span>
                    <Button sm onClick={() => cancelProxyJob(a.id)}>Cancel</Button>
                  </>
                ) : a.proxy?.status === 'ready' ? (
                  <>
                    <span className={`proxy-pill${active ? ' on' : ''}`} title={active ? 'Timeline is playing this proxy' : 'Proxy ready — enable proxy playback to use it'}>
                      {active ? 'PROXY' : 'READY'} · {a.proxy.width}×{a.proxy.height} · {formatBytes(a.proxy.bytes)}
                    </span>
                    <Button sm onClick={() => void detachProxy(a.id, true)} title="Delete the proxy file and go back to the original">Delete</Button>
                  </>
                ) : a.proxy?.status === 'pending' ? (
                  <span className="dim">Finishing…</span>
                ) : (
                  <>
                    <span className="dim">Original only → {target.width}×{target.height}</span>
                    <Button sm disabled={attaching === a.id} onClick={() => void createProxyForAsset(a.id)}>Create</Button>
                    <Button sm ghost disabled={attaching === a.id} onClick={() => void attachFile(a)} title="Use a file you encoded elsewhere as this clip's proxy">
                      {attaching === a.id ? '…' : 'Attach…'}
                    </Button>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

/* ================= Transcribe ================= */

export function TranscribeModal({ close }: P) {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const st = useSettings();
  const [range, setRange] = useState<'entire' | 'inout'>('entire');
  const [model, setModel] = useState<SttModelId>(st.sttModel);
  const [language, setLanguage] = useState(st.sttLanguage);
  const [mode, setMode] = useState<'replace' | 'append'>('replace');
  const [saveDefaults, setSaveDefaults] = useState(true);
  const [phase, setPhase] = useState<{ kind: string; progress: number; message: string } | null>(null);
  const [result, setResult] = useState<SttSegment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = phase != null;

  if (!seq) {
    return (
      <Modal title="Transcribe Sequence" icon="panelCaptions" onClose={close} width={520}>
        <div className="empty">Open a sequence first.</div>
      </Modal>
    );
  }
  const fps = seq.settings.fps;
  const dur = sequenceDuration(seq);
  const hasInOut = seq.inPoint != null && seq.outPoint != null && seq.outPoint > seq.inPoint;
  const startF = range === 'inout' && hasInOut ? seq.inPoint! : 0;
  const endF = range === 'inout' && hasInOut ? seq.outPoint! : dur;
  const meta = STT_MODELS.find((m) => m.id === model)!;

  const run = async () => {
    setError(null);
    setResult(null);
    if (saveDefaults) {
      st.set('sttModel', model);
      st.set('sttLanguage', language);
    }
    try {
      const segs = await transcribeRange(project, seq, startF, endF, {
        model,
        language,
        onProgress: (kind, progress, message) => setPhase({ kind, progress, message }),
      });
      setPhase(null);
      if (!segs.length) {
        setError('No speech was detected in this range. Check that the range contains audible dialogue on unmuted tracks.');
        return;
      }
      const captions = segmentsToCaptions(segs, startF, fps);
      useProject.getState().update('Transcribe Sequence', (p) => {
        const s = p.sequences.find((x) => x.id === seq.id)!;
        s.captions = mode === 'replace' ? captions : [...s.captions, ...captions].sort((a, b) => a.start - b.start);
      });
      setResult(segs);
      logEvent('info', `Transcribed ${segs.length} captions with Whisper (${meta.name})`);
      toast('success', 'Transcription complete', `${captions.length} caption${captions.length === 1 ? '' : 's'} added. Review them in the Captions panel.`);
    } catch (e) {
      setPhase(null);
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'cancelled') return;
      if (msg === 'silent') {
        setError('This range is silent (or all its audio is muted). Whisper refuses to guess — pick a range with audible speech.');
        return;
      }
      setError(`The transcription engine could not start: ${msg}. It downloads once from a CDN — check your connection and retry.`);
    }
  };

  return (
    <Modal
      title="Transcribe Sequence"
      icon="panelCaptions"
      onClose={() => {
        if (running) cancelTranscription();
        close();
      }}
      width={540}
      footer={
        <>
          <span className="dim" style={{ fontSize: 11 }}>{phase ? phase.message : result ? `${result.length} segments found` : 'On-device Whisper — audio never leaves your machine.'}</span>
          <span className="spacer" />
          {running ? <Button onClick={() => cancelTranscription()}>Cancel</Button> : <Button onClick={close}>{result ? 'Close' : 'Cancel'}</Button>}
          {!running && !result ? (
            <Button primary onClick={() => void run()} disabled={endF <= startF}>
              Transcribe
            </Button>
          ) : null}
          {result ? <Button primary onClick={close}>Done</Button> : null}
        </>
      }
    >
      <Row label="Range" desc={`${framesToTimecode(startF, fps)} → ${framesToTimecode(endF, fps)} (${((endF - startF) / fps).toFixed(1)}s)`}>
        <Segmented
          value={range}
          options={[
            { value: 'entire', label: 'Entire sequence' },
            { value: 'inout', label: 'In / Out', title: hasInOut ? 'Between In and Out points' : 'Set In and Out points first' },
          ]}
          onChange={(v) => setRange(v)}
        />
      </Row>
      {range === 'inout' && !hasInOut ? <div className="notice warn">No In/Out range set — the entire sequence will be used.</div> : null}
      <Row label="Model" desc={`${meta.size} download, cached afterwards. ${meta.desc}`}>
        <Select value={model} options={STT_MODELS.map((m) => ({ value: m.id, label: `${m.name} (${m.size})` }))} onChange={(v) => setModel(v as SttModelId)} />
      </Row>
      <Row label="Language" desc="Auto-detect works with the multilingual models.">
        <Select value={language} options={STT_LANGUAGES.map((l) => ({ value: l.id, label: l.name }))} onChange={setLanguage} />
      </Row>
      <Row label="Captions" desc={seq.captions.length ? `Sequence already has ${seq.captions.length} captions.` : 'Sequence has no captions yet.'}>
        <Segmented value={mode} options={[{ value: 'replace', label: 'Replace all' }, { value: 'append', label: 'Append' }]} onChange={(v) => setMode(v)} />
      </Row>
      <Row label="Remember" desc="Store the model and language as defaults.">
        <Checkbox checked={saveDefaults} onChange={setSaveDefaults} label="Save as my defaults" />
      </Row>
      {phase ? (
        <div style={{ marginTop: 10 }}>
          <div className="progress">
            <div style={{ width: `${Math.round(phase.progress * 100)}%` }} />
          </div>
          <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
            {phase.kind === 'model' ? 'Downloading model' : phase.kind === 'audio' ? 'Mixing audio' : 'Transcribing'} — {Math.round(phase.progress * 100)}%
          </div>
        </div>
      ) : null}
      {error ? <div className="notice error" style={{ marginTop: 10 }}>{error}</div> : null}
      {result ? (
        <div className="scroll-y" style={{ maxHeight: 180, marginTop: 10, border: '1px solid var(--c-line)', borderRadius: 4, padding: 8 }}>
          {result.slice(0, 60).map((s, i) => (
            <div key={i} style={{ fontSize: 11, padding: '2px 0', borderBottom: '1px solid var(--c-line)' }}>
              <span className="dim">{s.start.toFixed(1)}s → {s.end.toFixed(1)}s</span> {s.text}
            </div>
          ))}
          {result.length > 60 ? <div className="dim" style={{ fontSize: 11 }}>…and {result.length - 60} more</div> : null}
        </div>
      ) : null}
    </Modal>
  );
}

/* ================= Magic Mask ================= */

export function MagicMaskModal({ close }: P) {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const selection = useUI((s) => s.selection.clipIds);
  const playhead = usePlayback((s) => s.playhead);
  const [clipId, setClipId] = useState<Id | null>(null);
  const [step, setStep] = useState(3);
  const [progress, setProgress] = useState<{ done: number; total: number; msg: string } | null>(null);
  const [preview, setPreview] = useState<{ width: number; height: number; alpha: Uint8Array } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const cancelRef = useRef(false);
  const previewCanvas = useRef<HTMLCanvasElement>(null);

  const videoClips = useMemo(() => {
    if (!seq) return [];
    const vids = new Set(seq.tracks.filter((t) => t.kind === 'video').map((t) => t.id));
    return seq.clips.filter((c) => vids.has(c.trackId) && (findAsset(project, c.assetId ?? '')?.hasVideo || c.nestedSequenceId));
  }, [seq, project]);
  const clip = videoClips.find((c) => c.id === clipId) ?? videoClips.find((c) => selection.includes(c.id)) ?? videoClips.find((c) => playhead >= c.start && playhead < clipEnd(c)) ?? videoClips[0] ?? null;
  const hasMask = !!clip?.effects.some((e) => e.type === 'magicMask');
  const modelState = segmenterStatus();

  useEffect(() => {
    if (clip && !clipId) setClipId(clip.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id]);

  useEffect(() => {
    const cv = previewCanvas.current;
    if (!cv || !preview) return;
    cv.width = preview.width;
    cv.height = preview.height;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(preview.width, preview.height);
    for (let i = 0, j = 0; i < preview.alpha.length; i++, j += 4) {
      img.data[j] = 120;
      img.data[j + 1] = 170;
      img.data[j + 2] = 255;
      img.data[j + 3] = preview.alpha[i];
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.putImageData(img, 0, 0);
  }, [preview]);

  if (!seq) {
    return (
      <Modal title="Magic Mask" icon="clipMatte" onClose={close} width={480}>
        <div className="empty">Open a sequence first.</div>
      </Modal>
    );
  }

  const doPreview = async () => {
    if (!clip) return;
    setPreviewBusy(true);
    setPreview(null);
    try {
      const local = Math.max(0, Math.min(clip.duration - 1, playhead - clip.start));
      const m = await analyzeFramePreview(seq.id, clip.id, local);
      if (!m) toast('warning', 'No person found', 'The AI could not find a person in this frame.');
      setPreview(m);
    } catch (e) {
      toast('error', 'Preview failed', e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewBusy(false);
    }
  };

  const track = async () => {
    if (!clip) return;
    usePlayback.getState().pause();
    cancelRef.current = false;
    setProgress({ done: 0, total: 1, msg: 'Starting…' });
    const res = await analyzeClip({
      sequenceId: seq.id,
      clipId: clip.id,
      step,
      onProgress: (done, total, msg) => setProgress({ done, total, msg }),
      isCancelled: () => cancelRef.current,
    });
    setProgress(null);
    if (res) close();
  };

  return (
    <Modal
      title="Magic Mask"
      icon="clipMatte"
      onClose={() => {
        cancelRef.current = true;
        close();
      }}
      width={520}
      footer={
        <>
          <span className="dim" style={{ fontSize: 11 }}>{progress ? progress.msg : hasMask ? 'Re-tracking replaces the existing matte.' : 'Adds a Magic Mask effect to the clip.'}</span>
          <span className="spacer" />
          {progress ? <Button onClick={() => (cancelRef.current = true)}>Cancel</Button> : <Button onClick={close}>Close</Button>}
          {!progress ? (
            <Button primary disabled={!clip} onClick={() => void track()}>
              Track Subject
            </Button>
          ) : null}
        </>
      }
    >
      <div className="notice info">AI person matte — no green screen needed. Best on shots with clearly visible people; for objects, use Ultra Key or masks.</div>
      <Row label="Clip" desc={clip ? `${framesToTimecode(clip.duration, seq.settings.fps)} long · ${clip.name}` : undefined}>
        <Select value={clip?.id ?? ''} options={videoClips.map((c) => ({ value: c.id, label: c.name }))} onChange={(v) => { setClipId(v); setPreview(null); }} />
      </Row>
      <Row label="Keyframe step" desc="Analyze every Nth frame; mattes between keys are interpolated. Smaller steps track fast motion better.">
        <Segmented value={String(step)} options={[{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }, { value: '5', label: '5' }, { value: '10', label: '10' }]} onChange={(v) => setStep(Number(v))} />
      </Row>
      <Row label="Frame test" desc={modelState === 'error' ? 'Model failed to load before — retrying on demand.' : 'Analyze the frame under the playhead to check the shot.'}>
        <Button sm disabled={!clip || previewBusy} onClick={() => void doPreview()}>
          {previewBusy ? 'Analyzing…' : 'Preview This Frame'}
        </Button>
      </Row>
      {preview ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4 }}>
          <canvas ref={previewCanvas} style={{ width: 144, height: 'auto', borderRadius: 4, border: '1px solid var(--c-line)', imageRendering: 'pixelated' }} />
          <span className="dim" style={{ fontSize: 11 }}>Blue = kept subject at the playhead.<br />Tune edges later in Effect Controls.</span>
        </div>
      ) : (
        <canvas ref={previewCanvas} style={{ display: 'none' }} />
      )}
      {progress ? (
        <div style={{ marginTop: 10 }}>
          <div className="progress">
            <div style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
          </div>
          <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
            Frame {progress.done} / {progress.total}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

/* ================= Voice Cleanup ================= */

export function VoiceCleanupModal({ modal, close }: P) {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const selection = useUI((s) => s.selection.clipIds);
  const [assetId, setAssetId] = useState<Id | null>(null);
  const [plan, setPlan] = useState<VoiceCleanupPlan>(defaultVoicePlan());
  const [rendering, setRendering] = useState<string | null>(null);
  const [renderProgress, setRenderProgress] = useState(0);
  const [previewBufs, setPreviewBufs] = useState<{ orig: AudioBuffer; cleaned: AudioBuffer } | null>(null);
  const [playing, setPlaying] = useState<'orig' | 'cleaned' | null>(null);
  const player = useRef<AudioBufferSourceNode | null>(null);

  const audioAssets = useMemo(() => project.assets.filter((a) => a.hasAudio && a.kind !== 'sequence'), [project]);
  const fromSelection = (modal.payload?.assetId as Id | undefined) ?? seq?.clips.find((c) => selection.includes(c.id) && c.assetId)?.assetId ?? null;
  const asset = audioAssets.find((a) => a.id === (assetId ?? fromSelection)) ?? audioAssets[0] ?? null;
  const usingId = asset?.id ?? null;
  const cleaned = asset?.cleanedAudio;

  useEffect(() => () => {
    try {
      player.current?.stop();
    } catch {
      /* ignore */
    }
  }, []);

  const stop = () => {
    try {
      player.current?.stop();
    } catch {
      /* ignore */
    }
    player.current = null;
    setPlaying(null);
  };

  const play = (which: 'orig' | 'cleaned') => {
    if (!previewBufs) return;
    stop();
    const ctx = getSharedAudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = which === 'orig' ? previewBufs.orig : previewBufs.cleaned;
    src.connect(ctx.destination);
    src.onended = () => {
      if (player.current === src) {
        player.current = null;
        setPlaying(null);
      }
    };
    player.current = src;
    src.start();
    setPlaying(which);
  };

  const set = <K extends keyof VoiceCleanupPlan>(k: K, v: VoiceCleanupPlan[K]) => setPlan((p) => ({ ...p, preset: 'custom', [k]: v }));

  const renderPreview = async () => {
    if (!usingId) return;
    stop();
    setRendering('preview');
    setRenderProgress(0);
    try {
      const cleanedBuf = await renderVoiceCleanup(usingId, plan, {
        previewSeconds: 10,
        onProgress: (p) => setRenderProgress(p),
      });
      const rec = getMedia(usingId);
      if (!cleanedBuf || !rec?.audio) throw new Error('No decoded audio yet — wait for the waveform and retry.');
      const n = Math.min(rec.audio.length, cleanedBuf.length);
      const ctx = getSharedAudioContext();
      const orig = ctx.createBuffer(rec.audio.numberOfChannels, n, rec.audio.sampleRate);
      for (let c = 0; c < orig.numberOfChannels; c++) orig.getChannelData(c).set(rec.audio.getChannelData(c).subarray(0, n));
      setPreviewBufs({ orig, cleaned: cleanedBuf });
    } catch (e) {
      toast('error', 'Preview failed', e instanceof Error ? e.message : String(e));
    } finally {
      setRendering(null);
    }
  };

  const bake = async () => {
    if (!usingId) return;
    stop();
    setRendering('bake');
    setRenderProgress(0);
    try {
      const ok = await bakeVoiceCleanup(usingId, plan, { onProgress: (p) => setRenderProgress(p) });
      if (ok) close();
    } finally {
      setRendering(null);
    }
  };

  const remove = async () => {
    if (!usingId) return;
    await removeCleanedAudio(usingId);
    toast('info', 'Cleaned take removed', 'Clips are back on the original audio.');
  };

  return (
    <Modal
      title="Clean Up Voice"
      icon="mic"
      onClose={() => {
        stop();
        close();
      }}
      width={560}
      footer={
        <>
          <span className="dim" style={{ fontSize: 11 }}>{rendering === 'bake' ? `Baking… ${Math.round(renderProgress * 100)}%` : rendering ? `Rendering preview… ${Math.round(renderProgress * 100)}%` : 'Baked per asset — the original is always kept.'}</span>
          <span className="spacer" />
          <Button onClick={() => { stop(); close(); }}>Close</Button>
          <Button primary disabled={!usingId || !!rendering} onClick={() => void bake()}>
            Clean & Apply
          </Button>
        </>
      }
    >
      <Row label="Source" desc={asset?.cleanedAudio ? `Has a cleaned take (${asset.cleanedAudio.preset}). Baking replaces it.` : 'Dialogue recording to clean.'}>
        <Select value={usingId ?? ''} options={audioAssets.map((a) => ({ value: a.id, label: a.name }))} onChange={(v) => { setAssetId(v); setPreviewBufs(null); }} />
      </Row>
      <Row label="Preset" desc={VOICE_CLEANUP_PRESETS.find((p) => p.id === plan.preset)?.desc ?? 'Your custom mix.'}>
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {VOICE_CLEANUP_PRESETS.map((p) => (
            <Button key={p.id} sm primary={plan.preset === p.id} onClick={() => { setPlan({ ...p.plan }); setPreviewBufs(null); }}>
              {p.name}
            </Button>
          ))}
        </span>
      </Row>
      <div className="settings-section-title">Fine tune</div>
      <Row label="Noise reduction" desc="Learns the room tone from the quietest moment, then gates it out.">
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Slider value={plan.denoise} min={0} max={100} step={1} onChange={(v) => set('denoise', Math.round(v))} style={{ width: 160 }} />
          <span className="dim" style={{ width: 36 }}>{plan.denoise}%</span>
        </span>
      </Row>
      <Row label="Hum removal" desc="Notches mains hum and its harmonics.">
        <Segmented value={String(plan.humHz)} options={[{ value: '0', label: 'Off' }, { value: '50', label: '50 Hz' }, { value: '60', label: '60 Hz' }]} onChange={(v) => set('humHz', Number(v) as 0 | 50 | 60)} />
      </Row>
      <Row label="Tame reverb" desc="Pushes roomy tails down between words. Subtle by design.">
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Slider value={plan.reverb} min={0} max={100} step={1} onChange={(v) => set('reverb', Math.round(v))} style={{ width: 160 }} />
          <span className="dim" style={{ width: 36 }}>{plan.reverb}%</span>
        </span>
      </Row>
      <Row label="Rumble filter" desc="Cuts handling noise and plosives below 80 Hz.">
        <Checkbox checked={plan.rumble} onChange={(v) => set('rumble', v)} label="On" />
      </Row>
      <Row label="Auto level" desc="Evens out loud and quiet passages with a safety ceiling.">
        <Checkbox checked={plan.level} onChange={(v) => set('level', v)} label="On" />
      </Row>
      <div className="settings-section-title">Preview (first 10 seconds)</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <Button sm disabled={!usingId || !!rendering} onClick={() => void renderPreview()}>
          {rendering === 'preview' ? `Rendering ${Math.round(renderProgress * 100)}%` : previewBufs ? 'Re-render Preview' : 'Render Preview'}
        </Button>
        {previewBufs ? (
          <>
            <Button sm primary={playing === 'orig'} onClick={() => (playing === 'orig' ? stop() : play('orig'))}>
              {playing === 'orig' ? 'Stop' : 'Play Original'}
            </Button>
            <Button sm primary={playing === 'cleaned'} onClick={() => (playing === 'cleaned' ? stop() : play('cleaned'))}>
              {playing === 'cleaned' ? 'Stop' : 'Play Cleaned'}
            </Button>
          </>
        ) : null}
        <span className="spacer" />
        {cleaned ? <Button sm ghost onClick={() => void remove()} title="Delete the baked take and return clips to the original">Remove Take</Button> : null}
      </div>
      {rendering ? (
        <div className="progress" style={{ marginTop: 10 }}>
          <div style={{ width: `${Math.round(renderProgress * 100)}%` }} />
        </div>
      ) : null}
    </Modal>
  );
}

/* ================= Shortcut remapping (Settings > Keyboard) ================= */

export function ShortcutEditor() {
  const [q, setQ] = useState('');
  const [capturing, setCapturing] = useState<string | null>(null);
  const overrides = useShortcutStore((s) => s.overrides);
  const removed = useShortcutStore((s) => s.removed);
  const setBinding = useShortcutStore((s) => s.setBinding);
  const resetBinding = useShortcutStore((s) => s.resetBinding);
  const resetAll = useShortcutStore((s) => s.resetAll);
  const importPreset = useShortcutStore((s) => s.importPreset);
  const exportPreset = useShortcutStore((s) => s.exportPreset);
  const fileRef = useRef<HTMLInputElement>(null);
  void overrides;
  void removed;

  const list = effectiveShortcuts();
  const cats = [...new Set(SHORTCUTS.map((s) => s.category))];
  const match = (s: (typeof list)[number]) => !q || s.label.toLowerCase().includes(q.toLowerCase()) || s.keys.toLowerCase().includes(q.toLowerCase());

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturing(null);
        return;
      }
      // Bare modifiers are not a shortcut.
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      const desc = describeKey(e);
      const conflict = shortcutConflict(desc, capturing);
      if (conflict) {
        toast('warning', 'Already assigned', `"${desc}" runs "${conflict.label}". Clear it there first, or pick another combination.`);
        return;
      }
      setBinding(capturing, desc);
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, setBinding]);

  const doExport = () => {
    const file = exportPreset();
    download(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }), 'vanguard-shortcuts.json');
  };
  const doImport = async (f: File) => {
    try {
      const data = JSON.parse(await f.text()) as ShortcutPresetFile;
      if (data.app !== 'vanguard-studio-pro' || data.kind !== 'shortcuts') throw new Error('Not a Vanguard shortcuts file.');
      // Only accept ids we know.
      const known = new Set(SHORTCUTS.map((s) => s.id));
      const clean: ShortcutPresetFile = { ...data, overrides: Object.fromEntries(Object.entries(data.overrides ?? {}).filter(([k, v]) => known.has(k) && typeof v === 'string')), removed: (data.removed ?? []).filter((k) => known.has(k)) };
      importPreset(clean);
      toast('success', 'Shortcuts imported', `${Object.keys(clean.overrides).length} bindings applied.`);
    } catch (e) {
      toast('error', 'Import failed', e instanceof Error ? e.message : String(e));
    }
  };

  const customCount = Object.keys(exportPreset().overrides).length + exportPreset().removed.length;

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <TextField value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter commands" icon="search" style={{ width: 220 }} />
        <span className="spacer" />
        <span className="dim" style={{ fontSize: 11, alignSelf: 'center' }}>{customCount ? `${customCount} customized` : 'Factory defaults'}</span>
        <Button sm onClick={doExport} title="Download your bindings as JSON">Export</Button>
        <Button sm onClick={() => fileRef.current?.click()} title="Load bindings from a JSON file">Import</Button>
        <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); e.target.value = ''; }} />
        <Button sm ghost onClick={() => { if (confirm('Reset all shortcuts to factory defaults?')) resetAll(); }}>Reset All</Button>
      </div>
      <div className="notice info">Click a binding, then press the new keys. <Kbd>Esc</Kbd> cancels. Single letters also drive tools when nothing else claims them.</div>
      <div className="scroll-y" style={{ maxHeight: '46vh' }}>
        <div className="kbd-grid">
          {cats.map((c) => {
            const rows = list.filter((s) => s.category === c && match(s));
            if (!rows.length) return null;
            const factory = (id: string) => SHORTCUTS.find((s) => s.id === id)!;
            return (
              <React.Fragment key={c}>
                <div className="kb-cat">{c}</div>
                {rows.map((s) => {
                  const f = factory(s.id);
                  const custom = s.keys !== f.keys;
                  const isCap = capturing === s.id;
                  return (
                    <div key={s.id} className={`kb-row${custom ? ' custom' : ''}`}>
                      <span className="nm">{s.label}</span>
                      <span className="spacer" />
                      {isCap ? (
                        <span className="kbd-capture">Press keys…</span>
                      ) : s.keys ? (
                        <button type="button" className="kbd-btn" onClick={() => setCapturing(s.id)} title="Click to rebind">
                          {s.keys.split('+').map((k) => <Kbd key={k}>{k}</Kbd>)}
                        </button>
                      ) : (
                        <button type="button" className="kbd-btn unassigned" onClick={() => setCapturing(s.id)} title="Click to assign">Unassigned</button>
                      )}
                      {!isCap && s.keys ? (
                        <IconButton icon="close" label="Unassign" sm noline onClick={() => setBinding(s.id, null)} />
                      ) : null}
                      {!isCap && custom ? (
                        <IconButton icon="reset" label={`Reset to ${f.keys || 'unassigned'}`} sm noline onClick={() => resetBinding(s.id)} />
                      ) : null}
                    </div>
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
