"""Parse a floor-plan SVG (the dataset's matplotlib renders) into drawing primitives in SVG points.

What the renders encode (learned from train buildings, see lostfound/ingest/README.md):
- stroked patches (#333333 outline) are spaces; the fill colour is the space type;
- unstroked semi-transparent patches are assets; the fill colour is the asset category;
- <use> markers are openings: brown = door, red = entrance/outside door, grey = opening without leaf;
- <g id="text_N"> groups carry their text in an XML comment: room refs, plus a "Building — Floor" title."""

import re
from dataclasses import dataclass, field
from pathlib import Path

SPACE_COLOURS = {
    "#f3efe6": "room",
    "#dcdcdc": "corridor",
    "#f4b183": "stair",
    "#b4a7d6": "lift",
    "#fff2b3": "hall",
    "#cfe8c4": "outdoor",
}
ASSET_COLOURS = {"#7f6a4f": "furniture", "#2e7d32": "equipment", "#4f81bd": "fixture", "#c0504d": "machine"}
MARKER_COLOURS = {"#8b4513": "door", "#d32f2f": "entrance", "#9e9e9e": "opening"}

PATCH = re.compile(r'<g id="patch_\d+">\s*<path d="([^"]+)"(?: clip-path="[^"]*")? style="([^"]*)"')
POINT = re.compile(r"([MLC]) ([-\d.]+) ([-\d.]+)")
MARKER = re.compile(r'<use xlink:href="#[^"]+" x="([-\d.]+)" y="([-\d.]+)" style="([^"]*)"')
TEXT = re.compile(
    r'<g id="text_\d+">\s*<!-- (.*?) -->\s*<g[^>]*transform="translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+) [-\d.]+\)">(.*?)</g>',
    re.S,
)
GLYPH_OFFSET = re.compile(r'<use xlink:href="#[^"]+"(?: transform="translate\(([-\d.]+) 0\)")?')
GLYPH_ADVANCE = 63.6  # DejaVu Sans digit advance in font units; good enough for the last glyph
FILL = re.compile(r"fill: (#[0-9a-f]{6})")


@dataclass
class Drawing:
    level: int
    title: str = ""
    spaces: list[dict] = field(default_factory=list)  # {"type", "points"}
    assets: list[dict] = field(default_factory=list)  # {"category", "points"}
    markers: list[dict] = field(default_factory=list)  # {"kind", "x", "y"}
    labels: list[dict] = field(default_factory=list)  # {"text", "x", "y", "width"} (x, y = text start)


def _points(path_data: str) -> list[tuple[float, float]]:
    points = [(float(x), float(y)) for _, x, y in POINT.findall(path_data)]
    if len(points) > 1 and points[0] == points[-1]:
        points.pop()
    return points


def parse(path: Path) -> Drawing:
    text = path.read_text(encoding="utf-8")
    level = int(re.search(r"floor_(-?\d+)", path.name).group(1))
    drawing = Drawing(level=level)
    for path_data, style in PATCH.findall(text):
        fill = FILL.search(style)
        if not fill:
            continue
        colour = fill.group(1)
        points = _points(path_data)
        if "stroke: #333333" in style and colour in SPACE_COLOURS and len(points) >= 3:
            drawing.spaces.append({"type": SPACE_COLOURS[colour], "points": points})
        elif "stroke" not in style and colour in ASSET_COLOURS and len(points) >= 4:
            drawing.assets.append({"category": ASSET_COLOURS[colour], "points": points})
    for x, y, style in MARKER.findall(text):
        fill = FILL.search(style)
        if fill and fill.group(1) in MARKER_COLOURS:
            drawing.markers.append({"kind": MARKER_COLOURS[fill.group(1)], "x": float(x), "y": float(y)})
    for label, x, y, size, glyphs in TEXT.findall(text):
        label = label.replace("&amp;", "&").strip()
        if " — " in label and not drawing.title:
            drawing.title = label
            continue
        offsets = [float(offset or 0) for offset in GLYPH_OFFSET.findall(glyphs)]
        width = (max(offsets, default=0.0) + GLYPH_ADVANCE) * float(size) if offsets else 0.0
        drawing.labels.append({"text": label, "x": float(x), "y": float(y), "width": width})
    return drawing
