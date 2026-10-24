"""Build docs/mockup/ux-mockup.html: a clickable visualisation of docs/UX_DESIGN.md.

Geometry, routes and reachability come from a real dataset building via starter_agent/building_map.py.
The agent replies are hand-written mocks in the T20 response shape.

    uv run python docs/mockup/build_mockup.py [building_dir]
"""

import base64
import difflib
import json
import math
import sys
from pathlib import Path

import networkx as nx
from shapely.geometry import Polygon
from shapely.ops import linemerge

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from starter_agent.building_map import OUTSIDE, BuildingMap  # noqa: E402

BUILDING_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data/dev/proc-factory-dev-010"
OUT = Path(__file__).with_name("ux-mockup.html")
TEMPLATE = Path(__file__).with_name("template.html")

bm = BuildingMap.load(BUILDING_DIR)
data = bm.data
levels = {f["id"]: f["level"] for f in data["floors"]}


def floor_short(floor_id: str) -> str:
    level = levels[floor_id]
    return "EG" if level == 0 else f"{level}. OG" if level > 0 else f"{-level}. UG"


def label(space_id: str) -> str:
    space = bm.spaces[space_id]
    return space["name"] if space["ref"] in space["name"] else f"{space['name']} {space['ref']}"


def first(pred):
    return next(s["id"] for s in data["spaces"] if pred(s))


def opening_between(a: str, b: str):
    return next((o for o in data["openings"] if set(o["space_ids"]) == {a, b}), None)


def connector_between(a: str, b: str):
    return next((c for c in data["vertical_connectors"] if a in c["space_ids"] and b in c["space_ids"]), None)


def turn(p0, p1, p2) -> str:
    v1 = (p1[0] - p0[0], p1[1] - p0[1])
    v2 = (p2[0] - p1[0], p2[1] - p1[1])
    cross = v1[0] * v2[1] - v1[1] * v2[0]
    norm = math.hypot(*v1) * math.hypot(*v2) or 1
    s = cross / norm
    return "left" if s > 0.35 else "right" if s < -0.35 else "straight"


def landmark(space_id: str, near):
    assets = [a for a in data["assets"] if a["space_id"] == space_id and a["type"] not in ("chair", "office_chair", "desk", "plant")]
    return min(assets, key=lambda a: math.dist(a["position"], near), default=None)


def route_response(start: str, dest: str, step_free: bool, speed: float):
    r = bm.route(start, dest, step_free=step_free)
    path = r.space_path
    legs, points, steps = [], [list(bm.anchor(path[0]))], []
    floor = bm.spaces[path[0]]["floor_id"]
    floor_changes = []
    lifts = 0
    for a, b in zip(path, path[1:]):
        opening = opening_between(a, b)
        if b == OUTSIDE:
            points.append(opening["position"])
            continue
        if a == OUTSIDE:
            # 'outside' joins entrances on all floors, e.g. a hillside entrance on another level.
            if bm.spaces[b]["floor_id"] != floor:
                legs.append({"floor_id": floor, "points": points})
                floor_changes.append({"floor_id": floor, "at": points[-1], "to_floor": bm.spaces[b]["floor_id"],
                                      "name": "draußen", "kind": "outside"})
                floor, points = bm.spaces[b]["floor_id"], []
            points.append(opening["position"])
            continue
        if opening and bm.spaces[b]["floor_id"] == floor:
            points.append(opening["position"])
            continue
        connector = connector_between(a, b)
        points.append(list(bm.anchor(a)))
        legs.append({"floor_id": floor, "points": points})
        new_floor = bm.spaces[b]["floor_id"]
        floor_changes.append({"floor_id": floor, "at": list(bm.anchor(a)), "to_floor": new_floor,
                              "name": connector["name"], "kind": connector["kind"]})
        lifts += connector["kind"] == "lift"
        floor, points = new_floor, [list(bm.anchor(b))]
    points.append(list(bm.anchor(path[-1])))
    legs.append({"floor_id": floor, "points": points})

    # Followable steps: one per room change, directions from turn angles, landmarks from assets.
    leg_index = 0
    for i, (a, b) in enumerate(zip(path, path[1:])):
        if b == OUTSIDE:
            steps.append({"text": "Kurz **nach draußen** und am nächsten Eingang wieder hinein", "direction": "straight",
                          "floor_id": bm.spaces[a]["floor_id"], "leg_index": leg_index})
            continue
        if a == OUTSIDE:
            leg_index += bm.spaces[path[i - 1]]["floor_id"] != bm.spaces[b]["floor_id"]
            continue
        connector = connector_between(a, b)
        if connector and bm.spaces[a]["floor_id"] != bm.spaces[b]["floor_id"]:
            verb = "Nimm den" if connector["kind"] == "lift" else "Nimm das"
            leg_index += 1
            if steps and steps[-1].get("connector") == connector["id"]:
                steps[-1]["text"] = f"{verb} **{connector['name']}** ins {floor_short(bm.spaces[b]['floor_id'])}"
                continue
            steps.append({"connector": connector["id"], "text": f"{verb} **{connector['name']}** ins {floor_short(bm.spaces[b]['floor_id'])}",
                          "direction": "up" if levels[bm.spaces[b]["floor_id"]] > levels[bm.spaces[a]["floor_id"]] else "down",
                          "floor_id": bm.spaces[a]["floor_id"], "leg_index": leg_index - 1})
            continue
        if bm.spaces[b]["type"] in ("lift", "stair"):
            steps.append({"text": f"Zum **{label(b)}**", "direction": "straight",
                          "floor_id": bm.spaces[b]["floor_id"], "leg_index": leg_index})
            continue
        if b == path[-1]:
            continue
        opening = opening_between(a, b)
        prev_pt = bm.anchor(a)
        door = opening["position"] if opening else bm.anchor(b)
        nxt = bm.anchor(b)
        direction = turn(prev_pt, door, nxt) if i else "straight"
        word = {"left": "Links", "right": "Rechts", "straight": "Geradeaus"}[direction]
        mark = landmark(b, door)
        extra = f", vorbei an **{mark['name']}**" if mark else ""
        steps.append({"text": f"{word} in **{label(b)}**{extra}", "direction": direction,
                      "floor_id": bm.spaces[b]["floor_id"], "leg_index": leg_index,
                      "landmark": mark and {"name": mark["name"], "position": mark["position"], "floor_id": mark["floor_id"]}})
    # At most 6 steps (U6). Floor changes are never dropped, ordinary turns fill the remaining slots.
    if len(steps) > 5:
        keep = {i for i, s in enumerate(steps) if s["direction"] in ("up", "down")}
        keep |= set([i for i in range(len(steps)) if i not in keep][:max(0, 5 - len(keep))])
        steps = [s for i, s in enumerate(steps) if i in keep]
    steps.append({"text": f"Ziel: **{label(dest)}**", "direction": "arrive",
                  "floor_id": bm.spaces[dest]["floor_id"], "leg_index": len(legs) - 1})
    minutes = max(1, round((r.length_m / speed + 30 * lifts) / 60))
    path = [s for s in path if s != OUTSIDE]
    return {"space_path": path, "length_m": r.length_m, "minutes": minutes, "legs": legs,
            "steps": steps, "floor_changes": floor_changes}


def shared_wall_midpoint(a: str, b: str):
    pa, pb = Polygon(bm.spaces[a]["polygon"]), Polygon(bm.spaces[b]["polygon"])
    seg = pa.exterior.intersection(pb.exterior.buffer(0.35))
    if seg.length < 1.0:
        return None
    seg = linemerge(seg) if seg.geom_type == "MultiLineString" else seg
    if seg.geom_type != "LineString":
        seg = max(seg.geoms, key=lambda g: g.length)
    p = seg.interpolate(0.5, normalized=True)
    return [round(p.x, 2), round(p.y, 2)]


# ---------- pick places generically, so any building in the dataset format works ----------
floors_sorted = sorted(data["floors"], key=lambda f: f["level"])
F0, F_TOP = floors_sorted[0]["id"], floors_sorted[-1]["id"]
start = first(lambda s: s["floor_id"] == F0 and s["room_type"] == "lobby") if any(
    s["room_type"] == "lobby" and s["floor_id"] == F0 for s in data["spaces"]) else first(lambda s: s["floor_id"] == F0 and s["type"] in ("room", "hall"))
# Destination: as high up as possible, but reachable step-free from the start.
step_free_reach = nx.node_connected_component(bm.graph(step_free=True), start)
dest_pool = sorted((s for s in data["spaces"] if s["id"] in step_free_reach and s["type"] == "room" and s["id"] != start),
                   key=lambda s: (-levels[s["floor_id"]], s["room_type"] != "meeting_room"))
dest = dest_pool[0]["id"]
F_TOP = bm.spaces[dest]["floor_id"]
toilets = ([s["id"] for s in data["spaces"] if s["room_type"] == "toilet"]
           or [s["id"] for s in data["spaces"] if s["room_type"] in ("bathroom", "kitchen")])[:3]
tech_start = next((s["id"] for s in data["spaces"] if s["room_type"] in ("assembly_zone", "production_zone")), start)
lift = next((c for c in data["vertical_connectors"] if c["kind"] == "lift"), None)
L = lift or {"id": "", "name": "Lift", "space_ids": []}  # placeholder; lift scenarios are dropped below

wheel = route_response(start, dest, step_free=True, speed=0.9)
full_graph = bm.graph(step_free=False)
reach_full = nx.node_connected_component(full_graph, tech_start)
nearest_toilet = min((t for t in toilets if t in reach_full), default=dest,
                     key=lambda t: nx.shortest_path_length(full_graph, tech_start, t, weight="weight"))
voice = route_response(tech_start, nearest_toilet, step_free=False, speed=1.3)

# Closing the lift: what becomes unreachable step-free?
unreachable = []
if lift:
    bm.closed.add(lift["id"])
    reach = nx.node_connected_component(bm.graph(step_free=True), start)
    unreachable = [s["id"] for s in data["spaces"] if s["type"] in ("room", "hall") and s["id"] not in reach]
    bm.closed.clear()
unreach_floors = sorted({bm.spaces[s]["floor_id"] for s in unreachable}, key=levels.get)

refs = {s["ref"]: s["id"] for s in data["spaces"] if s["type"] in ("room", "hall")}
similar = [refs[r] for r in difflib.get_close_matches("9.99", list(refs), n=3, cutoff=0)]

# A door that could be added: two rooms on the top floor with a shared wall and no door yet.
door_pair, door_pos = None, None
rooms_top = [s["id"] for s in data["spaces"] if s["floor_id"] == F_TOP and s["type"] == "room"]
for i, a in enumerate(rooms_top):
    for b in rooms_top[i + 1:]:
        if not opening_between(a, b) and (pos := shared_wall_midpoint(a, b)):
            door_pair, door_pos = (a, b), pos
            break
    if door_pair:
        break


def hl(ids, role):
    return [{"space_id": i, "role": role} for i in ids]


scenarios = [
    {
        "key": "route", "title": "Route stufenlos", "covers": ["U1", "U2", "U3", "U4", "U6", "U7"],
        "memory": [{"icon": "📍", "label": label(start)}, {"icon": "♿", "label": "stufenlos"}],
        "lens": "wheel",
        "messages": [
            {"role": "user", "text": f"Ich sitze im Rollstuhl und bin in {label(start)}."},
            {"role": "agent", "text": "Alles klar. Ich plane ab jetzt nur stufenlose Wege und gehe von hier aus.",
             "understood": {"start": start, "constraints": ["step_free"]}, "memorised": True},
            {"role": "user", "text": f"Wie komme ich zu {label(dest)}?"},
            {"role": "agent", "status": ["🔎 Suche Route …", "♿ Prüfe stufenlose Wege …"],
             "text": f"Ich bringe dich stufenlos {'über den ' + L['name'] + ' ' if lift and any(fc['kind'] == 'lift' for fc in wheel['floor_changes']) else ''}hin, etwa {wheel['minutes']} Minuten.",
             "understood": {"start": start, "destination": dest, "constraints": ["step_free"]},
             "highlights": hl([dest], "target"), "route": wheel},
        ],
    },
    {
        "key": "clarify", "title": "Rückfrage", "covers": ["U2", "U4", "U5"],
        "memory": [],
        "messages": [
            {"role": "user", "text": "Wo ist die Toilette?"},
            {"role": "agent", "status": ["🔎 Suche Toiletten …"],
             "text": f"Hier gibt es {len(toilets)} Toiletten. Wo bist du gerade, oder welche meinst du?",
             "understood": {"destination_kind": "Toilette"},
             "highlights": hl(toilets, "candidate"),
             "clarification": {"question": "Welche Toilette meinst du?",
                               "options": [{"label": label(t), "space_id": t, "floor": floor_short(bm.spaces[t]["floor_id"])} for t in toilets],
                               "locate": True}},
        ],
    },
    {
        "key": "change", "title": "Sperrung mit Vorschau", "covers": ["U3", "U4", "U7", "U8"],
        "memory": [{"icon": "📍", "label": label(start)}, {"icon": "♿", "label": "stufenlos"}],
        "lens": "wheel", "floor": unreach_floors[0] if unreach_floors else F0,
        "messages": [
            {"role": "user", "text": f"Der {L['name']} ist kaputt."},
            {"role": "agent", "status": ["🔒 Prüfe Sperrung …", "♿ Rechne Erreichbarkeit neu …"],
             "text": f"Verstanden. Wenn ich den {L['name']} sperre, kommst du stufenlos nicht mehr in "
                     f"{len(unreachable)} Räume" + (f" im {', '.join(floor_short(f) for f in unreach_floors)}." if unreach_floors else "."),
             "understood": {"change": f"{L['name']} sperren"},
             "highlights": hl(unreachable, "unreachable"),
             "changes": [{"op": "close", "element_id": L["id"], "label": f"{L['name']} sperren", "status": "preview",
                          "space_ids": L["space_ids"],
                          "impact": f"{len(unreachable)} Räume stufenlos unerreichbar. Über die Treppe weiter erreichbar."}]},
        ],
    },
    {
        "key": "door", "title": "Tür hinzufügen", "covers": ["U4", "U8"],
        "memory": [], "floor": F_TOP,
        "messages": [
            {"role": "user", "text": f"Füge eine Tür zwischen {bm.spaces[door_pair[0]]['ref']} und {bm.spaces[door_pair[1]]['ref']} ein."},
            {"role": "agent", "status": ["📐 Suche gemeinsame Wand …"],
             "text": f"Die beiden Räume teilen eine Wand. Ich würde die Tür in die Mitte setzen, 0,9 m breit, stufenlos.",
             "understood": {"change": f"Tür {bm.spaces[door_pair[0]]['ref']} ↔ {bm.spaces[door_pair[1]]['ref']}"},
             "highlights": hl(door_pair, "changed"),
             "changes": [{"op": "add_door", "label": f"Neue Tür {label(door_pair[0])} ↔ {label(door_pair[1])}",
                          "status": "preview", "position": door_pos, "floor_id": F_TOP,
                          "impact": "Der Weg zwischen den Räumen wird kürzer, ohne Umweg über den Flur."}]},
        ] if door_pair else [],
    },
    {
        "key": "error", "title": "Fehler & keine Route", "covers": ["U5", "U9"],
        "memory": [{"icon": "📍", "label": label(start)}, {"icon": "♿", "label": "stufenlos"}, {"icon": "⛔", "label": L["name"]}],
        "lens": "wheel", "floor": F_TOP,
        "messages": [
            {"role": "user", "text": "Bring mich zu Raum 9.99"},
            {"role": "agent", "text": "Raum 9.99 gibt es hier nicht. Meintest du einen von diesen?",
             "highlights": hl(similar, "candidate"),
             "clarification": {"question": "Ähnliche Räume", "options": [
                 {"label": label(s), "space_id": s, "floor": floor_short(bm.spaces[s]["floor_id"])} for s in similar]}},
            {"role": "user", "text": f"Dann zu {label(dest)}."},
            {"role": "agent", "status": ["🔎 Suche Route …"],
             "error": {"title": "Keine stufenlose Route",
                       "reason": f"Der {L['name']} ist gesperrt, und ins {floor_short(F_TOP)} führt sonst nur eine Treppe.",
                       "actions": ["Mit Treppe zeigen", "Sperrung aufheben"]},
             "understood": {"start": start, "destination": dest, "constraints": ["step_free"], "closures": [L["name"]]},
             "highlights": hl([dest], "unreachable"),
             "changes": [{"op": "close", "element_id": L["id"], "status": "applied", "space_ids": L["space_ids"]}]},
        ],
    },
    {
        "key": "voice", "title": "Sprache", "covers": ["U6", "U10"],
        "memory": [{"icon": "📍", "label": label(tech_start)}], "voice": True,
        "messages": [
            {"role": "user", "text": "Wo ist die nächste Toilette?", "spoken": True},
            {"role": "agent", "status": ["🔎 Suche nächste Toilette …"],
             "text": f"Die nächste ist {label(nearest_toilet)}, etwa {voice['minutes']} Minute{'n' if voice['minutes'] > 1 else ''}.",
             "understood": {"start": tech_start, "destination": nearest_toilet},
             "highlights": hl([nearest_toilet], "target"), "route": voice},
        ],
    },
    {"key": "mobile", "title": "Mobil", "covers": ["U11", "U3", "U6"], "mobile": True, "ref": "route"},
    {"key": "import", "title": "Grundriss-Import", "covers": ["U12"], "import": True, "floor": F0},
]

if not lift:
    scenarios = [s for s in scenarios if s["key"] not in ("change", "error")]
    scenarios[0]["covers"] = sorted(set(scenarios[0]["covers"]) | {"U9"})

building = {
    "name": data["building"]["name"],
    "source": data["building"].get("source", ""),
    "attribution": data["building"].get("attribution", ""),
    "floors": [{"id": f["id"], "level": f["level"], "name": f["name"], "short": floor_short(f["id"])} for f in floors_sorted],
    "spaces": [{"id": s["id"], "floor_id": s["floor_id"], "type": s["type"], "room_type": s["room_type"],
                "name": s["name"], "ref": s["ref"], "label": label(s["id"]),
                "polygon": [[round(x, 2), round(y, 2)] for x, y in s["polygon"]],
                "anchor": [round(v, 2) for v in bm.anchor(s["id"])],
                "area": round(Polygon(s["polygon"]).area, 1)} for s in data["spaces"]],
    "openings": [{"floor_id": o["floor_id"], "position": o["position"], "kind": o["kind"], "width_m": o["width_m"]}
                 for o in data["openings"] if o["width_m"] <= 3],
}

plain = BUILDING_DIR / f"floor_{levels[F0]}_plain.png"
import_image = "data:image/png;base64," + base64.b64encode(plain.read_bytes()).decode() if plain.exists() else ""

payload = json.dumps({"building": building, "scenarios": scenarios, "importImage": import_image}, ensure_ascii=False)
OUT.write_text(TEMPLATE.read_text(encoding="utf-8").replace("/*__DATA__*/null", payload), encoding="utf-8")
print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB) for {building['name']}")
