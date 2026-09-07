import React, { useMemo, useRef, useState } from 'react';
import { useProject, useActiveSequence, findAsset } from '../../state/projectStore';
import { useUI, toast, type ContextMenuItem } from '../../state/uiStore';
import { usePlayback } from '../../engine/playback/playback';
import { HotText, IconButton, Select, Checkbox, ColorChip, Slider, TimecodeField, Empty, useElementSize, Button } from '../controls';
import { Icon } from '../icons';
import type { Clip, Param, ParamValue, Sequence, Interpolation, EffectMask, Keyframe } from '../../types/project';
import { param as mkParam, defaultMotion, defaultClipAudio } from '../../types/project';
import { getEffectDef, type ParamDef, type EffectDef } from '../../engine/effects/registry';
import { AUDIO_EFFECT_MAP } from '../../engine/effects/audioRegistry';
import { TRANSITION_MAP } from '../../engine/effects/transitions';
import { evalParam, setKeyframe, removeKeyframe, hasKeyframeAt, nearestKeyframes, toggleAnimated, setKeyframeInterp } from '../../engine/keyframes';
import { resolveParam } from '../../app/commands';
import { setParamAt } from '../timeline/Timeline';
import { cmd } from '../../app/commands';
import { uid, hexToRgb, rgbToHex, clamp } from '../../engine/util';
import { framesToTimecode } from '../../engine/timecode';

const BLEND_MODES = ['normal', 'dissolve', 'darken', 'multiply', 'colorBurn', 'linearBurn', 'lighten', 'screen', 'colorDodge', 'linearDodge', 'overlay', 'softLight', 'hardLight', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];

/** Effect Controls: all animatable properties of the selected (or pinned) clip. */
export function EffectControlsPanel() {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const sel = useUI((s) => s.selection.clipIds);
  const pinned = useUI((s) => s.pinnedClipId);
  const setPinned = useUI((s) => s.setPinnedClipId);
  const selEffect = useUI((s) => s.selection.effectId);
  const playhead = usePlayback((s) => s.playhead);
  const showKf = useUI((s) => s.showKeyframeEditor);
  const setShowKf = useUI((s) => s.setShowKeyframeEditor);
  const [open, setOpen] = useState<Record<string, boolean>>({ motion: true, opacity: true, remap: false, audio: true });
  const [bodyRef] = useElementSize<HTMLDivElement>();

  const clipId = pinned && seq?.clips.some((c) => c.id === pinned) ? pinned : sel[0];
  const clip = seq?.clips.find((c) => c.id === clipId) ?? null;
  const track = clip ? seq!.tracks.find((t) => t.id === clip.trackId) : null;
  const isAudio = track?.kind === 'audio';
  const fps = seq?.settings.fps ?? 30;
  const local = clip ? playhead - clip.start : 0;
  const inRange = clip ? playhead >= clip.start && playhead < clip.start + clip.duration : false;

  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  if (!seq || !clip) {
    return (
      <div className="ec" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <Empty title="Effect Controls" icon="effectFx">
          Select a clip in the timeline to edit Motion, Opacity, Time Remapping, Audio and every applied effect. Values can be scrubbed by dragging; the stopwatch turns any value into a keyframed animation.
        </Empty>
      </div>
    );
  }

  const asset = clip.assetId ? findAsset(project, clip.assetId) : null;
  const write = (label: string, fn: (c: Clip, s: Sequence) => void, transient = false) => {
    const st = useProject.getState();
    const run = (p: typeof project) => {
      const s = p.sequences.find((x) => x.id === seq.id)!;
      const c = s.clips.find((x) => x.id === clip.id);
      if (c) fn(c, s);
    };
    if (transient) st.updateTransient(run);
    else st.update(label, run);
  };

  /** Set a param value at the current time (keyframe-aware). */
  const setValue = (path: string, v: ParamValue, commit: boolean, label = 'Change property') => {
    write(
      label,
      (c) => {
        const p = resolveParam(c, path) as Param | null;
        if (!p) return;
        if (p.animated) setParamAt(c, path, { ...setKeyframe(p as any, local, v as any), animated: true });
        else setParamAt(c, path, { ...p, value: v });
      },
      !commit,
    );
  };
  const beginDrag = () => useProject.getState().beginBatch('Change property');
  const endDrag = () => useProject.getState().endBatch();

  const kfActions = (path: string) => ({
    toggleAnimated: () =>
      write('Toggle animation', (c) => {
        const p = resolveParam(c, path) as Param | null;
        if (!p) return;
        setParamAt(c, path, toggleAnimated(p as any, local));
      }),
    addRemove: () =>
      write('Keyframe', (c) => {
        const p = resolveParam(c, path) as Param | null;
        if (!p) return;
        if (hasKeyframeAt(p, local)) setParamAt(c, path, removeKeyframe(p as any, local));
        else setParamAt(c, path, { ...setKeyframe(p as any, local, evalParam(p as any, local)), animated: true });
      }),
    prev: () => {
      const p = resolveParam(clip, path) as Param | null;
      if (!p) return;
      const { prev } = nearestKeyframes(p, local);
      if (prev) usePlayback.getState().setPlayhead(clip.start + prev.t, { fromUser: true });
    },
    next: () => {
      const p = resolveParam(clip, path) as Param | null;
      if (!p) return;
      const { next } = nearestKeyframes(p, local);
      if (next) usePlayback.getState().setPlayhead(clip.start + next.t, { fromUser: true });
    },
    reset: (def: ParamValue) => setValue(path, def, true, 'Reset property'),
  });

  const ctxParam = (e: React.MouseEvent, path: string, def: ParamValue) => {
    e.preventDefault();
    const p = resolveParam(clip, path) as Param | null;
    if (!p) return;
    const has = hasKeyframeAt(p, local);
    const items: ContextMenuItem[] = [
      { label: has ? 'Remove Keyframe' : 'Add Keyframe', disabled: !p.animated && !has, onSelect: kfActions(path).addRemove },
      { label: 'Reset', onSelect: () => kfActions(path).reset(def) },
      { separator: true },
      ...(['linear', 'bezier', 'easeIn', 'easeOut', 'easeInOut', 'hold'] as Interpolation[]).map((i) => ({
        label: { linear: 'Linear', bezier: 'Bezier', easeIn: 'Ease In', easeOut: 'Ease Out', easeInOut: 'Ease In and Out', hold: 'Hold' }[i],
        disabled: !has,
        checked: has && p.keyframes?.find((k) => k.t === local)?.interp === i,
        onSelect: () => write('Keyframe interpolation', (c) => setParamAt(c, path, setKeyframeInterp(resolveParam(c, path) as any, local, i))),
      })),
      { separator: true },
      { label: 'Clear All Keyframes', disabled: !p.keyframes?.length, onSelect: () => write('Clear keyframes', (c) => setParamAt(c, path, { value: evalParam(p as any, local), keyframes: [], animated: false })) },
    ];
    useUI.getState().openContextMenu(e.clientX, e.clientY, items);
  };

  const rowProps = (path: string, def: ParamValue, keyframable = true) => {
    const p = resolveParam(clip, path) as Param | null;
    return { path, p, def, local, keyframable: keyframable && !!p, actions: kfActions(path), onContext: (e: React.MouseEvent) => ctxParam(e, path, def) };
  };

  const remapHasRamp = !!clip.timeRemap?.length;
  const groups: { key: string; title: string; kind: 'motion' | 'opacity' | 'remap' | 'audio' | 'fx'; fx?: Clip['effects'][number]; def?: EffectDef }[] = [];
  if (!isAudio) {
    groups.push({ key: 'motion', title: 'Motion', kind: 'motion' });
    groups.push({ key: 'opacity', title: 'Opacity', kind: 'opacity' });
    if (asset?.kind === 'video' || clip.nestedSequenceId) groups.push({ key: 'remap', title: 'Time Remapping', kind: 'remap' });
  } else {
    groups.push({ key: 'audio', title: 'Volume', kind: 'audio' });
  }
  for (const fx of clip.effects) {
    const def = getEffectDef(fx.type) ?? AUDIO_EFFECT_MAP[fx.type];
    if (def) groups.push({ key: fx.id, title: def.name, kind: 'fx', fx, def });
  }

  const ctxEffect = (e: React.MouseEvent, fx: Clip['effects'][number]) => {
    e.preventDefault();
    e.stopPropagation();
    const idx = clip.effects.indexOf(fx);
    useUI.getState().openContextMenu(e.clientX, e.clientY, [
      { label: fx.enabled ? 'Disable Effect' : 'Enable Effect', onSelect: () => write('Toggle effect', (c) => { const f = c.effects.find((x) => x.id === fx.id); if (f) f.enabled = !f.enabled; }) },
      { label: 'Reset Effect', onSelect: () => write('Reset effect', (c) => { const f = c.effects.find((x) => x.id === fx.id); const d = getEffectDef(fx.type) ?? AUDIO_EFFECT_MAP[fx.type]; if (f && d) for (const pd of d.params) f.params[pd.key] = mkParam(pd.default as ParamValue); }) },
      { separator: true },
      { label: 'Move Up', disabled: idx === 0, onSelect: () => write('Reorder effects', (c) => { const i = c.effects.findIndex((x) => x.id === fx.id); if (i > 0) { const [f] = c.effects.splice(i, 1); c.effects.splice(i - 1, 0, f); } }) },
      { label: 'Move Down', disabled: idx === clip.effects.length - 1, onSelect: () => write('Reorder effects', (c) => { const i = c.effects.findIndex((x) => x.id === fx.id); if (i < c.effects.length - 1) { const [f] = c.effects.splice(i, 1); c.effects.splice(i + 1, 0, f); } }) },
      { separator: true },
      { label: 'Copy Effect', onSelect: () => { cmd.copyEffect(clip.id, fx.id); } },
      { label: 'Remove Effect', shortcut: 'Delete', danger: true, onSelect: () => write('Remove effect', (c) => { c.effects = c.effects.filter((x) => x.id !== fx.id); }) },
    ]);
  };

  const timeRemapUI = (
    <>
      <div className="ec-row" style={{ paddingLeft: 22 }}>
        <span className="ec-name">Speed</span>
        <div className="ec-value">
          <HotText value={remapHasRamp ? evalRemap(clip, local) : clip.speed * 100} min={1} max={2000} step={1} unit="%" width={64} onChange={(v, commit) => {
            if (remapHasRamp) {
              write('Speed keyframe', (c) => {
                const kfs = c.timeRemap!.filter((k) => k.t !== local);
                kfs.push({ t: local, v, interp: 'linear' });
                kfs.sort((a, b) => a.t - b.t);
                c.timeRemap = kfs;
              }, !commit);
            } else if (commit) cmd.setSpeed(v / 100, clip.reversed, false, clip.maintainPitch);
          }} />
          <span className="kfnav">
            <IconButton icon="kfPrev" label="Previous speed keyframe" sm noline onClick={() => { const prev = [...(clip.timeRemap ?? [])].reverse().find((k) => k.t < local); if (prev) usePlayback.getState().setPlayhead(clip.start + prev.t, { fromUser: true }); }} />
            <IconButton icon="keyframe" label={clip.timeRemap?.some((k) => k.t === local) ? 'Remove speed keyframe' : 'Add speed keyframe'} sm noline on={clip.timeRemap?.some((k) => k.t === local)} onClick={() => write('Speed keyframe', (c) => {
              const kfs = c.timeRemap ?? [{ t: 0, v: c.speed * 100, interp: 'linear' as const }];
              if (kfs.some((k) => k.t === local)) c.timeRemap = kfs.filter((k) => k.t !== local);
              else { kfs.push({ t: local, v: evalRemap(c, local), interp: 'linear' }); kfs.sort((a, b) => a.t - b.t); c.timeRemap = kfs; }
              if (c.timeRemap && c.timeRemap.length < 2) c.timeRemap = undefined;
            })} />
            <IconButton icon="kfNext" label="Next speed keyframe" sm noline onClick={() => { const next = (clip.timeRemap ?? []).find((k) => k.t > local); if (next) usePlayback.getState().setPlayhead(clip.start + next.t, { fromUser: true }); }} />
          </span>
        </div>
      </div>
      <div className="ec-row" style={{ paddingLeft: 22 }}>
        <span className="ec-name">Reverse</span>
        <div className="ec-value"><Checkbox checked={clip.reversed} onChange={(v) => cmd.setSpeed(clip.speed, v, false, clip.maintainPitch)} /></div>
      </div>
      <div className="ec-row" style={{ paddingLeft: 22 }}>
        <span className="ec-name">Frame Hold</span>
        <div className="ec-value">
          <Checkbox checked={clip.freezeAt != null} onChange={() => cmd.frameHold()} label={clip.freezeAt != null ? `at ${clip.freezeAt.toFixed(2)}s` : undefined} />
        </div>
      </div>
      {remapHasRamp ? (
        <div className="ec-row" style={{ paddingLeft: 22 }}>
          <span className="ec-name sub" style={{ paddingLeft: 0 }}>{clip.timeRemap!.length} speed keyframes</span>
          <div className="ec-value"><Button sm onClick={() => write('Clear speed ramp', (c) => { c.timeRemap = undefined; })}>Clear ramp</Button></div>
        </div>
      ) : null}
    </>
  );

  return (
    <div className="ec" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="ec-head">
        <span>{seq.name}</span>
        <Icon name="chevronRight" size={10} />
        <span className="clip-title" title={clip.name}>{clip.name}</span>
        <IconButton icon="pin" label={pinned === clip.id ? 'Unpin clip' : 'Pin this clip (keep it shown when selection changes)'} sm on={pinned === clip.id} onClick={() => setPinned(pinned === clip.id ? null : clip.id)} />
        <span className="spacer" />
        {!inRange ? <span style={{ color: 'var(--c-warn)' }} title="The playhead is outside this clip; keyframes will be added relative to its start">Playhead outside clip</span> : null}
        <TimecodeField frames={clamp(local, 0, clip.duration)} fps={fps} muted title="Time within clip" />
        <IconButton icon="keyframe" label="Show/hide keyframe lane" sm on={showKf} onClick={() => setShowKf(!showKf)} />
      </div>
      <div className="ec-body" ref={bodyRef}>
        <div className="ec-props scroll-y">
          {groups.map((g) => {
            const isOpen = open[g.key] ?? true;
            const enabled = g.fx ? g.fx.enabled : true;
            return (
              <React.Fragment key={g.key}>
                <div className={`ec-row group-row ${selEffect === g.key ? 'selected' : ''}`} onClick={() => useUI.getState().setSelection({ effectId: g.fx ? g.fx.id : null })} onContextMenu={g.fx ? (e) => ctxEffect(e, g.fx!) : undefined} style={selEffect === g.key ? { background: '#2a3a52' } : undefined}>
                  <IconButton icon={isOpen ? 'chevronDown' : 'chevronRight'} label={isOpen ? 'Collapse' : 'Expand'} sm noline onClick={(e) => { e.stopPropagation(); toggle(g.key); }} />
                  <span className="ec-name">
                    <Icon name={g.kind === 'fx' ? (g.def?.audio ? 'clipAudio' : 'effectFx') : g.kind === 'audio' ? 'volume' : g.kind === 'remap' ? 'clock' : 'transform'} size={11} style={{ marginRight: 5, color: 'var(--c-text-dim)', verticalAlign: -2 }} />
                    {g.title}
                    {g.fx && !g.fx.enabled ? <span style={{ color: 'var(--c-text-faint)', marginLeft: 6 }}>(off)</span> : null}
                  </span>
                  <div className="ec-value">
                    {g.kind === 'fx' && g.fx ? (
                      <>
                        {!g.def?.audio ? <IconButton icon="mask" label="Add ellipse mask" sm noline onClick={(e) => { e.stopPropagation(); addMask(g.fx!.id, 'ellipse'); }} /> : null}
                        {!g.def?.audio ? <IconButton icon="maskRect" label="Add rectangle mask" sm noline onClick={(e) => { e.stopPropagation(); addMask(g.fx!.id, 'rectangle'); }} /> : null}
                        <IconButton icon={enabled ? 'fxOn' : 'fxOff'} label={enabled ? 'Disable effect' : 'Enable effect'} sm noline on={enabled} onClick={(e) => { e.stopPropagation(); write('Toggle effect', (c) => { const f = c.effects.find((x) => x.id === g.fx!.id); if (f) f.enabled = !f.enabled; }); }} />
                        <IconButton icon="reset" label="Reset effect" sm noline onClick={(e) => { e.stopPropagation(); write('Reset effect', (c) => { const f = c.effects.find((x) => x.id === g.fx!.id); if (f && g.def) for (const pd of g.def.params) f.params[pd.key] = mkParam(pd.default as ParamValue); }); }} />
                        <IconButton icon="close" label="Remove effect" sm noline onClick={(e) => { e.stopPropagation(); write('Remove effect', (c) => { c.effects = c.effects.filter((x) => x.id !== g.fx!.id); }); }} />
                      </>
                    ) : g.kind === 'motion' ? (
                      <IconButton icon="reset" label="Reset motion" sm noline onClick={(e) => { e.stopPropagation(); write('Reset motion', (c) => { c.motion = { ...defaultMotion(), opacity: c.motion.opacity, blendMode: c.motion.blendMode }; }); }} />
                    ) : g.kind === 'audio' ? (
                      <IconButton icon="reset" label="Reset volume" sm noline onClick={(e) => { e.stopPropagation(); write('Reset audio', (c) => { c.audio = { ...defaultClipAudio(), channelMode: c.audio.channelMode }; }); }} />
                    ) : null}
                  </div>
                </div>
                {isOpen ? (
                  <div style={{ opacity: enabled ? 1 : 0.5 }}>
                    {g.kind === 'motion' ? (
                      <>
                        <PointRow label="Position" {...rowProps('motion.position', [0.5, 0.5])} scale={[seq.settings.width, seq.settings.height]} onChange={(v, c) => setValue('motion.position', v, c, 'Position')} onBegin={beginDrag} onEnd={endDrag} />
                        <NumRow label="Scale" {...rowProps('motion.scale', 100)} min={0} max={10000} softMax={400} step={0.5} unit="%" onChange={(v, c) => setValue('motion.scale', v, c, 'Scale')} onBegin={beginDrag} onEnd={endDrag} slider />
                        {!clip.motion.uniformScale ? <NumRow label="Scale Width" {...rowProps('motion.scaleWidth', 100)} min={0} max={10000} softMax={400} step={0.5} unit="%" onChange={(v, c) => setValue('motion.scaleWidth', v, c, 'Scale width')} onBegin={beginDrag} onEnd={endDrag} slider /> : null}
                        <div className="ec-row"><span className="ec-name sub">Uniform Scale</span><div className="ec-value"><Checkbox checked={clip.motion.uniformScale} onChange={(v) => write('Uniform scale', (c) => { c.motion.uniformScale = v; if (v) c.motion.scaleWidth = { ...c.motion.scale }; })} /></div></div>
                        <NumRow label="Rotation" {...rowProps('motion.rotation', 0)} min={-36000} max={36000} softMin={-180} softMax={180} step={0.5} unit="°" format={fmtRotation} onChange={(v, c) => setValue('motion.rotation', v, c, 'Rotation')} onBegin={beginDrag} onEnd={endDrag} slider />
                        <PointRow label="Anchor Point" {...rowProps('motion.anchor', [0.5, 0.5])} scale={[asset?.width ?? seq.settings.width, asset?.height ?? seq.settings.height]} onChange={(v, c) => setValue('motion.anchor', v, c, 'Anchor point')} onBegin={beginDrag} onEnd={endDrag} />
                        <NumRow label="Anti-flicker Filter" {...rowProps('motion.antiFlicker', 0)} min={0} max={1} step={0.01} onChange={(v, c) => setValue('motion.antiFlicker', v, c, 'Anti-flicker')} onBegin={beginDrag} onEnd={endDrag} />
                        <div className="ec-row"><span className="ec-name sub">Fit</span><div className="ec-value"><Button sm onClick={() => cmd.scaleToFrame([clip.id], 'fit')}>Scale to Frame Size</Button><Button sm onClick={() => cmd.scaleToFrame([clip.id], 'fill')}>Fill Frame</Button></div></div>
                      </>
                    ) : null}
                    {g.kind === 'opacity' ? (
                      <>
                        <NumRow label="Opacity" {...rowProps('motion.opacity', 100)} min={0} max={100} step={0.5} unit="%" onChange={(v, c) => setValue('motion.opacity', v, c, 'Opacity')} onBegin={beginDrag} onEnd={endDrag} slider />
                        <div className="ec-row">
                          <span className="ec-name sub">Blend Mode</span>
                          <div className="ec-value">
                            <Select value={clip.motion.blendMode} options={BLEND_MODES.map((b) => ({ value: b, label: b.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase()) }))} onChange={(v) => write('Blend mode', (c) => { c.motion.blendMode = v as any; })} style={{ width: 120 }} />
                          </div>
                        </div>
                      </>
                    ) : null}
                    {g.kind === 'remap' ? timeRemapUI : null}
                    {g.kind === 'audio' ? (
                      <>
                        <NumRow label="Level" {...rowProps('audio.volume', 0)} min={-96} max={15} softMin={-48} step={0.1} unit=" dB" onChange={(v, c) => setValue('audio.volume', v, c, 'Volume')} onBegin={beginDrag} onEnd={endDrag} slider />
                        <NumRow label="Pan" {...rowProps('audio.pan', 0)} min={-100} max={100} step={1} onChange={(v, c) => setValue('audio.pan', v, c, 'Pan')} onBegin={beginDrag} onEnd={endDrag} slider format={(v) => (v === 0 ? 'C' : v < 0 ? `L${Math.abs(v).toFixed(0)}` : `R${v.toFixed(0)}`)} />
                        <div className="ec-row"><span className="ec-name sub">Gain</span><div className="ec-value"><HotText value={clip.audio.gain} min={-96} max={96} step={0.1} unit=" dB" width={70} onChange={(v, c) => { if (c) write('Gain', (x) => { x.audio.gain = v; }); }} /><Button sm onClick={() => cmd.audioGain()}>Audio Gain...</Button></div></div>
                        <div className="ec-row"><span className="ec-name sub">Channels</span><div className="ec-value"><Select value={clip.audio.channelMode} options={[{ value: 'stereo', label: 'Stereo' }, { value: 'left', label: 'Left only' }, { value: 'right', label: 'Right only' }, { value: 'swap', label: 'Swap L/R' }, { value: 'mono', label: 'Mono sum' }]} onChange={(v) => write('Channel mode', (c) => { c.audio.channelMode = v as any; })} style={{ width: 100 }} /></div></div>
                        <div className="ec-row"><span className="ec-name sub">Invert Phase</span><div className="ec-value"><Checkbox checked={clip.audio.invertPhase} onChange={(v) => write('Invert phase', (c) => { c.audio.invertPhase = v; })} /></div></div>
                        <div className="ec-row"><span className="ec-name sub">Maintain Pitch</span><div className="ec-value"><Checkbox checked={clip.maintainPitch} onChange={(v) => write('Maintain pitch', (c) => { c.maintainPitch = v; })} title="Keep pitch when the clip speed is changed" /></div></div>
                      </>
                    ) : null}
                    {g.kind === 'fx' && g.fx && g.def ? <EffectParams clip={clip} fx={g.fx} def={g.def} rowProps={rowProps} setValue={setValue} beginDrag={beginDrag} endDrag={endDrag} write={write} seq={seq} /> : null}
                  </div>
                ) : null}
              </React.Fragment>
            );
          })}
          {(clip.transitionIn || clip.transitionOut) && (
            <>
              <div className="ec-row group-row"><span className="ec-name"><Icon name="transition" size={11} style={{ marginRight: 5, color: 'var(--c-text-dim)', verticalAlign: -2 }} />Transitions</span></div>
              {(['in', 'out'] as const).map((edge) => {
                const t = edge === 'in' ? clip.transitionIn : clip.transitionOut;
                if (!t) return null;
                const tdef = TRANSITION_MAP[t.type];
                return (
                  <React.Fragment key={edge}>
                    <div className="ec-row">
                      <span className="ec-name sub">{edge === 'in' ? 'Start' : 'End'}: {tdef?.name ?? t.type}</span>
                      <div className="ec-value">
                        <HotText value={t.duration} min={1} max={clip.duration} step={1} unit=" f" width={50} onChange={(v, c) => { if (c) write('Transition duration', (x) => { const tr = edge === 'in' ? x.transitionIn : x.transitionOut; if (tr) tr.duration = Math.round(v); }); }} />
                        <Select value={t.alignment} options={[{ value: 'start', label: 'Start at cut' }, { value: 'center', label: 'Center at cut' }, { value: 'end', label: 'End at cut' }]} onChange={(v) => write('Transition alignment', (x) => { const tr = edge === 'in' ? x.transitionIn : x.transitionOut; if (tr) tr.alignment = v as any; })} style={{ width: 100 }} />
                        <IconButton icon="close" label="Remove transition" sm noline onClick={() => write('Remove transition', (x) => { if (edge === 'in') x.transitionIn = null; else x.transitionOut = null; })} />
                      </div>
                    </div>
                    {tdef?.params.filter((pd) => !pd.hidden).map((pd) => (
                      <TransitionParamRow key={pd.key} pd={pd} value={t.params[pd.key]?.value ?? pd.default} onChange={(v, c) => write('Transition parameter', (x) => { const tr = edge === 'in' ? x.transitionIn : x.transitionOut; if (tr) tr.params[pd.key] = mkParam(v); }, !c)} />
                    ))}
                  </React.Fragment>
                );
              })}
            </>
          )}
          <div className="ec-row" style={{ borderBottom: 0, justifyContent: 'flex-end', color: 'var(--c-text-faint)', fontSize: 11 }}>
            <span>{clip.effects.length} effect{clip.effects.length === 1 ? '' : 's'} - drag more from the Effects panel</span>
          </div>
        </div>
        {showKf ? <KeyframeLane clip={clip} seq={seq} groups={groups} open={open} fps={fps} /> : null}
      </div>
    </div>
  );

  function addMask(fxId: string, shape: EffectMask['shape']) {
    write('Add mask', (c) => {
      const f = c.effects.find((x) => x.id === fxId);
      if (!f) return;
      f.masks.push({ id: uid('mask'), name: `Mask (${f.masks.length + 1})`, shape, center: mkParam([0.5, 0.5]), size: mkParam(shape === 'rectangle' ? [0.5, 0.5] : [0.4, 0.4]), rotation: mkParam(0), feather: mkParam(10), opacity: mkParam(100), expansion: mkParam(0), inverted: false });
    });
    setOpen((o) => ({ ...o, [fxId]: true }));
  }
}

function evalRemap(clip: Clip, local: number) {
  const kfs = clip.timeRemap;
  if (!kfs?.length) return clip.speed * 100;
  if (local <= kfs[0].t) return kfs[0].v;
  for (let i = 1; i < kfs.length; i++) {
    if (local <= kfs[i].t) {
      const a = kfs[i - 1],
        b = kfs[i];
      const f = b.t === a.t ? 1 : (local - a.t) / (b.t - a.t);
      return a.v + (b.v - a.v) * f;
    }
  }
  return kfs[kfs.length - 1].v;
}

const fmtRotation = (v: number) => {
  const turns = Math.trunc(v / 360);
  const rem = v - turns * 360;
  return turns ? `${turns}x${rem.toFixed(1)}°` : `${v.toFixed(1)}°`;
};

interface BaseRow {
  label: string;
  path: string;
  p: Param | null;
  def: ParamValue;
  local: number;
  keyframable: boolean;
  actions: { toggleAnimated: () => void; addRemove: () => void; prev: () => void; next: () => void; reset: (d: ParamValue) => void };
  onContext: (e: React.MouseEvent) => void;
  onBegin: () => void;
  onEnd: () => void;
  sub?: boolean;
}

function KfControls({ p, local, actions, keyframable }: Pick<BaseRow, 'p' | 'local' | 'actions' | 'keyframable'>) {
  if (!p) return null;
  const animated = !!p.animated;
  const has = hasKeyframeAt(p, local);
  const { prev, next } = nearestKeyframes(p, local);
  return (
    <>
      {keyframable ? (
        <button type="button" className={`ibtn sm noline stopwatch ${animated ? 'on' : ''}`} title={animated ? 'Stop animating (removes keyframes)' : 'Toggle animation (adds a keyframe at the playhead)'} onClick={actions.toggleAnimated} aria-pressed={animated}>
          <Icon name="stopwatch" size={11} />
        </button>
      ) : (
        <span style={{ width: 16 }} />
      )}
      {animated ? (
        <span className="kfnav">
          <IconButton icon="kfPrev" label="Previous keyframe" sm noline disabled={!prev} onClick={actions.prev} />
          <IconButton icon="keyframe" label={has ? 'Remove keyframe' : 'Add keyframe'} sm noline on={has} onClick={actions.addRemove} />
          <IconButton icon="kfNext" label="Next keyframe" sm noline disabled={!next} onClick={actions.next} />
        </span>
      ) : (
        <span style={{ width: 48 }} />
      )}
    </>
  );
}

function NumRow(props: BaseRow & { min: number; max: number; softMin?: number; softMax?: number; step: number; unit?: string; format?: (v: number) => string; onChange: (v: number, commit: boolean) => void; slider?: boolean }) {
  const { label, p, local, def, actions, onContext, min, max, softMin, softMax, step, unit, format, onChange, onBegin, onEnd, slider, sub = true } = props;
  const [sliderOpen, setSliderOpen] = useState(false);
  if (!p) return null;
  const v = evalParam(p as Param<number>, local);
  const isDefault = !p.animated && v === def;
  return (
    <>
      <div className="ec-row" onContextMenu={onContext}>
        <KfControls p={p} local={local} actions={actions} keyframable={props.keyframable} />
        {slider ? <IconButton icon={sliderOpen ? 'chevronDown' : 'chevronRight'} label="Show slider" sm noline onClick={() => setSliderOpen(!sliderOpen)} /> : <span style={{ width: 16 }} />}
        <span className={`ec-name ${sub ? '' : ''}`} style={{ color: sub ? 'var(--c-text-dim)' : undefined }}>{label}</span>
        <div className="ec-value">
          <HotText value={v} min={min} max={max} step={step} unit={unit} format={format} width={76} onChange={onChange} onBeginDrag={onBegin} onEndDrag={onEnd} />
          <button type="button" className="ibtn sm noline ec-reset" title="Reset to default" onClick={() => actions.reset(def)} style={{ visibility: isDefault ? 'hidden' : 'visible' }}><Icon name="reset" size={10} /></button>
        </div>
      </div>
      {slider && sliderOpen ? (
        <div className="ec-slider-row">
          <span className="lim">{format ? format(softMin ?? min) : softMin ?? min}</span>
          <Slider value={v} min={softMin ?? min} max={softMax ?? max} step={step} onChange={onChange} onBegin={onBegin} onEnd={onEnd} style={{ flex: 1 }} />
          <span className="lim">{format ? format(softMax ?? max) : softMax ?? max}</span>
        </div>
      ) : null}
    </>
  );
}

function PointRow(props: BaseRow & { scale: [number, number]; onChange: (v: [number, number], commit: boolean) => void }) {
  const { label, p, local, def, actions, onContext, scale, onChange, onBegin, onEnd } = props;
  if (!p) return null;
  const v = evalParam(p as Param<[number, number]>, local);
  const isDefault = !p.animated && v[0] === (def as number[])[0] && v[1] === (def as number[])[1];
  return (
    <div className="ec-row" onContextMenu={onContext}>
      <KfControls p={p} local={local} actions={actions} keyframable={props.keyframable} />
      <span style={{ width: 16 }} />
      <span className="ec-name" style={{ color: 'var(--c-text-dim)' }}>{label}</span>
      <div className="ec-value">
        <HotText value={v[0] * scale[0]} step={1} decimals={1} width={64} onChange={(x, c) => onChange([x / scale[0], v[1]], c)} onBeginDrag={onBegin} onEndDrag={onEnd} />
        <HotText value={v[1] * scale[1]} step={1} decimals={1} width={64} onChange={(y, c) => onChange([v[0], y / scale[1]], c)} onBeginDrag={onBegin} onEndDrag={onEnd} />
        <button type="button" className="ibtn sm noline ec-reset" title="Reset to default" onClick={() => actions.reset(def)} style={{ visibility: isDefault ? 'hidden' : 'visible' }}><Icon name="reset" size={10} /></button>
      </div>
    </div>
  );
}

function ColorRow(props: BaseRow & { onChange: (v: [number, number, number, number], commit: boolean) => void }) {
  const { label, p, local, def, actions, onContext, onChange } = props;
  if (!p) return null;
  let v = evalParam(p as Param<any>, local) as any;
  if (typeof v === 'string') {
    const [r, g, b] = hexToRgb(v);
    v = [r, g, b, 1];
  }
  const hex = rgbToHex(v[0], v[1], v[2]);
  return (
    <div className="ec-row" onContextMenu={onContext}>
      <KfControls p={p} local={local} actions={actions} keyframable={props.keyframable} />
      <span style={{ width: 16 }} />
      <span className="ec-name" style={{ color: 'var(--c-text-dim)' }}>{label}</span>
      <div className="ec-value">
        <ColorChip color={hex} onChange={(h, c) => { const [r, g, b] = hexToRgb(h); onChange([r, g, b, v[3] ?? 1], c); }} alpha={v[3] ?? 1} onAlpha={(a) => onChange([v[0], v[1], v[2], a], true)} />
        <button type="button" className="ibtn sm noline ec-reset" title="Reset to default" onClick={() => actions.reset(def)}><Icon name="reset" size={10} /></button>
      </div>
    </div>
  );
}

function EffectParams({ clip, fx, def, rowProps, setValue, beginDrag, endDrag, write, seq }: { clip: Clip; fx: Clip['effects'][number]; def: EffectDef; rowProps: (path: string, def: ParamValue, keyframable?: boolean) => any; setValue: (path: string, v: ParamValue, commit: boolean, label?: string) => void; beginDrag: () => void; endDrag: () => void; write: (label: string, fn: (c: Clip, s: Sequence) => void, transient?: boolean) => void; seq: Sequence }) {
  const groups: { name: string | undefined; params: ParamDef[] }[] = [];
  for (const pd of def.params) {
    if (pd.hidden) continue;
    let g = groups.find((x) => x.name === pd.group);
    if (!g) groups.push((g = { name: pd.group, params: [] }));
    g.params.push(pd);
  }
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const preset = def.presets?.length ? (
    <div className="ec-row">
      <span className="ec-name sub">Preset</span>
      <div className="ec-value">
        <Select value="" options={[{ value: '', label: 'Choose...' }, ...def.presets.map((p) => ({ value: p.name, label: p.name }))]} onChange={(name) => { const pr = def.presets!.find((p) => p.name === name); if (pr) write(`Preset ${pr.name}`, (c) => { const f = c.effects.find((x) => x.id === fx.id); if (f) for (const [k, v] of Object.entries(pr.values)) f.params[k] = mkParam(v); }); }} style={{ width: 140 }} />
      </div>
    </div>
  ) : null;
  return (
    <>
      {preset}
      {groups.map((g, gi) => {
        const gOpen = g.name ? (openGroups[g.name] ?? gi === 0) : true;
        return (
          <React.Fragment key={g.name ?? '_'}>
            {g.name ? (
              <div className="ec-row" style={{ paddingLeft: 20, cursor: 'default' }} onClick={() => setOpenGroups((o) => ({ ...o, [g.name!]: !gOpen }))}>
                <Icon name={gOpen ? 'chevronDown' : 'chevronRight'} size={10} />
                <span className="ec-name" style={{ fontWeight: 460 }}>{g.name}</span>
              </div>
            ) : null}
            {gOpen
              ? g.params.map((pd) => {
                  const path = `fx.${fx.id}.${pd.key}`;
                  const common = { ...rowProps(path, pd.default), label: pd.label, onBegin: beginDrag, onEnd: endDrag } as BaseRow;
                  switch (pd.kind) {
                    case 'number':
                    case 'percent':
                    case 'angle':
                      return <NumRow key={pd.key} {...common} min={pd.min ?? -1e9} max={pd.max ?? 1e9} softMin={pd.softMin} softMax={pd.softMax} step={pd.step ?? 0.1} unit={pd.unit} format={pd.kind === 'angle' ? fmtRotation : undefined} onChange={(v, c) => setValue(path, v, c, pd.label)} slider />;
                    case 'color':
                      return <ColorRow key={pd.key} {...common} onChange={(v, c) => setValue(path, v, c, pd.label)} />;
                    case 'point':
                      return <PointRow key={pd.key} {...common} scale={[seq.settings.width, seq.settings.height]} onChange={(v, c) => setValue(path, v, c, pd.label)} />;
                    case 'bool': {
                      const p = resolveParam(clip, path) as Param<boolean> | null;
                      return (
                        <div key={pd.key} className="ec-row">
                          <span style={{ width: 16 }} /><span style={{ width: 48 }} /><span style={{ width: 16 }} />
                          <span className="ec-name" style={{ color: 'var(--c-text-dim)' }}>{pd.label}</span>
                          <div className="ec-value"><Checkbox checked={!!(p ? evalParam(p, common.local) : pd.default)} onChange={(v) => setValue(path, v, true, pd.label)} /></div>
                        </div>
                      );
                    }
                    case 'select': {
                      const p = resolveParam(clip, path) as Param<number | string> | null;
                      const cur = p ? evalParam(p, common.local) : (pd.default as number | string);
                      return (
                        <div key={pd.key} className="ec-row">
                          <span style={{ width: 16 }} /><span style={{ width: 48 }} /><span style={{ width: 16 }} />
                          <span className="ec-name" style={{ color: 'var(--c-text-dim)' }}>{pd.label}</span>
                          <div className="ec-value">
                            <Select value={String(cur)} options={(pd.options ?? []).map((o) => ({ value: String(o.value), label: o.label }))} onChange={(v) => setValue(path, typeof (pd.options?.[0]?.value) === 'number' ? Number(v) : v, true, pd.label)} style={{ width: 140 }} />
                          </div>
                        </div>
                      );
                    }
                    case 'curve': {
                      const p = resolveParam(clip, path) as Param<number[]> | null;
                      const pts = (p ? (evalParam(p, common.local) as number[]) : (pd.default as number[])) ?? [];
                      return <CurveRow key={pd.key} label={pd.label} points={pts} onChange={(v, c) => setValue(path, v, c, pd.label)} onBegin={beginDrag} onEnd={endDrag} />;
                    }
                    default:
                      return null;
                  }
                })
              : null}
          </React.Fragment>
        );
      })}
      {fx.masks.map((m) => (
        <MaskRows key={m.id} clip={clip} fx={fx} mask={m} rowProps={rowProps} setValue={setValue} beginDrag={beginDrag} endDrag={endDrag} write={write} />
      ))}
    </>
  );
}

function MaskRows({ fx, mask, rowProps, setValue, beginDrag, endDrag, write }: { clip: Clip; fx: Clip['effects'][number]; mask: EffectMask; rowProps: (path: string, def: ParamValue, keyframable?: boolean) => any; setValue: (path: string, v: ParamValue, commit: boolean, label?: string) => void; beginDrag: () => void; endDrag: () => void; write: (label: string, fn: (c: Clip, s: Sequence) => void, transient?: boolean) => void }) {
  const [open, setOpen] = useState(true);
  const base = `fx.${fx.id}.mask.${mask.id}`;
  const selected = useUI((s) => s.selection.effectId) === `${fx.id}:${mask.id}`;
  return (
    <>
      <div className="ec-row" style={{ paddingLeft: 20, background: selected ? '#2a3a52' : undefined }} onClick={() => useUI.getState().setSelection({ effectId: `${fx.id}:${mask.id}` })}>
        <IconButton icon={open ? 'chevronDown' : 'chevronRight'} label="Toggle" sm noline onClick={(e) => { e.stopPropagation(); setOpen(!open); }} />
        <Icon name={mask.shape === 'ellipse' ? 'mask' : 'maskRect'} size={11} />
        <span className="ec-name" style={{ fontWeight: 460 }}>{mask.name}</span>
        <div className="ec-value">
          <Checkbox checked={mask.inverted} onChange={(v) => write('Invert mask', (c) => { const m = c.effects.find((x) => x.id === fx.id)?.masks.find((x) => x.id === mask.id); if (m) m.inverted = v; })} label="Inverted" />
          <IconButton icon="close" label="Remove mask" sm noline onClick={() => write('Remove mask', (c) => { const f = c.effects.find((x) => x.id === fx.id); if (f) f.masks = f.masks.filter((x) => x.id !== mask.id); })} />
        </div>
      </div>
      {open ? (
        <>
          <PointRow label="Mask Center" {...rowProps(`${base}.center`, [0.5, 0.5])} scale={[100, 100]} onChange={(v, c) => setValue(`${base}.center`, v, c, 'Mask center')} onBegin={beginDrag} onEnd={endDrag} />
          <PointRow label="Mask Size" {...rowProps(`${base}.size`, [0.4, 0.4])} scale={[100, 100]} onChange={(v, c) => setValue(`${base}.size`, v, c, 'Mask size')} onBegin={beginDrag} onEnd={endDrag} />
          <NumRow label="Mask Rotation" {...rowProps(`${base}.rotation`, 0)} min={-3600} max={3600} softMin={-180} softMax={180} step={0.5} unit="°" onChange={(v, c) => setValue(`${base}.rotation`, v, c, 'Mask rotation')} onBegin={beginDrag} onEnd={endDrag} slider />
          <NumRow label="Mask Feather" {...rowProps(`${base}.feather`, 10)} min={0} max={500} softMax={200} step={0.5} onChange={(v, c) => setValue(`${base}.feather`, v, c, 'Mask feather')} onBegin={beginDrag} onEnd={endDrag} slider />
          <NumRow label="Mask Opacity" {...rowProps(`${base}.opacity`, 100)} min={0} max={100} step={0.5} unit="%" onChange={(v, c) => setValue(`${base}.opacity`, v, c, 'Mask opacity')} onBegin={beginDrag} onEnd={endDrag} slider />
          <NumRow label="Mask Expansion" {...rowProps(`${base}.expansion`, 0)} min={-500} max={500} softMin={-100} softMax={100} step={0.5} onChange={(v, c) => setValue(`${base}.expansion`, v, c, 'Mask expansion')} onBegin={beginDrag} onEnd={endDrag} slider />
        </>
      ) : null}
    </>
  );
}

function TransitionParamRow({ pd, value, onChange }: { pd: ParamDef; value: ParamValue; onChange: (v: ParamValue, commit: boolean) => void }) {
  return (
    <div className="ec-row">
      <span className="ec-name sub" style={{ paddingLeft: 36 }}>{pd.label}</span>
      <div className="ec-value">
        {pd.kind === 'bool' ? (
          <Checkbox checked={!!value} onChange={(v) => onChange(v, true)} />
        ) : pd.kind === 'select' ? (
          <Select value={String(value)} options={(pd.options ?? []).map((o) => ({ value: String(o.value), label: o.label }))} onChange={(v) => onChange(Number(v), true)} style={{ width: 130 }} />
        ) : pd.kind === 'color' ? (
          <ColorChip color={Array.isArray(value) && value.length >= 3 ? rgbToHex(value[0] as number, value[1] as number, value[2] as number) : String(value)} onChange={(h, c) => { const [r, g, b] = hexToRgb(h); onChange([r, g, b, 1], c); }} />
        ) : (
          <HotText value={Number(value)} min={pd.min} max={pd.max} step={pd.step ?? 0.1} unit={pd.unit} width={70} onChange={(v, c) => onChange(v, c)} />
        )}
      </div>
    </div>
  );
}

/** RGB curve editor for curve params (flat array of x,y pairs 0..1). */
function CurveRow({ label, points, onChange, onBegin, onEnd }: { label: string; points: number[]; onChange: (v: number[], commit: boolean) => void; onBegin: () => void; onEnd: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const W = 160,
    H = 120;
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < points.length; i += 2) pts.push([points[i], points[i + 1]]);
  if (pts.length < 2) pts.splice(0, pts.length, [0, 0], [1, 1]);
  const toXY = (p: [number, number]) => [p[0] * W, (1 - p[1]) * H] as const;
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${toXY(p)[0]},${toXY(p)[1]}`).join(' ');
  const down = (e: React.PointerEvent, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const r = ref.current!.getBoundingClientRect();
    onBegin();
    const cur = pts.map((p) => [...p] as [number, number]);
    const move = (ev: PointerEvent) => {
      const x = clamp((ev.clientX - r.left) / W, 0, 1);
      const y = clamp(1 - (ev.clientY - r.top) / H, 0, 1);
      const isEnd = idx === 0 || idx === cur.length - 1;
      cur[idx] = [isEnd ? cur[idx][0] : clamp(x, (cur[idx - 1]?.[0] ?? 0) + 0.01, (cur[idx + 1]?.[0] ?? 1) - 0.01), y];
      onChange(cur.flat(), false);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onChange(cur.flat(), true);
      onEnd();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const addPoint = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = clamp((e.clientX - r.left) / W, 0.01, 0.99);
    const y = clamp(1 - (e.clientY - r.top) / H, 0, 1);
    const next = [...pts, [x, y] as [number, number]].sort((a, b) => a[0] - b[0]);
    onChange(next.flat(), true);
  };
  return (
    <div className="ec-row" style={{ height: 'auto', alignItems: 'flex-start', padding: '4px 6px 4px 20px' }}>
      <span className="ec-name" style={{ color: 'var(--c-text-dim)', paddingTop: 2 }}>{label}</span>
      <div className="ec-value" style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
        <div ref={ref} className="curve-editor" style={{ width: W, height: H, position: 'relative', background: '#141414', border: '1px solid var(--c-line)' }} onDoubleClick={addPoint} title="Drag points; double-click to add a point; right-click a point to remove it">
          <svg width={W} height={H} style={{ position: 'absolute', inset: 0 }}>
            <line x1={0} y1={H} x2={W} y2={0} stroke="#333" strokeDasharray="3 3" />
            {[0.25, 0.5, 0.75].map((g) => (
              <React.Fragment key={g}>
                <line x1={g * W} y1={0} x2={g * W} y2={H} stroke="#222" />
                <line x1={0} y1={g * H} x2={W} y2={g * H} stroke="#222" />
              </React.Fragment>
            ))}
            <path d={path} stroke="#e0e0e0" fill="none" strokeWidth={1.5} />
            {pts.map((p, i) => {
              const [x, y] = toXY(p);
              return <circle key={i} cx={x} cy={y} r={4} fill="#3d7bd9" stroke="#e0e0e0" style={{ cursor: 'move' }} onPointerDown={(e) => down(e, i)} onContextMenu={(e) => { e.preventDefault(); if (i === 0 || i === pts.length - 1) return; onChange(pts.filter((_, j) => j !== i).flat(), true); }} />;
            })}
          </svg>
        </div>
        <Button sm onClick={() => onChange([0, 0, 1, 1], true)}>Reset curve</Button>
      </div>
    </div>
  );
}

/* ---------- keyframe lane (right side of the panel) ---------- */

function KeyframeLane({ clip, seq, groups, open, fps }: { clip: Clip; seq: Sequence; groups: { key: string; kind: string; fx?: Clip['effects'][number]; def?: EffectDef }[]; open: Record<string, boolean>; fps: number }) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const playhead = usePlayback((s) => s.playhead);
  const selKfs = useUI((s) => s.selection.keyframes);
  const W = size.width || 200;
  const ppf = (W - 16) / Math.max(1, clip.duration);
  const x = (t: number) => 8 + t * ppf;
  // Rows must mirror the visual order of the props list: we render one row per animatable property in each open group.
  const rows: { path: string; p: Param; label: string }[] = [];
  const push = (path: string, label: string) => {
    const p = resolveParam(clip, path) as Param | null;
    if (p) rows.push({ path, p, label });
  };
  for (const g of groups) {
    rows.push({ path: `group:${g.key}`, p: mkParam(0), label: '' });
    if (!(open[g.key] ?? true)) continue;
    if (g.kind === 'motion') ['position', 'scale', ...(clip.motion.uniformScale ? [] : ['scaleWidth']), 'uniform', 'rotation', 'anchor', 'antiFlicker', 'fit'].forEach((k) => (k === 'uniform' || k === 'fit' ? rows.push({ path: `spacer:${k}`, p: mkParam(0), label: '' }) : push(`motion.${k}`, k)));
    if (g.kind === 'opacity') {
      push('motion.opacity', 'opacity');
      rows.push({ path: 'spacer:blend', p: mkParam(0), label: '' });
    }
    if (g.kind === 'audio') {
      push('audio.volume', 'volume');
      push('audio.pan', 'pan');
      ['gain', 'channels', 'phase', 'pitch'].forEach((k) => rows.push({ path: `spacer:${k}`, p: mkParam(0), label: '' }));
    }
    if (g.kind === 'remap') ['speed', 'reverse', 'hold', ...(clip.timeRemap?.length ? ['ramp'] : [])].forEach((k) => rows.push({ path: k === 'speed' ? 'remap' : `spacer:${k}`, p: mkParam(0), label: k }));
    if (g.kind === 'fx' && g.fx && g.def) {
      if (g.def.presets?.length) rows.push({ path: 'spacer:preset', p: mkParam(0), label: '' });
      let lastGroup: string | undefined | null = null;
      for (const pd of g.def.params) {
        if (pd.hidden) continue;
        if (pd.group !== lastGroup) {
          if (pd.group) rows.push({ path: `spacer:${pd.group}`, p: mkParam(0), label: '' });
          lastGroup = pd.group;
        }
        if (pd.kind === 'curve') rows.push({ path: `spacer:curve${pd.key}`, p: mkParam(0), label: '' });
        else push(`fx.${g.fx.id}.${pd.key}`, pd.label);
      }
      for (const m of g.fx.masks) {
        rows.push({ path: `spacer:mask${m.id}`, p: mkParam(0), label: '' });
        ['center', 'size', 'rotation', 'feather', 'opacity', 'expansion'].forEach((k) => push(`fx.${g.fx!.id}.mask.${m.id}.${k}`, k));
      }
    }
  }
  const onKfDown = (e: React.PointerEvent, path: string, t: number) => {
    e.stopPropagation();
    e.preventDefault();
    const ui = useUI.getState();
    const already = selKfs.some((k) => k.clipId === clip.id && k.path === path && k.t === t);
    const sel = e.shiftKey ? (already ? selKfs.filter((k) => !(k.path === path && k.t === t)) : [...selKfs, { clipId: clip.id, path, t }]) : already ? selKfs : [{ clipId: clip.id, path, t }];
    ui.setSelection({ keyframes: sel, clipIds: ui.selection.clipIds });
    const x0 = e.clientX;
    let began = false;
    const startTs = sel.map((k) => k.t);
    const move = (ev: PointerEvent) => {
      const d = Math.round((ev.clientX - x0) / ppf);
      if (!began) {
        if (Math.abs(ev.clientX - x0) < 3) return;
        began = true;
        useProject.getState().beginBatch('Move keyframes');
      }
      useProject.getState().updateTransient((p) => {
        const c = p.sequences.find((s) => s.id === seq.id)!.clips.find((c) => c.id === clip.id)!;
        sel.forEach((k, i) => {
          if (k.path === 'remap') {
            const kf = c.timeRemap?.find((x) => x.t === (began ? k.t : startTs[i]));
            if (kf) kf.t = clamp(startTs[i] + d, 0, c.duration);
            c.timeRemap?.sort((a, b) => a.t - b.t);
            return;
          }
          const pr = resolveParam(c, k.path);
          const kf = pr?.keyframes?.find((x: Keyframe) => x.t === k.t);
          if (kf) kf.t = clamp(startTs[i] + d, 0, c.duration);
          pr?.keyframes?.sort((a: Keyframe, b: Keyframe) => a.t - b.t);
          k.t = clamp(startTs[i] + d, 0, c.duration);
        });
      });
      ui.setSelection({ keyframes: sel.map((k, i) => ({ ...k, t: clamp(startTs[i] + d, 0, clip.duration) })) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (began) useProject.getState().endBatch();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const seek = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const r = ref.current!.getBoundingClientRect();
    const f = clamp(Math.round((e.clientX - r.left - 8) / ppf), 0, clip.duration);
    usePlayback.getState().setPlayhead(clip.start + f, { fromUser: true });
    const move = (ev: PointerEvent) => usePlayback.getState().setPlayhead(clip.start + clamp(Math.round((ev.clientX - r.left - 8) / ppf), 0, clip.duration), { fromUser: true });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const local = playhead - clip.start;
  return (
    <div className="ec-kfarea" ref={ref} onPointerDown={seek} onKeyDown={(e) => { if (e.key === 'Delete' || e.key === 'Backspace') cmd.deleteSelectedKeyframes(); }} tabIndex={0}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 26, borderBottom: '1px solid var(--c-line-faint)', fontSize: 10, color: 'var(--c-text-faint)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 8px' }}>
        <span>{framesToTimecode(clip.start, fps)}</span>
        <span>{framesToTimecode(clip.start + clip.duration, fps)}</span>
      </div>
      {rows.map((r, i) => {
        const top = 26 + i * 23;
        if (r.path.startsWith('group:')) return <div key={r.path + i} style={{ position: 'absolute', top, left: 0, right: 0, height: 22, background: 'var(--c-panel-header)', borderBottom: '1px solid var(--c-line-faint)' }} />;
        if (r.path.startsWith('spacer:')) return <div key={r.path + i} style={{ position: 'absolute', top, left: 0, right: 0, height: 22, borderBottom: '1px solid var(--c-line-faint)' }} />;
        const kfs: Keyframe<any>[] = r.path === 'remap' ? (clip.timeRemap ?? []) : (r.p.keyframes ?? []);
        return (
          <div key={r.path} style={{ position: 'absolute', top, left: 0, right: 0, height: 22, borderBottom: '1px solid var(--c-line-faint)' }}>
            {kfs.map((k) => {
              const selected = selKfs.some((s) => s.clipId === clip.id && s.path === r.path && s.t === k.t);
              return (
                <div
                  key={k.t}
                  className={`kf-dot ${selected ? 'selected' : ''} ${k.interp}`}
                  style={{ position: 'absolute', left: x(k.t) - 5, top: 6, width: 10, height: 10, transform: k.interp === 'hold' ? 'none' : 'rotate(45deg)', background: selected ? '#e0e0e0' : 'var(--c-keyframe)', border: '1px solid #111', borderRadius: k.interp === 'linear' || k.interp === 'hold' ? 1 : 5 }}
                  title={`${r.label} @ ${framesToTimecode(clip.start + k.t, fps)} (${k.interp})`}
                  onPointerDown={(e) => onKfDown(e, r.path, k.t)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    useUI.getState().openContextMenu(e.clientX, e.clientY, [
                      ...(['linear', 'bezier', 'easeIn', 'easeOut', 'easeInOut', 'hold'] as Interpolation[]).map((it) => ({ label: it[0].toUpperCase() + it.slice(1).replace(/([A-Z])/g, ' $1'), checked: k.interp === it, onSelect: () => useProject.getState().update('Keyframe interpolation', (p) => { const c = p.sequences.find((s) => s.id === seq.id)!.clips.find((c) => c.id === clip.id)!; if (r.path === 'remap') { const kf = c.timeRemap?.find((x) => x.t === k.t); if (kf) kf.interp = it; } else setParamAt(c, r.path, setKeyframeInterp(resolveParam(c, r.path) as any, k.t, it)); }) })),
                      { separator: true },
                      { label: 'Delete Keyframe', danger: true, onSelect: () => useProject.getState().update('Delete keyframe', (p) => { const c = p.sequences.find((s) => s.id === seq.id)!.clips.find((c) => c.id === clip.id)!; if (r.path === 'remap') { c.timeRemap = c.timeRemap?.filter((x) => x.t !== k.t); if (c.timeRemap && c.timeRemap.length < 2) c.timeRemap = undefined; } else setParamAt(c, r.path, removeKeyframe(resolveParam(c, r.path) as any, k.t)); }) },
                    ]);
                  }}
                />
              );
            })}
          </div>
        );
      })}
      {local >= 0 && local <= clip.duration ? <div style={{ position: 'absolute', top: 0, bottom: 0, left: x(local), width: 1, background: 'var(--c-playhead)', pointerEvents: 'none' }} /> : null}
    </div>
  );
}

export { toast };
