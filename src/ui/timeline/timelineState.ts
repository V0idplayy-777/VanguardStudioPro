import { create } from 'zustand';

/** Transient timeline view state that should not be undoable. */
interface TimelineViewState {
  pixelsPerFrame: number;
  scrollFrame: number;
  scrollY: number;
  headerWidth: number;
  /** Hover info for the tooltip. */
  hover: { x: number; y: number; text: string } | null;
  setZoom: (ppf: number) => void;
  setScroll: (frame: number) => void;
  setScrollY: (y: number) => void;
  setHover: (h: TimelineViewState['hover']) => void;
  /** Drag preview from project panel / effects. */
  externalDrag: { kind: 'asset'; ids: string[]; part?: 'composite' | 'video' | 'audio' } | { kind: 'effect'; type: string } | { kind: 'transition'; type: string } | { kind: 'template'; id: string } | null;
  setExternalDrag: (d: TimelineViewState['externalDrag']) => void;
  snapLine: number | null;
  setSnapLine: (f: number | null) => void;
}

export const useTimelineView = create<TimelineViewState>((set) => ({
  pixelsPerFrame: 2,
  scrollFrame: 0,
  scrollY: 0,
  headerWidth: 190,
  hover: null,
  setZoom: (pixelsPerFrame) => set({ pixelsPerFrame: Math.min(120, Math.max(0.002, pixelsPerFrame)) }),
  setScroll: (scrollFrame) => set({ scrollFrame: Math.max(0, scrollFrame) }),
  setScrollY: (scrollY) => set({ scrollY: Math.max(0, scrollY) }),
  setHover: (hover) => set({ hover }),
  externalDrag: null,
  setExternalDrag: (externalDrag) => set({ externalDrag }),
  snapLine: null,
  setSnapLine: (snapLine) => set({ snapLine }),
}));

export const MIME_SOURCE = 'application/x-vsp-source';
export const MIME_ASSETS = 'application/x-vsp-assets';
export const MIME_EFFECT = 'application/x-vsp-effect';
export const MIME_TRANSITION = 'application/x-vsp-transition';
export const MIME_TEMPLATE = 'application/x-vsp-template';
