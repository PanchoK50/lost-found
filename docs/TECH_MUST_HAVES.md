# Technische Must-haves für den Benchmark

Lost & Found · Industrial Agents Hackathon 2026, Track 01 · Stand: Sa, 24.10.2026

Ziel: die **55 Punkte "Does it work"** holen. Diese setzen sich zusammen aus

1. der **Test-CSV** (145 Fragen zu 40 Gebäuden, liegt schon vor),
2. dem **Sonntags-Benchmark** (ein unbekanntes Gebäude und eine Fragendatei, kurz vor dem Code Freeze),
3. **automatischen Prüfungen** zu Level 1–4: richtige Antworten, gültige Routen, Routenlänge im Vergleich zur besten, korrekt aus Plänen gebaute Gebäude.

Prioritäten: **P0** heißt ohne geht es nicht, **P1** heißt es bringt sicher Punkte und sollte bis Sonntag stehen.

---

## Überblick

| # | Feature | Prio | Betroffene Fragen / Prüfungen | Status |
|---|---|---|---|---|
| T1 | Robuster Loader für `building.json` | P0 | alle | offen |
| T2 | Gebäudegraph | P0 | alle Routen, Erreichbarkeit | Starter vorhanden |
| T3 | Namen und Referenzen auflösen | P0 | alle | Basis im Starter |
| T4 | Distanzmodell A (README) | P0 | `errand`, `what_if_door` | Starter vorhanden |
| T5 | Distanzmodell B (Synera, Tür zu Tür) | P0 | Routenprüfung, Sonntag | **offen, größtes Paket** |
| T6 | Routing-Bedingungen | P0 | Routen, Erreichbarkeit | teilweise |
| T7 | Touren und "nächster Raum mit X" | P0 | `errand`, Touren | vorhanden |
| T8 | Routen-Ausgabe als Raumliste | P0 | Routenprüfung | **offen, Format klären** |
| T9 | Flächen | P0 | `largest_room`, `floor_area_total`, `errand` | geprüft 100 % |
| T10 | Erreichbarkeit zählen | P0 | `wide_delivery_count`, `step_free_reachable_count` | geprüft 100 % |
| T11 | Gemeinsame Wände | P0 | `shared_walls_count` | geprüft 100 % |
| T12 | Raum darüber/darunter, 3D-Abstand | P0 | `room_stacked`, `straight_line_3d` | geprüft 100 % |
| T13 | Was-wäre-wenn-Tür | P0 | `what_if_door` | geprüft 100 % |
| T14 | Claude-Agent mit Tools und `answer()` | P0 | alle | offen |
| T15 | Benchmark-Befehl und `BENCHMARK.md` | P0 | Test-CSV, Sonntag | offen |
| T16 | Regressionstests gegen train und dev | P1 | Absicherung | Skript vorhanden |
| T17 | Änderungen am Gebäude (Status in der Sitzung) | P0 | Level 2–4, Sperrungen | Basis im Starter |
| T18 | Grundriss-Import (Bild wird zu `building.json`) | P1 | Level 4 | offen, riskant |
| T19 | Mehrere Gebäude | P1 | Level 3 | offen |
| T20 | API für die App | P0 | Basis für die UX | offen |

"Geprüft 100 %" heißt: Ein Prototyp-Solver hat alle 655 Benchmark-Fragen aus train und dev richtig beantwortet, wenn man ihm die `inputs` der Fragen gibt. Die Logik muss nur noch ins Repo und an den Agenten angebunden werden.

---

## Daten und Graph

### T1 Robuster Loader · P0
- Liest `building.json` (Gebäude, Etagen, Räume, Öffnungen, vertikale Verbindungen, Gegenstände).
- **Darf an unbekannten Werten nicht scheitern.** Sonntag kommen vermutlich neue Raumarten (Gänge, Stapler-Gänge, Fußwege, Rampen, Produktionsbuchten). Unbekannte `type`- oder `room_type`-Werte werden durchgereicht und geloggt.
- Ungültige Polygone reparieren (`buffer(0)`), fehlende optionale Felder mit Defaults füllen (`width_m` 0,9, `step_free` true).
- **Akzeptanz:** Alle 280 Gebäude in `data/` laden ohne Fehler, Laufzeit unter 1 s pro Gebäude.

### T2 Gebäudegraph · P0
- Knoten: ein Knoten pro Raum, ein Knoten pro Öffnung, ein gemeinsamer Knoten `outside`.
- Kanten: Raum zu Öffnung, Öffnung zu `outside` (Kosten 0), Treppe und Lift zwischen aufeinanderfolgenden Halten.
- **MultiGraph**, weil eine Treppe und ein Lift dieselben zwei Räume verbinden können. Beide Kanten bleiben erhalten.
- Kosten kommen aus einem austauschbaren Distanzmodell (T4 oder T5).

### T3 Namen und Referenzen auflösen · P0
- Akzeptiert: Raum-ID, `ref` ("2.03"), vollständigen Namen ("Office 2.03"), Name mit Etage ("Office 2.03 (Floor 2)"), Gegenstandsname oder -typ ("coat rack", "3D printer"), Verbindungsname ("Lift 1", "East lift").
- Etagen: "ground floor", "floor 2", "Basement 1" werden zu `level`.
- Mehrdeutig heißt: Kandidatenliste zurückgeben, nie raten. Unbekannt heißt: ähnliche Treffer vorschlagen.
- **Akzeptanz:** Für alle Fragen aus train und dev werden die Räume aus dem Fragetext auf genau die IDs in `inputs` aufgelöst.

---

## Routing

### T4 Distanzmodell A, README-Modell · P0
Damit wurden die erwarteten Antworten der CSV-Fragen berechnet (`errand` ±1 %, `what_if_door`).
- Anker jedes Raums: `Polygon(space.polygon).representative_point()` (shapely).
- Raum zu Öffnung: Luftlinie vom Anker zur `position` der Öffnung.
- Treppe: **12 m pro Etage** zwischen aufeinanderfolgenden Halten.
- Lift: **15 m Wartezeit plus 6 m pro Etage**.
- `starter_agent/building_map.py` setzt das exakt um.

### T5 Distanzmodell B, Synera-Modell · P0
Damit werden **Routen in der automatischen Prüfung** gemessen, wahrscheinlich auch am Sonntag.
- Gelaufen wird **innerhalb jedes Raums von Tür zu Tür**, mit etwa **15 cm Abstand zur Wand**, um Ecken herum und nie durch Wände.
- Treppe: **2 m Laufweg pro Meter Höhe**. Lift: **15 m plus 1 m pro Meter Höhe**. Die Höhe kommt aus `elevation_m` der Etagen.
- Möbel und Maschinen sind keine Hindernisse. Es zählen nur die Umrisse von Räumen und Gängen.
- Eine Route zu einem Gegenstand endet im Raum, in dem er steht, nicht an seiner Position.
- **Umsetzungsidee:** pro Raum das Polygon um 0,15 m schrumpfen (`buffer(-0.15)`). Die Türpunkte auf das geschrumpfte Polygon projizieren. Dann einen Sichtbarkeitsgraphen aus Türpunkten und konkaven Ecken bauen und die kürzesten Wege für jedes Türpaar im Raum vorberechnen. Der Routing-Graph hat danach Türen als Knoten und Raum-Durchquerungen als Kanten.
- **Wichtig:** Modell A und Modell B können **unterschiedliche Raumfolgen** als optimal ergeben. Für die Routenprüfung immer mit Modell B suchen.
- **Offen, bei Synera erfragen:** Wo beginnt und endet die Route im Start- und Zielraum (Tür, Schwerpunkt, Anker)?

### T6 Routing-Bedingungen · P0
| Bedingung | Regel |
|---|---|
| Stufenlos ("ohne Treppen", Rollstuhl, Rollwagen) | nur Lifte, Rampen und Türen. Jede Kante mit `step_free: false` fällt weg |
| Mindestbreite (Palette, Rollwagen) | jede durchquerte Öffnung braucht `width_m` ≥ Breite. Lifte sind erlaubt, Treppen nicht |
| Gabelstapler | nur Stapler-Gänge und Öffnungen **ab 3 m**, Fußwege zählen nicht |
| Gesperrt oder blockiert | Raum, Tür, Treppe oder Lift wird aus dem Graphen entfernt |
| Produktionsbuchten | **nur als Ziel** (Einfahrt zum Liefern), **nie als Durchfahrt** |
| Keine gültige Route | ausdrücklich sagen, dass keine Route existiert. Das ist dann die richtige Antwort |

- Umsetzung für Buchten: Ein Buchten-Knoten darf nur Start- oder Endknoten sein, also beim Dijkstra keine ausgehenden Kanten, außer er ist der Start.
- **Offen, bei Synera erfragen:** Wie sind Gänge, Stapler-Gänge, Fußwege, Rampen und Buchten in `building.json` markiert? Im aktuellen Datensatz gibt es sie nicht als Räume. Fabrikhallen sind dort `hall` mit `production_zone`, `logistics_zone` und ähnlichen Werten.

### T7 Touren und "nächster Raum mit X" · P0
- Mehrere Stopps in fester Reihenfolge (Summe der Teilrouten).
- "Nächster Raum mit X": der Raum mit Gegenstandstyp X, der **nach Laufdistanz** am nächsten liegt, nicht nach Luftlinie.
- Spezifikation für `errand`: Distanz(Start → nächster Raum mit Gegenstand) + Distanz(dieser Raum → größter Raum vom Typ T auf Etage E). Steht in der Frage "I can carry it on the stairs", gilt der volle Graph. Sonst stufenlos.

### T8 Routen-Ausgabe als Raumliste · P0
- Jede Route liefert `space_path`, die geordnete Liste aller durchquerten Räume, also Start, Flure, Treppenhäuser, Lifte und Ziel.
- Jeder Schritt muss über eine echte Tür, Öffnung, Treppe oder einen Lift gehen und die Regeln aus T6 einhalten. **Ein ungültiger Schritt heißt 0 Punkte.**
- Punkte = beste Länge ÷ unsere Länge. Innerhalb von 1 % gibt es volle Punkte. Unsere eigene Meterzahl wird ignoriert.
- **Offen, bei Synera erfragen:** das genaue Ausgabeformat (IDs oder Namen, in welcher Zeile).
- **Akzeptanz:** Ein Validator prüft jede ausgegebene Route gegen den Graphen, bevor sie rausgeht.

---

## Geometrie-Tools für die 145 Testfragen

Verteilung im Testset: `floor_area_total` 33 · `shared_walls_count` 26 · `largest_room` 21 · `errand` 20 · `wide_delivery_count` 18 · `straight_line_3d` 15 · `room_stacked` 9 · `what_if_door` 3.

**Gemeinsame Definition "Raum"** für alle Zählfragen: Räume mit `type` gleich `room` oder `hall`. Flure, Treppen, Lifte und Außenbereiche zählen nicht.

### T9 Flächen · P0
- Fläche = `Polygon(polygon).area` in m².
- `largest_room`: größter Raum mit `room_type` T auf Etage E. Antwort: Name oder Nummer **und** Fläche (±5 %).
- `floor_area_total`: Summe der Flächen aller Räume mit `room_type` T auf Etage E (±5 %).

### T10 Erreichbarkeit zählen · P0
- `wide_delivery_count`: stufenloser Graph (keine Treppen, keine Öffnungen mit `step_free: false`), nur Öffnungen mit `width_m` ≥ Mindestbreite, Lifte erlaubt. Gezählt werden die vom Start erreichbaren Räume auf Etage E. Das Ergebnis muss **exakt** stimmen.
- `step_free_reachable_count`: genauso, nur ohne Breitenregel und mit gesperrtem Element (z. B. Lift 1).

### T11 Gemeinsame Wände · P0
- Raum B teilt eine Wand mit A, wenn mindestens **1 m** der Außenlinie von A innerhalb von **0,35 m** der Außenlinie von B liegt, oder umgekehrt.
- Umsetzung: `A.exterior.intersection(B.exterior.buffer(0.35)).length` und dasselbe umgekehrt. Das Maximum muss ≥ 1,0 sein.
- Kandidaten: nur Räume (`room`, `hall`) auf derselben Etage, ohne A selbst. Mit oder ohne Tür dazwischen.

### T12 Raum darüber/darunter und 3D-Abstand · P0
- `room_stacked`: auf der nächsten vorhandenen Etage darüber oder darunter der Raum mit der **größten Überlappungsfläche** mit A. Nur Gebäude mit gemeinsamem XY-Koordinatensystem (prozedurale und OSM-Gebäude).
- `straight_line_3d`: Schwerpunkt (`centroid`, nicht `representative_point`) beider Räume, z-Wert = `elevation_m` der Etage, dann der euklidische 3D-Abstand (±2 %).

### T13 Was-wäre-wenn-Tür · P0
- Neue Tür in der **Mitte der gemeinsamen Wand**: Stück der Außenlinie von A innerhalb von 0,35 m um B, davon der Punkt bei halber Länge. Breite 0,9 m, stufenlos.
- Für jeden Raum auf der Zieletage die Distanz zum nächsten Ausgang (Modell A, Dijkstra ab `outside`) vorher und nachher berechnen. Gezählt werden Räume mit einer Verbesserung von **mehr als 1 m**.

---

## Agent, Benchmark und Absicherung

### T14 Claude-Agent mit Tools · P0
- Einstieg: `answer(building_directory: Path, question_text: str) -> str`. Das ist die Signatur, die `benchmark.evaluate --agent module:function` erwartet.
- Tools: Suche und Auflösung (T3), Route (T5–T8), Flächen (T9), Erreichbarkeit (T10), Wände (T11), Stapelung und 3D (T12), Was-wäre-wenn (T13), Änderungen (T17).
- Claude liest die Frage, löst Räume auf, ruft Tools auf und formuliert. **Jede Zahl kommt aus einem Tool, nie aus dem Kopf.**
- Gebäudeübersicht im Systemprompt mit Prompt Caching. Tool-Ergebnisse kompakt halten.
- **Antwortformat für die Bewertung**, siehe `benchmark/score.py`:
  - Gewertet wird nur die **letzte Zeile, die mit `Answer:` beginnt**. Ohne diese Zeile ist die Antwort falsch.
  - Zahlenantworten: **genau eine Zahl** in der Zeile. Also nicht "Floor 2: 14" und keine Spanne.
  - Raumantworten: der richtige Raum **vor** jedem anderen Raum in der Zeile. Bei `largest_room` muss zusätzlich die Fläche drinstehen.
  - Toleranzen: Fläche ±5 %, Laufweg ±1 % (mindestens ±1 m), 3D-Abstand ±2 %, Zählungen exakt.
- **Akzeptanz:** mindestens 95 % auf `questions.jsonl` in dev mit `benchmark.evaluate --agent ...`.

### T15 Benchmark-Befehl und `BENCHMARK.md` · P0
- **Ein** Befehl, ohne Handgriffe zwischen Eingabe und Ausgabe, z. B.
  `uv run --env-file .env python -m agent.benchmark <gebäude-ordner> <fragen-datei> --out answers.csv`
- Liest die Fragen flexibel: JSONL oder CSV, mit oder ohne `building_id`, ein Gebäude oder ein ganzer Split.
- Schreibt UTF-8-CSV mit `question_id,answer`, höchstens 5 MB, jede ID genau einmal.
- Fragen parallel abarbeiten, mit Wiederholung bei API-Fehlern und einem Kostenlimit. Fällt die API aus, trotzdem eine Zeile für jede ID schreiben.
- `BENCHMARK.md` dokumentiert den Befehl, die Voraussetzungen (`uv sync`, `.env`) und die erwartete Laufzeit und Kosten.
- **Generalprobe am Samstag:** ein dev-Gebäude wie ein unbekanntes behandeln und den Befehl einmal komplett durchlaufen lassen.

### T16 Regressionstests · P1
- pytest: Jedes Tool wird mit den `inputs` aus train und dev aufgerufen und mit `answer` verglichen. Das ist der Prototyp-Solver als Test.
- Läuft in wenigen Sekunden, ohne API-Kosten, vor jedem Merge.

### T17 Änderungen am Gebäude · P0
- Sperren und Öffnen (Raum, Tür, Treppe, Lift), Tür hinzufügen (nur zwischen Räumen mit gemeinsamer Wand), Gegenstand umstellen ("das steht jetzt in 2.14").
- Der Zustand gilt pro Sitzung. Änderungen gibt es erst als **Vorschau**, nach Bestätigung werden sie übernommen. Speichern als `building_edited.json`.

### T18 Grundriss-Import, Level 4 · P1
- Bild (PNG oder Foto) geht an Claude Vision, heraus kommen `spaces` mit Polygonen in Metern, `openings` und `floors`.
- Maßstab bestimmen (Maßstabsleiste, bekannte Türbreite oder Rückfrage).
- **Prüfung:** Polygone gültig, Türen auf gemeinsamen Wänden, jeder Raum erreichbar, mindestens ein Eingang.
- Absicherung für die Demo: die sauberen `floor_*_plain.png` aus dem Datensatz. Die Qualität lässt sich gegen die echte `building.json` messen.

### T19 Mehrere Gebäude, Level 3 · P1
- Mehrere `BuildingMap`-Objekte laden, über `outside` oder eigene Verbindungswege verknüpfen.
- Tools bekommen einen Parameter `building`.

### T20 API für die App · P0
FastAPI-Server mit `POST /chat` und `GET /buildings/{id}`. Jede Agentenantwort liefert neben dem Text strukturierte Daten für die Karte:

```jsonc
{
  "text": "Ich bringe dich über Lift West hin, etwa 2 Minuten.",
  "understood": { "start": "…-F0-S001", "destination": "…-F1-S020",
                  "constraints": ["step_free"], "closures": ["…-V02"] },
  "highlights": [ { "space_id": "…-F1-S020", "role": "target" } ],   // target | candidate | unreachable | changed
  "route": {
    "space_path": ["…-F0-S001", "…-F0-S010", "…-F0-S004", "…-F1-S004", "…-F1-S020"],
    "length_m": 84.2,
    "legs":  [ { "floor_id": "…-F0", "points": [[3.1, 4.0], [3.1, 12.5]] } ],
    "steps": [ { "text": "Geradeaus den Flur entlang, an der Kaffeemaschine vorbei",
                 "floor_id": "…-F0", "landmark_asset_id": "…-A00117" } ]
  },
  "clarification": null,   // { "question": "…", "options": [ { "label": "…", "space_id": "…" } ] }
  "changes": []            // [ { "op": "close", "element_id": "…", "status": "preview" | "applied" } ]
}
```

---

## Architekturvorschlag

```
lost-found/
  core/        Python: Loader, Graph, Distanzmodelle, Geometrie-Tools, Validator
  agent/       Claude-Schleife, answer(), chat(), benchmark-CLI
  api/         FastAPI: /chat, /buildings/{id}
  tests/       Regressionstests gegen train und dev
  src/         Next.js: Karte und Chat (vorhanden)
  BENCHMARK.md
```

Der Datensatz (209 MB) bleibt außerhalb des Repos. Der Pfad wird per Argument oder Umgebungsvariable übergeben.

---

## Offene Fragen an Synera

1. Ausgabeformat der Routen: IDs oder Namen, in welcher Zeile?
2. Wo beginnt und endet eine Route im Start- und Zielraum?
3. Wie sind Gänge, Stapler-Gänge, Fußwege, Rampen und Produktionsbuchten markiert? Zählen die bestehenden `production_zone`-Hallen als Buchten?
4. Werden die CSV-Fragen weiter nach dem README-Modell bewertet?
5. Wann genau kommt am Sonntag das Gebäude, und in welchem Format sind die Fragen?
6. Wie wird "Gebäude korrekt aus Plänen gebaut" automatisch geprüft?
