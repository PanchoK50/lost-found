import type { Point } from '@/lib/buildings/types';
import type { WorldAction } from '@/lib/world/types';

/**
 * Contract between the chat backend (agent / deterministic tools) and the 3D viewer.
 *
 * The backend answers in prose (`reply`), a short headline (`answer`), and a `scene`
 * that tells the viewer where to fly and what to highlight. The viewer never
 * computes answers itself; it only renders what the scene describes.
 */

/** Benchmark question kinds from the challenge kit, plus UI-only intents. */
export type QuestionKind =
  | 'locate' | 'count'
  | 'route' | 'route_step_free' | 'route_with_closure' | 'tour' | 'errand'
  | 'largest_room' | 'floor_area_total' | 'shared_walls_count' | 'room_stacked' | 'straight_line_3d'
  | 'wide_delivery_count' | 'step_free_reachable_count' | 'what_if_door'
  | 'show' | 'unknown'
  /** Multiplayer: reports, pings, people and skills (docs/MULTIPLAYER.md §7). */
  | 'world';

export interface ChatRequest {
  buildingId: string;
  message: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** Backend conversation id from the previous response; keeps follow-ups and edits in one session. */
  sessionId?: string;
  /** Saved chat thread (Supabase `conversations`), when signed in. */
  conversationId?: string;
  /** Lets the backend read the player's world: presence, groups, pins and closures. */
  playerId?: string;
  /** A skill chip was tapped: resolve this skill relative to the player's presence. */
  skillId?: string;
  /** The room the player picked as "I'm here" (no GPS indoors). */
  location?: string;
  /** What is selected on the model and shown as a chip in the chat: "this", "it", "this door" refer to it. */
  selection?: { kind: 'asset' | 'opening' | 'space'; id: string };
}

/** A world change the agent suggests. Shown as a preview card; nothing is written until the user taps Confirm (U8). */
export interface Proposal {
  label: string;
  /** Where it applies, e.g. "Office lift · Ground floor". */
  detail?: string;
  action: WorldAction;
}

export interface ChatResponse {
  kind: QuestionKind;
  /** Full assistant reply, plain text. */
  reply: string;
  /** Headline shown on the answer card, e.g. { title: 'Generic room N5325', value: '79.48 m²' }. */
  /** `negative`: the answer is "not possible" (e.g. no step-free route); shown without the orange answer accent. */
  answer?: { title: string; value?: string; detail?: string; negative?: boolean };
  scene: SceneDirective;
  /** Follow-up buttons under the answer. `send: false` puts the text in the input for the user to finish. */
  actions?: { label: string; message: string; send?: boolean }[];
  /** Backend conversation id; send it back with the next message. */
  sessionId?: string;
  /** Saved chat thread id; send it back with the next message. */
  conversationId?: string;
  /** Building edits the agent made this turn (closures, new doors, moved assets). */
  edits?: unknown[];
  /** Claude cost of this answer in dollars (agent answers only). */
  cost?: number;
  /** Who answered: the Python agent, the world layer (people, reports, skills), or the offline demo resolver. */
  source?: 'agent' | 'world' | 'demo';
  /** World changes the agent proposes (docs/MULTIPLAYER.md §7). */
  proposals?: Proposal[];
}

/** A point on a specific floor, in building metres (Y up). */
export interface FloorPoint { floorId: string; position: Point }

/** One maneuver in turn-by-turn directions, Google Maps style. */
export interface RouteStep {
  action: 'straight' | 'slight-left' | 'left' | 'sharp-left' | 'slight-right' | 'right' | 'sharp-right' | 'u-turn'
    | 'stairs-up' | 'stairs-down' | 'lift-up' | 'lift-down' | 'outside' | 'inside';
  text: string;
  /** Extra hint, e.g. "The destination is the door on your left." */
  note?: string;
  /** Metres walked after this step until the next one. */
  distance: number;
  /** Floors ridden, for stairs and lifts. */
  floors?: number;
  /** Where the maneuver happens; tapping a step flies the camera here. */
  at: FloorPoint;
}

export type SceneFocus =
  /** Whole building, all floors stacked. */
  | { mode: 'building' }
  /** One floor in 2.5D; floors above lift away, floors below are ghosted. `around` zooms to a point (e.g. a route step). */
  | { mode: 'floor'; floorId: string; around?: Point }
  /**
   * Several floors shown together. `spread` (default) pulls them apart so they can be compared;
   * `true` keeps their real heights, e.g. for 3D distances.
   */
  | { mode: 'stack'; floorIds: string[]; spacing?: 'spread' | 'true' }
  /** The whole building as glass at real heights, with `floorIds` drawn solid and opened up (emergency views). */
  | { mode: 'xray'; floorIds: string[] };

export type Tone = 'primary' | 'secondary' | 'muted';

export interface SceneDirective {
  focus: SceneFocus;
  /**
   * Spaces to colour. `primary`: what the answer names or counts (orange, raised).
   * `secondary`: the reference room the question is about, e.g. the start, entry or target (light blue).
   * `muted`: background candidates, e.g. the runners-up for "largest room" (faint blue tint).
   */
  highlights?: { spaceId: string; tone: Tone; label?: string }[];
  /** Pins for assets or points. `primary` = the answer (orange head, answer label); `muted` = small flat warnings (e.g. doors that are too narrow). */
  markers?: (FloorPoint & { label: string; tone?: Tone })[];
  /**
   * Routes, one entry per leg. `steps` are turn-by-turn directions (filled in by the API when omitted). `spacePath` is the ordered list of spaces walked through (what the route check
   * scores) and drives the step list. `points` is the drawn polyline; if omitted, the API fills it in from
   * `spacePath` with the walking model (lib/buildings/walk.ts). Points on different floors draw a vertical hop.
   */
  routes?: { spacePath?: string[]; points?: FloorPoint[]; steps?: RouteStep[]; label?: string }[];
  /** Straight 3D lines, e.g. sensor links between room centroids. `breakdown` also draws the across and up legs (dashed). */
  links?: { from: FloorPoint; to: FloorPoint; label?: string; breakdown?: boolean }[];
  /** Asset ids to light up (their footprint boxes turn orange). */
  assets?: string[];
  /** Opening or vertical-connector ids to mark as closed. */
  closed?: string[];
  /** Spaces hit by a fire, leak or power cut, with how strongly right now (0–1): tinted red, blue or yellow. */
  hazards?: { spaceId: string; kind: 'fire' | 'water' | 'electrical'; level: number }[];
  /** Frame the whole focused floor(s) instead of the highlights and routes (emergency views). */
  frameAll?: boolean;
  /** Spaces the camera frames (with context around them), when the highlights are not the right ones. */
  frameSpaces?: string[];
  /** Evacuation drill: people per room and their way out; they move with `minute` at `walkMPerMin`. */
  evacuees?: { id: string; path: FloorPoint[]; startMin: number; outMin?: number; count: number; cutOff?: boolean }[];
  minute?: number;
  walkMPerMin?: number;
}
