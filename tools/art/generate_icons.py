# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = ["google-genai>=1.40", "pillow>=11", "rembg[cpu]>=2.0.60"]
# ///
"""
One image per asset type in the dataset (96 types), in a single consistent style.

The raw images double as the input for the image-to-3D step, so each one shows a single whole object
in a three-quarter view on a plain gray background.

    uv run tools/art/generate_icons.py <gcp-project> [type ...]

The first type generated becomes the style anchor (tools/art/out/raw/<type>.png) and is passed as a
reference for every other one. Steps are cached: delete a file to regenerate it.
Writes tools/art/out/raw/<type>.png, website/public/art/icons/<type>.png and a contact sheet at
tools/art/out/icons-sheet.png. ~$0.05 per image.
"""

import io
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from google import genai
from google.genai import errors, types
from PIL import Image, ImageDraw

TOOLS = Path(__file__).parent
REPO = TOOLS.parent.parent
RAW = TOOLS / "out" / "raw"
ICONS = REPO / "website" / "public" / "art" / "icons"
MODEL = "gemini-nano-banana-2.1"
ANCHOR = "cnc_mill"
ICON_SIZE = 160
WORKERS = 2
RETRIES = 10

STYLE = (
    "A single {name}, as a clean 3D product render for an indoor-navigation app. Soft matte "
    "materials, realistic proportions, simplified but clearly recognizable shapes, a calm palette "
    "of warm whites and light grays with the object's characteristic accent colors, soft even studio "
    "lighting. The whole object is visible and centered with a generous margin, seen from the "
    "front-left and slightly above (three-quarter view, about 30 degrees down). Plain flat neutral "
    "gray background (#808080), no floor, no shadow on the background, no text, no logos, no people, "
    "nothing else in the image."
)
ANCHOR_NOTE = (
    "Match the rendering style, materials, lighting, camera angle and level of detail of the "
    "reference image exactly, but draw the object described here, not the object in the reference."
)

# Hints where the type name alone is ambiguous or the model tends to add extra things.
HINTS = {
    "3d_printer": "desktop FDM 3D printer with an enclosed frame and a filament spool",
    "boiler": "floor-standing industrial heating boiler with pipes on top",
    "cnc_lathe": "industrial CNC lathe machine with an enclosed sliding door and a control panel",
    "cnc_mill": "industrial CNC milling machine (vertical machining center) with an enclosure, sliding front doors and a control panel",
    "compressor": "industrial air compressor with a horizontal tank",
    "conveyor": "straight belt conveyor section on legs",
    "coordinate_measuring_machine": "coordinate measuring machine (CMM) with a granite table and a bridge-shaped gantry with a probe",
    "curing_oven": "industrial cabinet curing oven with a large front door",
    "drill_press": "floor-standing drill press",
    "forklift": "warehouse forklift truck with its forks lowered, no driver",
    "hvac_unit": "industrial HVAC air handling unit box with fan grilles",
    "industrial_3d_printer": "large industrial 3D printer cabinet with a viewing window and a touchscreen",
    "injection_moulding_machine": "long horizontal plastic injection moulding machine with a hopper on top",
    "laser_cutter": "flatbed laser cutter with a hinged tinted lid",
    "milling_machine": "manual knee-type milling machine",
    "press_brake": "hydraulic press brake for bending sheet metal",
    "robot_cell": "industrial robot cell: an orange robot arm on a base inside a square safety fence",
    "waterjet_cutter": "waterjet cutting table with a gantry",
    "atm": "freestanding ATM cash machine",
    "defibrillator": "wall-mounted AED defibrillator box, green with a white heart symbol (no text)",
    "display_screen": "large flat information display screen on a stand",
    "electrical_panel": "wall-mounted gray electrical distribution cabinet",
    "eyewash_station": "emergency eyewash station on a pedestal, green and yellow",
    "fire_extinguisher": "red fire extinguisher",
    "forklift_charging_station": "forklift battery charging station: a gray charger cabinet with a cable",
    "fume_hood": "laboratory fume hood with a glass sash",
    "hand_dryer": "wall-mounted electric hand dryer",
    "multifunction_printer": "office multifunction printer-copier on a base cabinet",
    "oscilloscope_station": "electronics workbench with an oscilloscope and test equipment",
    "pallet_jack": "manual pallet jack",
    "powder_station": "powder handling station for metal 3D printing: a glovebox cabinet",
    "projector": "ceiling projector",
    "projector_screen": "pull-down projector screen",
    "server_rack": "server rack cabinet with blinking servers behind a mesh door",
    "soldering_station": "electronics soldering workbench with a soldering station and magnifier lamp",
    "ups_unit": "floor-standing UPS battery cabinet",
    "water_dispenser": "office water cooler with a blue bottle on top",
    "welding_station": "welding workstation with a welding table, welder and a protective curtain",
    "whiteboard": "whiteboard on a mobile stand",
    "internal_stairs": "short straight indoor staircase",
    "kitchen_counter": "kitchen counter with cabinets below",
    "serving_counter": "canteen serving counter with a sneeze guard",
    "shower": "square glass shower cabin",
    "assembly_station": "industrial assembly workstation with a frame, parts bins and a lamp",
    "built_in_wardrobe": "built-in wardrobe with sliding doors",
    "canteen_table": "long canteen table with benches",
    "chemical_cabinet": "yellow safety cabinet for chemicals",
    "inspection_bench": "quality inspection bench with a magnifier lamp",
    "lab_bench": "laboratory bench with a reagent shelf",
    "lecture_seating_row": "row of fold-down lecture hall seats with a writing desk in front",
    "locker": "row of metal lockers",
    "packing_station": "packing table with a roll of packing paper and cardboard boxes",
    "pallet_rack": "warehouse pallet rack with orange beams and a few pallets with boxes",
    "paper_shelf": "office shelf with paper reams and folders",
    "plant": "potted indoor plant",
    "reception_desk": "reception desk",
    "seminar_table": "seminar table",
    "tool_cabinet": "red rolling tool cabinet with drawers",
    "waste_basket": "set of recycling waste bins",
}


def asset_types() -> dict[str, str]:
    types_: dict[str, str] = {}
    for path in sorted((REPO / "data").glob("*/*/building.json")):
        for asset in json.loads(path.read_text(encoding="utf-8"))["assets"]:
            types_.setdefault(asset["type"], asset["category"])
    return dict(sorted(types_.items()))


def generate(client: genai.Client, prompt: str, out: Path, reference: Path | None) -> None:
    contents: list = [types.Part.from_bytes(data=reference.read_bytes(), mime_type="image/png")] if reference else []
    for attempt in range(RETRIES):
        try:
            response = client.models.generate_content(
                model=MODEL,
                contents=[*contents, prompt],
                config=types.GenerateContentConfig(
                    response_modalities=["IMAGE"], image_config=types.ImageConfig(aspect_ratio="1:1")
                ),
            )
            part = next(p for p in response.candidates[0].content.parts if p.inline_data)
            Image.open(io.BytesIO(part.inline_data.data)).convert("RGB").save(out)
            return
        except errors.ClientError as error:
            if error.code != 429 or attempt == RETRIES - 1:
                raise
            delay = min(30 * 2**attempt, 300)
            print(f"  rate limited on {out.stem}, retrying in {delay} s…", flush=True)
            time.sleep(delay)
        except (StopIteration, TypeError, AttributeError):
            if attempt == RETRIES - 1:
                raise
            print(f"  no image for {out.stem}, retrying…", flush=True)


def prompt_for(type_: str) -> str:
    return STYLE.format(name=HINTS.get(type_, type_.replace("_", " ")))


def cut_out(raw: Path, out: Path, session) -> None:
    from rembg import remove

    cut = remove(Image.open(raw).convert("RGB"), session=session)
    cut.putalpha(cut.getchannel("A").point(lambda a: 0 if a < 100 else min(255, int(a * 1.6 - 60))))
    cut = cut.crop(cut.getbbox())
    cut.thumbnail((ICON_SIZE, ICON_SIZE), Image.LANCZOS)
    canvas = Image.new("RGBA", (ICON_SIZE, ICON_SIZE))
    canvas.paste(cut, ((ICON_SIZE - cut.width) // 2, (ICON_SIZE - cut.height) // 2), cut)
    canvas.save(out, optimize=True)


def contact_sheet(names: list[str]) -> None:
    cell, cols = 180, 10
    tiles = [(n, ICONS / f"{n}.png") for n in names if (ICONS / f"{n}.png").exists()]
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * (cell + 20)), "#eef1e8")
    draw = ImageDraw.Draw(sheet)
    for i, (name, path) in enumerate(tiles):
        x, y = (i % cols) * cell, (i // cols) * (cell + 20)
        tile = Image.open(path)
        sheet.paste(tile, (x + 10, y + 5), tile)
        draw.text((x + 6, y + cell - 8), name[:28], fill="#233020")
    sheet.save(TOOLS / "out" / "icons-sheet.png")


def main() -> None:
    from rembg import new_session

    RAW.mkdir(parents=True, exist_ok=True)
    ICONS.mkdir(parents=True, exist_ok=True)
    client = genai.Client(vertexai=True, project=sys.argv[1], location="global")
    all_types = asset_types()
    names = sys.argv[2:] or list(all_types)
    unknown = [n for n in names if n not in all_types]
    if unknown:
        sys.exit(f"Unknown asset types: {', '.join(unknown)}")

    anchor = RAW / f"{ANCHOR}.png"
    if not anchor.exists():
        print(f"{ANCHOR} (style anchor)…")
        generate(client, prompt_for(ANCHOR), anchor, None)

    def work(name: str) -> None:
        raw = RAW / f"{name}.png"
        if raw.exists():
            return
        print(f"{name}…", flush=True)
        try:
            generate(client, f"{ANCHOR_NOTE} {prompt_for(name)}", raw, anchor)
        except Exception as error:  # keep going; rerun the script to fill the gaps
            print(f"  FAILED {name}: {error}", flush=True)

    with ThreadPoolExecutor(WORKERS) as pool:
        list(pool.map(work, [n for n in names if n != ANCHOR]))

    session = new_session("isnet-general-use")
    for name in names:
        icon = ICONS / f"{name}.png"
        if (RAW / f"{name}.png").exists() and not icon.exists():
            cut_out(RAW / f"{name}.png", icon, session)
    contact_sheet(list(all_types))
    print(f"{len(list(ICONS.glob('*.png')))}/{len(all_types)} icons in {ICONS.relative_to(REPO)}")


if __name__ == "__main__":
    main()
