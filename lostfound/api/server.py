"""HTTP API for the web app (contract documented in lostfound/api/README.md).

  source .envrc && uv run uvicorn lostfound.api.server:app --reload --port 8000"""

import csv
import os
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from lostfound.agent.agent import AgentConfig, BuildingQA, ChatSession
from lostfound.core import directions
from lostfound.core.building import Building, MapError
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


def load(building_id: str) -> Building:
    directory = building_directories().get(building_id)
    if directory is None:
        raise HTTPException(404, f"Unknown building '{building_id}'.")
    return Building.load(directory)


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
        SESSIONS[session_id] = ChatSession(load(request.building_id), config)
    session = SESSIONS[session_id]
    if session.building.id != request.building_id:
        raise HTTPException(400, "Session belongs to another building.")
    return {"session_id": session_id, **session.ask(request.message)}


class UIChatRequest(BaseModel):
    """The web viewer's ChatRequest (website/src/lib/chat/contract.ts) plus the backend session id."""

    buildingId: str
    message: str
    sessionId: str | None = None
    model: str = DEFAULT_CHAT_MODEL
    effort: str = "low"


@app.post("/ui/chat")
def ui_chat(request: UIChatRequest) -> dict:
    """One chat turn in the viewer's ChatResponse shape: kind, reply, answer card, scene."""
    session_id = request.sessionId or uuid.uuid4().hex
    if session_id not in SESSIONS:
        config = AgentConfig(design="chat", model=MODELS.get(request.model, request.model), effort=request.effort)
        SESSIONS[session_id] = ChatSession(load(request.buildingId), config)
    session = SESSIONS[session_id]
    if session.building.id != request.buildingId:
        raise HTTPException(400, "Session belongs to another building.")
    turn = session.ask(request.message)
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
        SESSIONS[request.session_id] = ChatSession(load(request.building_id), config)
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
    directory = building_directories().get(request.building_id)
    if directory is None:
        raise HTTPException(404, f"Unknown building '{request.building_id}'.")
    qa = BuildingQA(AgentConfig(design=request.design, model=MODELS.get(request.model, request.model)))
    outcome = qa.answer_question(directory, request.question)
    return {"reply": outcome.reply, "path": outcome.path, "tool_calls": outcome.tool_calls, "cost": round(outcome.cost(), 4)}
