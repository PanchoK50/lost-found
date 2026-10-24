"""Reachability under constraints (width, step-free, closures) and walking distance to the exits."""

import networkx as nx

from lostfound.core.building import OUTSIDE, ROOMISH_TYPES, Building


def reachable_spaces(
    building: Building, start: str, step_free: bool = False, min_width: float | None = None
) -> set[str]:
    graph = building.graph(step_free, min_width)
    if start not in graph:
        return set()
    return nx.node_connected_component(graph, start)


def rooms_reached(building: Building, reached: set[str], floor_id: str, types=ROOMISH_TYPES) -> list[str]:
    return [
        space["id"]
        for space in building.spaces_by_floor[floor_id]
        if space["type"] in types and space["id"] in reached
    ]


def exit_distances(building: Building, step_free: bool = False) -> dict[str, float]:
    """Route-model distance from every space to its nearest entrance (all entrances meet at 'outside')."""
    return building.distances_from(OUTSIDE, step_free)
