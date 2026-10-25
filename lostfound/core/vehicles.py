"""Route rules from the organizers' scoring note that the kit's route model does not cover.

- Forklift: forklift aisles and openings only, 3 m or wider; no stairs, steps or lifts; pedestrian walkways don't
  count.
- Factory production bays are destinations: a route may start or end in one (drive in to deliver), but never pass
  through one as a shortcut.

The organizers did not say whether the bay rule also holds for people on foot. "You can drive into one" reads as a
vehicle rule, and every labelled walking route in the kit is consistent either way, so by default it applies to
forklift routes only. Set LOSTFOUND_BAY_RULE=always to apply it to walking routes too (benchmark text answers such
as errand distances keep the kit model either way)."""

import os
import re

FORKLIFT_MIN_WIDTH_M = 3.0

# Hall zones of the procedural factories: the bays that hold machines, stock and goods. Hall access lobbies and the
# main aisles (corridors) are not bays.
BAY_ROOM_TYPES = frozenset({"production_zone", "assembly_zone", "additive_zone", "warehouse_zone", "logistics_zone"})

PEDESTRIAN_ONLY = re.compile(r"pedestrian|walkway|footpath|foot path|sidewalk|gehweg|fussweg|fußweg", re.IGNORECASE)


def is_bay(space: dict) -> bool:
    return space.get("room_type") in BAY_ROOM_TYPES


def is_pedestrian_only(space: dict) -> bool:
    """A space marked as a pedestrian walkway by its name or room type (none in the kit data; guards unseen ones)."""
    return bool(PEDESTRIAN_ONLY.search(f"{space.get('name') or ''} {space.get('room_type') or ''}"))


def bay_rule_applies(forklift: bool) -> bool:
    return forklift or os.environ.get("LOSTFOUND_BAY_RULE", "forklift").strip().lower() == "always"
