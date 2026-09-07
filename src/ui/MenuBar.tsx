import React, { useEffect, useRef, useState } from 'react';
import { useUI, type ContextMenuItem, type WorkspaceId, type PanelId } from '../state/uiStore';
import { useProject } from '../state/projectStore';
import { usePlayback } from '../engine/playback/playback';
import { cmd, selectedClipIds } from '../app/commands';
import { shortcutFor } from '../app/shortcuts';
import { MenuList } from './controls';
import { Icon } from './icons';
import { useLayout, PANEL_TITLES } from '../state/layoutStore';
import { LABEL_COLORS, type LabelColor } from '../types/project';
import { TRANSITIONS, AUDIO_TRANSITIONS } from '../engine/effects/transitions';
import { EFFECTS } from '../engine/effects/registry';
import { AUDIO_EFFECTS } from '../engine/effects/audioRegistry';
import { usePalette } from './CommandPalette';

const WORKSPACES: { id: WorkspaceId; label: string }[] = [
  { id: 'assembly', label: 'Assembly' },
  { id: 'editing', label: 'Editing' },
  { id: 'color', label: 'Color' },
  { id: 'effects', label: 'Effects' },
  { id: 'audio', label: 'Audio' },
  { id: 'graphics', label: 'Graphics' },
  { id: 'captions', label: 'Captions' },
  { id: 'review', label: 'Review' },
  { id: 'export', label: 'Export' },
];

const sc = (id: string) => shortcutFor(id);

export function MenuBar() {
  const [open, setOpen] = useState<{ index: number; x: number; y: number } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const workspace = useUI((s) => s.workspace);
  const setWorkspace = useUI((s) => s.setWorkspace);
  const projectName = useProject((s) => s.project.settings.name);
  const dirty = useProject((s) => s.dirty);
  const hasSel = useUI((s) => s.selection.clipIds.length > 0);
  const canUndo = useProject((s) => s.past.length > 0);
  const canRedo = useProject((s) => s.future.length > 0);
  const openModal = useUI((s) => s.openModal);
  const ws = workspace;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.menu') || t.closest('.menubar .mb-item')) return;
      setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const buildMenus = (): { title: string; items: () => ContextMenuItem[] }[] => [
    {
      title: 'File',
      items: () => [
        { label: 'New Project', shortcut: `${sc('open')?.split('+')[0]}+Alt+N`, onSelect: () => cmd.newProject() },
        { label: 'New Sequence...', shortcut: sc('newSeq'), onSelect: () => cmd.newSequence() },
        { label: 'New Bin', shortcut: sc('newBin'), onSelect: () => cmd.newBin() },
        {
          label: 'New Item',
          submenu: [
            { label: 'Adjustment Layer', onSelect: () => cmd.newGenerator('adjustmentLayer') },
            { label: 'Color Matte...', onSelect: () => openModal({ kind: 'colorMatte' }) },
            { label: 'Black Video', onSelect: () => cmd.newGenerator('blackVideo') },
            { label: 'Bars and Tone', onSelect: () => cmd.newGenerator('barsAndTone', { tone: 1000, level: -12 }) },
            { label: 'Universal Counting Leader...', onSelect: () => openModal({ kind: 'generateCountdown' }) },
            { label: 'Graphic (Title)', onSelect: () => openModal({ kind: 'newItem', payload: { kind: 'graphic' } }) },
          ],
        },
        { separator: true },
        { label: 'Open Project...', shortcut: sc('open'), onSelect: () => void cmd.openProject() },
        { label: 'Open Autosaved Version...', onSelect: () => openModal({ kind: 'projectManager' }) },
        { separator: true },
        { label: 'Save Project', shortcut: sc('save'), onSelect: () => void cmd.saveProject(false) },
        { label: 'Save Project with Media...', shortcut: sc('saveAs'), onSelect: () => void cmd.saveProject(true) },
        { label: 'Autosave Now', onSelect: () => void cmd.autosave() },
        { separator: true },
        { label: 'Import Media...', shortcut: sc('import'), onSelect: () => void cmd.importMedia() },
        { label: 'Import Captions (SRT / VTT)...', onSelect: () => void cmd.importCaptions() },
        { label: 'Link Media...', onSelect: () => openModal({ kind: 'linkMedia' }) },
        { separator: true },
        {
          label: 'Capture',
          submenu: [
            { label: 'Record Voiceover...', onSelect: () => openModal({ kind: 'recordVoiceover' }) },
            { label: 'Record Screen...', onSelect: () => openModal({ kind: 'capture', payload: { kind: 'screen' } }) },
            { label: 'Record Webcam...', onSelect: () => openModal({ kind: 'capture', payload: { kind: 'webcam' } }) },
          ],
        },
        { separator: true },
        {
          label: 'Export',
          submenu: [
            { label: 'Media...', shortcut: sc('export'), onSelect: () => openModal({ kind: 'export' }) },
            { label: 'Frame (PNG)', shortcut: sc('exportFrame'), onSelect: () => void cmd.exportFrame('png') },
            { label: 'Frame (JPEG)', onSelect: () => void cmd.exportFrame('jpeg') },
            { separator: true },
            { label: 'EDL (CMX 3600)', onSelect: () => cmd.exportEDL() },
            { label: 'Markers as CSV', onSelect: () => cmd.exportMarkers('csv') },
            { label: 'Markers as YouTube Chapters', onSelect: () => cmd.exportMarkers('chapters') },
            { label: 'Captions as SRT', onSelect: () => cmd.exportCaptions('srt') },
            { label: 'Captions as WebVTT', onSelect: () => cmd.exportCaptions('vtt') },
          ],
        },
        { separator: true },
        { label: 'Project Settings...', onSelect: () => openModal({ kind: 'projectSettings' }) },
        { label: 'Project Manager (Storage)...', onSelect: () => openModal({ kind: 'projectManager' }) },
      ],
    },
    {
      title: 'Edit',
      items: () => [
        { label: 'Undo', shortcut: sc('undo'), disabled: !canUndo, onSelect: () => cmd.undo() },
        { label: 'Redo', shortcut: sc('redo'), disabled: !canRedo, onSelect: () => cmd.redo() },
        { separator: true },
        { label: 'Cut', shortcut: sc('cut'), disabled: !hasSel, onSelect: () => cmd.cut() },
        { label: 'Copy', shortcut: sc('copy'), disabled: !hasSel, onSelect: () => cmd.copy() },
        { label: 'Paste', shortcut: sc('paste'), disabled: !cmd.hasClipboard(), onSelect: () => cmd.paste(false) },
        { label: 'Paste Insert', shortcut: sc('pasteInsert'), disabled: !cmd.hasClipboard(), onSelect: () => cmd.paste(true) },
        { label: 'Paste Attributes...', shortcut: sc('pasteAttr'), disabled: !cmd.hasAttributes() || !hasSel, onSelect: () => openModal({ kind: 'confirm', payload: { kind: 'pasteAttributes' } }) },
        { label: 'Copy Attributes', disabled: !hasSel, onSelect: () => cmd.copyAttributes() },
        { separator: true },
        { label: 'Clear', shortcut: 'Delete', disabled: !hasSel, onSelect: () => cmd.deleteSelection(false) },
        { label: 'Ripple Delete', shortcut: sc('rippleDelete'), disabled: !hasSel, onSelect: () => cmd.deleteSelection(true) },
        { label: 'Duplicate', shortcut: sc('duplicate'), disabled: !hasSel, onSelect: () => cmd.duplicate() },
        { separator: true },
        { label: 'Select All', shortcut: sc('selectAll'), onSelect: () => cmd.selectAll() },
        { label: 'Deselect All', shortcut: sc('deselectAll'), onSelect: () => cmd.deselectAll() },
        { separator: true },
        { label: 'Label', disabled: !hasSel, submenu: labelItems() },
        { separator: true },
        { label: 'Command Palette...', shortcut: sc('palette'), onSelect: () => usePalette.getState().toggle(true) },
        { label: 'Keyboard Shortcuts...', shortcut: sc('shortcuts'), onSelect: () => openModal({ kind: 'keyboardShortcuts' }) },
        { label: 'Settings...', shortcut: sc('settings'), onSelect: () => openModal({ kind: 'preferences' }) },
      ],
    },
    {
      title: 'Clip',
      items: () => [
        { label: 'Rename...', disabled: selectedClipIds().length !== 1, onSelect: () => openModal({ kind: 'rename', payload: { clipId: selectedClipIds()[0] } }) },
        { label: 'Enable', shortcut: sc('enable'), disabled: !hasSel, onSelect: () => cmd.toggleEnabled() },
        { separator: true },
        { label: 'Link', shortcut: sc('link'), disabled: !hasSel, onSelect: () => cmd.linkSelection(true) },
        { label: 'Unlink', disabled: !hasSel, onSelect: () => cmd.linkSelection(false) },
        { label: 'Group', shortcut: sc('group'), disabled: !hasSel, onSelect: () => cmd.groupSelection(true) },
        { label: 'Ungroup', shortcut: sc('ungroup'), disabled: !hasSel, onSelect: () => cmd.groupSelection(false) },
        { label: 'Nest...', shortcut: sc('nest'), disabled: !hasSel, onSelect: () => openModal({ kind: 'nest' }) },
        { separator: true },
        {
          label: 'Video Options',
          disabled: !hasSel,
          submenu: [
            { label: 'Frame Hold (toggle at playhead)', shortcut: sc('frameHold'), onSelect: () => cmd.frameHold() },
            { label: 'Insert Frame Hold Segment', onSelect: () => cmd.insertFrameHoldSegment() },
            { label: 'Time Remapping...', onSelect: () => openModal({ kind: 'timeRemap' }) },
            { separator: true },
            { label: 'Scale to Frame Size', onSelect: () => scaleToFrame('fit') },
            { label: 'Set to Frame Size', onSelect: () => scaleToFrame('fill') },
            { label: 'Reset Motion', onSelect: () => resetMotion() },
          ],
        },
        {
          label: 'Audio Options',
          disabled: !hasSel,
          submenu: [
            { label: 'Audio Gain...', shortcut: sc('gain'), onSelect: () => cmd.audioGain() },
            { label: 'Auto Ducking (music under dialogue)...', onSelect: () => openModal({ kind: 'autoDucking' }) },
            { separator: true },
            { label: 'Mute Clip', onSelect: () => setAudioProp('muted', true) },
            { label: 'Unmute Clip', onSelect: () => setAudioProp('muted', false) },
            { label: 'Invert Phase', onSelect: () => setAudioProp('invertPhase', 'toggle') },
            { separator: true },
            { label: 'Channels: Stereo', onSelect: () => setAudioProp('channelMode', 'stereo') },
            { label: 'Channels: Left only', onSelect: () => setAudioProp('channelMode', 'left') },
            { label: 'Channels: Right only', onSelect: () => setAudioProp('channelMode', 'right') },
            { label: 'Channels: Swap', onSelect: () => setAudioProp('channelMode', 'swap') },
            { label: 'Channels: Mono sum', onSelect: () => setAudioProp('channelMode', 'mono') },
          ],
        },
        { label: 'Speed / Duration...', shortcut: sc('speed'), disabled: !hasSel, onSelect: () => cmd.speedDuration() },
        { label: 'Scene Edit Detection...', disabled: !hasSel, onSelect: () => openModal({ kind: 'sceneDetect' }) },
        { label: 'Auto Color', disabled: !hasSel, onSelect: () => void cmd.autoColorSelection() },
        { label: 'Pan & Zoom (Ken Burns)...', disabled: !hasSel, onSelect: () => openModal({ kind: 'kenBurns' }) },
        { label: 'Normalize Audio (-14 LUFS)', disabled: !hasSel, onSelect: () => void cmd.normalizeAudio() },
        { label: 'Remove Silence...', disabled: !hasSel, onSelect: () => openModal({ kind: 'removeSilence' }) },
        { separator: true },
        { label: 'Remove Effects', disabled: !hasSel, onSelect: () => cmd.removeEffects(selectedClipIds()) },
        { label: 'Reveal in Project', disabled: !hasSel, onSelect: () => cmd.revealInProject() },
        { label: 'Match Frame', shortcut: sc('matchFrame'), onSelect: () => cmd.matchFrame() },
      ],
    },
    {
      title: 'Sequence',
      items: () => [
        { label: 'Sequence Settings...', onSelect: () => openModal({ kind: 'sequenceSettings' }) },
        { separator: true },
        { label: 'Add Edit', shortcut: sc('addEdit'), onSelect: () => cmd.razorAtPlayhead(false) },
        { label: 'Add Edit to All Tracks', shortcut: sc('addEditAll'), onSelect: () => cmd.razorAtPlayhead(true) },
        { label: 'Apply Video Transition', shortcut: sc('defaultTransition'), onSelect: () => cmd.applyDefaultTransition('video') },
        { label: 'Apply Audio Transition', shortcut: sc('defaultAudioTransition'), onSelect: () => cmd.applyDefaultTransition('audio') },
        { label: 'Apply Default Transitions to Selection', onSelect: () => cmd.applyDefaultTransition('both') },
        { separator: true },
        { label: 'Lift', shortcut: sc('lift'), onSelect: () => cmd.liftExtract(false) },
        { label: 'Extract', shortcut: sc('extract'), onSelect: () => cmd.liftExtract(true) },
        { label: 'Insert from Source', shortcut: sc('insert'), onSelect: () => cmd.insertOverwriteFromSource('insert') },
        { label: 'Overwrite from Source', shortcut: sc('overwrite'), onSelect: () => cmd.insertOverwriteFromSource('overwrite') },
        { separator: true },
        { label: 'Close Gap at Playhead', onSelect: () => cmd.closeGapAtPlayhead() },
        { label: 'Remove All Gaps', onSelect: () => cmd.removeAllGaps() },
        { separator: true },
        { label: 'Add Video Track', onSelect: () => cmd.addTrack('video') },
        { label: 'Add Audio Track', onSelect: () => cmd.addTrack('audio') },
        { label: 'Delete Empty Tracks', onSelect: () => cmd.deleteEmptyTracks() },
        { separator: true },
        { label: 'Go to Previous Edit', shortcut: sc('prevEdit'), onSelect: () => cmd.goTo('prevEdit') },
        { label: 'Go to Next Edit', shortcut: sc('nextEdit'), onSelect: () => cmd.goTo('nextEdit') },
        { separator: true },
        { label: 'Snap', shortcut: sc('snap'), checked: useUI.getState().snapping, onSelect: () => useUI.getState().setSnapping(!useUI.getState().snapping) },
        { label: 'Linked Selection', checked: useUI.getState().linkedSelection, onSelect: () => useUI.getState().setLinkedSelection(!useUI.getState().linkedSelection) },
        { label: 'Loop Playback', shortcut: sc('loop'), checked: usePlayback.getState().loop, onSelect: () => usePlayback.getState().setLoop(!usePlayback.getState().loop) },
        { separator: true },
        { label: 'Detect Beats...', onSelect: () => openModal({ kind: 'beatDetect' }) },
        { label: 'Cut to Beats', onSelect: () => void cmd.cutToBeats() },
        { label: 'Auto Reframe...', onSelect: () => openModal({ kind: 'autoReframe' }) },
      ],
    },
    {
      title: 'Markers',
      items: () => [
        { label: 'Mark In', shortcut: sc('markIn'), onSelect: () => cmd.markIn() },
        { label: 'Mark Out', shortcut: sc('markOut'), onSelect: () => cmd.markOut() },
        { label: 'Mark Clip', shortcut: sc('markClip'), onSelect: () => cmd.markClip() },
        { separator: true },
        { label: 'Go to In', shortcut: sc('goIn'), onSelect: () => cmd.goTo('in') },
        { label: 'Go to Out', shortcut: sc('goOut'), onSelect: () => cmd.goTo('out') },
        { label: 'Clear In', shortcut: sc('clearIn'), onSelect: () => cmd.clearInOut('in') },
        { label: 'Clear Out', shortcut: sc('clearOut'), onSelect: () => cmd.clearInOut('out') },
        { label: 'Clear In and Out', shortcut: sc('clearInOut'), onSelect: () => cmd.clearInOut('both') },
        { separator: true },
        { label: 'Add Marker', shortcut: sc('addMarker'), onSelect: () => cmd.addMarker() },
        { label: 'Add Chapter Marker', onSelect: () => cmd.addMarker({ kind: 'chapter', color: 'purple', name: 'Chapter' }) },
        { label: 'Edit Marker...', onSelect: () => openModal({ kind: 'markerEdit', payload: { markerId: cmd.addMarker() } }) },
        { label: 'Go to Next Marker', shortcut: sc('nextMarker'), onSelect: () => cmd.goTo('nextMarker') },
        { label: 'Go to Previous Marker', shortcut: sc('prevMarker'), onSelect: () => cmd.goTo('prevMarker') },
        { separator: true },
        { label: 'Clear Selected Marker', onSelect: () => cmd.clearSelectedMarkers() },
        { label: 'Clear All Markers', danger: true, onSelect: () => cmd.clearAllMarkers() },
      ],
    },
    {
      title: 'Graphics',
      items: () => [
        { label: 'New Layer: Text', onSelect: () => openModal({ kind: 'newItem', payload: { kind: 'graphic', layer: 'text' } }) },
        { label: 'New Layer: Rectangle', onSelect: () => openModal({ kind: 'newItem', payload: { kind: 'graphic', layer: 'rect' } }) },
        { label: 'New Layer: Ellipse', onSelect: () => openModal({ kind: 'newItem', payload: { kind: 'graphic', layer: 'ellipse' } }) },
        { separator: true },
        { label: 'Essential Graphics Panel', onSelect: () => useLayout.getState().openPanel(ws, 'essentialGraphics') },
        { label: 'Captions Panel', onSelect: () => useLayout.getState().openPanel(ws, 'captions') },
        { separator: true },
        { label: 'Create Captions from Transcript...', onSelect: () => openModal({ kind: 'captionsImport' }) },
        { label: 'Import Captions File...', onSelect: () => void cmd.importCaptions() },
      ],
    },
    {
      title: 'Window',
      items: () => [
        {
          label: 'Workspaces',
          submenu: [
            ...WORKSPACES.map((w) => ({ label: w.label, checked: workspace === w.id, onSelect: () => setWorkspace(w.id) })),
            { separator: true },
            { label: 'Reset to Saved Layout', onSelect: () => useLayout.getState().reset(ws) },
            { label: 'Reset All Workspaces', onSelect: () => useLayout.getState().resetAll() },
            { label: 'Manage Workspaces...', onSelect: () => openModal({ kind: 'workspaceManager' }) },
          ],
        },
        { label: 'Maximize Frame', shortcut: '`', onSelect: () => useUI.getState().setMaximizedPanel(useUI.getState().maximizedPanel ? null : useUI.getState().focusedPanel) },
        { separator: true },
        ...(Object.keys(PANEL_TITLES) as PanelId[])
          .sort((a, b) => PANEL_TITLES[a].localeCompare(PANEL_TITLES[b]))
          .map((p) => ({ label: PANEL_TITLES[p], onSelect: () => useLayout.getState().openPanel(ws, p) })),
      ],
    },
    {
      title: 'Help',
      items: () => [
        { label: 'Keyboard Shortcuts...', shortcut: sc('shortcuts'), onSelect: () => openModal({ kind: 'keyboardShortcuts' }) },
        { label: 'Welcome Screen', onSelect: () => openModal({ kind: 'welcome' }) },
        { label: 'Learn Panel', onSelect: () => useLayout.getState().openPanel(ws, 'learn') },
        { separator: true },
        { label: `Effects installed: ${EFFECTS.length} video, ${AUDIO_EFFECTS.length} audio, ${TRANSITIONS.length + AUDIO_TRANSITIONS.length} transitions`, disabled: true },
        { separator: true },
        { label: 'About Vanguard Studio Pro', onSelect: () => openModal({ kind: 'about' }) },
      ],
    },
  ];

  const menus = buildMenus();

  const openAt = (i: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setOpen({ index: i, x: r.left, y: r.bottom });
  };

  return (
    <div className="menubar" ref={barRef} role="menubar">
      <div className="brand" title="Vanguard Studio Pro">
        <svg className="mark" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M1.5 2.5h3l3.5 8 3.5-8h3L9.5 13.5h-3z" fill="currentColor" />
        </svg>
        <span>Vanguard Studio</span>
        <span className="pro">Pro</span>
      </div>
      {menus.map((m, i) => (
        <button key={m.title} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open?.index === i} className={`mb-item ${open?.index === i ? 'open' : ''}`} onPointerDown={(e) => (open?.index === i ? setOpen(null) : openAt(i, e.currentTarget))} onPointerEnter={(e) => open && open.index !== i && openAt(i, e.currentTarget)}>
          {m.title}
        </button>
      ))}
      <div className="workspaces" role="tablist" aria-label="Workspaces">
        {WORKSPACES.map((w) => (
          <button key={w.id} type="button" role="tab" aria-selected={workspace === w.id} className={workspace === w.id ? 'on' : ''} onClick={() => setWorkspace(w.id)}>
            {w.label}
          </button>
        ))}
      </div>
      <div className="right">
        <Icon name="fileJson" size={12} style={{ color: 'var(--c-text-faint)' }} />
        <span className={`project-name ${dirty ? 'dirty' : ''}`} title={dirty ? 'Unsaved changes' : 'Saved'}>
          {projectName}
        </span>
      </div>
      {open ? <MenuList items={menus[open.index].items()} x={open.x} y={open.y} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function labelItems(): ContextMenuItem[] {
  return (Object.keys(LABEL_COLORS) as LabelColor[]).map((l) => ({
    label: l.charAt(0).toUpperCase() + l.slice(1),
    onSelect: () => cmd.setLabel(l),
  }));
}

function scaleToFrame(mode: 'fit' | 'fill') {
  const ids = selectedClipIds();
  useProject.getState().update(mode === 'fit' ? 'Scale to frame size' : 'Set to frame size', (p) => {
    const seq = p.sequences.find((s) => s.id === p.activeSequenceId);
    if (!seq) return;
    for (const c of seq.clips) {
      if (!ids.includes(c.id)) continue;
      const a = p.assets.find((x) => x.id === c.assetId);
      const w = a?.width ?? seq.settings.width,
        h = a?.height ?? seq.settings.height;
      const sx = seq.settings.width / w,
        sy = seq.settings.height / h;
      const s = mode === 'fit' ? Math.min(sx, sy) : Math.max(sx, sy);
      c.motion.scale = { ...c.motion.scale, value: s * 100, keyframes: undefined, animated: false };
    }
  });
}

function resetMotion() {
  const ids = selectedClipIds();
  useProject.getState().update('Reset motion', (p) => {
    const seq = p.sequences.find((s) => s.id === p.activeSequenceId);
    if (!seq) return;
    for (const c of seq.clips) {
      if (!ids.includes(c.id)) continue;
      c.motion.position = { value: [0.5, 0.5] };
      c.motion.scale = { value: 100 };
      c.motion.scaleWidth = { value: 100 };
      c.motion.rotation = { value: 0 };
      c.motion.anchor = { value: [0.5, 0.5] };
      c.motion.opacity = { value: 100 };
    }
  });
}

function setAudioProp(key: 'muted' | 'invertPhase' | 'channelMode', value: any) {
  const ids = selectedClipIds();
  useProject.getState().update('Audio option', (p) => {
    const seq = p.sequences.find((s) => s.id === p.activeSequenceId);
    if (!seq) return;
    for (const c of seq.clips) {
      if (!ids.includes(c.id)) continue;
      if (value === 'toggle') (c.audio as any)[key] = !(c.audio as any)[key];
      else (c.audio as any)[key] = value;
    }
  });
}

export const MenuBarMemo = React.memo(MenuBar);
