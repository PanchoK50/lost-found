"""Parse a floor-plan PNG (the dataset's renders, or plans drawn in the same style) into the same drawing
primitives as svg.parse, in pixel units (y down), so assembly, inference and verification are shared.

- Spaces: pixels close to a space fill colour, one connected component per room (rooms of the same colour are
  separated by their dark outlines); a watershed then gives every outline pixel to the nearest room, so the
  region edges sit on the middle of the drawn walls. Polygons come from the region contours.
- Doors: small dots in the door, entrance and opening colours.
- Assets (for the scale): semi-transparent rectangles, recognised by un-blending a pixel against its room fill.
- Labels: not read here (they are glyphs, not text); lostfound.ingest.label reads them with Claude by region."""

from pathlib import Path

import cv2
import numpy as np

from lostfound.ingest.svg import ASSET_COLOURS, MARKER_COLOURS, SPACE_COLOURS, Drawing

FILL_TOLERANCE = 14          # RGB distance to count a pixel as a space fill
MARKER_TOLERANCE = 40
ASSET_TOLERANCE = 28
ASSET_ALPHA = 0.75           # assets are drawn at 75% opacity over the room fill
MIN_ROOM_PX = 30
MIN_ASSET_PX = 6
MARKER_AREA_PX = (12, 120)   # door dots are ~5 px wide; anti-aliased wall lines make smaller grey specks
MARKER_MAX_ASPECT = 1.6
MARKER_MIN_FILL = 0.6
SIMPLIFY_PX = 0.9


def _rgb(hex_colour: str) -> np.ndarray:
    return np.array([int(hex_colour[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float32)


def _load(path: Path) -> np.ndarray:
    """RGB float image composited over white."""
    image = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError(f"Cannot read image {path.name}")
    if image.ndim == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    if image.shape[2] == 4:
        alpha = image[:, :, 3:4].astype(np.float32) / 255
        image = image[:, :, :3].astype(np.float32) * alpha + 255 * (1 - alpha)
    return image[:, :, ::-1].astype(np.float32)  # BGR -> RGB


def _near(image: np.ndarray, colour: np.ndarray, tolerance: float) -> np.ndarray:
    return np.linalg.norm(image - colour, axis=2) <= tolerance


def parse(path: Path) -> Drawing:
    import re

    level = int(re.search(r"floor_(-?\d+)", path.name).group(1))
    image = _load(path)
    height, width = image.shape[:2]
    drawing = Drawing(level=level)
    drawing.raster = True  # type: ignore[attr-defined]

    # ---------- spaces ----------
    markers = np.zeros((height, width), dtype=np.int32)
    kinds: list[str] = []
    for colour, kind in SPACE_COLOURS.items():
        mask = _near(image, _rgb(colour), FILL_TOLERANCE).astype(np.uint8)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
        for index in range(1, count):
            if stats[index, cv2.CC_STAT_AREA] < MIN_ROOM_PX:
                continue
            kinds.append(kind)
            markers[labels == index] = len(kinds)
    if not kinds:
        return drawing
    background = np.linalg.norm(image - 255, axis=2) <= 6
    markers[background & (markers == 0)] = len(kinds) + 1  # the paper around the building
    flooded = cv2.watershed(np.clip(image[:, :, ::-1], 0, 255).astype(np.uint8), markers.copy())
    region_of = flooded  # -1 on watershed lines, 1..n rooms, n+1 background
    for index, kind in enumerate(kinds, start=1):
        region = (region_of == index).astype(np.uint8)
        # Watershed lines (-1) belong half to each side: grow the region by one pixel into them.
        region = cv2.dilate(region, np.ones((3, 3), np.uint8)) & ((region_of == index) | (region_of == -1)).astype(np.uint8)
        contours, _ = cv2.findContours(region, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        if cv2.contourArea(contour) < MIN_ROOM_PX:
            continue
        simplified = cv2.approxPolyDP(contour, SIMPLIFY_PX, True)[:, 0, :].astype(float)
        if len(simplified) < 3:
            continue
        from shapely.geometry import Polygon

        anchor = Polygon(simplified).buffer(0).representative_point()
        drawing.spaces.append({"type": kind, "points": [(float(x), float(y)) for x, y in simplified], "anchor_px": [anchor.x, anchor.y]})

    # ---------- doors ----------
    for colour, kind in MARKER_COLOURS.items():
        mask = _near(image, _rgb(colour), MARKER_TOLERANCE).astype(np.uint8)
        count, _, stats, centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
        for index in range(1, count):
            area = stats[index, cv2.CC_STAT_AREA]
            w, h = stats[index, cv2.CC_STAT_WIDTH], stats[index, cv2.CC_STAT_HEIGHT]
            if not MARKER_AREA_PX[0] <= area <= MARKER_AREA_PX[1] or max(w, h) / max(1, min(w, h)) > MARKER_MAX_ASPECT:
                continue
            if area / (w * h) < MARKER_MIN_FILL:
                continue
            x, y = centroids[index]
            drawing.markers.append({"kind": kind, "x": float(x), "y": float(y)})

    # ---------- assets (for the scale) ----------
    fills = {kind: _rgb(colour) for colour, kind in SPACE_COLOURS.items()}
    asset_mask = np.zeros((height, width), dtype=np.uint8)
    asset_kind = np.zeros((height, width), dtype=np.int8)
    asset_colours = [(_rgb(colour), category) for colour, category in ASSET_COLOURS.items()]
    for index, kind in enumerate(kinds, start=1):
        inside = region_of == index
        if not inside.any():
            continue
        fill = fills[kind]
        for code, (colour, _) in enumerate(asset_colours, start=1):
            blended = ASSET_ALPHA * colour + (1 - ASSET_ALPHA) * fill
            hit = inside & _near(image, blended, ASSET_TOLERANCE)
            asset_mask[hit] = 1
            asset_kind[hit] = code
    count, labels, stats, _ = cv2.connectedComponentsWithStats(asset_mask, connectivity=4)
    for index in range(1, count):
        if stats[index, cv2.CC_STAT_AREA] < MIN_ASSET_PX:
            continue
        ys, xs = np.nonzero(labels == index)
        codes = asset_kind[ys, xs]
        category = asset_colours[int(np.bincount(codes).argmax()) - 1][1]
        (cx, cy), (w, h), angle = cv2.minAreaRect(np.stack([xs, ys], axis=1).astype(np.float32))
        # Pixel coverage: the rectangle through the pixel centres is one pixel short in each direction.
        box = cv2.boxPoints(((cx, cy), (w + 1, h + 1), angle))
        drawing.assets.append({"category": category, "points": [(float(x), float(y)) for x, y in box]})
    return drawing
