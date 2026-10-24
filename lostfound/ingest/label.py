"""Read room numbers on image plans with Claude: one small crop per room, centred where the label is drawn,
many crops per request. The model only reads text; it never places geometry (see the research notes).

Used for plans without readable text (PNG). Costs roughly $0.01-0.02 per 30 rooms with Sonnet."""

import base64
import json
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic
import cv2

MODEL = "claude-sonnet-5-5"
CROP_HALF = (40, 14)   # pixels around the label anchor (labels are short room numbers)
UPSCALE = 4
BATCH = 30
SCHEMA = {
    "type": "object",
    "properties": {
        "labels": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"index": {"type": "integer"}, "text": {"type": "string"}},
                "required": ["index", "text"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["labels"],
    "additionalProperties": False,
}
PROMPT = """Each image is a crop of a floor plan centred on one room. Read the room label printed in the middle \
of the crop (usually a room number such as 0.21, N2148A or -1.03). Copy it exactly. If there is no label in the \
middle, return an empty string. Return one entry per image index."""


def _crop(image, x: float, y: float) -> bytes:
    h, w = image.shape[:2]
    dx, dy = CROP_HALF
    x0, x1 = max(0, int(x - dx)), min(w, int(x + dx))
    y0, y1 = max(0, int(y - dy)), min(h, int(y + dy))
    crop = cv2.resize(image[y0:y1, x0:x1], None, fx=UPSCALE, fy=UPSCALE, interpolation=cv2.INTER_CUBIC)
    return cv2.imencode(".png", crop)[1].tobytes()


def _read_batch(client: anthropic.Anthropic, crops: list[bytes]) -> tuple[list[str], dict]:
    content: list[dict] = []
    for index, data in enumerate(crops):
        content.append({"type": "text", "text": f"Image {index}:"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.b64encode(data).decode()}})
    content.append({"type": "text", "text": PROMPT})
    response = client.messages.create(
        model=MODEL,
        max_tokens=4000,
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": content}],
    )
    text = next(block.text for block in response.content if block.type == "text")
    found = {item["index"]: item["text"].strip() for item in json.loads(text)["labels"]}
    usage = {"input_tokens": response.usage.input_tokens, "output_tokens": response.usage.output_tokens}
    return [found.get(index, "") for index in range(len(crops))], usage


def label_rooms(building: dict, directory: Path, client: anthropic.Anthropic | None = None) -> dict:
    """Fill `ref` (and the name) of spaces imported from images. Returns token usage."""
    client = client or anthropic.Anthropic()
    level_of = {floor["id"]: floor["level"] for floor in building["floors"]}
    jobs: list[tuple[dict, bytes]] = []
    images: dict[int, object] = {}
    for space in building["spaces"]:
        if space.get("ref") or "label_px" not in space:
            continue
        level = level_of[space["floor_id"]]
        if level not in images:
            path = directory / f"floor_{level}_plain.png"
            path = path if path.exists() else directory / f"floor_{level}.png"
            images[level] = cv2.imread(str(path))
        if images[level] is None:
            continue
        x, y = space["label_px"]
        jobs.append((space, _crop(images[level], x, y)))
    usage = {"input_tokens": 0, "output_tokens": 0}
    batches = [jobs[i:i + BATCH] for i in range(0, len(jobs), BATCH)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda batch: _read_batch(client, [crop for _, crop in batch]), batches))
    for batch, (texts, used) in zip(batches, results):
        for key in usage:
            usage[key] += used[key]
        for (space, _), text in zip(batch, texts):
            if text and re.fullmatch(r"[\w.\-/ ]{1,24}", text):
                space["ref"] = text
                space["name"] = f"{space['room_type'].replace('_', ' ').capitalize()} {text}"
    for space in building["spaces"]:
        space.pop("label_px", None)
    return usage
