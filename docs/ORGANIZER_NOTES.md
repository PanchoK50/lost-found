# Infos der Veranstalter: Q&A und Challenge-PDF

Lost & Found · Stand: Sa, 24.10.2026

Zwei Quellen: Rabeas Notizen aus der Q&A mit Synera und das offizielle PDF "Talk to Your Building: Challenge Brief" (3 Seiten). Unten steht, was daraus für uns folgt.

---

## 1. Notizen aus der Q&A (Rabea)

Sinngemäß übernommen. Unklare Stellen sind markiert.

**Was der Jury wichtig ist**
- Einen klaren **Use Case** wählen, z. B. Raumnavigation.
- **UX ist spannend, Kreativität ist ein großer Teil!**
- Die Jury **mag Videospiele.**
- Chatten oder sprechen, um zu fragen, wohin man gehen soll.
- Claude-Credits **für die Fragen in der App** nutzen.
- Die wichtigste Frage: **Was findet ein Nutzer wirklich hilfreich?**
- "Dashboard, Claude Docs for engineering" (unklar, was genau gemeint war)
- Komplexe Komponenten: Welche Fragen stellen Leute dazu?
- Validierungsset: **Scoring-Tests selbst durchführen.**
- **Architekturen finden, die das Problem lösen**, nicht Modelle trainieren.

**Use-Case-Idee aus der Q&A:** eine **Hausmesse** (In-House-Fair), mit **Industrie-Bezug: Automobilfabrik.**

**"Project promotions, Jeff Bezos"** (unklar). Vermutlich ist Amazons "Working Backwards" gemeint: zuerst die Pressemitteilung schreiben, dann bauen. Das wäre ein Tipp für Demo-Video und Pitch.

**Wie bewertet wird**
- Die Jury **benutzt die App selbst, von Hand.**
- Geprüft wird: Funktion, wie interaktiv die App ist, wie sich das Erlebnis anfühlt. **User Experience!!**

**Wie nah an echter Fertigung muss es sein?** Sehr weit weg ist okay. Wichtig ist, die funktionalen Anforderungen abzudecken.

**Plattform**
- Nutzer sind **Menschen** (Roboter später).
- Mobil oder Laptop, beides möglich. **Portabilität ist wichtig.**
- **Kein iOS:** Die Jury kann keine iOS-App öffnen.
- **Desktop und Web zuerst!**
- **Kamera-Zugriff ist möglich.**

**Ideen für Extras:** WLAN-Triangulation. Offene Frage: Wie schnell kommen wir an Daten für Features?

---

## 2. Was im PDF steht und vom README abweicht

| Punkt | PDF | README im Kit |
|---|---|---|
| **Sonntags-Eingabe** | das neue Gebäude im selben Format und eine `questions.json` mit einem Eintrag pro Frage (`id`, Text, optionale Bedingungen wie stufenlos) | "Fragendatei", Format offen |
| **Sonntags-Befehl** | ein Befehl, z. B. `run_benchmark <building_dir> <questions.json> <answers.json>`, in `BENCHMARK.md` dokumentiert | gleich, ohne Beispiel |
| **Sonntags-Ausgabe** | **`answers.json`**: pro Frage-ID der gefundene Gegenstand oder Raum (ID), die **Route als geordnete Liste von Knoten-IDs** und die Routenlänge in Metern | offen |
| **Schema** | "Schema und Beispiel-Antwortdatei kommen in den data-Ordner" (noch TODO) | – |
| **Abgabe** | Repo mit `BENCHMARK.md` **und `answers.json`** | Repo mit `BENCHMARK.md` und Antworten-CSV für das Testset |
| **Finale** | 4 Finalisten, Pitch bei Tacto, **3 Minuten plus 1 Minute Q&A** | gleich |
| **Reihenfolge der Bewertung** | "does it work, is it a pleasure to use, what did you add that we did not ask for" | gleich |

**Über Synera (für den Pitch):** agentische KI fürs Engineering. Sie bauen Agenten, die **Raum und Geometrie verstehen und sich in einfacher Sprache erklären**, z. B. für NASA, Airbus und BMW. Unsere Challenge ist eine kleine Version davon. Genau diese Haltung sollte der Pitch spiegeln.

---

## 3. Was daraus für uns folgt

### Produkt und UX
1. **Web-App zuerst, responsiv für Laptop und Handy.** Keine native App. Die Jury testet von Hand im Browser.
2. **Öffentlich erreichbar deployen** (das Repo hat schon eine `.vercelignore`). Der API-Key bleibt serverseitig. Ein einfaches Rate-Limit schützt die Credits, wenn die Jury viel ausprobiert.
3. **Die Jury testet selbst**, also muss die App ohne Erklärung funktionieren: Ein Beispielgebäude ist vorgeladen, Beispielfragen sind als Buttons da, und nichts darf abstürzen.
4. **Die Jury mag Videospiele:** Das spricht stark für das Puppenhaus-Konzept (isometrisch wie bei SimCity, Die Sims oder Monument Valley). Dazu passen spielerische Elemente: eine Figur, die die Route abläuft, der Onboarding-Rundgang als Quest, kleine Erfolgsmomente.
5. **Use Case "Hausmesse in der Autofabrik"** als roter Faden für Demo und Video. Besucher waren noch nie im Gebäude, Aussteller stellen Dinge um, Bereiche werden gesperrt, Stände sind die "Gegenstände". Das deckt Finden, Route, Ändern und Reagieren in einer Geschichte ab.
6. **Kamera ist erlaubt:** QR-Code an der Tür scannen oder das Türschild fotografieren funktioniert im Browser (`getUserMedia`). Das ist der realistische Weg zu "Wo bin ich?".
7. **WLAN-Triangulation geht im Browser nicht:** Webseiten können keine WLAN-Signale auslesen, dafür bräuchte es eine native App, und die fällt weg. Deshalb lieber QR-Codes und Fotos statt WLAN.
8. Im Zweifel immer fragen: **Was findet ein Nutzer wirklich hilfreich?**

### Technik und Benchmark
1. **Zwei Ausgabeformate:** die **CSV** für das Testset (README, Abschnitt 6) **und** `answers.json` für Sonntag (PDF). Der Benchmark-Befehl braucht beide.
2. **Routen als Liste von Knoten-IDs** ausgeben. Das deckt sich mit der Synera-Notiz zur Routenbewertung (TECH_MUST_HAVES T8).
3. Selbst auf dev bewerten (`benchmark/score.py`), bevor wir abgeben.
4. Keine Modelle trainieren. Gesucht sind Architektur und Werkzeuge.

### Abgabe und Pitch
- Demo-Video, technische Erklärung, Repo mit `BENCHMARK.md`, `answers.json` und der Testset-CSV.
- Für den Pitch "Working Backwards" ausprobieren: zuerst den Pressetext für Lost & Found schreiben, dann Video und Pitch daraus ableiten.

### Offen, bei Synera erfragen
- Was war mit "Dashboard, Claude Docs for engineering" gemeint?
- Ab wann liegen Schema und Beispiel für `answers.json` im data-Ordner?
- Sind mit "Knoten-IDs" in der Route Raum-IDs gemeint, oder auch Türen?
