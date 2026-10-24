"""Deterministic core for the Lost & Found building agent.

Layers: model (typed building.json entities) -> geometry (shapely-derived facts)
-> graph (routing under constraints) -> vehicles (width profiles) -> queries
(one function per benchmark question kind). No LLM anywhere in this package.
"""

from core.model import (
    OUTSIDE,
    Asset,
    Building,
    BuildingMeta,
    Connector,
    Floor,
    Footprint,
    ModelError,
    Opening,
    Space,
)

__all__ = [
    "OUTSIDE",
    "Asset",
    "Building",
    "BuildingMeta",
    "Connector",
    "Floor",
    "Footprint",
    "ModelError",
    "Opening",
    "Space",
]
