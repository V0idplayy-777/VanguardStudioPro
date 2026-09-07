/*
  Vanguard Studio Pro - undocumented behaviours.

  Nothing in here is referenced by any visible label. The triggers are
  deliberately obscure; each one has an absurd payoff. If you're reading
  this file you've already found them, so no spoilers in comments.
*/
import { useUI, toast, logEvent } from '../state/uiStore';
import { useProject } from '../state/projectStore';
import { usePlayback } from '../engine/playback/playback';
import { getSharedAudioContext, resumeAudio } from '../engine/audio/audioContext';

type EggId = 'oogway' | 'hamburger' | 'turtle' | 'inverted' | 'konami' | 'reversal' | 'anthem' | 'gravity' | 'hallOfFame';

export interface EggEvent {
  id: EggId;
  title: string;
  message: string;
  sub?: string;
}

const listeners = new Set<(e: EggEvent) => void>();
export function onEgg(fn: (e: EggEvent) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
const found = new Set<EggId>(loadFound());
function loadFound(): EggId[] {
  try {
    return JSON.parse(localStorage.getItem('vsp.unlisted') ?? '[]');
  } catch {
    return [];
  }
}
function remember(id: EggId) {
  found.add(id);
  try {
    localStorage.setItem('vsp.unlisted', JSON.stringify([...found]));
  } catch {
    /* ignore */
  }
}
export function foundCount() {
  return found.size;
}
export const EGG_TOTAL = 9;

function fire(e: EggEvent) {
  remember(e.id);
  listeners.forEach((l) => l(e));
  logEvent('info', 'Undocumented behaviour triggered', e.title);
  if (found.size === EGG_TOTAL && e.id !== 'hallOfFame') {
    setTimeout(() => fire({ id: 'hallOfFame', title: 'You found all of them.', message: 'There is no prize. The real prize was the render queue we finished along the way.', sub: 'Vanguard Studio Pro salutes you. Now go make something.' }), 3500);
  }
}

/* ---------- 1. typed sequence anywhere (not in a text field) ---------- */
let typed = '';
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
let konamiIdx = 0;

export function secretKey(e: KeyboardEvent) {
  // Konami (works even when typing since arrow keys rarely go into fields)
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === KONAMI[konamiIdx]) {
    konamiIdx++;
    if (konamiIdx === KONAMI.length) {
      konamiIdx = 0;
      konami();
    }
  } else konamiIdx = k === KONAMI[0] ? 1 : 0;

  if (useUI.getState().textEditing) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length !== 1) return;
  typed = (typed + e.key.toLowerCase()).slice(-24);
  if (typed.endsWith('oogway')) {
    typed = '';
    oogway();
  } else if (typed.endsWith('hamburger')) {
    typed = '';
    hamburger();
  } else if (typed.endsWith('gravity')) {
    typed = '';
    gravity();
  }
}

function oogway() {
  fire({ id: 'oogway', title: 'A message from the Jade Palace', message: 'Master Oogway is gooning rn', sub: 'There are no accidents. Except this one. Playback speed is now 0.618x for the next 60 seconds.' });
  const pb = usePlayback.getState();
  const wasPlaying = pb.playing;
  pb.pause();
  const orig = usePlayback.getState().play;
  // Golden-ratio playback for a minute
  usePlayback.setState({ play: (rate = 1) => orig(rate * 0.618) } as any);
  if (wasPlaying) usePlayback.getState().play(1);
  setTimeout(() => usePlayback.setState({ play: orig } as any), 60000);
}

function hamburger() {
  const ui = useUI.getState();
  ui.setHamburgerMode(!ui.hamburgerMode);
  fire({ id: 'hamburger', title: ui.hamburgerMode ? 'Hamburger mode disengaged' : 'HAMBURGER REQUIREMENT satisfied', message: ui.hamburgerMode ? 'Your clips are just clips again.' : 'Per section 2 of the LICENSE, every clip in the timeline is now legally a hamburger. Type it again to revoke.', sub: 'The README contains exactly one. Do not add a second.' });
}

function gravity() {
  fire({ id: 'gravity', title: 'Gravity enabled', message: 'All clips have fallen to the lowest available track. Physics has been applied to your edit.', sub: 'Undo works. Gravity does not care.' });
  useProject.getState().update('Gravity', (p) => {
    const seq = p.sequences.find((s) => s.id === p.activeSequenceId);
    if (!seq) return;
    const vids = seq.tracks.filter((t) => t.kind === 'video');
    const auds = seq.tracks.filter((t) => t.kind === 'audio');
    const fall = (tracks: typeof vids) => {
      if (!tracks.length) return;
      const ground = tracks[0];
      const clips = seq.clips.filter((c) => tracks.some((t) => t.id === c.trackId)).sort((a, b) => a.start - b.start);
      const occupied: [number, number][] = [];
      for (const c of clips) {
        const free = !occupied.some(([s, e]) => c.start < e && c.start + c.duration > s);
        if (free) {
          c.trackId = ground.id;
          occupied.push([c.start, c.start + c.duration]);
        }
      }
    };
    fall(vids);
    fall(auds);
  });
}

function konami() {
  const ui = useUI.getState();
  const n = ui.bumpSecret('konami');
  if (n === 1) {
    fire({ id: 'konami', title: '30 extra lives', message: 'Your undo history limit has been raised from 200 to 230. Use them wisely.', sub: 'Enter it again for something worse.' });
    return;
  }
  ui.setColorInverted(!ui.colorInverted);
  fire({ id: 'inverted', title: ui.colorInverted ? 'Back to normal' : 'Negative space', message: ui.colorInverted ? 'Colours restored. Your retinas thank you.' : 'The entire interface is now a photographic negative. Enter the code again to fix it.', sub: 'The Program Monitor still shows the true colours. Only you are affected.' });
}

/* ---------- 2. click the version number in About seven times ---------- */
export function aboutVersionClick() {
  const n = useUI.getState().bumpSecret('about');
  if (n === 7) {
    useUI.getState().resetSecret('about');
    turtle();
  }
}
function turtle() {
  const ui = useUI.getState();
  ui.setTurtleMode(!ui.turtleMode);
  fire({ id: 'turtle', title: ui.turtleMode ? 'Turtle mode off' : 'Turtle mode', message: ui.turtleMode ? 'The interface has remembered how to hurry.' : 'Every UI transition now takes 1.8 seconds. Oogway would approve. Click the version seven more times to undo.', sub: 'Yes, including the menus. Yesterday is history, tomorrow is a mystery, and this dropdown is taking its time.' });
}

/* ---------- 3. set clip speed to exactly -100% and enable maintain pitch ---------- */
export function checkSpeedEgg(speedPercent: number, reverse: boolean, maintainPitch: boolean) {
  if (Math.abs(speedPercent) === 100 && reverse && maintainPitch && !found.has('reversal')) {
    fire({ id: 'reversal', title: 'Perfect reversal', message: 'A clip played backwards at exactly 100% with pitch maintained is still the same clip, just regretful. All sequence markers have been renamed to palindromes.', sub: 'racecar. level. kayak. noon.' });
    const pals = ['racecar', 'level', 'kayak', 'noon', 'rotor', 'civic', 'refer', 'stats', 'tenet', 'deified'];
    useProject.getState().update('Palindromes', (p) => {
      const seq = p.sequences.find((s) => s.id === p.activeSequenceId);
      if (!seq) return;
      seq.markers.forEach((m, i) => (m.name = pals[i % pals.length]));
    });
  }
}

/* ---------- 4. set master fader to exactly -42 dB ---------- */
export function checkMasterEgg(db: number) {
  if (Math.round(db) === -42 && !found.has('anthem')) {
    fire({ id: 'anthem', title: 'The answer', message: 'Master at -42 dB. The Program Monitor will now play a 4.2 second synthesised fanfare that nobody asked for.', sub: 'It is in the key of D, because Deep Thought would have wanted it that way.' });
    void fanfare();
  }
}

async function fanfare() {
  await resumeAudio();
  const ctx = getSharedAudioContext();
  const t0 = ctx.currentTime + 0.05;
  const notes = [293.66, 369.99, 440, 587.33, 440, 369.99, 293.66, 587.33];
  const gain = ctx.createGain();
  gain.gain.value = 0.08;
  gain.connect(ctx.destination);
  notes.forEach((f, i) => {
    const o = ctx.createOscillator();
    o.type = i % 2 ? 'triangle' : 'square';
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0 + i * 0.5);
    g.gain.linearRampToValueAtTime(1, t0 + i * 0.5 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.5 + 0.48);
    o.connect(g).connect(gain);
    o.start(t0 + i * 0.5);
    o.stop(t0 + i * 0.5 + 0.5);
  });
  setTimeout(() => gain.disconnect(), 4600);
}

/* ---------- 5. name a sequence "Sequence 00" ---------- */
export function checkSequenceNameEgg(name: string) {
  if (name.trim().toLowerCase() === 'sequence 00') {
    toast('info', 'Sequence 00', 'Before there was a first sequence, there was this one. It renders in negative time.');
    useProject.getState().update('Sequence 00', (p) => {
      const s = p.sequences.find((x) => x.name.trim().toLowerCase() === 'sequence 00');
      if (s) s.label = 'rose';
    });
  }
}

export function eggsFound() {
  return [...found];
}
