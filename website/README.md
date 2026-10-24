# Lost & Found

The Next.js app for **Talk to Your Building**, Synera's Industrial Agents Hackathon 2026 challenge.

## Repository layout

This folder is the app (the product we submit). Sibling folders in the repo root hold the rest of the team's work:

| Location | Contents |
| --- | --- |
| `../notebooks/` | Development-only challenge data exploration (HTML explorer + Jupyter notebook) |
| `../scripts/` | Notebook generation helpers |
| `../data/` | Challenge dataset (planned) |

The challenge kit itself stays in a separate checkout (see "Python kit and benchmark" below).

## Run locally

Use Node 24 (see `../.nvmrc`) and npm. No credentials are needed for the starter.

```sh
npm ci
npm run dev
```

Open http://localhost:3000. Search for `printer`, `CNC`, `coffee`, a room name, or a room number. Results select the containing room on the floor plan. Use the space selector to inspect other rooms. Search is a literal, case-insensitive lookup; it does not yet interpret conversational requests.

```sh
npm run lint
npm run typecheck
npm run build
```

CI runs the same checks on this folder for every push and pull request. Commit `package-lock.json` and use `npm ci` for reproducible installs.

## What's included

- Next.js App Router, TypeScript in strict mode, Tailwind CSS, ESLint, npm lockfile.
- Responsive SVG floor viewer with room highlighting, equipment details, and accessible form controls.
- `GET /api/search?q=printer`: validated deterministic search over sample rooms and assets.
- Original synthetic building fixture; nothing copied from the challenge dataset. No API keys, external fonts, database, or paid services required.

## Where the team works

| Location | Responsibility |
| --- | --- |
| `src/components/building-workspace.tsx` | UI state, search interaction, floor rendering |
| `src/lib/buildings/types.ts` | Core challenge building types (a subset, not a runtime import validator) |
| `src/lib/buildings/demo.ts` | Replaceable sample fixture in metres with Y pointing up |
| `src/app/api/search/route.ts` | Server-side lookup boundary |
| `src/app/globals.css` | Visual styling and responsive layouts |

The SVG flips the building Y axis for screen coordinates. The current viewer is deliberately limited to the sample ground floor. Routing, AI chat, floor-plan upload, multi-floor views, edits, persistence, and voice are not implemented yet.

## Chat + 3D viewer

The home page is a full-screen 3D model of the building with an "Ask me anything" chat. Each answer flies the camera to the relevant floor(s) and highlights the result.

- `src/lib/chat/contract.ts`: **the contract between the backend and the viewer.** `POST /api/chat` returns a `ChatResponse`: `reply` text, a headline `answer`, and a `scene` (focus floor/stack/building, highlighted space ids, markers, routes, links, closures).
- `docs/answer-types.md`: every question kind grouped into five output types, with the headline and 3D view each one gets.
- `src/lib/chat/demo-resolver.ts`: a keyword-matching **placeholder** so the UI can be demoed. Replace the `resolveDemo` call in `src/app/api/chat/route.ts` with the real agent and return the same shape.
- `src/components/experience/`: the viewer (`building-scene.tsx`, `scene-model.ts`) and the chat shell (`building-experience.tsx`).
- `src/lib/buildings/catalog.ts` + `src/data/buildings/`: the buildings offered in the UI (N3 and Fertigung Ost 27, geometry only; see `ATTRIBUTION.md` there).

## Challenge understanding and implementation order

Source: https://github.com/Synera-GmbH/industrial-agents-hackathon-2026

The app should locate assets, route with constraints, scale across floors/buildings, and create or update buildings from plans. Judging weights functionality at 55 points, interaction at 25, creativity at 10, and submission at 10. Prioritize a complete one-floor flow first.

1. **Data and graph:** import a train/dev `building.json` with runtime validation, retain source/license metadata, render its polygons, and agree on shared response types. Do not tune against test answers.
2. **Deterministic tools:** reuse the supplied Python `BuildingMap` behind a small HTTP service. Match its space/opening graph, representative-point anchors, parallel edges, closure rules, door widths, and step-free restrictions. Stairs cost 12 m per floor; lifts cost 15 m wait plus 6 m per floor. Verify against warm-up answers before adding AI.
3. **Conversation:** add a Next.js server route calling that service and/or Claude tools. Keep API keys server-side in ignored `.env.local`. The model should select tools and explain results; computed data supplies facts and routes. Return structured space IDs and route points with the text so the viewer can highlight them. Ask for clarification when destinations are ambiguous.
4. **Full benchmark:** add polygon areas, width-constrained reachability, shared walls, stacked-room overlap, 3D centroids, and what-if doors. The upstream starter deliberately scores below 5% on the real benchmark; warm-up success is insufficient.
5. **Scale and polish:** multiple floors, animated routes, preview/confirmation for edits, plan ingestion, then one focused extension (e.g. voice or logistics).

Suggested team split: UI/viewer; graph/geometry tools; agent/backend integration; evaluation/data import. Agree on the building and route contracts before parallel implementation.

## Python kit and benchmark

Keep a separate checkout of the challenge kit alongside this project; the Python code and large dataset are not vendored here. It requires Python 3.12+, uv, and Anthropic credentials for live agent calls. Follow its own setup instructions.

Run these **inside that checkout**:

```sh
uv sync
# Free deterministic warm-up evaluation
uv run python -m starter_agent.evaluate data/dev --oracle
# Live benchmark (uses API credits after configuring the kit's .env)
uv run --env-file .env python -m benchmark.evaluate data/dev --per-kind 3
```

The evaluator accepts an `answer(building_directory: Path, question_text: str) -> str` function via `--agent module:function`. Keep that entry point independent of the web UI. Submissions require a UTF-8 CSV with `question_id,answer`; scored replies need a final `Answer:` line. Before submission, add `BENCHMARK.md` with the actual single command for your implemented agent, and include the answers file, demo video, and technical explanation. The Sunday unseen building must run without manual intervention.

Dataset licenses vary (CC BY 4.0, ODbL 1.0, CC0). Read the upstream `ATTRIBUTION.md` before importing or redistributing data and preserve required attribution. The starter's original sample is independent of that dataset.

Build note: development and production builds use Next.js's supported Webpack option with Tailwind PostCSS. This avoids a Turbopack CSS-worker port-permission failure in the initial development environment.

## Explore the challenge data

Open `../notebooks/data-explorer.html` in a browser for an offline overview and interactive floor plans of a real development factory. For editable analysis, use `../notebooks/data-exploration.ipynb` (executed outputs included). See `../notebooks/README.md` for setup and data provenance. These are development-only resources outside this app, with no product imports, routes, or navigation links. `../.vercelignore` excludes them from Vercel deployment uploads. This exploration snapshot is separate from the app's original demo fixture.
