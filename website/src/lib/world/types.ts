import type { Point } from '@/lib/buildings/types';
import type { MultiplayerMode } from './mode';

/**
 * The world: a persistent layer next to the per-answer `scene` (docs/MULTIPLAYER.md §5).
 * People, pins, pings and skills, all attached to space ids so they work in any building.
 */

export type Role = 'member' | 'facility' | 'first_aider' | 'visitor' | 'exhibitor';
export type Audience = 'everyone' | 'team' | `group:${string}` | `player:${string}` | `role:${Role}`;

export interface Player {
  id: string;                  // random uuid, kept in localStorage
  name: string;
  role: Role;
  groups: string[];            // e.g. ['lunch-crew']
  initials: string;
  demo?: boolean;              // scripted demo player (§9)
}

export interface Presence {
  playerId: string;
  spaceId: string;
  floorId: string;
  precision: 'room' | 'floor' | 'building';
  /** Who may see it, from the "Share my location" setting. */
  audience: Audience;
  until: number;               // epoch ms
  updatedAt: number;
}

export type PinKind = 'blocked' | 'broken' | 'item' | 'event' | 'info' | 'meet';
export interface Pin {
  id: string;
  kind: PinKind;
  spaceId: string;
  floorId: string;
  position: Point;             // building metres, Y up (default: the space centroid)
  title: string;               // "East lift broken"
  detail?: string;
  photo?: string;              // data URL, downscaled to at most 800 px
  elementId?: string;          // opening, connector or space it blocks, which feeds routing
  assetId?: string;            // asset it is about (broken coffee machine, dropped drill)
  authorId?: string;           // undefined = anonymous
  audience: Audience;
  createdAt: number;
  expiresAt: number;
  votes: { playerId: string; vote: 'still' | 'fixed'; at: number }[];
  status: 'unconfirmed' | 'active' | 'resolved' | 'expired';
}

export type PingKind = 'come_to_me' | 'meet_halfway' | 'pick_up' | 'help' | 'ask_crowd';
export interface Ping {
  id: string;
  kind: PingKind;
  fromId: string;
  to: Audience | 'nearby';     // a player, a group, a role, or people near the sender
  spaceId: string;             // where to go (sender's room, halfway room, pin room)
  floorId: string;
  message?: string;
  pinId?: string;              // pick_up: the item pin
  createdAt: number;
  expiresAt: number;
  status: 'sent' | 'accepted' | 'declined' | 'done';
  answers?: { playerId: string; text: string; at: number }[];   // ask_crowd
}

export interface Skill {
  id: string;
  name: string;                // "Coffee"
  phrases: string[];           // ["coffee", "kaffee", "espresso"]
  kind: 'nearest' | 'place' | 'answer';
  target: { assetType?: string; roomType?: string; spaceId?: string };
  answer?: string;             // kind 'answer': "In the key box next to office 0.12"
  skipBroken?: boolean;        // nearest: ignore targets with an active 'broken' pin
  authorId?: string;
  audience: Audience;
  votes: number;
  uses: number;
  createdAt: number;
}

export interface WorldState {
  buildingId: string;
  mode: MultiplayerMode;
  /** True when someone overrode the detected mode in settings. */
  modeOverride: boolean;
  version: number;             // increases on every change
  players: Player[];
  presence: Presence[];        // already filtered by the requester's visibility
  pins: Pin[];                 // active and unconfirmed only
  pings: Ping[];               // only pings sent to or by the requester
  skills: Skill[];
}

export type WorldAction =
  | { type: 'player.upsert'; buildingId: string; player: Player }
  | { type: 'presence.set'; buildingId: string; presence: Omit<Presence, 'updatedAt'> }
  | { type: 'presence.clear'; buildingId: string; playerId: string }
  | { type: 'pin.create'; buildingId: string; pin: Omit<Pin, 'id' | 'createdAt' | 'votes' | 'status'> }
  | { type: 'pin.vote'; buildingId: string; pinId: string; playerId: string; vote: 'still' | 'fixed' }
  | { type: 'pin.resolve'; buildingId: string; pinId: string; playerId: string }
  | { type: 'ping.send'; buildingId: string; ping: Omit<Ping, 'id' | 'createdAt' | 'status'> }
  | { type: 'ping.update'; buildingId: string; pingId: string; playerId: string; status?: Ping['status']; answer?: string }
  | { type: 'skill.create'; buildingId: string; skill: Omit<Skill, 'id' | 'createdAt' | 'votes' | 'uses'> }
  | { type: 'skill.vote'; buildingId: string; skillId: string; playerId: string }
  /** Override the detected mode for everyone in this building ('auto' goes back to detection). */
  | { type: 'mode.set'; buildingId: string; playerId: string; mode: MultiplayerMode | 'auto' };
