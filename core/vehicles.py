"""Vehicle profiles: width-constrained routing for trolleys, forklifts and the like.

A vehicle composes the two independent width filters of RouteConstraints:
every opening it passes must be at least its width (min_door_width_m), and every
space it may enter must be that wide too (min_space_width_m, from the polygon's
minimum rotated rectangle). Vehicles never take stairs (step_free), and lifts
with 1.1 m doors drop out naturally through the door-width filter.

The dataset's forklift aisles are identifiable this way (calibrated on the
procedural factories): "Main aisle" corridors are 12-16.8 m wide while office
corridors are exactly 2.0 m, and the openings at least 3 m wide in factories are
exactly the doorless openings between aisles and hall zones plus the 4/5 m dock
entrances. Factory production/warehouse/logistics zones act as destinations
only, not shortcuts (no_transit) — "you can drive into a bay to deliver, but not
through one".
"""

from __future__ import annotations

from dataclasses import dataclass

from core.graph import RouteConstraints
from core.model import Building

FORKLIFT_MIN_WIDTH_M = 3.0
ZONE_ROOM_TYPES = frozenset(
    {"production_zone", "assembly_zone", "additive_zone", "warehouse_zone", "logistics_zone"}
)


@dataclass(frozen=True, slots=True)
class Vehicle:
    width_m: float
    allow_stairs: bool = False
    zone_sinks: bool = False


def for_vehicle(building: Building, vehicle: Vehicle) -> RouteConstraints:
    no_transit = (
        frozenset(
            space_id
            for space_id, space in building.spaces.items()
            if space.room_type in ZONE_ROOM_TYPES
        )
        if vehicle.zone_sinks
        else frozenset()
    )
    return RouteConstraints(
        step_free=not vehicle.allow_stairs,
        min_door_width_m=vehicle.width_m,
        min_space_width_m=vehicle.width_m,
        no_transit=no_transit,
    )


def forklift(building: Building) -> RouteConstraints:
    """A 3 m forklift: wide aisles and wide openings only, hall zones as destinations."""
    return for_vehicle(
        building,
        Vehicle(width_m=FORKLIFT_MIN_WIDTH_M, allow_stairs=False, zone_sinks=True),
    )
