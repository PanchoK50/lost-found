'use client';

import { useState } from 'react';
import type { Building } from '@/lib/buildings/types';
import { categoryLabel, modeFor, modeLabel, type BuildingCategory, type MultiplayerMode } from '@/lib/world/mode';
import { saveProfile, settingsFor, type Profile, type Settings } from '@/lib/world/profile';
import type { Role, WorldState } from '@/lib/world/types';
import type { WorldActions } from './world-hud';
import { Segmented } from './segmented';
import { Sheet } from './sheet';
import { inboxToasts } from './inbox';
import { SpaceSelect } from './space-select';

const roles: { value: Role; label: string }[] = [
  { value: 'member', label: 'Member' }, { value: 'facility', label: 'Facility' }, { value: 'first_aider', label: 'First aider' },
  { value: 'visitor', label: 'Visitor' }, { value: 'exhibitor', label: 'Exhibitor' },
];

/** Profile, mode and privacy (docs/MULTIPLAYER.md §2, §3). Choices apply at once; text fields when they lose focus. */
export function SettingsSheet({ building, profile, world, category, act, onGo, onClose }: {
  building: Building;
  profile: Profile;
  world?: WorldState;
  category: BuildingCategory;
  act: WorldActions['act'];
  /** Go to where a ping asks me to be. */
  onGo(spaceId: string): void;
  onClose(): void;
}) {
  const buildingId = building.building.id;
  const mode: MultiplayerMode = world?.mode ?? 'team';
  const settings = settingsFor(profile, mode);
  const [name, setName] = useState(profile.name);
  const [groups, setGroups] = useState(profile.groups.join(', '));
  const [error, setError] = useState<string>();
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => saveProfile({ ...profile, settings: { ...profile.settings, [key]: value } });
  const saveText = () => {
    const cleaned = name.trim().slice(0, 40);
    const list = groups.split(',').map(g => g.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean).slice(0, 10);
    if (cleaned && (cleaned !== profile.name || list.join() !== profile.groups.join())) saveProfile({ ...profile, name: cleaned, groups: list });
  };
  const setMode = async (next: MultiplayerMode | 'auto') => {
    const result = await act({ type: 'mode.set', playerId: profile.id, mode: next });
    setError(result.ok ? undefined : result.error);
  };
  const spaces = new Map(building.spaces.map(s => [s.id, s]));
  const floors = new Map(building.floors.map(f => [f.id, f]));
  const incoming = world ? inboxToasts(world, profile.id, settings.pingFrom, profile.groups).filter(t => t.type === 'incoming' && t.ping.kind !== 'ask_crowd') : [];
  const people = (world?.presence ?? []).map(p => ({ presence: p, player: world?.players.find(x => x.id === p.playerId) })).filter(p => p.player);

  return (
    <Sheet title="Settings" onClose={() => { saveText(); onClose(); }}>
      {incoming.length > 0 && <section>
        <h3>Inbox</h3>
        {incoming.map(t => {
          const from = world?.players.find(p => p.id === t.ping.fromId);
          return <p key={t.key} className="person-row">
            <span className={`person-dot${from?.demo ? ' person-dot--demo' : ''}`}>{from?.initials ?? '?'}</span>
            <span style={{ flex: 1 }}><strong>{from?.name ?? 'Someone'}</strong><small>{spaces.get(t.ping.spaceId)?.name}{t.ping.message ? ` · ${t.ping.message}` : ''}</small></span>
            <button type="button" className="button button--primary" style={{ flex: 'none', minHeight: 36 }} onClick={() => { void act({ type: 'ping.update', pingId: t.ping.id, playerId: profile.id, status: 'accepted' }); onGo(t.ping.spaceId); onClose(); }}>Go</button>
          </p>;
        })}
      </section>}

      <section>
        <h3>You</h3>
        <label>Name<input value={name} maxLength={40} onChange={e => setName(e.target.value)} onBlur={saveText} autoComplete="nickname" /></label>
        <label>Groups<input value={groups} onChange={e => setGroups(e.target.value)} onBlur={saveText} placeholder="e.g. lunch crew, line 2" /></label>
        <Segmented label="Role" options={roles} value={profile.role} onChange={role => saveProfile({ ...profile, role })} />
      </section>

      <section>
        <h3>Where are you?</h3>
        <SpaceSelect building={building} value={profile.rooms[buildingId] ?? ''} empty="Not set" onChange={id => saveProfile({ ...profile, rooms: { ...profile.rooms, [buildingId]: id } })} />
        <p className="hint">Only shown to others if you share your location below.</p>
      </section>

      <section>
        <h3>Mode</h3>
        <Segmented<MultiplayerMode | 'auto'> label="Mode" value={world?.modeOverride ? mode : 'auto'} onChange={setMode}
          options={[{ value: 'auto', label: `Auto · ${modeLabel[modeFor[category]]}` }, { value: 'team', label: 'Team' }, { value: 'public', label: 'Public' }, { value: 'home', label: 'Home' }]} />
        <p className="hint">Detected: {categoryLabel[category]}. The mode applies to everyone in this building.{mode === 'public' ? ' Reports close routes for others only after a second person confirms them.' : ''}</p>
        {error && <p className="sheet-error">{error}</p>}
      </section>

      <section>
        <h3>Privacy</h3>
        <p className="field-label">Share my location</p>
        <Segmented<Settings['share']> label="Share my location" value={settings.share} onChange={v => set('share', v)}
          options={[{ value: 'off', label: 'Off' }, { value: 'groups', label: 'My group' }, { value: 'team', label: mode === 'public' ? 'Everyone here' : 'Team' }]} />
        {settings.share === 'groups' && !profile.groups.length && <p className="hint">Add a group above, otherwise nobody sees you.</p>}
        <p className="field-label">Precision</p>
        <Segmented<Settings['precision']> label="Precision" value={settings.precision} onChange={v => set('precision', v)}
          options={[{ value: 'room', label: 'Room' }, { value: 'floor', label: 'Floor' }, { value: 'building', label: 'Building' }]} />
        <p className="field-label">For</p>
        <Segmented<Settings['duration']> label="Duration" value={settings.duration} onChange={v => set('duration', v)}
          options={[{ value: '15m', label: '15 min' }, { value: '1h', label: '1 h' }, { value: 'leave', label: 'Until I leave' }, { value: 'always', label: 'Always' }]} />
        <p className="field-label">Who can ping me</p>
        <Segmented<Settings['pingFrom']> label="Who can ping me" value={settings.pingFrom} onChange={v => set('pingFrom', v)}
          options={[{ value: 'everyone', label: 'Everyone' }, { value: 'team', label: 'Team' }, { value: 'groups', label: 'My groups' }, { value: 'nobody', label: 'Nobody' }]} />
        <p className="field-label">Demo players</p>
        <Segmented<'on' | 'off'> label="Show demo players" value={settings.demoPlayers ? 'on' : 'off'} onChange={v => set('demoPlayers', v === 'on')}
          options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
        <p className="hint">Pings and demo players arrive in a later step; these choices are already saved.</p>
      </section>

      <section>
        <h3>People sharing here</h3>
        {people.length ? people.map(({ presence, player }) => {
          const space = spaces.get(presence.spaceId), floor = floors.get(presence.floorId);
          const where = presence.precision === 'room' ? `${space?.name} · ${floor?.name}` : presence.precision === 'floor' ? floor?.name : 'In the building';
          return <p key={presence.playerId} className="person-row"><span className={`person-dot${player!.demo ? ' person-dot--demo' : ''}`}>{player!.initials}</span><span><strong>{player!.name}{player!.id === profile.id ? ' (you)' : ''}</strong><small>{where}</small></span></p>;
        }) : <p className="hint">Nobody is sharing their location right now.</p>}
      </section>
    </Sheet>
  );
}

