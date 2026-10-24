"""Chat with one building: uv run --env-file .env python -m agent data/dev/<building> [--model sonnet] [--one-shot]."""

from __future__ import annotations

import argparse
from pathlib import Path

import anthropic

from agent.agent import BuildingAgent
from agent.entry import building_and_geometry
from core.model import Building

EXIT_WORDS = {"exit", "quit", "bye"}


def chat(building_directory: Path, model: str | None, effort: str | None, one_shot: bool) -> None:
    building, geometry = building_and_geometry(building_directory)
    agent = BuildingAgent(
        building,
        geometry,
        model=model,
        effort=effort,
        clarification="forbidden" if one_shot else "allowed",
    )
    mode = "one-shot (benchmark mode, no questions asked)" if one_shot else "chat"
    print(f"Guide for {building.meta.name} [{mode}, model {agent.model}]. Ask anything ('exit' to stop).")
    while True:
        try:
            user_text = input("\nyou> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not user_text:
            continue
        if user_text.lower() in EXIT_WORDS:
            break
        try:
            print(f"\nguide> {agent.ask(user_text)}")
        except anthropic.AuthenticationError:
            print("No valid API credentials: set ANTHROPIC_API_KEY or run `ant auth login`.")
            return
        except anthropic.RateLimitError:
            print("Rate limited - wait a moment and try again.")
        except anthropic.APIConnectionError:
            print("Network error - check your connection.")
        except anthropic.APIStatusError as error:
            print(f"API error {error.status_code}: {error.message}")
    print(f"\nTokens used: {agent.usage}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="agent", description="Chat with a building through the agent.")
    parser.add_argument("building", type=Path, help="building directory (with building.json) or a building.json")
    parser.add_argument("--model", default=None, help="opus, sonnet, or a full model id (default: opus)")
    parser.add_argument("--effort", default=None, help="reasoning effort: low, medium, high (default: medium)")
    parser.add_argument("--one-shot", action="store_true", help="benchmark mode: never asks back, always answers")
    arguments = parser.parse_args()
    chat(arguments.building, arguments.model, arguments.effort, arguments.one_shot)


if __name__ == "__main__":
    main()
