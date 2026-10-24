# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = ["google-genai>=1.40", "pillow>=11", "numpy>=2"]
# ///
"""
Seamless floor textures, one per floor material (which room types get which is in
website/src/lib/buildings/geometry.ts). They are light and low in contrast because the viewer
multiplies them with the room-type color.

    uv run tools/art/generate_textures.py <gcp-project> [name ...]

Raw images are cached in tools/art/out/textures/ (delete one to regenerate it).
Writes website/public/art/textures/<name>.jpg (512 px, tiles in both directions). ~$0.05 each.
"""

import sys
from pathlib import Path

import numpy as np
from google import genai
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from generate_icons import generate  # noqa: E402

TOOLS = Path(__file__).parent
REPO = TOOLS.parent.parent
WORK = TOOLS / "out" / "textures"
OUT = REPO / "website" / "public" / "art" / "textures"
SIZE = 512

COMMON = (
    "A seamless tileable texture of {what}, seen exactly head-on (orthographic, no perspective), "
    "filling the whole square image edge to edge. Flat, even, shadowless lighting, light and fairly "
    "low in contrast, slightly desaturated, realistic but clean. No objects, no text, no vignette, "
    "no borders."
)
MATERIALS = {
    "epoxy": "a light gray factory floor with smooth epoxy coating, faint trowel marks and subtle speckles",
    "carpet": "light gray low-pile office carpet tiles with a fine woven texture, about 4 by 4 tiles",
    "parquet": "light natural oak parquet planks laid in a straight pattern, about 8 planks across",
    "tiles": "small square white ceramic floor tiles with light gray grout, about 12 by 12 tiles",
    "terrazzo": "light warm-white terrazzo floor with small gray and beige chips",
    "vinyl": "seamless light gray-white laboratory vinyl flooring with faint subtle mottling",
    "concrete": "smooth light gray polished concrete floor with faint subtle variation",
    "decking": "light weathered wooden outdoor decking boards, about 6 boards across",
    # Walls: seen straight on instead of from above.
    "plaster": "a smooth warm-white painted interior plaster wall seen straight on, very subtle trowel texture and faint matte grain",
}


def seamless(path: Path) -> Image.Image:
    """Make the texture tile in both directions by blending it with a half-offset copy."""
    tex = np.array(Image.open(path).convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)).astype(float)
    shifted = np.roll(np.roll(tex, SIZE // 2, axis=0), SIZE // 2, axis=1)
    ramp = 1 - np.abs(np.linspace(-1, 1, SIZE))
    weight = np.minimum(ramp[:, None], ramp[None, :])[..., None]
    return Image.fromarray((tex * weight + shifted * (1 - weight)).clip(0, 255).astype(np.uint8))


def main() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    client = genai.Client(vertexai=True, project=sys.argv[1], location="global")
    for name in sys.argv[2:] or list(MATERIALS):
        raw = WORK / f"{name}.png"
        if not raw.exists():
            print(f"{name}…")
            generate(client, COMMON.format(what=MATERIALS[name]), raw, None)
        seamless(raw).save(OUT / f"{name}.jpg", quality=85, optimize=True)
    print(f"{len(list(OUT.glob('*.jpg')))} textures in {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
