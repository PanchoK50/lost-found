"""Free-text references -> core ids: rooms, assets and floors.

Question texts name places the way people do ("Office 0.29 (Ground floor)",
"the lobby", "Lift 1"), while the core works with ids. This module bridges the
gap: exact id -> asset id -> exact room ref/name -> asset name -> substring
search. Ambiguity is not hidden: it raises ResolveError listing candidates the
model can show to the person (chat) or disambiguate from context (one-shot).
"""

from __future__ import annotations

import re

from core.model import Building

MAX_CANDIDATES = 8

_WORD_LEVELS = {"ground": 0, "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5}
_LEVEL_NUMBER = re.compile(r"^(?:floor|level|storey|story)\s+(-?\d+)$")


class ResolveError(ValueError):
    """Unknown or ambiguous reference; the message lists candidates when there are any."""


def search(building: Building, query: str, floor_level: int | None = None) -> list[dict]:
    """Spaces and assets whose name, ref or type contains every word of the query."""
    words = [word for word in query.lower().replace("_", " ").split() if word]
    if not words:
        return []
    results = []
    for space in building.spaces.values():
        room_type = space.room_type.replace("_", " ")
        text = f"{space.name} {space.ref or ''} {room_type} {space.id}".lower()
        if floor_level is not None and building.level(space.floor_id) != floor_level:
            continue
        if all(word in text for word in words):
            results.append(
                {
                    "kind": "space",
                    "id": space.id,
                    "name": space.name,
                    "room_type": space.room_type,
                    "floor": building.floor_name(space.floor_id),
                }
            )
    for asset in building.assets.values():
        if floor_level is not None and building.level(asset.floor_id) != floor_level:
            continue
        text = f"{asset.name} {asset.type.replace('_', ' ')} {asset.id}".lower()
        if all(word in text for word in words):
            results.append(
                {
                    "kind": "asset",
                    "id": asset.id,
                    "name": asset.name,
                    "in": building.describe_space(asset.space_id),
                }
            )
    return results


def _candidate_message(building: Building, reference: str, results: list[dict]) -> str:
    listed = "; ".join(f"{item['id']} ({item['name']})" for item in results[:MAX_CANDIDATES])
    more = f" (+{len(results) - MAX_CANDIDATES} more)" if len(results) > MAX_CANDIDATES else ""
    return f"'{reference}' is not exact. Candidates: {listed}{more}"


def _split_floor_hint(reference: str) -> tuple[str, int | None]:
    """Split 'Office 0.29 (Ground floor)' into the name and an optional floor level hint."""
    match = re.match(r"^(.*?)\s*\(([^)]*)\)\s*$", reference.strip())
    if not match:
        return reference.strip(), None
    hint = floor_level(match.group(2))
    return match.group(1).strip(), hint


def floor_level(reference: str) -> int | None:
    """Parse a floor reference ('2', 'floor 2', 'Ground floor', 'Basement 2', a floor name)."""
    text = reference.strip().lower()
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        pass
    match = _LEVEL_NUMBER.match(text)
    if match:
        return int(match.group(1))
    if text in ("ground", "ground floor", "groundfloor", "entrance level"):
        return 0
    if text in ("basement", "cellar"):
        return -1
    if text.startswith(("basement ", "cellar ")):
        try:
            return -abs(int(text.split()[1]))
        except ValueError:
            return None
    if text in _WORD_LEVELS:
        return _WORD_LEVELS[text]
    if text.endswith(" floor"):
        word = text[: -len(" floor")].strip()
        if word in _WORD_LEVELS:
            return _WORD_LEVELS[word]
    return None


def resolve_floor(building: Building, reference: str) -> str:
    """A floor reference (id, level, 'floor 2', 'Ground floor', or the floor's name) -> floor id."""
    text = reference.strip()
    lowered = text.lower()
    if text in building.floors:
        return text
    level = floor_level(text)
    if level is not None:
        floor = building.floor_at_level(level)
        if floor is not None:
            return floor.id
    for floor in building.floors.values():
        if floor.name.lower() == lowered:
            return floor.id
    raise ResolveError(
        f"Unknown floor '{reference}'. Floors: "
        + "; ".join(f"{floor.name} (level {floor.level})" for floor in building.floors_sorted())
    )


def resolve_space(building: Building, reference: str, floor_level: int | None = None) -> str:
    """A space reference (space id, asset id, exact room ref/name, asset name) -> space id."""
    reference = reference.strip()
    if reference in building.spaces:
        return reference
    if reference in building.assets:
        return building.assets[reference].space_id
    lowered = reference.lower()
    exact = [
        space.id
        for space in building.spaces.values()
        if (floor_level is None or building.level(space.floor_id) == floor_level)
        and lowered in ((space.ref or "").lower(), space.name.lower())
    ]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise ResolveError(
            f"'{reference}' matches {len(exact)} rooms. Candidates: "
            + "; ".join(f"{space_id} ({building.spaces[space_id].name})" for space_id in exact[:MAX_CANDIDATES])
        )
    asset_spaces = [
        asset.space_id
        for asset in building.assets.values()
        if (floor_level is None or building.level(asset.floor_id) == floor_level)
        and asset.name.lower() == lowered
    ]
    if len(asset_spaces) == 1:
        return asset_spaces[0]
    if " (" in reference:
        name, hint = _split_floor_hint(reference)
        if hint is not None:
            try:
                return resolve_space(building, name, floor_level=hint)
            except ResolveError:
                pass
    results = search(building, reference, floor_level)
    if not results:
        raise ResolveError(f"No place matches '{reference}'. Try search_building with fewer words.")
    raise ResolveError(_candidate_message(building, reference, results))


def resolve_element(building: Building, reference: str) -> str:
    """A closable element (connector, opening or space id/name) -> its id."""
    if reference in building.connectors or reference in building.openings or reference in building.spaces:
        return reference
    lowered = reference.strip().lower()
    named = [
        connector.id for connector in building.connectors.values() if connector.name.lower() == lowered
    ]
    if len(named) == 1:
        return named[0]
    return resolve_space(building, reference)
