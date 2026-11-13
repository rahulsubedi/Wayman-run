// Persisted player settings (sound + quality). Every storage access is guarded: private mode,
// blocked storage and sandboxed iframes must never break the game.
import type { Quality } from '../sim/types';

export interface Settings {
  muted: boolean;
  /** null = never chosen (let the game pick a default for the device). */
  quality: Quality | null;
}

const KEY = 'wayman-run.settings';

export function loadSettings(): Settings {
  const s: Settings = { muted: false, quality: null };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const o = JSON.parse(raw) as { muted?: unknown; quality?: unknown };
      s.muted = o.muted === true;
      if (o.quality === 'low' || o.quality === 'medium' || o.quality === 'high') s.quality = o.quality;
    }
  } catch {
    // storage unavailable or corrupt: defaults
  }
  return s;
}

export function saveSettings(patch: Partial<Settings>): void {
  try {
    const cur = loadSettings();
    const next = { ...cur, ...patch };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}
