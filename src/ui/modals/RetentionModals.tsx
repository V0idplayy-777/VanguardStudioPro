import React, { useEffect, useMemo, useState } from 'react';
import { type ModalRequest } from '../../state/uiStore';
import { useProject, useActiveSequence, sequenceDuration } from '../../state/projectStore';
import { renderFrameToCanvas } from '../../engine/playback/playback';
import { Modal, Button, Select, Checkbox, HotText, TextField, TextArea } from '../controls';
import { Icon } from '../icons';
import { retentionCmd } from '../../app/retention';
import { analyzeRetention, type RetentionFinding } from '../../retention/analyze';
import { SFX } from '../../retention/sfx';
import { brandKits, type BrandKit } from '../../retention/brandKit';

type P = { modal: ModalRequest; close: () => void };

const STATUS_ICON: Record<RetentionFinding['status'], { icon: string; color: string }> = {
  ok: { icon: 'check', color: 'var(--c-ok, #4da58a)' },
  warn: { icon: 'warning', color: 'var(--c-warn, #c48a3e)' },
  info: { icon: 'info', color: 'var(--c-text-dim)' },
};

/* ============================== Retention Check ============================== */

function RetentionCheckModal({ close }: P) {
  const seq = useActiveSequence();
  const report = useMemo(() => (seq ? analyzeRetention(seq) : null), [seq]);
  const fix = (f?: RetentionFinding['fix']) => {
    close();
    if (!f) return;
    switch (f) {
      case 'smartCaptions':
        retentionCmd.openSmartCaptions();
        break;
      case 'retentionCaptionStyle':
        retentionCmd.applyRetentionCaptionStyle();
        break;
      case 'zoomPunches':
        retentionCmd.zoomPunches();
        break;
      case 'flashOnCuts':
        retentionCmd.flashOnCuts();
        break;
      case 'musicBed':
        retentionCmd.applyMusicBed();
        break;
      case 'loopOutro':
        retentionCmd.openLoopOutro();
        break;
      case 'rewindTrap':
        retentionCmd.openRewindTrap();
        break;
      case 'typoBait':
        retentionCmd.plantTypoBait();
        break;
    }
  };
  if (!seq) return null;
  return (
    <Modal title="Retention Check" icon="target" onClose={close} width={620} footer={<><span className="dim" style={{ fontSize: 11 }}>Retention is measured, then fixed - every action is one undo step.</span><span className="spacer" /><Button primary onClick={close}>Done</Button></>}>
      <div className="scroll-y" style={{ maxHeight: '62vh', paddingRight: 4 }}>
        {report!.findings.map((f) => (
          <div key={f.id} style={{ display: 'flex', gap: 10, padding: '8px 4px', borderBottom: '1px solid var(--c-line)' }}>
            <Icon name={STATUS_ICON[f.status].icon as any} size={14} style={{ color: STATUS_ICON[f.status].color, marginTop: 2, flex: '0 0 auto' }} />
            <div style={{ flex: 1 }}>
              <strong>{f.title}</strong>
              <div style={{ fontSize: 12, color: 'var(--c-text-dim)', marginTop: 2 }}>{f.detail}</div>
            </div>
            {f.fix ? <Button sm onClick={() => fix(f.fix)}>Fix</Button> : null}
          </div>
        ))}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>The Corporate Retention &amp; Engagement Playbook</div>
          {retentionCmd.playbook().map((p) => (
            <div key={p.id} style={{ fontSize: 12, color: 'var(--c-text-dim)', padding: '3px 0' }}>
              <strong style={{ color: 'var(--c-text)' }}>{p.name}</strong> - {p.goal}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/* ============================== Smart Captions ============================== */

function SmartCaptionsModal({ close }: P) {
  const seq = useActiveSequence();
  const [maxWords, setMaxWords] = useState<number>(2);
  const [kicker, setKicker] = useState(true);
  const [transcript, setTranscript] = useState('');
  if (!seq) return null;
  const hasCaptions = seq.captions.length > 0;
  const run = () => {
    retentionCmd.generateSmartCaptions({ transcript: transcript.trim(), maxWords, kicker });
    close();
  };
  return (
    <Modal title="Smart Captions" icon="captions" onClose={close} width={460} footer={<><span className="spacer" /><Button onClick={close}>Cancel</Button><Button primary onClick={run} disabled={!hasCaptions && !transcript.trim()}>Generate</Button></>}>
      <div className="prop-grid">
        <span className="label">Words per caption</span>
        <Select value={maxWords} options={[1, 2, 3].map((n) => ({ value: n, label: `${n} word${n === 1 ? '' : 's'} per line` }))} onChange={(v) => setMaxWords(Number(v))} />
        <span className="label">Kicker word</span>
        <Checkbox checked={kicker} onChange={setKicker} label="Highlight the last word in each caption" />
      </div>
      <div style={{ fontSize: 12, color: 'var(--c-text-dim)', marginTop: 10 }}>
        {hasCaptions ? `Converts ${seq.captions.length} existing caption${seq.captions.length === 1 ? '' : 's'} into bold, centred, animated micro-captions (1-${maxWords} words per line).` : 'No captions yet - paste a transcript below. It will be laid out from the playhead.'}
      </div>
      {!hasCaptions ? <TextArea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={5} placeholder="Paste your script or transcript here..." style={{ marginTop: 10 }} /> : null}
    </Modal>
  );
}

/* ============================== Rewind Trap ============================== */

function RewindTrapModal({ close }: P) {
  const project = useProject((s) => s.project);
  const [kind, setKind] = useState<'text' | 'image'>('text');
  const [text, setText] = useState('nice try');
  const [corner, setCorner] = useState<'tl' | 'tr' | 'bl' | 'br'>('br');
  const [frames, setFrames] = useState(2);
  const images = project.assets.filter((a) => a.kind === 'image' && !a.offline);
  const [assetId, setAssetId] = useState<string>(images[0]?.id ?? '');
  const plant = () => {
    retentionCmd.insertRewindTrap({ kind, text, assetId: kind === 'image' ? assetId : undefined, corner, frames });
    close();
  };
  return (
    <Modal title="Insert Rewind Trap" icon="eye" onClose={close} width={440} footer={<><span className="spacer" /><Button onClick={close}>Cancel</Button><Button primary onClick={plant} disabled={kind === 'image' && !assetId}>Plant trap</Button></>}>
      <div className="prop-grid">
        <span className="label">Trap</span>
        <span style={{ display: 'flex', gap: 8 }}>
          <Button sm primary={kind === 'text'} onClick={() => setKind('text')}>Text</Button>
          <Button sm primary={kind === 'image'} onClick={() => setKind('image')}>Image</Button>
        </span>
        {kind === 'text' ? (
          <>
            <span className="label">Text</span>
            <TextField value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          </>
        ) : (
          <>
            <span className="label">Image</span>
            <Select value={assetId} options={images.map((a) => ({ value: a.id, label: a.name }))} onChange={setAssetId} />
          </>
        )}
        <span className="label">Corner</span>
        <Select value={corner} options={[{ value: 'tl', label: 'Top left' }, { value: 'tr', label: 'Top right' }, { value: 'bl', label: 'Bottom left' }, { value: 'br', label: 'Bottom right' }]} onChange={(v) => setCorner(v as any)} />
        <span className="label">On screen</span>
        <Select value={frames} options={[1, 2, 3].map((n) => ({ value: n, label: `${n} frame${n === 1 ? '' : 's'}` }))} onChange={(v) => setFrames(Number(v))} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--c-text-dim)', marginTop: 10 }}>A split-second flash in the corner that viewers will rewind to catch. Kept to 1-3 frames so it registers subconsciously, not overtly.</div>
    </Modal>
  );
}

/* ============================== Dopamine Audio ============================== */

function DopamineModal({ close }: P) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Dopamine Audio" icon="wave" onClose={close} width={480} footer={<><span className="spacer" /><Button primary onClick={close}>Done</Button></>}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <Button sm onClick={() => retentionCmd.applyMusicBed()}>Set music bed to 5% (-26 dB)</Button>
        <span style={{ fontSize: 11, color: 'var(--c-text-dim)' }}>Applies to selected audio clips, or all of them when nothing is selected.</span>
      </div>
      <div style={{ fontWeight: 600, margin: '6px 0' }}>Sharp SFX</div>
      <div className="scroll-y" style={{ maxHeight: 300 }}>
        {SFX.map((s) => (
          <div key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 2px', borderBottom: '1px solid var(--c-line)' }}>
            <div style={{ flex: 1 }}>
              <strong>{s.name}</strong>
              <div style={{ fontSize: 11, color: 'var(--c-text-dim)' }}>{s.desc}</div>
            </div>
            <Button sm disabled={busy} onClick={() => { setBusy(true); void retentionCmd.addSfx(s.id).finally(() => setBusy(false)); }}>At playhead</Button>
            <Button sm ghost disabled={busy} onClick={() => { setBusy(true); void retentionCmd.addSfxToCaptions(s.id).finally(() => setBusy(false)); }}>On captions</Button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/* ============================== Infinite Loop Outro ============================== */

function LoopOutroModal({ close }: P) {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const [loopSec, setLoopSec] = useState(1);
  const [seam, setSeam] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const checkSeam = async () => {
    if (!seq) return;
    setChecking(true);
    setSeam(null);
    try {
      const D = sequenceDuration(seq);
      if (D < 2) {
        setSeam(0);
        setChecking(false);
        return;
      }
      const a = document.createElement('canvas');
      const b = document.createElement('canvas');
      await renderFrameToCanvas(project, seq, 0, a, { scale: 8 });
      await renderFrameToCanvas(project, seq, D - 1, b, { scale: 8 });
      const da = a.getContext('2d')!.getImageData(0, 0, a.width, a.height).data;
      const db = b.getContext('2d')!.getImageData(0, 0, b.width, b.height).data;
      let diff = 0;
      for (let i = 0; i < da.length; i += 4) diff += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      const max = (da.length / 4) * 3 * 255;
      setSeam(Math.round((1 - diff / Math.max(1, max)) * 100));
    } finally {
      setChecking(false);
    }
  };
  if (!seq) return null;
  return (
    <Modal title="Infinite Loop Outro" icon="loop" onClose={close} width={460} footer={<><span className="spacer" /><Button onClick={close}>Close</Button><Button primary onClick={() => { retentionCmd.makeLoopOutro(loopSec); close(); }}>Make loop outro</Button></>}>
      <div className="prop-grid">
        <span className="label">Loop section</span>
        <HotText value={loopSec} min={0.25} max={5} step={0.25} decimals={2} unit=" s" width={70} onChange={(v, c) => c && setLoopSec(v)} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--c-text-dim)', margin: '10px 0' }}>
        Duplicates the first {loopSec.toFixed(2)}s of the sequence onto the end with a crossfade, so the last sentence flows straight back into the first and the video restarts before the viewer realises it ended.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button sm onClick={() => void checkSeam()} disabled={checking}>{checking ? 'Rendering frames...' : 'Check loop seam'}</Button>
        {seam !== null ? <span style={{ fontSize: 12 }}>First and last frame are <strong>{seam}%</strong> similar{seam >= 85 ? ' - already a near-perfect loop!' : ' - the crossfade will smooth the jump.'}</span> : null}
      </div>
    </Modal>
  );
}

/* ============================== Brand Kit ============================== */

function BrandKitModal({ close }: P) {
  const seq = useActiveSequence();
  const [, force] = useState(0);
  useEffect(() => brandKits.subscribe(() => force((n) => n + 1)), []);
  const kits = brandKits.get();
  const [name, setName] = useState(seq ? `${seq.name} Brand` : 'My Brand');
  const [resize, setResize] = useState(false);
  const save = () => {
    retentionCmd.saveBrandKit(name);
  };
  const apply = (kit: BrandKit) => {
    retentionCmd.applyBrandKit(kit, resize);
    close();
  };
  return (
    <Modal title="Brand Kit" icon="template" onClose={close} width={520} footer={<><span className="spacer" /><Button primary onClick={close}>Done</Button></>}>
      <div style={{ fontSize: 12, color: 'var(--c-text-dim)', marginBottom: 10 }}>
        Algorithmic uniformity: the exact same font, colour scheme and framing in every upload builds instant recognition on the feed. A kit stores your caption style and frame size.
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <TextField value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} placeholder="Kit name" />
        <Button onClick={save} disabled={!seq}>Save current sequence</Button>
      </div>
      <Checkbox checked={resize} onChange={setResize} label="Resize the sequence to the kit's frame when applying" />
      <div className="scroll-y" style={{ maxHeight: 280, marginTop: 10 }}>
        {kits.length === 0 ? <div className="empty" style={{ padding: 16 }}>No kits yet. Style your captions, then save the sequence as a kit.</div> : null}
        {kits.map((k) => (
          <div key={k.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 2px', borderBottom: '1px solid var(--c-line)' }}>
            <div style={{ flex: 1 }}>
              <strong>{k.name}</strong>
              <div style={{ fontSize: 11, color: 'var(--c-text-dim)' }}>
                {k.captionStyle.fontFamily} {k.captionStyle.fontWeight} · {k.width}x{k.height} @ {k.fps}fps · kicker {k.captionStyle.kicker ? 'on' : 'off'}
              </div>
            </div>
            <Button sm onClick={() => apply(k)}>Apply</Button>
            <Button sm ghost danger onClick={() => retentionCmd.deleteBrandKit(k.id)}>Delete</Button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export { RetentionCheckModal, SmartCaptionsModal, RewindTrapModal, DopamineModal, LoopOutroModal, BrandKitModal };
