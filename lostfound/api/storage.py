"""Buildings in Supabase (table `buildings`, Storage bucket 'buildings'): download on demand, save uploads."""

import json
import os
import re
import secrets
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

BUCKET = "buildings"
CACHE = Path(tempfile.gettempdir()) / "lostfound-buildings"


def configured() -> bool:
    return bool(os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SECRET_KEY"))


def _request(method: str, path: str, body: bytes | None = None, content_type: str = "application/json", extra: dict | None = None) -> bytes:
    url = os.environ["SUPABASE_URL"].rstrip("/") + path
    headers = {"apikey": os.environ["SUPABASE_SECRET_KEY"], "Content-Type": content_type, **(extra or {})}
    with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers, method=method), timeout=30) as response:
        return response.read()


def cached_directory(building_id: str) -> Path | None:
    """Local folder with the building's building.json, downloading it from Supabase Storage on first use."""
    if not re.fullmatch(r"[\w.-]{1,120}", building_id):
        return None
    directory = CACHE / building_id
    if (directory / "building.json").exists():
        return directory
    if not configured():
        return None
    try:
        data = _request("GET", f"/storage/v1/object/{BUCKET}/{building_id}/building.json")
    except urllib.error.HTTPError:
        return None
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "building.json").write_bytes(data)
    return directory


def new_building_id(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "building"
    return f"upload-{slug}-{secrets.token_hex(2)}"


def save_upload(building: dict, created_by: str | None) -> None:
    """Store an imported building: building.json in Storage, a row in `buildings`, and the local cache."""
    building_id = building["building"]["id"]
    body = json.dumps(building, ensure_ascii=False).encode()
    directory = CACHE / building_id
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "building.json").write_bytes(body)
    if not configured():
        return
    storage_path = f"{building_id}/building.json"
    _request("POST", f"/storage/v1/object/{BUCKET}/{storage_path}", body, extra={"x-upsert": "true"})
    floors = building["floors"]
    record = {
        "id": building_id,
        "name": building["building"]["name"],
        "source": "upload",
        "split": None,
        "license": building["building"].get("license") or None,
        "attribution": building["building"].get("attribution") or None,
        "floors": len(floors),
        "levels": ";".join(str(f["level"]) for f in sorted(floors, key=lambda f: f["level"])),
        "spaces": len(building["spaces"]),
        "assets": len(building["assets"]),
        "storage_path": storage_path,
        "created_by": created_by,
        "ingest_report": building.get("ingest_report"),
    }
    _request("POST", "/rest/v1/buildings", json.dumps(record).encode(), extra={"Prefer": "resolution=merge-duplicates"})
