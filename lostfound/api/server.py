"""HTTP API for the web app (contract documented in lostfound/api/README.md).

  uv run --env-file .env uvicorn lostfound.api.server:app --reload --port 8000"""

import base64
import csv
import functools
import json
import os
import re
import tempfile
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from lostfound.agent.agent import AgentConfig, BuildingQA, ChatSession
from lostfound.api import storage
from lostfound.core.edits import apply_edits
from lostfound.ingest.assemble import assemble
from lostfound.ingest.verify import summary as issue_summary
from lostfound.ingest.verify import verify
from lostfound.core import directions
from lostfound.core.building import Building, MapError
from lostfound.core.campus import Catalog
from lostfound.core.resolve import Resolver
from lostfound.evals.variants import MODELS

REPO = Path(__file__).resolve().parents[2]
DATA = REPO / "data"
DEFAULT_CHAT_MODEL = os.environ.get("LOSTFOUND_CHAT_MODEL", "opus")
IMPORTED = REPO / "buildings"  # buildings created from floor plans (lostfound.ingest)

app = FastAPI(title="Lost & Found building agent", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

SESSIONS: dict[str, ChatSession] = {}


def building_directories() -> dict[str, Path]:
    directories = {path.parent.name: path.parent for path in DATA.glob("*/*/building.json")}
    directories.update({path.parent.name: path.parent for path in IMPORTED.glob("*/building.json")})
    return directories


def building_directory(building_id: str) -> Path | None:
    """Dataset buildings ship with the agent; uploaded ones are fetched from Supabase Storage on first use."""
    return building_directories().get(building_id) or storage.cached_directory(building_id)


@functools.lru_cache(maxsize=1)
def catalog() -> Catalog:
    """Every servable building, for cross-building questions (chat only; nothing else changes)."""
    return Catalog(building_directories())


def load(building_id: str) -> Building:
    """The building as it is now: the plan plus every edit made by conversation (stored in Supabase)."""
    directory = building_directory(building_id)
    if directory is None:
        raise HTTPException(404, f"Unknown building '{building_id}'.")
    base = Building.load(directory)
    changes = storage.load_edits(building_id)
    if not changes:
        return base
    data, closed = apply_edits(base.data, changes)
    building = Building(data, directory)  # its own walk cache: the edited plan differs from the file
    building.closed = closed
    return building


def session_building(building_id: str, session_id: str | None) -> Building:
    if session_id and session_id in SESSIONS:
        session = SESSIONS[session_id]
        if session.building.id != building_id:
            raise HTTPException(400, "Session belongs to another building.")
        return session.building
    return load(building_id)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "sessions": len(SESSIONS)}


@app.get("/buildings")
def buildings() -> list[dict]:
    manifest = {}
    if (DATA / "manifest.csv").exists():
        with (DATA / "manifest.csv").open(encoding="utf-8") as handle:
            manifest = {row["building_id"]: row for row in csv.DictReader(handle)}
    listing = []
    for building_id, directory in sorted(building_directories().items()):
        row = manifest.get(building_id, {})
        listing.append(
            {
                "id": building_id,
                "name": row.get("name", building_id),
                "split": row.get("split", "imported" if directory.parent == IMPORTED else directory.parent.name),
                "source": row.get("source", ""),
                "floors": int(row["floors"]) if row.get("floors") else None,
                "levels": row.get("levels", ""),
            }
        )
    return listing


@app.get("/buildings/{building_id}")
def building(building_id: str, session_id: str | None = None) -> dict:
    b = session_building(building_id, session_id)
    return {**b.data, "closed": sorted(b.closed)}


class SearchRequest(BaseModel):
    building_id: str
    query: str
    session_id: str | None = None


@app.post("/search")
def search(request: SearchRequest) -> dict:
    b = session_building(request.building_id, request.session_id)
    resolution = Resolver(b).space(request.query)
    return {"places": resolution.as_dict(8), "matches": b.search(request.query)[:30]}


class RouteRequest(BaseModel):
    building_id: str
    start: str = Field(description="Space id, room number or name")
    destination: str
    via: list[str] = []
    step_free: bool = False
    min_width_m: float | None = None
    forklift: bool = False
    closed: list[str] = []
    session_id: str | None = None


@app.post("/route")
def route(request: RouteRequest) -> dict:
    """Deterministic route (no LLM): length, per-floor polylines for the map, steps with landmarks."""
    b = session_building(request.building_id, request.session_id)
    resolver = Resolver(b)
    try:
        closed = [b.find_element(name) for name in request.closed]
        with b.temporarily_closed(*closed):
            return directions.route_details(
                b,
                resolver.space(request.start).best,
                resolver.space(request.destination).best,
                request.step_free,
                [resolver.space(stop).best for stop in request.via],
                request.min_width_m,
                request.forklift,
            )
    except MapError as error:
        raise HTTPException(422, str(error)) from error


class ChatRequest(BaseModel):
    building_id: str
    message: str
    session_id: str | None = None
    model: str = "opus"
    effort: str = "low"


@app.post("/chat")
def chat(request: ChatRequest) -> dict:
    """One conversational turn. Returns text plus highlights, a route to draw and edits made this turn."""
    session_id = request.session_id or uuid.uuid4().hex
    if session_id not in SESSIONS:
        config = AgentConfig(design="chat", model=MODELS.get(request.model, request.model), effort=request.effort)
        SESSIONS[session_id] = ChatSession(load(request.building_id), config, catalog=catalog())
    session = SESSIONS[session_id]
    if session.building.id != request.building_id:
        raise HTTPException(400, "Session belongs to another building.")
    return {"session_id": session_id, **session.ask(request.message)}


class UIChatRequest(BaseModel):
    """The web viewer's ChatRequest (website/src/lib/chat/contract.ts) plus the backend session id."""

    buildingId: str
    message: str
    sessionId: str | None = None
    closed: list[str] = []  # openings, stairs, lifts or rooms reported closed in the world layer
    # Earlier turns as text. Serverless instances do not keep memory, so a session that is gone is rebuilt
    # from this (the reply text is kept; edits made in a lost session are not replayed).
    history: list[dict] = []
    location: str | None = None  # the room the person picked as "I'm here"
    # What the person selected on the model (a chip in the chat): {"kind": "asset" | "opening" | "space", "id": "..."}.
    selection: dict | None = None
    model: str = DEFAULT_CHAT_MODEL
    effort: str = "low"


@app.post("/ui/chat")
def ui_chat(request: UIChatRequest) -> dict:
    """One chat turn in the viewer's ChatResponse shape: kind, reply, answer card, scene."""
    session_id = request.sessionId or uuid.uuid4().hex
    if session_id not in SESSIONS:
        config = AgentConfig(design="chat", model=MODELS.get(request.model, request.model), effort=request.effort)
        SESSIONS[session_id] = ChatSession(load(request.buildingId), config, catalog=catalog())
        SESSIONS[session_id].seed_history(request.history)
    session = SESSIONS[session_id]
    if session.building.id != request.buildingId:
        raise HTTPException(400, "Session belongs to another building.")
    session.set_world_closures(request.closed)
    turn = session.ask(request.message, request.location, request.selection)
    ui = turn["ui"]
    return {
        "kind": ui["kind"],
        "reply": turn["text"],
        **({"answer": ui["answer"]} if ui.get("answer") else {}),
        "scene": ui["scene"],
        "sessionId": session_id,
        "source": "agent",
        "cost": turn["cost"],
        "toolCalls": turn["tool_calls"],
        "edits": turn["edits"],
    }


class EditRequest(BaseModel):
    building_id: str
    session_id: str
    action: str = Field(description="close | reopen | add_door | move_asset")
    element: str | None = None
    first: str | None = None
    second: str | None = None
    width_m: float = 0.9
    step_free: bool = True
    asset: str | None = None
    to_room: str | None = None


@app.post("/edit")
def edit(request: EditRequest) -> dict:
    """Direct edits from UI controls (no LLM); they apply to the chat session's copy of the building."""
    if request.session_id not in SESSIONS:
        config = AgentConfig(design="chat")
        SESSIONS[request.session_id] = ChatSession(load(request.building_id), config, catalog=catalog())
    toolbox = SESSIONS[request.session_id].toolbox
    try:
        match request.action:
            case "close" | "reopen":
                return toolbox.tool_set_closed(request.element or "", request.action == "close")
            case "add_door":
                return toolbox.tool_add_door(request.first or "", request.second or "", request.width_m, request.step_free)
            case "move_asset":
                return toolbox.tool_move_asset(request.asset or "", request.to_room or "")
    except MapError as error:
        raise HTTPException(422, str(error)) from error
    raise HTTPException(400, f"Unknown action '{request.action}'.")


class AskRequest(BaseModel):
    building_id: str
    question: str
    design: str = "hybrid"
    model: str = "opus"


@app.post("/ask")
def ask(request: AskRequest) -> dict:
    """Benchmark-style single answer (ends with an 'Answer:' line)."""
    directory = building_directory(request.building_id)
    if directory is None:
        raise HTTPException(404, f"Unknown building '{request.building_id}'.")
    qa = BuildingQA(AgentConfig(design=request.design, model=MODELS.get(request.model, request.model)))
    outcome = qa.answer_question(directory, request.question)
    return {"reply": outcome.reply, "path": outcome.path, "tool_calls": outcome.tool_calls, "cost": round(outcome.cost(), 4)}


class IngestFile(BaseModel):
    name: str
    content: str  # SVG text, or base64 for PNG
    encoding: str = "text"  # text | base64
    level: int | None = None


class IngestRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    files: list[IngestFile] = Field(min_length=1, max_length=20)
    created_by: str | None = None


@app.post("/ingest")
def ingest(request: IngestRequest) -> dict:
    """Create a building from floor-plan SVGs (one per floor): geometry, rooms, doors, stairs and lifts, inferred
    room types and door widths, then the verifier's list of what to check. Stored in Supabase."""
    # A ready-made building.json (the challenge format, e.g. the Sunday building) is imported as it is.
    for upload in request.files:
        if upload.name.lower().endswith(".json") and upload.encoding != "base64":
            return import_building_json(upload.content, request.name, request.created_by)
    building_id = storage.new_building_id(request.name)
    with tempfile.TemporaryDirectory() as scratch:
        written: set[str] = set()
        floors_seen = 0
        for index, upload in enumerate(request.files):
            name = upload.name.lower()
            if not name.endswith((".svg", ".png")):
                continue  # other files of a building folder (equipment.csv, questions …) are not plans
            match = re.search(r"floor[_ -]?(-?\d+)", name)
            level = upload.level if upload.level is not None else int(match.group(1)) if match else index
            plain = "_plain" in name
            target = f"floor_{level}{'_plain' if plain else ''}.{'svg' if name.endswith('.svg') else 'png'}"
            if target in written:
                raise HTTPException(400, f"Two files are for floor {level}. Name them floor_<level>.svg / .png or set the levels.")
            written.add(target)
            floors_seen += 1
            if upload.encoding == "base64":
                data = base64.b64decode(upload.content)
                if not data.startswith(b"\x89PNG"):
                    raise HTTPException(400, f"{upload.name} is not a PNG image. Use SVG or PNG floor plans.")
                (Path(scratch) / target).write_bytes(data)
            else:
                if "<svg" not in upload.content[:2000]:
                    raise HTTPException(400, f"{upload.name} is not an SVG floor plan. Use SVG or PNG floor plans.")
                (Path(scratch) / target).write_text(upload.content, encoding="utf-8")
        if not floors_seen:
            raise HTTPException(400, "No floor plans found. Upload floor_<level>.svg or .png files, or a building.json.")
        try:
            building = assemble(Path(scratch), building_id=building_id, name=request.name)
        except Exception as error:  # noqa: BLE001 - report any parse failure to the uploader
            raise HTTPException(422, f"Could not read the plans: {error}") from error
        if any(space.get("label_px") for space in building["spaces"]):
            # Image plans: room numbers are pixels, so Claude reads them from one small crop per room.
            try:
                from lostfound.ingest.label import label_rooms

                label_rooms(building, Path(scratch))
            except Exception as error:  # noqa: BLE001 - labels are a bonus; the building works without them
                building["ingest_report"]["assumptions"].append(f"room numbers could not be read: {error}")
                for space in building["spaces"]:
                    space.pop("label_px", None)
    if not building["spaces"]:
        raise HTTPException(422, "No rooms found in these plans.")
    issues = verify(building)
    building["ingest_report"]["issues"] = issues
    storage.save_upload(building, request.created_by)
    return {
        "id": building_id,
        "name": request.name,
        "floors": len(building["floors"]),
        "spaces": len(building["spaces"]),
        "doors": len(building["openings"]),
        "connectors": len(building["vertical_connectors"]),
        "issues": issue_summary(issues),
        "questions": [issue["question"] for issue in issues if issue["question"] and issue["severity"] == "high"][:5],
        "assumptions": building["ingest_report"].get("assumptions", []),
    }


def import_building_json(content: str, name: str, created_by: str | None) -> dict:
    """Import a building.json in the challenge format as it is (keeps its id, so its questions' ids still match)."""
    try:
        building = json.loads(content)
        info, floors, spaces = building["building"], building["floors"], building["spaces"]
        building.setdefault("openings", []); building.setdefault("vertical_connectors", []); building.setdefault("assets", [])
        Building(building)  # indexes everything: fails on a broken file
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(400, f"That building.json is not in the challenge format: {error}") from error
    building_id = str(info.get("id") or storage.new_building_id(name))
    if not re.fullmatch(r"[\w.-]{1,120}", building_id):
        raise HTTPException(400, "The building id may only contain letters, digits, '.', '_' and '-'.")
    if building_id in building_directories():
        raise HTTPException(409, f"Building {building_id} already exists.")
    info["id"] = building_id
    info["name"] = info.get("name") or name
    storage.save_upload(building, created_by)
    return {
        "id": building_id, "name": info["name"], "floors": len(floors), "spaces": len(spaces),
        "doors": len(building["openings"]), "connectors": len(building["vertical_connectors"]),
        "issues": {"issues": 0, "by_field": {}, "high": 0}, "questions": [], "assumptions": ["imported from building.json as it is"],
    }


# ---------- hazards: fire, water, electrical ----------

from lostfound.hazards import classify as hazard_classify  # noqa: E402
from lostfound.hazards import evacuation as hazard_evacuation  # noqa: E402
from lostfound.hazards import firefighting as hazard_firefighting  # noqa: E402
from lostfound.hazards import impact as hazard_impact  # noqa: E402
from lostfound.hazards import playbooks as hazard_playbooks  # noqa: E402
from lostfound.hazards import readiness as hazard_readiness  # noqa: E402
from lostfound.hazards import spread as hazard_spread  # noqa: E402
from lostfound.hazards.model import HAZARDS, sensors as hazard_sensors  # noqa: E402


class SimulateRequest(BaseModel):
    building_id: str
    hazard: str
    space_id: str
    minutes: float = 30.0
    severity: int = 2
    evacuate_at_min: float = 3.0
    contacts: list[dict] | None = None


@app.post("/hazards/simulate")
def simulate_hazard(request: SimulateRequest) -> dict:
    """What happens if `hazard` starts in `space_id`: spread over time, rooms and assets hit, evacuation (fire)
    and the response playbook. Pure computation: nothing is stored, nobody is called."""
    if request.hazard not in HAZARDS:
        raise HTTPException(400, f"hazard must be one of {', '.join(HAZARDS)}")
    building = load(request.building_id)
    if request.space_id not in building.spaces:
        raise HTTPException(400, f"Unknown room '{request.space_id}'.")
    minutes = max(1.0, min(request.minutes, 120.0))
    result = hazard_spread.simulate(building, request.hazard, request.space_id, minutes)
    summary = hazard_impact.impact(building, result)
    evacuation = hazard_evacuation.evacuate(building, result, request.evacuate_at_min)
    attack = hazard_firefighting.attack_route(building, result)
    return {
        "building_id": request.building_id, "simulation": result, "impact": summary, "evacuation": evacuation,
        "playbook": hazard_playbooks.plan(building, summary, evacuation, request.severity, request.contacts), "firefighting": attack,
    }


class ClassifyRequest(BaseModel):
    photo: str | None = None  # data URL
    text: str | None = None


@app.post("/hazards/classify")
def classify_damage(request: ClassifyRequest) -> dict:
    """Damage recognition from an employee's photo and/or words (one Claude vision call)."""
    try:
        return hazard_classify.classify(request.photo, request.text)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@app.get("/hazards/readiness")
def building_readiness(building_id: str) -> dict:
    return hazard_readiness.readiness(load(building_id))


@app.get("/hazards/sensors")
def building_sensors(building_id: str) -> dict:
    return {"building_id": building_id, "sensors": hazard_sensors(load(building_id)), "contacts": hazard_playbooks.DEFAULT_CONTACTS}


# ---------- fire brigade edition (docs/BRIGADE_BRIEF.md) ----------

from lostfound.hazards import brigade as hazard_brigade  # noqa: E402


class BriefingRequest(BaseModel):
    building_id: str
    origin: str
    t_now_min: float = 4.0
    eta_min: float = 8.0
    horizon_min: float = 30.0


@app.post("/brigade/briefing")
def brigade_briefing(request: BriefingRequest) -> dict:
    try:
        return hazard_brigade.briefing(load(request.building_id), request.origin, request.t_now_min, request.eta_min, request.horizon_min)
    except MapError as error:
        raise HTTPException(400, str(error)) from error


@app.get("/brigade/people")
def brigade_people(building_id: str, origin: str, t: float = 4.0) -> dict:
    try:
        return hazard_brigade.people(load(building_id), origin, t)
    except MapError as error:
        raise HTTPException(400, str(error)) from error


class CrewRoutesRequest(BaseModel):
    building_id: str
    origin: str
    t_arrival: float = 12.0
    start_opening: str | None = None
    targets: list[dict]


@app.post("/brigade/routes")
def brigade_routes(request: CrewRoutesRequest) -> dict:
    try:
        return hazard_brigade.routes(load(request.building_id), request.origin, request.t_arrival, request.targets, request.start_opening)
    except MapError as error:
        raise HTTPException(400, str(error)) from error


@app.get("/brigade/scenario/default")
def brigade_scenario() -> dict:
    return {"building_id": "proc-campus-test-005", "origin": "proc-campus-test-005-F3-S025", "alarm_clock": "10:42", "t_now_min": 4, "eta_min": 8}
