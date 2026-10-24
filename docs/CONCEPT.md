# UX-Konzept und Ideen

Lost & Found · Industrial Agents Hackathon 2026, Track 01 · Stand: Sa, 24.10.2026

Ergänzt [TECH_MUST_HAVES.md](TECH_MUST_HAVES.md) (Pflicht-Technik) und [UX_MUST_HAVES.md](UX_MUST_HAVES.md) (Pflicht-UX). Hier steht, **wie** die App aussehen und sich anfühlen soll und welche Extras wir obendrauf bauen können.

---

## Stand und Entscheidungen

- **Aufteilung:** Zwei aus dem Team bauen den technischen Kern (Graph, Routing, Geometrie-Tools, Benchmark) bis zu einem einfachen Chat. **Rabea und Andy** verantworten die UX-Schicht darüber, in Next.js unter `website/`. Rabeas Arbeit liegt auf dem Branch `Rabea`.
- **Schnittstelle:** Die UI liest Agenten-Antworten über den Vertrag aus TECH_MUST_HAVES T20 (`text`, `understood`, `highlights`, `route`, `clarification`, `changes`). Bis das Backend steht, bauen wir gegen eine Platzhalter-Route mit echten `building.json`-Daten.
- **Machbarkeit:** Ein Prototyp-Solver beantwortet alle 655 Benchmark-Fragen aus train und dev richtig. Der Benchmark ist also lösbar, und die UX kann den Unterschied machen.
- **Bewertung:** 55 Punkte Funktion, 25 Interaktion, 10 Kreativität, 10 Demo-Video.

---

## Leitidee

**"Lost & Found – frag dein Gebäude."** Jedes Gebäude wird zu einem begehbaren Puppenhaus, das spricht, alles exakt nachrechnen kann und jede Antwort direkt auf der Karte zeigt.

Der Name ist die Geschichte: Menschen, die sich verlaufen haben (*lost*), Dinge, die man sucht (*found*), und ein Gebäude, das selbst spricht.

## Drei Säulen

| Säule | Was | Bewertung |
|---|---|---|
| **Die Engine rechnet** | Deterministischer Kern. Claude übersetzt nur zwischen Mensch und Engine. Jede Zahl kommt aus einem Tool | Funktion (55) |
| **Das Gebäude spricht** | Ich-Form, Verstanden-Chips, Rückfragen nur bei echter Mehrdeutigkeit, Landmarken, Sprache | Interaktion (25) |
| **Das Puppenhaus zeigt** | Isometrisch gestapelte Etagen, animierte Route, Brillen, die die Benchmark-Fragen sichtbar machen | Kreativität (10), Demo (10) |

## Brillen: das Herzstück der UX

Jede Brille ist zugleich ein **Nutzerprofil** und eine **Fragenart aus dem Benchmark**, sichtbar gemacht. Die gewählte Brille bleibt gespeichert. Damit erfüllen wir nebenbei die Forderung "step-free, every time, without asking twice".

| Brille | Was man sieht | Steckt dahinter |
|---|---|---|
| Zu Fuß | schnellste Route | Routing |
| Rollstuhl | Unerreichbares wird grau, Treppen sind gesperrt | `step_free_reachable_count` |
| Stapler / Lieferung | nur Wege ab der nötigen Breite, Engpass-Tür in Rot | `wide_delivery_count`, Gabelstapler-Regeln |
| Facility | Flächen, Türbreiten, gemeinsame Wände | `largest_room`, `floor_area_total`, `shared_walls_count` |
| Röntgen | Raum darüber und darunter, 3D-Linie zwischen zwei Räumen | `room_stacked`, `straight_line_3d` |

## Look und Feel: Architekturmodell

- Stockwerke wie Kartonplatten, Räume in gedeckten Farben nach Typ. Das passt zur bestehenden Beige-Grün-Palette in `website/`.
- Die Route in **Signal-Orange**, als Linie, die sich animiert ausrollt, mit einem Punkt, der sie abläuft.
- **Vorschläge** (neue Türen, erkannte Räume) gestrichelt wie Bleistift, bis sie bestätigt werden.
- **Gesperrtes** rot schraffiert.
- Die Stimme des Agenten in Serifenschrift, die Bedienoberfläche in serifenloser Schrift.

**Technischer Trick:** Das Puppenhaus braucht kein three.js. Jedes Stockwerk ist ein SVG, das per CSS gekippt und gestapelt wird (`transform: rotateX(58deg) rotateZ(-38deg) translateZ(…)` mit `transform-style: preserve-3d`). Die Route ist ein Pfad mit animiertem `stroke-dashoffset`. So lässt sich der bestehende SVG-Viewer in wenigen Stunden umbauen. three.js kommt nur dazu, wenn am Ende Zeit übrig ist.

**Layout:** links der Chat (Sprache und Text, Verstanden-Chips, Schritte), rechts das große Puppenhaus mit den Brillen als Umschalter. Mobil ist die Karte im Vollbild und der Chat ein Panel von unten.

## Signatur-Feature (eins auswählen)

Die Challenge sagt bei Level 5 ausdrücklich: **eine Erweiterung richtig statt drei halb.**

1. **"Vom Fluchtplan zum Gebäude"** (Level 4 und Kreativität, riskant): Man fotografiert einen Flucht- und Rettungsplan, Claude Vision erzeugt `building.json`, und die Engine prüft das Ergebnis. Das Gebäude erscheint als Bleistiftskizze im Puppenhaus und wird per Sprache korrigiert. Als Absicherung dienen die sauberen `floor_*_plain.png` aus dem Datensatz.
2. **Werkzeug-Fundbüro** (passt zum Namen, mittlerer Aufwand): "Wo ist der Drehmomentschlüssel?" zeigt, wo er zuletzt gesehen wurde und von wem. "Hab ihn in 2.14 gelegt" aktualisiert die Karte, auch per Barcode-Scan.
3. **Präsentation** (deckt sich mit dem Puppenhaus): isometrische Etagen, animierte Routen, Sprache. Das ist eine offizielle Level-5-Option.

## Demo-Story in 2 Minuten

1. **0:00** Die Facility-Managerin fotografiert einen Fluchtplan. Das Puppenhaus baut sich auf.
2. **0:30** Eine Rollstuhlfahrerin fragt: "Wo ist die CNC-Fräse?" Die Chips erscheinen, die Route rollt sich über Lift West aus.
3. **1:00** Per Sprache: "Lift West ist gesperrt." Die Rollstuhl-Brille graut ab, was nicht mehr erreichbar ist, und das Gebäude sagt es ehrlich.
4. **1:30** Ein Wasserschaden: Die Röntgen-Brille zeigt den Raum darunter, die Route wird umgeleitet.
5. **1:50** Abschluss: "Lost & Found – jedes Gebäude kann sprechen."

## Bewusst weggelassen

AR, die Erfassung durch Begehung mit dem Handy, und mehrere Gebäude über das Pflichtprogramm von Level 3 hinaus.

---

## Ideen-Pool

Aufwand: `S` etwa 1–2 Stunden, `M` ein halber Tag, `L` aufwendig oder riskant.

**Gespräch:** Verstanden-Chips `S` · Rückfrage-Buttons mit Kartenvorschau `S` · Landmarken-Wegbeschreibung `M` · Profil merken `S` · vage Wünsche übersetzen ("Kaffee", "ich muss mal") `S` · Minuten statt Meter `S` · "Warum diese Route?" `S` · proaktive Hinweise bei Sperrungen `S` · mehrsprachig `S`

**Stimme:** Push-to-talk und Vorlesen `M` (Web Speech API gratis, ElevenLabs als Upgrade) · Audio-Navigation mit "weiter" `M` · das Gebäude spricht in Ich-Form `S`

**Wo bin ich?** Foto vom Türschild → Raumnummer `S` · Ortung durch Beschreibung ("ich sehe eine rote Maschine") `M` · QR-Sticker-Bogen für alle Türen `S` · Route per QR-Code aufs Handy `S`

**Visualisierung:** Puppenhaus mit Explosionsansicht `M–L` · Routen entlang echter Laufwege `M` · Erreichbarkeits-Overlay `S` · Benchmark-Fragen sichtbar (Röntgen, Laserlinie, gemeinsame Wände) `S–M` · Was-wäre-wenn-Vergleich `S` · Ego-Perspektive `M` · hoher Kontrast und große Schrift `S`

**Bauen und ändern:** Fluchtplan-Foto → Gebäude `L` · Grundriss-Upload mit Overlay und Korrektur per Sprache `L` · Änderungen als Vorschau mit Undo `S` · Änderungsprotokoll und Schichtübergabe `S` · Türen auf der Karte zeichnen `M`

**Fabrik und Logistik:** Werkzeug-Fundbüro `M` · Gabelstapler-Modus `M` · Milk-Run-Planer `S` · "Passt das durch?" `S` · Störfall-Ablauf `M` · Live-Updates an andere Nutzer `M`

**Alltag:** Onboarding-Rundgang für den ersten Tag `S` · Treffpunkt-Finder `S` · ruhige Route `S` · Evakuierungsmodus (Demo, nicht zertifiziert) `S` · Besucherpass mit QR-Route `S`

---

## Notion-Backlog des Teams

[Lost & Found — Feature Backlog](https://app.notion.com/p/Lost-Found-Feature-Backlog-4039ee8868f781ceb7a4f4d77653aa13) (öffentlich lesbar, Bearbeiten braucht ein Notion-Konto)

| # | Idee | Bezug |
|---|---|---|
| 1 | Multiplayer: "Schick X den Weg zum nächsten Y" | Kreativ. Passt zu "mehrere Nutzer" und zum Treffpunkt-Finder |
| 2 | Bei unklaren Anfragen nachfragen | **Pflicht** (UX_MUST_HAVES U5) |
| 3 | Live-Änderungen am Gebäude (Tür blockiert, Lift kaputt) | **Pflicht im Kern** (T17, U8). Benachrichtigungen sind das kreative Extra |
| 4 | Wiederverwendbare Skills ("nächste Kaffeemaschine") | Kreativ. Ein Skill kann sich die Antworten auf Rückfragen merken |
