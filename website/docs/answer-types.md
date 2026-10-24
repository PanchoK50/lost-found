# Answer types: what each question kind shows

Every question kind in the challenge data (`data/*/*/questions*.jsonl`) maps to one of five **output types**. The type decides the headline and the 3D view. Within a type only the wording and the highlighted things change.

The backend returns a `ChatResponse` (`src/lib/chat/contract.ts`): `reply` text, a headline `answer` (`title`, `value`, `detail`) and a `scene`. The scene fields used per type are listed below.

**Highlight colours** (`scene.highlights[].tone`) mean the same thing everywhere:
- `primary` (lime, raised): what the answer names or counts.
- `secondary` (sage): the reference room the question is about, e.g. the start, the entry, the room being soundproofed.
- `muted` (faint tint): background candidates, e.g. the runners-up for "largest room".

On a single floor the camera frames the `primary` + `secondary` spaces (never tighter than 45% of the floor or 30 m).

Counts are test questions (145 in total); warm-up kinds are not scored.

## 1. One room

The answer is a specific room. Show its name (and area) and fly to it.

| Kind | Test | Headline | Scene |
|---|---|---|---|
| `largest_room` | 21 | `Generic room N5325` · `79.48 m²` | `focus: floor`; winner `primary` with label; other rooms of that type on the floor `muted` |
| `room_stacked` | 9 | `Generic room N1318` · `Floor 1` | `focus: stack` [lower, upper]; answer `primary`, source room `secondary`, other overlapped rooms `muted` |

- `room_stacked` sometimes has no explicit direction: "water dripping from the ceiling" means *above*.
- Definition: the space on the next floor up/down whose outline covers most of this room's outline.

## 2. A number over a set of rooms

The answer is a number (area or room count). Show the number and highlight the rooms that make it up, so the number can be checked by eye.

| Kind | Test | Headline | Scene |
|---|---|---|---|
| `floor_area_total` | 33 | `171.65 m²` · `7 meeting rooms on Ground floor` | `focus: floor`; every summed room `primary` |
| `shared_walls_count` | 26 | `7` · `Rooms sharing a wall with Assembly zone H-A2` | `focus: floor`; each neighbour `primary`; target `secondary` with label |
| `wide_delivery_count` | 18 | `7` · `Rooms a 1.1 m load can reach on Floor 1` | `focus: floor` (target floor); reachable rooms `primary`; entry room `secondary` (or `primary` if it counts); too-narrow doors with one reachable side as `muted` markers (small red discs) |
| `step_free_reachable_count` | 0 (2 total) | `30` · `Step-free rooms on Floor 2` | `focus: floor`; reachable rooms `primary`; `closed: [connector id]` |
| `what_if_door` | 3 | `22` · `Rooms on Basement 1 with a shorter way out` | `focus: floor`, or `stack` [door floor, target floor]; proposed door as a labelled `marker`; improved rooms `primary`; the two joined spaces `secondary` |

Definitions (from the kit README, section 4):
- **Sharing a wall:** at least 1 m of one room's outline runs within 0.35 m of the other's (either direction). Rooms **and halls** count; corridors, stairwells and lifts don't.
- **"Rooms" in reachability counts** (wide delivery, step-free, what-if): spaces with `type: "room"` only. Halls, lobbies and corridors are passed through but not counted. The entry space counts if it is itself a room (e.g. a living room in an apartment).
- **Wide delivery:** no stairs or steps (lifts are fine), every door at least the load's width.
- **What-if door:** placed in the middle of the shared wall and walked like any door. "Walk out" is the route-model distance to the nearest entrance; a room counts if it improves by more than 1 m.

These rules were checked against every train and dev question: shared walls 142/143, wide delivery 80/80, step-free reachable 2/2, what-if door 4/4. The one miss is in a building with duplicate room names (`osm-way37850565`), where matching by name is ambiguous.

## 3. A route

The answer is a path. Show the distance, draw the way and list the steps. For now the start comes from the question; later the request can carry the user's current location.

| Kind | Test | Headline | Scene |
|---|---|---|---|
| `route` (warm-up) | — | `≈ 55 m` · `1 floor · about 1 min` | `routes: [{ spacePath, points }]`; start `secondary` ("Start · …"), destination `primary`; spaces passed through `muted` |
| `route_step_free` (warm-up) | — | `≈ 26 m` · `step-free` **or** `No step-free route` | Same, no stairs or steps |
| `route_with_closure` (warm-up) | — | `≈ 121 m` **or** `No route` | Same, plus `closed: [ids]` |
| `tour` (warm-up) | — | `≈ 276 m` · `3 floors` | One `routes` entry per leg; stops labelled "Stop 1 · …" |
| `errand` | 20 | `132.35 m` | Two legs; pick-up room labelled "Pick up stove · …" |
| route to an item | — | `≈ 36 m` | "How do I get from X to the projector?" ends in the room that holds the nearest one |

**How routes are scored (challenge partner):**
- The scored output is the **ordered list of spaces** (`spacePath`). Every step must go through a real door, opening, stair or lift that the rules allow; an invalid route scores 0.
- Their checker measures the sequence itself: walking inside each space door to door, about 15 cm off the walls, around corners. Stairs cost 2 m per metre climbed; a lift 15 m plus 1 m per metre of height. Furniture is ignored.
- Score = best length ÷ your length; within 1% counts as full marks. The distance you print doesn't matter.
- Rules: **without stairs**: lifts, ramps and doors only. **Forklift**: aisles and openings ≥ 3 m wide only (no pedestrian walkways, stairs or lifts). **Closed** elements are avoided. **Factory production bays** (production, assembly, additive, warehouse, logistics zones) are destinations only, never shortcuts. If no route exists, say so.

`src/lib/buildings/walk.ts` implements this model (`WalkGraph.route`, `.measure` to check and measure a given space list, `.distancesFrom`). Checked on all 1,098 train/dev warm-up routes: reachability matches every time (including all 121 "no route" cases), every expected sequence is valid, and ours is never longer under this model. 861 are identical; the rest are equal or shorter.

**Contract:** a backend may return only `spacePath` per leg; the API (`src/app/api/chat/route.ts`) fills in `points` with the walking model. The UI turns `spacePath` into numbered steps (`src/lib/buildings/directions.ts`).

**No route:** shown as a result, not an error. The resolver re-checks without each rule to explain why ("The only way is through Office lift, which is closed", "Every way there needs Stairs 2"), marks the blockers, highlights start and destination, and tints how far you can get from the start.

Open points:
- **Errands use the kit's distance model**, not the partner's: "the room that has one closest to me" and the total match the expected answers in 93/93 cases only with the kit model (README section 3). The path is still drawn with the walking model.
- **Outside:** the kit lets routes go out one entrance and in another for free. The walking model charges the straight line between the two entrances, so outside is only used when really needed. Confirm with the partner how their checker treats outside.
- **Forklift** questions don't appear in the data yet; the rule is implemented from the note (aisles and openings ≥ 3 m, single floor).

## 4. Distance between two points

| Kind | Test | Headline | Scene |
|---|---|---|---|
| `straight_line_3d` | 15 | `13.06 m` | `focus: stack` (or `floor` if same floor); both rooms `primary`; `links: [{ from, to, label }]` between centroids |

- Room centre = polygon centroid at the floor's `elevation_m`.

## 5. Where things are (assets)

| Kind | Test | Headline | Scene |
|---|---|---|---|
| `locate` (warm-up) | — | `Quality lab 0.21` · `Ground floor` | `focus: floor`; containing room `primary`; item `markers` |
| `count` (warm-up) | — | `7` · `Meeting tables on Ground floor` | Items as `markers`; their rooms `secondary` |

## Conventions

- **`Answer:` line:** benchmark replies must end with `Answer: …`. The UI strips that line from the displayed reply because the headline card already shows the answer.
- **Current location (later):** `ChatRequest` will gain an optional `location` (space id from a QR code or the last tapped room); the backend uses it when the question gives no start.
- **Placeholder:** `src/lib/chat/demo-resolver.ts` implements these views with keyword matching so the UI can be demoed. The real agent replaces it and returns the same shape. Its geometry and graph code (`src/lib/buildings/geometry.ts`, `src/lib/buildings/graph.ts`, a port of the kit's route model) can be reused.
