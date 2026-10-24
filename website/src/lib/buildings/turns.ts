import type { Point } from './types';
import type { Building } from './types';
import type { RouteStep } from '@/lib/chat/contract';
import type { WalkSegment } from './walk';

/**
 * Turn a walk (see walk.ts) into Google-Maps-style maneuvers: "Turn right into Corridor N0350", distances
 * between maneuvers, stair and lift rides, and which side the destination door is on.
 *
 * A turn is the change of heading at a door: the direction you walk as you reach it versus the direction
 * you walk after it. Long walks inside one space also get a step at sharp corners.
 */
export function turnByTurn(building: Building, segments: WalkSegment[], spacePath: string[], options: { endsAt?: 'destination' | 'stop' } = {}): RouteStep[] {
  const goal = options.endsAt === 'stop' ? 'Your stop' : 'The destination';
  const spaces = new Map(building.spaces.map(s => [s.id, s]));
  const floors = new Map(building.floors.map(f => [f.id, f]));
  const connectors = new Map(building.vertical_connectors.map(c => [c.id, c]));
  const name = (id: string) => spaces.get(id)?.name ?? 'outside';
  const destination = spacePath.at(-1)!;
  const steps: RouteStep[] = [];
  let heading: Point | undefined; // last walking direction, unknown after a ride or outside
  let pendingDoor: { spaceId: string; at: { floorId: string; position: Point }; into: string; first: boolean } | undefined;
  let sinceCorner = 0;

  const add = (step: Omit<RouteStep, 'distance'>) => { steps.push({ ...step, distance: 0 }); sinceCorner = 0; };
  const walked = (m: number) => { if (steps.length) steps[steps.length - 1].distance += m; sinceCorner += m; };

  segments.forEach((seg, i) => {
    if (seg.kind === 'ride') {
      const c = connectors.get(seg.via!);
      const prevFloor = segments.slice(0, i).reverse().find(s => s.floorId !== seg.floorId || s.kind !== 'ride')?.floorId;
      const from = floors.get(prevFloor ?? seg.floorId), to = floors.get(seg.floorId)!;
      const up = !from || to.level > from.level;
      const last = steps.at(-1);
      // Consecutive rides on the same connector are one step ("Take Stairs 1 up to Floor 5").
      if (last && last.action.startsWith(c?.kind === 'lift' ? 'lift' : 'stairs') && last.text.startsWith(`Take ${c?.name}`)) {
        last.floors = (last.floors ?? 1) + 1;
        last.text = `Take ${c?.name} ${up ? 'up' : 'down'} to ${to.name}`;
      } else {
        // The maneuver happens where you board: the stair/lift point on the floor you leave.
        const board = segments[i - 1];
        const at = board?.points.length ? { floorId: board.floorId, position: board.points.at(-1)! } : { floorId: seg.floorId, position: centre(spaces.get(seg.spaceId)?.polygon) };
        add({ action: `${c?.kind === 'lift' ? 'lift' : 'stairs'}-${up ? 'up' : 'down'}`, text: `Take ${c?.name ?? 'the stairs'} ${up ? 'up' : 'down'} to ${to.name}`, floors: Math.abs(to.level - (from?.level ?? to.level)) || 1, at });
      }
      heading = undefined;
      return;
    }
    if (seg.kind === 'door') {
      const entering = seg.spaceId;
      const leavingOutside = spacePath[spacePath.indexOf(entering) - 1] === 'outside' || segments[i - 1]?.spaceId === 'outside';
      if (entering === 'outside') { add({ action: 'outside', text: 'Go outside through the entrance', at: { floorId: seg.floorId, position: seg.points[0] } }); heading = undefined; return; }
      if (leavingOutside) { add({ action: 'inside', text: `Come back in through the entrance into ${name(entering)}`, at: { floorId: seg.floorId, position: seg.points.at(-1)! } }); heading = undefined; walked(seg.length); return; }
      // Decide the turn once we know the direction walked after the door.
      pendingDoor = { spaceId: entering, at: { floorId: seg.floorId, position: seg.points[0] }, into: entering, first: steps.length === 0 };
      walked(seg.length);
      return;
    }
    // A walk inside one space: a polyline of straight pieces.
    const pts = seg.points;
    for (let k = 0; k + 1 < pts.length; k++) {
      const d = direction(pts[k], pts[k + 1]);
      const piece = dist(pts[k], pts[k + 1]);
      if (!d) continue;
      if (pendingDoor) {
        const space = spaces.get(pendingDoor.into);
        const turn = heading ? classify(heading, d) : 'straight';
        const isDestination = pendingDoor.into === destination;
        const isWayfinding = space && (space.type === 'corridor' || space.type === 'hall' || space.type === 'stair' || space.type === 'lift');
        if (isDestination) {
          const side = heading ? sideOf(heading, d) : 'ahead';
          add({ action: turn, text: `${turnPhrase(turn)} into ${name(pendingDoor.into)}`, note: side === 'ahead' ? `${goal} is straight ahead.` : `${goal} is the door on your ${side}.`, at: pendingDoor.at });
        } else if (steps.length === 0 || !heading) {
          const from = segments.slice(0, i).reverse().find(s => s.kind === 'walk')?.spaceId;
          add({ action: turn, text: steps.length === 0 && from ? `Leave ${name(from)} ${turn === 'straight' ? 'into' : `and ${turnPhrase(turn).toLowerCase()} into`} ${name(pendingDoor.into)}` : `Head into ${name(pendingDoor.into)}`, at: pendingDoor.at });
        } else if (turn !== 'straight' || isWayfinding) {
          add({ action: turn, text: turn === 'straight' ? `Continue straight into ${name(pendingDoor.into)}` : `${turnPhrase(turn)} into ${name(pendingDoor.into)}`, at: pendingDoor.at });
        }
        pendingDoor = undefined;
      } else if (heading && sinceCorner >= 3 && piece >= 3) {
        // A real corner inside a long corridor or hall.
        const turn = classify(heading, d);
        if (turn === 'left' || turn === 'right' || turn.startsWith('sharp')) add({ action: turn, text: `${turnPhrase(turn)} in ${name(seg.spaceId)}`, at: { floorId: seg.floorId, position: pts[k] } });
      }
      heading = d;
      walked(piece);
    }
  });
  if (pendingDoor) add({ action: 'straight', text: `Go into ${name(pendingDoor.into)}`, note: pendingDoor.into === destination ? `${goal} is here.` : undefined, at: pendingDoor.at });
  return steps;
}

function direction(a: Point, b: Point): Point | undefined {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
  return l < 0.05 ? undefined : [dx / l, dy / l];
}

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Signed angle from heading a to heading b in degrees; positive is a left turn (building Y points up). */
function angle(a: Point, b: Point) {
  return (Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]) * 180) / Math.PI;
}

function classify(a: Point, b: Point): RouteStep['action'] {
  const t = angle(a, b), m = Math.abs(t), side = t > 0 ? 'left' : 'right';
  if (m < 25) return 'straight';
  if (m < 60) return `slight-${side}`;
  if (m < 135) return side;
  if (m < 165) return `sharp-${side}`;
  return 'u-turn';
}

function sideOf(a: Point, b: Point): 'left' | 'right' | 'ahead' {
  const t = angle(a, b);
  return Math.abs(t) < 25 ? 'ahead' : t > 0 ? 'left' : 'right';
}

function turnPhrase(action: RouteStep['action']) {
  return ({
    straight: 'Go straight', 'slight-left': 'Bear left', left: 'Turn left', 'sharp-left': 'Turn sharp left',
    'slight-right': 'Bear right', right: 'Turn right', 'sharp-right': 'Turn sharp right', 'u-turn': 'Turn around',
  } as Record<string, string>)[action] ?? 'Go';
}

function centre(polygon?: Point[]): Point {
  if (!polygon?.length) return [0, 0];
  return [polygon.reduce((s, p) => s + p[0], 0) / polygon.length, polygon.reduce((s, p) => s + p[1], 0) / polygon.length];
}
