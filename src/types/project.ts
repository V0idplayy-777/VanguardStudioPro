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
  /** Proxy media status. generation progress lives outside the document (see proxy.ts). */
  proxy?: {
    status: 'ready' | 'pending';
    width: number;
    height: number;
    bytes: number;
    createdAt: number;
  };
  /** Voice cleanup: a baked "cleaned" copy of the audio is stored for this asset. */
  cleanedAudio?: {
    bytes: number;
    createdAt: number;
    preset: string;
  };
  createdAt: number;
  meta: AssetMetadata;
  /** Optional per-asset interpretation overrides. */
  interpret?: {
    fps?: number;
    pixelAspect?: number;
    alpha?: 'straight' | 'premultiplied' | 'ignore';
    /**
     * Camera log profile the footage was recorded in. Applied as an input
     * transform before any creative grade (see engine/color/lut.ts).
     */
    inputTransform?: string;
    /** Id of an imported LUT applied on decode, before clip effects. */
    inputLutId?: string;
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
  /** Opaque host data keyed by the effect: magic-mask track id, preset names, ... */
  data?: Record<string, string | number | boolean>;
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

export type FadeShape = 'linear' | 'equalPower' | 'exponential' | 'sCurve';

export interface ClipAudio {
  /** Clip gain in dB (static, "Audio Gain" dialog). */
  gain: number;
  /** Level in dB, keyframable (the rubber band). */
  volume: Param<number>;
  pan: Param<number>;
  muted: boolean;
  channelMode: 'stereo' | 'left' | 'right' | 'swap' | 'mono';
  invertPhase: boolean;
  /** Use the baked "cleaned" audio copy for this clip when one exists (Voice Cleanup). */
  enhanced?: boolean;
  /** Clip fade-in, in frames. Dragged from the waveform fade handles. */
  fadeIn?: number;
  /** Clip fade-out, in frames. */
  fadeOut?: number;
  /** Curve applied to both fades. */
  fadeShape?: FadeShape;
}

/**
 * How intermediate frames are produced when a clip is re-timed (speed != 1)
 * or when the sequence rate differs from the source rate.
 *
 *  - `nearest`      sample the closest source frame (fastest, can stutter)
 *  - `blend`        cross-dissolve the two bracketing source frames
 *  - `opticalFlow`  motion-compensated interpolation (see engine/time/opticalFlow)
 */
export type TimeInterpolation = 'nearest' | 'blend' | 'opticalFlow';

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
  /** Retiming interpolation. Absent means `nearest` (the historical behaviour). */
  timeInterpolation?: TimeInterpolation;
  /** Set when this clip's media was produced by Render & Replace. */
  renderReplace?: RenderReplaceInfo;
  /** Point/planar track analyses attached to this clip (see engine/track/pointTracker). */
  tracks?: TrackAnalysis[];
}

/** A clip whose media was baked by Render and Replace. */
export interface RenderReplaceInfo {
  /** Asset holding the baked render (kind 'video'). */
  bakedAssetId: Id;
  /** Asset the clip pointed at before the bake; Restore puts it back. */
  originalAssetId: Id | null;
  /** Original in point / speed so a restore is exact. */
  originalInPoint: number;
  originalSpeed: number;
  at: number;
  width: number;
  height: number;
  bytes: number;
  /** Incremented each time the clip is re-rendered. */
  generation: number;
}

/** One point/planar tracking analysis stored on a clip. */
export interface TrackAnalysis {
  id: Id;
  name: string;
  /** 'point' tracks a single feature, 'planar' tracks a four-corner patch. */
  kind: 'point' | 'planar';
  /** Seed positions, normalised 0..1 in the source frame. One entry for point, four for planar (tl,tr,br,bl). */
  seed: [number, number][];
  /** Tracked positions per analysed source frame, in the same order as `frames`. */
  positions: [number, number][][];
  /** Source frame indices that were analysed (sparse; interpolated between). */
  frames: number[];
  /** Per-frame match confidence 0..1. */
  confidence: number[];
  /** Source seconds the analysis covers. */
  startSec: number;
  endSec: number;
  at: number;
  /** Where the result was applied, so it can be re-applied or cleared. */
  appliedTo?: { type: 'effect'; clipEffectId: Id; paramPrefix?: string } | { type: 'mask'; effectId: Id; maskId: Id } | { type: 'graphicLayer'; layerId: Id } | { type: 'cornerPin'; effectId: Id };
}

export type TrackKind = 'video' | 'audio' | 'caption';

/** What a track is carrying. Drives the mix-to-target loudness balance. */
export type TrackRole = 'dialogue' | 'voiceover' | 'music' | 'sfx' | 'ambience' | 'other';

export const TRACK_ROLES: { id: TrackRole; label: string }[] = [
  { id: 'dialogue', label: 'Dialogue' },
  { id: 'voiceover', label: 'Voiceover' },
  { id: 'music', label: 'Music' },
  { id: 'sfx', label: 'SFX' },
  { id: 'ambience', label: 'Ambience' },
  { id: 'other', label: 'Other' },
];

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
  /** Audio: what this track carries, used by Mix to Target. */
  role?: TrackRole;
  /** Caption track: style. */
  captionStyle?: CaptionStyle;
  /** Whether the track is expanded (tall) in the UI. */
  expanded?: boolean;
}

export type MarkerKind = 'comment' | 'chapter' | 'segmentation' | 'webLink' | 'flashCue' | 'beat';

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
  /**
   * Per-word timings in frames, relative to the sequence (not the caption),
   * aligned with the words of `text` in order. Present when the caption came
   * from a word-level transcript; drives the karaoke highlight.
   */
  words?: CaptionWord[];
}

/** One spoken word with its timeline span, in frames. */
export interface CaptionWord {
  /** Sequence frame the word starts. */
  t0: number;
  /** Sequence frame the word ends. */
  t1: number;
  text: string;
}

export type CaptionAnimation = 'none' | 'pop' | 'slideUp' | 'fade' | 'scale' | 'typewriter';

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
  /** Entry animation applied to each caption as it appears (retention styling). */
  animation?: CaptionAnimation;
  /** Auto-highlight the last word of each caption when no *word* markup is present. */
  kicker?: boolean;
  /** Colour of the highlighted (kicker) word. */
  kickerColor?: string;
  /**
   * Word-by-word highlight driven by transcript timings: words already spoken
   * are painted in `karaokeColor`. Needs CaptionItem.words to do anything.
   */
  karaoke?: boolean;
  karaokeColor?: string;
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
  /** Delivery target; drives the Program monitor safe-area guides. */
  deliveryPlatform?: PlatformId;
}

/* ---------- platform safe areas ---------- */

export type PlatformId = 'none' | 'tiktok' | 'reels' | 'shorts' | 'instagramPost' | 'facebook' | 'youtube' | 'twitter' | 'linkedin' | 'broadcast' | 'cinema';

/**
 * Regions a platform's own chrome covers, in normalised frame coordinates.
 * `top`/`bottom` are heights, `left`/`right` are widths, all 0..1 of the frame.
 * Anything important should stay inside the remaining rectangle.
 */
export interface PlatformSafeArea {
  id: PlatformId;
  label: string;
  /** Aspect ratio the platform displays at, for reference. */
  aspect: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** Where the platform puts its caption/description text (a hint region). */
  captionZone: { x: number; y: number; w: number; h: number };
  note: string;
}

export const PLATFORM_SAFE_AREAS: PlatformSafeArea[] = [
  { id: 'none', label: 'Off', aspect: '-', top: 0, bottom: 0, left: 0, right: 0, captionZone: { x: 0.1, y: 0.75, w: 0.8, h: 0.15 }, note: 'No guides.' },
  { id: 'tiktok', label: 'TikTok', aspect: '9:16', top: 0.12, bottom: 0.16, left: 0.0, right: 0.14, captionZone: { x: 0.06, y: 0.7, w: 0.72, h: 0.12 }, note: 'Right-hand action rail (like/comment/share/profile) and the bottom caption + music ticker. Keep faces and text left of the rail.' },
  { id: 'reels', label: 'Instagram Reels', aspect: '9:16', top: 0.11, bottom: 0.19, left: 0.0, right: 0.13, captionZone: { x: 0.06, y: 0.66, w: 0.74, h: 0.12 }, note: 'Right rail plus a taller bottom stack: handle, caption, audio, and the progress bar.' },
  { id: 'shorts', label: 'YouTube Shorts', aspect: '9:16', top: 0.1, bottom: 0.2, left: 0.0, right: 0.12, captionZone: { x: 0.06, y: 0.64, w: 0.76, h: 0.12 }, note: 'The deepest bottom reserve of the three - title, channel row and buttons all live there.' },
  { id: 'instagramPost', label: 'Instagram Feed 4:5', aspect: '4:5', top: 0.09, bottom: 0.11, left: 0.0, right: 0.0, captionZone: { x: 0.1, y: 0.72, w: 0.8, h: 0.14 }, note: 'Feed posts crop 4:5; header and action row overlay top and bottom.' },
  { id: 'facebook', label: 'Facebook Feed', aspect: '16:9', top: 0.07, bottom: 0.1, left: 0.0, right: 0.0, captionZone: { x: 0.1, y: 0.74, w: 0.8, h: 0.14 }, note: 'Reactions row along the bottom, page header at the top.' },
  { id: 'youtube', label: 'YouTube (16:9)', aspect: '16:9', top: 0.0, bottom: 0.13, left: 0.0, right: 0.0, captionZone: { x: 0.1, y: 0.72, w: 0.8, h: 0.14 }, note: 'Player chrome covers the bottom in fullscreen-off mode; titles and the seek bar sit there.' },
  { id: 'twitter', label: 'X / Twitter', aspect: '16:9', top: 0.0, bottom: 0.09, left: 0.0, right: 0.0, captionZone: { x: 0.1, y: 0.76, w: 0.8, h: 0.13 }, note: 'Thin bottom bar with the action row.' },
  { id: 'linkedin', label: 'LinkedIn', aspect: '16:9', top: 0.0, bottom: 0.08, left: 0.0, right: 0.0, captionZone: { x: 0.1, y: 0.77, w: 0.8, h: 0.13 }, note: 'Minimal chrome; keep a little bottom margin for the control bar.' },
  { id: 'broadcast', label: 'Broadcast (title/action safe)', aspect: '16:9', top: 0.1, bottom: 0.1, left: 0.1, right: 0.1, captionZone: { x: 0.1, y: 0.72, w: 0.8, h: 0.16 }, note: 'SMPTE-style: outer 10% is action safe, inner 20% is title safe. Overscan can crop the outer ring.' },
  { id: 'cinema', label: 'Cinema 2.39:1', aspect: '2.39:1', top: 0.125, bottom: 0.125, left: 0.0, right: 0.0, captionZone: { x: 0.1, y: 0.7, w: 0.8, h: 0.12 }, note: 'Letterboxed scope mattes; keeps everything inside the projected aperture.' },
];

export function platformSafeArea(id: PlatformId | undefined): PlatformSafeArea {
  return PLATFORM_SAFE_AREAS.find((p) => p.id === id) ?? PLATFORM_SAFE_AREAS[0];
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
  /** Speech transcript used by text-based editing and karaoke captions. */
  transcript?: Transcript;
  /** Present when this sequence is a multicam angle stack. */
  multicam?: MulticamData;
}

/* ---------- transcript (text-based editing) ---------- */

/** One spoken word located on the timeline. */
export interface TranscriptWord {
  /** Sequence frames. */
  t0: number;
  t1: number;
  text: string;
  /** Confidence 0..1 when the recogniser supplied one. */
  confidence?: number;
  /** Id of the clip that was on a targeted video track at this word, if any. */
  clipId?: Id;
}

export interface Transcript {
  /** Recogniser model / source description. */
  source: string;
  at: number;
  /** Language as reported (or requested). */
  language?: string;
  words: TranscriptWord[];
  /** Frame range the transcript was produced from. */
  startFrame: number;
  endFrame: number;
}

/* ---------- multicam ---------- */

export interface MulticamAngle {
  id: Id;
  name: string;
  /** Video track in this sequence carrying the angle. */
  trackId: Id;
  assetId: Id | null;
  /** Optional colour for the angle badge. */
  label?: LabelColor;
}

export interface MulticamData {
  angles: MulticamAngle[];
  /** Which angle supplies program audio. */
  audioAngleId: Id;
  /** Cut points: from `frame` onward this angle is live. Sorted ascending. */
  switches: { frame: number; angleId: Id }[];
  /** How the angles were aligned. */
  syncMethod: 'audio' | 'inPoint' | 'manual' | 'timecode';
  createdAt: number;
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
  animation: 'none',
  kicker: false,
  kickerColor: '#ffd54a',
  karaoke: false,
  karaokeColor: '#ffd54a',
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
    enhanced: false,
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
