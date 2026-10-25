// Server-side: chat patterns for the world (docs/MULTIPLAYER.md §7, §10). They run before the building resolver.
import type { Building, Space } from '@/lib/buildings/types';
import { WalkGraph } from '@/lib/buildings/walk';
import type { ChatResponse, Proposal, SceneDirective } from '@/lib/chat/contract';
import { mentionsIn, resolveDemo } from '@/lib/chat/demo-resolver';
import type { Audience, Player, Presence, Skill, WorldAction, WorldState } from './types';

type NewPin = Extract<WorldAction, { type: 'pin.create' }>['pin'];

export interface WorldChatInput {
  /** The asking player's view of the world. */
  world: WorldState;
  playerId?: string;
  skillId?: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** Closures for this player's routes. */
  closed: string[];
}

export interface WorldChatResult { response: ChatResponse; usedSkill?: string }

const MINUTE = 60_000;
/** Same pace as the building resolver: 1.3 m/s. */
const minutes = (metres: number) => Math.max(1, Math.round(metres / 1.3 / 60));
const BAYS = new Set(['production_zone', 'assembly_zone', 'additive_zone', 'warehouse_zone', 'logistics_zone']);
const MEET_TYPES = ['kitchen', 'canteen', 'lobby', 'meeting_room'];
const LUNCH_TYPES = ['canteen', 'kitchen'];
const CLOSURE = /\b(broken|out of order|not working|out of service|doesn'?t work|does not work|blocked|closed|locked|jammed|kaputt)\b/;

/** A world answer for this message, or undefined to let the building resolver answer. */
export function resolveWorld(building: Building, message: string, input: WorldChatInput): WorldChatResult | undefined {
  const me = input.world.players.find(p => p.id === input.playerId);
  if (!me) return undefined;
  const chat = new WorldChat(building, message, input, me);
  if (input.skillId) return chat.useSkill(input.skillId);
  const response = chat.saveSkill() ?? chat.itemDrop() ?? chat.people() ?? chat.lunch() ?? chat.report() ?? chat.directAsk();
  return response && { response };
}

/** When the building can't answer: offer to ask the people here (ping kind ask_crowd). */
export function offerAskCrowd(building: Building, message: string, input: WorldChatInput, response: ChatResponse): ChatResponse {
  const me = input.world.players.find(p => p.id === input.playerId);
  if (!me || response.kind !== 'unknown') return response;
  const chat = new WorldChat(building, message, input, me);
  const space = chat.mySpace() ?? building.spaces.find(s => s.type === 'room') ?? building.spaces[0];
  if (!space) return response;
  return {
    ...response,
    reply: `I don't know. Shall I ask the people here?\n\n${response.reply}`,
    proposals: [{
      label: 'Ask the people here',
      detail: `"${message.slice(0, 120)}"`,
      action: { type: 'ping.send', buildingId: building.building.id, ping: { kind: 'ask_crowd', fromId: me.id, to: chat.everyone(), spaceId: space.id, floorId: space.floor_id, message: message.slice(0, 300), expiresAt: Date.now() + 30 * MINUTE } },
    }],
  };
}

const graphs = new Map<string, WalkGraph>();
/** Walk graphs are expensive for big buildings: one per building and set of closures. */
export function walkGraph(building: Building, closed: string[]) {
  const key = JSON.stringify([building.building.id, [...closed].sort()]);
  let graph = graphs.get(key);
  if (!graph) { graph = new WalkGraph(building, { closed }); graphs.set(key, graph); if (graphs.size > 20) graphs.delete(graphs.keys().next().value!); }
  return graph;
}

class WorldChat {
  readonly text: string;
  private readonly spaces: Map<string, Space>;
  private readonly buildingId: string;
  constructor(readonly building: Building, readonly message: string, readonly input: WorldChatInput, readonly me: Player) {
    this.text = message.toLowerCase();
    this.spaces = new Map(building.spaces.map(s => [s.id, s]));
    this.buildingId = building.building.id;
  }

  // ---------- helpers ----------

  presenceOf(playerId: string): Presence | undefined { return this.input.world.presence.find(p => p.playerId === playerId); }
  /** The room a player is in, if they share it at room precision. */
  roomOf(playerId: string): Space | undefined {
    const p = this.presenceOf(playerId);
    return p?.precision === 'room' ? this.spaces.get(p.spaceId) : undefined;
  }
  mySpace() { return this.roomOf(this.me.id); }
  floorName(space: Space) { return this.building.floors.find(f => f.id === space.floor_id)?.name ?? ''; }
  where(space: Space) { return `${space.name} · ${this.floorName(space)}`; }
  /** 'team' in team and home mode, 'everyone' in public mode. */
  everyone(): Audience { return this.input.world.mode === 'public' ? 'everyone' : 'team'; }
  graph() { return walkGraph(this.building, this.input.closed); }
  mentions(text = this.message) { return mentionsIn(this.building, text); }

  /** Players addressed with @, by full or first name ("@Tom", "@Mia Wagner"). Real people first. */
  mentioned(): Player[] {
    if (!this.text.includes('@')) return [];
    return [...this.input.world.players].sort((a, b) => Number(!!a.demo) - Number(!!b.demo)).filter(p => p.id !== this.me.id && [p.name, p.name.split(/\s+/)[0]].some(n => n.length >= 2 && new RegExp(`@${escape(n.toLowerCase())}(?![\\w])`).test(this.text)));
  }

  /** Other players named in the message, by full or first name. Real people win over demo players of the same name. */
  named(): Player[] {
    return [...this.input.world.players].sort((a, b) => Number(!!a.demo) - Number(!!b.demo)).filter(p => p.id !== this.me.id && [p.name, p.name.split(/\s+/)[0]].some(n => n.length >= 2 && new RegExp(`(?<![\\w])${escape(n.toLowerCase())}(?![\\w])`).test(this.text)));
  }

  reply(reply: string, scene: SceneDirective, proposals?: Proposal[], answer?: ChatResponse['answer']): ChatResponse {
    return { kind: 'world', reply, answer, scene, proposals };
  }
  focusOn(space: Space): SceneDirective['focus'] { return { mode: 'floor', floorId: space.floor_id }; }
  routeScene(from: Space, to: Space): SceneDirective['routes'] {
    const leg = this.graph().route(from.id, to.id);
    return leg && leg.spacePath.length > 1 ? [{ spacePath: leg.spacePath }] : undefined;
  }

  /**
   * Meeting room for several people (§10): a room or hall that minimises the longest walk, ties broken by the
   * total. Preferred room types win if any of them is reachable for everybody.
   */
  meetingPoint(from: Space[], preferred: string[]): { space: Space; walks: number[] } | undefined {
    const maps = from.map(s => this.graph().distancesFrom(s.id));
    const candidates = this.building.spaces.filter(s => (s.type === 'room' || s.type === 'hall') && !BAYS.has(s.room_type) && maps.every(m => m.has(s.id)));
    const liked = candidates.filter(s => preferred.includes(s.room_type));
    const pool = liked.length ? liked : candidates;
    let best: { space: Space; walks: number[]; worst: number; total: number } | undefined;
    for (const space of pool) {
      const walks = maps.map(m => m.get(space.id)!);
      const worst = Math.max(...walks), total = walks.reduce((a, b) => a + b, 0);
      if (!best || worst < best.worst - 1e-6 || (Math.abs(worst - best.worst) < 1e-6 && total < best.total)) best = { space, walks, worst, total };
    }
    return best && { space: best.space, walks: best.walks };
  }

  noRoom(what: string): ChatResponse {
    return this.reply(`Where are you? Tap the mode badge at the top, pick your room under "Where are you?", then ${what} again. You can also name a room, for example "… to Kitchen 1.08".`, { focus: { mode: 'building' } });
  }

  // ---------- "Save this as 'Coffee' for everyone" ----------

  saveSkill(): ChatResponse | undefined {
    const m = this.message.match(/\b(?:save|remember|store|keep)\b.*?\bas\s+["'“‘„]?([^"'”’“.!?]{1,40}?)["'”’“]?\s*(?:\bfor\s+(everyone|everybody|all|me|us|the team|my team)\b)?\s*[.!?]*$/i);
    if (!m) return undefined;
    const name = m[1].trim();
    const previous = (this.input.history ?? []).filter(h => h.role === 'user').at(-1)?.content;
    const lastAnswer = (this.input.history ?? []).filter(h => h.role === 'assistant').at(-1)?.content;
    if (!previous) return this.reply(`Ask me something first, for example "Where is the coffee machine?", then say "Save this as '${name}'".`, { focus: { mode: 'building' } });
    const prev = this.mentions(previous);
    let skill: Omit<Skill, 'id' | 'createdAt' | 'votes' | 'uses'>;
    let description: string;
    const audience: Audience = /^me$/i.test(m[2] ?? '') ? `player:${this.me.id}` : this.everyone();
    const base = { name, authorId: this.me.id, audience };
    if (prev.assetType) {
      const label = prev.assetType.replaceAll('_', ' ');
      skill = { ...base, phrases: unique([name, label]), kind: 'nearest', target: { assetType: prev.assetType }, skipBroken: true };
      description = `the way to the nearest working ${label}`;
    } else if (prev.spaces.length) {
      const space = prev.spaces.at(-1)!;
      skill = { ...base, phrases: unique([name]), kind: 'place', target: { spaceId: space.id } };
      description = `the way to ${space.name}`;
    } else if (prev.roomType) {
      const label = prev.roomType.replaceAll('_', ' ');
      skill = { ...base, phrases: unique([name, label]), kind: 'nearest', target: { roomType: prev.roomType }, skipBroken: true };
      description = `the way to the nearest ${label}`;
    } else if (lastAnswer) {
      skill = { ...base, phrases: unique([name]), kind: 'answer', target: {}, answer: lastAnswer.slice(0, 300) };
      description = 'the last answer';
    } else return undefined;
    return this.reply(
      `Shall I save "${name}" as a skill? ${audience.startsWith('player:') ? 'You' : 'Everyone here'} can then tap ⚡ ${name} to get ${description} from wherever they are.`,
      { focus: { mode: 'building' } },
      [{ label: `Save skill ⚡ ${name}`, detail: description[0].toUpperCase() + description.slice(1), action: { type: 'skill.create', buildingId: this.buildingId, skill } }],
    );
  }

  // ---------- "I left the drill in 2.14 for Tom" ----------

  itemDrop(): ChatResponse | undefined {
    const m = this.text.match(/\b(?:left|dropped|put|placed|parked|leave)\s+(?:the |a |an |my |our |some )?(.+?)\s+(?:in|at|on|next to|by)\s+/);
    if (!m) return undefined;
    const thing = m[1].replace(/\s+for\s+\w+$/, '').trim().slice(0, 40);
    const space = this.mentions().spaces[0] ?? (/\b(here|my room)\b/.test(this.text) ? this.mySpace() : undefined);
    if (!space) return this.noRoom('tell me');
    const forName = this.text.match(/\bfor\s+([\w-]+)/)?.[1];
    const recipient = this.named()[0];
    const title = `${thing[0].toUpperCase()}${thing.slice(1)} in ${space.name}`;
    const proposals: Proposal[] = [{
      label: `Drop pin: ${title}`,
      detail: this.where(space),
      action: { type: 'pin.create', buildingId: this.buildingId, pin: { kind: 'item', spaceId: space.id, title, authorId: this.me.id, audience: this.everyone() } },
    }];
    if (recipient) proposals.push({
      label: `Ask ${recipient.name} to pick it up`,
      detail: this.where(space),
      action: { type: 'ping.send', buildingId: this.buildingId, ping: { kind: 'pick_up', fromId: this.me.id, to: `player:${recipient.id}`, spaceId: space.id, floorId: space.floor_id, message: `Please pick up the ${thing} in ${space.name}.`, expiresAt: Date.now() + 60 * MINUTE } },
    });
    const unknown = forName && !recipient && !['me', 'you', 'later', 'now'].includes(forName) ? ` I don't know anyone called ${forName} here, so I'll only drop a pin.` : '';
    return this.reply(
      `Got it: the ${thing} is in ${space.name}.${recipient ? ` Shall I pin it there and ask ${recipient.name} to pick it up?` : ' Shall I pin it there so others can find it?'}${unknown}`,
      { focus: this.focusOn(space), highlights: [{ spaceId: space.id, tone: 'primary', label: title }] },
      proposals,
    );
  }

  // ---------- "Where is Mia?", "Tell Mia to come here", "Where should Mia and I meet?" ----------

  people(): ChatResponse | undefined {
    const tagged = this.mentioned()[0];
    const player = tagged ?? this.named()[0];
    if (!player) return undefined;
    if (/\b(meet|halfway|middle|half way)\b/.test(this.text)) return this.meetHalfway(player);
    if (/\b(tell|ask|send|share|ping|call|get)\b/.test(this.text) && /\b(come|location|where i am|find me|over|here|to me)\b/.test(this.text)) return this.comeToMe(player);
    if (tagged && /^\s*@\S+\s+(come|come here|come over)\s*[.!]*$/.test(this.text)) return this.comeToMe(player);
    // "Where is @Tom?" asks about Tom; "@Tom where is the key?" is a question for Tom (directAsk).
    if (tagged ? /\bwhere(?:'s| is| are)\s+@/.test(this.text) : /\bwhere(?:'s| is| are)?\b/.test(this.text)) return this.whereIs(player);
    return undefined;
  }

  // ---------- "@Tom where is the key for store 3?" ----------

  directAsk(): ChatResponse | undefined {
    const people = this.mentioned();
    if (!people.length) return undefined;
    let question = this.message;
    for (const p of people) for (const n of [p.name, p.name.split(/\s+/)[0]]) question = question.replace(new RegExp(`@${escape(n)}(?![\\w])`, 'gi'), '');
    question = question.replace(/^[\s,:;-]+|[\s,;-]+$/g, '').replace(/\s{2,}/g, ' ');
    const names = people.map(p => p.name).join(' and ');
    if (!question) return this.reply(`What do you want to ask ${names}? Write it after the name, for example "@${people[0].name.split(/\s+/)[0]} where is the key?".`, { focus: { mode: 'building' } });
    const space = this.mySpace() ?? this.roomOf(people[0].id) ?? this.building.spaces[0];
    return this.reply(
      `Shall I send this to ${names}? The answer shows up as a message, and you can find it later under Messages.`,
      { focus: { mode: 'building' } },
      people.map(p => ({
        label: `Ask ${p.name}`,
        detail: `"${question.slice(0, 120)}"`,
        action: { type: 'ping.send', buildingId: this.buildingId, ping: { kind: 'ask', fromId: this.me.id, to: `player:${p.id}`, spaceId: space.id, floorId: space.floor_id, message: question.slice(0, 300), expiresAt: Date.now() + 60 * MINUTE } },
      })),
    );
  }

  whereIs(player: Player): ChatResponse {
    const p = this.presenceOf(player.id);
    const space = p && this.spaces.get(p.spaceId);
    if (!p || !space) {
      // Not sharing: offer to ask them (sent right away when the message @-mentions them).
      const at = this.mySpace() ?? this.building.spaces.find(s => s.type === 'room') ?? this.building.spaces[0];
      const proposal: Proposal = {
        label: `Ask ${player.name}`,
        detail: 'for their location',
        action: { type: 'ping.send', buildingId: this.buildingId, ping: { kind: 'share_location', fromId: this.me.id, to: `player:${player.id}`, spaceId: at.id, floorId: at.floor_id, expiresAt: Date.now() + 60 * MINUTE } },
      };
      return { ...this.reply(`${player.name} isn't sharing a location right now. Shall I ask ${player.name.split(/\s+/)[0]} to share it?`, { focus: { mode: 'building' } }), proposals: [proposal] };
    }
    if (p.precision === 'building') return this.reply(`${player.name} is somewhere in the building.`, { focus: { mode: 'building' } });
    if (p.precision === 'floor') return this.reply(`${player.name} is on ${this.floorName(space)}.`, { focus: this.focusOn(space) }, undefined, { title: player.name, value: this.floorName(space) });
    const mine = this.mySpace();
    const walk = mine && this.graph().route(mine.id, space.id);
    return this.reply(
      `${player.name} is in ${space.name} on ${this.floorName(space)}.${walk ? ` That's about ${minutes(walk.length)} min from you.` : ''}`,
      { focus: this.focusOn(space), highlights: [{ spaceId: space.id, tone: 'primary', label: `${player.name} · ${space.name}` }] },
      undefined,
      { title: player.name, value: space.name, detail: this.floorName(space) },
    );
  }

  comeToMe(player: Player): ChatResponse {
    const space = this.mentions().spaces[0] ?? this.mySpace();
    if (!space) return this.noRoom(`ask me to call ${player.name}`);
    const theirs = this.roomOf(player.id);
    const walk = theirs && this.graph().route(theirs.id, space.id);
    return this.reply(
      `Shall I ask ${player.name} to come to ${space.name}?${walk ? ` It's about ${minutes(walk.length)} min for them.` : ''}`,
      { focus: this.focusOn(space), highlights: [{ spaceId: space.id, tone: 'primary', label: `Meet ${player.name} · ${space.name}` }, ...(theirs ? [{ spaceId: theirs.id, tone: 'secondary' as const }] : [])], routes: theirs && this.routeScene(theirs, space) },
      [{
        label: `Ask ${player.name} to come to ${space.name}`,
        detail: this.where(space),
        action: { type: 'ping.send', buildingId: this.buildingId, ping: { kind: 'come_to_me', fromId: this.me.id, to: `player:${player.id}`, spaceId: space.id, floorId: space.floor_id, expiresAt: Date.now() + 30 * MINUTE } },
      }],
    );
  }

  meetHalfway(player: Player): ChatResponse {
    const mine = this.mySpace();
    if (!mine) return this.noRoom(`ask where to meet ${player.name}`);
    const theirs = this.roomOf(player.id);
    if (!theirs) {
      const response = this.comeToMe(player);
      return { ...response, reply: `${player.name} isn't sharing a room with you, so I can't work out the middle. ${response.reply}` };
    }
    const meet = this.meetingPoint([mine, theirs], MEET_TYPES);
    if (!meet) return this.reply(`I couldn't find a room both of you can walk to${this.input.closed.length ? ' with the current closures' : ''}.`, { focus: this.focusOn(mine) });
    const [a, b] = meet.walks.map(minutes);
    return this.reply(
      `Meet in ${meet.space.name} on ${this.floorName(meet.space)}: about ${a} min for you and ${b} min for ${player.name}. Shall I send ${player.name} the meeting point?`,
      {
        focus: this.focusOn(meet.space),
        highlights: [
          { spaceId: meet.space.id, tone: 'primary', label: `Meet here · ${a} / ${b} min` },
          { spaceId: theirs.id, tone: 'secondary' },
        ],
        routes: this.routeScene(mine, meet.space),
      },
      [{
        label: `Meet ${player.name} in ${meet.space.name}`,
        detail: `${this.where(meet.space)} · ${a} / ${b} min`,
        action: { type: 'ping.send', buildingId: this.buildingId, ping: { kind: 'meet_halfway', fromId: this.me.id, to: `player:${player.id}`, spaceId: meet.space.id, floorId: meet.space.floor_id, expiresAt: Date.now() + 30 * MINUTE } },
      }],
      { title: 'Meeting point', value: meet.space.name, detail: `${a} min for you · ${b} min for ${player.name}` },
    );
  }

  // ---------- "Lunch?" in a group ----------

  lunch(): ChatResponse | undefined {
    if (!/\b(lunch|mittag|mittagessen)\b/.test(this.text) || !this.me.groups.length) return undefined;
    const group = this.me.groups.find(g => this.text.includes(g.replaceAll('-', ' '))) ?? this.me.groups[0];
    const mine = this.mySpace();
    if (!mine) return this.noRoom('ask for lunch');
    const members = this.input.world.players.filter(p => p.id !== this.me.id && p.groups.includes(group));
    const rooms = members.map(p => this.roomOf(p.id)).filter((s): s is Space => !!s);
    const meet = this.meetingPoint([mine, ...rooms], LUNCH_TYPES);
    if (!meet) return this.reply('I couldn\'t find a place everyone can walk to.', { focus: this.focusOn(mine) });
    const worst = minutes(Math.max(...meet.walks));
    const crew = group.replaceAll('-', ' ');
    return this.reply(
      `How about ${meet.space.name} on ${this.floorName(meet.space)}? ${rooms.length ? `It's at most ${worst} min for anyone in ${crew} who shares a room.` : `It's ${worst} min for you; nobody else in ${crew} shares a room right now.`} Shall I ping ${crew}?`,
      {
        focus: this.focusOn(meet.space),
        highlights: [{ spaceId: meet.space.id, tone: 'primary', label: `Lunch · ${meet.space.name}` }, ...rooms.map(s => ({ spaceId: s.id, tone: 'secondary' as const }))],
        routes: this.routeScene(mine, meet.space),
      },
      [{
        label: `Lunch call to ${crew}`,
        detail: `${this.where(meet.space)} · at most ${worst} min`,
        action: { type: 'ping.send', buildingId: this.buildingId, ping: { kind: 'meet_halfway', fromId: this.me.id, to: `group:${group}`, spaceId: meet.space.id, floorId: meet.space.floor_id, message: 'Lunch?', expiresAt: Date.now() + 30 * MINUTE } },
      }],
    );
  }

  // ---------- "The east lift is broken", "Aisle 4 is blocked" ----------

  report(): ChatResponse | undefined {
    if (!CLOSURE.test(this.text) || this.text.includes('?') || /\b(how|route|way|from|can i|is there|get to|take me)\b/.test(this.text)) return undefined;
    const kind: 'blocked' | 'broken' = /\b(blocked|closed|locked|jammed)\b/.test(this.text) ? 'blocked' : 'broken';
    const m = this.mentions();
    const mine = this.mySpace();
    const state = kind === 'broken' ? 'out of order' : 'blocked';
    let pin: NewPin;
    let space: Space;
    let effect: string;
    if (m.connectors.length) {
      const c = m.connectors[0];
      const stop = c.space_ids.find(id => this.spaces.get(id)?.floor_id === mine?.floor_id) ?? c.space_ids[0];
      space = this.spaces.get(stop)!;
      pin = { kind, spaceId: space.id, title: `${c.name} ${state}`, elementId: c.id, authorId: this.me.id, audience: this.everyone() };
      effect = `routes will avoid ${c.name}`;
    } else if (m.assetType) {
      const label = m.assetType.replaceAll('_', ' ');
      const holder = m.spaces[0] ?? mine;
      if (!holder) {
        const example = this.spaces.get(this.building.assets.find(a => a.type === m.assetType)?.space_id ?? '');
        return this.reply(`Which ${label}? Say where it is, for example "The ${label} in ${example?.name ?? 'Kitchen 1.08'} is broken".`, { focus: { mode: 'building' } });
      }
      const asset = this.building.assets.find(a => a.type === m.assetType && a.space_id === holder.id);
      if (!asset) return this.reply(`I can't find a ${label} in ${holder.name}.`, { focus: this.focusOn(holder), highlights: [{ spaceId: holder.id, tone: 'secondary', label: holder.name }] });
      space = holder;
      pin = { kind: 'broken', spaceId: space.id, title: `${label[0].toUpperCase()}${label.slice(1)} broken · ${space.name}`, assetId: asset.id, authorId: this.me.id, audience: this.everyone(), position: asset.position };
      effect = `skills like "nearest ${label}" will skip it`;
    } else if (m.spaces.length) {
      space = m.spaces[0];
      pin = { kind, spaceId: space.id, title: `${space.name} ${state}`, elementId: space.id, authorId: this.me.id, audience: this.everyone() };
      effect = `routes will avoid ${space.name}`;
    } else return undefined;
    const when = pin.elementId ? (this.input.world.mode === 'public' ? ' once a second person confirms it' : ' right away') : '';
    return this.reply(
      `Thanks for telling me. Shall I post this? Then ${effect}${when}.`,
      { focus: this.focusOn(space), highlights: [{ spaceId: space.id, tone: 'secondary', label: pin.title }] },
      [{ label: `Report: ${pin.title}`, detail: this.where(space), action: { type: 'pin.create', buildingId: this.buildingId, pin } }],
    );
  }

  // ---------- skills (§7 "Skills in the chat") ----------

  useSkill(skillId: string): WorldChatResult {
    const skill = this.input.world.skills.find(s => s.id === skillId);
    if (!skill) return { response: this.reply('That skill is gone.', { focus: { mode: 'building' } }) };
    const tag = `⚡ ${skill.name}`;
    if (skill.kind === 'answer') {
      const space = skill.target.spaceId ? this.spaces.get(skill.target.spaceId) : undefined;
      return { usedSkill: skill.id, response: this.reply(skill.answer ?? '', space ? { focus: this.focusOn(space), highlights: [{ spaceId: space.id, tone: 'primary', label: space.name }] } : { focus: { mode: 'building' } }, undefined, { title: tag, value: space?.name }) };
    }
    const from = this.mentions().spaces[0] ?? this.mySpace();
    if (!from) return { response: this.noRoom(`tap ${tag}`) };
    const skipped = skill.skipBroken ? this.brokenTargets(skill) : [];
    let response: ChatResponse;
    if (skill.kind === 'nearest' && skill.target.assetType) {
      response = resolveDemo(this.building, `How do I get from ${from.name} to the ${skill.target.assetType.replaceAll('_', ' ')}?`, { closed: this.input.closed, skip: skipped.map(s => s.id) });
    } else {
      const target = skill.kind === 'place' ? this.spaces.get(skill.target.spaceId ?? '') : this.nearestOfType(from, skill.target.roomType, new Set(skipped.map(s => s.id)));
      if (!target) return { usedSkill: skill.id, response: this.reply(`I couldn't find where ${tag} leads from ${from.name}.`, { focus: this.focusOn(from) }) };
      if (target.id === from.id) return { usedSkill: skill.id, response: this.reply(`${tag}: you're already in ${target.name}.`, { focus: this.focusOn(target), highlights: [{ spaceId: target.id, tone: 'primary', label: target.name }] }, undefined, { title: tag, value: target.name }) };
      response = resolveDemo(this.building, `How do I get from ${from.name} to ${target.name}?`, { closed: this.input.closed });
    }
    const note = skipped.length ? ` I skipped ${skipped.map(s => s.name).join(' and ')}, reported broken.` : '';
    return {
      usedSkill: skill.id,
      response: {
        ...response,
        reply: `${tag}: ${response.reply}${note}`,
        answer: response.answer && { ...response.answer, detail: [tag, response.answer.detail].filter(Boolean).join(' · ') },
      },
    };
  }

  /** Spaces whose matching items or the space itself have a live 'broken' pin. */
  brokenTargets(skill: Skill): Space[] {
    const broken = this.input.world.pins.filter(p => p.kind === 'broken' && (p.status === 'active' || p.authorId === this.me.id));
    const out: Space[] = [];
    for (const space of this.building.spaces) {
      const items = skill.target.assetType ? this.building.assets.filter(a => a.space_id === space.id && a.type === skill.target.assetType) : [];
      if (skill.target.assetType && !items.length) continue;
      if (skill.target.roomType && space.room_type !== skill.target.roomType) continue;
      const spaceBroken = broken.some(p => p.spaceId === space.id && !p.assetId);
      const allItemsBroken = items.length > 0 && items.every(a => broken.some(p => p.assetId === a.id));
      if (spaceBroken || allItemsBroken) out.push(space);
    }
    return out;
  }

  nearestOfType(from: Space, roomType: string | undefined, skip: Set<string>): Space | undefined {
    if (!roomType) return undefined;
    const dist = this.graph().distancesFrom(from.id);
    return this.building.spaces
      .filter(s => s.room_type === roomType && !skip.has(s.id) && dist.has(s.id))
      .sort((a, b) => dist.get(a.id)! - dist.get(b.id)!)[0];
  }
}

function unique(values: string[]) {
  return [...new Set(values.map(v => v.toLowerCase().trim()).filter(Boolean))];
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Answers about the building know nothing of reports. Mark what people reported broken: its marker says so,
 * its room drops to a muted highlight, and the headline points at a working one instead.
 */
export function markBroken(building: Building, response: ChatResponse, world: WorldState): ChatResponse {
  const broken = world.pins.filter(p => p.kind === 'broken');
  if (!broken.length || !response.scene.markers?.length) return response;
  const assets = new Map(building.assets.map(a => [a.id, a]));
  const brokenAssets = broken.map(p => p.assetId && assets.get(p.assetId)).filter(a => !!a);
  const brokenSpaces = new Set(broken.filter(p => !p.assetId).map(p => p.spaceId));
  const assetAt = (m: { floorId: string | null; position: [number, number] }) => m.floorId === null ? undefined : building.assets.find(a => a.floor_id === m.floorId && a.position[0] === m.position[0] && a.position[1] === m.position[1]);
  const isBroken = (m: { floorId: string | null; position: [number, number] }) => {
    const asset = assetAt(m);
    return !!asset && (brokenAssets.some(b => b.id === asset.id) || brokenSpaces.has(asset.space_id));
  };
  const markers = response.scene.markers.map(m => isBroken(m) ? { ...m, label: `${m.label} · reported broken` } : m);
  const hits = response.scene.markers.filter(isBroken);
  if (!hits.length) return response;
  // A highlighted room is muted when every marker inside it is broken.
  const inSpace = new Map<string, boolean[]>();
  for (const m of response.scene.markers) { const a = assetAt(m); if (a) inSpace.set(a.space_id, [...(inSpace.get(a.space_id) ?? []), isBroken(m)]); }
  const dead = new Set([...inSpace].filter(([, flags]) => flags.every(Boolean)).map(([id]) => id));
  const highlights = response.scene.highlights?.map(h => dead.has(h.spaceId) ? { spaceId: h.spaceId, tone: 'muted' as const } : h);
  const spaces = new Map(building.spaces.map(s => [s.id, s]));
  const floors = new Map(building.floors.map(f => [f.id, f]));
  let answer = response.answer;
  const headline = building.spaces.find(s => s.name === answer?.title);
  if (answer && headline && dead.has(headline.id)) {
    const workingId = highlights?.find(h => h.tone === 'primary' && !dead.has(h.spaceId))?.spaceId
      ?? response.scene.markers.map(assetAt).find(a => a && !dead.has(a.space_id))?.space_id;
    const space = workingId ? spaces.get(workingId) : undefined;
    if (space) answer = { ...answer, title: space.name, value: floors.get(space.floor_id)?.name };
  }
  const names = hits.map(m => m.label);
  return {
    ...response,
    reply: `${response.reply} ${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} reported broken. Tap a room on the map for a route.`,
    answer,
    scene: { ...response.scene, markers, highlights },
  };
}
