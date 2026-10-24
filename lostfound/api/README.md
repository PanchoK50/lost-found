# Building agent API (for the web app)

Start the server from the repo root:

```sh
source .envrc && uv run uvicorn lostfound.api.server:app --reload --port 8000
```

Interactive docs are served at http://localhost:8000/docs. CORS is open for local development.

**Conventions**
- Coordinates are metres in the building's frame, with y pointing up (same as `building.json`).
- `session_id` keeps one conversation and its edits (closures, new doors, moved assets) together. Edits apply to that session's copy of the building and are never written to disk.

## Endpoints

| Method | Path | Body or params | Returns |
|---|---|---|---|
| GET | `/buildings` | – | `[{id, name, split, source, floors, levels}]` |
| GET | `/buildings/{id}?session_id=` | – | The `building.json` content, including session edits, plus `closed: [ids]` |
| POST | `/search` | `{building_id, query, session_id?}` | `{places: {candidates, ambiguous}, matches: [...]}` |
| POST | `/route` | `{building_id, start, destination, via?, step_free?, min_width_m?, closed?, session_id?}` | Route object (below). No LLM. |
| POST | `/chat` | `{building_id, message, session_id?, model?, effort?}` | Chat turn (below) |
| POST | `/edit` | `{building_id, session_id, action, ...}` | The applied edit. Actions:<br>`close` / `reopen` with `element`<br>`add_door` with `first, second, width_m, step_free`<br>`move_asset` with `asset, to_room` |
| POST | `/ask` | `{building_id, question, design?, model?}` | `{reply, path, tool_calls, cost}`: a benchmark-style answer ending in `Answer:` |

In `start`, `destination` and `via` you can pass a space id, a room number (`0.21`), a name (`Office 0.46`), or a name with its floor (`Büro (Floor 1)`).

### Route object
```jsonc
{
  "length_m": 57.25,
  "space_path": ["...-F0-S046", "...-F0-S016", "...-F0-S021"],  // spaces in order ("outside" may appear)
  "polylines": [ { "floor_id": "...-F0", "level": 0, "points": [[x, y], ...] } ],  // one run per floor, in order
  "steps": ["Start in Office 0.46 (Ground floor).", "After about 32 m, turn left through the door into ..."],
  "highlights": ["...-F0-S046", "...-F0-S016", "...-F0-S021"],
  "step_free": true
}
```

### Chat turn
```jsonc
{
  "session_id": "4f1c…",          // send it back on the next turn
  "text": "The coordinate measuring machine is in Quality lab 0.21 …",
  "highlights": ["...-F0-S046", "...-F0-S021"],   // spaces to highlight on the map
  "route": { /* route object or null */ },
  "edits": [ { "action": "close", "element_id": "...-F0-S016" } ],   // edits made this turn
  "closed": ["...-F0-S016"],      // everything currently closed in this session
  "tool_calls": ["find_assets", "route"],
  "cost": 0.0233                  // dollars for this turn
}
```

When the agent needs a clarification, for example when two rooms share a name, it asks in `text` and returns no route.
