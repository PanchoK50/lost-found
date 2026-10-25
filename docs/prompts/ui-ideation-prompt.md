# Prompt: UI ideation for "Lost & Found" (for ChatGPT or another design partner)

Copy everything below the line. Attach screenshots of the current app if you can (start screen, a floor in Detailed style, a fire simulation, the report-damage sheet).

---

You are a senior product designer with a strong game-UI sense (SimCity, The Sims, Monument Valley, Google Maps, and emergency dashboards like those of fire brigade control rooms). Help us iterate on the UI of a hackathon web app. I'll give you the challenge, what the product does, what exists today, and the constraints. Then propose ideas, push back on weak ones, and iterate with me.

## 1. The challenge
- **Industrial Agents Hackathon 2026, Track 01 "Talk to Your Building"**, by Synera, an industrial engineering software company. It runs Sat 24 to Sun 25 October 2026.
- Teams build an **AI agent you can talk to about a building**, backed by a deterministic core: a graph of rooms, doors, corridors, stairs and lifts, plus assets, and shortest paths.
- **Levels** (each builds on the previous):
  1. **Locate:** find things on a floor and show them.
  2. **Route:** A to B, step-free routes, closed areas, multi-stop tours.
  3. **Scale:** several floors and buildings, with stairs, lifts and walkways.
  4. **Build:** create or update a building from floor plans, by conversation, in minutes.
  5. **Extend** (optional, pick one and do it well): moving assets, several users, industrial logistics, capture on site with a phone, accessibility routing, presentation (isometric floors, animated routes, voice), or AR.
- **Judging:**

  | Part | Points | What counts |
  |---|---|---|
  | Does it work | 55 | Automatic tests on unseen buildings |
  | Interaction | 25 | A scripted conversation with tricky users. The agent asks only what it needs, shows what it understood, and gives directions people can follow. |
  | Creativity | 10 | Level 5 and add-ins |

- **What the organisers told us:**
  - The jury **uses the app by hand in a browser**: web first, laptop and phone, no native or iOS app.
  - It must work **without explanation**: a building is preloaded, example questions are buttons, and nothing crashes.
  - The jury **likes video games**.
  - The camera is allowed.
  - Suggested use case: an in-house fair in an automotive factory.
- **It must work on any building** in the dataset format: 280 buildings, from university campuses and apartment blocks to factories and offices. On Sunday it runs on a building nobody has seen. So no hand-made art per building: everything is generated from the data.

## 2. The product: Lost & Found → building emergency management
We pivoted. The main story is now **damage in a building: fire, water, electricity**.

User story and video storyline:
1. **Damage recognition and alarm.** An employee sees water dripping or smoke and reports it from the phone: a photo and/or a few words. AI classifies it (fire, water or electrical; severity 1–3; immediate danger yes or no) and the room is confirmed. Simulated **sensors** (smoke detectors, leak sensors, power monitors) can also raise it.
2. **The incident appears on the platform.** An alarm banner and sound appear on every open screen, and the building manager sees it in 3D.
3. **What it means for the building:**
   - which rooms are affected and when, over a timeline;
   - water: the floor below and the rooms next door;
   - fire: smoke through corridors and up stairwells;
   - electrical: which circuit or zone goes dark;
   - **cascades**, e.g. water reaching a server room cuts its power;
   - people at risk and critical assets (server racks, electrical panels, machines);
   - for fire, **evacuation routes** that avoid the fire, with lifts off and rooms cut off.
4. **Automatic response.** A playbook starts and calls the right people: fire brigade 112, facility manager, plumber, electrician, IT, insurer. Each call shows a live status (calling → connected → confirmed, ETA). The response also includes damage-limiting steps: water shut-off, power isolation, moving equipment.
5. **Simulations for building managers.** "What if a fire or leak starts here?" Pick any room and watch the spread on a timeline. Plus a **readiness check**: a building score with findings such as "rooms more than 20 m from an extinguisher", "only one way out through corridor X", "server room below a bathroom", "no defibrillator", each shown on the map.

The original features stay underneath, and they are what the automatic tests score:
- chat Q&A about the building ("where is the 3D printer?", "step-free route from A to B", "what is below room X?") with turn-by-turn directions;
- importing a building from floor plans (SVG, PNG or `building.json`);
- correcting the building by conversation.

**Users:**
- employees on a phone, who report and need to know where to go;
- building / facility managers on a laptop, who monitor, simulate, check readiness and coordinate;
- the jury, who will click everything.

## 3. What exists today (current UI)
- **Full-screen 3D model** of the building (three.js), white "studio" look with Synera brand colours:
  - navy `#002478` for the interface;
  - orange `#f05c03` for answers and actions;
  - route gradient blue → violet → pink → coral.
- **Map style switch**, like map vs satellite in Google Maps:
  - *Blocks*: a white massing model;
  - *Detailed*: textured floors by room type, walls with door gaps, generated 3D furniture models, doors coloured by entrance / step-free / step.
- **Floor rail** on the right (⌂, 6, 5, … G, B1): one floor at a time, with badges for alerts and people.
- **Clicking a room** flies the camera in and opens a room card (name, area, what's inside, "Route here", "I'm here", "Simulate here: 🔥 Fire · 💧 Water · ⚡ Power").
- **Start screen:** "Ask me anything." with a chat input and example-question chips. It disappears once you explore a floor.
- **Header:** building switcher, **🚨 Report damage** (red), **🛡 Readiness**, location chip, team avatars and an inbox. The avatars and inbox belong to the old multiplayer feature, which is being removed or hidden.
- **Hazard panel** on the left (bottom sheet on phones):
  - header with the hazard icon and room, and "Simulation" or "Live incident";
  - a timeline slider with play;
  - stats (spaces hit, people at risk, critical assets, without power);
  - cascade notes;
  - tabs: Rooms (grouped as where it started / floor below / next door / same floor), Assets, Evacuation, Response (the playbook with live call statuses).
- **3D hazard tints:** fire red, water blue, power cut a light yellow wash. Opacity follows the level over time. There is a pin at the origin, and evacuation routes are animated gradient lines.
- **Alarm banner** at the top centre, pulsing and coloured by hazard, with View and Resolve.
- **Report damage sheet:** photo (the camera opens directly on phones), description, "Check with AI", hazard chips, severity chips (Minor / Spreading / Danger), room picker, "Raise the alarm".
- **Readiness sheet:** score /100 and a ranked list of findings. Clicking one highlights its rooms on the map.

Known weak spots:
- the header is getting crowded;
- the hazard panel is dense;
- the power-cut tint is subtle;
- water across two floors needs a better "stacked" view;
- there's no clear "control room" mode for managers vs a "just tell me where to go" mode for employees;
- there are no game-like moments yet: no character walking the evacuation route, no onboarding quest, no "all clear" success moment.

## 4. Constraints
- **Web only**, responsive: laptop for managers and the jury, phone for employees. Built in Next.js 16 / React 19 / Tailwind 4 / three.js.
- **Everything is data-driven** from `building.json`: rooms (polygons and types), doors (width, step-free), stairs and lifts, assets (type, footprint), floors. No per-building assets or texts.
- Fast to build: we have hours, not weeks. Prefer ideas that reuse what exists (3D tints, the timeline, the panel, sheets, banners).
- **Accessible:** colour isn't the only signal (icons and labels too), and it's readable on a projector.
- Calls are **simulated**; we don't really dial 112. The UI should feel real but be honest that it's a demo where needed.
- Keep the chat agent visible and useful. "Interaction" is 25 points: the agent should be able to answer "what happens if the kitchen floods?" or "how do people get out of floor 3?" and drive the map.

## 5. What I want from you
1. **Three distinct UI directions** for the emergency product, each with a one-line pitch, the layout (manager laptop and employee phone), the key screens in order of the video storyline, and why the jury would remember it. For example: "Control room" (dark ops dashboard), "Living dollhouse" (game-like isometric building that reacts), "Google-Maps-for-emergencies" (calm, map first).
2. For the strongest direction:
   - a **screen-by-screen flow** for the 5-step storyline;
   - **ASCII wireframes** for the laptop and the phone;
   - component names mapped to what already exists;
   - motion and sound cues;
   - copy for the key labels.
3. **Ten quick wins**: small changes with a big wow effect we can build in under an hour each. Examples: a little figure walking the evacuation route, a "time to safety" countdown, a "before / after shut-off" comparison, a heat-map of readiness, an "all clear" moment.
4. **How to show cascades and multi-floor water** clearly in 3D: an exploded floor stack, a cross-section, a side elevation, arrows.
5. **Mode design:** how employees, managers and the jury each get the right entry point without a login wall.
6. Anything in the current UI you would **remove** to make the story sharper.

Ask me clarifying questions only if a choice changes the direction. Otherwise make a recommendation, and we'll iterate.
