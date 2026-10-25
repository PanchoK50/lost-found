"""Cross-building routing: the campus union graph, honest distance sources, and the journey legs."""

from pathlib import Path

import pytest

from lostfound.core.building import Building, MapError
from lostfound.core.campus import (
    CAMPUS_DIR,
    Campus,
    CampusMember,
    Catalog,
    curated_placement,
    geo_placement,
)

N3 = "osm-way22744230"   # TUM Stammgelände (dev)
N8 = "osm-way43035346"   # its real neighbour (test)
FACTORY = "proc-factory-dev-003"


@pytest.fixture(scope="module")
def buildings() -> dict[str, Building]:
    return {
        N3: Building.load(Path("data/dev") / N3),
        N8: Building.load(Path("data/test") / N8),
        FACTORY: Building.load(Path("data/dev") / FACTORY),
    }


@pytest.fixture(scope="module")
def campus(buildings) -> Campus:
    placement = curated_placement(N3, N8)
    assert placement is not None, "the demo campus file must place N3 and N8"
    return Campus(
        [CampusMember(buildings[N3], (0, 0), "here"), CampusMember(buildings[N8], tuple(placement["offset"]), placement["source"])],
        placement.get("walkways", []),
    )


def _room(building: Building, suffix: str) -> str:
    return next(s["id"] for s in building.spaces.values() if s["floor_id"].endswith(suffix) and s["type"] == "room")


def test_geo_table_has_real_neighbours():
    placement = geo_placement(N3, N8)
    assert placement is not None
    assert placement["source"] == "measured"
    assert 120 < placement["distance_m"] < 170  # N3 and N8 are ~144 m apart on the real campus
    assert curated_placement(N3, N8)["offset"] == pytest.approx(placement["offset"], abs=2)


def test_geo_table_rejects_unmeasured_pairs():
    assert geo_placement(N3, FACTORY) is None  # the factory has no real-world position


def test_cross_route_composes_three_legs(campus, buildings):
    start, destination = _room(buildings[N3], "-F0"), _room(buildings[N8], "-F0")
    result = campus.cross_route((N3, start), (N8, destination))
    kinds = [leg["kind"] for leg in result["legs"]]
    assert kinds == ["indoor", "outdoor", "indoor"]
    assert result["legs"][0]["building_id"] == N3
    assert result["legs"][2]["building_id"] == N8
    indoor = sum(leg["route"]["length_m"] for leg in result["legs"] if leg["kind"] == "indoor")
    outdoor = next(leg for leg in result["legs"] if leg["kind"] == "outdoor")["length_m"]
    assert outdoor > 100  # the real walk across between the buildings
    assert result["length_m"] == pytest.approx(indoor + outdoor, abs=1.0)
    assert any("walk about" in step and "entrance" in step for step in result["steps"])


def test_cross_route_across_floors(campus, buildings):
    start, destination = _room(buildings[N3], "-F2"), _room(buildings[N8], "-F2")
    result = campus.cross_route((N3, start), (N8, destination))
    assert result["legs"][0]["route"]["polylines"]  # an indoor path in N3
    assert result["length_m"] > result["legs"][1]["length_m"]  # more than just the walk between buildings


def test_cross_route_rejects_same_building(campus, buildings):
    with pytest.raises(MapError):
        campus.cross_route((N3, _room(buildings[N3], "-F0")), (N3, _room(buildings[N3], "-F1")))


def test_campus_graph_only_links_across_buildings(buildings):
    """The graded single-building model has no outdoor edges; the campus layer adds only cross-building ones."""
    site = Campus([CampusMember(buildings[N3], (0, 0)), CampusMember(buildings[N8], (134, -52))])
    graph = site.graph()
    def building_of(node: str) -> str:
        return node.removeprefix("door:")[: node.removeprefix("door:").rfind("-F")]
    outdoor_edges = [
        (u, v)
        for u, v in graph.edges()
        if any(attrs.get("outdoor") for attrs in (graph.get_edge_data(u, v) or {}).values())
    ]
    assert outdoor_edges, "the campus must link the two buildings' entrances"
    for u, v in outdoor_edges:
        assert {building_of(u), building_of(v)} == {N3, N8}, "outdoor edges only ever cross buildings"
    single = buildings[N3].graph()
    assert not any(
        attrs.get("outdoor") for _, _, attrs in single.edges(data=True)
    ), "the plain building graph stays untouched"


def test_assumed_placement_from_conversation(buildings):
    """A building without a real position is placed from what the person said; the source is 'assumed'.
    The offset places the building ORIGINS 500 m apart; the outdoor leg measures door to door, so it can
    come out a little shorter or longer than 500 m depending on which entrances win."""
    site = Campus([CampusMember(buildings[N3], (0, 0), "here"), CampusMember(buildings[FACTORY], (500, 0), "assumed")])
    result = site.cross_route((N3, _room(buildings[N3], "-F0")), (FACTORY, _room(buildings[FACTORY], "-F0")))
    outdoor = next(leg for leg in result["legs"] if leg["kind"] == "outdoor")
    assert 380 < outdoor["length_m"] < 620  # door-to-door around the 500 m the person described
    assert result["distance_source"] == "assumed"


def test_far_pair_routes_with_real_distance(buildings):
    """No distance limit: N3 to the Garching institute (~29 km) routes with its real length."""
    institute = Building.load(Path("data/dev") / "osm-way27326387")
    placement = geo_placement(N3, institute.id)
    assert placement is not None and placement["distance_m"] > 25_000
    site = Campus([CampusMember(buildings[N3], (0, 0), "here"), CampusMember(institute, tuple(placement["offset"]), "measured")])
    result = site.cross_route((N3, _room(buildings[N3], "-F0")), (institute.id, _room(institute, "-F0")))
    assert result["length_m"] > 25_000  # the real kilometres, not a capped or refused route
    assert result["legs"][1]["kind"] == "outdoor"
    assert result["distance_source"] == "measured"


def test_catalog_finds_buildings_by_name():
    catalog = Catalog({N3: Path("data/dev") / N3, N8: Path("data/test") / N8})
    assert catalog.search("N8")[0]["id"] == N8
    assert catalog.search("n8")[0]["id"] == N8
    assert catalog.search("osm-way22744230")[0]["id"] == N3
    loaded = catalog.load(N8)
    assert loaded.id == N8


def test_demo_campus_file_exists():
    assert (CAMPUS_DIR / "stammgelaende.json").exists()
    assert (CAMPUS_DIR / "building-geo.json").exists()
