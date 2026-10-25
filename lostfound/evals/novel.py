"""Novel-kind probes: question kinds the labelled sets never ask, with answers computed by the verified library.

A proxy for hidden Sunday/jury questions (water damage spreading, smallest rooms, exits, closures, ...). Answers use
the score.py types (number or space); space answers are kept only with a clear margin over the runner-up, like the
organisers' generator. Writes evals/data/novel_dev.jsonl:

  uv run python -m lostfound.evals.novel --split dev --per-kind 3
  uv run --env-file .env python -m lostfound.evals.run --variant V4 --model opus --effort low --set novel-dev"""

import argparse
import json
import random
from collections import Counter
from pathlib import Path

from lostfound.core import geometry, reach
from lostfound.core.building import ROOMISH_TYPES, Building, MapError
from lostfound.evals.datasets import DATA, GENERATED, NUMBER_SUFFIX, ROOM_SUFFIX

SEED = 11
GAIN_M = 1.0


def _number(value: float, relative: float = 0.02, absolute: float = 0.0) -> dict:
    return {"type": "number", "value": round(value, 2), "relative_tolerance": relative, "absolute_tolerance": absolute}


def _labels(b: Building, space_id: str) -> list[str]:
    space = b.spaces[space_id]
    return [label for label in (space.get("ref"), space["name"]) if label]


def _space(b: Building, winner: str, others: list[str]) -> dict:
    reject = [label for other in others for label in _labels(b, other) if label not in _labels(b, winner)]
    return {"type": "space", "space_id": winner, "accept": _labels(b, winner), "reject": reject}


def _type_name(room_type: str) -> str:
    return room_type.replace("_", " ")


def _floor_name(b: Building, floor_id: str) -> str:
    return b.floors[floor_id]["name"].lower().replace("floor ", "the floor ").replace("ground", "the ground").replace(
        "basement", "the basement"
    )


def _rooms(b: Building, floor_id: str) -> list[dict]:
    return [space for space in b.spaces_by_floor[floor_id] if space["type"] in ROOMISH_TYPES]


def _clear(values: list[tuple[float, str]], margin: float, relative: bool = False) -> bool:
    """values sorted best first: the winner beats the runner-up by margin (absolute or share of the winner)."""
    if len(values) < 2:
        return False
    gap = abs(values[0][0] - values[1][0])
    return gap >= (margin * abs(values[0][0]) if relative else margin)


# ---------- generators: each yields (kind, question, answer) for one building ----------


def smallest_room(b: Building, rng: random.Random):
    for floor_id in b.floors:
        by_type = Counter(space["room_type"] for space in _rooms(b, floor_id))
        for room_type, count in by_type.items():
            if count < 3:
                continue
            areas = sorted((geometry.area(b, s["id"]), s["id"]) for s in _rooms(b, floor_id) if s["room_type"] == room_type)
            if _clear(areas, 0.15, relative=True):
                q = (f"We need a small quiet spot. Which is the smallest {_type_name(room_type)} on {_floor_name(b, floor_id)}, "
                     f"and how big is it?{ROOM_SUFFIX}")
                yield q, _space(b, areas[0][1], [a[1] for a in areas[1:4]])


def room_count(b: Building, rng: random.Random):
    for floor_id in b.floors:
        for room_type, count in Counter(s["room_type"] for s in _rooms(b, floor_id)).items():
            if count >= 2:
                q = f"How many {_type_name(room_type)}s are there on {_floor_name(b, floor_id)}?{NUMBER_SUFFIX}"
                yield q, _number(count, 0.0)


def average_area(b: Building, rng: random.Random):
    for floor_id in b.floors:
        by_type = Counter(s["room_type"] for s in _rooms(b, floor_id))
        for room_type, count in by_type.items():
            if count >= 3:
                areas = [geometry.area(b, s["id"]) for s in _rooms(b, floor_id) if s["room_type"] == room_type]
                q = (f"What is the average floor area of a {_type_name(room_type)} on {_floor_name(b, floor_id)}, "
                     f"in square metres?{NUMBER_SUFFIX}")
                yield q, _number(sum(areas) / len(areas))


def building_area_total(b: Building, rng: random.Random):
    for room_type, count in Counter(s["room_type"] for s in b.spaces.values() if s["type"] in ROOMISH_TYPES).items():
        floors = {s["floor_id"] for s in b.spaces.values() if s["room_type"] == room_type and s["type"] in ROOMISH_TYPES}
        if count >= 3 and len(floors) >= 2:
            total = sum(geometry.area(b, s["id"]) for s in b.spaces.values() if s["room_type"] == room_type and s["type"] in ROOMISH_TYPES)
            q = (f"For the cleaning contract: what is the combined floor area of all {_type_name(room_type)}s in the whole "
                 f"building, across every floor, in m²?{NUMBER_SUFFIX}")
            yield q, _number(total)


def _stack_ok(b: Building, space_id: str, direction: str) -> str | None:
    try:
        other, share = geometry.stacked(b, space_id, direction)
    except MapError:
        return None
    return other if share >= 0.6 else None


def water_two_floors_down(b: Building, rng: random.Random):
    for space in b.spaces.values():
        if space["type"] not in ROOMISH_TYPES:
            continue
        below = _stack_ok(b, space["id"], "below")
        below2 = below and _stack_ok(b, below, "below")
        if below2:
            q = (f"A pipe burst in {b.label(space['id'])} and the water went through two ceilings. Which room two floors "
                 f"below it is affected (on each floor, the space whose outline covers most of the one above)?{ROOM_SUFFIX}")
            yield q, _space(b, below2, [below])


def water_below_count(b: Building, rng: random.Random):
    for space in b.spaces.values():
        if space["type"] not in ROOMISH_TYPES:
            continue
        try:
            floor = b.floor_by_level(b.space_level(space["id"]) - 1)
        except MapError:
            continue
        outline = b.polygon(space["id"])
        hit = [o for o in b.spaces_by_floor[floor["id"]] if b.polygon(o["id"]).intersection(outline).area >= 1.0]
        if len(hit) >= 2:
            q = (f"Water is leaking through the whole floor of {b.label(space['id'])}. How many spaces on the floor below "
                 f"(rooms, corridors, anything) lie under it by at least 1 m² of overlapping outline and may get water "
                 f"damage?{NUMBER_SUFFIX}")
            yield q, _number(len(hit), 0.0)


def area_above(b: Building, rng: random.Random):
    for space in b.spaces.values():
        above = space["type"] in ROOMISH_TYPES and _stack_ok(b, space["id"], "above")
        if above:
            q = (f"There is a water stain on the ceiling of {b.label(space['id'])}. How large, in m², is the room "
                 f"directly above it, which we need to inspect?{NUMBER_SUFFIX}")
            yield q, _number(geometry.area(b, above))


def exit_distance(b: Building, rng: random.Random):
    distances = reach.exit_distances(b)
    for space in b.spaces.values():
        if space["type"] in ROOMISH_TYPES and space["id"] in distances and distances[space["id"]] > 5:
            q = (f"I'm in {b.label(space['id'])} and want to leave. How many metres is my walk out of the building, to the "
                 f"nearest exit?{NUMBER_SUFFIX}")
            yield q, _number(distances[space["id"]], 0.01)


def farthest_from_exit(b: Building, rng: random.Random):
    distances = reach.exit_distances(b)
    for floor_id in b.floors:
        ranked = sorted(((distances[s["id"]], s["id"]) for s in _rooms(b, floor_id) if s["id"] in distances), reverse=True)
        if len(ranked) >= 3 and _clear(ranked, 5.0):
            q = (f"For the evacuation plan: which room on {_floor_name(b, floor_id)} has the longest walk to its "
                 f"nearest building exit?{ROOM_SUFFIX}")
            yield q, _space(b, ranked[0][1], [r[1] for r in ranked[1:4]])


def longest_shared_wall(b: Building, rng: random.Random):
    for space in b.spaces.values():
        if space["type"] not in ROOMISH_TYPES:
            continue
        walls = sorted(((length, other) for other, length in geometry.shared_walls(b, space["id"])), reverse=True)
        if len(walls) >= 2 and _clear(walls, 1.5):
            q = (f"Mould is spreading through the walls of {b.label(space['id'])}. Which neighbouring room on that floor "
                 f"shares the longest stretch of wall with it?{ROOM_SUFFIX}")
            yield q, _space(b, walls[0][1], [w[1] for w in walls[1:4]])


def nearest_of_type(b: Building, rng: random.Random):
    for space in b.spaces.values():
        if space["type"] not in ROOMISH_TYPES:
            continue
        distances = b.distances_from(space["id"])
        for room_type in {s["room_type"] for s in b.spaces.values()} - {space["room_type"]}:
            ranked = sorted((distances[s["id"]], s["id"]) for s in b.spaces.values()
                            if s["room_type"] == room_type and s["type"] in ROOMISH_TYPES and s["id"] in distances)
            if len(ranked) >= 2 and _clear(ranked, 8.0):
                q = (f"I'm in {b.label(space['id'])}. Which {_type_name(room_type)} is the shortest walk away from me, "
                     f"on any floor?{ROOM_SUFFIX}")
                yield q, _space(b, ranked[0][1], [r[1] for r in ranked[1:4]])


def closed_door_count(b: Building, rng: random.Random):
    before = reach.exit_distances(b)
    for opening in b.openings.values():
        if opening["kind"] != "door" or any(s not in b.spaces for s in opening["space_ids"]):
            continue
        with b.temporarily_closed(opening["id"]):
            after = reach.exit_distances(b)
        floor_id = opening["floor_id"]
        worse = [s for s in _rooms(b, floor_id)
                 if s["id"] in before and after.get(s["id"], float("inf")) - before[s["id"]] > GAIN_M]
        if len(worse) >= 2:
            first, second = (b.label(s) for s in opening["space_ids"])
            q = (f"The door between {first} and {second} is locked for renovation. How many rooms on that floor now "
                 f"have a longer walk to their nearest building exit, by more than 1 m (or none at all)?{NUMBER_SUFFIX}")
            yield q, _number(len(worse), 0.0)


def room_perimeter(b: Building, rng: random.Random):
    for space in b.spaces.values():
        if space["type"] in ROOMISH_TYPES:
            q = (f"We're putting skirting boards around {b.label(space['id'])}. What is the length of its outline "
                 f"(the polygon perimeter) in metres?{NUMBER_SUFFIX}")
            yield q, _number(b.polygon(space["id"]).exterior.length)


def floor_with_most(b: Building, rng: random.Random):
    for room_type in {s["room_type"] for s in b.spaces.values() if s["type"] in ROOMISH_TYPES}:
        counts = sorted(((sum(1 for s in _rooms(b, f) if s["room_type"] == room_type), b.level(f)) for f in b.floors), reverse=True)
        if len(counts) >= 2 and counts[0][0] - counts[1][0] >= 2:
            q = (f"Which floor has the most {_type_name(room_type)}s? Give its level number (0 is the ground floor, "
                 f"1 the first upper floor, -1 the first basement).{NUMBER_SUFFIX}")
            yield q, _number(counts[0][1], 0.0)


KINDS = {fn.__name__: fn for fn in (
    smallest_room, room_count, average_area, building_area_total, water_two_floors_down, water_below_count,
    area_above, exit_distance, farthest_from_exit, longest_shared_wall, nearest_of_type, closed_door_count,
    room_perimeter, floor_with_most,
)}
# Stacking only means something where the floors share one XY frame (procedural and OSM, see README).
STACKED_KINDS = {"water_two_floors_down", "water_below_count", "area_above"}


def generate(split: str, per_kind: int) -> list[dict]:
    rng = random.Random(SEED)
    directories = sorted(path.parent for path in (DATA / split).glob("*/building.json"))
    items = []
    for kind, generator in KINDS.items():
        candidates = directories[:]
        if kind in STACKED_KINDS:
            candidates = [d for d in candidates if d.name.startswith(("proc-", "osm-"))]
        rng.shuffle(candidates)
        found = 0
        for directory in candidates:
            if found >= per_kind:
                break
            b = Building.load(directory / "building.json")
            options = list(generator(b, rng))
            if not options:
                continue
            question, answer = rng.choice(options)
            found += 1
            items.append({"id": f"{directory.name}-N-{kind}-{found}", "kind": kind, "set": f"novel-{split}",
                          "building_dir": str(directory), "question": question, "answer": answer, "inputs": None})
    return items


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--split", default="dev")
    parser.add_argument("--per-kind", type=int, default=3)
    args = parser.parse_args()
    items = generate(args.split, args.per_kind)
    GENERATED.mkdir(parents=True, exist_ok=True)
    path = GENERATED / f"novel_{args.split}.jsonl"
    path.write_text("".join(json.dumps(item, ensure_ascii=False) + "\n" for item in items), encoding="utf-8")
    print(f"{len(items)} probes -> {path}", dict(Counter(item["kind"] for item in items)))


if __name__ == "__main__":
    main()
