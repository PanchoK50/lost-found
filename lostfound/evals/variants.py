"""Registry of agent variants compared in the evals. A variant answers one question and reports its usage."""

from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

# dollars per million tokens: input, output, cache read, cache write (5-minute TTL = 1.25x input)
PRICES = {
    "claude-opus-5-5": (4.00, 20.00, 0.20, 5.00),
    "claude-sonnet-5-5": (2.00, 10.00, 0.20, 2.50),
    "claude-haiku-5-5": (0.10, 0.50, 0.01, 0.125),
}
MODELS = {"opus": "claude-opus-5-5", "sonnet": "claude-sonnet-5-5", "haiku": "claude-haiku-5-5"}


@dataclass
class Outcome:
    reply: str
    usage: Counter = field(default_factory=Counter)  # per model: "<model>:input_tokens" ...
    tool_calls: list[str] = field(default_factory=list)
    path: str = ""  # which route through the agent produced the answer (typed, code, rules, ...)
    notes: dict = field(default_factory=dict)

    def cost(self) -> float:
        total = 0.0
        for key, tokens in self.usage.items():
            model, _, kind = key.partition(":")
            if model not in PRICES:
                continue
            input_price, output_price, read_price, write_price = PRICES[model]
            price = {
                "input_tokens": input_price,
                "output_tokens": output_price,
                "cache_read_input_tokens": read_price,
                "cache_creation_input_tokens": write_price,
            }[kind]
            total += tokens * price / 1_000_000
        return total


Variant = Callable[[dict], Outcome]  # gets the eval item (building_dir, question, inputs...) -> Outcome


def rules_variant(_model: str | None, _effort: str | None, **_options) -> Variant:
    from lostfound.agent import rules

    def run(item: dict) -> Outcome:
        return Outcome(reply=rules.answer(Path(item["building_dir"]), item["question"]), path="rules")

    return run


def oracle_variant(_model: str | None, _effort: str | None, **_options) -> Variant:
    """Upper bound: the labelled structured inputs go straight into the skills (benchmark sets only)."""
    import tests.test_skills_oracle as oracle

    from lostfound.agent.format import answer_line
    from lostfound.core.building import Building

    def run(item: dict) -> Outcome:
        # A fresh Building per question: what-if questions edit the building temporarily, so instances must not
        # be shared between threads (the test module caches one per directory).
        building = Building.load(Path(item["building_dir"]))
        _, result = oracle.run_skill(Path(item["building_dir"]), item, building)
        return Outcome(reply=answer_line(building, item["kind"], result), path="oracle")

    return run


def starter_variant(model: str | None, effort: str | None, **_options) -> Variant:
    """V0: the kit's starter agent exactly as shipped (its own model and effort)."""
    import anthropic

    from starter_agent import agent as starter
    from starter_agent.building_map import BuildingMap

    client = anthropic.Anthropic()

    def run(item: dict) -> Outcome:
        building_agent = starter.BuildingAgent(
            BuildingMap.load(Path(item["building_dir"])), Path("agent_output") / "scratch", client
        )
        reply = building_agent.ask(item["question"])
        usage = Counter({f"{starter.MODEL}:{key}": value for key, value in building_agent.usage.items()})
        return Outcome(reply=reply, usage=usage, path="starter")

    return run


def agent_variant(design: str) -> Callable[..., Variant]:
    def factory(model: str | None, effort: str | None, excluded_kinds: frozenset[str] = frozenset()) -> Variant:
        from lostfound.agent.agent import AgentConfig, BuildingQA

        config = AgentConfig(
            design=design,
            model=MODELS.get(model or "opus", model),
            effort=effort or "low",
            excluded_kinds=excluded_kinds,
        )
        qa = BuildingQA(config)
        return lambda item: qa.answer_item(item)

    return factory


VARIANTS: dict[str, Callable[[str | None, str | None], Variant]] = {
    "V0": starter_variant,
    "V1": rules_variant,
    "V2": agent_variant("typed"),
    "V3": agent_variant("code"),
    "V4": agent_variant("hybrid"),
    "V5": agent_variant("rules+"),
    "oracle": oracle_variant,
}
