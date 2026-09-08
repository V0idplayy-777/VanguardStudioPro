import { create } from 'zustand';

const STORAGE_KEY = 'vsp.tutorial.v1';

export interface TutorialProgress {
  completed: boolean;
  skipped: boolean;
  lastSeenAt: number | null;
  dontShowAgain: boolean;
}

function loadProgress(): TutorialProgress {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        completed: !!parsed.completed,
        skipped: !!parsed.skipped,
        lastSeenAt: parsed.lastSeenAt ?? null,
        dontShowAgain: !!parsed.dontShowAgain,
      };
    }
  } catch {}
  return { completed: false, skipped: false, lastSeenAt: null, dontShowAgain: false };
}

function saveProgress(p: TutorialProgress) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {}
}

interface TutorialState {
  isActive: boolean;
  currentStep: number;
  totalSteps: number;
  progress: TutorialProgress;
  start: () => void;
  next: () => void;
  prev: () => void;
  goTo: (step: number) => void;
  skip: () => void;
  complete: () => void;
  reset: () => void;
  setDontShowAgain: (v: boolean) => void;
  setTotalSteps: (n: number) => void;
}

export const useTutorial = create<TutorialState>((set, get) => ({
  isActive: false,
  currentStep: 0,
  totalSteps: 9,
  progress: loadProgress(),

  start: () => {
    set({ isActive: true, currentStep: 0 });
    const p = { ...get().progress, lastSeenAt: Date.now() };
    set({ progress: p });
    saveProgress(p);
  },
  next: () => {
    const { currentStep, totalSteps } = get();
    if (currentStep < totalSteps - 1) set({ currentStep: currentStep + 1 });
    else get().complete();
  },
  prev: () => {
    const { currentStep } = get();
    if (currentStep > 0) set({ currentStep: currentStep - 1 });
  },
  goTo: (step: number) => {
    const { totalSteps } = get();
    set({ currentStep: Math.max(0, Math.min(step, totalSteps - 1)) });
  },
  skip: () => {
    const p = { ...get().progress, skipped: true, lastSeenAt: Date.now() };
    saveProgress(p);
    set({ isActive: false, progress: p });
  },
  complete: () => {
    const p = { ...get().progress, completed: true, skipped: false, lastSeenAt: Date.now() };
    saveProgress(p);
    set({ isActive: false, progress: p });
  },
  reset: () => {
    const p: TutorialProgress = { completed: false, skipped: false, lastSeenAt: null, dontShowAgain: false };
    saveProgress(p);
    set({ isActive: false, currentStep: 0, progress: p });
    try {
      localStorage.removeItem('vsp.hasSeenWelcome');
    } catch {}
  },
  setDontShowAgain: (v: boolean) => {
    const p = { ...get().progress, dontShowAgain: v };
    saveProgress(p);
    set({ progress: p });
  },
  setTotalSteps: (n: number) => set({ totalSteps: n }),
}));

export function shouldAutoStartTutorial(): boolean {
  const prog = loadProgress();
  if (prog.completed) return false;
  if (prog.dontShowAgain) return false;
  // If user has explicitly skipped before, don't auto-start, but still allow welcome modal to prompt.
  // For true first-time, check if there is any persisted settings or project dirty?
  try {
    const hasSettings = !!localStorage.getItem('vsp.settings.v1');
    const hasLayout = !!localStorage.getItem('vsp.layouts.v1');
    const hasTutorial = !!localStorage.getItem(STORAGE_KEY);
    if (hasTutorial) return false; // user already interacted
    if (hasSettings || hasLayout) return false; // returning user
  } catch {}
  return true;
}

export function markTutorialDontShowAgain() {
  const cur = loadProgress();
  saveProgress({ ...cur, dontShowAgain: true });
}
