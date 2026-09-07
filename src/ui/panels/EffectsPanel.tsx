import React, { useMemo, useState, useSyncExternalStore } from 'react';
import { EFFECTS, EFFECT_CATEGORIES, type EffectDef, type EffectCategory } from '../../engine/effects/registry';
import { AUDIO_EFFECTS } from '../../engine/effects/audioRegistry';
import { TRANSITIONS, AUDIO_TRANSITIONS, type TransitionDef } from '../../engine/effects/transitions';
import { useUI, toast } from '../../state/uiStore';
import { useProject } from '../../state/projectStore';
import { cmd } from '../../app/commands';
import { Icon, type IconName } from '../icons';
import { TextField, IconButton, useLocalToggle } from '../controls';
import { MIME_EFFECT, MIME_TRANSITION, useTimelineView } from '../timeline/timelineState';
import { userPresets, type UserPreset } from '../../app/presets';

const CATEGORY_ICON: Partial<Record<EffectCategory, IconName>> = {
  'Color Correction': 'color',
  'Blur & Sharpen': 'blur',
  Distort: 'distort',
  Stylize: 'stylize',
  Keying: 'key',
  Generate: 'generate',
  'Noise & Grain': 'noise',
  Transform: 'transform',
  Time: 'clock',
  Utility: 'wrench',
};

type Node = { key: string; label: string; icon: IconName; count: number; children: Leaf[] };
type Leaf = { kind: 'effect' | 'transition' | 'preset'; type: string; name: string; description: string; audio?: boolean; gpu?: boolean; preset?: UserPreset };

export function EffectsPanel() {
  const search = useUI((s) => s.effectsSearch);
  const setSearch = useUI((s) => s.setEffectsSearch);
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('vsp.fxtree') || '{}');
    } catch {
      return {};
    }
  });
  const [accelOnly, setAccelOnly] = useLocalToggle('vsp.fx.accelOnly', false);
  const presets = useSyncExternalStore(
    (cb) => userPresets.subscribe(cb),
    () => userPresets.get(),
  );
  const sel = useUI((s) => s.selection.clipIds);
  const project = useProject((s) => s.project);

  const toggle = (k: string) => {
    const next = { ...open, [k]: !open[k] };
    setOpen(next);
    localStorage.setItem('vsp.fxtree', JSON.stringify(next));
  };

  const tree = useMemo<Node[]>(() => {
    const q = search.trim().toLowerCase();
    const match = (n: string, d: string) => !q || n.toLowerCase().includes(q) || d.toLowerCase().includes(q);
    const nodes: Node[] = [];
    const presetLeaves: Leaf[] = presets.filter((p) => match(p.name, p.effectType)).map((p) => ({ kind: 'preset', type: p.id, name: p.name, description: `Preset for ${p.effectType}`, preset: p }));
    if (presetLeaves.length || !q) nodes.push({ key: 'presets', label: 'Presets', icon: 'presets', count: presetLeaves.length, children: presetLeaves });
    const videoLeaves: Record<string, Leaf[]> = {};
    for (const e of EFFECTS as EffectDef[]) {
      if (!match(e.name, e.description)) continue;
      (videoLeaves[e.category] ??= []).push({ kind: 'effect', type: e.type, name: e.name, description: e.description, gpu: true });
    }
    const vcats = EFFECT_CATEGORIES.filter((c) => !c.startsWith('Audio') && videoLeaves[c]?.length);
    nodes.push({ key: 'video', label: 'Video Effects', icon: 'effectFx', count: vcats.reduce((n, c) => n + videoLeaves[c].length, 0), children: [] });
    for (const c of vcats) nodes.push({ key: `v:${c}`, label: c, icon: CATEGORY_ICON[c] ?? 'effectFx', count: videoLeaves[c].length, children: videoLeaves[c] });
    const audioLeaves: Record<string, Leaf[]> = {};
    for (const e of AUDIO_EFFECTS) {
      if (!match(e.name, e.description)) continue;
      (audioLeaves[e.category] ??= []).push({ kind: 'effect', type: e.type, name: e.name, description: e.description, audio: true });
    }
    const acats = EFFECT_CATEGORIES.filter((c) => c.startsWith('Audio') && audioLeaves[c]?.length);
    nodes.push({ key: 'audio', label: 'Audio Effects', icon: 'clipAudio', count: acats.reduce((n, c) => n + audioLeaves[c].length, 0), children: [] });
    for (const c of acats) nodes.push({ key: `a:${c}`, label: c.replace('Audio: ', ''), icon: 'clipAudio', count: audioLeaves[c].length, children: audioLeaves[c] });
    const tcats: Record<string, Leaf[]> = {};
    for (const t of TRANSITIONS as TransitionDef[]) {
      if (!match(t.name, t.description)) continue;
      (tcats[t.category] ??= []).push({ kind: 'transition', type: t.type, name: t.name, description: t.description, gpu: true });
    }
    const tkeys = Object.keys(tcats);
    nodes.push({ key: 'vtrans', label: 'Video Transitions', icon: 'transition', count: tkeys.reduce((n, c) => n + tcats[c].length, 0), children: [] });
    for (const c of tkeys) nodes.push({ key: `t:${c}`, label: c, icon: 'transition', count: tcats[c].length, children: tcats[c] });
    const at = AUDIO_TRANSITIONS.filter((t) => match(t.name, t.description)).map((t) => ({ kind: 'transition', type: t.type, name: t.name, description: t.description, audio: true }) as Leaf);
    nodes.push({ key: 'atrans', label: 'Audio Transitions', icon: 'transition', count: at.length, children: [] });
    if (at.length) nodes.push({ key: 't:Crossfade', label: 'Crossfade', icon: 'transition', count: at.length, children: at });
    return nodes;
  }, [search, presets]);

  const apply = (leaf: Leaf) => {
    if (leaf.kind === 'preset' && leaf.preset) {
      if (!sel.length) return toast('info', 'Select a clip first', 'Presets apply to the selected clips.');
      cmd.applyPreset(sel, leaf.preset);
      return;
    }
    if (leaf.kind === 'transition') {
      if (!sel.length) return toast('info', 'Select a clip first', 'Double-clicking a transition applies it to the selected clip edges. You can also drag it onto an edit point.');
      for (const id of sel) {
        cmd.addTransitionTo(id, 'in', leaf.type);
        cmd.addTransitionTo(id, 'out', leaf.type);
      }
      return;
    }
    if (!sel.length) return toast('info', 'Select a clip first', 'Double-click applies the effect to selected clips, or drag it onto a clip in the timeline.');
    cmd.addEffectToClips(sel, leaf.type);
  };

  const dragStart = (e: React.DragEvent, leaf: Leaf) => {
    if (leaf.kind === 'transition') {
      e.dataTransfer.setData(MIME_TRANSITION, leaf.type);
      useTimelineView.getState().setExternalDrag({ kind: 'transition', type: leaf.type });
    } else if (leaf.kind === 'preset') {
      e.dataTransfer.setData(MIME_EFFECT, `preset:${leaf.type}`);
      useTimelineView.getState().setExternalDrag({ kind: 'effect', type: `preset:${leaf.type}` });
    } else {
      e.dataTransfer.setData(MIME_EFFECT, leaf.type);
      useTimelineView.getState().setExternalDrag({ kind: 'effect', type: leaf.type });
    }
    e.dataTransfer.setData('text/plain', leaf.name);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const q = search.trim();
  const visibleChildren = (n: Node) => (q ? n.children : open[n.key] ? n.children : []);
  const groupHeaders = new Set(['presets', 'video', 'audio', 'vtrans', 'atrans']);

  return (
    <div className="fx-tree" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="toolbar">
        <TextField value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search effects and transitions" style={{ flex: 1 }} icon="search" />
        <IconButton icon="gpu" label="Show only GPU-accelerated effects" sm on={accelOnly} onClick={() => setAccelOnly(!accelOnly)} />
        <IconButton icon="presets" label="Save the selected clip's effects as a preset" sm disabled={!sel.length} onClick={() => {
          const seq = project.sequences.find((s) => s.id === project.activeSequenceId);
          const clip = seq?.clips.find((c) => c.id === sel[0]);
          if (!clip?.effects.length) return toast('info', 'No effects to save', 'The selected clip has no effects applied.');
          useUI.getState().openModal({ kind: 'rename', payload: { title: 'Save Preset', label: 'Preset name', value: `${clip.name} preset`, onSubmit: (name: string) => { userPresets.add({ id: `p${Date.now().toString(36)}`, name, effectType: clip.effects.map((e) => e.type).join(', '), effects: clip.effects.map((e) => ({ type: e.type, params: JSON.parse(JSON.stringify(e.params)) })) }); toast('success', 'Preset saved', `"${name}" is in Presets.`); } } });
        }} />
      </div>
      <div className="scroll-y" style={{ flex: 1 }}>
        {tree.map((n) => {
          const isGroup = groupHeaders.has(n.key);
          const kids = visibleChildren(n).filter((l) => !accelOnly || l.gpu || l.audio || l.kind === 'preset');
          if (accelOnly && !isGroup && !kids.length) return null;
          return (
            <React.Fragment key={n.key}>
              <div className="fx-cat" style={{ paddingLeft: isGroup ? 6 : 16, fontWeight: isGroup ? 460 : 400, color: isGroup ? 'var(--c-text-bright)' : undefined }} onClick={() => (isGroup ? null : toggle(n.key))} onDoubleClick={() => isGroup && toast('info', n.label, `${n.count} available`)} role="button">
                {!isGroup ? <Icon name={q || open[n.key] ? 'chevronDown' : 'chevronRight'} size={10} /> : null}
                <Icon name={n.icon} size={12} style={{ color: 'var(--c-text-dim)' }} />
                <span>{n.label}</span>
                <span className="count">{n.count}</span>
              </div>
              {kids.map((l) => (
                <div key={`${l.kind}:${l.type}`} className="fx-item" draggable onDragStart={(e) => dragStart(e, l)} onDragEnd={() => useTimelineView.getState().setExternalDrag(null)} onDoubleClick={() => apply(l)} title={`${l.description}\n\nDouble-click to apply to selected clips, or drag onto a clip.`} onContextMenu={(e) => {
                  e.preventDefault();
                  useUI.getState().openContextMenu(e.clientX, e.clientY, [
                    { label: sel.length ? `Apply to ${sel.length} selected clip${sel.length > 1 ? 's' : ''}` : 'Apply (select a clip first)', disabled: !sel.length, onSelect: () => apply(l) },
                    ...(l.kind === 'transition' && !l.audio ? [{ label: 'Set as Default Transition', onSelect: () => useProject.getState().update('Default transition', (p) => { p.settings.defaultVideoTransition = l.type; }) }] : []),
                    ...(l.kind === 'transition' && l.audio ? [{ label: 'Set as Default Audio Transition', onSelect: () => useProject.getState().update('Default audio transition', (p) => { p.settings.defaultAudioTransition = l.type; }) }] : []),
                    ...(l.kind === 'preset' ? [{ label: 'Delete Preset', danger: true, onSelect: () => userPresets.remove(l.type) }] : []),
                  ]);
                }}>
                  <Icon name={l.kind === 'transition' ? 'transition' : l.kind === 'preset' ? 'presets' : l.audio ? 'clipAudio' : 'effectFx'} size={12} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
                  <span className="acc">
                    {l.kind === 'transition' && l.type === project.settings.defaultVideoTransition ? <span className="tag" title="Default video transition">Default</span> : null}
                    {l.kind === 'transition' && l.type === project.settings.defaultAudioTransition ? <span className="tag" title="Default audio transition">Default</span> : null}
                    {l.gpu ? <span className="tag" title="GPU accelerated (WebGL2)">GPU</span> : null}
                  </span>
                </div>
              ))}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
