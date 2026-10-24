"""Create a readable exploration notebook; execute separately with nbclient."""
import json
from pathlib import Path
cells=[]
def md(text): cells.append({'cell_type':'markdown','metadata':{},'source':text.splitlines(True)})
def code(text): cells.append({'cell_type':'code','execution_count':None,'metadata':{},'outputs':[],'source':text.splitlines(True)})
md('''# Inside the challenge dataset

A hands-on tour for the Lost & Found team. Start with the dataset inventory, then inspect a real factory, both floors, equipment, connections and benchmark questions.

**Sample:** `proc-factory-dev-003`, a public CC0 procedural development building. No test answers are included. The full manifest is included, but only this building's detailed records are bundled. Source snapshot: `cb51a6f2e357db743b0c8b2b377fe902ee3ced13`.

Run all cells from top to bottom. Change `BUILDING_DIR` to explore another local building in the same format. This notebook uses Python's standard library and IPython (included with Jupyter); it needs no API key and makes no network calls.
''')
code('''from pathlib import Path
import sys, json
from collections import Counter
from IPython.display import HTML, display

# Supports launching Jupyter from the repository root or notebooks/.
NOTEBOOK_DIR = Path.cwd() if (Path.cwd() / "explore.py").exists() else Path.cwd() / "notebooks"
sys.path.insert(0, str(NOTEBOOK_DIR))
from explore import load_building, load_manifest, load_questions, table, bars, floor_svg, area, STYLE
BUILDING_DIR = NOTEBOOK_DIR / "data" / "proc-factory-dev-003"
building = load_building(BUILDING_DIR)
manifest = load_manifest()
display(HTML(f"<style>{STYLE}</style>"))
print("Loaded:", building["building"]["name"])
''')
md('''## 1. What data do we have?

The manifest has one row per building. Train is for development, dev is for evaluation, and test is for final generated submissions. Buildings come from Swiss Dwellings, ResPlan, OpenStreetMap indoor data, and procedural generators. Licenses differ: read `data/ATTRIBUTION.md`.
''')
code('''print(f"{len(manifest)} buildings described by the manifest")
display(HTML(bars(Counter(row["split"] for row in manifest), "Buildings by split")))
display(HTML(bars(Counter(row["source"] for row in manifest), "Buildings by source")))
display(HTML(table(manifest[:8])))
''')
md('''## 2. What is inside one building?

- `building.json`: canonical metadata and spatial model.
- `equipment.csv`: flattened asset inventory, including room names and floor details.
- `floor_<level>.png/.svg` and `floor_<level>_plain.png`: visual floor plans, available upstream (not bundled).
- `questions_basic.jsonl`: warm-up lookups and routes.
- `questions.jsonl`: real benchmark tasks; train/dev include answers, test does not.

A **space** is a polygon. An **opening** joins two spaces (or a space and `outside`). A **vertical connector** links floor stops. An **asset** has a location and a `space_id`. Units are metres; X points right, Y points up. Floor 0 is ground level.
''')
code('''display(HTML(table([building["building"]])))
display(HTML(table([{"entity": key, "records": len(building[key])} for key in ("floors", "spaces", "openings", "vertical_connectors", "assets")])))
display(HTML(table(building["floors"])))
# Exact records are useful when agreeing on frontend/backend contracts.
for key in ("spaces", "openings", "vertical_connectors", "assets"):
    print("\\n" + key + " — first record:")
    print(json.dumps(building[key][0], indent=2))
''')
md('''## 3. Visualize the floors

Rooms are coloured by space type; blue footprints are machines/equipment; grey-green footprints are furniture/fixtures; dots are openings. Hover for exact names, IDs, door widths, accessibility and source fields. Orange dots mark openings that are not step-free. Stairs are orange regions and lifts are purple.

These are input polygons and asset footprints, not walkable paths. Display labels use approximate bounding-box centres; routing must use the official graph's representative points.
''')
code('''for floor in sorted(building["floors"], key=lambda f: f["level"]):
    print(f"{floor['name']} — level {floor['level']}, elevation {floor['elevation_m']} m")
    display(HTML(floor_svg(building, floor["id"])))
''')
md('''## 4. Explore the inventory

Change `SEARCH` to find equipment by name or type. `space_id` connects each result back to a room polygon; `floor_id` connects it to a floor. Generated assets are marked separately from dataset assets.
''')
code('''display(HTML(bars(Counter(a["category"] for a in building["assets"]), "Asset categories")))
SEARCH = "cnc"
assets = [a for a in building["assets"] if SEARCH.casefold() in (a["name"] + " " + a["type"]).casefold()]
print(f"{len(assets)} matching assets")
display(HTML(table(assets, ["id", "name", "type", "space_id", "floor_id", "position", "source"])))
# Confirm the CSV is an alternative view of the same asset inventory.
import csv
with (BUILDING_DIR / "equipment.csv").open(newline="") as handle:
    equipment = list(csv.DictReader(handle))
assert {row["asset_id"] for row in equipment} == {a["id"] for a in building["assets"]}
print("CSV asset IDs match building.json:", len(equipment))
''')
md('''## 5. Geometry and connectivity

Polygon areas are calculated using the shoelace formula. These are individual space areas; summing all polygons can double-count overlaps. This is a useful first tool for `largest_room`, but not enough for route, shared-wall or stacked-room questions.
''')
code('''space_rows = [{"name": s["name"], "floor_id": s["floor_id"], "type": s["type"], "room_type": s["room_type"], "area_m2": round(area(s["polygon"]), 2)} for s in building["spaces"]]
display(HTML(table(sorted(space_rows, key=lambda s: s["area_m2"], reverse=True)[:15])))
print("Connections between floors:")
display(HTML(table(building["vertical_connectors"])))
print("Entrances:")
display(HTML(table([o for o in building["openings"] if "outside" in o["space_ids"]])))
print("Door widths (first 12 doors):")
display(HTML(table([o for o in building["openings"] if o["kind"] == "door"][:12], ["id", "space_ids", "width_m", "step_free"])))
''')
md('''## 6. What do we need to answer?

Warm-up questions test locating/counting/routing. The full benchmark asks for areas, width-constrained reachability, rooms above/below, shared walls, 3D distances, and the effect of adding a door. Inspect a dev question and its structured expected answer below. This notebook does not call an LLM or attempt the benchmark.
''')
code('''questions = load_questions(directory=BUILDING_DIR)
basic = load_questions("questions_basic.jsonl", directory=BUILDING_DIR)
display(HTML(table([{"set": name, "kind": kind, "count": n} for name, records in [("benchmark", questions), ("warm-up", basic)] for kind, n in Counter(q["kind"] for q in records).items()])))
display(HTML(table(questions, ["id", "kind", "question"])))
QUESTION_INDEX = 0
print(json.dumps(questions[QUESTION_INDEX], indent=2))
''')
md('''## 7. Basic data integrity checks

Check unique IDs, entity references and floor membership before building on these inputs. These checks do not establish routing correctness or polygon validity.
''')
code('''space_ids = {s["id"] for s in building["spaces"]}
floor_ids = {f["id"] for f in building["floors"]}
for key in ("floors", "spaces", "openings", "vertical_connectors", "assets"):
    assert len({item["id"] for item in building[key]}) == len(building[key]), f"Duplicate IDs in {key}"
for space in building["spaces"]:
    assert space["floor_id"] in floor_ids
    assert len(space["polygon"]) >= 3 and area(space["polygon"]) > 0
for asset in building["assets"]:
    assert asset["space_id"] in space_ids and asset["floor_id"] in floor_ids
    assert next(s for s in building["spaces"] if s["id"] == asset["space_id"])["floor_id"] == asset["floor_id"]
for opening in building["openings"]:
    assert len(opening["space_ids"]) == 2
    assert opening["floor_id"] in floor_ids
    assert set(opening["space_ids"]) <= space_ids | {"outside"}
for connector in building["vertical_connectors"]:
    assert len(connector["floor_ids"]) == len(connector["space_ids"])
    for floor_id, space_id in zip(connector["floor_ids"], connector["space_ids"]):
        assert floor_id in floor_ids and space_id in space_ids
        assert next(s for s in building["spaces"] if s["id"] == space_id)["floor_id"] == floor_id
print("All sample entity IDs, references, floor memberships and basic polygon checks passed.")
''')
md('''## Where to go next

1. Import this real building into the Next.js viewer instead of the hand-made demo.
2. Reuse the Python starter graph: space anchors at Shapely representative points, opening nodes, parallel connections, stair cost 12 m/floor, lift cost 15 m wait + 6 m/floor. Preserve the official accessibility and closure behaviour.
3. Validate routing against dev warm-up answers; then add geometry tools for the full benchmark.
4. Connect tool results to the conversational UI with exact space/asset IDs and route coordinates.

Read [the challenge](https://github.com/Synera-GmbH/industrial-agents-hackathon-2026) and `data/ATTRIBUTION.md`. This snapshot was fetched on 2026-10-24; the HTML explorer can be regenerated with `python notebooks/explore.py`.
''')
for i,cell in enumerate(cells): cell['id']=f'explore-{i:02d}'
nb={'cells':cells,'metadata':{'kernelspec':{'display_name':'Python 3','language':'python','name':'python3'},'language_info':{'name':'python','version':'3.9'}},'nbformat':4,'nbformat_minor':5}
Path('notebooks/data-exploration.ipynb').write_text(json.dumps(nb,indent=2)+'\n')
