# Gebäude-GeoGuessr

Lost & Found · Rabea · Sa, 24.10.2026

**Die Idee in einem Satz:** Du stehst irgendwo im Gebäude und siehst nur den Raum um dich herum. Du tippst auf der Karte, wo du glaubst zu sein, und bekommst Punkte nach der echten **Laufdistanz** zwischen deinem Tipp und der Lösung.

**Warum das mehr ist als ein Gag:**
- **Onboarding:** Neue Mitarbeitende lernen ihr Gebäude spielerisch kennen, in der ersten Woche jeden Tag eine Runde.
- **Die Jury mag Videospiele.**
- **Es zeigt, dass die App räumlich denkt.** Das Spiel benutzt dieselbe Geometrie wie der Benchmark (Flächen, gemeinsame Wände, Räume darüber und darunter, Laufwege). Das passt genau zu Syneras Kern: Agenten, die Raum und Geometrie verstehen.
- **Kein API-Key nötig.** Alles ist deterministisch und kostet keine Credits.

---

## 1. Ablauf einer Partie

1. **Start** unter `/guess?building=<id>`: Gebäude wählen, Modus wählen, Start. Eine Partie hat **5 Runden**.
2. **Runde:** Links (am Handy oben) siehst du den **Hinweis**, je nach Modus (Abschnitt 2). Rechts (am Handy unten) ist die **Karte** des Gebäudes mit Andys 3D-Szene, aber **ohne Raumnamen**.
3. **Tippen:** Etage wählen, auf einen Raum tippen, er wird markiert, dann **"Hier bin ich!"**.
4. **Auflösung:**
   - Die Kamera fliegt zum richtigen Raum.
   - Eine **Route von deinem Tipp zur Lösung** wird gezeichnet, mit dem Label "37 m daneben".
   - Jetzt erst erscheint der echte Name: *"Es war: Rolex 😅"*.
   - Die Punkte zählen hoch.
5. **Ende:** Gesamtpunkte (maximal 25.000), eine Zeile pro Runde, ein Teilen-Text im Wordle-Stil und "Nochmal".

## 2. Drei Modi

| Modus | Was man sieht | Aufwand | Schwierigkeit |
|---|---|---|---|
| **Silhouette** | Nur der Umriss des Raums, zufällig gedreht und ohne Maßstab. Dazu die Türen als Lücken | gering | leicht bis mittel |
| **Detektiv** | Text-Hinweise aus der Geometrie, nacheinander aufdeckbar. Jeder zusätzliche Hinweis kostet Punkte | gering | einstellbar |
| **Raum-Blick** (wie Street View) | Ego-Perspektive in 3D: Wände aus dem Polygon, Türlücken, Möbel und Maschinen als einfache Blöcke. Man kann sich umschauen | mittel | mittel |

Alle drei Modi teilen sich Runden, Karte, Punkte und Auflösung. Nur die Hinweis-Komponente unterscheidet sich.

### Detektiv-Hinweise
Jeder Hinweis wird aus den Daten berechnet, nichts ist erfunden. Der erste Hinweis ist gratis, jeder weitere kostet **500 Punkte**.

- "Der Raum hat etwa **24 m²**." (auf 5 gerundet)
- "Es gibt **2 Türen**." (Öffnungen, die zu diesem Raum gehören)
- "Drin stehen: **3 Schreibtische, 1 Kaffeemaschine, 1 Drucker**." (aus `assets`, häufigste Typen zuerst)
- "Der Raum teilt eine Wand mit einem **Serverraum**." (`sharedWall` aus `geometry.ts`)
- "Direkt darüber liegt eine **Küche**." (größte Überlappung auf der Etage darüber)
- "Bis zum nächsten **Lift** sind es **18 m** zu Fuß." (`WalkGraph.distancesFrom`)
- "Du bist auf **Etage 1**." (der teuerste Hinweis: 1.500 Punkte)

### Raum-Blick (Ego-Perspektive)
- **Kamera** auf 1,6 m Höhe am Ankerpunkt des Raums. Man kann nur drehen und schauen, nicht rauszoomen (OrbitControls mit festem Abstand oder PointerLock).
- **Wände:** eine Fläche pro Polygonkante, Höhe aus `height_m` der Etage (sonst 3 m). Boden in der Farbe des Raumtyps.
- **Türen:** Für jede Öffnung des Raums wird an `position` auf der nächsten Kante eine Lücke mit `width_m` ausgeschnitten. Durch die Lücke sieht man ein Stück helleren Boden.
- **Gegenstände:** Boxen mit `footprint` (Breite, Tiefe, Drehung). Die Höhe kommt aus der Kategorie (Tisch 0,75 m, Schrank 2 m, Maschine 1,8 m, Kleinkram 0,4 m), die Farbe auch. Kleine **Emoji-Schilder** über typischen Gegenständen machen es spielbar: ☕ coffee_machine, 🖨️ printer, 🤖 robot_cell, 🧯 fire_extinguisher, 🛋️ sofa, 🛁 bathtub, 🏧 atm, 🧪 fume_hood, 🍫 vending_machine, 🏗️ forklift.
- **Kein Text** mit Raumnamen oder Nummern im Bild.

## 3. Welche Räume vorkommen

- Nur Räume vom `type` `room` oder `hall`, mindestens **6 m²**, mit mindestens **2 Gegenständen** oder mindestens 2 Türen. Keine Flure, Treppen oder Lifte.
- **Fairness:** Für jeden Raum wird ein **Fingerabdruck** berechnet: Flächenstufe, Anzahl Türen, Menge der Gegenstandstypen.
  - **Leicht** zieht Räume mit **einzigartigem** Fingerabdruck.
  - **Schwer** zieht Räume, die mehrere Doppelgänger haben.
- Die 5 Runden liegen möglichst auf **verschiedenen Etagen**.
- **Zufall mit Seed** (z. B. mulberry32), damit eine Partie reproduzierbar ist:
  - `?seed=…` in der URL, damit man eine Kollegin herausfordern kann ("Schaffst du mehr als 18.400?").
  - **Tagesaufgabe:** `seed = buildingId + Datum`. Alle bekommen dieselben 5 Räume.

## 4. Punkte

- `d` ist die **Laufdistanz** vom getippten Raum zur Lösung, berechnet mit `new WalkGraph(building).distancesFrom(guessId)`. Eine falsche Etage ist damit automatisch teuer, weil Treppe oder Lift dazukommen.
- `scale` ist die Diagonale der Bounding Box des Gebäudes geteilt durch 4 (Laufwege sind deutlich länger als die Luftlinie, mit 8 war die Wertung zu hart). Damit funktioniert die Wertung im kleinen Haus genauso wie im TUM-Monster.
- `punkte = round(5000 · exp(−d / scale))` minus die gekauften Hinweise, mindestens 0.
- **Volltreffer** (der richtige Raum): 5.000 Punkte und ein kleines Konfetti.
- Ist ein Raum nicht erreichbar, zählt die Luftlinie in 3D mal 1,5.
- Zeile pro Runde für das Teilen: 🟩 ab 4.000 · 🟨 ab 2.000 · 🟧 ab 500 · 🟥 darunter.
  Beispiel: `Lost & Found GeoGuessr · Terminal 2 · 18.400 / 25.000 · 🟩🟨🟩🟥🟩`

## 5. Persönlichkeit (das Gebäude kommentiert)

Kurze Sprüche je nach Ergebnis, das Gebäude spricht in Ich-Form:
- Volltreffer: *"Du kennst mich besser als mein Hausmeister."*
- Falsche Etage: *"Kalt. Sehr kalt. Du bist im Keller, ich meinte das 5. OG."*
- Über 100 m daneben: *"Das ist nicht mal mehr derselbe Flügel."*
- Hinweis gekauft: *"Schummeln ist erlaubt. Aber ich merk's mir."*

## 6. Ordner und Code

Alles Neue liegt in eigenen Ordnern. Andys Code und der Multiplayer-Code werden möglichst nicht angefasst.

```
website/src/app/guess/page.tsx            Server-Komponente: liest den Katalog, übergibt das Gebäude (wie app/page.tsx)
website/src/components/guess/             Client-Komponenten
  guess-game.tsx                          Zustand der Partie: Runde, Tipp, Auflösung, Ende
  clue-silhouette.tsx                     SVG-Umriss mit Türlücken, zufällig gedreht
  clue-detective.tsx                      Hinweis-Karten mit Kosten
  clue-room-view.tsx                      Ego-Perspektive (react-three-fiber)
  result-card.tsx                         Punkte, Spruch, Teilen
website/src/lib/guess/                    Reine Logik ohne React, gut testbar
  random.ts                               Zufall mit Seed (mulberry32), Tages-Seed
  rooms.ts                                Auswahl und Fingerabdruck der Räume
  clues.ts                                Detektiv-Hinweise aus der Geometrie
  score.ts                                Punkte aus der Laufdistanz, Emoji-Zeile
  room-view.ts                            Wände, Türlücken und Boxen für die Ego-Perspektive
```

**Wiederverwenden:**
- `lib/buildings/types.ts`
- `geometry.ts` (`polygonArea`, `polygonCentroid`, `sharedWall`, `storeyHeights`)
- `walk.ts` (`WalkGraph.distancesFrom`, `route` für die Auflösung)
- `catalog.ts` (die Gebäude)
- Andys `BuildingScene` als Karte zum Tippen (`onSelect`) und für die Auflösung (`directive` mit `highlights` und `routes`)

**Die einzige nötige Änderung an Andys Szene:** eine optionale Prop **`hideLabels`**. Sonst verraten die Hover- und Tipp-Labels den Raumnamen. Standard ist `false`, damit sich in der Haupt-App nichts ändert.

**Look:** Andys Tokens (`--accent` Limettengrün, `--glass`, `--shadow`, `--ink`), mobil zuerst, große Knöpfe.

**Einstieg aus der Haupt-App:** ein kleiner Chip "🎮 Gebäude-GeoGuessr" bei den Vorschlägen, der auf `/guess?building=<aktuelles Gebäude>` verlinkt.

## 7. Spaßige Gebäude für das Spiel (optional)

Diese Gebäude wären für das Spiel besonders lustig. Für jedes muss die `building.json` nach `website/src/data/buildings/` kopiert, im Katalog eingetragen und **"© OpenStreetMap contributors, ODbL"** angezeigt werden.
- **Terminal 2** (`data/dev/osm-way360544293`): Lufthansa Lounge, Duty Free, Rolex, Hermès, Geldautomaten
- **Pasing Arcaden** (`data/train/osm-way52060470`): Aldi Süd, H&M, Metzgerei Boneberger

Keine Gebäude aus `data/test/` verwenden.

## 8. Bauplan

1. **Kern:** `lib/guess` (Zufall, Räume, Punkte), die Seite `/guess`, der Modus **Silhouette**, Tippen auf der Karte mit `hideLabels`, Auflösung mit Route und 5 Runden mit Endbildschirm.
2. **Detektiv:** Hinweise mit Kosten.
3. **Raum-Blick:** die Ego-Perspektive.
4. **Extras:** Tagesaufgabe und `?seed=`, Teilen-Text, Sprüche, Chip in der Haupt-App, Terminal 2 und Pasing Arcaden im Katalog.

## 9. Fertig, wenn

- Eine Partie mit 5 Runden läuft auf **jedem** Katalog-Gebäude durch, ohne gebäudespezifischen Code.
- **Vor dem Tipp ist nirgends ein Raumname oder eine Raumnummer zu sehen,** weder auf der Karte noch im Hinweis noch im Seitentitel.
- Dieselbe `seed` ergibt dieselben 5 Räume.
- Ein Tipp in den richtigen Raum gibt 5.000 Punkte, und die Punkte fallen mit der Laufdistanz.
- Am Handy (375 px) ist alles mit einer Hand spielbar.
- `npm run lint`, `typecheck` und `build` in `website/` sind grün.
