# UI inventory and simplification (25 Oct 2026)

Goal: easy to grasp at first sight, low cognitive load, professional rather than playful. One primary action per screen, colour only where it means something (hazards), no emoji in the interface.

## User flows

| # | Flow | Who | Steps today | Target |
|---|---|---|---|---|
| 1 | Ask the building (challenge Q&A: locate, route, step-free, closures, areas, stacking…) | anyone, jury | type, or tap one of ~11 chips → answer card + 3D + directions | type, or tap one of **2 example questions** → same |
| 2 | Explore | anyone | floor rail → floor → tap room → room card (name, area, contents, Route here, I'm here, Simulate ×3) | same, calmer card: **Route here** (primary), Simulate (secondary row), I'm here (link) |
| 3 | Simulate (what if) | manager, jury | room card → Fire/Water/Power → x-ray view + right panel (stats, drill bar, cascade notes, 5 tabs) + playback bar | also from the start screen (**Simulate a fire / a water leak** on a sensible room). Panel: **3 tabs** (Overview, Affected, Response), 3 stats |
| 4 | Report an incident | employee | header "🚨 Report damage" → sheet (photo, text, AI check, type, severity, room) → alarm | header **Report incident** (the only coloured button) → same sheet, no emoji |
| 5 | Live incident | manager | banner (pulsing) → View → panel → Start response → Resolve | banner (static, coloured dot) → same |
| 6 | Readiness | manager | header "🛡 Readiness" → sheet → tap finding → rooms on map | header text button **Readiness** → same |
| 7 | Sign in (demo accounts) | everyone | "Who are you?" sheet on first visit; avatars in header | same sheet; header shows **one initials button** |
| 8 | Add a building | team, jury | building switcher → buildings sheet → upload | unchanged |

## Inventory: what is on screen, and the decision

**Header**

| Element | Decision |
|---|---|
| Logo "◈ lost & found" | keep |
| Building switcher, "280 buildings" button | keep the switcher, drop the duplicate count button |
| Simulation / Live badge | keep, quieter |
| 🚨 Report damage (red) | → **Report incident** (accent), no emoji |
| 🛡 Readiness | → plain text button |
| Location chip "Set your location" | hide (location is set via "I'm here" on a room) |
| Team avatars, inbox ✉, "Team" pill (multiplayer) | **hide** (code stays; see decision below) |
| (new) account initials button | add: opens the demo-login sheet |

**Map overlays**

| Element | Decision |
|---|---|
| Blocks / Detailed switch with preview tiles | → small text segmented control |
| Floor rail with badges | keep; badges only for live incidents |
| Room card | keep, fewer buttons, no emoji |
| Hover tip | keep |
| Answer labels, route, markers | keep; no emoji in hazard labels |
| World anchors: people, pins, counts (multiplayer) | hide |
| Evacuation figures (5 colours) | → 3 states: grey waiting, navy moving, green safe; red only for trapped |
| Hazard tints, x-ray, arrow to key room | keep |

**Bottom / dock**

| Element | Decision |
|---|---|
| "Ask me anything." hero | keep |
| ~11 example chips | → 2 questions + 2 simulations |
| "+" report button in the ask bar (multiplayer pins) | hide |
| Skill chips, mention picker, passer-by (multiplayer) | hide |
| Mic | keep |
| Scenario playback bar | keep |

**Panels and sheets**

| Element | Decision |
|---|---|
| Hazard panel: emoji icon, 4 stats, drill bar, cascade notes, 5 tabs, emoji action icons | coloured dot instead of emoji, 3 stats, one cascade line, **3 tabs** (Overview · Affected · Response, with evacuation inside Overview), no emoji |
| Alarm banners (pulsing) | static, coloured left edge |
| Report sheet: emoji chips | plain chips |
| Readiness sheet: emoji per finding | severity bar only |
| Multiplayer sheets (messages, person, pin, settings, location, inbox toasts) | not reachable from the UI any more |

## Decision on multiplayer
Hidden from the interface, not deleted: the code, the database and the chat-side closures stay, so it can come back (Level 5 "several users", 10 Creativity points) without rework. Emergency incidents replace it as the shared, realtime layer.
