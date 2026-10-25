"""Real surroundings for the OpenStreetMap buildings: neighbouring buildings, streets, paths, green areas, water and
trees within ~250 m, in the building's own plan frame (metres, like building.json).

  uv run python scripts/fetch_osm_context.py            # all buildings in data/campus/building-geo.json
  uv run python scripts/fetch_osm_context.py osm-way22744230

The dataset's indoor plans do not keep their real-world orientation, so the building's own OSM outline is fitted to
its plan footprint first (rotation and mirror searched by overlap, centroids aligned); the neighbours get the same
transform. Output: website/public/osm-context/<building id>.json. Data © OpenStreetMap contributors (ODbL)."""

import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from shapely.affinity import rotate, scale, translate
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
GEO = ROOT / "data" / "campus" / "building-geo.json"
OUT = ROOT / "website" / "public" / "osm-context"
RADIUS_M = 250
OVERPASS = "https://overpass-api.de/api/interpreter"
AGENT = "lost-found-hackathon/1.0 (Industrial Agents Hackathon building demo)"
ROAD_WIDTH = {"motorway": 14, "trunk": 12, "primary": 11, "secondary": 9, "tertiary": 8, "residential": 6, "unclassified": 6,
              "service": 4, "living_street": 5, "pedestrian": 5, "footway": 2, "path": 1.6, "cycleway": 2, "steps": 2}


def overpass(query: str) -> dict:
    body = urllib.parse.urlencode({"data": query}).encode()
    request = urllib.request.Request(OVERPASS, data=body, headers={"User-Agent": AGENT})
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.loads(response.read())


def project(lat0: float, lon0: float):
    k = 111320.0
    return lambda lat, lon: ((lon - lon0) * k * math.cos(math.radians(lat0)), (lat - lat0) * k)


def plan_footprint(building_id: str) -> Polygon:
    path = next(ROOT.glob(f"data/*/{building_id}/building.json"))
    data = json.loads(path.read_text())
    polygons = [Polygon(s["polygon"]).buffer(0) for s in data["spaces"] if len(s["polygon"]) >= 3]
    return unary_union(polygons).buffer(0.5).buffer(-0.5)


def fit(osm: Polygon, plan: Polygon) -> tuple[float, bool]:
    """Rotation (degrees) and mirror that best map the OSM outline (centred) onto the plan footprint (centred)."""
    o, p = osm.centroid, plan.centroid
    osm_c = translate(osm, -o.x, -o.y)
    plan_c = translate(plan, -p.x, -p.y)

    def iou(angle: float, mirror: bool) -> float:
        shape = rotate(scale(osm_c, -1 if mirror else 1, 1, origin=(0, 0)), angle, origin=(0, 0))
        union = shape.union(plan_c).area
        return shape.intersection(plan_c).area / union if union else 0.0

    best = max(((a, m) for m in (False, True) for a in range(0, 360, 2)), key=lambda am: iou(*am))
    fine = max(((best[0] + d / 4, best[1]) for d in range(-8, 9)), key=lambda am: iou(*am))
    return fine[0], fine[1], iou(*fine)


def main() -> None:
    geo = json.loads(GEO.read_text())["buildings"]
    ids = sys.argv[1:] or list(geo)
    OUT.mkdir(parents=True, exist_ok=True)
    for building_id in ids:
        info = geo[building_id]
        lat0, lon0 = info["lat"], info["lon"]
        to_m = project(lat0, lon0)
        way = building_id.removeprefix("osm-way")
        query = f"""[out:json][timeout:60];
(
  way({way});
  way(around:{RADIUS_M},{lat0},{lon0})[building];
  way(around:{RADIUS_M},{lat0},{lon0})[highway];
  way(around:{RADIUS_M},{lat0},{lon0})[landuse~"grass|meadow|forest|recreation_ground"];
  way(around:{RADIUS_M},{lat0},{lon0})[leisure~"park|garden|pitch"];
  way(around:{RADIUS_M},{lat0},{lon0})[natural~"water|wood|scrub|grassland"];
  node(around:{RADIUS_M},{lat0},{lon0})[natural=tree];
);
out geom;"""
        try:
            data = overpass(query)
        except Exception as error:  # noqa: BLE001 - one failed fetch must not stop the rest
            print(f"{building_id}: fetch failed ({error})")
            continue
        elements = data["elements"]
        own = next((e for e in elements if e["type"] == "way" and str(e["id"]) == way and e.get("geometry")), None)
        if own is None:
            print(f"{building_id}: own outline not found")
            continue
        osm_outline = Polygon([to_m(g["lat"], g["lon"]) for g in own["geometry"]]).buffer(0)
        plan = plan_footprint(building_id)
        angle, mirror, quality = fit(osm_outline, plan)
        o, p = osm_outline.centroid, plan.centroid

        def place(x: float, y: float) -> tuple[float, float]:
            x, y = x - o.x, y - o.y
            if mirror:
                x = -x
            a = math.radians(angle)
            return (round(x * math.cos(a) - y * math.sin(a) + p.x, 2), round(x * math.sin(a) + y * math.cos(a) + p.y, 2))

        buildings, roads, areas, trees = [], [], [], []
        for e in elements:
            tags = e.get("tags", {})
            if e["type"] == "node":
                trees.append(place(*to_m(e["lat"], e["lon"])))
                continue
            points = [place(*to_m(g["lat"], g["lon"])) for g in e.get("geometry", [])]
            if len(points) < 2 or str(e["id"]) == way:
                continue
            if "building" in tags and len(points) >= 4:
                levels = tags.get("building:levels")
                height = tags.get("height")
                try:
                    h = float(str(height).split()[0]) if height else float(levels) * 3.4 if levels else 10.0
                except ValueError:
                    h = 10.0
                shape = Polygon(points).buffer(0)
                # Skip the building's own outline (and anything overlapping the plan): we draw it ourselves.
                if shape.is_empty or shape.intersection(plan).area > 0.3 * shape.area:
                    continue
                buildings.append({"polygon": points, "height": round(min(max(h, 3.0), 80.0), 1)})
            elif "highway" in tags:
                kind = tags["highway"]
                roads.append({"points": points, "width": ROAD_WIDTH.get(kind, 4), "kind": kind})
            elif len(points) >= 4:
                kind = "water" if tags.get("natural") == "water" else "wood" if tags.get("natural") in ("wood", "scrub") or tags.get("landuse") == "forest" else "green"
                areas.append({"polygon": points, "kind": kind})
        out = {
            "building_id": building_id, "name": info["name"], "center": {"lat": lat0, "lon": lon0}, "radius_m": RADIUS_M,
            "fit": {"rotation_deg": round(angle, 2), "mirrored": mirror, "overlap": round(quality, 3)},
            "attribution": "© OpenStreetMap contributors (ODbL)",
            "buildings": buildings, "roads": roads, "areas": areas, "trees": trees,
        }
        (OUT / f"{building_id}.json").write_text(json.dumps(out, separators=(",", ":")))
        print(f"{building_id} ({info['name']}): fit {angle:.1f}° mirror={mirror} overlap={quality:.2f} · "
              f"{len(buildings)} buildings, {len(roads)} roads, {len(areas)} areas, {len(trees)} trees")
        time.sleep(2)  # be polite to the public Overpass server


if __name__ == "__main__":
    main()
