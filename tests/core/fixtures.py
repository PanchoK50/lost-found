"""Shared hand-built building fixtures for the core tests.

Coordinates are metres, Y up, matching the challenge format. The base building
is intentionally small but exercises every feature: two floors, an entrance,
doors of different widths, stairs, and assets. Tests copy and extend it.
"""

from __future__ import annotations

import copy


def rectangle(x: float, y: float, width: float, height: float) -> list[list[float]]:
    return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]]


def minimal_building() -> dict:
    return {
        "building": {
            "id": "test-building",
            "name": "Test Hall",
            "source": "test",
            "license": "CC0-1.0",
            "units": "m",
            "split": "dev",
        },
        "floors": [
            {"id": "F0", "level": 0, "name": "Ground floor", "elevation_m": 0.0, "height_m": 4.0},
            {"id": "F1", "level": 1, "name": "First floor", "elevation_m": 3.0, "height_m": 3.0},
        ],
        "spaces": [
            {
                "id": "F0-S001",
                "floor_id": "F0",
                "type": "room",
                "room_type": "lobby",
                "name": "Lobby 0.01",
                "ref": "0.01",
                "polygon": rectangle(0, 0, 8, 6),
            },
            {
                "id": "F0-S002",
                "floor_id": "F0",
                "type": "corridor",
                "room_type": "corridor",
                "name": "Corridor 0.02",
                "ref": "0.02",
                "polygon": rectangle(8, 0, 2, 20),
            },
            {
                "id": "F0-S003",
                "floor_id": "F0",
                "type": "room",
                "room_type": "office",
                "name": "Office 0.03",
                "ref": "0.03",
                "polygon": rectangle(10, 0, 10, 10),
            },
            {
                "id": "F0-S004",
                "floor_id": "F0",
                "type": "stair",
                "room_type": "stairwell",
                "name": "Stairwell 0.04",
                "ref": "0.04",
                "polygon": rectangle(10, 10, 4, 4),
            },
            {
                "id": "F1-S001",
                "floor_id": "F1",
                "type": "room",
                "room_type": "office",
                "name": "Office 1.01",
                "ref": "1.01",
                "polygon": rectangle(10, 0, 10, 10),
            },
            {
                "id": "F1-S002",
                "floor_id": "F1",
                "type": "stair",
                "room_type": "stairwell",
                "name": "Stairwell 1.02",
                "ref": "1.02",
                "polygon": rectangle(10, 10, 4, 4),
            },
        ],
        "openings": [
            {
                "id": "F0-O0001",
                "floor_id": "F0",
                "space_ids": ["outside", "F0-S001"],
                "kind": "entrance",
                "position": [4.0, 0.0],
                "width_m": 1.6,
                "step_free": True,
            },
            {
                "id": "F0-O0002",
                "floor_id": "F0",
                "space_ids": ["F0-S001", "F0-S002"],
                "kind": "door",
                "position": [8.0, 3.0],
                "width_m": 1.2,
                "step_free": True,
            },
            {
                "id": "F0-O0003",
                "floor_id": "F0",
                "space_ids": ["F0-S002", "F0-S003"],
                "kind": "door",
                "position": [10.0, 5.0],
                "width_m": 0.9,
                "step_free": True,
            },
            {
                "id": "F0-O0004",
                "floor_id": "F0",
                "space_ids": ["F0-S002", "F0-S004"],
                "kind": "door",
                "position": [10.0, 12.0],
                "width_m": 1.2,
                "step_free": True,
            },
            {
                "id": "F1-O0005",
                "floor_id": "F1",
                "space_ids": ["F1-S002", "F1-S001"],
                "kind": "door",
                "position": [12.0, 10.0],
                "width_m": 1.2,
                "step_free": True,
            },
        ],
        "vertical_connectors": [
            {
                "id": "V01",
                "kind": "stairs",
                "name": "Staircase",
                "floor_ids": ["F0", "F1"],
                "space_ids": ["F0-S004", "F1-S002"],
                "step_free": False,
            }
        ],
        "assets": [
            {
                "id": "A00001",
                "name": "Printer 0.03-A",
                "category": "equipment",
                "type": "printer",
                "space_id": "F0-S003",
                "floor_id": "F0",
                "position": [15.0, 5.0],
                "footprint": {"width_m": 0.6, "depth_m": 0.5, "rotation_deg": 0.0},
                "source": "generated",
            }
        ],
    }


def mutated_building(**kwargs: dict) -> dict:
    """A deep copy of minimal_building() with top-level keys replaced via kwargs."""
    data = copy.deepcopy(minimal_building())
    for key, value in kwargs.items():
        data[key] = value
    return data


def with_lift() -> dict:
    """The minimal building plus a step-free lift joining the two stairwells."""
    data = copy.deepcopy(minimal_building())
    data["vertical_connectors"].append(
        {
            "id": "V02",
            "kind": "lift",
            "name": "Lift",
            "floor_ids": ["F0", "F1"],
            "space_ids": ["F0-S004", "F1-S002"],
            "step_free": True,
        }
    )
    return data
