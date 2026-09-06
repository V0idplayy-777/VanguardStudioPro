/*
  Core document model for Vanguard Studio Pro.

  Units:
  - Timeline positions and durations are integer FRAMES of the owning sequence.
  - Source media positions (inPoint) are SECONDS in the source file.
  - Keyframe times are frames relative to the clip's timeline start.
*/

export type Id = string;

export type LabelColor =
  | 'violet'
  | 'iris'
  | 'caribbean'
  | 'lavender'
  | 'cerulean'
  | 'forest'
  | 'rose'
  | 'mango'
  | 'purple'
  | 'blue'
  | 'teal'
  | 'magenta'
  | 'tan'
  | 'green'
  | 'brown'
  | 'yellow';

export const LABEL_COLORS: Record<LabelColor, string> = {
  violet: '#6f5ea8',
  iris: '#5c6fb5',
  caribbean: '#3f8f95',
  lavender: '#8a76b8',
  cerulean: '#3f7fb0',
  forest: '#4f8a5c',
  rose: '#b05c7a',
  mango: '#c48a3e',
  purple: '#7d4f9e',
  blue: '#3f6fb5',
  teal: '#3f9a8a',
  magenta: '#a84f8f',
  tan: '#a88a5e',
  green: '#5f9a4f',
  brown: '#8a6a4a',
  yellow: '#b5a23f',
};

export type MediaKind = 'video' | 'audio' | 'image' | 'sequence' | 'generator';

export type GeneratorKind = 'colorMatte' | 'adjustmentLayer' | 'blackVideo' | 'barsAndTone' | 'graphic' | 'countdown';

export interface MediaAsset {
  id: Id;
  kind: MediaKind;
  name: string;
  binId: Id | null;
  label: LabelColor;
  /** File properties, when the asset is backed by a file. */
  file?: {
    name: string;
    size: number;
    type: string;
    lastModified: number;
  };
  /** Present for time based media (seconds). */
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  audioChannels?: number;
  sampleRate?: number;
  /** Generator specifics. */
  generator?: GeneratorKind;
  generatorParams?: Record<string, number | string | boolean>;
  /** For kind === 'sequence' the id of the referenced sequence. */
  sequenceId?: Id;
  /** For graphic assets, the layer stack. */
  graphic?: GraphicDocument;
  /** Source monitor in/out (seconds). */
  srcIn?: number;
  srcOut?: number;
  /** Whether the media is currently missing (needs relinking). */
  offline: boolean;
  createdAt: number;
  meta: AssetMetadata;
  /** Optional per-asset interpretation overrides. */
  interpret?: {
    fps?: number;
    pixelAspect?: number;
    alpha?: 'straight' | 'premultiplied' | 'ignore';
  };
}

export interface AssetMetadata {
  description?: string;
  logNote?: string;
  scene?: string;
  shot?: string;
  take?: string;
  good?: boolean;
  comment?: string;
  tags?: string[];
}

export interface Bin {
  id: Id;
  name: string;
  parentId: Id | null;
  label: LabelColor;
  expanded: boolean;
}

export type Interpolation = 'linear' | 'bezier' | 'hold' | 'easeIn' | 'easeOut' | 'easeInOut';

export interface Keyframe<T = number> {
  /** Frame relative to the clip start (may be negative if trimmed later). */
  t: number;
  v: T;
  interp: Interpolation;
  /** Optional bezier handles (influence 0..1 along time, value slope) for 'bezier'. */
  bezier?: { inX: number; inY: number; outX: number; outY: number };
}

export type ParamValue = number | boolean | string | [number, number] | [number, number, number, number] | number[];

export interface Param<T extends ParamValue = ParamValue> {
  value: T;
  keyframes?: Keyframe<T>[];
  /** Whether the stopwatch is enabled; when true edits write/add keyframes. */
  animated?: boolean;
}

export type MaskShape = 'rectangle' | 'ellipse' | 'polygon';

export interface EffectMask {
  id: Id;
  name: string;
  shape: MaskShape;
  /** Normalised 0..1 in clip space. */
  center: Param<[number, number]>;
  size: Param<[number, number]>;
  rotation: Param<number>;
  feather: Param<number>;
  opacity: Param<number>;
  expansion: Param<number>;
  inverted: boolean;
  /** Polygon points, normalised. */
  points?: [number, number][];
}

export interface EffectInstance {
  id: Id;
  /** Registry key, e.g. 'gaussianBlur'. */
  type: string;
  enabled: boolean;
  params: Record<string, Param>;
  masks: EffectMask[];
  /** Collapsed in Effect Controls UI. */
  collapsed?: boolean;
}

export type BlendMode =
  | 'normal'
  | 'dissolve'
  | 'darken'
  | 'multiply'
  | 'colorBurn'
  | 'linearBurn'
  | 'lighten'
  | 'screen'
  | 'colorDodge'
  | 'linearDodge'
  | 'overlay'
  | 'softLight'
  | 'hardLight'
  | 'vividLight'
  | 'linearLight'
  | 'pinLight'
  | 'hardMix'
  | 'difference'
  | 'exclusion'
  | 'subtract'
  | 'divide'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export const BLEND_MODES: { id: BlendMode; label: string; group: number }[] = [
  { id: 'normal', label: 'Normal', group: 0 },
  { id: 'dissolve', label: 'Dissolve', group: 0 },
  { id: 'darken', label: 'Darken', group: 1 },
  { id: 'multiply', label: 'Multiply', group: 1 },
  { id: 'colorBurn', label: 'Color Burn', group: 1 },
  { id: 'linearBurn', label: 'Linear Burn', group: 1 },
  { id: 'lighten', label: 'Lighten', group: 2 },
  { id: 'screen', label: 'Screen', group: 2 },
  { id: 'colorDodge', label: 'Color Dodge', group: 2 },
  { id: 'linearDodge', label: 'Linear Dodge (Add)', group: 2 },
  { id: 'overlay', label: 'Overlay', group: 3 },
  { id: 'softLight', label: 'Soft Light', group: 3 },
  { id: 'hardLight', label: 'Hard Light', group: 3 },
  { id: 'vividLight', label: 'Vivid Light', group: 3 },
  { id: 'linearLight', label: 'Linear Light', group: 3 },
  { id: 'pinLight', label: 'Pin Light', group: 3 },
  { id: 'hardMix', label: 'Hard Mix', group: 3 },
  { id: 'difference', label: 'Difference', group: 4 },
  { id: 'exclusion', label: 'Exclusion', group: 4 },
  { id: 'subtract', label: 'Subtract', group: 4 },
  { id: 'divide', label: 'Divide', group: 4 },
  { id: 'hue', label: 'Hue', group: 5 },
  { id: 'saturation', label: 'Saturation', group: 5 },
  { id: 'color', label: 'Color', group: 5 },
  { id: 'luminosity', label: 'Luminosity', group: 5 },
];

export interface Transition {
  id: Id;
  /** Registry key, e.g. 'crossDissolve'. */
  type: string;
  /** Duration in frames. */
  duration: number;
  /** How the transition sits relative to the cut. */
  alignment: 'start' | 'center' | 'end';
  params: Record<string, Param>;
}

export interface ClipMotion {
  position: Param<[number, number]>;
  scale: Param<number>;
  scaleWidth: Param<number>;
  uniformScale: boolean;
  rotation: Param<number>;
  anchor: Param<[number, number]>;
  opacity: Param<number>;
  blendMode: BlendMode;
  /** Whether to crop the clip to the frame edge when scaled (no effect on output, reserved). */
  antiFlicker: Param<number>;
}

export interface ClipAudio {
  /** Clip gain in dB (static, "Audio Gain" dialog). */
  gain: number;
  /** Level in dB, keyframable (the rubber band). */
  volume: Param<number>;
  pan: Param<number>;
  muted: boolean;
  channelMode: 'stereo' | 'left' | 'right' | 'swap' | 'mono';
  invertPhase: boolean;
}

export interface Clip {
  id: Id;
  trackId: Id;
  /** Media asset reference. null for pure generator clips which carry their own data. */
  assetId: Id | null;
  name: string;
  /** Timeline start, frames. */
  start: number;
  /** Timeline duration, frames. */
  duration: number;
  /** Source in point, seconds. */
  inPoint: number;
  /** Speed factor. 1 = normal; negative not used, see reversed. */
  speed: number;
  reversed: boolean;
  maintainPitch: boolean;
  /** Frame hold: when set the clip shows a single source frame (seconds). */
  freezeAt?: number;
  enabled: boolean;
  label: LabelColor;
  /** Group of linked clips (audio + video from the same source). */
  linkId: Id | null;
  /** Group of grouped clips (Clip > Group). */
  groupId: Id | null;
  motion: ClipMotion;
  audio: ClipAudio;
  effects: EffectInstance[];
  transitionIn: Transition | null;
  transitionOut: Transition | null;
  /** For nested sequence clips, the sequence id. */
  nestedSequenceId?: Id;
  /** Generator specifics for clips created without an asset (adjustment layers, mattes, graphics). */
  generator?: GeneratorKind;
  generatorParams?: Record<string, number | string | boolean>;
  graphic?: GraphicDocument;
  /** Clip markers. */
  markers: Marker[];
  /** Time remapping keyframes (speed ramps). Value is speed percent. */
  timeRemap?: Keyframe<number>[];
  /** Source channel index for audio clips split out of multi-channel media. */
  audioChannel?: number;
  /** Extra per-clip note shown in Info panel. */
  comment?: string;
}

export type TrackKind = 'video' | 'audio' | 'caption';

export interface Track {
  id: Id;
  kind: TrackKind;
  name: string;
  height: number;
  locked: boolean;
  muted: boolean;
  solo: boolean;
  /** Video: eye toggle. */
  visible: boolean;
  /** Source patching target for insert/overwrite. */
  targeted: boolean;
  syncLocked: boolean;
  /** Audio track fader in dB and pan -1..1. */
  volume: Param<number>;
  pan: Param<number>;
  effects: EffectInstance[];
  /** Show keyframes/rubber band in the track. */
  showKeyframes: 'clip' | 'track' | 'none';
  /** Audio: send to submix id (reserved). */
  output: 'master' | Id;
  /** Caption track: style. */
  captionStyle?: CaptionStyle;
  /** Whether the track is expanded (tall) in the UI. */
  expanded?: boolean;
}

export type MarkerKind = 'comment' | 'chapter' | 'segmentation' | 'webLink' | 'flashCue';

export const MARKER_COLORS: Record<string, string> = { green: '#4da58a', red: '#c9463d', purple: '#7d4f9e', orange: '#c48a3e', yellow: '#b5a23f', white: '#d0d0d0', blue: '#3f6fb5', cyan: '#3f9a8a' };
export function markerColor(m: { color: string }): string {
  return MARKER_COLORS[m.color] ?? (LABEL_COLORS as Record<string, string>)[m.color] ?? '#4da58a';
}

export interface Marker {
  id: Id;
  /** Frames. */
  time: number;
  /** Frames; 0 for a point marker. */
  duration: number;
  name: string;
  comment: string;
  color: LabelColor | 'green' | 'red' | 'purple' | 'orange' | 'yellow' | 'white' | 'blue' | 'cyan';
  kind: MarkerKind;
  url?: string;
}

export interface CaptionItem {
  id: Id;
  /** Frames. */
  start: number;
  end: number;
  text: string;
  /** Optional per item style override. */
  style?: Partial<CaptionStyle>;
}

export interface CaptionStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  color: string;
  backgroundColor: string;
  backgroundOpacity: number;
  edge: 'none' | 'shadow' | 'outline' | 'raised';
  edgeColor: string;
  align: 'left' | 'center' | 'right';
  /** Vertical position 0..1 of the caption baseline box. */
  position: number;
  maxWidth: number;
  letterSpacing: number;
}

export interface SequenceSettings {
  width: number;
  height: number;
  fps: number;
  dropFrame: boolean;
  sampleRate: number;
  pixelAspect: number;
  fieldOrder: 'progressive' | 'upper' | 'lower';
  /** Preview quality divisor for realtime playback (1, 2, 4). */
  previewScale: 1 | 2 | 4;
  colorSpace: 'rec709' | 'srgb';
  /** Maximum bit depth flag (informational - the compositor is float internally). */
  maxBitDepth: boolean;
  maxRenderQuality: boolean;
  workingColorSpace?: string;
}

export interface Sequence {
  id: Id;
  name: string;
  settings: SequenceSettings;
  tracks: Track[];
  clips: Clip[];
  markers: Marker[];
  captions: CaptionItem[];
  captionTrack: { enabled: boolean; burnIn: boolean; style: CaptionStyle; name: string };
  inPoint: number | null;
  outPoint: number | null;
  workArea: { enabled: boolean; start: number; end: number };
  /** Persisted view state. */
  view: {
    pixelsPerFrame: number;
    scrollFrame: number;
    scrollY: number;
    playhead: number;
  };
  label: LabelColor;
  binId: Id | null;
  createdAt: number;
  modifiedAt: number;
}

/* ---------- graphics (titles) ---------- */

export type GraphicLayerKind = 'text' | 'rect' | 'ellipse' | 'line' | 'polygon' | 'image';

export interface GraphicLayerBase {
  id: Id;
  kind: GraphicLayerKind;
  name: string;
  visible: boolean;
  locked: boolean;
  /** Position of layer anchor in sequence pixels. Keyframable via Param. */
  x: Param<number>;
  y: Param<number>;
  scale: Param<number>;
  rotation: Param<number>;
  opacity: Param<number>;
  anchor: 'topLeft' | 'center';
  /** Responsive pin to the frame; when set the layer keeps its offset from that edge. */
  pin?: 'none' | 'left' | 'right' | 'top' | 'bottom' | 'center';
  fill: string;
  fillEnabled: boolean;
  stroke: string;
  strokeWidth: number;
  strokeEnabled: boolean;
  shadowEnabled: boolean;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  shadowOpacity: number;
  blend: 'source-over' | 'multiply' | 'screen' | 'overlay' | 'difference' | 'lighter';
  /** Time based reveal animation applied at render time. */
  animIn?: GraphicAnimation;
  animOut?: GraphicAnimation;
}

export interface GraphicAnimation {
  type: 'none' | 'fade' | 'slideLeft' | 'slideRight' | 'slideUp' | 'slideDown' | 'scale' | 'typewriter' | 'blur' | 'wipe';
  /** Duration in seconds. */
  duration: number;
  /** Delay in seconds. */
  delay: number;
  easing: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'back';
}

export interface TextLayer extends GraphicLayerBase {
  kind: 'text';
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  underline: boolean;
  allCaps: boolean;
  tracking: number;
  leading: number;
  align: 'left' | 'center' | 'right';
  verticalAlign: 'top' | 'middle' | 'bottom';
  /** Wrap width in px; 0 = no wrap. */
  boxWidth: number;
  boxHeight: number;
  background: {
    enabled: boolean;
    color: string;
    opacity: number;
    padding: number;
    radius: number;
  };
  tabularNums: boolean;
}

export interface ShapeLayer extends GraphicLayerBase {
  kind: 'rect' | 'ellipse' | 'line' | 'polygon';
  width: number;
  height: number;
  radius: number;
  sides: number;
  /** Line: end offset. */
  x2: number;
  y2: number;
}

export interface ImageLayer extends GraphicLayerBase {
  kind: 'image';
  assetId: Id;
  width: number;
  height: number;
}

export type GraphicLayer = TextLayer | ShapeLayer | ImageLayer;

export interface GraphicDocument {
  layers: GraphicLayer[];
  /** Responsive design: time protection in seconds for intro/outro when trimming. */
  introProtect: number;
  outroProtect: number;
  /** Template reference, when created from a preset. */
  templateId?: string;
}

/* ---------- project ---------- */

export interface ProjectSettings {
  name: string;
  /** Default new sequence settings. */
  defaultSequence: SequenceSettings;
  defaultVideoTransition: string;
  defaultAudioTransition: string;
  /** Frames. */
  defaultTransitionDuration: number;
  defaultAudioTransitionDuration: number;
  defaultStillDuration: number;
  timecodeDisplay: 'timecode' | 'frames' | 'seconds' | 'feet16' | 'feet35';
  autoSaveEnabled: boolean;
  autoSaveIntervalMinutes: number;
  scratchNote: string;
  labelDefaults: Record<'video' | 'audio' | 'image' | 'sequence' | 'graphic' | 'adjustment' | 'bin', LabelColor>;
  audioHardware: { latencyHint: 'interactive' | 'balanced' | 'playback' };
  captionDefaults: CaptionStyle;
}

export interface Project {
  id: Id;
  version: number;
  settings: ProjectSettings;
  bins: Bin[];
  assets: MediaAsset[];
  sequences: Sequence[];
  /** Order of sequence tabs open in the timeline. */
  openSequenceIds: Id[];
  activeSequenceId: Id | null;
  createdAt: number;
  modifiedAt: number;
  /** Increments on every committed change; used by autosave. */
  revision: number;
}

/* ---------- helpers ---------- */

export function param<T extends ParamValue>(value: T): Param<T> {
  return { value };
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: 'Inter Variable',
  fontSize: 48,
  fontWeight: 500,
  italic: false,
  color: '#f0f0f0',
  backgroundColor: '#000000',
  backgroundOpacity: 0.6,
  edge: 'none',
  edgeColor: '#000000',
  align: 'center',
  position: 0.9,
  maxWidth: 0.8,
  letterSpacing: 0,
};

export const DEFAULT_SEQUENCE_SETTINGS: SequenceSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  dropFrame: false,
  sampleRate: 48000,
  pixelAspect: 1,
  fieldOrder: 'progressive',
  previewScale: 1,
  colorSpace: 'rec709',
  maxBitDepth: false,
  maxRenderQuality: false,
};

export function defaultMotion(): ClipMotion {
  return {
    position: param<[number, number]>([0.5, 0.5]),
    scale: param(100),
    scaleWidth: param(100),
    uniformScale: true,
    rotation: param(0),
    anchor: param<[number, number]>([0.5, 0.5]),
    opacity: param(100),
    blendMode: 'normal',
    antiFlicker: param(0),
  };
}

export function defaultClipAudio(): ClipAudio {
  return {
    gain: 0,
    volume: param(0),
    pan: param(0),
    muted: false,
    channelMode: 'stereo',
    invertPhase: false,
  };
}

export function defaultTrack(kind: TrackKind, index: number, id: string): Track {
  const prefix = kind === 'video' ? 'V' : kind === 'audio' ? 'A' : 'C';
  return {
    id,
    kind,
    name: `${prefix}${index + 1}`,
    height: kind === 'video' ? 48 : kind === 'audio' ? 44 : 28,
    locked: false,
    muted: false,
    solo: false,
    visible: true,
    targeted: index === 0,
    syncLocked: true,
    volume: param(0),
    pan: param(0),
    effects: [],
    showKeyframes: 'clip',
    output: 'master',
    expanded: false,
  };
}
