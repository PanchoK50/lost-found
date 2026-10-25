# Pitch video recordings: notes

Run `node video/record.mjs [clip[:phone|desktop] ...]` (default: every enabled clip). Flags:
- `--list` lists the clips.
- `--paid` is required for clips that ask Claude (A1).
- `--keep-frames` keeps the raw frames in `out/.frames/`.

The app must already be running (Next.js :3000, agent API :8000). The script does not start or stop anything.

- Desktop: 1920x1080, CDP screencast at about 55–60 fps, encoded to H.264 yuv420p 30 fps CFR, CRF 18.
- Phone: 390x844 CSS px at device scale 3, so 1170x2532 output. Headless Chrome's screencast ignores the
  device scale (frames are 390 px wide), so the phone is captured with a `Page.captureScreenshot` loop and
  resampled to 30 fps. The loop runs at about 20 fps in simulations, about 14–16 fps in A1 and about 10 fps in
  the first 2 s of A2, while the page is still loading. Motion is choppier than on desktop but sharp.
  If smoothness matters more, set the phone `deviceScaleFactor: 1` (screencast at 60 fps, 390x844) and
  upscale in the edit.
- Trimming: `h.mark('start')` and `h.mark('end')` cut away loading and sign-in. A single take can also produce
  named cuts (`h.cut(name)` / `h.cutEnd()`), each written to its own file.
- Every take signs in as "Jury" first and clears `localStorage['lf-incidents']`.
  Map style is 'detailed'. The Next.js dev badge is hidden with injected CSS.
- Stills: `out/stills/<clip>-<viewport>-<moment>.png` at full resolution. While a still is taken, the phone
  capture loop pauses, because parallel captures garbled the frames.
- The phone CSS workarounds were removed after app commit 4322ab7. Phone clips now show the app as it is.
  Old evidence: `out/stills/bug-phone-model-collapsed.png` and `bug-phone-sideways-shift.png` (both fixed).

## Clips (re-recorded on 4322ab7)

| File | Shows | Duration |
|---|---|---|
| `A6-fire-{phone,desktop}.mp4` | Whole take, +0.9 → +10.5 sim min: people on floor 3 walk out along the routes (+1 to +2 min), then the fire takes floors 3 and 4 | 20 s |
| `A6-fire-walk-*` | Cut: people walking out, fire in 1–2 rooms | 4.8 s |
| `A6-fire-spread-*` | Cut: +4.3 → +10.5, from 2 spaces to about 50 | 9 s |
| `A6-water-{phone,desktop}.mp4` | Toilet 0.18 leaks across the ground floor; at +12.5 the view switches to Basement 1, where water reaches Server room -1.09 (about +15) and spreads to about 30 basement spaces | 13.4 s |
| `A6-power-{phone,desktop}.mp4` | Meeting room 2.25 electrical fault: 33 spaces in the amber zone, lifts Closed, people leaving | 10.2 s |
| `A1-route-phone.mp4` | Best take (take 2): the question is typed, one "Looking it up…" shows, the answer arrives at about 16 s and the route draws via Staircase 1 | 24 s |
| `A1-route-phone-take1.mp4` | Take 1, kept as evidence of the route/text mismatch (see below) | 26 s |
| `A2-A5-incident-{phone,desktop}.mp4` | One continuous take of A2 → A5 | 16 s |
| `A2-notify-*` / `A3-overview-*` / `A4-technician-*` / `A5-resolve-*` | Cuts of that take: the alert slides in → tap it, live incident overview → "Call technician" ticket → key "f", fixed and the zone fades | 2.3 / 6 / 4 / 3.7 s |

URLs (building `proc-campus-test-005`):
- Fire: `/?building=proc-campus-test-005&simulate=fire:proc-campus-test-005-F3-S025`. On desktop only, one
  30-unit wheel zoom toward the fire room happens before the clip starts.
- Water: `&simulate=water:proc-campus-test-005-F0-S018`. The script clicks "Basement 1" at about +12.5 min.
- Power: `&simulate=electrical:proc-campus-test-005-F2-S025`.
- A1: `/?building=proc-campus-test-005`. The script types into "Ask about the building":
  "Power is out in Meeting room 2.25 and the lifts are down. How do we get out?" Outputs: the answer text in
  `out/A1-route-answer.txt`, the raw `/api/chat` reply in `out/A1-route-api.json`.
- A2–A5: `&notify=electrical:proc-campus-test-005-F2-S025`, then click `.incident-toast`, click
  "Call technician" (the phone scrolls the ticket into view), blur the focused element, press `f` (the phone
  scrolls "Status: fixed" into view).

## Check after the fixes (4322ab7)

Fixed and confirmed in the footage:
- Phone layout: the model is visible, the header is compact ("Laborgebäude 029", Report incident, account)
  and the floor strip no longer shifts the page.
- A1 shows a single "Looking it up…".
- A2: the alert sits below the phone header.
- The evacuee figures are bigger and readable on desktop and phone.

Still wrong or worth improving:
1. **A1 route vs text: still inconsistent in 1 of 2 takes** (2 paid takes, ~$0.04).
   - Take 1: the text recommends Staircase 1 → Corridor 0.01 / Main lobby, "Total: about 55 m", and mentions
     Staircase 2 (86 m) as the fallback. The route card says "2.25 → 0.02 · 86 m · 3 closed", and the map line
     goes via **Staircase 2 to Corridor 0.02**. Still: `out/stills/A1-take1-mismatch-route.png`.
   - Take 2: the text and the route agree. The card says "2.25 → 0.15 · 55 m". The `spacePath` is
     F2-S025 → F2-S001 → F2-S007 → F1-S007 → F0-S005 → F0-S001 → F0-S015, and the text names Staircase 1.
     This answer did **not** mention a Staircase 2 fallback.
   - So the mismatch seems to appear when the agent also plans the fallback. The "recommended, not explored"
     fix does not cover that case yet: the route shown is still the last one planned.
2. **A1: the answer still lands scrolled to the bottom on the phone.** At about 16 s the pane shows step 3
   onwards. The route summary card and steps 1–2 are above the fold, and it stays like that.
3. **A1 framing:** the camera shows the vertical stair line, with the start floor (Floor 2) cut off at the top
   edge and the exit at the bottom edge.
4. On the phone, the route label ("Seminar room 3.25 → Lab 3.11", "Meeting room 2.25 → Print room 2.10") sits
   next to or over the red "Closed" tags. It is readable but busy.
5. The slow intro of a simulation (first 6 sim minutes over about 20 s) makes the fire take 20 s long if it
   shows both the people and the spread. A `?t=` start time or `?speed=` link would allow tighter takes.
   The two fire cuts are the workaround.
6. Wheel zoom is very sensitive: one 120-unit notch flies into the slab. A camera focus or zoom deep link
   would allow close-ups.
7. A3: the UPS / server backup countdown from the incident-flow commit is not visible in either A3 still.
   The phone shows only the first facts, and the desktop panel shows Power off, Lifts, People and Equipment.
   If it is meant for the shot, it needs to sit higher in the panel.
