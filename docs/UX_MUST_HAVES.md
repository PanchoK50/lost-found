# UX-Must-haves für den Benchmark

Lost & Found · Industrial Agents Hackathon 2026, Track 01 · Stand: Sa, 24.10.2026

Ziel: die Level 1–4 **sichtbar und benutzbar** machen und die **25 Punkte Interaktion** holen. Die Jury führt ein kurzes, vorgeschriebenes Gespräch mit "schwierigen Nutzern" und bewertet nach einer Rubrik:

1. **Fragt der Agent nur, was er wirklich braucht?**
2. **Zeigt er, was er verstanden hat?**
3. **Gibt er Wegbeschreibungen, denen ein Mensch folgen kann?**
4. Sprache zählt ausdrücklich mit ("Voice counts here").

Prioritäten: **P0** heißt ohne geht es nicht, **P1** heißt es bringt sicher Punkte und sollte bis Sonntag stehen.

Die technische Grundlage steht in [`TECH_MUST_HAVES.md`](TECH_MUST_HAVES.md). Die UI liest den Antwortvertrag aus T20 (Text plus `understood`, `highlights`, `route`, `clarification`, `changes`).

---

## Für wen wir bauen (aus der Challenge)

| Persona | Braucht |
|---|---|
| Erster Arbeitstag | kennt keine Raumnamen, fragt "Wo krieg ich Kaffee?" |
| Rollstuhlnutzer:in | stufenlose Routen und breite Türen, **jedes Mal, ohne zweimal zu fragen** |
| Servicetechniker:in | Hände voll, Handy in der Tasche, will Sprache und "links an der Presse" |
| Facility Manager:in | stellt Maschinen um, sperrt Lifte, fügt Türen hinzu. Die Karte muss mitkommen |
| Staplerfahrer:in | "Gang 4 ist blockiert, schnellster Weg zu Dock B?" |
| Logistik | "Wo ist die Stahltrommel von gestern?" |

---

## Überblick

| # | Feature | Prio | Rubrik / Level |
|---|---|---|---|
| U1 | Chat mit kurzen, gestreamten Antworten | P0 | Grundlage |
| U2 | Kartenansicht mit Hervorhebung und Etagenwechsel | P0 | Level 1 |
| U3 | Route auf der Karte, über mehrere Etagen | P0 | Level 2–3 |
| U4 | "Verstanden"-Zusammenfassung | P0 | Rubrik 2 |
| U5 | Rückfragen nur bei echter Mehrdeutigkeit | P0 | Rubrik 1 |
| U6 | Wegbeschreibung, der man folgen kann | P0 | Rubrik 3 |
| U7 | Bedingungen aus natürlicher Sprache, gemerkt | P0 | Rubrik 1, Rollstuhl-Persona |
| U8 | Änderungen mit Vorschau und Bestätigung | P0 | Level 4, Rubrik 2 |
| U9 | Freundliche Fehlerbehandlung | P0 | schwierige Nutzer |
| U10 | Spracheingabe und -ausgabe | P1 | Rubrik 4 |
| U11 | Mobil benutzbar | P1 | Techniker-Persona |
| U12 | Ablauf für den Grundriss-Import | P1 | Level 4 |

---

## Features im Detail

### U1 Chat · P0
- Texteingabe, Antworten werden gestreamt. Während Tools laufen, zeigt die UI einen Hinweis wie "Suche Route …".
- Der Verlauf bleibt erhalten, Folgefragen beziehen sich auf vorher Gesagtes ("und von dort zur Toilette?").
- **Akzeptanz:** Die erste Antwort beginnt nach höchstens 3 s zu erscheinen.

### U2 Kartenansicht · P0
- Echte `building.json` laden, alle Etagen, Räume nach Typ eingefärbt, Raumnamen lesbar.
- Etagenwechsel per Klick. Springt automatisch zur Etage, um die es in der Antwort geht.
- Hervorhebungen aus `highlights`: Ziel, Kandidaten (bei Rückfragen), unerreichbar, geändert.
- Gefundene Gegenstände als Punkt an ihrer `position`.
- **Akzeptanz:** Auch ein OSM-Gebäude mit 8 Etagen und mehr als 300 Räumen lädt in unter 2 s und bleibt flüssig.
- Als Komponente mit Overlays bauen (einfärben, ausgrauen, zeichnen). Darauf setzen später Puppenhaus und Brillen auf.

### U3 Route auf der Karte · P0
- Route aus `route.legs` pro Etage zeichnen, am besten entlang der echten Laufwege (Modell B).
- Etagenwechsel markieren ("Lift West → 1. OG"), Start und Ziel deutlich.
- Animation: Die Linie rollt sich aus, die Etagen werden nacheinander gezeigt.
- Gesperrte Elemente rot und durchgestrichen oder schraffiert.
- **Akzeptanz:** Eine Route über 2 Etagen ist ohne Text verständlich.

### U4 "Verstanden"-Zusammenfassung · P0
- Vor oder über jeder Antwort steht in einer Zeile, was der Agent verstanden hat: **Start · Ziel · Bedingungen · Sperrungen**.
- In der UI als Chips aus `understood`. Ein Tipp auf einen Chip ändert ihn (anderer Start, Bedingung entfernen).
- Bei Änderungen am Gebäude: "Ich habe verstanden: Lift Ost sperren. Soll ich das übernehmen?"
- **Akzeptanz:** Ein Jurymitglied sieht ohne Nachfragen, welche Annahmen der Agent getroffen hat.

### U5 Rückfragen nur bei echter Mehrdeutigkeit · P0
- Fragen **nur**, wenn die Antwort davon abhängt und es mehrere plausible Möglichkeiten gibt.
- Immer nur **eine** Frage auf einmal, als Auswahl-Buttons aus `clarification.options`. Die Kandidaten leuchten auf der Karte.
- Ist eine Möglichkeit klar gemeint (z. B. der nächste Drucker zum bekannten Standort), einfach machen und die Annahme sagen: "Ich nehme den Drucker in 2.03, der ist am nächsten."
- Bekanntes merken: Standort, Profil (Rollstuhl), Sperrungen. **Nie zweimal fragen.**
- Den Startpunkt nur erfragen, wenn er für die Antwort nötig ist.

### U6 Wegbeschreibung, der man folgen kann · P0
- In einer Zeile, was verstanden wurde, dann **höchstens 6 nummerierte Schritte**, dann die Gesamtdauer.
- **Raumnamen statt IDs**. Interne IDs erscheinen nie im Text.
- Richtungen (links, rechts, geradeaus) aus den Abbiegewinkeln der Route.
- **Landmarken**: markante Gegenstände an Abbiegepunkten ("an der Kaffeemaschine vorbei", "links an der Presse").
- Etagenwechsel ausdrücklich: "Nimm Lift West in den 1. Stock."
- Dauer in **Minuten** (etwa 1,3 m/s zu Fuß, langsamer im Rollstuhl), Meter optional.
- **Akzeptanz:** Jemand, der das Gebäude nicht kennt, kommt nur mit dem Text ans Ziel.

### U7 Bedingungen aus natürlicher Sprache · P0
| Nutzer sagt | wird zu |
|---|---|
| Rollstuhl, Kinderwagen, Krücken, "keine Treppen", Rollwagen | stufenlos |
| "1,1 m breite Palette", "großer Schrank" | Mindestbreite der Türen, stufenlos |
| Gabelstapler, Stapler | Stapler-Regeln (Gänge ab 3 m, keine Buchten als Abkürzung) |
| "Lift X ist kaputt", "Gang 4 blockiert" | Sperrung |
| "Kaffee", "ich muss mal", "ruhiger Ort zum Telefonieren" | Küche oder Kantine, Toilette, freier Besprechungsraum |

- Eine einmal genannte Bedingung gilt für das **ganze Gespräch**, bis die Person sie aufhebt. Sie ist als Chip sichtbar.

### U8 Änderungen mit Vorschau und Bestätigung · P0
- Jede Änderung (sperren, Tür hinzufügen, Gegenstand umstellen) erscheint **erst als Vorschau**: gestrichelt auf der Karte, im Chat "Übernehmen / Verwerfen".
- Nach dem Übernehmen sagt der Agent, **was sich ändert**: "Drei Räume im 2. OG sind jetzt nur noch über Lift West erreichbar, 40 m weiter."
- Unmögliches wird mit Grund abgelehnt: "2.03 und 2.07 haben keine gemeinsame Wand, eine Tür geht dort nicht."
- Rückgängig machen ist möglich.

### U9 Freundliche Fehlerbehandlung · P0
- Unbekannter Raum ("Raum 9.99"): sagen, dass es ihn nicht gibt, und die ähnlichsten Treffer anbieten.
- Keine Route unter den Bedingungen: klar sagen, **warum** (z. B. "kein Lift ins Untergeschoss"), und eine Alternative anbieten, falls es eine gibt.
- Meinungswechsel ("doch nicht zur Kantine, zur Toilette"): neue Route, den Start behalten, nicht nochmal fragen.
- API-Fehler: eine verständliche Meldung, nie ein Stacktrace.

### U10 Spracheingabe und -ausgabe · P1
- Großer Push-to-talk-Knopf. Die erkannte Eingabe erscheint als Text, damit man sie prüfen kann.
- Ausgabe vorlesen, in einem **kürzeren Sprachmodus**: nur der nächste Schritt, "weiter" holt den folgenden.
- Schnellster Start: die Web Speech API im Browser (Chrome, kostenlos, etwa 1 Stunde). ElevenLabs als Upgrade für eine schönere Stimme (Credits gibt es über die Veranstalter).

### U11 Mobil benutzbar · P1
- Layout ab 375 px Breite: Karte im Vollbild, Chat als Panel von unten, große Knöpfe.
- Schritte als wischbare Karten.

### U12 Ablauf für den Grundriss-Import · P1
- Bild hochladen, dann die erkannten Räume als Overlay über dem Bild zeigen ("Das habe ich erkannt").
- Korrektur per Chat ("Raum 3 ist die Küche", "hier fehlt eine Tür"), dann übernehmen.
- Am Ende eine Prüfmeldung: "12 Räume, 15 Türen, alle Räume erreichbar."

---

## Tonalität des Agenten

- Kurz. Erst die Antwort, dann die Details.
- Höchstens **eine** Rückfrage pro Antwort.
- Namen statt IDs, Minuten statt nur Metern.
- Annahmen offen sagen ("Ich gehe von der Lobby aus, weil du dort bist").
- Ehrlich, wenn etwas nicht geht, mit Alternative.
- Im Chat **keine** `Answer:`-Zeile. Die ist nur für den Benchmark-Modus (T14).

---

## Testszenarien für die Interaktion

Diese Gespräche regelmäßig durchspielen. Sie sind nah an dem, was die Jury testen wird.

| # | Persona | Nutzer sagt | Erwartetes Verhalten |
|---|---|---|---|
| 1 | Erster Tag | "Wo krieg ich Kaffee?" | Nächste Küche, Kantine oder Kaffeemaschine finden. Nach dem Standort nur fragen, wenn er unbekannt ist. Auf der Karte zeigen |
| 2 | Vage | "Wo ist der Drucker?" (drei Drucker im Gebäude) | Standort bekannt: den nächsten nehmen und das sagen. Unbekannt: eine Rückfrage mit drei Buttons, alle drei leuchten |
| 3 | Falsch | "Bring mich zu Raum 9.99" | Sagen, dass es ihn nicht gibt, ähnliche Räume anbieten |
| 4 | Rollstuhl | "Ich sitze im Rollstuhl." … später: "Wie komme ich zur Kantine?" | Zweite Route ist stufenlos, **ohne erneut zu fragen**. Chip "stufenlos" sichtbar |
| 5 | Sperrung | "Der Ostlift ist gesperrt. Was ändert sich?" | Sperrung als Vorschau, nach Bestätigung erklären, welche Wege länger oder unmöglich werden. Auf der Karte zeigen |
| 6 | Bearbeiten | "Füge eine Tür zwischen 2.03 und 2.04 ein." | Vorschau gestrichelt, bestätigen, übernehmen. Ohne gemeinsame Wand: begründet ablehnen |
| 7 | Meinungswechsel | "Doch nicht zur Kantine, zur Toilette." | Neue Route vom selben Start, keine Rückfrage |
| 8 | Techniker, Sprache | "Welche der drei Pressen ist Linie 4, und wie komme ich hin?" | Die richtige Presse finden, kurze Schritte mit Landmarken, vorlesbar |
| 9 | Stapler | "Gang 4 ist blockiert. Schnellster Weg zu Dock B?" | Stapler-Regeln und Sperrung anwenden, Route zeigen, Umweg nennen |
| 10 | Keine Route | "Stufenlos ins Untergeschoss" (kein Lift dorthin) | Klar sagen, dass es nicht geht, und warum. Alternative, falls vorhanden |
| 11 | Logistik | "Wo ist die Stahltrommel von gestern?" | Gegenstand finden. Wurde er umgestellt: den letzten bekannten Ort nennen |
| 12 | Facility | "Die CNC-Fräse steht jetzt in Halle 3." | Umstellen als Vorschau, übernehmen, ab dann bei Suchen den neuen Ort zeigen |

**Definition of Done für die Interaktion:** Alle 12 Szenarien laufen auf einem prozeduralen Fabrikgebäude aus dev durch, ohne dass der Agent unnötig fragt, falsche Annahmen versteckt oder interne IDs zeigt.
