"""Create a building from floor-plan SVGs, and optionally score it against a ground truth.

  uv run python -m lostfound.ingest data/dev/proc-factory-dev-003 --out buildings/my-building/building.json
  uv run python -m lostfound.ingest --evaluate data/dev           # rebuild every dev building and score it"""

import argparse
import json
import statistics
from pathlib import Path

from lostfound.ingest.assemble import assemble
from lostfound.ingest.evaluate import evaluate, verifier_counts
from lostfound.ingest.verify import verify

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
    "floor_registration",
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
    verifier_totals: dict[str, dict[str, int]] = {}
    for directory in sorted(p for p in arguments.source.iterdir() if (p / "building.json").exists()):
        building = assemble(directory)
        if arguments.label:
            from lostfound.ingest.label import label_rooms

            label_rooms(building, directory)
        scores = evaluate(directory, building)
        issues = verify(building)
        scores["issues"] = len(issues)
        for field, counts in verifier_counts(directory, building, issues).items():
            totals = verifier_totals.setdefault(field, {"errors": 0, "flagged": 0, "caught": 0})
            for key, value in counts.items():
                totals[key] += value
        rows.append((directory.name, scores))
        cells = " ".join(f"{key[:8]}={'n/a' if scores[key] is None else format(scores[key], '.2f')}" for key in SUMMARY_KEYS)
        print(f"{directory.name:24s} {cells}", scores["qa_by_kind"], flush=True)
    print("\nmean over", len(rows), "buildings (n/a excluded):")
    for key in SUMMARY_KEYS:
        values = [score[key] for name, score in rows if score.get(key) is not None]
        print(f"  {key:24s} {statistics.mean(values):.3f}   (n={len(values)})")
    print("\nverifier (dev ground truth): field  errors  flagged  caught  recall  precision")
    for field, totals in verifier_totals.items():
        recall = totals["caught"] / totals["errors"] if totals["errors"] else float("nan")
        precision = totals["caught"] / totals["flagged"] if totals["flagged"] else float("nan")
        print(f"  {field:10s} {totals['errors']:6d} {totals['flagged']:8d} {totals['caught']:7d}  {recall:6.1%}  {precision:6.1%}")
    rows.append(("_verifier", verifier_totals))
    results = Path("evals") / "results" / f"ingest__{arguments.source.name}{'__labelled' if arguments.label else ''}.json"
    results.write_text(json.dumps(dict(rows), indent=1, default=str), encoding="utf-8")
    print(f"details: {results}")


if __name__ == "__main__":
    main()
