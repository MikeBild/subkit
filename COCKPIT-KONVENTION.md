# Cockpit-Konvention

Version 1.2 · 17.08.2026 · Gilt für: ContentKit, SubKit, WorkKit, WikiKit, CodeKit, WatchKit

**Modell: Konvention statt Bibliothek.** Jedes Produkt bleibt eigenständig — eigenes Repo, eigene shadcn-Komponenten (vendored, wie shadcn gedacht ist), eigene Releases, kein shared Package. Geteilt wird nur dieses Dokument. Eine Kopie liegt in jedem Repo; Abweichungen sind erlaubt, wo das Produkt es begründet — die Konvention ist der Default, nicht das Gesetz.

Referenz-Implementierung: der Zielbild-Prototyp (Artefakt „kit-cockpit-zielbilder"). Er zeigt jede Regel gerendert; bei Unklarheit gilt der Prototyp. Für §8 ist WorkKit die Referenz-Implementierung (Übergabe „workkit-entscheidungen-uebergabe"), für §9–§11 SubKit (Übergabe „subkit-referenzarchitektur-uebergabe").

Änderungen v1.1: neuer §8 Entscheidungs-Grammatik (hebt das Muster aus der WorkKit-Übergabe auf Familienebene); §1 Zone A verweist auf §8.
Änderungen v1.2: neue §9 Diff-Freigabe, §10 Sammlungs-Listen, §11 Verbindungs-Status (heben die Muster aus der SubKit-Übergabe auf Familienebene); §4 um „Leere führt zur Handlung" ergänzt.

---

## 1. Startscreen-Vertrag

Der erste Screen jedes Cockpits hat drei Zonen, in dieser Reihenfolge:

**Zone A — Wartet auf dich.** Alle menschlichen Gates des Produkts in einer Karte: Anzahl im Kopf, Alter der ältesten Position, eine Aktion pro Zeile. Amber ab 1. Der Zähler steht zusätzlich am Übersichts-Eintrag der Sidebar. Zone A ist die Kurzform der Entscheidungs-Seite (§8): sie zeigt die Top-Positionen derselben Queue und verlinkt dorthin; entschieden wird auf der Entscheidungs-Seite.

**Zone B — Kernobjekt-Hero.** Pro Produkt verschieden und dessen Identität: Release-Kette (ContentKit), Fehlergruppen (SubKit), Freigabe-Triage + Budgetampel (WorkKit), Fragen-Karten (WikiKit), Aufgaben je Projekt (CodeKit), ehrliches Banner + Streifen (WatchKit).

**Zone C — Zuletzt geschehen.** Letzte Läufe/Änderungen, jede Zeile klickbar.

Regeln: Kein Zähler ohne Link. Kein Rot ohne Weg zur Ursache. Betriebsmetriken (HTTP, p95, Calls) wohnen unter Installation → System, nie auf dem Startscreen. Nur WatchKit darf „nichts zu tun" als Erfolg inszenieren.

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

Deutsch auf oberster Ebene; Fachbegriffe (SRE, API-Namen) erst in der Detailtiefe. Rollen-Label einheitlich „Administrator". Destruktive Aktionen (Löschen, Verwerfen, Widerrufen) nie als rote Primärfläche in Listenzeilen — ins ⋯-Menü mit Bestätigung. Titel sind Zusammenfassungen, nie rohe Prompts oder UUIDs; Auto-Titel aus dem ersten Auftrag, wo kein Titel existiert.

## 6. Struktur-Konstanten

Sidebar links: Wortmarke, gruppierte Navigation, Account unten (Avatar · E-Mail · Rolle · Menü: Profil/Sprache/Darstellung/Abmelden). Installation-Sektion enthält mindestens: System · Einstellungen · Zugangsdaten · Benachrichtigungen · Audit. Deep-Links funktionieren; unbekannte Routen zeigen eine gestaltete Seite mit Rückweg. Mandanten-Switcher trennt Prod/Test, Test ausblendbar.

## 7. Drift-Kontrolle ohne Shared Code

Die Konvention wird nicht technisch erzwungen. Zwei leichte Mechanismen statt dessen: (1) Diese Datei liegt versioniert in jedem Repo; eine Änderung an der Konvention ist ein PR in sechs Repos — bewusst teuer, damit sie selten ist. (2) Optional prüft WatchKit einzelne Regeln als Vertragsaussagen gegen die laufenden Cockpits (z. B. „kein ‚Unbekannt'-Status im DOM der Übersicht"), so wie es heute schon API-Zusagen gegen Verhalten prüft.

## 8. Entscheidungs-Grammatik

Jedes Produkt, das menschliche Entscheidungen sammelt (Freigaben, Reviews, Budget-Gates, Proposals), hat **eine** Entscheidungs-Seite. Sie beantwortet die drei Fragen in dieser Reihenfolge: Was passiert? Braucht es mich? Was tue ich dann? WorkKit ist die Referenz-Implementierung; jedes Produkt kopiert das Muster in eigene Komponenten (kein Import).

**8.1 Navigation.** Der Eintrag steht ungruppiert direkt unter der Übersicht und trägt einen Live-Zähler (offene Positionen, dedupliziert). Der Zähler kippt auf rot, sobald eine Position abgelaufen ist oder ein Health-Problem enthalten ist. Produktname des Eintrags einheitlich: „Entscheidungen".

**8.2 Queue.** Eine Spalte, max-w ~780 px. Default-Sortierung: ablaufend zuerst, dann älteste zuerst. Positionen älter als 3 Tage stehen in einer eigenen Rubrik „Liegt schon länger". Filter-Chips nach Art, Gruppieren-Umschalter (Keine / Art / Verursacher), Persistenz lokal.

**8.3 Zeile.** Meta-Zeile (Status-Glyph + Art-Badge · Quell-Referenz als Link · Frist „Entscheiden bis …" wo vorhanden, mit Herkunft) → Titel (line-clamp-2, nie UUID) → Wirkung in einer Zeile → Quellzeile. Aktionen rechts unten: Buttons benennen die Handlung („Freigeben", „Ablehnen", „Änderung anfordern" — nie „OK"). Ablehnung klappt ein Notizfeld in der Zeile auf. Entscheidung verlässt die Seite nie; Optimistic-Hide + Toast, Fehler bringt die Zeile zurück. ⋯-Menü: Später erinnern (Presets + eigener Zeitpunkt) · Dauerhaft verwerfen (mit Bestätigung; wenn endgültig, sagt die UI das) · Quelle öffnen.

**8.4 Aufklappen.** Zeilen mit mehr Kontext tragen unten links einen benannten Toggle („Mehr anzeigen"), nie einen nackten Chevron. Aufgeklappt: volle Begründung, Rohdaten der Quelle, ggf. Formular für strukturierte Rückfragen. Die Entscheidungs-Buttons wandern ins Panel (kollabiert Kompakt-Form, expandiert Voll-Form).

**8.5 Regale.** Unter der aktiven Queue: einklappbare Sektionen „Zurückgestellt" (mit Wiedervorlage-Zeit), „Verworfen", „Entschieden" — gedimmt, mit Rückhol-Aktion wo die API es erlaubt.

**8.6 Leere.** Nie etwas offen: grüner Check, „Alles erledigt" + „Gerade wartet keine Entscheidung auf dich." Nur weggefiltert: eigene, kompaktere Meldung mit Hinweis auf die Filter. Beide getrennt testbar (§4 gilt).

**8.7 Incident-Banner.** Die Übersicht zeigt oberhalb aller Kacheln einen nicht schließbaren roten Banner, sobald ein Budget-/Health-Gate offen oder eine Frist gerissen ist — mit konkreten Zahlen und Link auf die Entscheidungs-Seite. Ein Dashboard, das bei offenen Gates Ruhe meldet, ist ein Konventionsbruch.

**8.8 Produkt-Spezifisch bleibt:** die Arten (Kinds) und ihre Badges, die Resolver-Formulare, die Quell-Referenzen. Familienweit sind Struktur, Sprache, Sortierung, Regale, Leere-Zustände und der Banner-Vertrag.

## 9. Diff-Freigabe

Schlägt ein Agent oder Automat eine Änderung an einem verwalteten Objekt vor (Patch-Kandidat, Proposal, Revision, Preview-Promotion), gilt: **Die Entscheidung passiert, wo der Vorschlag entstand.**

**9.1 Diff-Karte.** Der Vorschlag erscheint als Karte in der Konversation bzw. auf der Quellseite: Ziel-Label (Objekt · Version, nie UUID) → Zeilen-Diff (alt/neu) → wo vorhanden das Prüf-Ergebnis daneben (Dry-Run, Preview, Lint) → Aktionen nach §8.3 („Freigeben", „Ablehnen", Notizfeld klappt auf). Kein Seitenwechsel für die Entscheidung.

**9.2 Doppelte Sichtbarkeit.** Jeder offene Vorschlag steht zusätzlich in der Entscheidungs-Queue (§8) — die Karte ist der schnelle Weg, die Queue das Sicherheitsnetz gegen Vergessen. Beide führen auf dieselbe API-Entscheidung, mit Audit-Spur.

**9.3 Produkt-Spezifisch bleibt:** der Diff-Renderer (Text, JSON, Code, Markdown), die Prüf-Semantik (Dry-Run vs. Preview vs. Build) und das Zielobjekt-Vokabular.

## 10. Sammlungs-Listen

Jede Sammlung gleichrangiger Objekte (Workflows, Skills, Quellen, Checks, Spaces) folgt einer Grammatik: Suche + Sortier-Header + **Kategorie-/Ordner-Chips** oberhalb der Liste („Alle" ist der einzige feste Chip; Kategorien kommen aus den Daten, nie hartkodiert). Umkategorisieren inline in der Zeile (Picker im ⋯-Bereich), nicht über eine Detailseite. Gefilterte Leere nennt den Filter und bietet den Rückweg („Alle anzeigen") — §4 gilt.

## 11. Verbindungs-Status

Alles, was eine Fremdsystem-Verbindung repräsentiert (Connector, Binding, Quelle, Site), zeigt sich als Karte oder Zeile mit drei Pflichtangaben: **Auth-Zustand** als Wort + Badge (verbunden · abgelaufen · Zugangsdaten fehlen · nie eingerichtet — Vokabular nach §2/§4), **Umgebung** (dev/prod-Badge, wo das Produkt Umgebungen kennt) und **„Verbindung testen"** als sichtbare Aktion mit Ergebnis in place. Ein abgelaufener OAuth-Zustand nennt den Weg zur Erneuerung — kein Rot ohne Weg zur Ursache (§1).
