import type { Point } from '@/lib/buildings/types';

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
  | 'show' | 'unknown';

export interface ChatRequest {
  buildingId: string;
  message: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
}

export interface ChatResponse {
  kind: QuestionKind;
  /** Full assistant reply, plain text. */
  reply: string;
  /** Headline shown on the answer card, e.g. { title: 'Generic room N5325', value: '79.48 m²' }. */
  answer?: { title: string; value?: string; detail?: string };
  scene: SceneDirective;
}

/** A point on a specific floor, in building metres (Y up). */
export interface FloorPoint { floorId: string; position: Point }

export type SceneFocus =
  /** Whole building, all floors stacked. */
  | { mode: 'building' }
  /** One floor in 2.5D; floors above lift away, floors below are ghosted. */
  | { mode: 'floor'; floorId: string }
  /** Several floors pulled apart so they can be compared (stacked rooms, multi-floor routes). */
  | { mode: 'stack'; floorIds: string[] };

export type Tone = 'primary' | 'secondary' | 'muted';

export interface SceneDirective {
  focus: SceneFocus;
  /**
   * Spaces to colour. `primary`: what the answer names or counts (lime, raised).
   * `secondary`: the reference room the question is about, e.g. the start, entry or target (sage).
   * `muted`: background candidates, e.g. the runners-up for "largest room" (faint tint).
   */
  highlights?: { spaceId: string; tone: Tone; label?: string }[];
  /** Pins for assets or points. `muted` markers draw as small flat warnings (e.g. doors that are too narrow). */
  markers?: (FloorPoint & { label: string; tone?: Tone })[];
  /** Polylines through the building. Consecutive points on different floors draw a vertical hop. */
  routes?: { points: FloorPoint[]; label?: string }[];
  /** Straight 3D lines, e.g. sensor links between room centroids. */
  links?: { from: FloorPoint; to: FloorPoint; label?: string }[];
  /** Opening or vertical-connector ids to mark as closed. */
  closed?: string[];
}
