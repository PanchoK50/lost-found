"""Conversational agent: Claude orchestrates the strict tools, the core supplies every fact.

Model and effort come from the parameter, then AGENT_MODEL/AGENT_EFFORT, then
defaults (opus, medium effort). Clarification mode switches the prompt between
chat behaviour (may ask one short question when ambiguous) and one-shot
behaviour (benchmark: never asks, states its assumption, always commits an
Answer line).
"""

from __future__ import annotations

import json
import os

import anthropic

from agent.tools import AgentToolkit, make_tools
from core.geometry import Geometry
from core.model import Building

MODEL_ALIASES = {"opus": "claude-opus-5-5", "sonnet": "claude-sonnet-5-5"}
DEFAULT_MODEL = "claude-opus-5-5"
DEFAULT_EFFORT = "medium"
MAX_TOKENS = 16000
MAX_TOOL_ITERATIONS = 12
FALLBACK_BETA = "server-side-fallback-2026-07-01"

BASE_PROMPT = """You are the indoor guide for one building, like Google Maps but inside: people ask where \
things are, how to get somewhere, about rooms and areas, and tell you about changes (closed lifts, new doors).

How to work:
- Every fact (rooms, things, areas, door widths, routes, distances, counts) must come from your tools. \
Never guess a number, a room or a route.
- Room numbers like "0.29" are exact references; pass names or numbers to the tools as written. If a tool \
lists candidates, choose the one the question's context (floor, wording) points to.
- Keep tool outputs to yourself; reply in short plain sentences with the key numbers and room names.
- Constraints: step_free for wheelchair/pram/trolley ("no stairs"), min_door_width_m for wide loads, \
closed_elements or set_closed for closures, what_if_door for hypothetical doors.

{clarification}

Answer format (your replies are graded automatically):
- Always finish with a final line starting with "Answer:".
- Numeric answers: that line holds exactly one number (a unit like m or m² is fine; ranges or two numbers \
are wrong), e.g. "Answer: 132.35 m".
- Room answers: name the requested room before any other room; include areas as m², \
e.g. "Answer: Kitchen 1.14, 28.0 m²".
- Routes: the ordered list of spaces, e.g. "Answer: Lobby 0.01 -> Corridor 0.02 -> Office 0.03".
- If no route exists under the rules, say so plainly and finish with e.g. "Answer: no step-free route".
- Tools return a ready "answer_line"; use it (trimmed if you like) as your final line.

Building overview:
{overview}"""

CLARIFICATION_ALLOWED = """- If a search returns several equally plausible matches and the person's words don't settle it, ask one \
short question listing the options, then continue. If one match is clearly meant, go ahead without asking."""

CLARIFICATION_FORBIDDEN = """- You get exactly one reply and there is nobody to answer questions: never ask back. If a reference is \
ambiguous, pick the best match from the question's context (floor, wording), state the assumption in one \
short sentence, and always commit to the final Answer line."""


def resolve_model(value: str | None = None) -> str:
    source = (value or os.environ.get("AGENT_MODEL") or DEFAULT_MODEL).strip()
    return MODEL_ALIASES.get(source.lower(), source)


def resolve_effort(value: str | None = None) -> str:
    return (value or os.environ.get("AGENT_EFFORT") or DEFAULT_EFFORT).strip()


class BuildingAgent:
    """One conversation with one building; the toolkit session holds closures and added doors."""

    def __init__(
        self,
        building: Building,
        geometry: Geometry,
        client: anthropic.Anthropic | None = None,
        model: str | None = None,
        effort: str | None = None,
        clarification: str = "allowed",
    ) -> None:
        if clarification not in ("allowed", "forbidden"):
            raise ValueError(f"clarification must be 'allowed' or 'forbidden', got {clarification!r}")
        self.building = building
        self.geometry = geometry
        self.model = resolve_model(model)
        self.effort = resolve_effort(effort)
        self.clarification = clarification
        self._client = client
        self.toolkit = AgentToolkit(building, geometry)
        self.tools = make_tools(self.toolkit)
        block = CLARIFICATION_ALLOWED if clarification == "allowed" else CLARIFICATION_FORBIDDEN
        self.system = [
            {
                "type": "text",
                "text": BASE_PROMPT.format(overview=json.dumps(self.toolkit.building_overview()), clarification=block),
                "cache_control": {"type": "ephemeral"},
            }
        ]
        self.messages: list[dict] = []
        self.usage = {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        }

    @property
    def client(self) -> anthropic.Anthropic:
        if self._client is None:
            self._client = anthropic.Anthropic()
        return self._client

    def ask(self, user_text: str) -> str:
        self.messages.append({"role": "user", "content": user_text})
        runner = self.client.beta.messages.tool_runner(
            model=self.model,
            max_tokens=MAX_TOKENS,
            max_iterations=MAX_TOOL_ITERATIONS,
            system=self.system,
            tools=self.tools,
            messages=list(self.messages),
            output_config={"effort": self.effort},
            betas=[FALLBACK_BETA],
            fallbacks="default",
        )
        final = None
        for message in runner:
            final = message
            self.track_usage(message)
            # The runner keeps its own history; mirror it so the next turn has the full conversation.
            self.messages.append({"role": "assistant", "content": message.content})
            tool_response = runner.generate_tool_call_response()
            if tool_response is not None:
                self.messages.append(tool_response)
        if final is None:
            return "(no response)"
        if final.stop_reason == "refusal":
            return "Sorry, I can't help with that request."
        return "\n".join(block.text for block in final.content if block.type == "text").strip()

    def track_usage(self, message: object) -> None:
        usage = message.usage
        self.usage["input_tokens"] += usage.input_tokens
        self.usage["output_tokens"] += usage.output_tokens
        self.usage["cache_read_input_tokens"] += usage.cache_read_input_tokens or 0
        self.usage["cache_creation_input_tokens"] += usage.cache_creation_input_tokens or 0
