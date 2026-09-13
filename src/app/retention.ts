/*
  Retention toolkit - commands.

  Wires the retention engine into the project store. Every action is a single
  undo step, reports through toasts, and is reachable from the Retention menu,
  the command palette, and the Retention Check panel.
*/

import { useProject, getActiveSequence, makeClip } from '../state/projectStore';
import { useUI, toast, logEvent } from '../state/uiStore';
import * as E from '../engine/timeline/edits';
import { importFiles } from '../engine/media/importer';
import { uid } from '../engine/util';
import type { CaptionItem, Sequence } from '../types/project';
import { selectedClips, playheadNow } from './commands';
import { addZoomPunches, addFlashOnCuts, makeLoopOutro, insertRewindTrap, plantTypoBait, type RewindTrapOptions } from '../retention/edits';
import { buildMicroCaptions, retentionStyleFor } from '../retention/captions';
import { sfxWavFile } from '../retention/sfx';
import { brandKits, kitFromSequence, type BrandKit } from '../retention/brandKit';

export function retentionSeq(): Sequence | null {
  return getActiveSequence(useProject.getState().project);
}

function mutate(label: string, fn: (seq: Sequence, project: ReturnType<typeof useProject.getState>['project']) => void) {
  useProject.getState().update(label, (p) => {
    const seq = getActiveSequence(p);
    if (seq) fn(seq, p);
  });
}

export const retentionCmd = {
  /* ---------- modal openers ---------- */
  check() {
    if (!retentionSeq()) return toast('info', 'Retention Check', 'Open a sequence first.');
    useUI.getState().openModal({ kind: 'retentionCheck' });
  },
  openSmartCaptions() {
    if (!retentionSeq()) return toast('info', 'Smart Captions', 'Open a sequence first.');
    useUI.getState().openModal({ kind: 'smartCaptions' });
  },
  openRewindTrap() {
    if (!retentionSeq()) return toast('info', 'Rewind Trap', 'Open a sequence first.');
    useUI.getState().openModal({ kind: 'rewindTrap' });
  },
  openDopamine() {
    if (!retentionSeq()) return toast('info', 'Dopamine Audio', 'Open a sequence first.');
    useUI.getState().openModal({ kind: 'dopamineAudio' });
  },
  openLoopOutro() {
    if (!retentionSeq()) return toast('info', 'Infinite Loop Outro', 'Open a sequence first.');
    useUI.getState().openModal({ kind: 'loopOutro' });
  },
  openBrandKit() {
    useUI.getState().openModal({ kind: 'brandKit' });
  },

  /* ---------- captions ---------- */
  /** Apply the bold, centred, animated retention caption style to the sequence. */
  applyRetentionCaptionStyle() {
    const seq = retentionSeq();
    if (!seq) return;
    const style = retentionStyleFor(seq.settings.height);
    mutate('Retention caption style', (s, p) => {
      s.captionTrack.style = { ...style };
      s.captionTrack.enabled = true;
      s.captionTrack.burnIn = true;
      // Algorithmic uniformity: future sequences start with this look too.
      p.settings.captionDefaults = { ...style };
    });
    toast('success', 'Retention caption style applied', 'Bold, centred, animated captions with a kicker word. Enabled and burned in on export.');
    logEvent('info', 'Retention caption style applied');
  },

  /** Convert captions (or a pasted transcript) into 1-3 word micro-captions. */
  generateSmartCaptions(opts: { transcript?: string; maxWords: number; kicker: boolean }) {
    const seq = retentionSeq();
    if (!seq) return;
    const fps = seq.settings.fps;
    const style = { ...retentionStyleFor(seq.settings.height), kicker: opts.kicker };
    let built: CaptionItem[];
    if (opts.transcript && opts.transcript.trim()) {
      // No captions yet: lay a transcript out from the playhead at ~half a second per chunk.
      const chunks = opts.transcript.split(/\s+/).filter(Boolean);
      const micro: string[] = [];
      for (let i = 0; i < chunks.length; i += opts.maxWords) micro.push(chunks.slice(i, i + opts.maxWords).join(' '));
      const ph = playheadNow();
      let t = ph;
      const perChunk = Math.max(1, Math.round(fps * 0.5));
      built = micro.map((text) => {
        const item: CaptionItem = { id: uid('cap'), start: t, end: t + perChunk, text, style: { animation: 'pop' } };
        t += perChunk;
        return item;
      });
    } else if (seq.captions.length) {
      built = buildMicroCaptions(seq.captions, opts.maxWords, { animation: 'pop' });
    } else {
      return toast('info', 'Smart Captions', 'There are no captions to convert. Paste a transcript or transcribe the audio first.');
    }
    mutate('Smart captions', (s, p) => {
      s.captions = built;
      s.captions.sort((a, b) => a.start - b.start);
      s.captionTrack.style = { ...style };
      s.captionTrack.enabled = true;
      s.captionTrack.burnIn = true;
      p.settings.captionDefaults = { ...style };
    });
    toast('success', 'Smart captions generated', `${built.length} micro-captions at 1-${opts.maxWords} words per line.`);
    logEvent('info', 'Smart captions generated', `${built.length} captions`);
  },

  /* ---------- pacing ---------- */
  zoomPunches() {
    const seq = retentionSeq();
    if (!seq) return;
    let touched = 0;
    mutate('Zoom punches', (s) => {
      touched = addZoomPunches(s);
    });
    if (touched) toast('success', 'Zoom punches added', `A subtle zoom reset every 2s across ${touched} clip${touched === 1 ? '' : 's'}.`);
    else toast('info', 'Zoom punches', 'No static video clips long enough to punch (or they already have motion keyframes).');
  },
  flashOnCuts() {
    const seq = retentionSeq();
    if (!seq) return;
    let added = 0;
    mutate('Flash on cuts', (s) => {
      added = addFlashOnCuts(s);
    });
    if (added) toast('success', 'Flash on cuts', `${added} cut${added === 1 ? '' : 's'} now flash white for a sensory reset.`);
    else toast('info', 'Flash on cuts', 'No plain cuts without a transition found.');
  },

  /* ---------- rewind trap + comment bait ---------- */
  insertRewindTrap(opts: RewindTrapOptions) {
    const project = useProject.getState().project;
    const seq = retentionSeq();
    if (!seq) return;
    const ph = playheadNow();
    let ok = false;
    mutate('Insert rewind trap', (s) => {
      ok = !!insertRewindTrap(s, project, ph, opts);
    });
    if (ok) toast('success', 'Rewind trap planted', `${opts.frames} frame${opts.frames === 1 ? '' : 's'} of "${opts.kind === 'text' ? opts.text : 'an image'}" in the ${opts.corner.toUpperCase()} corner. Viewers will rewind to catch it.`);
    else toast('info', 'Rewind trap', 'Could not plant the trap - add a video track first.');
  },
  plantTypoBait() {
    const seq = retentionSeq();
    if (!seq) return;
    let before: string | undefined;
    let after: string | undefined;
    mutate('Comment bait', (s) => {
      const r = plantTypoBait(s);
      if (r) {
        before = r.before;
        after = r.after;
      }
    });
    if (before !== undefined && after !== undefined) toast('success', 'Comment bait planted', `"${before}" is now "${after}". The comments will correct you - engagement incoming.`);
    else toast('info', 'Comment bait', 'No captions with a word long enough to misspell.');
  },

  /* ---------- dopamine audio ---------- */
  /** Set the selected audio clip (or the first one) to ~5% volume (-26 dB). */
  applyMusicBed() {
    const seq = retentionSeq();
    if (!seq) return;
    const sel = new Set(selectedClips().map((c) => c.id));
    let targets = seq.clips.filter((c) => seq.tracks.find((t) => t.id === c.trackId)?.kind === 'audio' && (sel.size ? sel.has(c.id) : true));
    if (!targets.length) return toast('info', 'Music bed', 'No audio clips found. Import a high-tempo track first.');
    mutate('Music bed to 5%', (s) => {
      const live = new Set(sel.size ? [...sel] : s.clips.filter((c) => s.tracks.find((t) => t.id === c.trackId)?.kind === 'audio').map((c) => c.id));
      for (const c of s.clips) if (live.has(c.id)) c.audio.gain = -26;
    });
    toast('success', 'Music bed set to 5%', `${targets.length} audio clip${targets.length === 1 ? '' : 's'} at -26 dB. Layer SFX on top for the dopamine hit.`);
  },
  async addSfx(id: string) {
    const seq = retentionSeq();
    if (!seq) return;
    const hasAudioTrack = seq.tracks.some((t) => t.kind === 'audio');
    if (!hasAudioTrack) return toast('info', 'Add SFX', 'This sequence has no audio track. Add one first (Sequence > Add Track).');
    const ph = playheadNow();
    const { file, duration, name } = await sfxWavFile(id);
    const assets = await importFiles([file]);
    const asset = assets[0];
    if (!asset) return;
    mutate(`Add ${name} SFX`, (s, p) => {
      const a = p.assets.find((x) => x.id === asset.id);
      if (!a) return;
      a.duration = duration;
      const fps = s.settings.fps;
      const frames = Math.max(1, Math.round(duration * fps));
      let aTrack = s.tracks.find((t) => t.kind === 'audio' && t.targeted) ?? s.tracks.find((t) => t.kind === 'audio');
      if (!aTrack) aTrack = E.addTrack(s, 'audio');
      s.clips.push(makeClip({ trackId: aTrack.id, start: ph, duration: frames, assetId: a.id, name: a.name, inPoint: 0, label: 'forest' }));
    });
    toast('success', `${name} added`, 'SFX placed at the playhead on the audio track.');
  },
  async addSfxToCaptions(id: string) {
    const seq = retentionSeq();
    if (!seq) return;
    if (!seq.captions.length) return toast('info', 'SFX on captions', 'Generate captions first, then run this to hit an SFX on every caption.');
    const { file, duration, name } = await sfxWavFile(id);
    const assets = await importFiles([file]);
    const asset = assets[0];
    if (!asset) return;
    const starts = [...seq.captions].sort((a, b) => a.start - b.start).map((c) => c.start);
    mutate(`Add ${name} on captions`, (s, p) => {
      const a = p.assets.find((x) => x.id === asset.id);
      if (!a) return;
      a.duration = duration;
      const fps = s.settings.fps;
      const frames = Math.max(1, Math.round(duration * fps));
      let aTrack = s.tracks.find((t) => t.kind === 'audio' && t.targeted) ?? s.tracks.find((t) => t.kind === 'audio');
      if (!aTrack) aTrack = E.addTrack(s, 'audio');
      for (const st of starts) s.clips.push(makeClip({ trackId: aTrack.id, start: st, duration: frames, assetId: a.id, name: a.name, inPoint: 0, label: 'forest' }));
    });
    toast('success', `${name} on captions`, `${starts.length} SFX hits, one at the start of each caption.`);
  },

  /* ---------- infinite loop outro ---------- */
  makeLoopOutro(loopSec: number) {
    const seq = retentionSeq();
    if (!seq) return;
    let res: { added: number; error?: string } = { added: 0 };
    mutate('Infinite loop outro', (s) => {
      res = makeLoopOutro(s, loopSec);
    });
    if (res.error) toast('info', 'Infinite loop outro', res.error);
    else toast('success', 'Infinite loop outro', `${res.added} clip${res.added === 1 ? '' : 's'} duplicated from the opening ${loopSec.toFixed(1)}s with a crossfade. The video restarts before the viewer notices.`);
  },

  /* ---------- brand kit ---------- */
  saveBrandKit(name: string) {
    const seq = retentionSeq();
    if (!seq) return;
    const kit = kitFromSequence(name.trim() || 'My Brand', seq);
    brandKits.save(kit);
    toast('success', 'Brand kit saved', `"${kit.name}" captures your caption style and ${kit.width}x${kit.height} @ ${kit.fps}fps framing.`);
  },
  applyBrandKit(kit: BrandKit, resize: boolean) {
    mutate('Apply brand kit', (s, p) => {
      s.captionTrack.style = { ...kit.captionStyle };
      s.captionTrack.enabled = true;
      s.captionTrack.burnIn = true;
      p.settings.captionDefaults = { ...kit.captionStyle };
      if (resize) {
        s.settings.width = kit.width;
        s.settings.height = kit.height;
        s.settings.fps = kit.fps;
      }
    });
    toast('success', `Brand kit "${kit.name}" applied`, resize ? 'Caption style and framing applied. Run Auto Reframe if clips no longer fit.' : 'Caption style applied for instant feed recognition.');
  },
  deleteBrandKit(id: string) {
    brandKits.remove(id);
  },

  /** Human-friendly list of playbook requirements, used by the check panel. */
  playbook() {
    return [
      { id: 'hook', name: 'Micro-hook Overload', goal: 'Keep retention above 80% in the first 3 seconds - open mid-sentence or mid-action, never "Hi, welcome".' },
      { id: 'captions', name: 'Visual Friction Elimination', goal: 'Bold, animated captions in the exact centre, 1-3 words per line.' },
      { id: 'reset', name: 'The 2-Second Reset', goal: 'Change the visual frame every 1.5-2s: a cut, zoom punch, SFX or screen flash.' },
      { id: 'rewind', name: 'Subconscious Rewind Traps', goal: 'Hide a split-second meme or easter egg in the corner to force rewinds.' },
      { id: 'audio', name: 'Audio Momentum (Dopamine)', goal: 'High-tempo track at ~5% volume, sharp SFX on text transitions and punchlines.' },
      { id: 'loop', name: 'The Infinite Loop Outro', goal: 'The last sentence flows back into the first - the video restarts before it ends.' },
      { id: 'bait', name: 'Comment Section Baiting', goal: 'Leave one obvious minor mistake for the comments to correct.' },
      { id: 'uniform', name: 'Algorithmic Uniformity', goal: 'Same font, colours and framing in every upload for instant recognition.' },
    ];
  },
};
