"""Upload the dataset buildings to Supabase: building.json into the 'buildings' Storage bucket and one row per
building into the `buildings` table (from data/manifest.csv). Safe to re-run (upserts).

  source .envrc && uv run python scripts/upload_buildings.py            # all splits
  source .envrc && uv run python scripts/upload_buildings.py dev        # one split"""

import csv
import json
import os
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
BUCKET = "buildings"


def request(method: str, path: str, body: bytes, content_type: str, extra: dict | None = None) -> None:
    url = os.environ["SUPABASE_URL"].rstrip("/") + path
    headers = {"apikey": os.environ["SUPABASE_SECRET_KEY"], "Content-Type": content_type, **(extra or {})}
    with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers, method=method)) as response:
        response.read()


def upload(row: dict) -> str:
    building_id = row["building_id"]
    path = DATA / row["path"] / "building.json"
    if not path.exists():
        return f"missing  {building_id}"
    storage_path = f"{building_id}/building.json"
    request("POST", f"/storage/v1/object/{BUCKET}/{storage_path}", path.read_bytes(), "application/json", {"x-upsert": "true"})
    building = json.loads(path.read_text(encoding="utf-8"))["building"]
    record = {
        "id": building_id,
        "name": row["name"] or building_id,
        "source": row["source"],
        "split": row["split"],
        "license": row["license"],
        "attribution": building.get("attribution"),
        "floors": int(row["floors"]),
        "levels": row["levels"],
        "spaces": int(row["spaces"]),
        "assets": int(row["assets"] or 0),
        "storage_path": storage_path,
    }
    request("POST", "/rest/v1/buildings", json.dumps(record).encode(), "application/json", {"Prefer": "resolution=merge-duplicates"})
    return f"uploaded {building_id}"


def main() -> None:
    splits = set(sys.argv[1:]) or {"train", "dev", "test"}
    with (DATA / "manifest.csv").open(encoding="utf-8") as handle:
        rows = [row for row in csv.DictReader(handle) if row["split"] in splits]
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(upload, rows))
    failed = [r for r in results if not r.startswith("uploaded")]
    print(f"{len(results) - len(failed)} buildings uploaded; problems: {failed or 'none'}")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        raise SystemExit(f"Supabase answered {error.code}: {error.read().decode()}") from error
