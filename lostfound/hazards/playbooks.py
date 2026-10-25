"""Response playbooks: who to call and what to do, per hazard, ordered and filled in from the impact.

Calls are simulated: each action gets a timeline (dialing, connected, confirmed) relative to the incident's start,
so every screen shows the same progress without writing status updates to the database."""

from lostfound.core.building import Building

DEFAULT_CONTACTS = [
    {"id": "fire_brigade", "role": "fire_brigade", "name": "Feuerwehr (fire brigade)", "phone": "112", "eta_min": 8},
    {"id": "facility", "role": "facility", "name": "Facility manager on duty", "phone": "+49 89 1234 5600", "eta_min": 5},
    {"id": "security", "role": "security", "name": "Site security", "phone": "+49 89 1234 5601", "eta_min": 3},
    {"id": "plumber", "role": "plumber", "name": "Sanitär-Notdienst Huber GmbH", "phone": "+49 89 5550 1200", "eta_min": 35},
    {"id": "electrician", "role": "electrician", "name": "Elektro-Notdienst Maier", "phone": "+49 89 5550 3400", "eta_min": 15},
    {"id": "it", "role": "it", "name": "IT on call", "phone": "+49 89 1234 5699", "eta_min": 15},
    {"id": "insurer", "role": "insurer", "name": "Building insurance claims line", "phone": "+49 800 555 0100", "eta_min": None},
]


def contacts_by_role(contacts: list[dict] | None) -> dict[str, dict]:
    merged = {c["role"]: c for c in DEFAULT_CONTACTS}
    for contact in contacts or []:
        merged[contact["role"]] = {**merged.get(contact["role"], {}), **contact}
    return merged


def plan(building: Building, impact: dict, evacuation: dict | None = None, severity: int = 2, contacts: list[dict] | None = None) -> list[dict]:
    """Ordered actions. `auto` actions start by themselves when the incident is confirmed; the rest wait for a tap."""
    people = contacts_by_role(contacts)
    hazard, origin = impact["hazard"], impact["origin"]
    place = f"{origin['name']} ({origin['floor']})"
    floors = impact["floors"]
    servers = [a for a in impact["assets_at_risk"] if a["type"] == "server_rack"]
    powered = [a for a in impact["assets_at_risk"] if a["type"] in ("server_rack", "electrical_panel") or a["weight"] >= 4]
    below = [r for r in impact["rooms"] if r["relation"] == "below"]
    actions: list[dict] = []

    def add(kind: str, title: str, detail: str, role: str | None = None, auto: bool = True, space_ids: list[str] | None = None):
        contact = people.get(role) if role else None
        actions.append({"kind": kind, "title": title, "detail": detail, "auto": auto, "space_ids": space_ids or [],
                        "contact": contact, "eta_min": contact.get("eta_min") if contact else None})

    if hazard == "fire":
        add("alarm", "Sound the fire alarm", f"Building-wide alarm, starting on {', '.join(floors[:3])}.", space_ids=[r["space_id"] for r in impact["rooms"]][:80])
        add("call", "Call the fire brigade", f"Fire in {place}. About {impact['people_at_risk']} people in the affected area"
            + (f"; {len(evacuation['cut_off'])} rooms cut off" if evacuation and evacuation["cut_off"] else "") + ".", "fire_brigade")
        add("evacuate", "Evacuate", (f"Everyone out by the routes shown; longest way out {evacuation['longest_m']:.0f} m (about {evacuation['longest_min']:.0f} min). " if evacuation else "")
            + "Lifts are switched off.", space_ids=[r["space_id"] for r in (evacuation or {}).get("cut_off", [])])
        add("shutoff", "Lifts to ground floor, out of service", "Lifts park on the ground floor and stay off until the fire brigade releases them.")
        add("call", "Alert site security", "Meet the fire brigade at the main entrance with the building plan and keys.", "security")
        add("notify", "Inform the facility manager", f"Fire in {place}.", "facility")
        if servers:
            add("notify", "Warn IT", f"Server racks in the fire area ({servers[0]['room']}). Start a controlled shutdown if it is safe.", "it", auto=severity >= 2)
    elif hazard == "water":
        add("notify", "Inform the facility manager", f"Water damage in {place}" + (f", spreading to {len(below)} rooms below." if below else "."), "facility")
        add("shutoff", "Shut off the water supply", f"Close the water valve for {origin['floor']} (in the technical room or the riser next to {origin['name']}).", "facility")
        add("call", "Call the emergency plumber", f"Leak in {place}. Find and stop the source.", "plumber")
        if below:
            add("notify", "Warn the rooms below", f"Water is coming through the ceiling into {', '.join(r['name'] for r in below[:3])}{'…' if len(below) > 3 else ''}. Move equipment and paper away.",
                space_ids=[r["space_id"] for r in below])
        if powered:
            add("shutoff", "Switch off power where water meets electrics", f"{len(powered)} electrical items in the wet area, e.g. {powered[0]['name']} in {powered[0]['room']}.", "facility",
                space_ids=sorted({a["space_id"] for a in powered}))
            add("call", "Call an electrician", "Check the wet circuits before the power goes back on.", "electrician", auto=severity >= 2)
        if servers:
            add("notify", "Warn IT", f"Servers in the path of the water ({servers[0]['room']}). Shut down and cover them.", "it")
        add("call", "Report the claim to the insurer", "Photos and the affected rooms from this report.", "insurer", auto=False)
    else:
        add("shutoff", "Isolate the circuit", f"Switch off the breaker for {place}" + (f" ({impact['power_outage_spaces']} spaces without power)." if impact["power_outage_spaces"] else "."), "facility")
        add("call", "Call an electrician", f"Electrical fault in {place}.", "electrician")
        add("notify", "Inform the facility manager", f"Power is off in {impact['power_outage_spaces']} spaces.", "facility")
        if servers:
            add("notify", "Warn IT", "Servers on the affected circuit: check the UPS and shut down in order.", "it")
        add("call", "Call the fire brigade if there is smoke or a smell of burning", "Electrical fires: don't use water.", "fire_brigade", auto=severity >= 3)
    for order, action in enumerate(actions):
        action["order"] = order
        # Simulated progress, in seconds after the incident is confirmed (calls go out one after another).
        start = order * 4
        action["timeline"] = ([{"at_s": start, "status": "dialing"}, {"at_s": start + 5, "status": "connected"}, {"at_s": start + 11, "status": "confirmed"}]
                              if action["kind"] == "call" else [{"at_s": start, "status": "in_progress"}, {"at_s": start + 6, "status": "done"}])
    return actions
