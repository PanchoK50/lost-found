"""Damage recognition: an employee's photo and/or words → hazard kind, severity and what to tell the responders.

One Claude vision call with a JSON schema. The room comes from the reporter (their location or the room they
picked); the model only says what it sees and, if the text names a place, which one."""

import base64
import json
import re

import anthropic

MODEL = "claude-opus-5-5"
SCHEMA = {
    "type": "object",
    "properties": {
        "is_damage": {"type": "boolean"},
        "hazard": {"type": "string", "enum": ["fire", "water", "electrical", "none"]},
        "severity": {"type": "integer", "enum": [1, 2, 3]},
        "confidence": {"type": "number"},
        "title": {"type": "string"},
        "description": {"type": "string"},
        "signs": {"type": "array", "items": {"type": "string"}},
        "immediate_danger": {"type": "boolean"},
        "place_hint": {"type": "string"},
    },
    "required": ["is_damage", "hazard", "severity", "confidence", "title", "description", "signs", "immediate_danger", "place_hint"],
    "additionalProperties": False,
}
PROMPT = """You check damage reports from employees in a building (office, campus, factory). Look at the photo \
(if any) and read the report (if any). Decide:
- hazard: "fire" (flames, smoke, soot, burning smell), "water" (leak, flooding, wet ceiling or floor, burst pipe), \
"electrical" (sparks, scorched socket or panel, exposed wires, power out, burning-plastic smell), or "none".
- severity: 1 = minor, contained (a drip, a scorch mark); 2 = spreading or damaging property (water on the floor, \
smoke in a room, a panel tripping); 3 = danger to people or the building (open flames, heavy smoke, flooding \
near electrics, live wires).
- immediate_danger: true if people must leave or the fire brigade is needed now.
- title: at most 6 words, e.g. "Water leaking from ceiling".
- description: one or two plain sentences for the responders about what is visible.
- signs: the concrete cues you used.
- place_hint: a room or place the report names (e.g. "kitchen 2nd floor"), else "".
Be calibrated: if the photo shows no damage, say so (is_damage false, hazard "none")."""

MEDIA_TYPES = {"png": "image/png", "jpeg": "image/jpeg", "jpg": "image/jpeg", "webp": "image/webp", "gif": "image/gif"}


def classify(photo_data_url: str | None = None, text: str | None = None, client: anthropic.Anthropic | None = None) -> dict:
    """`photo_data_url`: a data:image/...;base64,… URL (the app downscales photos to 800 px)."""
    if not photo_data_url and not (text or "").strip():
        raise ValueError("Send a photo or describe what you see.")
    content: list[dict] = []
    if photo_data_url:
        match = re.match(r"data:image/(\w+);base64,(.+)", photo_data_url, re.S)
        if not match or match.group(1).lower() not in MEDIA_TYPES:
            raise ValueError("The photo must be a PNG, JPEG, WebP or GIF data URL.")
        data = match.group(2)
        base64.b64decode(data, validate=False)
        content.append({"type": "image", "source": {"type": "base64", "media_type": MEDIA_TYPES[match.group(1).lower()], "data": data}})
    content.append({"type": "text", "text": f"{PROMPT}\n\nReport: {text.strip() if text else '(photo only)'}"})
    client = client or anthropic.Anthropic()
    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=2000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": content}],
    )
    usage = {"input_tokens": response.usage.input_tokens, "output_tokens": response.usage.output_tokens, "model": response.model}
    if response.stop_reason == "refusal":
        return {**_unknown("The image could not be assessed."), "usage": usage}
    text_block = next((block.text for block in response.content if block.type == "text"), "")
    try:
        result = json.loads(text_block)
    except json.JSONDecodeError:
        return {**_unknown("The assessment could not be read."), "usage": usage}
    result["confidence"] = max(0.0, min(1.0, float(result.get("confidence", 0))))
    return {**result, "usage": usage}


def _unknown(reason: str) -> dict:
    return {"is_damage": False, "hazard": "none", "severity": 1, "confidence": 0.0, "title": "Not assessed", "description": reason,
            "signs": [], "immediate_danger": False, "place_hint": ""}
