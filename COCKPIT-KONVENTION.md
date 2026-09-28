# Cockpit-Konvention

Version 2.1.1 · 28.09.2026 · Gilt für: ContentKit, SubKit, WorkKit, WikiKit, CodeKit, WatchKit

**Modell: Konvention statt Bibliothek.** Jedes Produkt bleibt eigenständig — eigenes Repo, eigene shadcn-Komponenten (vendored, wie shadcn gedacht ist), eigene Releases, kein shared Package. Geteilt wird nur dieses Dokument. Eine Kopie liegt in jedem Repo; Abweichungen sind erlaubt, wo das Produkt es begründet — die Konvention ist der Default, nicht das Gesetz.

**v2.x ist SubKit-first — eine gewollte Abweichung von der Familie, bis die Geschwister folgen.** SubKit setzt v2.1 und `FAMILY-UI.json` 3.0 zuerst um. ContentKit, WorkKit, WikiKit, CodeKit und WatchKit arbeiten nach v1.7 und `FAMILY-UI.json` 2.3, bis ihre eigenen Umsetzungs-Schnitte folgen; bis dahin gilt in ihren Repos die v1.7-Kopie. Den Startseiten-Namen „Übersicht" tragen alle sechs bereits. Was ein Geschwister umsetzen muss, steht in `FAMILY-UI.json` unter `migration`. Die v2.3-Schnittstelle `GET /v1/operational-overview` bleibt in SubKit erhalten, damit Geschwister und Prometheus weiterlesen können.

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
| Gesundheitszustand | Statuszeile auf der Übersicht, **nur im leeren Zustand**; Ursachen sind Einträge | nirgends |
| Komponenten/Score | nur API, MCP, Prometheus | — |
| Zahl offener Anliegen | Abzeichen am Navigationseintrag = Zahl der Einträge | Listenköpfe ohne Zahl |
| Ausführungen, Erfolgsquote, Konnektor-Gesundheit, Reparaturquote | Übersicht, Betriebsleiste (je Wert ein Link in die gefilterte Liste desselben Zeitfensters, §10.1) | Nutzung zeigt Verbrauch, Kontingent und Laufzeit, nicht diese Werte |
| Datenstand | Eintrag auf der Übersicht, nur wenn veraltet | — |
| Drift-Scan | kein Knopf im Cockpit (der Scheduler scannt; CLI/MCP behalten ihn) | — |
| Titel wiederholende Beschreibungen | entfallen | — |
| „Öffnen" in Zeilen | entfällt; der Name ist ein echter Link, die Zeile klickbar (§10) | — |
| Aufmerksamkeitsliste auf Objektseiten (z. B. Zugangsdaten) | **entfällt** — eine zweite Aufgabenliste; Zeilen tragen Zustands-Chips, Zeilenaktionen (z. B. „Erneuern") bleiben | — |
| Wortlaut der Engine | nur im Prüf-Seitenblatt (§8.4), nicht an Einträgen oder Listen-Markierungen | — |

Wer einen Fakt an einer zweiten Stelle zeigen will, verlinkt auf seinen Ort, statt ihn zu
wiederholen. Zwei Stellen mit derselben Zahl sind zwei Stellen, die auseinanderlaufen.

## 1. Startscreen-Vertrag

Der erste Screen jedes Cockpits ist die **„Übersicht"** (`/`, englisch „Overview"): oben die
Betriebsleiste, darunter die Liste der Anliegen, die diese Person jetzt braucht. Sie ersetzt
Entscheidungs-Seite und System-Seite aus v1.7; deren alte Adressen leiten auf die Übersicht um
(ein Link, der einen Gegenstand nannte, öffnet dessen Prüf-Seitenblatt).

**Aufbau.** Seitenkopf (Titel „Übersicht", Zeitfenster 24 Std · 7 Tage · 30 Tage, Vorgabe
24 Std) → Betriebsleiste → „Braucht dich": die Anliegen-Liste (§8) → ein Hinweis auf nicht
lesbare Quellen, nur wenn eine Quelle nicht geantwortet hat → genau ein Verweis „Was bereits
entschieden wurde" auf den Audit-Trail. Kein Ereignisstrom, keine Liste letzter Läufe.

**Betriebsleiste.** Genau vier Werte in einer Zeile, auf dem Telefon 2 × 2: Ausführungen,
Erfolgsquote, Gesunde Konnektoren, Übernommene Reparaturen. Ausführungen, Erfolgsquote und
Reparaturen zählen im gewählten Zeitfenster; „Gesunde Konnektoren" ist ein Zustand und trägt
„Stand jetzt". Jeder Wert führt auf die gefilterte Liste desselben Fensters (§10.1). Ein Wert,
der nicht gelesen werden konnte, sagt „nicht lesbar" und bietet an, erneut zu lesen — je Wert,
nicht für die ganze Leiste. Die Leiste ist kompakt (etwa 72 px hoch), damit die Anliegen im
ersten Screen stehen. Sie zeigt Zahlen, keine Aufgaben: was jemanden braucht, ist ein Eintrag
der Liste.

**Keine Null-Kacheln.** Die Übersicht zeigt keine nackte 0. Ein Wert ohne Daten sagt das in
Worten („Keine im Zeitraum", „Keine aktiven Konnektoren") und trägt keinen Link. Eine Kachel
„Blockiert: 0" beantwortet eine Frage, die niemand gestellt hat, und eine Wand aus Nullen
lehrt, die Seite zu überlesen.

**Leer.** Ist nichts offen, bleibt die Betriebsleiste stehen, und statt der Liste steht dort
„Alles erledigt." und **eine** Statuszeile (Gesundheitszustand · nächste geplante Ausführung).
Das gilt **nur**, wenn jede Quelle, die diese Person lesen darf, geantwortet hat. Hat eine
Quelle nicht geantwortet, nennt die Seite, was fehlt — ein falsches „Alles erledigt" ist
schlimmer als keines. Wer keine Quelle lesen darf, landet auf dem ersten sichtbaren
Navigationseintrag.

**Abzeichen.** Der Navigationseintrag „Übersicht" trägt die Zahl der Einträge der Liste —
dieselbe Zahl, nicht eine zweite Zählung.

Regeln: Kein Zähler ohne Link. Kein Rot ohne Weg zur Ursache. Die vier Betriebswerte wohnen
in der Betriebsleiste der Übersicht; Nutzung zeigt Verbrauch, Kontingent und Laufzeit, nicht
diese Werte. Komponenten und Score liefern API, MCP und Prometheus. „Nichts zu tun" ist ein
ruhiger Zustand, kein inszenierter Erfolg.

## 2. Zustandsvokabular

Sechs Zustände, jedes Produkt implementiert seine eigene Badge-Komponente mit denselben Namen und Farbrollen. Immer Punkt/Icon + Wort, nie Farbe allein.

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

Sidebar links: Wortmarke, gruppierte Navigation, Account unten (Avatar · E-Mail · Rolle · Menü: Profil/Sprache/Darstellung/Abmelden). Ganz oben, ungruppiert und ohne Überschrift: **Übersicht** mit Abzeichen (§1). Installation-Sektion enthält mindestens: Nutzung · Einstellungen · Zugangsdaten · Personen & Rechte · Benachrichtigungen · Audit. Eine System-Seite gibt es nicht mehr: der Gesundheitszustand ist die Statuszeile auf der Übersicht, seine Ursachen sind Einträge dort, Komponenten und Score liefern API, MCP und Prometheus (§0.1). **Personen & Rechte** ist die eine Seite für Personen, Rollen, Gruppen und Freigaben, je Abschnitt eine Adresse (`?section=…`); **Zugangsdaten** ist die eine Seite für API-Schlüssel, verbundene Anwendungen und Kontoverbindungen. Deep-Links funktionieren; abgelöste Adressen leiten auf ihren neuen Ort um, statt „nicht gefunden" zu zeigen; unbekannte Routen zeigen eine gestaltete Seite mit Rückweg. Mandanten-Switcher trennt Prod/Test, Test ausblendbar.

**Kanonische Gruppennamen.** Geteilte Konzepte heißen in allen sechs Produkten gleich: die Admin-Gruppe heißt **„Installation"** (nie „Administration"), der Startseiten-Eintrag heißt **„Übersicht"** und steht **ungruppiert** ganz oben (§1), die Rolle heißt **„Administrator"** (eine Schreibweise, keine Versalien-Varianten). Produktspezifische Gruppen (Wiki, Überwachung, …) bleiben frei benannt — aber deutsch und in Normalschreibung.

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

**Einstellungen** gliedern ihre Bereiche als gruppierte, senkrechte Liste — keine Tabs, keine Zähler, kein seitliches Scrollen bei keiner Breite: ab 720px Inhaltsbreite steht die Liste links neben dem gewählten Bereich, darunter ist sie die Startansicht, und ein Bereich öffnet sich mit „← Alle Bereiche" an ihrer Stelle. Eine Zeile zeigt das passende Bedienelement (Auswahl, Schalter, Zahl mit Einheit) und nur dann „Geändert · Standard: X · Zurücksetzen", wenn der Wert vom Standard abweicht; Zurücksetzen legt nur einen Entwurf an. „Alle | Geändert" steht neben der Suche und ist adressierbar. Ein Geheimnis zeigt nie seinen Wert, nur „Hinterlegt · Ersetzen" oder „Nicht hinterlegt · Hinterlegen". Entwürfe gehören der Seite, nicht dem Bereich: eine Leiste „N ungespeicherte Änderungen · Verwerfen · Speichern" speichert alle auf einmal, nie automatisch; hat inzwischen jemand gespeichert, sagt die Leiste das und die Entwürfe bleiben. Wer nur lesen darf, liest „Du darfst ansehen, nicht ändern."

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

**8.6 Leere.** Nichts offen und jede lesbare Quelle hat geantwortet: „Alles erledigt." und eine Statuszeile (Gesundheitszustand · nächste geplante Ausführung); darüber bleibt die Betriebsleiste (§1) stehen — nichts sonst, keine Kachel mit 0. Eine Quelle hat nicht geantwortet: kein „Alles erledigt", sondern ein Hinweis, welche Quelle nicht lesbar war, mit „Erneut lesen"; die Einträge der übrigen Quellen stehen trotzdem da. Eine Quelle, die die Person nicht lesen darf, zählt nicht als fehlend. Die Statuszeile erscheint nur im leeren Zustand; ist etwas offen, sind die Ursachen eines schlechten Zustands selbst Einträge. Alle Fälle sind getrennt testbar (§4 gilt).

**8.7 Kein Incident-Banner.** Ein offenes Budget- oder Health-Gate und eine gerissene Frist sind Einträge der Klasse „gestoppt" oder „scheitert" und stehen damit oben in der Liste. Ein zusätzliches Banner wäre ein zweiter Ort für denselben Fakt (§0.1). Eine Startseite, die bei offenen Gates „Alles erledigt" meldet, bleibt ein Konventionsbruch.

**8.8 Produkt-Spezifisch bleibt:** die Quellen und Arten (Kinds) und ihre Badges, die Resolver-Formulare im Seitenblatt, die Quell-Referenzen. Familienweit sind die eine Engine-Quelle, die drei Klassen und ihre Reihenfolge, die Eintrags-Anatomie, das Seitenblatt, die Sprache, die Trennung von Zustand und Geschichte und die Leere-Regel.

## 9. Diff-Freigabe

Schlägt ein Agent oder Automat eine Änderung an einem verwalteten Objekt vor (Patch-Kandidat, Proposal, Revision, Preview-Promotion), gilt: **Die Entscheidung passiert, wo der Vorschlag entstand.**

**9.1 Diff-Karte.** Der Vorschlag erscheint als Karte in der Konversation bzw. auf der Quellseite: Ziel-Label (Objekt · Version, nie UUID) → Zeilen-Diff (alt/neu) → wo vorhanden das Prüf-Ergebnis daneben (Dry-Run, Preview, Lint) → Aktionen nach §8.4 („Freigeben", „Ablehnen", Notizfeld klappt auf). Kein Seitenwechsel für die Entscheidung.

**9.2 Doppelte Sichtbarkeit.** Jeder offene Vorschlag steht zusätzlich als Eintrag auf der Übersicht (§8), und sein Prüf-Seitenblatt zeigt dieselbe Karte — die Karte am Entstehungsort ist der schnelle Weg, die Übersicht das Sicherheitsnetz gegen Vergessen. Beide führen auf dieselbe API-Entscheidung, mit Audit-Spur. Das ist keine Doppelung im Sinne von §0.1: die Aufgabe wohnt auf der Übersicht, die Karte am Entstehungsort ist ihr Kontext.

**9.3 Produkt-Spezifisch bleibt:** der Diff-Renderer (Text, JSON, Code, Markdown), die Prüf-Semantik (Dry-Run vs. Preview vs. Build) und das Zielobjekt-Vokabular.

## 10. Sammlungs-Listen

Jede Sammlung gleichrangiger Objekte (Workflows, Skills, Quellen, Checks, Spaces) folgt einer Grammatik: Suche + Sortier-Header + **Kategorie-/Ordner-Chips** oberhalb der Liste („Alle" ist der einzige feste Chip; Kategorien kommen aus den Daten, nie hartkodiert). Umkategorisieren inline in der Zeile, nicht über eine Detailseite. Gefilterte Leere nennt den Filter und bietet den Rückweg („Alle anzeigen") — §4 gilt.

**Zeilen öffnen über den Namen.** Die Namens-Zelle ist ein echter Link (`<a href>`) auf die eigene Adresse des Objekts — Tastatur, Screenreader und „in neuem Tab öffnen" erreichen ihn. Die ganze Zeile bleibt als Komfort klickbar und ignoriert Klicks auf Bedienelemente in ihr; die Zeile selbst ist kein Tab-Stopp. Einen „Öffnen"-Knopf in der Zeile gibt es nicht. Das „⋯" steht nur für ein **echtes Menü** mehrerer weiterer Aktionen; eine einzelne weitere Aktion ist ein benannter Knopf. Die mobile Karte ist kein Knopf: ihr Titel ist der Link, sie enthält keine verschachtelten Links, und die Zeilenaktionen stehen auch mobil auf der Karte.

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

**15.1 Name und Ort.** Der Menüeintrag heißt **„Audit"**, in der Gruppe Installation (§6).
Die Seitenüberschrift heißt **„Audit-Trail"**. Nicht „Protokoll", nicht „Audit-Protokoll",
nicht „Verlauf".

**15.2 Die fünf Spalten.** In dieser Reihenfolge, mit diesen Namen:

    Zeitpunkt · Vorgang · Art · Ergebnis · Verursacher

- **Zeitpunkt** ist **absolut** („19.08.2026, 14:11"), nie eine Spanne. Jede relative Angabe
  hier ist eine deutsche Präposition am Quantum — genau der Defekt, den §5 laufend findet.
- **Vorgang** ist ein deutscher Name, nie ein Maschinenwert. Wo keiner existiert, steht der
  Maschinenwert **als solcher erkennbar**, nicht „Unbekannt" (§2).
- **Verursacher** steht als Gedankenstrich, wo die Quelle keinen führt — **nie erschlossen**.

**Produktspezifische Zusatzspalten sind erlaubt** und stehen **rechts** der fünf (WorkKit:
Transport, Details; ContentKit: Website). Eine Zusatzspalte ist nie ein anderer Name für eine
der fünf.

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
