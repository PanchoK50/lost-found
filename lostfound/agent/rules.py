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


ROOM_AREA_ANSWER = "Finish with a line 'Answer: <room name or number>, <area> m²'."
ROOM_ANSWER = "Finish with a line 'Answer: <room name or number>'."
NUMBER_ANSWER = "Finish with a line 'Answer: <number>'."

# Each template is anchored at the start of the question and must end with its own answer instruction, so a
# reworded question never half-matches a template; anything that is not an exact template goes to Claude.
TEMPLATES: list[tuple[str, re.Pattern, str]] = [
    (
        "largest_room",
        re.compile(r"Which is the largest (?P<room_type>[\w ]+?) on (?P<floor>the [\w -]+?|[\w -]+? floor), and how big is it in m²\?", re.I),
        ROOM_AREA_ANSWER,
    ),
    (
        "floor_area_total",
        re.compile(
            r"Facilities want the total floor area of (?:every|all) (?P<room_type>[\w ]+?) on (?P<floor>[\w -]+?) "
            r"added together\. How many square metres is that\?",
            re.I,
        ),
        NUMBER_ANSWER,
    ),
    (
        "errand",
        re.compile(
            r"I'm in (?P<start>.+?)\. I need to grab an? (?P<asset_type>[\w ]+?) from the room that has one "
            r"closest to me, then carry it to the largest (?P<room_type>[\w ]+?) on (?P<floor>[\w -]+?)\. "
            r"(?P<rest>[^.]*)\. How far will I walk in total, in metres\?",
            re.I,
        ),
        NUMBER_ANSWER,
    ),
    (
        "shared_walls_count",
        re.compile(
            r"We're soundproofing (?P<space>.+?)\. How many other rooms on that floor share a wall with it\? "
            r"Count every room whose wall runs along it for at least 1 m, with or without a door between them; "
            r"corridors, stairwells and lifts don't count\.",
            re.I,
        ),
        NUMBER_ANSWER,
    ),
    (
        "wide_delivery_count",
        re.compile(
            r"I'm moving an? (?P<load_width>\d+(?:\.\d+)?) m wide [\w ]+?\. It can't go on stairs or steps "
            r"\(lifts are fine\), and every door it passes through must be at least (?P<min_width>\d+(?:\.\d+)?) m wide\. "
            r"It arrives through the entrance into (?P<start>.+?)\. Into how many rooms on (?P<floor>[\w -]+?) can it be delivered\?",
            re.I,
        ),
        NUMBER_ANSWER,
    ),
    (
        "step_free_reachable_count",
        re.compile(
            r"(?P<closed>[^.]+?) is out of service\. A wheelchair user comes in through the entrance into (?P<start>.+?)\. "
            r"How many rooms on (?P<floor>[\w -]+?) can they still reach\?",
            re.I,
        ),
        NUMBER_ANSWER,
    ),
    (
        "room_stacked_above",
        re.compile(r"There's water dripping from the ceiling in (?P<space>.+?)\. Which room is directly above it\?", re.I),
        ROOM_ANSWER,
    ),
    (
        "room_stacked_below",
        re.compile(
            r"A washing machine is leaking onto the floor of (?P<space>.+?)\. Which room directly below it will the water reach\?",
            re.I,
        ),
        ROOM_ANSWER,
    ),
    (
        "straight_line_3d",
        re.compile(
            r"We're planning a wireless sensor link between (?P<first>.+?) and (?P<second>.+?)\. What is the straight-line "
            r"distance in metres between the centres of the two rooms \(each room's floor-plan centroid, at its floor's elevation\)\?",
            re.I,
        ),
        NUMBER_ANSWER,
    ),
    (
        "what_if_door",
        re.compile(
            r"What if we add a door between (?P<first>.+?) and (?P<second>.+?), in the middle of the wall they share\? "
            r"How many rooms on (?P<floor>[\w -]+?) would then have a shorter walk out of the building, to their "
            r"nearest entrance, by more than 1 m\?",
            re.I,
        ),
        NUMBER_ANSWER,
    ),
]


def parse(building: Building, question: str) -> Parsed | None:
    resolver = Resolver(building)
    text = " ".join(question.split())
    for name, pattern, instruction in TEMPLATES:
        match = pattern.match(text)
        if not match or text[match.end():].strip() != instruction:
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
                    "step_free": _step_free(groups["rest"]),
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


def _step_free(sentence: str) -> bool:
    """'I can carry it on the stairs' -> False; anything else must be a clear 'no stairs' statement."""
    if re.fullmatch(r"I can carry it on the stairs", sentence.strip(), re.I):
        return False
    if NOT_STAIRS.search(sentence):
        return True
    raise MapError(f"Unrecognised constraint: {sentence}")


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
