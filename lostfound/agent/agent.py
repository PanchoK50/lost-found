"""The Claude agent: batch answers for the benchmark and chat sessions for the app.

Designs (the eval variants):
- typed:   resolver hints + typed tools per question kind (+ search/route)
- code:    resolver + run_python over the verified library
- hybrid:  typed tools first, run_python when nothing fits
- rules+:  the no-LLM template parser when it recognises the question, else hybrid (eval comparison only; not
           used for answers, since hidden questions may resemble a template but mean something else)

Entry point for benchmark/evaluate.py:  --agent lostfound.agent.agent:answer"""

import os
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import anthropic

from benchmark.score import committed_answer
from lostfound.agent import rules
from lostfound.agent.format import answer_line
from lostfound.agent.prompts import BATCH_INSTRUCTIONS, CHAT_INSTRUCTIONS, building_summary, other_buildings_block
from lostfound.agent.tools import Toolbox
from lostfound.core.building import Building, MapError
from lostfound.core.campus import Catalog
from lostfound.core.resolve import Resolver
from lostfound.evals.variants import Outcome

DEFAULT_MODEL = os.environ.get("LOSTFOUND_MODEL", "claude-opus-5-5")
DEFAULT_EFFORT = os.environ.get("LOSTFOUND_EFFORT", "low")
DEFAULT_DESIGN = os.environ.get("LOSTFOUND_DESIGN", "hybrid")
FALLBACK_BETA = "server-side-fallback-2026-07-01"
FALLBACK_MODELS = {"claude-opus-5-5", "claude-sonnet-5-5"}
MAX_TOKENS = 16000
MAX_ITERATIONS = 12


@dataclass
class AgentConfig:
    design: str = DEFAULT_DESIGN
    model: str = DEFAULT_MODEL
    effort: str = DEFAULT_EFFORT
    excluded_kinds: frozenset[str] = field(default_factory=frozenset)


class ClaudeLoop:
    """Manual tool loop with usage accounting; shared by batch answers and chat sessions."""

    def __init__(self, config: AgentConfig, client: anthropic.Anthropic | None = None) -> None:
        self.config = config
        self.client = client or anthropic.Anthropic()

    def run(self, system: list[dict], messages: list[dict], toolbox: Toolbox, outcome: Outcome) -> str:
        extra = {}
        if self.config.model in FALLBACK_MODELS:
            extra = {"betas": [FALLBACK_BETA], "fallbacks": "default"}
        tools = toolbox.definitions()
        if tools:
            tools[-1] = {**tools[-1], "cache_control": {"type": "ephemeral"}}
        response = None
        api_seconds = tool_seconds = 0.0
        for _ in range(MAX_ITERATIONS):
            started = time.monotonic()
            response = self.client.beta.messages.create(
                model=self.config.model,
                max_tokens=MAX_TOKENS,
                system=system,
                tools=tools,
                messages=messages,
                output_config={"effort": self.config.effort},
                **extra,
            )
            api_seconds += time.monotonic() - started
            self._track(outcome, response)
            messages.append({"role": "assistant", "content": response.content})
            if response.stop_reason == "refusal":
                return "Sorry, I can't help with that request."
            calls = [block for block in response.content if block.type == "tool_use"]
            if response.stop_reason != "tool_use" or not calls:
                break
            results = []
            started = time.monotonic()
            for call in calls:
                outcome.tool_calls.append(call.name)
                text, is_error = toolbox.call(call.name, call.input)
                results.append({"type": "tool_result", "tool_use_id": call.id, "content": text, "is_error": is_error})
            tool_seconds += time.monotonic() - started
            messages.append({"role": "user", "content": results})
        outcome.notes["api_s"] = round(outcome.notes.get("api_s", 0) + api_seconds, 2)
        outcome.notes["tool_s"] = round(outcome.notes.get("tool_s", 0) + tool_seconds, 2)
        if response is None:
            return ""
        return "\n".join(block.text for block in response.content if block.type == "text").strip()

    def _track(self, outcome: Outcome, response) -> None:
        model = self.config.model
        usage = response.usage
        outcome.usage[f"{model}:input_tokens"] += usage.input_tokens
        outcome.usage[f"{model}:output_tokens"] += usage.output_tokens
        outcome.usage[f"{model}:cache_read_input_tokens"] += usage.cache_read_input_tokens or 0
        outcome.usage[f"{model}:cache_creation_input_tokens"] += usage.cache_creation_input_tokens or 0


def system_blocks(instructions: str, building: Building) -> list[dict]:
    return [
        {"type": "text", "text": instructions},
        {"type": "text", "text": "Building overview:\n" + building_summary(building), "cache_control": {"type": "ephemeral"}},
    ]


def mention_hints(building: Building, question: str) -> str:
    """Deterministic pre-resolution of the room names in the question (entity normalisation before the LLM)."""
    lines = []
    for mention in Resolver(building).mentions(question):
        ids = mention["space_ids"]
        labels = "; ".join(f"{space_id} = {building.label(space_id)}" for space_id in ids[:4])
        flag = " (AMBIGUOUS: several spaces share this name)" if len(ids) > 1 else ""
        lines.append(f"- '{mention['text']}' -> {labels}{flag}")
    return "Room mentions found in the question:\n" + "\n".join(lines) if lines else ""


class BuildingQA:
    """Batch mode: one fresh conversation per question; always ends with a committed 'Answer:' line."""

    def __init__(self, config: AgentConfig | None = None, client: anthropic.Anthropic | None = None) -> None:
        self.config = config or AgentConfig()
        self.loop = ClaudeLoop(self.config, client)

    def answer_item(self, item: dict) -> Outcome:
        return self.answer_question(Path(item["building_dir"]), item["question"])

    def answer_question(self, building_directory: Path, question: str) -> Outcome:
        building = Building.load(building_directory)
        design = self.config.design
        if design == "rules+":
            outcome = self._rules(building, question)
            if outcome is not None:
                return outcome
            design = "hybrid"
        return self._claude(building, question, design)

    def _rules(self, building: Building, question: str) -> Outcome | None:
        parsed = rules.parse(building, question)
        if parsed is None or parsed.kind in self.config.excluded_kinds:
            return None
        try:
            result = rules.solve(building, parsed)
        except MapError:
            return None
        line = answer_line(building, parsed.kind, result)
        return Outcome(reply=f"Computed {parsed.kind.replace('_', ' ')} from the plan.\n{line}", path="rules")

    def _claude(self, building: Building, question: str, design: str) -> Outcome:
        toolbox = Toolbox(building, design, self.config.excluded_kinds)
        outcome = Outcome(reply="", path=design)
        hints = mention_hints(building, question)
        content = question + (f"\n\n{hints}" if hints else "")
        reply = self.loop.run(system_blocks(BATCH_INSTRUCTIONS, building), [{"role": "user", "content": content}], toolbox, outcome)
        if committed_answer(reply) is None and toolbox.last_answer_line:
            reply = f"{reply}\n{toolbox.last_answer_line}".strip()
            outcome.notes["appended_answer_line"] = True
        outcome.reply = reply
        outcome.notes["resolutions"] = toolbox.resolutions[-4:]
        outcome.notes["result"] = toolbox.result_for(committed_answer(reply))
        return outcome


_DEFAULT_QA: BuildingQA | None = None


def answer(building_directory: Path, question_text: str) -> str:
    """benchmark/evaluate.py entry point (design/model/effort via LOSTFOUND_* environment variables)."""
    global _DEFAULT_QA
    if _DEFAULT_QA is None:
        _DEFAULT_QA = BuildingQA()
    return _DEFAULT_QA.answer_question(Path(building_directory), question_text).reply


def import_checks(building: Building) -> list[dict]:
    """For buildings created from plans: what the importer could not tell, so the agent can settle it by conversation."""
    issues = (building.data.get("ingest_report") or {}).get("issues") or []
    open_items = [i for i in issues if i.get("severity") in ("high", "medium") and i.get("question")][:15]
    if not open_items:
        return []
    lines = "\n".join(f"- [{i['field']}] {i['id']}: {i['message']} Ask: {i['question']}" for i in open_items)
    return [{"type": "text", "text": (
        "This building was just created from uploaded floor plans. The importer is unsure about these points:\n"
        f"{lines}\n"
        "When the person wants to check the import (or asks what is uncertain), go through them one at a time, most "
        "important first (scale, missing stairs/links, then rooms): ask one short question, then fix the answer with "
        "rename_room, set_room_type, set_door_width, rescale_building or set_floor_height and confirm in one line. Changes are saved for everyone."
    )}]


def selection_note(building, selection: dict | None) -> str:
    """What the person selected on the model (shown as a chip in the chat), so "this", "it" and "that door" resolve."""
    if not isinstance(selection, dict):
        return ""
    kind, item = selection.get("kind"), str(selection.get("id") or "")
    if kind == "asset" and item in building.assets:
        asset = building.assets[item]
        return (f"[Selected on the map: {asset['name']} ({asset['type'].replace('_', ' ')}, asset id {item}) in "
                f"{building.label(asset['space_id'])}. 'This', 'it' and 'that {asset['type'].replace('_', ' ')}' mean this object; "
                "use its asset id with the tools (move_object to shift it by metres, left/right as on the person's screen; move_asset to another room).]\n")
    if kind == "opening" and item in building.openings:
        opening = building.openings[item]
        sides = " and ".join(building.label(s) if s in building.spaces else "outside" for s in opening["space_ids"])
        state = "closed" if item in building.closed else "open"
        return (f"[Selected on the map: the {opening['kind']} {item} between {sides}, {opening['width_m']:.2f} m wide, "
                f"{'step-free' if opening['step_free'] else 'with a step'}, currently {state}. 'This door' and 'it' mean this "
                f"opening; use its id {item} with set_closed, set_door_width or move_door (left/right are as the person sees the screen; for 'as far as possible' pass a large distance, e.g. 100 — the door stops at the end of its wall). If they say it is closed, blocked or locked, that is a report: call set_closed on it. Don't ask where the person is.]\n")
    if kind == "space" and item in building.spaces:
        return f"[Selected on the map: {building.label(item)} (space id {item}). 'This room' and 'here' mean this space.]\n"
    return ""


class ChatSession:
    """Chat mode: one conversation about one building, with edits that persist for the session.

    With a building catalogue, the session can also route to other buildings (cross_route): the session's
    building stays the anchor; others are loaded on demand and placed from real positions, curated campus
    files, or what the person says in the conversation."""

    def __init__(
        self,
        building: Building,
        config: AgentConfig | None = None,
        client: anthropic.Anthropic | None = None,
        catalog: Catalog | None = None,
    ) -> None:
        self.config = config or AgentConfig(design="hybrid", effort="low")
        self.loop = ClaudeLoop(self.config, client)
        self.toolbox = Toolbox(building, "chat", catalog=catalog)
        self.catalog = catalog
        self.messages: list[dict] = []
        self.system = system_blocks(CHAT_INSTRUCTIONS, building) + import_checks(building)
        if catalog is not None:
            self.system += other_buildings_block(building, catalog)
        self.usage: Counter = Counter()
        self.last_scene: dict = {"focus": {"mode": "building"}}
        self.world_closed: set[str] = set()  # closures reported by people in the building (web world layer)

    @property
    def building(self) -> Building:
        """The session's building; the toolbox may replace it (e.g. after a rescale)."""
        return self.toolbox.building

    def seed_history(self, history: list[dict]) -> None:
        """Rebuild a lost session from text turns: strictly alternating user/assistant, starting with the user."""
        expected = "user"
        for turn in history[-20:]:
            role, content = turn.get("role"), str(turn.get("content", "")).strip()
            if role != expected or not content:
                continue
            self.messages.append({"role": role, "content": content})
            expected = "assistant" if role == "user" else "user"
        if self.messages and self.messages[-1]["role"] == "user":
            self.messages.pop()  # the new question is appended by ask()

    def set_world_closures(self, element_ids: list[str]) -> None:
        """Replace last turn's reported closures with this turn's; closures the agent made itself stay."""
        b = self.building
        valid = {e for e in element_ids if e in b.connectors or e in b.openings or e in b.spaces}
        agent_closed = b.closed - self.world_closed
        self.world_closed = valid
        b.closed = agent_closed | valid

    def ask(self, text: str, location: str | None = None, selection: dict | None = None) -> dict:
        outcome = Outcome(reply="", path="chat")
        hints = mention_hints(self.building, text)
        where = (
            f"[The person says they are in {self.building.label(location)} (space id {location}). Use it as the start for "
            "'here', 'nearest', 'from me' and routes without a start; don't ask where they are.]\n"
            if location in self.building.spaces
            else "[The person has not set their location. If you need a start, ask for their room, or tell them to tap a room "
            "on the map and choose \"I'm here\".]\n"
        )
        view = selection.get("view_right") if isinstance(selection, dict) else None
        self.toolbox.view_right = tuple(view) if isinstance(view, (list, tuple)) and len(view) == 2 else None
        self.messages.append({"role": "user", "content": where + selection_note(self.building, selection) + text + (f"\n\n{hints}" if hints else "")})
        self.toolbox.reset_turn()
        reply = self.loop.run(self.system, self.messages, self.toolbox, outcome)
        self.usage.update(outcome.usage)
        payload = self.toolbox.turn_payload()
        ui = payload.pop("ui", None)
        if ui is None:  # no tool ran (e.g. a clarifying question): keep the camera where it was
            ui = {"kind": "unknown", "scene": {**self.last_scene, "highlights": [], "routes": []}}
        else:
            self.last_scene = {"focus": ui["scene"]["focus"]}
        ui["scene"].setdefault("closed", sorted(self.building.closed))
        return {
            "text": reply,
            **payload,
            "ui": ui,
            "tool_calls": outcome.tool_calls,
            "cost": round(outcome.cost(), 4),
        }
