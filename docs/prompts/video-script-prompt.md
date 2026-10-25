# Prompt: minute 2 of the pitch video (engineering)

Copy everything below the line into another agent.

---

You are a technical scriptwriter. Write **minute 2 (60 s) of a 2-minute pitch video** for an expert jury: engineers at Synera, an industrial engineering software company. Minute 1 is already written. It tells one power outage twice, first from the employee stuck in a dark meeting room and then from the facility manager who fixes it from a café, and it ends on "You don't need to be in the building to run it."

Minute 2 must show **how it works**: precise, impressive, honest. Use only the facts below. If you need a fact that isn't here, write `[TODO: verify]`. Real numbers, real design decisions, and trade-offs said out loud.

## Product (where it is now)
**Lost & Found: building operations for incidents.** Fire, water and electrical faults on any building, in an enterprise web app in the style of Siemens iX / Desigo CC:
- an application header with event lamps (Fire / Water / Power);
- a navigation sidebar (floors, view, incidents, simulations);
- a 3D model in the centre;
- an assistant panel on the right.

Flows:
1. **Detect.** A sensor event, or an employee report (photo and/or text checked by Claude vision: hazard, severity, immediate danger), raises an incident. Every open screen gets a push-style alert.
2. **Understand.** For the incident, the panel shows sourced facts at the current minute: spaces hit per floor, the power cut it causes (circuit, lifts offline, server rooms on UPS with a countdown), people affected, equipment at risk, and the next key consequence (e.g. "Server room 1.06, directly below, at +6 min").
3. **Act.** One tap calls the right responder (technician, plumber, fire brigade), and a ticket tracks Reported → On the way (ETA) → Fixed. "Notify everyone" runs the full playbook. Calls are simulated with a deterministic timeline.
4. **Train / prepare.** Any room can be simulated ("what if a fire starts here?"). A timeline plays the spread, and **people walk out** along their evacuation routes, queuing at exit doors. A **readiness check** scores the building against workplace rules.
5. **Ask.** A chat agent answers the original challenge questions (locate, route, step-free, closures, areas, rooms above/below, 3D distances, what-if doors) and drives the map.

Everything runs from the challenge's `building.json` format: 280 buildings, and the unseen Sunday building. Nothing is hard-coded per building.

## Architecture
```
Next.js 16 (React 19, three.js) ── /api/chat, /api/hazards/*, /api/buildings/upload     (Vercel)
        │
FastAPI agent service (Vercel Services, private binding)
  ├── lostfound.core     route model + multigraph + geometry          (deterministic)
  ├── lostfound.agent    Claude agent: resolver → typed tools → run_python → formatter
  ├── lostfound.hazards  spread · impact · evacuation · readiness · playbooks · vision check
  ├── lostfound.ingest   SVG/PNG floor plans → building.json
  └── lostfound.evals    variants × question sets → accuracy, $, latency
Supabase: demo logins, uploaded buildings, edit log, chat history, Realtime
```

### 1. Deterministic core: no LLM in the maths
- The organisers' route model:
  - door to door, 15 cm off walls (shortest paths inside room polygons);
  - stairs cost 2 m per metre climbed;
  - lifts cost 15 m plus 1 m per metre;
  - no shortcut outside.
- A **multigraph** of spaces and door nodes, with stair and lift edges, searched with Dijkstra. Constraints: step-free routes, minimum door width, closures, and temporary what-if doors.
- **Verified against every labelled answer:**

  | Set | Answers reproduced |
  |---|---|
  | Benchmark, train + dev | 655 / 655 |
  | Warm-up | 2,130 / 2,130 |
  | Labelled route paths (exact doors, stairs and lifts, plus length) | 896 / 897 |

  The test suite has 3,477 tests.

### 2. The agent: typed tools first, code second
Built on Claude Opus 5.5 at low effort:
1. A deterministic resolver normalises names ("the Büro on floor 2") into ids, so the model never invents ids.
2. Typed tools with strict schemas. The API allows at most 20 strict tools, and we test that limit.
3. A `run_python` fallback: sandboxed subprocess, 60 s timeout, preloaded with the verified library. The model composes tested functions instead of writing geometry.
4. A deterministic `Answer:` formatter.

| Set | Rules (no LLM) | Agent |
|---|---|---|
| dev (138) | 100% | **138/138** ($0.014 per question) |
| paraphrased dev (276) | **0%** | **276/276** |
| warm-up, unseen kinds (369) | 0% | **368/369** |
| leave-one-kind-out (each kind's tool removed) | – | **138/138** via `run_python` |

These were measured on 24 Oct, before the latest tool additions. Say "on our dev sets".

### 3. Hazard engine (`lostfound.hazards`): deterministic, derived from the plan alone
- **Spread:** Dijkstra on arrival time with a peak level per space.
  - *Fire and smoke:* through doors. Rooms about 6 m/min, corridors and stairwells about 30 m/min. Through walls after about 28 min and through floors after about 18 min. Up stairwells fast.
  - *Water:* down to the rooms below, weighted by polygon overlap; under doors (attenuated); never up.
  - *Electrical:* each space belongs to the nearest electrical panel on its floor by walking distance. Where plans have no panels (most do not: 73 panels in 280 buildings), estimated zones of about 800 m².
  - *Cascades:* water on servers, panels or machines (not kitchen appliances) cuts that circuit, and so does fire at a panel.
- **Impact:** each space relative to the origin (below, next door, same floor), people from seats or area, and critical assets weighted by type.
- **Evacuation:** ways out with the burning spaces closed and lifts off. **Exit capacity is about 80 people per metre of door width per minute**, so queues form.
  - Real finding on a campus building: **506 of 507 people queue at one exit** while the main lobby exit stays almost unused. Everyone is out by +4.8 min.
- **Readiness**, using German workplace rules where they give numbers:
  - extinguisher within 20 m walking (ASR A2.2);
  - escape route at most 35 m (ASR A2.3);
  - single ways out, found as articulation points of the space graph;
  - server rooms below wet rooms;
  - defibrillator reach.
- **Playbooks:** ordered actions per hazard, with contacts and a simulated call timeline.
- 36 tests on real dataset buildings, e.g. "water reaches the room below", "evacuation routes avoid the fire", "temporary closures are undone".

### 4. From plans to buildings (Level 4)
- **SVG plans:** room IoU 1.00, doors 0.997.
- **PNG plans:** colour segmentation and watershed; scale estimated from furniture footprints, because plans have no scale bar; Claude reads room labels by region id and never outputs coordinates. Results: rooms 88–93%, areas within ±5% for 70–76%. Honest: weaker than SVG.
- **Conversational fixes:** "that's the kitchen" or "it's 10% bigger" become replayable edits.

### 5. Design decisions worth saying
- **One floor at a time**, as in ArcGIS Indoors' floor filter and Siemens Desigo CC. The sidebar floor list doubles as a building section, with live per-floor counts. We tried an exploded multi-floor view and dropped it as hard to read.
- **Facts with their source.** Water and the power cut it causes are counted separately, so the numbers add up.
- **Research behind training by simulation** (verify before quoting; see `docs/PITCH_EVIDENCE.md`):
  - Galea et al. 2014: 38% notice a normal exit sign, 77% a dynamic one;
  - Al-Haddad et al. 2019: 3D familiarisation beats 2D plans;
  - Zaalberg & Midden 2013: interactive 3D flood simulation in one's own home raises evacuation intention more than film or slides.

## Footage available
Screen recordings from the real app, at phone 390×844 and desktop 1920×1080, in `video/out/`:
- A1: route around locked lifts;
- A2: alert;
- A3: power-fault overview;
- A4: ticket;
- A5: fixed;
- A6: fire, water and power spread with people walking out.

Building: "Laborgebäude 029", 6 levels, CC0. Deep links (`?simulate=`, `?incident=`, `?notify=`, the `f` key) make every take repeatable. You can also ask for: terminal shots of `uv run pytest` (3,477 passing) and of the Sunday runner `python -m lostfound.run_benchmark <building> <questions.json> <answers.json>`, plus code close-ups.

## Deliver
1. A **60 s voice-over** (about 140–160 words) in 4–5 beats:
   1. one engine, any building;
   2. a deterministic core and the proof;
   3. an agent with verified tools (0% → 100% on reworded questions);
   4. the hazard engine (cascade, queues, readiness);
   5. close, linking back to minute 1's tagline.
2. Per beat: **shot list** (which clip or terminal shot), **on-screen text** with one number, and the **duration**.
3. **Three hero numbers** for the end card.
4. A **claims list**: every number used and the section above it came from.

Tone: engineer to engineer, confident and concrete ("we measured"). Use the jargon (multigraph, Dijkstra, articulation points, strict tool schemas, sandboxed subprocess), each with a five-word plain gloss the first time.
