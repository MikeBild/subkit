# Cockpit-Konvention

Version 2.5 · 22.10.2026 · Gilt für: ContentKit, SubKit, WorkKit, WikiKit, CodeKit, WatchKit

**Modell: Konvention statt Bibliothek.** Jedes Produkt bleibt eigenständig — eigenes Repo, eigene shadcn-Komponenten (vendored, wie shadcn gedacht ist), eigene Releases, kein shared Package. Geteilt wird nur dieses Dokument. Eine Kopie liegt in jedem Repo; Abweichungen sind erlaubt, wo das Produkt es begründet — die Konvention ist der Default, nicht das Gesetz.

**v2.x ist SubKit-first — eine gewollte Abweichung von der Familie, bis die Geschwister folgen.** SubKit setzt v2.3 und `FAMILY-UI.json` 3.0 zuerst um. ContentKit, WorkKit, WikiKit, CodeKit und WatchKit arbeiten nach v1.7 und `FAMILY-UI.json` 2.3, bis ihre eigenen Umsetzungs-Schnitte folgen; bis dahin gilt in ihren Repos die v1.7-Kopie. Den Startseiten-Namen „Übersicht" tragen alle sechs bereits. Was ein Geschwister umsetzen muss, steht in `FAMILY-UI.json` unter `migration`. Die v2.3-Schnittstelle `GET /v1/operational-overview` bleibt in SubKit erhalten, damit Geschwister und Prometheus weiterlesen können.

Referenz-Implementierung: für v2.x ist SubKit die Referenz (Startseite „Übersicht" mit Betriebsleiste und Anliegen-Liste, Prüf-Seitenblatt, Zeilen, „Personen & Rechte"). Die Karten-Anatomie einer Entscheidung (§8.4) stammt aus WorkKit (Übergabe „workkit-entscheidungen-uebergabe"), §9–§11 aus SubKit (Übergabe „subkit-referenzarchitektur-uebergabe").

Änderungen v1.1: neuer §8 Entscheidungs-Grammatik (hebt das Muster aus der WorkKit-Übergabe auf Familienebene); §1 Zone A verweist auf §8.
Änderungen v1.2: neue §9 Diff-Freigabe, §10 Sammlungs-Listen, §11 Verbindungs-Status (heben die Muster aus der SubKit-Übergabe auf Familienebene); §4 um „Leere führt zur Handlung" ergänzt.
Änderungen v1.3: §6 um kanonische Gruppennamen ergänzt; Umsetzungs-Vehikel für §§2–6 ist die Übergabe „shell-paket" (ein gleichförmiger Konformitäts-PR je Repo).
Änderungen v1.4: Endnutzer-Patterns aus den Produktivitäts-Leitfäden gehoben (Übergabe „endnutzer-pattern-adaption"): §5 Zusammenfassungszeile, §8.3 drei Arten von Nein, §8.5 Geschichte vs. Zustand, §11 Fähigkeits-Inventur, neu §12 Berichts-Grammatik, §13 Prüfen vor Reparieren, §14 Modus & Schranken.
Änderungen v1.5: §6 um Wortmarke, kanonische Schreibweise des Produktnamens, Browser-Titel und App-Icon ergänzt — die Familie war an ihrer sichtbarsten Stelle uneinheitlich, ohne dass eine Regel es benannte.
Änderungen v1.6: neuer §0 „Wofür das Cockpit da ist" (gilt vor allen anderen Paragrafen); §1 Zone C wird ein Verweis statt eines Ereignisstroms; neue §8.5a Zähler-Kacheln und §8.5b zur Zahl der Entscheidungen.
Änderungen v1.6 (Fortsetzung): §8.5 neu gefasst — die Regale unter der Queue entfallen ersatzlos. Die Entscheidungs-Seite zeigt nur noch, was wartet; Zurückgestellt, Verworfen und Entschieden sind Vergangenheit und wohnen allein im Audit-Protokoll, erreichbar über genau einen Verweis. §8.8 nennt entsprechend die Trennung von Zustand und Geschichte statt der Regale.
Änderungen v1.7: §8.2 auf genau ein Ordnungswerkzeug reduziert. Art-Chips mit Zählern bleiben; der redundante Gruppieren-Umschalter entfällt. Die Sortierung ist fest: ablaufend zuerst, dann älteste.
Änderungen v2.0: Übersicht, Entscheidungs-Seite und System-Seite verschmelzen zu **einer** Startseite „Heute" mit einer Anliegen-Liste. Neu §0.1 „Ein Fakt, ein Ort" mit Matrix; §1 neu gefasst (Heute statt drei Zonen, keine Null-Kacheln, „Alles erledigt" nur, wenn jede lesbare Quelle geantwortet hat); §6 Installation ohne System, mit „Personen & Rechte"; §8 neu gefasst als Anliegen-Grammatik mit Prüf-Seitenblatt — die Karten-Anatomie aus v1.7 wandert ins Seitenblatt, Art-Chips, Rubriken, Zähler-Kacheln und Incident-Banner entfallen; §9.2 und §12 verweisen auf Heute; §10 Zeilen öffnen über den Namen als echten Link und per Klick, ohne „Öffnen"-Knopf, „⋯" nur für echte Menüs; neu §10.1 „Zahlen führen auf Listen, die dasselbe zählen".
Änderungen v2.1: Die Startseite heißt wieder **„Übersicht"** (englisch „Overview") wie in allen sechs Produkten. §1 neu gegliedert: Seitenkopf mit Zeitfenster (24 Std · 7 Tage · 30 Tage) → Betriebsleiste mit genau vier Werten → Anliegen-Liste „Braucht dich" → Verweis auf den Audit-Trail; „keine Null-Kacheln" bleibt. §0.1: Ausführungen, Erfolgsquote, Konnektor-Gesundheit und Reparaturquote wohnen in der Betriebsleiste der Übersicht, nicht mehr auf Nutzung. §6 kanonischer Name „Übersicht". §8.5: ein Wert der Betriebsleiste, der auf gefilterte Audit-Einträge führt, ist kein zweiter Verweis auf die Geschichte. §8.6: die Betriebsleiste bleibt im leeren Zustand stehen.
Änderungen v2.1.1: §6 Einstellungen — eine Zeile sagt, wenn ein Wert vom Standard abweicht, und setzt ihn per Entwurf zurück; „Alle | Geändert“ neben der Suche; Geheimnisse zeigen nur „Hinterlegt“ oder „Nicht hinterlegt“; ein Speichern ist ein Vorgang für alle Entwürfe der Seite, ein Konflikt behält sie.
Änderungen v2.2: Die Betriebsleiste trägt sechs Werte statt vier — dazu **Kosten** (Ausgaben im gewählten Zeitfenster, in der Währung der Preise) und **Kontingent** (Token des Kalendermonats gegen das Monatskontingent, markiert „Monat"), je in Kurzform. §1 Betriebsleiste: ein Raster ohne seitliches Scrollen (breit 6 in einer Zeile oder 3 × 2, Telefon 2 Spalten). §0.1: Kosten und Kontingent wohnen als Kurzform in der Betriebsleiste; Nutzung behält Aufriss und Tabellen.
Änderungen v2.3: Die Übersicht folgt dem abgenommenen Klick-Dummy. Die Betriebsleiste trägt wieder **vier** Werte — Ausführungen, Erfolgsquote, Gesunde Konnektoren, Kontingent —; Kosten zeigt Nutzung im Aufriss, entschiedene Reparaturen zeigt der Audit-Trail (§0.1). Das Zeitfenster (24 Std · 7 Tage) steht rechts in der Zusammenfassungszeile über der Leiste, nicht im Seitenkopf; der Seitenkopf trägt „Alle Läufe" und den Verweis „Was bereits entschieden wurde". Unter der Anliegen-Liste stehen die drei jüngsten Fehlschläge. Leer heißt: die Zusammenfassungszeile zählt „0 Einträge brauchen dich", die Liste sagt „Nichts braucht dich gerade." — ohne Statuszeile; den Gesundheitszustand liefern API, MCP und Prometheus, seine Ursachen sind Einträge (§1, §8.6).
Änderungen v2.4: neuer §16 Auftragskette — jeder Lauf nennt, wer ihn ausgelöst hat, wie SubKit das geprüft hat und welche Freigabe galt; eine Zeile im Lauf, Details zugeklappt, keine neue Fläche (§0.1).
Änderungen v2.5: Eine Zeile führt mit einem Klick auf die eigene Seite des Objekts; das Vorschau-Seitenblatt zwischen Liste und Detailseite entfällt für alle Sammlungen (§10). Zurück stellt Filter, Suche und Scrollposition wieder her. Listen und Detailseiten teilen eine Inhaltsbreite; Detailseiten folgen drei Ebenen (Verstehen, Einzelheiten, Technik), und Zustand zeigen Badge und Status-Streifen, nie farbige Randstreifen oder getönte Flächen (§6).

---

## 0. Wofür das Cockpit da ist

**Entscheidung Mike, 21.08.2026 — gilt vor allen anderen Paragrafen.**

Das Cockpit zeigt die **Gegenwart**: Nutzer und Workflow, Reporte, aktuelle Daten,
und **Entscheidungen, die zu treffen sind**.

**Die Vergangenheit gehört in den Audit-Trail.** Jedes Produkt hat dafür einen eigenen
Bereich im Cockpit. Von dort ist sie vollständig zu holen — also muss sie nirgendwo sonst
zweitverwertet werden.

**Die Unterscheidung, die im Zweifel gilt:**

- Eine **Eigenschaft eines aktuellen Dings** bleibt, wo das Ding ist. „Zuletzt verwendet" in
  einer Schlüsselzeile beschreibt den Schlüssel, nicht die Geschichte.
- Ein **Strom vergangener Ereignisse** gehört in den Audit-Trail. Keine zweite Fläche, keine
  Zähler-Kachel, kein gedimmter Abschnitt unter einer Liste.

Wer eine Fläche baut, beantwortet zuerst: **muss ein Mensch hier etwas tun oder etwas
Aktuelles sehen?** Wenn nein, gehört sie nicht ins Cockpit, sondern in den Audit-Trail.

**Leitregel (v2.1): Aufgaben leben nur auf der „Übersicht".** Objektseiten zeigen ihren Zustand
und verlinken höchstens zur Aufgabe. Jeder Fakt hat genau einen Ort.

### 0.1 Ein Fakt, ein Ort

| Fakt | Ort | Sonst |
|---|---|---|
| Aufgaben (Entscheidungen, Scheitern, Anmeldung, Kontingent, Rückfragen, Geheimnis-Freigaben) | Übersicht, Anliegen-Liste | Objektseiten: Zustand + Link |
| Gesundheitszustand | Ursachen eines schlechten Zustands sind Einträge der Übersicht; der Zustand selbst nur API, MCP, Prometheus | nirgends |
| Komponenten/Score | nur API, MCP, Prometheus | — |
| Zahl offener Anliegen | Abzeichen am Navigationseintrag = Zahl der Einträge | Listenköpfe ohne Zahl |
| Ausführungen, Erfolgsquote, Konnektor-Gesundheit, Nutzung des Monats | Übersicht, Betriebsleiste (je Wert ein Link in die gefilterte Liste desselben Zeitfensters, §10.1; Nutzung in Kurzform: Kosten des Kalendermonats, darunter Prozent vom Monatskontingent mit Zustand) | Nutzung zeigt Aufriss, Tabellen und Laufzeit desselben Fensters, nicht die Betriebswerte; ohne Kontingent „Kein Kontingent" |
| Kosten | Nutzung, Aufriss desselben Fensters: zuerst wofür, dann nach Workflow (nur zuordenbare Läufe) und nach Modell | ohne Preis kein stiller Teilbetrag („mind. …") |
| Übernommene Reparaturen | Audit-Trail, entschiedene Vorschläge (§8.5) | — |
| Datenstand | Eintrag auf der Übersicht, nur wenn veraltet | — |
| Drift-Scan | kein Knopf im Cockpit (der Scheduler scannt; CLI/MCP behalten ihn) | — |
| Titel wiederholende Beschreibungen | entfallen | — |
| „Öffnen" in Zeilen, Vorschau-Seitenblatt einer Zeile | entfällt; der Name ist ein echter Link auf die Detailseite, die Zeile klickbar (§10) | — |
| Aufmerksamkeitsliste auf Objektseiten (z. B. Zugangsdaten) | **entfällt** — eine zweite Aufgabenliste; Zeilen tragen Zustands-Chips, Zeilenaktionen (z. B. „Erneuern") bleiben | — |
| Wortlaut der Engine | nur im Prüf-Seitenblatt (§8.4), nicht an Einträgen oder Listen-Markierungen | — |

Wer einen Fakt an einer zweiten Stelle zeigen will, verlinkt auf seinen Ort, statt ihn zu
wiederholen. Zwei Stellen mit derselben Zahl sind zwei Stellen, die auseinanderlaufen.

## 1. Startscreen-Vertrag

Der erste Screen jedes Cockpits ist die **„Übersicht"** (`/`, englisch „Overview"): oben die
Betriebsleiste, darunter die Liste der Anliegen, die diese Person jetzt braucht. Sie ersetzt
Entscheidungs-Seite und System-Seite aus v1.7; deren alte Adressen leiten auf die Übersicht um
(ein Link, der einen Gegenstand nannte, öffnet dessen Prüf-Seitenblatt).

**Aufbau.** Seitenkopf (Titel „Übersicht", „Alle Läufe" als Seitenblatt und genau ein Verweis
„Was bereits entschieden wurde" auf den Audit-Trail) → Zusammenfassungszeile („3 Einträge brauchen
dich") mit dem Zeitfenster rechts (24 Std · 7 Tage, Vorgabe 24 Std) → Betriebsleiste → „Braucht
dich": die Anliegen-Liste (§8) → ein Hinweis auf nicht lesbare Quellen, nur wenn eine Quelle nicht
geantwortet hat → „Letzte Fehlschläge": die drei jüngsten gescheiterten Läufe mit Ursache, jeder
öffnet sein Seitenblatt. Kein Ereignisstrom; keine Liste erfolgreicher Läufe.

**Betriebsleiste.** Genau vier Werte in einem Raster ohne seitliches Scrollen — breit in einer
Zeile oder 2 × 2, auf dem Telefon 2 × 2: Ausführungen, Erfolgsquote, Gesunde Konnektoren,
Nutzung. Ausführungen und Erfolgsquote zählen im gewählten Zeitfenster; „Gesunde Konnektoren"
ist ein Zustand und trägt „Stand jetzt", „Nutzung" gilt dem Kalendermonat und trägt „Monat".
Nutzung zeigt kompakt die Kosten des Monats und den prozentualen Anteil am Tokenkontingent;
Gesamtkontingent und Restmenge stehen im Aufriss auf Nutzung. Der Kontingentzustand bestimmt
die Farbgebung. Ohne Preis steht nur der Anteil, ohne Kontingent „Kein Kontingent". Jeder Wert führt auf die
gefilterte Liste desselben Fensters (§10.1), Nutzung auf die Seite Nutzung, die den Aufriss trägt.
Die Kosten des Zeitfensters und übernommene Reparaturen stehen nicht in der Leiste: Kosten zeigt
Nutzung im Aufriss, entschiedene Reparaturen der Audit-Trail (§0.1). Ein Wert,
der nicht gelesen werden konnte, sagt „nicht lesbar" und bietet an, erneut zu lesen — je Wert,
nicht für die ganze Leiste. Die Leiste ist kompakt (je Wert etwa 72 px hoch), damit die Anliegen im
ersten Screen stehen. Sie zeigt Zahlen, keine Aufgaben: was jemanden braucht, ist ein Eintrag
der Liste.

**Keine Null-Kacheln.** Die Übersicht zeigt keine nackte 0. Ein Wert ohne Daten sagt das in
Worten („Keine im Zeitraum", „Keine aktiven Konnektoren") und trägt keinen Link. Eine Kachel
„Blockiert: 0" beantwortet eine Frage, die niemand gestellt hat, und eine Wand aus Nullen
lehrt, die Seite zu überlesen.

**Leer.** Ist nichts offen, bleibt die Betriebsleiste stehen, die Zusammenfassungszeile zählt
in Worten („0 Einträge brauchen dich" — ein Satz, keine Kachel), und an der Stelle der Einträge
steht „Nichts braucht dich gerade." — keine Statuszeile. Das gilt **nur**, wenn jede Quelle, die
diese Person lesen darf, geantwortet hat. Hat eine Quelle nicht geantwortet, nennt die Seite, was
fehlt, und zählt nicht; ohne Einträge sagt sie höchstens, dass aus den Quellen, die geantwortet
haben, nichts ansteht — ein falsches „Nichts braucht dich" ist schlimmer als keines. Konnte die
Liste gar nicht gelesen werden, sagt die Seite das mit „Erneut versuchen" und zählt nichts. Wer
keine Quelle lesen darf, landet auf dem ersten sichtbaren Navigationseintrag.

**Abzeichen.** Der Navigationseintrag „Übersicht" trägt die Zahl der Einträge der Liste —
dieselbe Zahl, nicht eine zweite Zählung.

Regeln: Kein Zähler ohne Link. Kein Rot ohne Weg zur Ursache. Die vier Betriebswerte wohnen
in der Betriebsleiste der Übersicht; Nutzung zeigt Aufriss, Tabellen und Laufzeit, nicht
diese Werte ein zweites Mal. Komponenten und Score liefern API, MCP und Prometheus. „Nichts zu tun" ist ein
ruhiger Zustand, kein inszenierter Erfolg.

## 2. Zustandsvokabular

Sechs Zustände, jedes Produkt implementiert seine eigene Badge-Komponente mit denselben Namen und Farbrollen. Immer Punkt/Icon + Wort, nie Farbe allein.

**Ein Statusmuster im gesamten Cockpit.** Sichtbare Objektzustände verwenden dieselbe Status-Badge-Komponente in Listen, Detailansichten und ergänzenden Zustandsanzeigen. Gleicher Zustand bedeutet gleichen Wortlaut, gleiche semantische Farbe, Form, Typografie und Innenabstände – unabhängig vom Objekttyp. Ein zusätzlicher Zustand steht als weiteres Badge mit dem gemeinsamen Abstand neben oder unter dem Hauptstatus. Keine Sonderform aus freiem Farbpunkt und Text, kein sichtbarer Präfix „Zustand:“ und keine Unterstreichung im Badge. Ein Badge darf zur zugehörigen Ursache verlinken; Tastaturfokus und aussagekräftiger zugänglicher Linkname bleiben erhalten. Kontext darf Zustandsbedeutungen präzisieren, aber nicht dieselbe Bedeutung je Seite anders einfärben. In SubKit ist `StatusBadge` die gemeinsame Implementierung; Zustandsfarben kommen aus `statusTone`.

| Zustand | Rolle | Licht (bg / fg) |
|---|---|---|
| Läuft | blau | #eff6ff / #1d4ed8 |
| Wartet auf dich | amber | #fffbeb / #b45309 |
| Erfolgreich | grün | #f0fdf4 / #15803d |
| Fehlgeschlagen | rot | #fef2f2 / #b91c1c |
| Abgebrochen | neutral | #f4f4f5 / #52525b |
| Entwurf | neutral, gestrichelter Rand | transparent / muted |

„Unbekannt" ist verboten: entweder wird der Zustand aufgelöst, oder es steht „nicht ermittelbar seit X" mit Grund. Statusfarben werden nie für Diagrammserien verwendet.

## 3. Lauf-Liste

Jede Liste von Ausführungen/Läufen zeigt mindestens: Name (sprechend, kein UUID-Prefix-Truncate) · Status-Badge · gestartet (relativ) · Dauer · Fortschritt n/m · Zeile klickbar. Fehlschläge tragen ihre Ursachengruppe in der Zeile („Ursache: Object not found") und sind nach Ursache gruppierbar — ein Eintrag je Ursache mit Zähler, nicht n identische Zeilen.

## 4. Drei Arten von Leere

Gemessene Null („0 · zuletzt geprüft vor 2 min") ≠ nicht erfasst (Hohlzelle, „Opt-in") ≠ noch nie benutzt (Leerzustand mit nächstem Schritt). Skeletons haben ein Timeout (5 s) und lösen in Leerzustand oder Fehlermeldung auf — nie dauerhaft.

**Leere führt zur Handlung.** Der „noch nie benutzt"-Zustand endet nie in einem leeren Formular: „Ersten Workflow anlegen" führt in den geführten Weg (Chat mit vorbereitetem Prompt, Assistent, Vorlage), ein leerer Chat zeigt Beispiel-Karten („Was kann diese Installation?") statt eines leeren Eingabefelds.

## 5. Sprache & Benennung

Deutsch auf oberster Ebene; Fachbegriffe (SRE, API-Namen) erst in der Detailtiefe. Rollen-Label einheitlich „Administrator". Destruktive Aktionen (Löschen, Verwerfen, Widerrufen) nie als rote Primärfläche in Listenzeilen — ins ⋯-Menü, wo die Zeile ein echtes Menü hat, sonst als benannter Nebenknopf (§10); immer mit Bestätigung. Titel sind Zusammenfassungen, nie rohe Prompts oder UUIDs; Auto-Titel aus dem ersten Auftrag, wo kein Titel existiert.

**Zusammenfassungszeile.** Jedes benannte Objekt trägt eine 1–2-Satz-Zusammenfassung, und Listen zeigen sie unter dem Titel — einmal geschrieben (beim Anlegen, notfalls generiert), hundertmal gelesen. Der Lesepfad ist dreistufig: Landkarte (Bereichs-Start) → Zusammenfassungszeile → Volltext; Volltextsuche ist Fallback, nicht Haupteingang.

## 6. Struktur-Konstanten

Sidebar links: Wortmarke, gruppierte Navigation, Account unten (Avatar · E-Mail · Rolle · Menü: Profil/Sprache/Darstellung/Abmelden). Ganz oben, ungruppiert und ohne Überschrift: **Übersicht** mit Abzeichen (§1). Die Gruppe **Verwaltung** enthält in dieser Reihenfolge: Nutzung · Audit · Personen & Rechte · API-Zugang · Einstellungen. Benachrichtigungen sind ein Bereich der Einstellungen. Eine System-Seite gibt es nicht mehr: der Gesundheitszustand ist die Statuszeile auf der Übersicht, seine Ursachen sind Einträge dort, Komponenten und Score liefern API, MCP und Prometheus (§0.1). **Personen & Rechte** ist die eine Seite für Personen, Rollen, Gruppen und Freigaben, je Abschnitt eine Adresse (`?section=…`); **API-Zugang** ist die Seite für API-Schlüssel und verbundene Anwendungen. Kontoverbindungen stehen beim jeweiligen Konnektor. Deep-Links funktionieren; abgelöste Adressen leiten auf ihren neuen Ort um, statt „nicht gefunden" zu zeigen; unbekannte Routen zeigen eine gestaltete Seite mit Rückweg. Mandanten-Switcher trennt Prod/Test, Test ausblendbar.

**Kanonische Gruppennamen.** Geteilte Konzepte heißen in allen sechs Produkten gleich: die Admin-Gruppe heißt auf Deutsch **„Verwaltung"**, auf Englisch **„Administration"**, der Startseiten-Eintrag heißt **„Übersicht"** und steht **ungruppiert** ganz oben (§1), die Rolle heißt **„Administrator"** (eine Schreibweise, keine Versalien-Varianten). Produktspezifische Gruppen (Wiki, Überwachung, …) bleiben frei benannt — aber deutsch und in Normalschreibung.

**Wortmarke und App-Icon.** Die Seitenleiste trägt oben die Wortmarke: **Produkt-Icon plus
Produktname in kanonischer Schreibweise** — WorkKit · SubKit · WikiKit · ContentKit · CodeKit ·
WatchKit. Die Schreibweise ist unveränderlich: keine Versalien-Transformation (weder
`toUpperCase()` im Code noch `text-transform` im Stylesheet), keine Kleinschreibung, kein
hartkodierter Text — Quelle ist der Übersetzungskatalog (`app.name`), damit der Name genau
einmal im Produkt steht. Jedes Produkt hat ein **App-Icon**, und es erscheint an zwei Stellen:
als Favicon im Browser-Tab und neben der Wortmarke. Die Anatomie ist familienweit gleich — ein
Glyph auf der Produktfarbe, quadratisch mit weichen Ecken —, das Motiv ist produktspezifisch.
Der **Browser-Titel** lautet einheitlich „<Produktname> Cockpit". Ein Cockpit, das seinen
Produktnamen nicht nennt oder ihn anders schreibt als seine Geschwister, ist an der Stelle
uneinheitlich, an der es zuerst gelesen wird.

**Einstellungen** beginnen mit einer Übersicht der Bereiche: je Bereich eine Karte mit Titel, einem Satz zum aktuellen Zustand und höchstens einem Status-Badge (Wort und Punkt, nur aus Fakten wie fehlendem Schlüssel, erreichtem Limit oder ausstehendem Neustart) — keine Zähler, keine Tabs. Ein Bereich öffnet eine geführte Seite: Abschnitte mit einer Frage als Überschrift, je Frage ein Bedienelement in Alltagssprache; technische Schlüssel, Rohwerte und JSON stehen dort nicht. Ganz unten und in der Bereichsliste führt „Alle Einstellungen (für Fachleute)" zur vollständigen Liste jeder Einstellung mit ihrem technischen Namen. Bereiche und die vollständige Liste gliedern sich als gruppierte, senkrechte Liste — kein seitliches Scrollen bei keiner Breite: ab 720px Inhaltsbreite steht die Liste links neben dem gewählten Bereich, darunter ist sie die Startansicht, und ein Bereich öffnet sich mit „← Alle Bereiche" an ihrer Stelle. Wo ein Wert je Arbeitsbereich abweichen kann und die Person für alle Arbeitsbereiche ändern darf, fragt die Seite einmal „Für wen gilt das?". Eine Zeile zeigt das passende Bedienelement (Auswahl, Schalter, Zahl mit Einheit) und nur dann „Geändert · Standard: X · Zurücksetzen", wenn der Wert vom Standard abweicht; Zurücksetzen legt nur einen Entwurf an. „Alle | Geändert" steht neben der Suche und ist adressierbar. Ein Geheimnis zeigt nie seinen Wert, nur „Hinterlegt · Ersetzen" oder „Nicht hinterlegt · Hinterlegen". Entwürfe gehören der Seite, nicht dem Bereich: eine Leiste „N ungespeicherte Änderungen · Verwerfen · Speichern" sammelt Entwürfe aus geführten Seiten und der vollständigen Liste und speichert alle auf einmal, nie automatisch; hat inzwischen jemand gespeichert, sagt die Leiste das und die Entwürfe bleiben. Wer nur lesen darf, liest „Du darfst ansehen, nicht ändern."

**Responsive Arbeitsfläche.** Maßgeblich ist die tatsächlich verfügbare Inhaltsbreite nach Navigation und weiteren Spalten, nicht allein die Bildschirmbreite. Listen, Detailinhalte und Chat nutzen diese Fläche mit ihren gemeinsamen Achsen; breite Tabellen erhalten Platz für sprechende Namen statt gleich breiter, überwiegend leerer Spalten. Chat-Titel, Verlauf und Eingabe folgen derselben Achse. Der Arbeitsinhalt beginnt auf jeder Seite — Übersicht, Listen, Details, Einstellungen und Chat — an derselben linken Kante direkt neben der Navigation und mit demselben Seitenrand; keine Seite zentriert ihren Inhalt, damit beim Durchklicken nichts springt. Eine maximale Breite begrenzt nur den rechten Rand; Listen und Detailseiten teilen dieselbe Inhaltsbreite (Arbeitsbreite 1760px), damit der Schritt von der Zeile zur Seite nichts verschiebt. Höhe und Breite passen unabhängig: Navigation, Hauptinhalt und Kontext können jeweils scrollen; Eingabe und Schließen bleiben erreichbar.

**Maße.** Maßgeblich ist der Cockpit-Code; `FAMILY-UI.json` führt dieselben Werte und `bun run check:family-ui-drift` schlägt bei jeder Abweichung fehl. Kopfleiste 48px; Sidebar 256px, eingeklappt 48px; Seitenrand 16px, ab `sm` 24px; Lesespalte 780px, Arbeitsspalte 1440px, Arbeitsbreite (Listen und Detailseiten) 1760px; Abstand zwischen Abschnitten 24px, zwischen Karteninhalten 16px; Kartenradius 16,8px (Basisradius 12px × 1,4); Bedienelemente 32px hoch, Tabs 36px, Tabellenzeilen mindestens 44px. Typografie: Seitentitel 24/32 (600), Abschnittstitel 16/24 (600), Text 14/20, Fließtext im Artikel 14/24, Meta 12/16. Navigation: Übersicht und Chat ungruppiert, dann Automatisierung · Wissen · Verwaltung (englisch Administration).

**Details neben dem Arbeitsinhalt.** Ein Objekt aus einer Liste öffnet seine eigene Seite, nie ein Seitenblatt (§10). Seitenblätter zeigen nur Einzelheiten innerhalb einer Seite — ein Schritt, ein Lauf, eine Freigabe, ein Werkzeug, ein Abschnitt, eine Version — und das Prüf-Seitenblatt (§8.4). Ein solches Seitenblatt steht bei ausreichender Arbeitsbreite als echte rechte Spalte neben dem weiter bedienbaren Hauptinhalt, ohne Abdunklung, Overlay oder Fokusfalle. Bei schmaler Arbeitsbreite wird dieselbe Auswahl im modalen Seitenblatt, mobil über die volle Breite gezeigt. Ohne Auswahl wird kein Objekt erfunden und keine leere Detailspalte reserviert. Es gibt höchstens eine angedockte Objektansicht; verschachtelte Dialoge bleiben modal. Formulare und Entscheidungen mit Freigabe-, Wiederherstellungs- oder Berechtigungswirkung behalten ihre explizite modale Interaktion. Größenwechsel allein darf weder Auswahl noch Eingaben, aufgeklappte Details oder Entwürfe verwerfen und löst keine fachliche Aktion aus. Ein angedockter Bereich hat einen zugänglichen Namen und einen Schließen-Knopf; Escape gilt für den fokussierten Bereich, verschachtelte Dialoge haben Vorrang. Nach Schließen kehrt der Fokus zum noch vorhandenen Auslöser zurück.

**Drei Ebenen auf jeder Detailseite.** Kopf: Zurück, Titel mit Kategorie-Chip und Aktionen in einer Zeile, darunter ein Satz Zweck; auf dem Telefon stehen die Aktionen unter dem Titel. Darunter ein Status-Streifen mit einem Satz und höchstens einer Aktion, wo es etwas zu sagen gibt, dann Tabs (`?tab=`). Jeder Tab beginnt mit einer Zusammenfassungszeile, zeigt ein Hauptelement und klappt den Rest zu. Ebene 1 ist bildhaft und in Klartext (Ablauf- und Verbindungsgrafik, Kacheln, Zeitleiste, Chips mit Klarnamen); Ebene 2 öffnet ein Element im Seitenblatt; Ebene 3 heißt immer „Technische Angaben", steht zuletzt und ist zugeklappt. Kennungen, Verweise, Rollenschlüssel, Schritt-Kennungen, Header und JSON stehen nur in Ebene 3. Höchstens ein gefüllter Knopf je Ansicht; jede Wirkung hat genau einen Auslöser.

**Zustand ohne Farbflächen.** Zustand zeigen Badge und Status-Streifen (Punkt und Satz). Farbige Randstreifen, getönte Karten- oder Streifenhintergründe als Zustandsanzeige gibt es nicht; einzige Ausnahme ist der fehlgeschlagene Schritt in der Ablaufgrafik.

**Chat-Kontext.** Der vorhandene Kontext einer geladenen Unterhaltung erscheint bei ausreichender Arbeitsbreite automatisch neben dem Verlauf. Die ausdrücklich gewählte offene oder geschlossene Darstellung wird gespeichert und hat Vorrang vor der Automatik. Bei geringerer Breite bleibt der Kontext über denselben Schalter erreichbar. Responsive Anpassung verändert die Darstellung der vorhandenen Informationen, nicht die verbindliche Designreferenz oder die fachlichen Abläufe.

## 7. Drift-Kontrolle ohne Shared Code

Die Konvention wird nicht technisch erzwungen. Zwei leichte Mechanismen statt dessen: (1) Diese Datei liegt versioniert in jedem Repo; eine Änderung an der Konvention ist ein PR in sechs Repos — bewusst teuer, damit sie selten ist. (2) Optional prüft WatchKit einzelne Regeln als Vertragsaussagen gegen die laufenden Cockpits (z. B. „kein ‚Unbekannt'-Status im DOM der Startseite"), so wie es heute schon API-Zusagen gegen Verhalten prüft.

## 8. Anliegen-Grammatik

Jedes Produkt, das menschliche Aufmerksamkeit braucht (Freigaben, Reviews, Budget-Gates, Proposals, Rückfragen, gestörte Anmeldungen, scheiternde Automatik), zeigt sie an **einem** Ort: der Anliegen-Liste auf der „Übersicht" (§1). Eine eigene Entscheidungs-Seite und eine System-Seite gibt es daneben nicht; die Betriebsleiste über der Liste zeigt Zahlen, keine Aufgaben. Die Liste beantwortet die drei Fragen in dieser Reihenfolge: Was passiert? Braucht es mich? Was tue ich dann? Jedes Produkt baut das Muster in eigenen Komponenten nach (kein Import).

**8.1 Eine Quelle.** Die Liste kommt von der Engine, nicht aus dem Browser: `GET /v1/attention` (`attention.v1`) liefert die Einträge, je Eintrag gegen die Rechte der lesenden Person geprüft, und je Quelle ihren Stand (`answered` · `failed` · `not_permitted`). Digest, MCP-Verbindungszeile und das MCP-Werkzeug `get_attention` rendern dieselbe Liste. Rückfragen sind immer die eigenen der lesenden Person. Der Navigationseintrag „Übersicht" trägt als Abzeichen die Zahl der Einträge.

**8.2 Ein Eintrag je Gegenstand, drei Klassen.** Was denselben Gegenstand betrifft, ist **ein** Eintrag: ein scheiternder Workflow samt seinen offenen Korrekturen ist ein Eintrag, nicht einer je Lauf und einer je Korrektur; mehrere Skill-Vorschläge sind ein Eintrag. Die Klassen und ihre feste Reihenfolge: **gestoppt** (etwas steht, bis jemand handelt — gehaltener Zeitplan, wartende Rückfrage, abgelaufene Anmeldung) → **scheitert** (etwas läuft und schlägt fehl) → **entscheiden** (ein Vorschlag wartet, nichts ist blockiert). Innerhalb einer Klasse: nächste Frist zuerst, dann älteste. Es gibt keine Art-Chips, keine Rubriken, keinen Gruppieren-Umschalter und keine Zahl im Listenkopf. Nicht aufgenommen werden Warnungen, Test- und Autoren-Fehlschläge und ungenutzte Schlüssel — sie sind Zustand eines Objekts, keine Aufgabe.

**8.3 Eintrag.** Ein Satz: Gegenstand (beim Namen, nie UUID) + Grund + „seit …", wo vorhanden mit Frist „Entscheiden bis …" samt Herkunft. Dazu **eine** Hauptaktion und **höchstens ein** Nebenlink. Die Hauptaktion benennt die Handlung („Prüfen", „Anmelden", „Antworten" — nie „OK", nie „Öffnen"); ihre Reihenfolge folgt der Ursache (eine bereitliegende Korrektur wird zuerst geprüft, eine abgelehnte Anmeldung führt zum Konnektor, alles andere in den Chat mit dem Gegenstand im Kontext). Wer die Handlung nicht darf, sieht den Grund statt eines Links. Der Wortlaut der Engine steht nicht am Eintrag.

**8.4 Prüf-Seitenblatt.** Entschieden wird im Seitenblatt, das sich über der Liste öffnet und eine eigene Adresse hat (`?review=<id>`), damit Mail, Audit-Zeile und Lesezeichen direkt darauf zeigen können. Das Seitenblatt trägt die Karten-Anatomie: Meta-Zeile (Status-Glyph + Art-Badge · Quell-Referenz als Link · Frist mit Herkunft) → Titel (line-clamp-2, nie UUID) → Wirkung in einer Zeile → Quellzeile → Aktionen, die die Handlung benennen („Freigeben", „Ablehnen", „Änderung anfordern"). Ablehnung klappt ein Notizfeld auf. Mehr Kontext steht hinter einem benannten Toggle („Mehr anzeigen"), nie hinter einem nackten Chevron: volle Begründung, Rohdaten der Quelle, der Wortlaut der Engine, ggf. ein Formular für strukturierte Rückfragen. Technische Details sind zugeklappt. Nach der Entscheidung verschwindet der Eintrag sofort (Optimistic-Hide), ein Toast verlinkt den Audit-Trail; ein Fehler bringt den Eintrag zurück. Wo das Produkt einen zurückgestellten Zustand kennt, bietet das Seitenblatt „Später erinnern" (Presets + eigener Zeitpunkt); wo nicht, fehlt die Aktion, statt einen Zustand vorzutäuschen, den die Engine nicht führt. „Dauerhaft verwerfen" nur mit Bestätigung; wenn endgültig, sagt die UI das.

**Drei Arten von Nein.** Wo das Produkt sie kennt, unterscheidet das Seitenblatt: Ablehnung **mit** Begründung (schickt zurück ans Nacharbeiten) · Ablehnung **ohne** Begründung (beendet) · **Verwerfen** (folgenlos — als „folgenlos" beschriftet). Eine unbeantwortete Frist verfällt sichtbar als „verfallen (nicht entschieden)", nie stillschweigend. Ein wiederholter identischer Vorschlag zeigt die frühere Ablehnung samt Begründung — die Oberfläche bohrt nicht nach, bis der Mensch ja sagt. Wo Auftraggeber und Freigeber getrennte Rollen sind, zeigt das Seitenblatt, wer entscheiden darf; die eigene Beauftragung ist markiert.

**8.5 Zustand und Geschichte sind getrennte Flächen.** Die Anliegen-Liste zeigt ausschließlich, was auf den Menschen wartet. Zurückgestellt, Verworfen und Entschieden sind Vergangenheit: Erledigtes verlässt die Liste — es wird nicht gedimmt, nicht durchgestrichen, nicht in eigene Sektionen unter der Liste gestellt und nicht über Zustands-Filter wieder hereingeholt. Die vollständige Geschichte wohnt im Audit-/Aktivitätsprotokoll (append, nie gekürzt) und ist von der Übersicht über **genau einen** Verweis erreichbar — „Was bereits entschieden wurde", ein Satz mit Link, keine Zähler-Kacheln. Ein Wert der Betriebsleiste, der auf die gefilterten Audit-Einträge seines Zeitfensters führt (§10.1), ist kein zweiter Verweis auf die Geschichte, sondern der Beleg seiner Zahl.

**8.5b Die Zahl selbst ist eine Design-Frage.** Eine Liste, die einem Menschen
Hunderte Positionen vorlegt, hat ihre Aufgabe verfehlt, egal wie gut sie gegliedert ist.
Gemessen am 21.08.2026: WatchKit legt **359 Positionen** vor, weil Doku- und Drift-Befunde als
Entscheidungen zählen; WorkKit zeigt **15 gleichartige Budget-Sperren einzeln**; SubKit lässt
**jede Korrektur-Karte einer Gruppe einzeln** entscheiden; bei SubKit trugen die wartenden
Unterhaltungen **weder Freigeben noch Ablehnen** — folgenlose Positionen in einer
Entscheidungs-Queue.

Das ist kein Darstellungs-, sondern ein Zuschnittsproblem: **was gleichartig ist, wird zu
einer Entscheidung zusammengefasst; was folgenlos ist, ist keine.** §8.2 („ein Eintrag je
Gegenstand") ist die Antwort darauf.

> **Korrektur, 21.08. 18:40.** Oben stand „bei SubKit sind 32 von 35 Positionen wartende
> Unterhaltungen". Die 32 stammen aus dem **Prüfstand-Mock**, der den Statusfilter ignorierte;
> auf PROD liefert derselbe Aufruf `total=1`. Gefunden vom SubKit-Verifier, nachdem der Satz
> bereits byte-gleich in sechs Repos stand. **Eine Zahl, die niemand nachmisst, wird durch
> Verteilung nicht wahrer.**
>
> **Zweite Korrektur, 21.08. 19:20.** Der erste Korrekturblock stand *vor* dem Regelsatz, und
> Markdowns lazy continuation zog ihn mit hinein — die Regel las sich in allen sechs Repos als
> Teil einer historischen Fußnote. Gefunden vom Verifier der Konventionsrunde, der die Datei
> durch einen Markdown-Renderer geschickt hat statt sie zu lesen. **Auch eine Korrektur kann
> beschädigen, was sie korrigiert.**

**8.6 Leere.** Nichts offen und jede lesbare Quelle hat geantwortet: „Nichts braucht dich gerade." an der Stelle der Einträge, die Zusammenfassungszeile zählt „0 Einträge brauchen dich"; darüber bleibt die Betriebsleiste (§1) stehen — keine Statuszeile, keine Kachel mit 0. Eine Quelle hat nicht geantwortet: kein „Nichts braucht dich" und keine Zählung, sondern ein Hinweis, welche Quelle nicht lesbar war, mit „Erneut lesen"; die Einträge der übrigen Quellen stehen trotzdem da. Eine Quelle, die die Person nicht lesen darf, zählt nicht als fehlend. Die Ursachen eines schlechten Zustands sind selbst Einträge. Alle Fälle sind getrennt testbar (§4 gilt).

**8.7 Kein Incident-Banner.** Ein offenes Budget- oder Health-Gate und eine gerissene Frist sind Einträge der Klasse „gestoppt" oder „scheitert" und stehen damit oben in der Liste. Ein zusätzliches Banner wäre ein zweiter Ort für denselben Fakt (§0.1). Eine Startseite, die bei offenen Gates „Nichts braucht dich gerade." meldet, bleibt ein Konventionsbruch.

**8.8 Produkt-Spezifisch bleibt:** die Quellen und Arten (Kinds) und ihre Badges, die Resolver-Formulare im Seitenblatt, die Quell-Referenzen. Familienweit sind die eine Engine-Quelle, die drei Klassen und ihre Reihenfolge, die Eintrags-Anatomie, das Seitenblatt, die Sprache, die Trennung von Zustand und Geschichte und die Leere-Regel.

## 9. Diff-Freigabe

Schlägt ein Agent oder Automat eine Änderung an einem verwalteten Objekt vor (Patch-Kandidat, Proposal, Revision, Preview-Promotion), gilt: **Die Entscheidung passiert, wo der Vorschlag entstand.**

**9.1 Diff-Karte.** Der Vorschlag erscheint als Karte in der Konversation bzw. auf der Quellseite: Ziel-Label (Objekt · Version, nie UUID) → Zeilen-Diff (alt/neu) → wo vorhanden das Prüf-Ergebnis daneben (Dry-Run, Preview, Lint) → Aktionen nach §8.4 („Freigeben", „Ablehnen", Notizfeld klappt auf). Kein Seitenwechsel für die Entscheidung.

**9.2 Doppelte Sichtbarkeit.** Jeder offene Vorschlag steht zusätzlich als Eintrag auf der Übersicht (§8), und sein Prüf-Seitenblatt zeigt dieselbe Karte — die Karte am Entstehungsort ist der schnelle Weg, die Übersicht das Sicherheitsnetz gegen Vergessen. Beide führen auf dieselbe API-Entscheidung, mit Audit-Spur. Das ist keine Doppelung im Sinne von §0.1: die Aufgabe wohnt auf der Übersicht, die Karte am Entstehungsort ist ihr Kontext.

**9.3 Produkt-Spezifisch bleibt:** der Diff-Renderer (Text, JSON, Code, Markdown), die Prüf-Semantik (Dry-Run vs. Preview vs. Build) und das Zielobjekt-Vokabular.

## 10. Sammlungs-Listen

Jede Sammlung gleichrangiger Objekte (Workflows, Skills, Quellen, Checks, Spaces) folgt einer Grammatik: Suche + Sortier-Header + **Kategorie-/Ordner-Chips** oberhalb der Liste („Alle" ist der einzige feste Chip; Kategorien kommen aus den Daten, nie hartkodiert). Umkategorisieren inline in der Zeile, nicht über eine Detailseite. Gefilterte Leere nennt den Filter und bietet den Rückweg („Alle anzeigen") — §4 gilt.

**Zeilen öffnen über den Namen.** Die Namens-Zelle ist ein echter Link (`<a href>`) auf die eigene Adresse des Objekts, seine Detailseite `/{ressource}/{id}` — Tastatur, Screenreader und „in neuem Tab öffnen" erreichen ihn. Ein Klick führt direkt dorthin; ein Vorschau-Seitenblatt zwischen Liste und Detailseite gibt es nicht. Zurück stellt Filter, Suche, Gruppierung und Scrollposition der Liste wieder her, und die zuletzt geöffnete Zeile ist kurz hervorgehoben. Die ganze Zeile bleibt als Komfort klickbar und ignoriert Klicks auf Bedienelemente in ihr; die Zeile selbst ist kein Tab-Stopp. Einen „Öffnen"-Knopf in der Zeile gibt es nicht. Das „⋯" steht nur für ein **echtes Menü** mehrerer weiterer Aktionen; eine einzelne weitere Aktion ist ein benannter Knopf. Die mobile Karte ist kein Knopf: ihr Titel ist der Link, sie enthält keine verschachtelten Links, und die Zeilenaktionen stehen auch mobil auf der Karte.

**Zustand statt Aufgabe.** Eine Objektliste zeigt den Zustand ihrer Zeilen (Chips nach §2/§11) und höchstens einen Link zum Eintrag auf der Übersicht; eine eigene Aufmerksamkeitsliste über der Tabelle ist eine zweite Aufgabenliste und damit ein Konventionsbruch (§0.1). Listenköpfe tragen keine Zahl offener Anliegen.

**10.1 Zahlen führen auf Listen, die dasselbe zählen.** Jede Zahl mit Link (Kennzahl, Chip, Zähler) führt auf eine Liste, die **dasselbe** zählt: gleiches Zeitfenster, gleicher Filter, gleicher Gegenstand. „Ausführungen (30 Tage): 412" öffnet die Ausführungsliste der letzten 30 Tage, nicht alle; „Erfolgsquote" öffnet die gescheiterten Läufe desselben Fensters. Eine gezählte Null hat nichts zu öffnen und trägt keinen Link; ein Verhältnis, ein Score oder eine Dauer bei 0 ist der schlechteste Zustand und behält seinen Weg zur Ursache. Eine Zahl, deren Link auf eine anders zählende Liste führt, ist ein Konventionsbruch — der Mensch vergleicht beide und glaubt keiner.

## 11. Verbindungs-Status

Alles, was eine Fremdsystem-Verbindung repräsentiert (Connector, Binding, Quelle, Site), zeigt sich als Karte oder Zeile mit drei Pflichtangaben: **Auth-Zustand** als Wort + Badge (verbunden · abgelaufen · Zugangsdaten fehlen · nie eingerichtet — Vokabular nach §2/§4), **Umgebung** (dev/prod-Badge, wo das Produkt Umgebungen kennt) und **„Verbindung testen"** als sichtbare Aktion mit Ergebnis in place. Ein abgelaufener OAuth-Zustand nennt den Weg zur Erneuerung — kein Rot ohne Weg zur Ursache (§1).

**Fähigkeits-Inventur.** Die Karte beantwortet die wichtigere Frage: **Was darf diese Verbindung?** Fähigkeitsliste (lesen · suchen · schreiben · …) plus Risikostufe als Badge (lesen · nach draußen · **schreibt**). Schreibrecht ist nie Kleingedrucktes — „ein Server, der schreiben darf, ohne dass du es weißt, ist keine Verbindung, sondern eine offene Tür." Ergänzend gehört zu jeder Installation eine **Rechte-Inventur**: angesammelte Einzelfreigaben, stehende Grants und Schlüssel mit Alter, letzter Nutzung und Widerruf in place — Rechte häufen sich still an, die Inventur macht es zur Entscheidung.

## 12. Berichts-Grammatik

Jeder automatisch erzeugte Bericht oder Digest endet mit einem Block „**Was du entscheiden musst**" — dessen Positionen sind dieselben wie die Einträge auf der Übersicht (§8, aus derselben Engine-Quelle) und verlinken auf ihr Prüf-Seitenblatt. Ein Bericht ohne Befund ist kein leerer Lauf, sondern der Beleg, dass geprüft wurde: „0 Befunde · geprüft vor 2 min" (§4). Die **Reihe** der Berichte ist sichtbar — Lücken (ausgefallene Läufe) erscheinen als Lücke, nicht als Stille. Drei Nicht-Zustände bleiben unterscheidbar: geprüft-nichts-gefunden · nie hingeschaut · kein Zugang. Erfolgs-Aussagen verlinken ihren Beleg — eine Messung mit Herkunft, nie die Behauptung des Agenten; Assistenten-Antworten zitieren ihre Quellobjekte als Links.

## 13. Prüfen vor Reparieren

Wo ein Produkt automatisch pflegt, heilt oder aufräumt, sind Prüfen und Reparieren **zwei getrennte Aktionen in fester Reihenfolge**: „Prüfen" liest und ändert nichts (Ergebnis: Bericht nach §12); „Reparieren" folgt danach und nur in erlaubten Zonen. Ein Bearbeiter, der sein eigenes Ergebnis bewertet, meldet Erfolg — deshalb nie ein Knopf für beides. Sicherungen, familienweit: erst die Änderungsliste zeigen, dann ändern; ab einer Schwelle rückfragen; **Löschen ist immer ein Vorschlag, nie eine automatische Handlung**; bei Unsicherheit nicht anfassen; ein Befund ist kein Auftrag — der Mensch entscheidet pro Befund. Prüf-Ergebnisse nennen die Version des Maßstabs, gegen den sie liefen; der Maßstab hat eine Quelle und keine Kopien.

## 14. Modus & Schranken

Jeder Freigabe-/Autonomie-Modus zeigt am Wähler seine **Gate-Matrix**: welche Gates bleiben, welche entfallen — der Name allein sagt nichts über die Schranke, und zwei Modi mit gleicher Matrix sind eine Lesefalle. Regel- und Policy-Listen kennzeichnen jede Zeile als **Leitplanke** (Anweisungstext an das Modell — eine Bitte) oder **Grenze** (erzwungen durch Rechteprüfung, Abschottung oder nutzlastgebundene Freigabe). Wer beides gleich darstellt, verkauft Ordnung als Sicherheit.

## 15. Audit-Trail

**Entscheidung Mike, 22.08.2026.** §0 schickt die Vergangenheit hierher — also muss diese
Fläche in allen sechs Produkten **dieselbe** sein. Gemessen am 22.08. war sie es nicht:
vier verschiedene Spaltensätze (5 bis 8 Spalten), „Aktion" gegen „Vorgang" gegen `subject`,
„Akteur" gegen „Verursacher" gegen `origin`, eine Überschrift „Audit-Protokoll" gegen fünfmal
„Audit", und ein Produkt ohne Tabelle. **Der Grund: es gab keinen Paragrafen.** Die Aufträge
trugen eine Beschreibung, und eine Beschreibung kann nicht fehlschlagen.

**15.1 Name und Ort.** Der Menüeintrag heißt **„Audit"**, in der Gruppe Verwaltung (§6).
Die Seitenüberschrift heißt **„Audit-Trail"**. Nicht „Protokoll", nicht „Audit-Protokoll",
nicht „Verlauf".

**15.2 Die vier Spalten.** In dieser Reihenfolge, mit diesen Namen:

    Ereignis · Wer · Ergebnis · Wann

- **Ereignis** nennt den Vorgang und den dokumentierten Objektnamen. Fehlt der Name,
  darf ein berechtigt gelesener Name verwendet werden; sonst bleibt die Ressourcenart sichtbar.
  Unbekannte Vorgangsnamen erscheinen als erkennbare Maschinenwerte.
- **Wer** nennt ausschließlich dokumentierte, typisierte Akteure. Fehlt die Identität,
  bleibt die dokumentierte Akteursart oder ein Gedankenstrich; sie wird nie erschlossen.
- **Ergebnis** heißt Erfolgreich, Fehlgeschlagen oder Verweigert.
- **Wann** ist absolut, nie eine relative Spanne.

Produktspezifische Zusatzspalten stehen rechts der vier Spalten.

**15.3 Was die Seite können muss.** Serverseitige Suche und Filter, vollständiges Blättern,
Ereignisdetail mit sichtbaren Hashes und Rohdaten, Kettenstatus, Export der aktuellen Auswahl.

**15.4 Die Fußnote ist Pflicht.** Die Seite nennt, **was das Protokoll nicht umfasst** —
damit ein schmales nicht als vollständiges gelesen wird. Eine Quelle, die nicht antwortet,
wird **über der Tabelle benannt**, nicht verschluckt.

**15.5 Der Motor.** Verbindlich ist der Standard **audit.v1** aus Mikes Plan: append-only,
`prev_sha256`/`sha256`-Kette, Sequenz und Hash atomar unter Sperre, Ereignis und Änderung in
**einer** Transaktion, Fehler und Verweigerungen ebenfalls aufgezeichnet, tägliche
Kettenkopf-Manifeste außerhalb der Produktdatenbank. Flächen: `GET /v1/audit`,
`/v1/audit/{id}`, `/v1/audit/verify`, `/v1/audit/export.ndjson`.

**Gemessen am 22.08.2026** — der Ausgangspunkt, an dem sich der Fortschritt messen lässt:

| | Tabelle | Kette | `/v1/audit` | verify | export |
|---|---|---|---|---|---|
| WorkKit | ja | **ja** | ja | ja | — |
| SubKit | ja | — | ja | — | **ja** |
| ContentKit | ja | — | ja | — | — |
| WikiKit · CodeKit · WatchKit | — | — | — | — | — |

**15.6 Die elf Nachweise.** Ein Audit-Trail ist erst fertig, wenn jeder davon **gefahren**
ist — nicht beschrieben, nicht zugesichert. Vollständig in `AUDIT-NACHWEISE.md`:

1. Jede Mutation erzeugt **genau einen** passenden Erfolgs- oder Fehlernachweis.
2. Eine künstlich fehlschlagende Audit-Speicherung **rollt die fachliche Änderung zurück**.
3. `UPDATE`, `DELETE`, `TRUNCATE` auf Audit-Tabellen sind für den Laufzeitbenutzer **verboten**.
4. Manipulation oder Entfernung eines Eintrags wird in einer **wiederhergestellten
   PROD-Kopie** erkannt und meldet die **erste defekte Sequenz**.
5. Vollständiges Cursor-Durchlaufen entspricht dem **Datenbanksnapshot**.
6. **HTTP und MCP** liefern dieselben Ereignisse und Filterergebnisse.
7. Der Export endet am festgehaltenen **Cutoff** und enthält alle Ereignisse dieses Snapshots.
8. **Jeder** persistierte KI-Output besitzt Ergebnis-ID, Hash, Lauf, Provider und Modell.
9. Text- und Bildbytes ergeben beim **erneuten Hashen** denselben SHA-256.
10. Audit und Export enthalten **keine** Test-Tokens, Prompts, Passwörter oder Geheimnisse.
11. **C2PA**-signierte Bilder bestehen die **unabhängige** Validierung; Bearbeitungen behalten
    die Zutatenkette.

Geführt wird der Stand als Tabelle Produkt × Nachweis, drei Ausgänge je Zelle: **gefahren ·
gefallen · nicht gebaut (mit Messwert)**. **Eine Zelle ohne Lauf ist nie grün.**

**Historische Lücken werden nicht schöngerechnet:** Altdaten werden als `legacy_partial`
versiegelt, der lückenlose Nachweis beginnt am dokumentierten Umstellungszeitpunkt.

## 16. Auftragskette

Ein Lauf beantwortet vier Fragen, jede an genau einem Ort (§0.1):

| Frage | Ort | Form |
|---|---|---|
| Wer hat den Auftrag gegeben? | Lauf-Sheet, unter dem Statusbalken | eine Zeile „Auftrag von · Kanal" + Badge **geprüft**, **automatisch** bei gespeicherter Engine-Identität oder **nicht dokumentiert** bei fehlendem Identitäts-/Prüfnachweis |
| Warum durfte er starten? | Lauf-Sheet, zugeklappt „Warum erlaubt" | Prüfverfahren · Berechtigung · Umgebung · Link auf die Freigabe |
| Mit wem spricht SubKit? | Schrittzeile und Konnektor | „Liest/Schreibt · Konnektor"; aufgeklappt „Spricht als" mit Status, nie Werte |
| Was ist passiert? | Statusbalken und Schritte | wie bisher; eine Freigabe ist kein Erfolg |

**16.1 Herkunft wird gekennzeichnet.** Geprüft (von SubKit festgestellt) · vom Client übermittelt · im Workflow ermittelt. Übermittelte Angaben verleihen nie Rechte.

**16.2 Technische Auslöser heißen, was sie sind.** Zeitplan, Webhook, Unterworkflow — kein erfundener Mensch. Ein Unterlauf nennt den ursprünglichen Lauf.

**16.3 Drei Fehler, drei Seiten.** Anmeldung abgelaufen · Anmeldung nicht zugeordnet · Workflow nicht erlaubt. Nie „Authentifizierung fehlgeschlagen" (§4).

**16.4 Ein Vorgang, eine Kennung.** Lauf, Audit-Einträge und die Antworten von HTTP, MCP und CLI tragen dieselbe Vorgangskennung; das Audit filtert danach und nach Verursacher (§15).

**16.5 Nicht zeigen.** Tokens, Schlüssel, Roh-Header, Kennungen von Schlüsseln. Begriffe wie Principal oder `$caller` stehen nur im aufgeklappten Detail.
