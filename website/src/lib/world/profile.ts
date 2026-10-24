import { useSyncExternalStore } from 'react';
import type { MultiplayerMode } from './mode';
import type { Role } from './types';

/** Privacy and multiplayer settings (docs/MULTIPLAYER.md §3). */
export interface Settings {
  share: 'off' | 'groups' | 'team';
  precision: 'room' | 'floor' | 'building';
  duration: '15m' | '1h' | 'leave' | 'always';
  pingFrom: 'everyone' | 'team' | 'groups' | 'nobody';
  demoPlayers: boolean;
}

/** The player profile, kept in this browser only. */
export interface Profile {
  id: string;
  name: string;
  role: Role;
  groups: string[];
  /** Only what the user changed; the rest follows the building's mode. */
  settings: Partial<Settings>;
  /** "Where am I?" per building id. */
  rooms: Record<string, string>;
  /** Pins the passer-by chip already asked about (§4.2: once per pin). */
  asked: string[];
}

export const defaultSettings: Record<MultiplayerMode, Settings> = {
  team: { share: 'groups', precision: 'room', duration: 'leave', pingFrom: 'team', demoPlayers: true },
  public: { share: 'off', precision: 'floor', duration: '15m', pingFrom: 'groups', demoPlayers: true },
  home: { share: 'team', precision: 'room', duration: 'always', pingFrom: 'team', demoPlayers: true },
};

export const settingsFor = (profile: Profile, mode: MultiplayerMode): Settings => ({ ...defaultSettings[mode], ...profile.settings });

const MINUTE = 60_000;
/** How long shared presence lasts. "Until I leave" ends when the page closes, at the latest after 12 h. */
export const durationMs: Record<Settings['duration'], number> = { '15m': 15 * MINUTE, '1h': 60 * MINUTE, leave: 12 * 60 * MINUTE, always: 30 * 24 * 60 * MINUTE };

const KEY = 'lf.player';
const listeners = new Set<() => void>();
let cached: { raw: string | null; profile: Profile } | undefined;

function create(): Profile {
  return { id: crypto.randomUUID(), name: `Guest ${Math.floor(1000 + Math.random() * 9000)}`, role: 'member', groups: [], settings: {}, rooms: {}, asked: [] };
}

function read(): Profile {
  const raw = localStorage.getItem(KEY);
  if (cached && cached.raw === raw) return cached.profile;
  let profile: Profile | undefined;
  try { profile = raw ? { ...create(), ...JSON.parse(raw) } : undefined; } catch { profile = undefined; }
  if (!profile) {
    profile = create();
    localStorage.setItem(KEY, JSON.stringify(profile));
  }
  cached = { raw: localStorage.getItem(KEY), profile };
  return profile;
}

export function saveProfile(profile: Profile) {
  localStorage.setItem(KEY, JSON.stringify(profile));
  listeners.forEach(notify => notify());
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  window.addEventListener('storage', notify);
  return () => { listeners.delete(notify); window.removeEventListener('storage', notify); };
}

/** The profile, or null during server rendering. Created on first use. */
export function useProfile(): Profile | null {
  return useSyncExternalStore(subscribe, read, () => null);
}
