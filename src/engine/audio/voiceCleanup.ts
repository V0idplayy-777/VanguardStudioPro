import { toast, logEvent } from '../../state/uiStore';
import { findAsset, useProject } from '../../state/projectStore';
import { getMedia, updateMedia } from '../media/mediaStore';
import { deleteCleanedAudio, kvGet, kvSet, loadCleanedAudio, persistCleanedAudio } from '../media/mediaDb';
import { getSharedAudioContext } from './audioContext';
import { autoLevel, findQuietestSpan, highPass, learnNoiseProfile, notchHum, softenReverb, spectralGate, type NoiseProfile } from './denoise';
import type { Id } from '../../types/project';

/*
  Advanced voice cleanup.

  A guided offline pipeline for dialogue: learn the room-noise fingerprint
  from the quietest span, spectral-gate it out, notch mains hum, dry up
  reverb tails, remove rumble and even out the level. The result is baked to
  a WAV stored per-asset in IndexedDB (`clean:<assetId>`); clips opt into it
  with clip.audio.enhanced, so the original is always one toggle away.
*/

export interface VoiceCleanupPlan {
  preset: string;
  /** Spectral denoise 0..100. */
  denoise: number;
  /** Mains hum removal. */
  humHz: 0 | 50 | 60;
  /** Reverb softening 0..100. */
  reverb: number;
  /** Rumble high-pass. */
  rumble: boolean;
  /** Auto level + soft limit. */
  level: boolean;
}

export const VOICE_CLEANUP_PRESETS: { id: string; name: string; desc: string; plan: VoiceCleanupPlan }[] = [
  { id: 'podcast', name: 'Podcast / Voiceover', desc: 'Strong denoise, rumble cut and broadcast-style leveling.', plan: { preset: 'podcast', denoise: 70, humHz: 0, reverb: 30, rumble: true, level: true } },
  { id: 'interview', name: 'Interview / Location', desc: 'Room tone and hum removal that keeps voices natural.', plan: { preset: 'interview', denoise: 55, humHz: 50, reverb: 45, rumble: true, level: true } },
  { id: 'light', name: 'Light Touch-Up', desc: 'Gentle cleanup for already decent recordings.', plan: { preset: 'light', denoise: 35, humHz: 0, reverb: 20, rumble: true, level: false } },
  { id: 'harsh', name: 'Harsh Environment', desc: 'Maximum suppression for noisy rooms. May sound processed.', plan: { preset: 'harsh', denoise: 85, humHz: 60, reverb: 60, rumble: true, level: true } },
];

export function defaultVoicePlan(): VoiceCleanupPlan {
  return { ...VOICE_CLEANUP_PRESETS[0].plan };
}

/* ---------- noise profiles ---------- */

const profileCache = new Map<Id, NoiseProfile>();

export async function getNoiseProfile(assetId: Id): Promise<NoiseProfile | null> {
  const cached = profileCache.get(assetId);
  if (cached) return cached;
  const rec = getMedia(assetId);
  if (!rec?.audio) return null;
  // 1) persisted
  try {
    const saved = await kvGet<{ size: number; sampleRate: number; spectrum: number[] }>(`cleanprofile:${assetId}`);
    if (saved && saved.sampleRate === rec.audio.sampleRate) {
      const p = { size: saved.size, sampleRate: saved.sampleRate, spectrum: Float32Array.from(saved.spectrum) };
      profileCache.set(assetId, p);
      return p;
    }
  } catch {
    /* ignore */
  }
  // 2) learn from the quietest span
  const ch = rec.audio.getChannelData(0);
  const span = findQuietestSpan(ch, rec.audio.sampleRate);
  const profile = learnNoiseProfile(ch, rec.audio.sampleRate, span.from, span.to);
  profileCache.set(assetId, profile);
  kvSet(`cleanprofile:${assetId}`, { size: profile.size, sampleRate: profile.sampleRate, spectrum: Array.from(profile.spectrum) }).catch(() => undefined);
  return profile;
}

/* ---------- rendering ---------- */

export interface RenderCleanupOptions {
  /** Render only the first N seconds (preview). */
  previewSeconds?: number;
  onProgress?: (p: number, phase: string) => void;
}

function processChannel(input: Float32Array, sampleRate: number, profile: NoiseProfile | null, plan: VoiceCleanupPlan, onProgress?: (p: number) => void): Float32Array {
  let out = input;
  if (plan.rumble) out = highPass(out, sampleRate, 80);
  if (plan.humHz) out = notchHum(out, sampleRate, plan.humHz, 5);
  if (plan.denoise > 0 && profile) out = spectralGate(out, sampleRate, profile, { amount: plan.denoise }, onProgress);
  else onProgress?.(1);
  if (plan.reverb > 0) out = softenReverb(out, sampleRate, plan.reverb);
  if (plan.level) out = autoLevel(out, sampleRate);
  // safety: hard clip guard
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const v = Math.abs(out[i]);
    if (v > peak) peak = v;
  }
  if (peak > 1) {
    const g = 0.99 / peak;
    for (let i = 0; i < out.length; i++) out[i] *= g;
  }
  return out;
}

export async function renderVoiceCleanup(assetId: Id, plan: VoiceCleanupPlan, opts: RenderCleanupOptions = {}): Promise<AudioBuffer | null> {
  const rec = getMedia(assetId);
  const src = rec?.audio;
  if (!src) return null;
  const profile = plan.denoise > 0 ? await getNoiseProfile(assetId) : null;
  const ctx = getSharedAudioContext();
  const total = opts.previewSeconds ? Math.min(src.length, Math.floor(opts.previewSeconds * src.sampleRate)) : src.length;
  const out = ctx.createBuffer(Math.min(2, src.numberOfChannels), total, src.sampleRate);
  for (let c = 0; c < out.numberOfChannels; c++) {
    opts.onProgress?.(c / out.numberOfChannels, c === 0 ? 'Cleaning channel 1…' : 'Cleaning channel 2…');
    const slice = src.getChannelData(Math.min(c, src.numberOfChannels - 1)).slice(0, total);
    // Yield between heavy stages so the dialog stays alive.
    await new Promise((r) => setTimeout(r, 0));
    out.getChannelData(c).set(processChannel(slice, src.sampleRate, profile, plan, (p) => opts.onProgress?.((c + p) / out.numberOfChannels, 'Reducing noise…')));
  }
  opts.onProgress?.(1, 'Done');
  return out;
}

/* ---------- bake / restore / remove ---------- */

export async function bakeVoiceCleanup(assetId: Id, plan: VoiceCleanupPlan, opts: { applyToClips?: boolean; onProgress?: (p: number, phase: string) => void } = {}): Promise<boolean> {
  const asset = findAsset(useProject.getState().project, assetId);
  if (!asset) return false;
  opts.onProgress?.(0, 'Cleaning audio…');
  const cleaned = await renderVoiceCleanup(assetId, plan, { onProgress: opts.onProgress });
  if (!cleaned) {
    toast('error', 'Voice cleanup', 'No decoded audio for this asset yet.');
    return false;
  }
  const { encodeWav } = await import('../export/exporter');
  const blob = encodeWav(cleaned, cleaned.numberOfChannels > 1 ? 2 : 1);
  await persistCleanedAudio(assetId, blob);
  updateMedia(assetId, { enhancedAudio: cleaned });
  const presetName = VOICE_CLEANUP_PRESETS.find((p) => p.id === plan.preset)?.name ?? 'Custom';
  useProject.getState().update('Clean Up Voice', (p) => {
    const a = p.assets.find((x) => x.id === assetId);
    if (a) a.cleanedAudio = { bytes: blob.size, createdAt: Date.now(), preset: presetName };
    if (opts.applyToClips !== false) {
      for (const s of p.sequences) for (const c of s.clips) if (c.assetId === assetId) c.audio.enhanced = true;
    }
  });
  logEvent('info', `Voice cleanup baked for ${asset.name} (${presetName}, ${(blob.size / 1048576).toFixed(1)} MB)`);
  toast('success', 'Voice cleaned', `${asset.name} now plays the cleaned take. Toggle per clip in the Audio section.`);
  return true;
}

export async function restoreCleanedAudio(assetId: Id): Promise<boolean> {
  const rec = getMedia(assetId);
  if (!rec || rec.enhancedAudio) return !!rec?.enhancedAudio;
  try {
    const blob = await loadCleanedAudio(assetId);
    if (!blob) return false;
    const ctx = getSharedAudioContext();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    updateMedia(assetId, { enhancedAudio: buf });
    return true;
  } catch {
    return false;
  }
}

export async function removeCleanedAudio(assetId: Id): Promise<void> {
  updateMedia(assetId, { enhancedAudio: undefined });
  await deleteCleanedAudio(assetId).catch(() => undefined);
  profileCache.delete(assetId);
  useProject.getState().update('Remove Cleaned Audio', (p) => {
    const a = p.assets.find((x) => x.id === assetId);
    if (a) a.cleanedAudio = undefined;
    for (const s of p.sequences) for (const c of s.clips) if (c.assetId === assetId) c.audio.enhanced = false;
  });
}
