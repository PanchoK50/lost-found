"""Variant V1: a template parser for the known benchmark phrasings -> skill call, no LLM.

It is the free baseline in the eval table, a fast path the hybrid agent can cross-check against, and the
fallback when the API is unavailable. It only understands the phrasings seen in train; anything else
returns None so a smarter path can take over."""

import re
from dataclasses import dataclass, field
from pathlib import Path

from lostfound.agent.format import answer_line
from lostfound.core import skills
from lostfound.core.building import Building, MapError
from lostfound.core.resolve import Resolver

NOT_STAIRS = re.compile(r"\b(can ?not|can't|cannot|no|without|avoid)\b[^.]*\b(stairs?|steps?)\b", re.IGNORECASE)


@dataclass
class Parsed:
    kind: str
    inputs: dict
    notes: list[str] = field(default_factory=list)


PATTERNS: list[tuple[str, re.Pattern]] = [
    (
        "largest_room",
        re.compile(r"largest (?P<room_type>[\w ]+?) on (?P<floor>the [\w -]+?|[\w -]+? floor)[,?]", re.I),
    ),
    (
        "floor_area_total",
        re.compile(r"floor area of (?:every|all) (?P<room_type>[\w ]+?) on (?P<floor>[\w -]+?) added together", re.I),
    ),
    (
        "errand",
        re.compile(
            r"I'm in (?P<start>.+?)\. I need to grab an? (?P<asset_type>[\w ]+?) from the room that has one "
            r"closest to me, then carry it to the largest (?P<room_type>[\w ]+?) on (?P<floor>[\w -]+?)\.(?P<rest>.*)",
            re.I | re.S,
        ),
    ),
    ("shared_walls_count", re.compile(r"soundproofing (?P<space>.+?)\. How many other rooms", re.I)),
    (
        "wide_delivery_count",
        re.compile(
            r"at least (?P<min_width>\d+(?:\.\d+)?) m wide\. It arrives through the entrance into (?P<start>.+?)\. "
            r"Into how many rooms on (?P<floor>[\w -]+?) can",
            re.I,
        ),
    ),
    (
        "step_free_reachable_count",
        re.compile(
            r"(?P<closed>[^.]+?) is (?:out of service|closed)[^.]*\. A wheelchair user comes in through the "
            r"entrance into (?P<start>.+?)\. How many rooms on (?P<floor>[\w -]+?) can",
            re.I,
        ),
    ),
    ("room_stacked_above", re.compile(r"ceiling in (?P<space>.+?)\. Which room is directly above", re.I)),
    ("room_stacked_below", re.compile(r"floor of (?P<space>.+?)\. Which room directly below", re.I)),
    (
        "straight_line_3d",
        re.compile(r"between (?P<first>.+?) and (?P<second>.+?)\. What is the straight-line distance", re.I),
    ),
    (
        "what_if_door",
        re.compile(
            r"add a door between (?P<first>.+?) and (?P<second>.+?), in the middle of the wall they share\? "
            r"How many rooms on (?P<floor>[\w -]+?) would",
            re.I,
        ),
    ),
]


def parse(building: Building, question: str) -> Parsed | None:
    resolver = Resolver(building)
    for name, pattern in PATTERNS:
        match = pattern.search(question)
        if not match:
            continue
        groups = match.groupdict()
        try:
            return _to_inputs(building, resolver, name, groups)
        except MapError:
            continue
    return None


def _to_inputs(building: Building, resolver: Resolver, name: str, groups: dict) -> Parsed:
    space = lambda key: resolver.space(groups[key]).best  # noqa: E731
    floor = lambda: resolver.floor(groups["floor"])  # noqa: E731
    match name:
        case "largest_room" | "floor_area_total":
            return Parsed(name, {"floor_id": floor(), "room_type": resolver.room_type(groups["room_type"])})
        case "errand":
            return Parsed(
                name,
                {
                    "start": space("start"),
                    "asset_type": resolver.asset_type(groups["asset_type"]),
                    "floor_id": floor(),
                    "room_type": resolver.room_type(groups["room_type"]),
                    "step_free": bool(NOT_STAIRS.search(groups["rest"])),
                },
            )
        case "shared_walls_count":
            return Parsed(name, {"space_id": space("space")})
        case "wide_delivery_count":
            return Parsed(name, {"start": space("start"), "floor_id": floor(), "min_width": float(groups["min_width"])})
        case "step_free_reachable_count":
            closed = building.find_element(groups["closed"].strip())
            return Parsed(name, {"start": space("start"), "floor_id": floor(), "closed": [closed]})
        case "room_stacked_above" | "room_stacked_below":
            return Parsed("room_stacked", {"space_id": space("space"), "direction": name.rsplit("_", 1)[1]})
        case "straight_line_3d":
            return Parsed(name, {"first": space("first"), "second": space("second")})
        case "what_if_door":
            return Parsed(name, {"first": space("first"), "second": space("second"), "floor_id": floor()})
    raise MapError(name)


def solve(building: Building, parsed: Parsed) -> dict:
    return skills.SKILLS[parsed.kind](building, **parsed.inputs)


def answer(building_directory: Path, question: str) -> str:
    """benchmark/evaluate.py-compatible entry point for the rules-only variant."""
    building = Building.load(building_directory)
    parsed = parse(building, question)
    if parsed is None:
        return "I could not match this question to a known template."
    try:
        result = solve(building, parsed)
    except MapError as error:
        return f"I could not answer: {error}"
    return f"Computed with {parsed.kind} on {parsed.inputs}.\n{answer_line(building, parsed.kind, result)}"
