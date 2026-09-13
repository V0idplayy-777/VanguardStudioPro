/*
  Retention toolkit - brand kit (algorithmic uniformity).

  Saves the exact font, colour scheme, caption style and framing of a
  sequence so every upload looks instantly recognisable on the feed.
  Persisted in localStorage like effect presets.
*/

import type { CaptionStyle, Sequence } from '../types/project';

export interface BrandKit {
  id: string;
  name: string;
  captionStyle: CaptionStyle;
  width: number;
  height: number;
  fps: number;
  createdAt: number;
}

const KEY = 'vsp.brandkit.v1';

class BrandKitStore {
  private items: BrandKit[] = [];
  private listeners = new Set<() => void>();
  constructor() {
    try {
      this.items = JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch {
      this.items = [];
    }
  }
  get() {
    return [...this.items].sort((a, b) => b.createdAt - a.createdAt);
  }
  byId(id: string) {
    return this.items.find((k) => k.id === id);
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  save(kit: BrandKit) {
    const idx = this.items.findIndex((k) => k.id === kit.id);
    if (idx >= 0) this.items[idx] = kit;
    else this.items.push(kit);
    this.commit();
  }
  remove(id: string) {
    this.items = this.items.filter((k) => k.id !== id);
    this.commit();
  }
  private commit() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.items));
    } catch {
      /* ignore quota errors */
    }
    this.listeners.forEach((l) => l());
  }
}

export const brandKits = new BrandKitStore();

/** Snapshot the current sequence's caption style and framing into a kit. */
export function kitFromSequence(name: string, seq: Sequence): BrandKit {
  return {
    id: `bk-${Date.now().toString(36)}`,
    name,
    captionStyle: { ...seq.captionTrack.style },
    width: seq.settings.width,
    height: seq.settings.height,
    fps: seq.settings.fps,
    createdAt: Date.now(),
  };
}
