import React, { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useUI, type PanelId } from '../state/uiStore';
import { useProject, useActiveSequence } from '../state/projectStore';
import { usePlayback } from '../engine/playback/playback';
import { useLayout, PANEL_TITLES } from '../state/layoutStore';
import { cmd } from '../app/commands';
import { shortcutFor } from '../app/shortcuts';
import { EFFECTS, getEffectDef } from '../engine/effects/registry';
import { AUDIO_EFFECTS } from '../engine/effects/audioRegistry';
import { useSettings, SETTINGS_META } from '../state/settingsStore';
import { Icon } from './icons';
import { Kbd } from './controls';

/*
  Command palette (Ctrl+Shift+P): one fuzzy box that reaches every command,
  panel, effect, asset, sequence and setting. The list is rebuilt on open.
*/

const isMac = navigator.platform.toLowerCase().includes('mac');

interface PaletteStore {
  open: boolean;
  toggle: (v?: boolean) => void;
}
export const usePalette = create<PaletteStore>((set) => ({
  open: false,
  toggle: (v) => set((s) => ({ open: v ?? !s.open })),
}));

interface Item {
  id: string;
  label: string;
  group: string;
  hint?: string;
  shortcut?: string;
  icon?: string;
  run: () => void;
}

/** Subsequence fuzzy match with word-start bonuses; returns score or -1. */
function fuzzy(q: string, text: string): number {
  const t = text.toLowerCase();
  const s = q.toLowerCase();
  if (!s) return 0;
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ') continue;
    const idx = t.indexOf(s[i], ti);
    if (idx === -1) return -1;
    streak = idx === ti ? streak + 1 : 0;
    score += 10 + streak * 8;
    if (idx === 0 || ' :/.'.includes(t[idx - 1] ?? '')) score += 12;
    ti = idx + 1;
  }
  if (t === s) score += 100;
  else if (t.startsWith(s)) score += 40;
  return score - Math.max(0, t.length - s.length) * 0.1;
}

function buildItems(): Item[] {
  const items: Item[] = [];
  const ui = useUI.getState();
  const project = useProject.getState().project;
  const pb = usePlayback.getState();
  const sc = (id: string) => shortcutFor(id);

  const C = (id: string, label: string, run: () => void, group = 'Commands', hint?: string, shortcut?: string) => items.push({ id, label, group, hint, shortcut: shortcut ?? sc(id), run });

  /* Commands */
  C('play', 'Play / Pause', () => pb.toggle());
  C('stop', 'Stop and return to start', () => {
    usePlayback.getState().setPlayhead(0, { fromUser: true });
    usePlayback.getState().pause();
  });
  C('undo', 'Undo', () => cmd.undo());
  C('redo', 'Redo', () => cmd.redo());
  C('save', 'Save Project', () => void cmd.saveProject(false));
  C('saveAs', 'Save Project with Media', () => void cmd.saveProject(true));
  C('import', 'Import Media...', () => void cmd.importMedia());
  C('newSeq', 'New Sequence...', () => ui.openModal({ kind: 'newSequence' }));
  C('export', 'Export Media...', () => ui.openModal({ kind: 'export' }));
  C('exportFrame', 'Export Frame (PNG)', () => void cmd.exportFrame('png'));
  C('addEdit', 'Add Edit at Playhead', () => cmd.razorAtPlayhead(false));
  C('defaultTransition', 'Apply Default Video Transition', () => cmd.applyDefaultTransition('video'));
  C('defaultAudioTransition', 'Apply Default Audio Transition', () => cmd.applyDefaultTransition('audio'));
  C('lift', 'Lift', () => cmd.liftExtract(false));
  C('extract', 'Extract', () => cmd.liftExtract(true));
  C('insert', 'Insert from Source Monitor', () => cmd.insertOverwriteFromSource('insert'));
  C('overwrite', 'Overwrite from Source Monitor', () => cmd.insertOverwriteFromSource('overwrite'));
  C('matchFrame', 'Match Frame', () => cmd.matchFrame());
  C('nest', 'Nest Selection', () => cmd.nestSelection());
  C('speed', 'Speed / Duration...', () => cmd.speedDuration());
  C('gain', 'Audio Gain...', () => cmd.audioGain());
  C('addMarker', 'Add Marker', () => cmd.addMarker());
  C('markIn', 'Mark In', () => cmd.markIn());
  C('markOut', 'Mark Out', () => cmd.markOut());
  C('snap', 'Toggle Snapping', () => ui.setSnapping(!useUI.getState().snapping));
  C('waveforms', 'Toggle Audio Waveforms', () => ui.setTimelineDisplay({ showAudioWaveforms: !useUI.getState().showAudioWaveforms }));
  C('thumbs', 'Toggle Video Thumbnails', () => ui.setTimelineDisplay({ showVideoThumbnails: !useUI.getState().showVideoThumbnails }));
  C('loop', 'Toggle Loop Playback', () => usePlayback.getState().setLoop(!usePlayback.getState().loop));
  C('fullScreen', 'Toggle Full Screen Program', () => {
    const el = document.querySelector('.monitor.program .viewport') as HTMLElement | null;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el?.requestFullscreen?.();
  });
  C('voiceover', 'Record Voiceover...', () => ui.openModal({ kind: 'recordVoiceover' }), 'Capture', 'Record from the microphone onto the timeline');
  C('screenRecord', 'Record Screen...', () => ui.openModal({ kind: 'capture', payload: { kind: 'screen' } }), 'Capture', 'Capture a window or screen into the project');
  C('webcamRecord', 'Record Webcam...', () => ui.openModal({ kind: 'capture', payload: { kind: 'webcam' } }), 'Capture');
  C('beatDetect', 'Detect Beats...', () => ui.openModal({ kind: 'beatDetect' }), 'Audio', 'Mark the beats of a music clip for cutting on rhythm');
  C('autoColor', 'Auto Color Selection', () => void cmd.autoColorSelection(), 'Color', 'One-click contrast and white balance fix');
  C('sceneDetect', 'Scene Detection...', () => ui.openModal({ kind: 'sceneDetect' }), 'Color');
  C('duck', 'Auto Duck Music...', () => ui.openModal({ kind: 'autoDucking' }), 'Audio');
  C('shortcuts', 'Keyboard Shortcuts', () => ui.openModal({ kind: 'keyboardShortcuts' }), 'Help');
  C('settings', 'Open Settings', () => ui.openModal({ kind: 'preferences' }), 'Help', undefined, 'Ctrl+,');
  C('about', 'About Vanguard Studio Pro', () => ui.openModal({ kind: 'about' }), 'Help');

  /* Panels */
  for (const [pid, title] of Object.entries(PANEL_TITLES)) {
    items.push({
      id: 'panel:' + pid,
      label: title,
      group: 'Panels',
      hint: 'Open panel',
      run: () => {
        const ws = useUI.getState().workspace;
        useLayout.getState().openPanel(ws, pid as PanelId);
        useUI.getState().setFocusedPanel(pid as PanelId);
      },
    });
  }

  /* Effects: apply to selection */
  const hasSel = useUI.getState().selection.clipIds.length > 0;
  for (const def of [...EFFECTS, ...AUDIO_EFFECTS]) {
    items.push({
      id: 'fx:' + def.type,
      label: def.name,
      group: hasSel ? 'Effects (apply to selection)' : 'Effects',
      hint: def.description?.slice(0, 70),
      run: () => cmd.addEffectToSelection(def.type),
    });
  }
  void getEffectDef;

  /* Sequences */
  for (const s of project.sequences) {
    items.push({
      id: 'seq:' + s.id,
      label: s.name,
      group: 'Sequences',
      hint: `${s.settings.width}x${s.settings.height} - ${s.clips.length} clips`,
      run: () => cmd.openSequence(s.id),
    });
  }

  /* Assets: open in source monitor */
  for (const a of project.assets) {
    if (a.kind === 'sequence') continue;
    items.push({
      id: 'asset:' + a.id,
      label: a.name,
      group: 'Media',
      hint: a.kind + (a.duration ? ` - ${a.duration.toFixed(1)}s` : ''),
      run: () => useUI.getState().setSourceAssetId(a.id),
    });
  }

  /* Settings toggles */
  const st = useSettings.getState();
  const boolKeys = ['reduceMotion', 'highContrast', 'largerText', 'strongFocus', 'disableFlashingEffects', 'verboseToasts', 'autoQualityDrop', 'parkOnLastFrame', 'showFpsOverlay', 'floatPipeline', 'snapshotPresentation', 'desyncCanvas', 'debugRenderLogging', 'brightSurfaces'] as const;
  for (const k of boolKeys) {
    const meta = SETTINGS_META[k];
    items.push({
      id: 'set:' + k,
      label: `${meta?.label ?? k}: ${st[k] ? 'On' : 'Off'}`,
      group: 'Settings',
      hint: meta?.category + (meta?.hint ? ` - ${meta.hint}` : ''),
      run: () => useSettings.getState().set(k, !(st[k] as boolean)),
    });
  }

  return items;
}

export function CommandPalette() {
  const open = usePalette((s) => s.open);
  const toggle = usePalette((s) => s.toggle);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [items, setItems] = useState<Item[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useActiveSequence();
  const projectAssets = useProject((s) => s.project.assets);

  useEffect(() => {
    if (open) {
      setItems(buildItems());
      setQ('');
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, seq?.id, projectAssets]);

  const results = useMemo(() => {
    if (!q.trim()) return items.slice(0, 40);
    const scored: { item: Item; score: number }[] = [];
    for (const it of items) {
      const s = fuzzy(q, it.label + ' ' + it.group);
      if (s >= 0) scored.push({ item: it, score: s + (q.toLowerCase().startsWith(it.group.slice(0, 3).toLowerCase()) ? 6 : 0) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 40).map((s) => s.item);
  }, [q, items]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;

  const accept = (i: number) => {
    const it = results[i];
    toggle(false);
    try {
      it?.run();
    } catch (e) {
      console.error(e);
    }
  };

  const groupOf = (i: number) => (i === 0 || results[i - 1].group !== results[i].group ? results[i].group : null);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && toggle(false)}>
      <div className="palette" onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
        else if (e.key === 'Enter') { e.preventDefault(); accept(sel); }
        else if (e.key === 'Escape') { e.preventDefault(); toggle(false); }
      }}>
        <div className="palette-input">
          <Icon name="search" size={14} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Type a command, panel, effect, clip or setting..."
            spellCheck={false}
          />
          <span className="dim" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>
            {results.length} result{results.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="palette-list scroll-y" ref={listRef}>
          {results.length === 0 ? <div className="empty" style={{ padding: 18 }}>Nothing matches "{q}"</div> : null}
          {results.map((it, i) => {
            const g = groupOf(i);
            return (
              <React.Fragment key={it.id}>
                {g ? <div className="palette-group">{g}</div> : null}
                <div data-idx={i} className={`palette-row${i === sel ? ' sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => accept(i)}>
                  <span className="nm">{it.label}</span>
                  {it.hint ? <span className="hint">{it.hint}</span> : null}
                  {it.shortcut ? <span className="keys">{it.shortcut.split('+').map((k) => <Kbd key={k}>{k}</Kbd>)}</span> : null}
                </div>
              </React.Fragment>
            );
          })}
        </div>
        <div className="palette-foot">
          <span><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
          <span><Kbd>Enter</Kbd> run</span>
          <span><Kbd>Esc</Kbd> close</span>
          <span className="spacer" />
          <span className="dim">Ctrl+Shift+P</span>
        </div>
      </div>
    </div>
  );
}
