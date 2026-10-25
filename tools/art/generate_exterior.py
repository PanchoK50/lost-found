# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = ["google-genai>=1.40", "pillow>=11", "numpy>=2"]
# ///
"""
Exterior textures for the 3D building viewer: facades, roofs, plinth and ground.

Facades are mapped onto extruded walls with U along the wall (one repeat = one window bay, ~3 m) and
V spanning exactly one storey (bottom = floor slab, top = next slab). So each facade image is one
storey high and one bay wide, shows the slab/spandrel band at the very bottom, tiles seamlessly
left-right and repeats per storey. Roof, plinth and ground textures are top-down and tile in both
directions. Usage and metres per repeat are in website/public/art/exterior/README.md.

    uv run tools/art/generate_exterior.py <gcp-project> [name ...]

Raw images are cached in tools/art/out/exterior/<name>.png (delete one to regenerate it). Writes
website/public/art/exterior/<name>.jpg (512 px), a 2x2 tiled preview per texture in
tools/art/out/exterior/preview/ and a contact sheet at tools/art/out/exterior/contact.png.
Night variants (and the ground-floor office) use their day facade as a reference image.
~$0.05 per generated image.
"""

import sys
from pathlib import Path

import numpy as np
from google import genai
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).parent))
from generate_icons import generate  # noqa: E402

TOOLS = Path(__file__).parent
REPO = TOOLS.parent.parent
WORK = TOOLS / "out" / "exterior"
PREVIEW = WORK / "preview"
OUT = REPO / "website" / "public" / "art" / "exterior"
SIZE = 512

FACADE = (
    "A flat orthographic elevation texture of {what}. The image shows exactly ONE storey high and "
    "exactly ONE window bay wide, filling the whole square image edge to edge: the bottom tenth of "
    "the image is a horizontal floor slab / spandrel band running the full width, above it the "
    "storey with the window, and the top edge ends right below the next slab. The left and right "
    "edges cut through the middle of the vertical dividers between bays so the image tiles "
    "seamlessly side by side and stacked on top of itself. Seen exactly head-on (pure front "
    "elevation, no perspective, no vanishing lines, no depth), flat even overcast lighting, no cast "
    "shadows. Clean, realistic but slightly stylized architectural-visualisation look, mid to light "
    "values, slightly desaturated. No people, no plants, no text, no signs, no logos, no vignette, "
    "no borders, no sky, no ground."
)
TOPDOWN = (
    "A seamless tileable texture of {what}, seen from directly above (orthographic top-down, no "
    "perspective), filling the whole square image edge to edge. Flat, even, shadowless lighting, "
    "light and low in contrast, slightly desaturated, realistic but clean architectural-visualisation "
    "look. No objects, no people, no text, no markings, no vignette, no borders."
)
NIGHT = (
    "Redraw the reference facade texture exactly (same layout, same framing, same single storey and "
    "single bay, same slab band at the bottom, same orthographic head-on view) but at dusk/night: "
    "the facade materials are dim cool blue-grey, and the window glass glows with warm yellow-white "
    "interior light (soft, as if office ceiling lights are on behind it); the glass shows only an even "
    "warm glow with at most a faint hint of a ceiling light line, no visible room interior, no "
    "furniture, no perspective. No people, no text, no "
    "vignette, no sky."
)
GROUND_FLOOR = (
    "Using the reference facade texture for materials and style (same light grey aluminium mullions, "
    "same blue-grey glass, same slab band, same orthographic head-on framing of exactly one storey "
    "and one bay), draw the GROUND-FLOOR variant: a tall glass storefront / entrance-lobby glazing "
    "that runs almost from the bottom slab band to the top, with a thin transom bar near the top and "
    "a low kick plate at the bottom. " + FACADE.split(". ", 1)[1]
)

# name -> (kind, description, reference name or None)
TEXTURES = {
    "facade-office": ("facade", "a modern office building curtain wall: slim light grey aluminium "
                      "mullions framing one large blue-grey glass pane with a subtle soft sky "
                      "reflection, and a light grey aluminium spandrel panel band at the bottom", None),
    "facade-campus": ("facade", "a university building facade: smooth continuous light warm-grey "
                      "render wall without any panel joints or vertical lines with one large punched rectangular window centred "
                      "horizontally (about 60% of the image width and 55% of its height, dark grey "
                      "glass, slim light-coloured frame, slim sill), plain wall at the left and "
                      "right edges, and a thin continuous horizontal concrete slab line running "
                      "the full width at the very bottom", None),
    "facade-brick": ("facade", "an older residential building: warm red-brown brick wall in running "
                     "bond with light mortar, one large white-framed rectangular window centred "
                     "horizontally (about 50% of the image width and 55% of its height) with a "
                     "light stone sill, plain flat brick at the left and right edges (no piers, no "
                     "pilasters), and a thin continuous light concrete slab band running the full "
                     "width at the very bottom", None),
    "facade-industrial": ("facade", "a factory hall: light grey vertical corrugated (trapezoidal) "
                          "metal cladding covering the wall, with one long horizontal ribbon window "
                          "strip high up running the full width of the image (edge to edge), and a "
                          "thin darker grey base band at the bottom", None),
    "facade-ground-office": ("ground", "", "facade-office"),
    "facade-office-night": ("night", "", "facade-office"),
    "facade-campus-night": ("night", "", "facade-campus"),
    "roof-flat": ("top", "a flat roof covered with light grey fine gravel over a membrane, with faint "
                  "straight membrane seams", None),
    "roof-green": ("top", "an extensive green roof planted with low sedum, muted soft green and "
                   "olive tones with a few reddish patches, even coverage", None),
    "plinth": ("top", "light warm-grey natural stone paving slabs in a regular rectangular pattern "
               "with thin joints, about 4 by 4 slabs", None),
    "ground-grass": ("top", "a mown lawn, soft muted green short grass, very even", None),
    "ground-asphalt": ("top", "plain light grey asphalt road surface with fine aggregate, no road "
                       "markings, no cracks", None),
    "ground-pavement": ("top", "light grey square concrete pavers with thin joints, about 6 by 6 "
                        "pavers", None),
}


def prompt_for(kind: str, what: str) -> str:
    return {"facade": FACADE.format(what=what), "top": TOPDOWN.format(what=what), "night": NIGHT,
            "ground": GROUND_FLOOR}[kind]


def crossfade_wrap(tex: np.ndarray, axis: int, k: int) -> np.ndarray:
    """Make one axis wrap: blend the last k rows/columns into the first k and drop them."""
    tex = np.moveaxis(tex, axis, 0)
    n = tex.shape[0]
    w = np.linspace(0, 1, k)[:, None, None]
    head = tex[n - k:] * (1 - w) + tex[:k] * w
    out = np.concatenate([head, tex[k:n - k]], axis=0)
    return np.moveaxis(out, 0, axis)


def seamless_both(img: Image.Image) -> Image.Image:
    """Top-down textures: blend with a half-offset copy (same as generate_textures.py)."""
    tex = np.array(img.resize((SIZE, SIZE), Image.LANCZOS)).astype(float)
    shifted = np.roll(np.roll(tex, SIZE // 2, axis=0), SIZE // 2, axis=1)
    ramp = 1 - np.abs(np.linspace(-1, 1, SIZE))
    weight = np.minimum(ramp[:, None], ramp[None, :])[..., None]
    return Image.fromarray((tex * weight + shifted * (1 - weight)).clip(0, 255).astype(np.uint8))


def best_period(tex: np.ndarray, search: int, half: int = 6) -> tuple[int, int]:
    """Columns x0 < x1 near the left/right edges such that cropping [x0, x1) gives one clean
    horizontal period: what lies left of x1 should look like what lies left of x0 (and, where the
    image allows, the same to the right), so no mullion or joint is doubled or cut at the seam."""
    gray = tex.mean(axis=2)
    w = gray.shape[1]
    best, pair = np.inf, (0, w)
    for x0 in range(half, search):
        left = gray[:, x0 - half:x0]
        right = gray[:, x0:x0 + half]
        for x1 in range(w - search, w + 1):
            terms = [np.mean((left - gray[:, x1 - half:x1]) ** 2)]
            if x1 + half <= w:
                terms.append(np.mean((right - gray[:, x1:x1 + half]) ** 2))
            cost = np.mean(terms) + 0.05 * (x0 + w - x1)
            if cost < best:
                best, pair = cost, (x0, x1)
    return pair


def seamless_facade(img: Image.Image) -> Image.Image:
    """Facades: crop to a matched horizontal period plus a short edge crossfade, so the window stays
    crisp and the slab band stays at the bottom."""
    tex = np.array(img.resize((SIZE, SIZE), Image.LANCZOS)).astype(float)
    x0, x1 = best_period(tex, SIZE // 8)
    # Blend the last k columns of the crop into the k columns that precede x0 in the original, so
    # the seam continues exactly into the start of the next repeat.
    k = min(6, x0)
    crop = tex[:, x0:x1].copy()
    w = np.linspace(0, 1, k)[None, :, None]
    crop[:, -k:] = crop[:, -k:] * (1 - w) + tex[:, x0 - k:x0] * w
    tex = crop
    tex = crossfade_wrap(tex, axis=0, k=SIZE // 64)
    out = Image.fromarray(tex.clip(0, 255).astype(np.uint8))
    return out.resize((SIZE, SIZE), Image.LANCZOS)


def tiled(img: Image.Image) -> Image.Image:
    sheet = Image.new("RGB", (img.width * 2, img.height * 2))
    for x in (0, img.width):
        for y in (0, img.height):
            sheet.paste(img, (x, y))
    return sheet


def contact_sheet() -> None:
    cell, cols = 260, 5
    names = [n for n in TEXTURES if (OUT / f"{n}.jpg").exists()]
    rows = (len(names) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * (cell + 20)), "#eef1e8")
    draw = ImageDraw.Draw(sheet)
    for i, name in enumerate(names):
        x, y = (i % cols) * cell, (i // cols) * (cell + 20)
        tile = tiled(Image.open(OUT / f"{name}.jpg")).resize((cell - 20, cell - 20), Image.LANCZOS)
        sheet.paste(tile, (x + 10, y + 5))
        draw.text((x + 10, y + cell - 10), name, fill="#233020")
    sheet.save(WORK / "contact.png")


def main() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    PREVIEW.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    client = genai.Client(vertexai=True, project=sys.argv[1], location="global")
    for name in sys.argv[2:] or list(TEXTURES):
        kind, what, ref = TEXTURES[name]
        raw = WORK / f"{name}.png"
        if not raw.exists():
            print(f"{name}…", flush=True)
            generate(client, prompt_for(kind, what), raw, WORK / f"{ref}.png" if ref else None)
        img = Image.open(raw).convert("RGB")
        tex = seamless_both(img) if kind == "top" else seamless_facade(img)
        tex.save(OUT / f"{name}.jpg", quality=85, optimize=True)
        tiled(tex).resize((SIZE, SIZE), Image.LANCZOS).save(PREVIEW / f"{name}.png")
    contact_sheet()
    print(f"{len(list(OUT.glob('*.jpg')))} textures in {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
