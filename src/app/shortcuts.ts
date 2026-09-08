import { useEffect } from 'react';
import { useUI, type ToolId } from '../state/uiStore';
import { useProject } from '../state/projectStore';
import { usePlayback } from '../engine/playback/playback';
import { cmd } from './commands';
import { useLayout } from '../state/layoutStore';
import { useSettings } from '../state/settingsStore';
import { shortcutOverrides } from '../state/shortcutStore';
import { isMac } from '../engine/util';
import { secretKey } from '../easter/eggs';

export interface ShortcutDef {
  id: string;
  keys: string;
  label: string;
  category: string;
  run: (e: KeyboardEvent) => void;
}

const mod = isMac() ? 'Cmd' : 'Ctrl';

const TOOL_KEYS: Record<string, ToolId> = { v: 'select', a: 'trackSelectFwd', b: 'ripple', n: 'rolling', r: 'rateStretch', c: 'razor', y: 'slip', u: 'slide', p: 'pen', h: 'hand', z: 'zoom' };

export const SHORTCUTS: ShortcutDef[] = [
  // Transport
  { id: 'play', keys: 'Space', label: 'Play / Stop', category: 'Playback', run: () => usePlayback.getState().toggle() },
  { id: 'shuttleL', keys: 'J', label: 'Shuttle left (press again to speed up)', category: 'Playback', run: () => usePlayback.getState().shuttle(-1) },
  { id: 'shuttleStop', keys: 'K', label: 'Shuttle stop', category: 'Playback', run: () => usePlayback.getState().shuttle(0) },
  { id: 'shuttleR', keys: 'L', label: 'Shuttle right (press again to speed up)', category: 'Playback', run: () => usePlayback.getState().shuttle(1) },
  { id: 'stepBack', keys: 'Left', label: 'Step back 1 frame', category: 'Playback', run: () => usePlayback.getState().step(-1) },
  { id: 'stepFwd', keys: 'Right', label: 'Step forward 1 frame', category: 'Playback', run: () => usePlayback.getState().step(1) },
  { id: 'step5Back', keys: 'Shift+Left', label: 'Step back 5 frames', category: 'Playback', run: () => usePlayback.getState().step(-5) },
  { id: 'step5Fwd', keys: 'Shift+Right', label: 'Step forward 5 frames', category: 'Playback', run: () => usePlayback.getState().step(5) },
  { id: 'home', keys: 'Home', label: 'Go to sequence start', category: 'Playback', run: () => cmd.goTo('start') },
  { id: 'end', keys: 'End', label: 'Go to sequence end', category: 'Playback', run: () => cmd.goTo('end') },
  { id: 'prevEdit', keys: 'Up', label: 'Go to previous edit point', category: 'Playback', run: () => cmd.goTo('prevEdit') },
  { id: 'nextEdit', keys: 'Down', label: 'Go to next edit point', category: 'Playback', run: () => cmd.goTo('nextEdit') },
  { id: 'goIn', keys: 'Shift+I', label: 'Go to in point', category: 'Playback', run: () => cmd.goTo('in') },
  { id: 'goOut', keys: 'Shift+O', label: 'Go to out point', category: 'Playback', run: () => cmd.goTo('out') },
  { id: 'loop', keys: `${mod}+L`, label: 'Toggle loop playback', category: 'Playback', run: () => usePlayback.getState().setLoop(!usePlayback.getState().loop) },
  { id: 'prevMarker', keys: `${mod}+Shift+M`, label: 'Go to previous marker', category: 'Markers', run: () => cmd.goTo('prevMarker') },
  { id: 'nextMarker', keys: 'Shift+M', label: 'Go to next marker', category: 'Markers', run: () => cmd.goTo('nextMarker') },
  { id: 'addMarker', keys: 'M', label: 'Add marker', category: 'Markers', run: () => cmd.addMarker() },
  { id: 'markIn', keys: 'I', label: 'Mark in', category: 'Marking', run: () => cmd.markIn() },
  { id: 'markOut', keys: 'O', label: 'Mark out', category: 'Marking', run: () => cmd.markOut() },
  { id: 'markClip', keys: 'X', label: 'Mark clip / selection', category: 'Marking', run: () => cmd.markClip() },
  { id: 'clearIn', keys: `${mod}+Shift+I`, label: 'Clear in', category: 'Marking', run: () => cmd.clearInOut('in') },
  { id: 'clearOut', keys: `${mod}+Shift+O`, label: 'Clear out', category: 'Marking', run: () => cmd.clearInOut('out') },
  { id: 'clearInOut', keys: `${mod}+Shift+X`, label: 'Clear in and out', category: 'Marking', run: () => cmd.clearInOut('both') },
  // Editing
  { id: 'undo', keys: `${mod}+Z`, label: 'Undo', category: 'Edit', run: () => cmd.undo() },
  { id: 'redo', keys: `${mod}+Shift+Z`, label: 'Redo', category: 'Edit', run: () => cmd.redo() },
  { id: 'cut', keys: `${mod}+X`, label: 'Cut', category: 'Edit', run: () => cmd.cut() },
  { id: 'copy', keys: `${mod}+C`, label: 'Copy', category: 'Edit', run: () => cmd.copy() },
  { id: 'paste', keys: `${mod}+V`, label: 'Paste', category: 'Edit', run: () => cmd.paste(false) },
  { id: 'pasteInsert', keys: `${mod}+Shift+V`, label: 'Paste insert', category: 'Edit', run: () => cmd.paste(true) },
  { id: 'pasteAttr', keys: `${mod}+Alt+V`, label: 'Paste attributes', category: 'Edit', run: () => cmd.pasteAttributes({ motion: true, audio: true, effects: true }) },
  { id: 'duplicate', keys: 'Alt+Shift+D', label: 'Duplicate', category: 'Edit', run: () => cmd.duplicate() },
  { id: 'selectAll', keys: `${mod}+A`, label: 'Select all', category: 'Edit', run: () => cmd.selectAll() },
  { id: 'deselectAll', keys: `${mod}+Shift+A`, label: 'Deselect all', category: 'Edit', run: () => cmd.deselectAll() },
  { id: 'delete', keys: 'Delete', label: 'Clear (delete selection)', category: 'Edit', run: () => cmd.deleteSelection(false) },
  { id: 'deleteBs', keys: 'Backspace', label: 'Clear (delete selection)', category: 'Edit', run: () => cmd.deleteSelection(false) },
  { id: 'rippleDelete', keys: 'Shift+Delete', label: 'Ripple delete', category: 'Edit', run: () => cmd.deleteSelection(true) },
  { id: 'rippleDeleteBs', keys: 'Shift+Backspace', label: 'Ripple delete', category: 'Edit', run: () => cmd.deleteSelection(true) },
  { id: 'addEdit', keys: `${mod}+K`, label: 'Add edit (razor at playhead)', category: 'Sequence', run: () => cmd.razorAtPlayhead(false) },
  { id: 'addEditAll', keys: `${mod}+Shift+K`, label: 'Add edit to all tracks', category: 'Sequence', run: () => cmd.razorAtPlayhead(true) },
  { id: 'defaultTransition', keys: `${mod}+D`, label: 'Apply video transition', category: 'Sequence', run: () => cmd.applyDefaultTransition('video') },
  { id: 'defaultAudioTransition', keys: `${mod}+Shift+D`, label: 'Apply audio transition', category: 'Sequence', run: () => cmd.applyDefaultTransition('audio') },
  { id: 'lift', keys: ';', label: 'Lift', category: 'Sequence', run: () => cmd.liftExtract(false) },
  { id: 'extract', keys: "'", label: 'Extract', category: 'Sequence', run: () => cmd.liftExtract(true) },
  { id: 'insert', keys: ',', label: 'Insert (from Source)', category: 'Sequence', run: () => cmd.insertOverwriteFromSource('insert') },
  { id: 'overwrite', keys: '.', label: 'Overwrite (from Source)', category: 'Sequence', run: () => cmd.insertOverwriteFromSource('overwrite') },
  { id: 'matchFrame', keys: 'F', label: 'Match frame', category: 'Sequence', run: () => cmd.matchFrame() },
  { id: 'enable', keys: 'Shift+E', label: 'Enable / disable clip', category: 'Clip', run: () => cmd.toggleEnabled() },
  { id: 'link', keys: `${mod}+Shift+L`, label: 'Link / unlink', category: 'Clip', run: () => cmd.linkSelection(!(useUI.getState().selection.clipIds.length && seqHasLinked())) },
  { id: 'group', keys: `${mod}+G`, label: 'Group', category: 'Clip', run: () => cmd.groupSelection(true) },
  { id: 'ungroup', keys: `${mod}+Shift+G`, label: 'Ungroup', category: 'Clip', run: () => cmd.groupSelection(false) },
  { id: 'nest', keys: `${mod}+Shift+N`, label: 'Nest', category: 'Clip', run: () => cmd.nestSelection() },
  { id: 'speed', keys: `${mod}+R`, label: 'Speed / Duration', category: 'Clip', run: () => cmd.speedDuration() },
  { id: 'gain', keys: 'G', label: 'Audio gain', category: 'Clip', run: () => cmd.audioGain() },
  { id: 'nudgeL', keys: 'Alt+Left', label: 'Nudge clip left 1 frame', category: 'Clip', run: () => cmd.nudge(-1) },
  { id: 'nudgeR', keys: 'Alt+Right', label: 'Nudge clip right 1 frame', category: 'Clip', run: () => cmd.nudge(1) },
  { id: 'nudgeL5', keys: 'Alt+Shift+Left', label: 'Nudge clip left 5 frames', category: 'Clip', run: () => cmd.nudge(-5) },
  { id: 'nudgeR5', keys: 'Alt+Shift+Right', label: 'Nudge clip right 5 frames', category: 'Clip', run: () => cmd.nudge(5) },
  { id: 'nudgeUp', keys: 'Alt+Up', label: 'Nudge clip up a track', category: 'Clip', run: () => cmd.nudge(0, 1) },
  { id: 'nudgeDown', keys: 'Alt+Down', label: 'Nudge clip down a track', category: 'Clip', run: () => cmd.nudge(0, -1) },
  { id: 'frameHold', keys: `${mod}+Shift+H`, label: 'Add frame hold', category: 'Clip', run: () => cmd.frameHold() },
  { id: 'exportFrame', keys: `${mod}+Shift+E`, label: 'Export frame', category: 'File', run: () => void cmd.exportFrame() },
  { id: 'export', keys: `${mod}+M`, label: 'Export media', category: 'File', run: () => useUI.getState().openModal({ kind: 'export' }) },
  { id: 'import', keys: `${mod}+I`, label: 'Import', category: 'File', run: () => void cmd.importMedia() },
  { id: 'save', keys: `${mod}+S`, label: 'Save project', category: 'File', run: () => void cmd.saveProject(false) },
  { id: 'saveAs', keys: `${mod}+Shift+S`, label: 'Save project with media', category: 'File', run: () => void cmd.saveProject(true) },
  { id: 'open', keys: `${mod}+O`, label: 'Open project', category: 'File', run: () => void cmd.openProject() },
  { id: 'newSeq', keys: `${mod}+N`, label: 'New sequence', category: 'File', run: () => cmd.newSequence() },
  { id: 'newBin', keys: `${mod}+B`, label: 'New bin', category: 'File', run: () => cmd.newBin() },
  { id: 'snap', keys: 'S', label: 'Toggle snapping', category: 'Timeline', run: () => useUI.getState().setSnapping(!useUI.getState().snapping) },
  { id: 'zoomIn', keys: '=', label: 'Zoom in', category: 'Timeline', run: () => timelineZoom(1.5) },
  { id: 'zoomOut', keys: '-', label: 'Zoom out', category: 'Timeline', run: () => timelineZoom(1 / 1.5) },
  { id: 'zoomFit', keys: '\\', label: 'Zoom to sequence', category: 'Timeline', run: () => timelineZoomFit() },
  { id: 'maximize', keys: '`', label: 'Maximize / restore focused panel', category: 'Window', run: () => {} },
  { id: 'shortcuts', keys: `${mod}+Alt+K`, label: 'Keyboard shortcuts', category: 'Window', run: () => useUI.getState().openModal({ kind: 'keyboardShortcuts' }) },
  { id: 'workspaceEdit', keys: 'Alt+Shift+1', label: 'Workspace: Editing', category: 'Window', run: () => useUI.getState().setWorkspace('editing') },
  { id: 'workspaceColor', keys: 'Alt+Shift+2', label: 'Workspace: Color', category: 'Window', run: () => useUI.getState().setWorkspace('color') },
  { id: 'workspaceFx', keys: 'Alt+Shift+3', label: 'Workspace: Effects', category: 'Window', run: () => useUI.getState().setWorkspace('effects') },
  { id: 'workspaceAudio', keys: 'Alt+Shift+4', label: 'Workspace: Audio', category: 'Window', run: () => useUI.getState().setWorkspace('audio') },
  { id: 'workspaceGfx', keys: 'Alt+Shift+5', label: 'Workspace: Graphics', category: 'Window', run: () => useUI.getState().setWorkspace('graphics') },
  { id: 'toolSelect', keys: 'V', label: 'Selection tool', category: 'Tools', run: () => useUI.getState().setTool('select') },
  { id: 'toolTrack', keys: 'A', label: 'Track select forward (Shift+A backward)', category: 'Tools', run: () => useUI.getState().setTool('trackSelectFwd') },
  { id: 'toolTrackBack', keys: 'Shift+A', label: 'Track select backward', category: 'Tools', run: () => useUI.getState().setTool('trackSelectBack') },
  { id: 'toolRipple', keys: 'B', label: 'Ripple edit tool', category: 'Tools', run: () => useUI.getState().setTool('ripple') },
  { id: 'toolRolling', keys: 'N', label: 'Rolling edit tool', category: 'Tools', run: () => useUI.getState().setTool('rolling') },
  { id: 'toolRate', keys: 'R', label: 'Rate stretch tool', category: 'Tools', run: () => useUI.getState().setTool('rateStretch') },
  { id: 'toolRazor', keys: 'C', label: 'Razor tool', category: 'Tools', run: () => useUI.getState().setTool('razor') },
  { id: 'toolSlip', keys: 'Y', label: 'Slip tool', category: 'Tools', run: () => useUI.getState().setTool('slip') },
  { id: 'toolSlide', keys: 'U', label: 'Slide tool', category: 'Tools', run: () => useUI.getState().setTool('slide') },
  { id: 'toolPen', keys: 'P', label: 'Pen tool', category: 'Tools', run: () => useUI.getState().setTool('pen') },
  { id: 'toolHand', keys: 'H', label: 'Hand tool', category: 'Tools', run: () => useUI.getState().setTool('hand') },
  { id: 'toolZoom', keys: 'Z', label: 'Zoom tool', category: 'Tools', run: () => useUI.getState().setTool('zoom') },
  { id: 'escape', keys: 'Esc', label: 'Cancel / deselect', category: 'Edit', run: () => escapeAction() },
  { id: 'palette', keys: `${mod}+Shift+P`, label: 'Command palette', category: 'Window', run: () => void import('../ui/CommandPalette').then((m) => m.usePalette.getState().toggle()) },
  { id: 'settings', keys: `${mod}+,`, label: 'Settings', category: 'Window', run: () => useUI.getState().openModal({ kind: 'preferences' }) },
  // Proxies, captions, AI, storyboard
  { id: 'toggleProxy', keys: 'Shift+P', label: 'Toggle proxy playback', category: 'Playback', run: () => void import('../engine/media/proxy').then((m) => m.toggleProxyPlayback()) },
  { id: 'proxyManager', keys: `${mod}+Alt+P`, label: 'Proxy manager', category: 'Playback', run: () => useUI.getState().openModal({ kind: 'proxyManager' }) },
  { id: 'transcribe', keys: `${mod}+Shift+T`, label: 'Transcribe sequence...', category: 'Captions', run: () => useUI.getState().openModal({ kind: 'transcribe' }) },
  { id: 'storyboard', keys: 'T', label: 'Open Storyboard panel', category: 'Window', run: () => {
    const ui = useUI.getState();
    useLayout.getState().openPanel(ui.workspace, 'storyboard');
    ui.setFocusedPanel('storyboard');
  } },
  { id: 'magicMask', keys: `${mod}+Alt+M`, label: 'Magic Mask (AI rotoscope)...', category: 'Effects', run: () => useUI.getState().openModal({ kind: 'magicMask' }) },
  { id: 'voiceCleanup', keys: `${mod}+Alt+A`, label: 'Clean up voice...', category: 'Audio', run: () => useUI.getState().openModal({ kind: 'voiceCleanup' }) },
];

function seqHasLinked() {
  const ui = useUI.getState();
  const seq = useProject.getState().project.sequences.find((s) => s.id === useProject.getState().project.activeSequenceId);
  return !!seq && seq.clips.some((c) => ui.selection.clipIds.includes(c.id) && c.linkId);
}

function escapeAction() {
  const ui = useUI.getState();
  if (ui.contextMenu) return ui.closeContextMenu();
  if (ui.modal) return ui.closeModal();
  if (ui.maximizedPanel) return ui.setMaximizedPanel(null);
  ui.clearSelection();
}

/* Timeline zoom is handled by the timeline component through a tiny event bus. */
type TlEvent = { type: 'zoom'; factor: number } | { type: 'zoomFit' } | { type: 'scrollTo'; frame: number };
const tlListeners = new Set<(e: TlEvent) => void>();
export function onTimelineEvent(fn: (e: TlEvent) => void) {
  tlListeners.add(fn);
  return () => {
    tlListeners.delete(fn);
  };
}
export function timelineZoom(factor: number) {
  tlListeners.forEach((l) => l({ type: 'zoom', factor }));
}
export function timelineZoomFit() {
  tlListeners.forEach((l) => l({ type: 'zoomFit' }));
}
export function timelineScrollTo(frame: number) {
  tlListeners.forEach((l) => l({ type: 'scrollTo', frame }));
}

/** Normalise a KeyboardEvent to our "Ctrl+Shift+K" style descriptor. */
export function describeKey(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push(mod);
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  const map: Record<string, string> = { ' ': 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Escape: 'Esc' };
  if (map[k]) k = map[k];
  else if (k.length === 1) {
    // use the physical key for letters/digits so Shift+= etc. work
    if (/^[a-z]$/i.test(k)) k = k.toUpperCase();
    else if (e.code.startsWith('Digit')) k = e.code.slice(5);
    else if (e.code === 'Equal') k = '=';
    else if (e.code === 'Minus') k = '-';
    else if (e.code === 'Backslash') k = '\\';
    else if (e.code === 'Semicolon') k = ';';
    else if (e.code === 'Quote') k = "'";
    else if (e.code === 'Comma') k = ',';
    else if (e.code === 'Period') k = '.';
    else if (e.code === 'Backquote') k = '`';
  }
  parts.push(k);
  return parts.join('+');
}

/**
 * Factory defaults plus the user's remapping overrides. Unassigned commands
 * carry `keys: ''` and are skipped by the dispatcher.
 */
export function effectiveShortcuts(): ShortcutDef[] {
  const { overrides, removed } = shortcutOverrides();
  return SHORTCUTS.map((s) => {
    if (removed.includes(s.id)) return { ...s, keys: '' };
    const o = overrides[s.id];
    return o ? { ...s, keys: o } : s;
  });
}

/** Find the command currently bound to `keys` (for conflict warnings), if any. */
export function shortcutConflict(keys: string, exceptId?: string): ShortcutDef | undefined {
  return effectiveShortcuts().find((s) => s.keys === keys && s.id !== exceptId);
}

export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUI.getState();
      const target = e.target as HTMLElement;
      const inText = ui.textEditing || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
      secretKey(e);
      if (inText) {
        // The command palette opens even from text fields.
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
          e.preventDefault();
          void import('../ui/CommandPalette').then((m) => m.usePalette.getState().toggle());
          return;
        }
        // allow Esc to blur
        if (e.key === 'Escape') (target as HTMLElement).blur?.();
        return;
      }
      if (ui.modal && e.key !== 'Escape') {
        // In modals only allow Cmd/Ctrl combos that are not destructive
        if (!(e.ctrlKey || e.metaKey)) return;
      }
      const desc = describeKey(e);
      const def = effectiveShortcuts().find((s) => s.keys !== '' && s.keys === desc);
      if (!def) {
        // Single-letter tools
        if (!e.ctrlKey && !e.metaKey && !e.altKey && TOOL_KEYS[e.key.toLowerCase()] && !e.shiftKey) {
          ui.setTool(TOOL_KEYS[e.key.toLowerCase()]);
          e.preventDefault();
        }
        return;
      }
      if (def.id === 'maximize') return; // handled by dock
      e.preventDefault();
      e.stopPropagation();
      def.run(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Persist layouts on unload for good measure
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (useProject.getState().dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
      void useLayout.getState();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);
}

export function shortcutFor(id: string): string | undefined {
  const s = effectiveShortcuts().find((x) => x.id === id);
  return s && s.keys !== '' ? s.keys : undefined;
}
