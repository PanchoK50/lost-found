"""Create (or update) the demo logins in Supabase Auth, so nobody has to go through a sign-up flow.

  uv run --env-file .env python scripts/create_demo_users.py

Needs SUPABASE_URL, SUPABASE_SECRET_KEY and DEMO_PASSWORD in the environment. Profiles are created by the
`on_auth_user_created` trigger from the user metadata (supabase/migrations)."""

import json
import os
import urllib.error
import urllib.request

DEMO_DOMAIN = "lostfound.demo"
DEMO_USERS = [
    {"username": "pancho", "display_name": "Pancho", "role": "member", "groups": ["team"]},
    {"username": "chrissi", "display_name": "Chrissi", "role": "member", "groups": ["team"]},
    {"username": "andy", "display_name": "Andy", "role": "member", "groups": ["team"]},
    {"username": "rabea", "display_name": "Rabea", "role": "member", "groups": ["team"]},
    # The jury tests alone: facility may also resolve any report.
    {"username": "jury", "display_name": "Jury", "role": "facility", "groups": []},
]


def request(method: str, path: str, body: dict | None = None) -> dict:
    url = os.environ["SUPABASE_URL"].rstrip("/") + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"apikey": os.environ["SUPABASE_SECRET_KEY"], "Content-Type": "application/json"}
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers, method=method)) as response:
        return json.loads(response.read() or b"{}")


def main() -> None:
    password = os.environ["DEMO_PASSWORD"]
    existing = {user["email"]: user for user in request("GET", "/auth/v1/admin/users?per_page=200").get("users", [])}
    for demo in DEMO_USERS:
        email = f"{demo['username']}@{DEMO_DOMAIN}"
        metadata = {key: demo[key] for key in ("username", "display_name", "role", "groups")}
        if email in existing:
            user_id = existing[email]["id"]
            request("PUT", f"/auth/v1/admin/users/{user_id}", {"password": password, "user_metadata": metadata})
            # The trigger only runs on insert: keep the profile in step with the metadata.
            profile = {key: demo[key] for key in ("display_name", "role", "groups")}
            request("PATCH", f"/rest/v1/profiles?id=eq.{user_id}", profile)
            print(f"updated  {email}")
        else:
            request("POST", "/auth/v1/admin/users", {"email": email, "password": password, "email_confirm": True, "user_metadata": metadata})
            print(f"created  {email}")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        raise SystemExit(f"Supabase answered {error.code}: {error.read().decode()}") from error
