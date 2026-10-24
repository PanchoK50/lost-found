# Lost & Found: context for Claude Code

@AGENTS.md

Industrial Agents Hackathon 2026, Track 01 "Talk to Your Building", Sat 24 to Sun 25 October 2026. The full challenge text is [README.md](README.md). Reply in the language the user writes in.

## Repo layout

| Path | What |
|---|---|
| `website/` | Next.js 16 app (React 19, Tailwind 4, Node 24). Run `npm run dev`, `lint`, `typecheck`, `build` inside `website/`. CI runs lint, typecheck and build. Contains Andy's viewer (merged from `andy-ui`): three.js scene in `src/components/experience/`, chat contract `src/lib/chat/contract.ts`, walking model `src/lib/buildings/walk.ts`, turn-by-turn `turns.ts`, demo resolver `src/lib/chat/demo-resolver.ts`, answer types in `website/docs/answer-types.md`. |
| `data/` | Challenge dataset: `train/`, `dev/` (with answers), `test/` (without). One `building.json` per building. |
| `benchmark/` | Official scorer (`score.py`) and evaluator (`evaluate.py`). |
| `starter_agent/` | Reference Python agent. `building_map.py` implements the dataset's route model. |
| `notebooks/` | Data explorer. |
| `docs/TECH_MUST_HAVES.md` | Technical must-haves T1–T20: distance models, exact definitions, answer format, API response contract (T20), open questions for the organizers. |
| `docs/UX_MUST_HAVES.md` | UX must-haves U1–U12, agent tone, 12 interaction test scenarios. |
| `docs/CONCEPT.md` | UX concept (dollhouse view, lenses, look and feel, demo story), idea pool, team decisions, summary of the team's Notion feature backlog. Read it before UX work. |
| `docs/MULTIPLAYER.md` | Signature feature spec for the andy-ui code: four building blocks (pin, ping, presence, skill), modes by building category, privacy, truth rules, data model, `/api/world`, chat proposals, routing closures, demo players, UI, build order. |
| `docs/ORGANIZER_NOTES.md` | Organizer Q&A notes and the official challenge PDF: jury tests the web app by hand, web first (no iOS), camera allowed, jury likes video games, use case "in-house fair in an automotive factory", Sunday output is `answers.json` (route as ordered node ids). Read it before product decisions. |
| `docs/UX_DESIGN.md` | Concrete UX design for U1–U12: layout, visual tokens, components with T20 mapping, states, the 12 scenarios in the UI, requests to the backend. |

Python runs through uv at the repo root (`uv sync`, `uv run ...`).

## Team split

- Two teammates build the technical core (graph, routing, geometry tools, benchmark) up to a simple chat interface.
- Rabea and Andy own the UX layer and the UX features on top of it, in Next.js under `website/`. Rabea's work goes on branch `Rabea`.

## Rules

- UX consumes agent replies through the response contract in `docs/TECH_MUST_HAVES.md` (T20): `text`, `understood`, `highlights`, `route`, `clarification`, `changes`. Mock it with real `building.json` data until the backend exists.
- Coordinates are metres with y pointing up; SVG views flip y.
- Everything must work on any building in the dataset format. The Sunday benchmark uses a building nobody has seen, so never hard-code test buildings.
- `ANTHROPIC_API_KEY` lives in the root `.env` (gitignored). Read it only in server code, never with a `NEXT_PUBLIC_` prefix. Never commit `.env*`.
- OSM buildings are ODbL: keep the attribution from `ATTRIBUTION.md` when showing them.
