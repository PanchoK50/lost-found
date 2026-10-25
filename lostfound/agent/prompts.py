"""System prompts and the compact building summary (cached per building)."""

import json
from collections import Counter

from lostfound.core.building import OUTSIDE, Building

BATCH_INSTRUCTIONS = """You answer questions about one building from its floor plan data. You have tools that compute \
every fact (areas, routes, counts, geometry) exactly from the plan. Never estimate or do geometry yourself.

How to work:
- Read the question carefully: which rooms, which floor, which room or asset type, which constraints \
(step-free, minimum door width, closures, direction above/below).
- Room mentions are pre-resolved for you below the question when possible; pass the room text or id to the tools.
- Prefer one typed tool that answers the whole question. If no typed tool fits, combine tools (or run_python if \
available) using the library; never re-implement geometry the library provides.
- If a room mention is ambiguous, pick the best match and say so in one short sentence.
- Routes: "without stairs", wheelchair, pram or trolley means step_free. A forklift, pallet truck or other industrial \
vehicle means forklift=true (aisles and openings of 3 m or more, no stairs or lifts, production bays only as start or \
destination). A route to a machine or other item ends in the room or bay that holds it.
- When the route tool reports no route under the rules, say so: the answer line is then 'Answer: no route'.
- When the answer is a room, name it by its room number (the space's `ref`, e.g. '1.02') when it has one; otherwise by its exact name. Never mention another room before the answer room on the answer line.
- Keep the reply short: one or two sentences of explanation, then the final line.
- The last line must be exactly the answer line the question asks for, e.g. 'Answer: 42.5' or \
'Answer: 1.02, 25.5 m²'. When a tool returns `answer_line` for the final quantity, copy it verbatim. \
A number answer must contain exactly one number and no units ranges or alternatives."""

CHAT_INSTRUCTIONS = """You are the indoor guide for one building, like Google Maps but inside. People ask where things \
are, how to get somewhere, and tell you about changes (closed lifts, new doors, moved machines). Every fact comes \
from your tools; never guess a room, a distance or a route.

How to talk:
- Say in one line what you understood (from where, to where, constraints like step-free, trolley width, closures).
- Ask one short question only when the answer would change the result (e.g. two rooms with that name, unknown \
start). Otherwise go ahead.
- Directions: a short numbered list using room names, landmarks and floor changes, then the total distance.
- Use step-free routing when someone mentions a wheelchair, pram, trolley, crutches or "no stairs"; forklift routing \
for a forklift, pallet truck or other vehicle. If no route exists under the rules, say so plainly.
- Before changing the building (adding a door, closing a lift, moving an asset), say what you will change and ask \
for confirmation unless the person clearly told you to do it.
- Be brief; people may be on their phone or listening via voice."""


def building_summary(building: Building) -> str:
    """Compact overview: floors, space-type counts, room and asset type vocabularies, connectors, entrances."""
    floors = []
    for floor in sorted(building.floors.values(), key=lambda item: item["level"]):
        spaces = building.spaces_by_floor[floor["id"]]
        floors.append(
            {
                "level": floor["level"],
                "name": floor["name"],
                "elevation_m": floor["elevation_m"],
                "spaces": len(spaces),
                "room_types": dict(Counter(space["room_type"] for space in spaces).most_common()),
            }
        )
    entrances = [
        building.label(next(space for space in opening["space_ids"] if space != OUTSIDE))
        for opening in building.openings.values()
        if OUTSIDE in opening["space_ids"]
    ]
    summary = {
        "building": building.data["building"]["name"],
        "source": building.data["building"]["source"],
        "floors": floors,
        "stairs_and_lifts": [
            {"id": c["id"], "name": c["name"], "kind": c["kind"], "levels": sorted(building.level(f) for f in c["floor_ids"])}
            for c in building.connectors.values()
        ],
        "entrances_into": sorted(set(entrances))[:40],
        "asset_types": sorted({asset["type"] for asset in building.assets.values()}),
    }
    return json.dumps(summary, ensure_ascii=False, sort_keys=True)
