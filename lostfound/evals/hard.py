"""Hard probes: questions that need reasoning on top of the tools (a crate's measurements, the widest load, a door
widened, smoke in a staircase, water falling through several floors, a shaft drilled through the building, the best
meeting room, the best tour order, a room's air volume, two closures at once).

Every answer is computed here independently of lostfound.core: from the raw building.json with shapely and from the
kit's own route model (starter_agent.building_map, the model the judges grade with). A probe is kept only when its
twist changes the answer (the crate's narrower side matters, the smoke makes the walk longer, the best tour order
beats the order given, ...) and when its winner beats the runner-up clearly. Writes evals/data/hard_<split>.jsonl:

  uv run python -m lostfound.evals.hard --split dev --per-kind 3
  uv run --env-file .env python -m lostfound.evals.run --variant V4 --model opus --effort low --set hard-dev"""

import argparse
import itertools
import json
import random
from collections import Counter
from pathlib import Path

import networkx as nx
from shapely.geometry import Polygon

from lostfound.evals.datasets import DATA, GENERATED, NUMBER_SUFFIX, ROOM_SUFFIX
from starter_agent.building_map import DOOR_PREFIX, OUTSIDE, BuildingMap

SEED = 7
ROUTE_SUFFIX = " If there is no such route, finish with a line 'Answer: no route'; otherwise finish with a line 'Answer: <number>'."
ROOM = "room"  # what the kit counts as a room in reach counts (halls, corridors, stairs, lifts are not rooms)


class Plan:
    """The raw plan plus the kit's route model; nothing from lostfound.core."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.data = json.loads((directory / "building.json").read_text(encoding="utf-8"))
        self.kit = BuildingMap(self.data)
        self.floors = {f["id"]: f for f in self.data["floors"]}
        self.spaces = {s["id"]: s for s in self.data["spaces"]}
        self.openings = {o["id"]: o for o in self.data["openings"]}
        self.connectors = {c["id"]: c for c in self.data["vertical_connectors"]}
        self.polygons = {sid: Polygon(s["polygon"]) for sid, s in self.spaces.items()}
        for sid, polygon in self.polygons.items():
            if not polygon.is_valid:
                self.polygons[sid] = polygon.buffer(0)
        names = Counter((s["name"], s["floor_id"]) for s in self.spaces.values())
        self.unique = {sid for sid, s in self.spaces.items() if names[s["name"], s["floor_id"]] == 1 and s["name"]}
        connector_names = Counter(c.get("name") for c in self.connectors.values())
        self.named_connectors = [c for c in self.connectors.values() if c.get("name") and connector_names[c["name"]] == 1]
        self._graphs: dict[tuple, nx.MultiGraph] = {}

    def level(self, space_id: str) -> int:
        return self.floors[self.spaces[space_id]["floor_id"]]["level"]

    def label(self, space_id: str) -> str:
        space = self.spaces[space_id]
        return f"{space['name']} ({self.floors[space['floor_id']]['name']})"

    def floor_phrase(self, floor_id: str) -> str:
        return self.floors[floor_id]["name"]

    def rooms(self, floor_id: str | None = None) -> list[str]:
        return sorted(sid for sid, s in self.spaces.items() if s["type"] == ROOM and (floor_id is None or s["floor_id"] == floor_id))

    def labels(self, space_id: str) -> list[str]:
        space = self.spaces[space_id]
        return [label for label in (space.get("ref"), space["name"]) if label]

    def graph(self, step_free: bool = False, min_width: float | None = None, closed: tuple[str, ...] = (),
              widened: dict[str, float] | None = None) -> nx.MultiGraph:
        """The kit's graph under these rules (cached: callers must not change it)."""
        key = (step_free, min_width, tuple(sorted(closed)), tuple(sorted((widened or {}).items())))
        if key not in self._graphs:
            self._graphs[key] = self._build(step_free, min_width, closed, widened)
        return self._graphs[key]

    def _build(self, step_free: bool, min_width: float | None, closed: tuple[str, ...], widened: dict[str, float] | None) -> nx.MultiGraph:
        self.kit.closed = set(closed)
        try:
            graph = self.kit.graph(step_free)
        finally:
            self.kit.closed = set()
        if min_width is not None:
            widths = {oid: (widened or {}).get(oid, o["width_m"]) for oid, o in self.openings.items()}
            graph.remove_nodes_from([DOOR_PREFIX + oid for oid, width in widths.items() if width + 1e-9 < min_width and DOOR_PREFIX + oid in graph])
        return graph

    def entrances(self) -> list[str]:
        return [DOOR_PREFIX + oid for oid, o in self.openings.items() if OUTSIDE in o["space_ids"]]

    def exit_distance(self, graph: nx.MultiGraph, space_id: str) -> float | None:
        sources = [node for node in self.entrances() if node in graph]
        if not sources or space_id not in graph:
            return None
        return nx.multi_source_dijkstra_path_length(graph, sources, weight="weight").get(space_id)


def _number(value: float, relative: float = 0.01, absolute: float = 0.0) -> dict:
    return {"type": "number", "value": round(value, 3), "relative_tolerance": relative, "absolute_tolerance": absolute}


def _space(plan: Plan, winner: str, others: list[str]) -> dict:
    reject = [label for other in others for label in plan.labels(other) if label not in plan.labels(winner)]
    return {"type": "space", "space_id": winner, "accept": plan.labels(winner), "reject": reject}


def _length(graph: nx.MultiGraph, a: str, b: str) -> float | None:
    try:
        return nx.dijkstra_path_length(graph, a, b, weight="weight")
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        return None


def _entry_spaces(plan: Plan) -> list[str]:
    """Spaces an entrance leads into, named uniquely."""
    found = []
    for opening in plan.openings.values():
        if OUTSIDE in opening["space_ids"]:
            found += [s for s in opening["space_ids"] if s != OUTSIDE and s in plan.unique]
    return sorted(set(found))


# ---------- generators: each yields (question, answer, inputs) for one building; inputs are the ids behind it ----------


def crate_route(plan: Plan, rng: random.Random):
    """A crate that stays upright but can be turned fits through a door at least as wide as its narrower side."""
    rooms = [r for r in plan.rooms() if r in plan.unique]
    door_widths = sorted({o["width_m"] for o in plan.openings.values()})
    if len(rooms) < 2 or len(door_widths) < 2:
        return
    for _ in range(200):
        a, b = rng.sample(rooms, 2)
        width = round(rng.choice(door_widths[:-1]) + 0.05, 2)  # just too wide for some of the doors
        length_m, height = round(width + rng.choice([0.4, 0.6, 0.8]), 2), rng.choice([0.9, 1.1, 1.3])
        plain = _length(plan.graph(step_free=True), a, b)
        constrained = _length(plan.graph(step_free=True, min_width=width), a, b)
        if plain is None or constrained is None or constrained - plain < 2.0:
            continue
        q = (f"We're moving a crate on a pallet trolley from {plan.label(a)} to {plan.label(b)}. The crate is {length_m} m long, "
             f"{width} m wide and {height} m high; it must stay upright, but we can turn it. The trolley can't go on stairs or "
             f"steps (lifts are fine). How long is the shortest route on which the crate fits through every door?{ROUTE_SUFFIX}")
        yield q, _number(constrained), {"start": a, "destination": b, "min_width": width, "step_free": True}


def crate_tipped(plan: Plan, rng: random.Random):
    """A table top lying flat needs a door as wide as its width; stood on its long edge, only as wide as its thickness.
    Lying flat it would not get there at all."""
    rooms = [r for r in plan.rooms() if r in plan.unique]
    for _ in range(200):
        if len(rooms) < 2:
            return
        a, b = rng.sample(rooms, 2)
        thickness = rng.choice([0.7, 0.75, 0.8])
        width = rng.choice([1.2, 1.3])
        on_edge = _length(plan.graph(step_free=True, min_width=thickness), a, b)
        flat = _length(plan.graph(step_free=True, min_width=width), a, b)
        if on_edge is None or flat is not None:
            continue
        q = (f"A table top {width + 0.5:.1f} m long, {width} m wide and {thickness} m thick lies flat on a trolley and has to go "
             f"from {plan.label(a)} to {plan.label(b)}. For the move we may stand it up on its long edge (it is then {width} m "
             f"high). The trolley can't go on stairs or steps (lifts are fine). How long is the shortest route on which it "
             f"fits through every door?{ROUTE_SUFFIX}")
        yield q, _number(on_edge), {"start": a, "destination": b, "min_width": thickness, "flat_width": width, "step_free": True}


def crate_no_route(plan: Plan, rng: random.Random):
    """Too wide for some door on every route: the answer is that there is no route."""
    rooms = [r for r in plan.rooms() if r in plan.unique]
    for _ in range(200):
        if len(rooms) < 2:
            return
        a, b = rng.sample(rooms, 2)
        width = rng.choice([1.0, 1.1, 1.2])
        if _length(plan.graph(step_free=True), a, b) is None or _length(plan.graph(step_free=True, min_width=width), a, b) is not None:
            continue
        q = (f"Can a {width + 0.5:.1f} m long and {width} m wide machine base (it can't be tipped) be rolled from {plan.label(a)} to "
             f"{plan.label(b)}, without stairs or steps (lifts are fine)? It must fit through every door. If yes, how far is it?"
             f"{ROUTE_SUFFIX}")
        yield q, {"type": "unreachable"}, {"start": a, "destination": b, "min_width": width, "step_free": True}


def widest_load(plan: Plan, rng: random.Random):
    """The widest load that can be rolled from an entrance space into a room: the best path's narrowest door."""
    widths = sorted({o["width_m"] for o in plan.openings.values()}, reverse=True)
    if len(widths) < 3:
        return
    for start in _entry_spaces(plan):
        for target in rng.sample(plan.rooms(), min(25, len(plan.rooms()))):
            if target not in plan.unique or target == start:
                continue
            best = next((w for w in widths if _length(plan.graph(step_free=True, min_width=w), start, target) is not None), None)
            if best is None or best in (widths[0], widths[-1]):  # neither the widest nor the narrowest door anywhere
                continue
            q = (f"Deliveries arrive in {plan.label(start)}. What is the widest load, in metres, that can be rolled from there into "
                 f"{plan.label(target)} without stairs or steps (lifts are fine), given the door widths on the way?{NUMBER_SUFFIX}")
            yield q, _number(best, 0.0, 0.005), {"start": start, "destination": target}


def door_widened(plan: Plan, rng: random.Random):
    """Widen one door: how many more rooms on a floor can a wide trolley then reach?"""
    pairs = Counter(frozenset(o["space_ids"]) for o in plan.openings.values())
    for start in _entry_spaces(plan):
        for width in (1.0, 1.1):
            base = plan.graph(step_free=True, min_width=width)
            if start not in base:
                continue
            reached = nx.node_connected_component(base, start)
            narrow = sorted(oid for oid, o in plan.openings.items() if o["width_m"] < width and o["step_free"])
            for oid in rng.sample(narrow, min(25, len(narrow))):
                opening = plan.openings[oid]
                ends = opening["space_ids"]
                if (opening["width_m"] >= width or not opening["step_free"] or OUTSIDE in ends or pairs[frozenset(ends)] != 1
                        or any(s not in plan.unique for s in ends)):
                    continue
                after = nx.node_connected_component(plan.graph(step_free=True, min_width=width, widened={oid: 1.2}), start)
                for floor_id in plan.floors:
                    gained = [s for s in after - reached if s in plan.spaces and plan.spaces[s]["floor_id"] == floor_id]
                    rooms = [s for s in gained if plan.spaces[s]["type"] == ROOM]
                    if len(rooms) >= 2 and len(rooms) == len([s for s in gained if plan.spaces[s]["type"] in (ROOM, "hall")]):
                        a, b = ends
                        q = (f"A {width} m wide trolley comes in at {plan.label(start)} and can't take stairs or steps (lifts are "
                             f"fine). If we widen the door between {plan.label(a)} and {plan.label(b)} to 1.2 m, how many more rooms "
                             f"on {plan.floor_phrase(floor_id)} can the trolley reach than today?{NUMBER_SUFFIX}")
                        yield q, _number(len(rooms), 0.0), {"start": start, "door": oid, "min_width": width, "new_width": 1.2, "floor_id": floor_id}


def smoke_exit(plan: Plan, rng: random.Random):
    """A staircase full of smoke: the walk out of the building from a room, without it."""
    base = plan.graph()
    stairs = [c for c in plan.named_connectors if c["kind"] == "stairs"]
    for connector in stairs:
        smoky = plan.graph(closed=(connector["id"],))
        for room in plan.rooms():
            if room not in plan.unique or plan.level(room) == 0:
                continue
            before, after = plan.exit_distance(base, room), plan.exit_distance(smoky, room)
            if before is None or after is None or after - before < 5.0:
                continue
            q = (f"{connector['name']} is full of smoke and can't be used. I'm in {plan.label(room)}. How many metres is my walk "
                 f"out of the building now, to the nearest exit door?{NUMBER_SUFFIX}")
            yield q, _number(after), {"start": room, "closed": [connector["id"]], "closed_name": connector["name"]}


def water_column(plan: Plan, rng: random.Random):
    """Water falls straight down through every floor below: count the spaces under the room's outline on all of them."""
    for room in plan.rooms():
        if room not in plan.unique:
            continue
        below = [f for f in plan.floors.values() if f["level"] < plan.level(room)]
        if len(below) < 2:
            continue
        outline = plan.polygons[room]
        hits, borderline = 0, False
        for floor in below:
            for sid, space in plan.spaces.items():
                if space["floor_id"] != floor["id"]:
                    continue
                overlap = plan.polygons[sid].intersection(outline).area
                borderline |= 0.7 <= overlap <= 1.3
                hits += overlap >= 1.0
        if hits >= 3 and not borderline:
            q = (f"A tank bursts in {plan.label(room)} and the water runs straight down through every floor below it. How many "
                 f"spaces on all the floors below (rooms, corridors, anything) lie under its outline by at least 1 m² and may get "
                 f"water damage?{NUMBER_SUFFIX}")
            yield q, _number(hits, 0.0), {"space_id": room}


def drill_shaft(plan: Plan, rng: random.Random):
    """A vertical shaft through the room's centre point: the spaces on the other floors it passes through."""
    for room in plan.rooms():
        if room not in plan.unique:
            continue
        centre = plan.polygons[room].centroid
        if not plan.polygons[room].contains(centre):
            continue
        hits, close = 0, False
        for sid, space in plan.spaces.items():
            if space["floor_id"] == plan.spaces[room]["floor_id"]:
                continue
            polygon = plan.polygons[sid]
            close |= polygon.exterior.distance(centre) < 0.3
            hits += polygon.contains(centre)
        if hits >= 2 and not close and len(plan.floors) >= 3:
            q = (f"We're drilling a vertical cable shaft through the whole building, from the lowest floor to the top, at the "
                 f"centre point (the floor-plan centroid) of {plan.label(room)}. How many spaces on the other floors does the shaft "
                 f"pass through?{NUMBER_SUFFIX}")
            yield q, _number(hits, 0.0), {"space_id": room}


def meeting_point(plan: Plan, rng: random.Random):
    """Three people meet in the room of a type that minimises the sum of their walks."""
    graph = plan.graph()
    by_type = Counter(plan.spaces[r]["room_type"] for r in plan.rooms())
    for room_type, count in by_type.items():
        if count < 3:
            continue
        candidates = [r for r in plan.rooms() if plan.spaces[r]["room_type"] == room_type]  # every one of them competes
        people = [r for r in plan.rooms() if plan.spaces[r]["room_type"] != room_type and r in plan.unique]
        if len(people) < 3:
            continue
        for _ in range(10):
            trio = rng.sample(people, 3)
            distances = [nx.single_source_dijkstra_path_length(graph, p, weight="weight") for p in trio]
            totals = sorted((sum(d.get(c, float("inf")) for d in distances), c) for c in candidates)
            if totals[0][0] == float("inf") or totals[1][0] - totals[0][0] < 8.0 or totals[0][1] not in plan.unique:
                continue
            names = ", ".join(plan.label(p) for p in trio[:2]) + f" and {plan.label(trio[2])}"
            q = (f"Three colleagues, in {names}, want to meet in one {room_type.replace('_', ' ')}. Which one keeps their total "
                 f"walking distance smallest?{ROOM_SUFFIX}")
            yield q, _space(plan, totals[0][1], [t[1] for t in totals[1:4]]), {"people": trio, "room_type": room_type}


def best_tour(plan: Plan, rng: random.Random):
    """Visit three rooms in any order and come back: the best order beats the order the question lists."""
    graph = plan.graph()
    rooms = [r for r in plan.rooms() if r in plan.unique]
    for _ in range(40):
        if len(rooms) < 4:
            return
        home, *stops = rng.sample(rooms, 4)
        lengths = {}
        for a, b in itertools.permutations([home, *stops], 2):
            lengths[a, b] = _length(graph, a, b)
        if None in lengths.values():
            continue
        tour = lambda order: sum(lengths[a, b] for a, b in itertools.pairwise([home, *order, home]))  # noqa: E731
        best = min(tour(order) for order in itertools.permutations(stops))
        if tour(stops) - best < 0.03 * best + 3.0:
            continue
        q = (f"Starting from {plan.label(home)}, I have to drop off a parcel in {plan.label(stops[0])}, {plan.label(stops[1])} and "
             f"{plan.label(stops[2])}, in whatever order is best, and then come back. What is the shortest total walk in metres?"
             f"{NUMBER_SUFFIX}")
        yield q, _number(best), {"home": home, "stops": stops}


def air_volume(plan: Plan, rng: random.Random):
    """Floor area times the storey height of the room's floor."""
    for room in plan.rooms():
        if room in plan.unique:
            height = plan.floors[plan.spaces[room]["floor_id"]]["height_m"]
            q = (f"For the ventilation design: how many cubic metres of air does {plan.label(room)} hold (its floor area times the "
                 f"storey height of its floor)?{NUMBER_SUFFIX}")
            yield q, _number(plan.polygons[room].area * height, 0.02), {"space_id": room}


def two_closures(plan: Plan, rng: random.Random):
    """A lift out of service and a door locked: each one matters, together they cut off more."""
    lifts = [c for c in plan.named_connectors if c["kind"] == "lift"]
    doors = [o for o in plan.openings.values() if OUTSIDE not in o["space_ids"] and all(s in plan.unique for s in o["space_ids"])
             and Counter(frozenset(x["space_ids"]) for x in plan.openings.values())[frozenset(o["space_ids"])] == 1]
    for start in _entry_spaces(plan):
        reached_cache: dict[tuple[str, ...], set[str]] = {}

        def count(closed: tuple[str, ...], floor_id: str) -> int:
            if closed not in reached_cache:
                graph = plan.graph(step_free=True, closed=closed)
                reached_cache[closed] = nx.node_connected_component(graph, start) if start in graph else set()
            return sum(1 for s in reached_cache[closed] if s in plan.spaces and plan.spaces[s]["floor_id"] == floor_id
                       and plan.spaces[s]["type"] == ROOM)

        for lift in lifts:
            for door in rng.sample(doors, min(30, len(doors))):
                for floor_id in plan.floors:
                    both = count((lift["id"], door["id"]), floor_id)
                    if both < count((lift["id"],), floor_id) and both < count((door["id"],), floor_id) and both > 0:
                        a, b = door["space_ids"]
                        q = (f"{lift['name']} is out of service and the door between {plan.label(a)} and {plan.label(b)} is locked. "
                             f"A wheelchair user comes in through the entrance into {plan.label(start)}. How many rooms on "
                             f"{plan.floor_phrase(floor_id)} can they still reach?{NUMBER_SUFFIX}")
                        yield q, _number(both, 0.0), {"start": start, "closed": [lift["id"], door["id"]], "floor_id": floor_id}


KINDS = {fn.__name__: fn for fn in (
    crate_route, crate_tipped, crate_no_route, widest_load, door_widened, smoke_exit, water_column, drill_shaft,
    meeting_point, best_tour, air_volume, two_closures,
)}
# Stacking only means something where the floors share one XY frame (procedural and OSM, see README).
STACKED_KINDS = {"water_column", "drill_shaft"}


def generate(split: str, per_kind: int) -> list[dict]:
    rng = random.Random(SEED)
    directories = sorted(path.parent for path in (DATA / split).glob("*/building.json"))
    items = []
    for kind, generator in KINDS.items():
        candidates = [d for d in directories if kind not in STACKED_KINDS or d.name.startswith(("proc-", "osm-"))]
        rng.shuffle(candidates)
        found = 0
        for directory in candidates:
            if found >= per_kind:
                break
            plan = Plan(directory)
            options = list(itertools.islice(generator(plan, random.Random(f"{SEED}:{kind}:{directory.name}")), 40))
            if not options:
                continue
            question, answer, inputs = rng.choice(options)
            found += 1
            items.append({"id": f"{directory.name}-X-{kind}-{found}", "kind": kind, "set": f"hard-{split}",
                          "building_dir": str(directory), "question": question, "answer": answer, "inputs": inputs})
    return items


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--split", default="dev")
    parser.add_argument("--per-kind", type=int, default=3)
    args = parser.parse_args()
    items = generate(args.split, args.per_kind)
    GENERATED.mkdir(parents=True, exist_ok=True)
    path = GENERATED / f"hard_{args.split}.jsonl"
    path.write_text("".join(json.dumps(item, ensure_ascii=False) + "\n" for item in items), encoding="utf-8")
    print(f"{len(items)} probes -> {path}", dict(Counter(item["kind"] for item in items)))


if __name__ == "__main__":
    main()
