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

PROMPT = """You are the voice of Lost & Found, a building operations assistant for facility managers and fire safety
teams. You talk with the person in real time and operate the app for them with your tools. Keep spoken answers short
(one or two sentences) and say what you are showing ("I've opened floor 3", "the fire brigade route is on the map").

Tools:
- ask_building: any question about the building (where something is, routes, step-free, rooms above/below, areas,
  moving a door or object, closing a door). Pass the person's words as the question; read the answer back briefly.
- simulate: start a fire, water or power simulation in a room ("what if a fire starts in seminar room 3.25").
- show_floor: open a floor ("show me floor 2", "the basement", "whole building").
- report_incident: raise a real incident in a room (fire, water or electrical).
- call_fire_brigade: in an open fire incident or simulation, start the response (calls the fire brigade).
- clear_map: remove routes and highlights from the map.
If a room name is unclear, ask once. Never invent room names: ask_building can look them up. For anything about fire,
evacuation or how the fire brigade gets in, start a fire simulation in the named room; the map then shows the spread,
the people walking out and the fire brigade route."""

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
        "name": "Lost & Found building operations",
        "conversation_config": {
            "agent": {
                "first_message": "Hi, I'm your building assistant. Ask me about the building, or say for example: simulate a fire in seminar room 3.25.",
                "language": "en",
                "prompt": {"prompt": PROMPT, "tools": [{"type": "client", **tool} for tool in TOOLS]},
            },
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
