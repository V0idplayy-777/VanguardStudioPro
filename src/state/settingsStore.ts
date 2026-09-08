import { create } from 'zustand';
import type { WorkspaceId } from './uiStore';

/*
  Application settings (user preferences that live outside any project).

  Persisted to localStorage under 'vsp.settings.v1'. Everything that affects
  the document (theme, scale, motion, contrast) is applied by settings.ts
  `applyDocumentSettings`, called on boot and on every change.
*/

export type ThumbQuality = 'off' | 'low' | 'high';
export type UiScale = 85 | 95 | 100 | 105 | 115 | 125;
export type StartupWorkspace = WorkspaceId | 'last';

export interface SettingsState {
  /* Appearance */
  uiScale: number; // percent of default size
  accent: string; // hex; drives --c-accent and friends
  /** Appearance > brighter seams + panel fills for dim rooms. */
  brightSurfaces: boolean;

  /* Import */
  /** How media is scaled when placed on the timeline: native pixels, fit or fill the frame. */
  importScaleMode: 'native' | 'fit' | 'fill';
  /** When the project has no sequence, the first imported video/image creates one that matches. */
  importAutoSequence: boolean;

  /* Export */
  /** Preset applied when the Export panel opens ('none' keeps per-sequence defaults). */
  exportDefaultPreset: string;
  /** Default output file name. */
  exportFilenameMode: 'sequence' | 'project' | 'dated';
  /** Save the file as soon as an export (or queue item) finishes. */
  exportAutoDownload: boolean;
  /** Start with "burn captions" ticked when the sequence has captions. */
  exportBurnCaptions: boolean;

  /* Workspace */
  /** Workspace shown at launch. */
  startupWorkspace: StartupWorkspace;
  /** Show the welcome screen at launch. */
  showWelcomeOnStartup: boolean;

  /* Notifications */
  /** Chime when an export or the render queue finishes. */
  soundOnExport: boolean;
  /** Seconds a toast stays on screen. */
  toastDuration: number;

  /* Accessibility */
  reduceMotion: boolean;
  highContrast: boolean;
  largerText: boolean;
  strongFocus: boolean;
  /** Photosensitivity: disable strobe / flashing video effects. */
  disableFlashingEffects: boolean;
  /** Announce completed jobs with a toast even when the panel is hidden. */
  verboseToasts: boolean;

  /* Playback */
  defaultProgramQuality: 'full' | 'half' | 'quarter';
  /** Let the engine drop to half resolution when rendering falls behind. */
  autoQualityDrop: boolean;
  /** Park on the last content frame instead of the empty end frame. */
  parkOnLastFrame: boolean;

  /* Performance */
  thumbnailQuality: ThumbQuality;
  showFpsOverlay: boolean;
  /** Decode cache size (frames per source), 24-160. */
  decodeCacheSize: number;

  /* Experimental */
  /** Render composites into half-float targets (disable for old GPUs). */
  floatPipeline: boolean;
  /** Present monitors from a GPU snapshot of each frame (stability path). */
  snapshotPresentation: boolean;
  /** Low-latency canvas hint for the compositor. */
  desyncCanvas: boolean;
  /** Show decode/render diagnostics in the Events panel. */
  debugRenderLogging: boolean;

  set: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
  reset: () => void;
}

const STORAGE_KEY = 'vsp.settings.v1';

export const SETTINGS_META: Record<string, { label: string; category: string; hint?: string }> = {
  uiScale: { label: 'Interface scale', category: 'Appearance', hint: 'Sizes the whole UI. 100% is the default.' },
  accent: { label: 'Accent color', category: 'Appearance' },
  brightSurfaces: { label: 'Brighter surfaces', category: 'Appearance', hint: 'Lifts panels and seams for dim rooms or projectors.' },
  importScaleMode: { label: 'Default media scale', category: 'Import', hint: 'How clips are scaled when they are added to the timeline.' },
  importAutoSequence: { label: 'Auto-create sequence on import', category: 'Import', hint: 'When the project has no sequence, the first imported video or image creates one that matches its size and rate.' },
  exportDefaultPreset: { label: 'Opening preset', category: 'Export', hint: 'Applied when the Export panel opens.' },
  exportFilenameMode: { label: 'File name', category: 'Export', hint: 'Default output file name for exports and queue items.' },
  exportAutoDownload: { label: 'Download automatically', category: 'Export', hint: 'Save the file as soon as an export or queue item finishes.' },
  exportBurnCaptions: { label: 'Burn captions by default', category: 'Export', hint: 'Start with caption burn-in ticked when the sequence has captions.' },
  startupWorkspace: { label: 'Startup workspace', category: 'Workspace', hint: 'The workspace shown when the app launches.' },
  showWelcomeOnStartup: { label: 'Welcome screen on startup', category: 'Workspace' },
  soundOnExport: { label: 'Sound when an export finishes', category: 'Notifications', hint: 'A short chime when an export or the render queue completes.' },
  toastDuration: { label: 'Notification duration', category: 'Notifications', hint: 'Seconds a toast stays on screen.' },
  reduceMotion: { label: 'Reduce motion', category: 'Accessibility', hint: 'Removes animations and transitions across the app.' },
  highContrast: { label: 'High contrast interface', category: 'Accessibility', hint: 'Stronger text and edge contrast.' },
  largerText: { label: 'Larger text', category: 'Accessibility', hint: 'Bumps base font size without scaling the layout.' },
  strongFocus: { label: 'Strong focus rings', category: 'Accessibility', hint: 'Thicker keyboard focus outlines.' },
  disableFlashingEffects: { label: 'Disable flashing effects', category: 'Accessibility', hint: 'Blocks strobe and flash effects from playing - important for photosensitivity.' },
  verboseToasts: { label: 'Verbose notifications', category: 'Notifications' },
  defaultProgramQuality: { label: 'Program monitor resolution', category: 'Playback' },
  autoQualityDrop: { label: 'Drop quality to keep up', category: 'Playback', hint: 'Falls back to half resolution during playback when rendering falls behind.' },
  parkOnLastFrame: { label: 'End on the last video frame', category: 'Playback', hint: 'When playback reaches the end, show the last frame instead of the empty end frame.' },
  thumbnailQuality: { label: 'Timeline thumbnails', category: 'Performance' },
  showFpsOverlay: { label: 'Show performance overlay', category: 'Performance', hint: 'Frame rate, render time and dropped frames on the Program Monitor.' },
  decodeCacheSize: { label: 'Decode cache (frames)', category: 'Performance' },
  floatPipeline: { label: 'Half-float render pipeline', category: 'Experimental' },
  snapshotPresentation: { label: 'Snapshot presentation', category: 'Experimental', hint: 'Monitors present from a private copy of each rendered frame. Turn off only if you see display issues on exotic drivers.' },
  desyncCanvas: { label: 'Low-latency canvas', category: 'Experimental' },
  debugRenderLogging: { label: 'Render debug logging', category: 'Experimental' },
};

export const ACCENT_PRESETS: { name: string; value: string }[] = [
  { name: 'Vanguard Blue', value: '#3d7bd9' },
  { name: 'Cyan', value: '#2fa8a0' },
  { name: 'Violet', value: '#7d5fd9' },
  { name: 'Magenta', value: '#c05ca8' },
  { name: 'Orange', value: '#cf7b35' },
  { name: 'Green', value: '#5c9a4f' },
  { name: 'Graphite', value: '#8d8d8d' },
];

const DEFAULTS = {
  uiScale: 100,
  accent: '#3d7bd9',
  brightSurfaces: false,

  importScaleMode: 'native' as const,
  importAutoSequence: false,

  exportDefaultPreset: 'none',
  exportFilenameMode: 'sequence' as const,
  exportAutoDownload: true,
  exportBurnCaptions: true,

  startupWorkspace: 'last' as StartupWorkspace,
  showWelcomeOnStartup: true,

  soundOnExport: true,
  toastDuration: 4.5,

  reduceMotion: false,
  highContrast: false,
  largerText: false,
  strongFocus: false,
  disableFlashingEffects: false,
  verboseToasts: true,

  defaultProgramQuality: 'full' as const,
  autoQualityDrop: true,
  parkOnLastFrame: true,

  thumbnailQuality: 'high' as const,
  showFpsOverlay: false,
  decodeCacheSize: 48,

  floatPipeline: true,
  snapshotPresentation: true,
  desyncCanvas: true,
  debugRenderLogging: false,
};

function loadPersisted(): Partial<SettingsState> {
  try {
    const clean: Record<string, unknown> = {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      for (const k of Object.keys(DEFAULTS) as string[]) if (k in parsed) clean[k] = parsed[k];
    }
    // Migration: the welcome screen used to be dismissed via its own local key.
    if (!('showWelcomeOnStartup' in clean) && localStorage.getItem('vsp.skipWelcome') === '1') clean.showWelcomeOnStartup = false;
    return clean as Partial<SettingsState>;
  } catch {
    return {};
  }
}

function persist(s: SettingsState) {
  try {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(DEFAULTS)) out[k] = (s as unknown as Record<string, unknown>)[k];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    /* storage full or unavailable - settings stay for this session */
  }
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...DEFAULTS,
  ...loadPersisted(),
  set: (key, value) => {
    set({ [key]: value } as Partial<SettingsState>);
    persist(get());
    applyDocumentSettings(get());
  },
  reset: () => {
    set({ ...DEFAULTS });
    persist(get());
    applyDocumentSettings(get());
  },
}));

/** Apply theme / a11y settings to the document root. Idempotent. */
export function applyDocumentSettings(s: SettingsState) {
  const root = document.documentElement;
  root.style.setProperty('--ui-scale', String(s.uiScale / 100));
  root.style.setProperty('--c-accent', s.accent);
  root.style.setProperty('--c-accent-dim', s.accent + '99');
  root.style.setProperty('--c-accent-text', s.accent);
  root.style.setProperty('--c-selection', s.accent);
  root.style.setProperty('--c-playhead', s.accent);
  root.classList.toggle('reduce-motion', s.reduceMotion);
  root.classList.toggle('high-contrast', s.highContrast);
  root.classList.toggle('larger-text', s.largerText);
  root.classList.toggle('strong-focus', s.strongFocus);
  root.classList.toggle('bright-surfaces', s.brightSurfaces);
}

/** Non-hook accessor for engine code. */
export function settings() {
  return useSettings.getState();
}
