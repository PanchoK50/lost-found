# UX-Design

Lost & Found · Industrial Agents Hackathon 2026, Track 01 · Stand: Sa, 24.10.2026

Klickbares Mockup: [`mockup/ux-mockup.html`](mockup/ux-mockup.html) im Browser öffnen, neu bauen mit `uv run python docs/mockup/build_mockup.py [gebäude-ordner]`.

Setzt [UX_MUST_HAVES.md](UX_MUST_HAVES.md) (U1–U12) und das Konzept aus [CONCEPT.md](CONCEPT.md) in konkrete Screens, Komponenten und Zustände um. Jede Komponente liest nur, was der Antwortvertrag aus [TECH_MUST_HAVES.md](TECH_MUST_HAVES.md) T20 liefert, plus die `building.json` für Namen und Geometrie.

---

## Grundsätze

1. **Karte und Chat sagen dasselbe.** Jede Antwort hat ein Gegenstück auf der Karte: Chip ↔ Markierung, Schritt ↔ Routenabschnitt, Rückfrage-Button ↔ nummerierter Kandidat.
2. **Annahmen sind sichtbar und änderbar.** Was der Agent verstanden oder sich gemerkt hat, steht als Chip da. Ein Tipp darauf korrigiert es.
3. **Nichts passiert heimlich.** Änderungen am Gebäude erscheinen zuerst als Bleistift-Vorschau und gelten erst nach "Übernehmen".
4. **Gebäude-unabhängig.** Farben kommen aus `type` und `room_type`. Unbekannte Werte fallen auf eine neutrale Farbe zurück. Der Ausschnitt kommt aus der Bounding Box der Etage. Nichts ist für ein bestimmtes Gebäude gebaut.
5. **Eine Hand, laute Halle.** Alles Wichtige geht auch per Sprache und mit großen Knöpfen.

---

## Layout

### Desktop (ab 1024 px)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ ◈ lost & found   [Gebäude: Werk Nord ▾]        Brille: (Zu Fuß)(♿)(Stapler)(Facility)(Röntgen)   [⚙] │
├──────────────────────────────┬─────────────────────────────────────────────────┤
│ CHAT                 400 px  │ BÜHNE                                            │
│                              │  ┌────┐                                          │
│  ┌ Verstanden ────────────┐  │  │ 3  │   [ Plan | Puppenhaus ]      Legende ▾   │
│  │ 📍 Lobby → ◎ Kantine    │  │  │ 2  │                                          │
│  │ ♿ stufenlos  ⛔ Lift Ost│  │  │▶1  │        ┌──────┬──────────┐              │
│  └────────────────────────┘  │  │ 0  │        │      │   ◎      │              │
│  Ich bringe dich über Lift   │  │ -1 │   ●━━━━━━━━━━━━┛          │              │
│  West hin, etwa 2 Minuten.   │  └────┘        │      │          │              │
│   1 ↑ Geradeaus den Flur …   │  Etagen-       └──────┴──────────┘              │
│   2 ↰ Links am Kaffee …      │  leiste                                          │
│   3 ⇅ Lift West → 1. OG      │          Lift West → 1. OG  ⓘ                   │
│  ⏱ 2 Min · 84 m  [Warum?]    │                                                  │
│                              │                                                  │
├──────────────────────────────┤                                                  │
│ Gemerkt: 📍Lobby ♿stufenlos ✕│                                                  │
│ [Wo krieg ich Kaffee?] [Lift…]│                                                  │
│ ┌──────────────────────┐ (🎤) │                                                  │
│ │ Frag dein Gebäude …  │  ➤  │                                                  │
│ └──────────────────────┘      │                                                  │
└──────────────────────────────┴─────────────────────────────────────────────────┘
```

- **Links der Chat**, rechts die **Bühne** mit Karte (Plan oder Puppenhaus), **Etagenleiste** und **Legende**.
- **Brillen** oben rechts als Segment-Umschalter. Die gewählte Brille ist zugleich das Profil (U7) und wird in `localStorage` gespeichert.
- **Gemerkt-Leiste** direkt über dem Eingabefeld: der Zustand der Sitzung (Standort, Profil, Sperrungen). Sie bleibt immer sichtbar.

### Tablet (768–1023 px)
Chat als ausklappbare Spalte über der Karte (360 px), Karte voll im Hintergrund.

### Mobil (ab 375 px), siehe U11
Karte im Vollbild, Chat als Bottom-Sheet.

---

## Visuelle Sprache

Baut auf der bestehenden Palette in `website/src/app/globals.css` auf (Beige-Grün, Akzent Lime).

| Token | Wert | Verwendung |
|---|---|---|
| `--ink` | `#273322` | Text, Raumumrisse |
| `--muted` | `#71796c` | Nebentext, Labels zweiter Ordnung |
| `--paper` | `#f5f6f0` | Hintergrund, "Karton" der Etagen |
| `--line` | `#e0e4d9` | Trennlinien |
| `--accent` | `#d8f578` | Ziel, Auswahl, aktiver Chip |
| `--route` | `#ff6a1a` | Route, Startpunkt (Signal-Orange) |
| `--blocked` | `#d64545` | Gesperrtes, rot schraffiert |
| `--pencil` | `#5b6b8c` | Vorschau, gestrichelt (Bleistift) |
| `--unreachable` | `--ink` bei 12 % | Unerreichbares, ausgegraut |

**Raumfarben nach Typ** (gedeckt, auf Papier):

| Gruppe | `type` / `room_type` | Farbe |
|---|---|---|
| Verkehr | `corridor`, `lobby`, `stairwell`, `stair`, `lift` | `#e4e7df` |
| Arbeit | `office`, `meeting_room`, `seminar_room`, `lecture_hall`, `library` | `#eef1e8` |
| Produktion | `hall`, `production_zone`, `assembly_zone`, `additive_zone`, `makerspace`, `lab`, `quality_lab` | `#f1ead8` |
| Logistik | `warehouse_zone`, `logistics_zone`, `storage` | `#e9e1d0` |
| Versorgung | `kitchen`, `canteen`, `toilet`, `bathroom`, `locker_room` | `#e3ece6` |
| Technik | `server_room`, `technical_room`, `print_room` | `#e6e4ec` |
| Wohnen | `bedroom`, `living_room` | `#f4efe6` |
| Außen | `outdoor`, `balcony` | Papier, gepunktet |
| Unbekannt | alles andere | `#f9faf6` |

**Schrift:** Die Stimme des Agenten in einer Serifenschrift (z. B. `Fraunces` über `next/font`), die Bedienoberfläche serifenlos (`Inter`). Raumlabels auf der Karte serifenlos, Name fett, `ref` darunter in `--muted`.

**Bewegung:** Die Route rollt sich in 900 ms aus (`stroke-dashoffset`), ein Punkt läuft sie danach in Schleife ab. Etagenwechsel als Überblendung in 250 ms. Bei `prefers-reduced-motion` erscheint alles sofort.

---

## Komponenten

| Komponente | Datei (Vorschlag) | Liest aus T20 | U |
|---|---|---|---|
| `AppShell` | `components/app-shell.tsx` | – | U11 |
| `BuildingPicker` | `components/building-picker.tsx` | `GET /api/buildings` | U2 |
| `LensSwitch` | `components/lens-switch.tsx` | – (setzt Profil) | U7 |
| `ChatPanel` | `components/chat/chat-panel.tsx` | Nachrichtenliste | U1 |
| `Message` | `components/chat/message.tsx` | `text` | U1 |
| `UnderstoodBar` | `components/chat/understood-bar.tsx` | `understood` | U4 |
| `ClarificationCard` | `components/chat/clarification-card.tsx` | `clarification` | U5 |
| `RouteSteps` | `components/chat/route-steps.tsx` | `route.steps`, `route.length_m` | U6 |
| `ChangeCard` | `components/chat/change-card.tsx` | `changes` | U8 |
| `ErrorCard` | `components/chat/error-card.tsx` | `text`, `clarification` | U9 |
| `MemoryBar` | `components/chat/memory-bar.tsx` | Sitzungszustand | U7 |
| `Composer` | `components/chat/composer.tsx` | – | U1, U10 |
| `VoiceButton` | `components/voice/voice-button.tsx` | – | U10 |
| `VoiceGuide` | `components/voice/voice-guide.tsx` | `route.steps` | U10 |
| `Stage` | `components/map/stage.tsx` | alles Kartenrelevante | U2, U3 |
| `FloorPlan` | `components/map/floor-plan.tsx` | `building.json`, Overlays | U2 |
| `FloorRail` | `components/map/floor-rail.tsx` | Etagen, Etagen mit Treffern | U2, U3 |
| `RouteLayer` | `components/map/route-layer.tsx` | `route.legs` | U3 |
| `HighlightLayer` | `components/map/highlight-layer.tsx` | `highlights` | U2, U5 |
| `ChangeLayer` | `components/map/change-layer.tsx` | `changes`, `understood.closures` | U3, U8 |
| `ImportWizard` | `app/import/page.tsx` | Import-API (T18) | U12 |

`FloorPlan` ist reine Darstellung: Polygone, Labels, Türen, Gegenstände. Alles andere sind Layer darüber. So lassen sich Puppenhaus und Brillen später aufsetzen, ohne `FloorPlan` umzubauen.

---

## Die Features im Einzelnen

### U1 Chat mit kurzen, gestreamten Antworten

**Aufbau einer Agenten-Nachricht** (von oben nach unten, jeder Block optional):

```
┌──────────────────────────────────────┐
│ [Verstanden-Leiste]            U4    │
│ Antworttext in Serifenschrift  U1    │
│ [Rückfrage-Buttons]            U5    │
│ [Schritte 1–6, Dauer]          U6    │
│ [Änderungskarte]               U8    │
│ Warum diese Route? · Auf Karte zeigen│
└──────────────────────────────────────┘
```

**Zustände:**

| Zustand | Darstellung |
|---|---|
| Wartet auf erste Tokens | Drei pulsierende Punkte im Stil des Agenten |
| Tool läuft | Zeile in `--muted` mit Icon: "🔎 Suche Route …", "📐 Rechne Flächen …", "🔒 Prüfe Sperrung …". Wechselt live |
| Streamt | Text erscheint wortweise. Chips, Schritte und Karten kommen erst, wenn das JSON vollständig ist, dann mit kurzem Einblenden |
| Fertig | Aktionen am Fuß der Nachricht werden sichtbar |
| Abgebrochen | "Gestoppt." und ein Button "Nochmal" |

- Während des Streamens wird der Senden-Knopf zu **Stopp ■**.
- Der Verlauf liegt im Client-State und geht bei jeder Anfrage an `POST /api/chat` mit, damit Folgefragen funktionieren ("und von dort zur Toilette?").
- Neue Nachrichten scrollen nur automatisch, wenn man schon unten ist. Sonst erscheint ein Hinweis "↓ Neue Antwort".
- Leerer Zustand: kurzer Gruß in Ich-Form ("Ich bin **Werk Nord**. Frag mich nach Räumen, Wegen oder Maschinen.") und drei Vorschläge, die aus dem aktuellen Gebäude kommen. Gibt es eine Kaffeemaschine, heißt einer "Wo krieg ich Kaffee?"; gibt es mehr als einen Lift, heißt einer "Lift … ist gesperrt".
- **Akzeptanz:** Die Punkte erscheinen sofort, die erste Tool-Zeile oder das erste Wort nach höchstens 3 s.

### U2 Kartenansicht mit Hervorhebung und Etagenwechsel

```
┌────┐
│ 3  │   Etagenleiste: Kurzname (Level), Tooltip mit vollem Namen.
│ 2 •│   • = auf dieser Etage gibt es Treffer oder Route
│▶1 •│   ▶ = aktive Etage
│ 0  │   Tastatur: Bild↑ / Bild↓
│ -1 │
└────┘
```

- **Ausschnitt:** Im Plan wird jede Etage auf ihre eigene Bounding Box eingepasst, weil Etagen sehr unterschiedlich groß sein können (Fabrikhalle im EG, schmaler Büroriegel im 1. OG). Im Puppenhaus teilen alle Etagen einen Ausschnitt, damit sie übereinander passen. y wird gespiegelt.
- **Zoom und Verschieben:** Mausrad, Pinch, Ziehen. Button "⤢ Einpassen". Bei einer neuen Antwort fährt die Karte auf die Highlights bzw. die Route.
- **Labels:** am `representative_point` des Polygons. Name nur, wenn er in den Raum passt, sonst nur `ref`, bei sehr kleinen Räumen gar nichts, Name dann als Tooltip. Flure ohne Label.
- **Türen** als kurze Lücke bzw. Strich in der Wand, **Treppen und Lifte** mit Symbol (▤ ⇅).
- **Gegenstände:** Standardmäßig ausgeblendet (es sind oft Tausende). Gezeigt werden nur Gegenstände aus der Antwort und Landmarken der Route, als Punkt mit Label an ihrer `position`.
- **Automatischer Etagenwechsel:** Nach einer Antwort springt die Karte auf die Etage des Ziels bzw. auf die erste Etage der Route.
- **Hover und Klick:** Hover zeigt eine Karte mit Name, `ref`, Typ und Fläche. Klick setzt den Raum als Standort oder Ziel ("Von hier" / "Hierhin") und schreibt die Frage ins Eingabefeld.

**Highlight-Rollen aus `highlights[].role`:**

| Rolle | Darstellung |
|---|---|
| `target` | Füllung `--accent`, Umriss 2 px `--ink`, Ziel-Pin ◎ |
| `candidate` | Füllung `--accent` 50 %, nummerierter Pin ①②③, passend zu den Rückfrage-Buttons |
| `unreachable` | ausgegraut, diagonale Schraffur |
| `changed` | Umriss gestrichelt in `--pencil` |

- **Performance:** Ein `<path>` pro Raum, Labels in eigener Ebene, nur die aktive Etage im DOM (im Puppenhaus: alle Etagen, Labels nur auf der aktiven). Memoisiert pro Gebäude und Etage.
- **Akzeptanz:** OSM-Gebäude mit 8 Etagen und mehr als 300 Räumen lädt in unter 2 s, Zoomen bleibt flüssig.

### U3 Route auf der Karte, über mehrere Etagen

```
 Etage 0                         Etage 1
 ┌─────────┬────────┐            ┌────────┬─────────┐
 │ ● Start │        │            │        │   ◎     │
 │  ┗━━━━━━━━━━━┓   │    ⇅       │   ┏━━━━━━━━┛     │
 │          [⇅ Lift West → 1. OG]│   ┃    │         │
 └──────────────┸───┘            └───┸────┴─────────┘
```

- **Linie:** `--route`, 4 px, runde Enden, weißer Rand für Kontrast. Gezeichnet aus `route.legs[].points` der jeweiligen Etage.
- **Start** als ausgefüllter Kreis ●, **Ziel** als Pin ◎ im Zielraum.
- **Etagenwechsel:** Am Ende des Abschnitts eine Pille "⇅ Lift West → 1. OG" bzw. "▤ Treppe Nord → 2. OG". Ein Klick springt zur nächsten Etage. In der Etagenleiste sind alle Etagen der Route mit • markiert und durch eine orange Linie verbunden.
- **Abspielen:** Bei einer neuen Route läuft sie automatisch ab: Abschnitt auf Etage A rollt sich aus, Wechsel, Abschnitt auf Etage B. Danach bleibt die Karte auf der Zieletage. Button "▶ Nochmal abspielen".
- **Schritte ↔ Karte:** Hover über Schritt 3 im Chat hebt den passenden Abschnitt hervor und springt auf dessen Etage (`steps[].floor_id`).
- **Gesperrtes** aus `understood.closures` und angewendeten `changes`: Raum oder Lift rot schraffiert, Tür als rotes ✕, Treppe oder Lift mit Schloss 🔒.
- **Puppenhaus-Modus:** Gleiche Layer, alle Etagen gestapelt. Der Etagenwechsel wird als senkrechte gestrichelte Linie zwischen den Platten gezeichnet.
- **Akzeptanz:** Eine Route über zwei Etagen ist ohne Text verständlich.

### U4 "Verstanden"-Zusammenfassung

```
┌ Verstanden ──────────────────────────────────────────┐
│ (📍 Lobby ▾) → (◎ Kantine ▾)  (♿ stufenlos ✕) (⛔ Lift Ost ✕) │
└──────────────────────────────────────────────────────┘
```

| Chip | Aus | Tipp darauf |
|---|---|---|
| 📍 Start | `understood.start` | Liste der Räume mit Suche, oder "auf der Karte wählen" |
| ◎ Ziel | `understood.destination` | dasselbe |
| ♿ / 📦 1,1 m / 🚜 Bedingung | `understood.constraints` | ✕ entfernt sie und schickt die Frage neu |
| ⛔ Sperrung | `understood.closures` | ✕ hebt sie für diese Frage auf (Vorschau) |

- IDs werden über die `building.json` in Namen übersetzt. **Im UI erscheinen nie IDs.**
- Jede Korrektur über einen Chip erzeugt eine sichtbare Nutzernachricht ("Start: Werkstatt 0.03"), damit der Verlauf nachvollziehbar bleibt.
- Annahmen, die der Agent selbst getroffen hat, haben einen gepunkteten Rand und den Tooltip "angenommen". Beispiel: Er nimmt den nächsten Drucker, weil der Standort bekannt ist.
- Bei Änderungen am Gebäude zeigt die Leiste die Absicht: "✎ Lift Ost sperren", danach folgt die Änderungskarte (U8).
- **Akzeptanz:** Ein Jurymitglied sieht ohne Nachfragen, welche Annahmen der Agent getroffen hat.

### U5 Rückfragen nur bei echter Mehrdeutigkeit

```
 Welchen Drucker meinst du?
 ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐
 │ ① Druckraum 2.03     │ │ ② Büro 1.12          │ │ ③ Lager -1.04        │
 │   2. OG · 40 m       │ │   1. OG · 65 m       │ │   UG · 120 m         │
 └──────────────────────┘ └──────────────────────┘ └──────────────────────┘
```

- Aus `clarification.question` und `clarification.options`. Höchstens **eine** Rückfrage pro Antwort.
- Die Buttons tragen dieselben Nummern wie die Kandidaten-Pins auf der Karte (`role: candidate`). Hover über einen Button lässt seinen Pin pulsieren und springt auf die Etage.
- Ein Klick auf den Button **oder auf den Raum in der Karte** beantwortet die Frage. Die Wahl wird als Nutzernachricht gezeigt ("Druckraum 2.03"), die anderen Buttons werden ausgegraut.
- Freitext bleibt möglich. Das Eingabefeld zeigt dann den Platzhalter "oder schreib es".
- Ab vier Optionen werden die ersten drei gezeigt, dazu "+ 4 weitere".
- **Fragt der Agent nach dem Standort**, gibt es als feste Optionen zusätzlich "📍 Auf der Karte zeigen" und "Ich bin am Eingang".

### U6 Wegbeschreibung, der man folgen kann

```
 Ich bringe dich stufenlos über Lift West hin.
  1  ↑   Geradeaus den Hauptflur entlang
  2  ↰   Links an der Kaffeemaschine vorbei
  3  ⇅   Lift West in den 1. Stock
  4  ↱   Rechts aus dem Lift, dann die zweite Tür
  5  ◎   Kantine 1.20
 ⏱ ca. 2 Min · 84 m           [Warum diese Route?] [🔊 Vorlesen]
```

- Aus `route.steps` (höchstens 6), `route.length_m` und dem Profil.
- **Richtungs-Icon** pro Schritt: ↑ ↰ ↱ ⇅ ▤ ◎. Kommt aus `steps[].direction`, falls das Backend es liefert, sonst aus Schlüsselwörtern im Text.
- **Landmarken** fett, mit kleinem Punkt auf der Karte (`landmark_asset_id`).
- **Etagenwechsel** als eigener Schritt, optisch hervorgehoben.
- **Dauer** in Minuten, groß, Meter klein daneben. Zu Fuß 1,3 m/s, mit ♿ 0,9 m/s, mit Stapler eigene Angabe. Ein Lift zählt 30 s Wartezeit.
- **"Warum diese Route?"** klappt eine Zeile auf: "Stufenlos, deshalb Lift West statt Treppe Nord, 20 m länger." Das ist eine Folgefrage an den Agenten, keine Rechnung im Client.
- **Kopieren / Teilen:** Schritte als Text in die Zwischenablage. Optional QR-Code der URL mit Route.
- **Akzeptanz:** Jemand, der das Gebäude nicht kennt, kommt nur mit dem Text ans Ziel.

### U7 Bedingungen aus natürlicher Sprache, gemerkt

**Zwei Wege, dasselbe Ergebnis:** Man sagt es ("Ich sitze im Rollstuhl") **oder** man wählt die Brille. Beides setzt denselben Sitzungszustand.

```
 Gemerkt:  (📍 Lobby ✕) (♿ stufenlos ✕) (⛔ Lift Ost ✕)          [Alles vergessen]
```

| Sitzungszustand | Chip | Quelle |
|---|---|---|
| Standort | 📍 Name | Agent (`understood.start`), Klick auf Karte, QR |
| Profil: stufenlos | ♿ stufenlos | Agent (`constraints: step_free`), Brille "Rollstuhl" |
| Profil: Mindestbreite | 📦 ≥ 1,1 m | Agent (`constraints: min_width:1.1`) |
| Profil: Stapler | 🚜 Stapler | Agent, Brille "Stapler" |
| Sperrungen | ⛔ Name | angewendete `changes` |

- Die **Gemerkt-Leiste** sitzt über dem Eingabefeld und wird mit jeder Anfrage als Kontext an `/api/chat` geschickt. So muss der Agent nie zweimal fragen.
- Neu gemerkte Werte blinken einmal kurz auf, mit dem Hinweis "gemerkt".
- ✕ hebt einen Wert auf. Der Agent bestätigt im Chat: "Okay, ab jetzt wieder mit Treppen."
- Profil und Brille bleiben in `localStorage`, Standort und Sperrungen nur pro Sitzung und Gebäude.
- **Brillen** färben die Karte passend: Rollstuhl graut alles aus, was stufenlos nicht erreichbar ist (`unreachable`). Stapler zeigt nur Wege ab 3 m und markiert die engste Tür rot. Diese Daten liefert das Backend; ohne Backend zeigt die Brille nur den Chip.

### U8 Änderungen mit Vorschau und Bestätigung

```
 ┌ ✎ Vorschau ──────────────────────────────────────┐
 │ Lift Ost sperren                                  │
 │ Folgen: 3 Räume im 2. OG nur noch über Lift West, │
 │ Wege dorthin ca. 40 m länger. 1 Raum unerreichbar.│
 │                       [Verwerfen]  [Übernehmen ✓] │
 └───────────────────────────────────────────────────┘
          ↓ nach Übernehmen
 ✓ Lift Ost ist gesperrt.                         [Rückgängig]
```

- Aus `changes[]` mit `status: "preview"`. Auf der Karte gestrichelt in `--pencil`: eine neue Tür als gestrichelte Lücke, ein umgestellter Gegenstand mit gestricheltem Pfeil vom alten zum neuen Ort, eine Sperrung schraffiert.
- **Folgen** stehen im Text der Antwort. Betroffene Räume sind auf der Karte `changed` oder `unreachable`.
- **Übernehmen** schickt eine Bestätigung an den Agenten. Danach ist der Status `applied`, die Linien werden durchgezogen, die Gemerkt-Leiste bekommt den Chip, und ein Toast bietet 10 s lang "Rückgängig".
- **Verwerfen** entfernt die Vorschau ohne weitere Rückfrage.
- **Abgelehnt** (z. B. keine gemeinsame Wand): eine Karte in `--muted` mit Grund und, falls möglich, Alternative: "2.03 und 2.07 teilen keine Wand. Zwischen 2.03 und 2.04 ginge es. [Das stattdessen]".
- **Änderungsprotokoll:** ⚙ → "Änderungen (3)" zeigt die Liste mit Zeit und ✕ zum Zurücknehmen und bietet einen Export als `building_edited.json`.

### U9 Freundliche Fehlerbehandlung

| Fall | Darstellung |
|---|---|
| Unbekannter Raum ("9.99") | Text: "Raum 9.99 gibt es hier nicht." Darunter die ähnlichsten Treffer als Rückfrage-Buttons (U5), auf der Karte als Kandidaten |
| Keine Route unter den Bedingungen | `ErrorCard` mit Symbol 🚫, Grund in einem Satz ("Ins UG führt kein Lift."), Zielraum `unreachable` markiert, Alternative als Button ("Mit Treppe zeigen", "Nächste Toilette im EG") |
| Meinungswechsel | keine eigene UI. Der Start-Chip bleibt, nur der Ziel-Chip wechselt, kurz hervorgehoben |
| Netz- oder API-Fehler | Nachricht im Agentenstil: "Ich komme gerade nicht an meine Pläne. [Nochmal versuchen]". Die Eingabe bleibt erhalten. Nie ein Stacktrace oder Statuscode |
| Gebäude lädt nicht | Platzhalter in der Bühne mit Gebäudeauswahl, Chat bleibt benutzbar |
| Spracherkennung versteht nichts | "Hab dich nicht verstanden. Nochmal oder tippen?" |

### U10 Spracheingabe und -ausgabe

```
 Eingabefeld:  [ Frag dein Gebäude …      ] (🎤) ➤

 Beim Sprechen:
 ┌───────────────────────────────────────────┐
 │  ◉ Ich höre zu …   ▁▃▅▃▁▂▅▇▅▂               │
 │  "Wie komme ich zur Presse Linie 4"        │
 │                     [Abbrechen] [Senden ➤] │
 └───────────────────────────────────────────┘
```

- **Push-to-talk:** Mikrofon-Knopf gedrückt halten (Maus, Touch) oder Leertaste halten, wenn das Eingabefeld leer ist. Loslassen zeigt den erkannten Text. Mit "Automatisch senden" (Einstellung, Standard an) geht er nach 1 s ohne Korrektur raus.
- **Zustände:** bereit · hört zu (pulsierender Ring, Pegel) · verarbeitet · Fehler. Kein Mikrofonzugriff: Knopf ausgegraut mit Tooltip, warum.
- **Vorlesen:** Lautsprecher-Schalter in der Kopfzeile. Wurde die Frage gesprochen, wird die Antwort automatisch vorgelesen.
- **Sprach-Navigation** (`VoiceGuide`): Bei einer Route im Sprachmodus liest das Gebäude nur den **aktuellen Schritt** vor. Eine große Karte zeigt ihn, darunter [◀ zurück] [weiter ▶]. Gesagtes "weiter", "zurück" oder "nochmal" steuert sie. Die Karte folgt dem Schritt.
- Technik: Web Speech API (`SpeechRecognition`, `speechSynthesis`), Sprache aus der UI-Sprache. ElevenLabs später hinter derselben Schnittstelle.

### U11 Mobil benutzbar

```
 ┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
 │ ◈  Werk Nord ▾  (♿) │   │      Karte          │   │ ─── Chat ───────    │
 │                     │   │                     │   │ Verstanden …        │
 │      Karte          │   │ ┌─────────────────┐ │   │ Ich bringe dich …   │
 │     (Vollbild)      │   │ │ 2 ↰ Links an der│ │   │  1 ↑ …              │
 │                 [1] │   │ │   Kaffeemaschine│ │   │  2 ↰ …              │
 │                 [0] │   │ │   ◀  2/5  ▶     │ │   │  …                  │
 │─────────────────────│   │ └─────────────────┘ │   │                     │
 │ ▔▔▔                 │   │─────────────────────│   │                     │
 │ 📍Lobby ♿           │   │ ▔▔▔                 │   │ 📍Lobby ♿           │
 │ [Frag …     ] (🎤)  │   │ [Frag …     ] (🎤)  │   │ [Frag …     ] (🎤)  │
 └─────────────────────┘   └─────────────────────┘   └─────────────────────┘
   eingeklappt               Route aktiv              ausgeklappt
```

- **Bottom-Sheet** mit drei Stufen: eingeklappt (Gemerkt-Leiste und Eingabe), halb (letzte Antwort), voll (ganzer Verlauf).
- **Schritte als wischbare Karten** über der Karte, die Karte folgt dem aktuellen Schritt.
- **Großer Mikrofon-Knopf** (56 px), alle Ziele mindestens 44 × 44 px.
- Etagenleiste rechts am Rand, kompakt. Brillen hinter einem Profil-Knopf (♿) in der Kopfzeile.
- Kein Hover: Raum-Infos per Tipp, lange gedrückt für "Von hier / Hierhin".

### U12 Ablauf für den Grundriss-Import

Eigene Seite `/import`, erreichbar über die Gebäudeauswahl ("+ Grundriss importieren").

```
 ①Bild ─── ②Maßstab ─── ③Erkannt ─── ④Korrigieren ─── ⑤Prüfen
```

| Schritt | Inhalt |
|---|---|
| ① Bild | Drag-and-drop oder Kamera (mobil). PNG, JPG, PDF-Seite. Pro Etage ein Bild, Etagen benennbar. Beispielbild aus dem Datensatz als "Ausprobieren" |
| ② Maßstab | Erkannter Maßstab mit Begründung ("Maßstabsleiste 10 m"). Sonst zwei Punkte auf dem Bild klicken und Länge eingeben, oder "Türen sind 0,9 m breit" annehmen |
| ③ Erkannt | Das Bild halbtransparent, darüber die erkannten Räume als **Bleistift-Overlay** (gestrichelt, `--pencil`), Türen als Striche. Liste daneben: "12 Räume, 15 Türen". Hover verbindet Liste und Overlay |
| ④ Korrigieren | Chat neben dem Overlay: "Raum 3 ist die Küche", "hier fehlt eine Tür" (mit Klick auf die Stelle). Jede Korrektur wieder als Vorschau (U8) |
| ⑤ Prüfen | Prüfbericht mit Haken: ✓ Polygone gültig · ✓ 15 Türen auf gemeinsamen Wänden · ✓ alle Räume erreichbar · ✓ 2 Eingänge. Probleme verlinken auf die Stelle im Overlay. [Gebäude übernehmen] öffnet es in der normalen Ansicht |

- Während der Analyse: Fortschritt mit Klartext ("Erkenne Räume …", "Suche Türen …"), etwa 10–30 s.
- Scheitert die Erkennung: Erklärung und Angebot, ein Beispiel aus dem Datensatz zu nehmen.

---

## Barrierefreiheit

- Kontrast mindestens 4,5:1 für Text. Die Route hat einen weißen Rand, damit sie auf jedem Raumton sichtbar ist.
- Schalter **"Hoher Kontrast und große Schrift"** in ⚙: Schrift 125 %, Raumfarben durch Muster und kräftige Umrisse ersetzt.
- Tastatur: Tab durch Chat, Chips, Buttons. `Bild↑/↓` Etage, `+/-` Zoom, `Esc` schließt Popover, Leertaste halten für Sprache.
- Der Chat ist ein `aria-live="polite"`-Bereich. Die Karte hat eine Textalternative: Bei einer Route liest der Screenreader die Schritte.
- Farbe trägt nie allein Bedeutung: Gesperrtes ist zusätzlich schraffiert, Kandidaten nummeriert, Unerreichbares schraffiert.

---

## Die 12 Testszenarien im UI

| # | Szenario | Was man sieht |
|---|---|---|
| 1 | "Wo krieg ich Kaffee?" | Ohne Standort: Rückfrage mit "📍 Auf der Karte zeigen". Mit Standort: Ziel-Chip "Teeküche 1.05", Route, Kaffeemaschine als Landmarke |
| 2 | "Wo ist der Drucker?" | Standort bekannt: Ziel-Chip mit gepunktetem Rand ("angenommen: nächster"). Unbekannt: drei nummerierte Buttons und Pins |
| 3 | "Raum 9.99" | Fehlertext mit ähnlichen Räumen als Buttons, Kandidaten auf der Karte |
| 4 | Rollstuhl, später Kantine | Chip "♿ stufenlos" wandert in die Gemerkt-Leiste und blinkt "gemerkt". Zweite Route über den Lift, Chip auch in der Verstanden-Leiste |
| 5 | "Ostlift gesperrt" | Änderungskarte mit Folgen, Lift schraffiert, betroffene Räume gestrichelt. Nach Übernehmen: Chip ⛔ in der Gemerkt-Leiste |
| 6 | Tür zwischen 2.03 und 2.04 | Gestrichelte Tür auf der gemeinsamen Wand, Übernehmen. Ohne gemeinsame Wand: Ablehnungskarte mit Alternative |
| 7 | "Doch zur Toilette" | Start-Chip bleibt, Ziel-Chip wechselt, neue Route rollt aus |
| 8 | Techniker, Sprache | Push-to-talk, Sprach-Navigation Schritt für Schritt, "links an der Presse" fett |
| 9 | Stapler, Gang 4 blockiert | Brille Stapler, Chips 🚜 und ⛔, enge Türen rot, Umweg im Text |
| 10 | Stufenlos ins UG | `ErrorCard` "Ins UG führt kein Lift", Ziel schraffiert, Button "Mit Treppe zeigen" |
| 11 | Stahltrommel von gestern | Ziel-Chip mit Gegenstand, Pin an seiner Position. War er umgestellt: "zuletzt gesehen in …" mit gestricheltem Pfeil |
| 12 | CNC-Fräse jetzt in Halle 3 | Änderungskarte mit Pfeil alt → neu, nach Übernehmen bei Suchen der neue Ort |

---

## Wünsche an T20

Damit das Design ohne Raten funktioniert, braucht die UI vom Backend zusätzlich zu T20:

1. **Status-Events beim Streamen**, z. B. `{ "type": "status", "tool": "route" }`, für die Zeile "Suche Route …" (U1).
2. **`steps[].direction`** (`straight | left | right | up | down | arrive`), damit die Icons nicht aus Text geraten werden (U6).
3. **`steps[].leg_index`** oder Punktbereich, damit ein Schritt den passenden Routenabschnitt hervorheben kann (U3).
4. **`understood.assumed`**: welche Felder angenommen statt gesagt wurden (U4, gepunkteter Rand).
5. **`clarification.options[].floor_id` und `distance_m`** für die Zusatzzeile in den Buttons (U5).
6. **`changes[].geometry`** für die Vorschau: Position einer neuen Tür, alter und neuer Ort eines Gegenstands (U8).
7. **`route.floor_changes`** mit Verbindungsname und Ziel-Etage für die Pillen auf der Karte (U3). Alternativ aus `space_path` ableitbar.
8. **Sitzungszustand als Eingabe** an `/chat`: `{ location, profile, closures }` aus der Gemerkt-Leiste (U7).

Bis das Backend steht, liefert der Mock in `website/src/app/api/chat/` genau diese Felder.

---

## Reihenfolge für den Bau

| Block | Inhalt | Wer |
|---|---|---|
| 1 | `FloorPlan`, `FloorRail`, `BuildingPicker`, echte Gebäude über `/api/buildings` (U2) | Rabea |
| 2 | T20-Typ und Mock `/api/chat`, `ChatPanel`, `Message`, `Composer` (U1) | Andy |
| 3 | `HighlightLayer`, `UnderstoodBar`, `ClarificationCard` (U4, U5) | beide, Schnittstelle Highlights |
| 4 | `RouteLayer` mit Animation, `RouteSteps` (U3, U6) | Rabea Karte, Andy Schritte |
| 5 | `MemoryBar`, `LensSwitch`, `ChangeCard`, `ChangeLayer`, `ErrorCard` (U7, U8, U9) | aufteilen |
| 6 | Sprache, Mobil (U10, U11) | aufteilen |
| 7 | Puppenhaus-Modus der Bühne | Rabea |
| 8 | Import-Ablauf (U12), nur wenn T18 steht | offen |

Die Aufteilung ist nur ein Vorschlag, die Spalte "Wer" stimmt ihr selbst ab.
