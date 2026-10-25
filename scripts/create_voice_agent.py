"""Create (or update) the ElevenLabs voice agent for the web app's live voice bubble.

  uv run --env-file .env python scripts/create_voice_agent.py

The agent speaks with the person and drives the app through client tools that run in the browser (see
website/src/components/voice/voice-agent.tsx): it hands building questions to our own Claude agent (ask_building)
and starts simulations, opens floors, reports incidents and calls the fire brigade directly. Writes
ELEVENLABS_AGENT_ID to .env. Needs ELEVENLABS_API_KEY (never printed)."""

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.elevenlabs.io/v1/convai"
ENV = Path(__file__).resolve().parent.parent / ".env"

PROMPT = """You are the fire co-pilot of Lost & Found: the voice in the ear of firefighters in a life-and-death
situation. You operate the building map with your tools.

How you speak (strict):
- At most one short sentence, under 12 words. Like radio: "Lab 4.10, floor 4. Route is on the map."
- No greetings, no small talk, no filler ("sure", "great question", "let me check"), no explanations.
- Never ask the crew anything. Never ask to confirm. If something is unclear, take the most likely room and act.
- Act immediately: call the tool, then say only the result.
- If the plans cannot tell, say "Unknown in the plans." Never invent rooms, distances or routes.

Tools:
- ask_building: every question or report about the building (where the fire is, which entrance, route to a room,
  nearest exit, above/below, room size, extinguishers, panels, labs, people inside; "staircase 2 is full of smoke").
  Pass the crew's words. It returns a short answer: say it as it is.
- simulate: start a fire (or water or power) scenario in a room.
- show_floor: open a floor or the whole building.
- report_incident: raise a real incident in a room.
- call_fire_brigade: start the response for the open incident or simulation.
- clear_map: remove routes and highlights."""

TOOLS = [
    {"name": "ask_building", "description": "Ask the building agent a question or give it an instruction about the building; returns its answer.",
     "expects_response": True, "response_timeout_secs": 60,
     "parameters": {"type": "object", "properties": {"question": {"type": "string", "description": "The person's question or instruction, in full."}}, "required": ["question"]}},
    {"name": "simulate", "description": "Start a simulation of a fire, water leak or power fault in a room.", "expects_response": True, "response_timeout_secs": 30,
     "parameters": {"type": "object", "properties": {
         "hazard": {"type": "string", "description": "fire, water or electrical"},
         "room": {"type": "string", "description": "Room name or number, e.g. 'Seminar room 3.25' or '3.25'."}}, "required": ["hazard", "room"]}},
    {"name": "show_floor", "description": "Open a floor on the map, or the whole building.", "expects_response": True, "response_timeout_secs": 10,
     "parameters": {"type": "object", "properties": {"floor": {"type": "string", "description": "e.g. '3', 'ground floor', 'basement', 'whole building'."}}, "required": ["floor"]}},
    {"name": "report_incident", "description": "Raise a live incident (alarm for everyone) in a room.", "expects_response": True, "response_timeout_secs": 20,
     "parameters": {"type": "object", "properties": {
         "hazard": {"type": "string", "description": "fire, water or electrical"},
         "room": {"type": "string", "description": "Room name or number."}}, "required": ["hazard", "room"]}},
    {"name": "call_fire_brigade", "description": "Start the response for the open incident or simulation (calls the fire brigade and the other contacts).",
     "expects_response": True, "response_timeout_secs": 10, "parameters": {"type": "object", "properties": {}, "required": []}},
    {"name": "clear_map", "description": "Remove routes and highlights from the map.", "expects_response": False,
     "parameters": {"type": "object", "properties": {}, "required": []}},
]


def request(method: str, path: str, body: dict | None = None) -> dict:
    key = os.environ["ELEVENLABS_API_KEY"]
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={"xi-api-key": key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        sys.exit(f"ElevenLabs {method} {path}: {error.code} {error.read().decode()[:600]}")


def main() -> None:
    if not os.environ.get("ELEVENLABS_API_KEY"):
        sys.exit("Set ELEVENLABS_API_KEY in .env and run with --env-file .env.")
    config = {
        "name": "Lost & Found fire co-pilot",
        "conversation_config": {
            "agent": {
                "first_message": "What's the emergency?",
                "language": "en",
                "prompt": {"prompt": PROMPT, "tools": [{"type": "client", **tool} for tool in TOOLS]},
            },
            # Full-band audio and light latency optimisation: the defaults (16 kHz, level 3) sound like a phone line.
            "tts": {"agent_output_audio_format": "pcm_44100", "optimize_streaming_latency": 1},
        },
    }
    existing = os.environ.get("ELEVENLABS_AGENT_ID")
    if existing:
        request("PATCH", f"/agents/{existing}", config)
        print(f"updated agent {existing}")
        return
    agent_id = request("POST", "/agents/create", config)["agent_id"]
    text = ENV.read_text() if ENV.exists() else ""
    text = re.sub(r"^ELEVENLABS_AGENT_ID=.*\n?", "", text, flags=re.M).rstrip("\n") + f"\nELEVENLABS_AGENT_ID={agent_id}\n"
    ENV.write_text(text)
    print(f"created agent {agent_id} (saved to .env)")


if __name__ == "__main__":
    main()
