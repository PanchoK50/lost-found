# Multiplayer: spec for the UI (andy-ui)

Lost & Found · Hackathon 2026 · Rabea, Sat 24 Oct 2026 · for Andy

Multiplayer is our signature feature. Everyone else will have a 3D building, routing and a chat. We add **the people in the building**: they meet, report problems, hand things over and share what they know. The building learns from its people.

This spec is written against the code on `origin/andy-ui`: `ChatResponse` / `SceneDirective` in `website/src/lib/chat/contract.ts`, the anchor labels in `building-scene.tsx`, `WalkGraph` with `closed` in `lib/buildings/walk.ts`, and the HUD and console in `building-experience.tsx`. Nothing here replaces that code. Multiplayer adds a second, persistent layer, **the world**, next to the per-answer `scene`.

---

## 1. Four building blocks

Every multiplayer idea is built from four primitives. All of them attach to a space id from `building.json`, so they work in **any** building without special cases.

| Block | What | Examples |
|---|---|---|
| **Pin** | A message attached to a place, with an expiry | "East lift broken", "Cordless drill left here", "Cake in the kitchen" |
| **Ping** | Person to person, with a notification and a route | "Come to me", "Please pick this up", "Need a first aider" |
| **Presence** | Who is where. Opt-in, time-limited, room-level at most | "Mia is in Hall 2" |
| **Skill** | Shared knowledge as a one-tap shortcut | "Coffee" → nearest *working* coffee machine; "Key for store 3" → "box next to office 0.12" |

Each block can be created **from the chat** ("Tell Tom to fetch the drill from 2.14") or from a quick-action button. The chat always shows a **preview card first**, and nothing is posted before the user confirms. This matches UX rule U8.

---

## 2. Modes by building category

The building's category is **detected automatically** when it loads. The category sets the multiplayer mode, and the user can override it in settings.

| Category | Detected from (`room_type` counts, `building.source`) | Mode |
|---|---|---|
| Factory | `production_zone`, `assembly_zone`, `warehouse_zone`, `logistics_zone`, `additive_zone` | `team` |
| Office | `office`, `meeting_room` dominate | `team` |
| Campus | `lecture_hall`, `seminar_room`, `lab`, `library` | `team` |
| Public (mall, airport, station, fair) | many `shop`, large `lobby` or `hall` share, OSM source with shops | `public` |
| Residential | `bedroom`, `living_room`, `kitchen`, `bathroom` dominate, or source `resplan` / `swiss_dwellings` | `home` |

```ts
// lib/world/mode.ts
export type BuildingCategory = 'factory' | 'office' | 'campus' | 'public' | 'residential';
export type MultiplayerMode = 'team' | 'public' | 'home';

export function detectCategory(building: Building): BuildingCategory { /* score room_type counts, ties → 'office' */ }
export const modeFor: Record<BuildingCategory, MultiplayerMode> = {
  factory: 'team', office: 'team', campus: 'team', public: 'public', residential: 'home',
};
```

What changes per mode:

| | `team` (office, factory, campus) | `public` (mall, airport, station, fair) | `home` |
|---|---|---|---|
| Identity | Name and role. **Check in on arrival** (pick a room, scan a door QR or snap a photo) | Anonymous by default. Friends join through an invite link or QR code | Household members |
| Presence visible to | Team, or only my groups (e.g. "Lunch crew") | Only friends I invited | Household |
| Pins visible to | Team | Everyone (anonymous) | Household |
| Who can ping me | Team, or only groups and friends (setting) | Friends only | Household |
| Skills | Created by anyone, curated by the `facility` role | Crowd skills, ranked by votes | Household |
| Special | **Groups** with extra actions: "Lunch call" pings the group and suggests a halfway meeting point; group members see each other | Lost-friends finder | – |

Roles in `team` mode: `member`, `facility`, `first_aider`, `visitor`, `exhibitor`. Roles change what the user can do (a `facility` user can resolve pins alone) and which pings reach them (a "need a first aider" ping goes to `first_aider`).

---

## 3. Privacy settings

These live in a settings sheet (gear icon in `hud-top`) and are stored per user.

| Setting | Options | Default `team` | Default `public` |
|---|---|---|---|
| Share my location | Off · My groups · Team · Friends | Groups | Off |
| Precision | Room · Floor · Building | Room | Floor |
| Duration | 15 min · 1 h · Until I leave · Always | Until I leave | 15 min |
| Who can ping me | Everyone · Team · Groups and friends · Nobody | Team | Friends |
| Show demo players | On · Off | On | On |

Presence always carries an `until` timestamp. When it passes, the person disappears from everyone's map.

---

## 4. Keeping it true

Without these rules, the map would fill up with stale or fake reports.

1. **Everything expires.** Defaults per pin kind: `blocked` 2 h, `broken` 24 h, `item` 24 h or until picked up, `event` set by the author (default 2 h), `info` 7 days, `meet` 30 min. A countdown ring on the pin shows the time left.
2. **Passers-by confirm, without being asked to do anything else.** If a user's route goes through a pinned space, or the user is in that space, they get one chip above the input: *"East lift still broken? [Still broken] [Fixed]"*. They see it once per pin.
3. **When a pin is resolved:** two "Fixed" votes, or the author, or a `facility` user. Each "Still broken" vote extends the expiry by one default period, capped at 3×.
4. **When a pin affects routing for others:**
   - `team` mode: immediately, because members are known people. The badge shows "1 report" until somebody confirms it.
   - `public` mode: only after **2 independent reports or confirmations within 30 minutes**. Before that the pin is drawn dashed and marked "unconfirmed", and only the reporter's own routes avoid it.
5. **Limits:** at most 5 new pins per user per 10 minutes. Only the author or `facility` can edit or delete a pin.

---

## 5. Data model

```ts
// lib/world/types.ts
import type { Point } from '@/lib/buildings/types';
import type { MultiplayerMode } from './mode';

export type Role = 'member' | 'facility' | 'first_aider' | 'visitor' | 'exhibitor';
export type Audience = 'everyone' | 'team' | `group:${string}` | `player:${string}` | `role:${Role}`;

export interface Player {
  id: string;                  // random uuid, kept in localStorage
  name: string;
  role: Role;
  groups: string[];            // e.g. ['lunch-crew']
  initials: string;
  demo?: boolean;              // scripted demo player (section 9)
}

export interface Presence {
  playerId: string;
  spaceId: string;
  floorId: string;
  precision: 'room' | 'floor' | 'building';
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
  version: number;             // increases on every change
  players: Player[];
  presence: Presence[];        // already filtered by the requester's visibility
  pins: Pin[];                 // active and unconfirmed only
  pings: Ping[];               // only pings sent to or by the requester
  skills: Skill[];
}
```

---

## 6. API

There is a single route handler, which keeps the Next.js 16 surface small: no dynamic segments. It lives in `website/src/app/api/world/route.ts`.

```ts
// GET /api/world?buildingId=…&playerId=…&since=<version>
//   → 200 WorldState, or 204 if nothing changed since `since`

// POST /api/world   body: WorldAction
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
  | { type: 'skill.vote'; buildingId: string; skillId: string; playerId: string };
//   → 200 { ok: true, state: WorldState } | 400 { error }
```

**Storage** sits behind one interface so it can change without touching the UI:

```ts
// lib/world/store.ts (server only)
export interface WorldStore {
  get(buildingId: string): Promise<StoredWorld>;
  apply(action: WorldAction, now: number): Promise<StoredWorld>;   // validates, applies section 4, bumps version
}
```

- **Locally and on any single long-running Node server** (`next dev`, `next start`): an in-memory store (a module-level `Map`) is enough. Two browser windows on the same machine already play together.
- **On Vercel**, serverless instances don't share memory. Swap in a Redis-backed store (e.g. Upstash over REST, keys `world:<buildingId>`) using environment variables. Same interface, no UI change.
- Expiry and section 4 run inside `apply` and `get`, so no cron job is needed.

**Sync:** a `useWorld(buildingId, playerId)` hook polls `GET /api/world` every 2 s with `since=version`, and immediately after every POST. Polling is enough for the demo. Server-sent events can come later.

---

## 7. Chat integration

Extend the existing contract. Every new field is optional, so the current UI keeps working.

```ts
// contract.ts additions
export interface ChatRequest {
  // …existing fields
  playerId?: string;           // lets the backend read the player's presence, groups and pins
}

export interface ChatResponse {
  // …existing fields
  /** World changes the agent proposes. The UI shows each as a preview card; nothing is written until the user taps Confirm. */
  proposals?: { label: string; action: WorldAction }[];
}
```

What the chat understands. The demo resolver can pattern-match these first; the real agent gets one tool per action.

| User says | Proposal |
|---|---|
| "The east lift is broken" | `pin.create` kind `broken`, `elementId` = the lift connector |
| "Aisle 4 is blocked" / "Door to 2.04 is locked" | `pin.create` kind `blocked`, `elementId` = the opening or space |
| "I left the drill in 2.14 for Tom" | `pin.create` kind `item` plus `ping.send` kind `pick_up` to Tom |
| "Send my location to Mia" / "Tell Mia to come here" | `ping.send` kind `come_to_me` |
| "Where should Mia and I meet?" | `ping.send` kind `meet_halfway` (the room comes from the graph, section 10) |
| "Lunch?" (in a group) | `ping.send` kind `meet_halfway`, `to: 'group:lunch-crew'`, suggesting the canteen |
| "Where is Mia?" | no proposal. `scene.highlights` shows her room if she shares it, otherwise the reply says she isn't sharing |
| "Save this as 'Coffee' for everyone" | `skill.create` from the last answer |
| Question the building can't answer | reply "I don't know. Shall I ask the people here?" plus a proposal `ping.send` kind `ask_crowd` |

**Skills in the chat:** before calling the backend, the client checks the input against `skill.phrases`. On a match it shows the skill as a chip ("⚡ Coffee"). Tapping it sends the message with the skill id, and the backend resolves it relative to the player's presence.

---

## 8. Routing integration (so it really changes routes)

Active pins with an `elementId` are **closures**. Merge them wherever routes are computed:

```ts
// app/api/chat/route.ts
const world = await store.get(entry.building.building.id);
const worldClosed = activeClosures(world, playerId);   // section 4: team → active pins; public → confirmed pins, plus the player's own
const closed = [...(response.scene.closed ?? []), ...worldClosed];
const graph = new WalkGraph(building, { closed });
```

- Pass the same `closed` list into the resolver or agent, so that answers ("take the west lift") and drawn routes agree. Today `resolveDemo(building, message)` computes its routes without any world closures. Extend it to `resolveDemo(building, message, { closed, playerId })` and hand `closed` to every `WalkGraph` it builds.
- Return `worldClosed` in `scene.closed`. The scene already draws the "Closed" label.
- Skills with `skipBroken` ignore assets and spaces with an active `broken` pin. "Coffee" never sends you to the broken machine.

---

## 9. Demo players (the jury tests alone)

The jury tries the app by hand, alone. Multiplayer only shines with other people, so we ship **scripted demo players** (setting "Show demo players", on by default).

- `lib/world/demo-players.ts` seeds 3–4 players per building: e.g. Mia (member, lunch crew), Tom (member), Jonas (facility), Lea (first aider). Their presence is placed in real spaces of the loaded building, picked by room type, never by hard-coded ids.
- Scripted reactions, run server-side in `apply`:
  - `come_to_me` or `meet_halfway` to a demo player: accepted after 3 s. Their presence then **walks the route** space by space every 2 s.
  - `pick_up` to a demo player: accepted, and the item pin is resolved when they "arrive".
  - `ask_crowd`: one demo player answers after 5 s with a plausible answer, and the answer turns into an `info` pin.
  - A `broken` pin posted by the user: Jonas (facility) votes "still" after 10 s. Demo players occasionally post one `event` pin ("Cake in the kitchen").
- Demo players are marked `demo: true` and drawn with a dashed ring, so it's honest.
- Second option for live demos: a "Join on your phone" QR code in settings, opening the same building as a new player.

---

## 10. Computations (deterministic, reuse lib/buildings)

| Need | How |
|---|---|
| Route to a ping | `WalkGraph` from my presence space to `ping.spaceId`, with `closed` from section 8 |
| Meet halfway | Dijkstra from both players' spaces. Pick the room (`type` `room` or `hall`, prefer `kitchen`, `canteen`, `lobby`, `meeting_room`) that minimises the **larger** of the two walking times, with ties broken by the total. Works in any building |
| Who is "nearby" | players whose presence is within 60 m walking distance, or on the same floor if precision is `floor` |
| Passer-by check | the client compares the current `scene.routes[].spacePath` and my presence space with active pins I haven't voted on |
| Category and mode | `detectCategory`, section 2 |

---

## 11. UI in the andy-ui look

Reuse the existing tokens (`--accent` lime, `--glass`, `--line`, `--shadow`, `--ink`) and the warning red `#e5484d` from the scene palette. Everything is phone-first.

**HUD top (`hud-top`)**
- On the right of `hud-bar`: an **avatar stack** of people sharing their location (max 3 plus "+5"), each a lime circle with initials. Tapping it opens the people sheet: name, room, "Ping" and "Meet halfway".
- A small **mode badge** next to the building switch: "Team" / "Public" / "Home". Tapping it opens settings.

**Scene (`building-scene.tsx`)**
Add a `world` prop and render it as persistent anchors through the existing `Anchor` / `Projector` mechanism, next to `answerAnchors`. They stay when the answer `directive` changes.

| Element | Look | Class |
|---|---|---|
| Person | lime dot with initials, a soft pulse while walking, a dashed ring for demo players | `scene-label--person` |
| Pin `blocked` / `broken` | glass chip with a red icon and a countdown ring. Dashed border and "unconfirmed" while unconfirmed | `scene-label--pin-alert` |
| Pin `item` | glass chip with a photo thumbnail | `scene-label--pin-item` |
| Pin `event` / `info` | glass chip with a lime dot | `scene-label--pin-info` |
| Meet point | lime ring on the floor of the room plus a label "Meet here · 2 min each" | `scene-label--meet` |

On a single floor (`focus.mode === 'floor'`) show only that floor's world anchors. In the building overview show one small count chip per floor ("2 alerts · 3 people").

**Inbox toasts** (new, under `hud-top`): a glass card slides in for every new ping addressed to me.
`Mia · Come to me · Kitchen 1.14 · 2 min   [Go] [Later]`
"Go" sets `directive` to a route from my presence to the ping's space (as `routes: [{ spacePath }]`, so `withRoutePoints` fills in `points` and the turn-by-turn `steps` from `lib/buildings/turns.ts`), and marks the ping `accepted`. Toasts stack to 2 at most and the rest go into the people sheet.

**Console (`console`)**
- **Passer-by chip** above `.ask`: "East lift still broken? [Still broken] [Fixed]".
- **Proposal cards** in the transcript for `response.proposals`: a glass card with the label and the target room, plus **[Confirm] [Edit]**. After Confirm it shows "Posted" and the map updates.
- **Quick actions:** a "+" button left of the input opens a sheet with Report a problem · Drop an item · Share my location · Ping someone · Save as skill. Each one prefills a chat message such as "The east lift is broken" and goes through the same proposal flow, so there is one path to test.
- **Skill chips** in `.chips`: the 3 most-used skills of this building ("⚡ Coffee", "⚡ Quiet room").

**Check-in** (`team` mode, first open per day): a sheet asks "Where are you?" with three options: pick a room · scan a door QR · take a photo of the door sign. Skip is allowed.

---

## 12. Build order

**Phase 1: the four building blocks**
1. `lib/world/types.ts`, `mode.ts`, the in-memory `store.ts`, and `app/api/world/route.ts` with section 4 inside `apply`.
2. A `useWorld` hook with polling, and the player profile in `localStorage` (name, role, groups, settings).
3. A `world` prop on `BuildingScene`: people and pins as anchors.
4. Closures merged into routing (section 8).
5. A settings sheet with the mode badge and the privacy options.

**Phase 2: chat**
6. `proposals` in `ChatResponse`, proposal cards, and the patterns from section 7 in the demo resolver.
7. Skill chips and skill resolution.

**Phase 3: liveliness**
8. Inbox toasts with "Go", and the passer-by chip.
9. Demo players (section 9).

**Phase 4 (later): hero features on top of the blocks**
Meet halfway as a full flow · "Ask the people here" turning answers into pins and skills · item drop with photo · first-aider call · evacuation with an assembly-point check-in ("I'm out", so the fire warden sees who is missing and where they were last) · XP and a "Building expert" badge for reports and answers.

## 13. Done when

Two browser windows (one normal, one private), each with its own name, on the same building:

1. A says "The east lift is broken" and confirms. **Within 3 s** B sees the red pin, and B's next route avoids that lift.
2. A sends "Come to me" to B. B gets a toast, taps Go, and sees the route to A's room.
3. B's route passes the pin's space. B gets "Still broken?" and taps Fixed. After a second Fixed from A, the pin disappears and routes use the lift again.
4. "Save this as 'Coffee'" creates a skill. The chip appears for both, and it skips a coffee machine with a `broken` pin.
5. All of this works on **both catalog buildings** with no building-specific code, and the mode badge matches the detected category.
6. With demo players on and only one window open, steps 1–3 still produce visible reactions.
