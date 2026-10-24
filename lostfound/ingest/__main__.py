"""Create a building from floor-plan SVGs, and optionally score it against a ground truth.

  uv run python -m lostfound.ingest data/dev/proc-factory-dev-003 --out buildings/my-building/building.json
  uv run python -m lostfound.ingest --evaluate data/dev           # rebuild every dev building and score it"""

import argparse
import json
import statistics
from pathlib import Path

from lostfound.ingest.assemble import assemble
from lostfound.ingest.evaluate import evaluate

SUMMARY_KEYS = (
    "space_recall",
    "space_precision",
    "mean_iou",
    "area_within_5pct",
    "type_accuracy",
    "ref_accuracy",
    "room_type_accuracy",
    "door_recall",
    "door_precision",
    "connector_link_recall",
    "qa_parity",
)


def main() -> None:
    parser = argparse.ArgumentParser(prog="lostfound.ingest")
    parser.add_argument("source", type=Path, help="folder with floor_<level>.svg files (or a split folder with --evaluate)")
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--evaluate", action="store_true", help="rebuild every building in the folder and score it")
    parser.add_argument("--label", action="store_true", help="label room types with Claude (uses API credits)")
    arguments = parser.parse_args()

    if not arguments.evaluate:
        building = assemble(arguments.source)
        if arguments.label:
            from lostfound.ingest.label import label_rooms

            label_rooms(building, arguments.source)
        out = arguments.out or Path("buildings") / building["building"]["id"] / "building.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(building, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"{len(building['spaces'])} spaces, {len(building['openings'])} openings, "
              f"{len(building['vertical_connectors'])} connectors -> {out}")
        print(json.dumps(building["ingest_report"], indent=1))
        return

    rows = []
    for directory in sorted(p for p in arguments.source.iterdir() if (p / "building.json").exists()):
        building = assemble(directory)
        if arguments.label:
            from lostfound.ingest.label import label_rooms

            label_rooms(building, directory)
        scores = evaluate(directory, building)
        rows.append((directory.name, scores))
        print(f"{directory.name:24s} " + " ".join(f"{key.split('_')[0][:5]}={scores[key]:.2f}" for key in SUMMARY_KEYS),
              scores["qa_by_kind"], flush=True)
    print("\nmean over", len(rows), "buildings:")
    for key in SUMMARY_KEYS:
        print(f"  {key:24s} {statistics.mean(score[key] for _, score in rows):.3f}")
    results = Path("evals") / "results" / f"ingest__{arguments.source.name}{'__labelled' if arguments.label else ''}.json"
    results.write_text(json.dumps(dict(rows), indent=1, default=str), encoding="utf-8")
    print(f"details: {results}")


if __name__ == "__main__":
    main()
