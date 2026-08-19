# Übergabe: SubKit Cockpit — Nutzerflüsse nach Vorbild der Referenzarchitektur

**Für:** Claude Code auf dem Mac, Repo `~/Projects/AI/subkit`
**Referenz-Grundlage dieses Produkts:** Die **Referenzarchitektur** (Lese-Referenz-Ordner neben diesem Repo) ist für SubKit die Referenz für **Architektur
und UI/UX-Design** — bei jeder Design-Frage, die diese Übergabe nicht
beantwortet, wird dort nachgesehen und das Muster kopiert (nie der Name).
**Sprachregelung:** Das Referenzprodukt im entsprechenden Ordner wird in Code,
Commits, Kommentaren und Doku ausschließlich **„Referenzarchitektur"** genannt;
sein Produktname fällt nirgends. Gleiches gilt für die Referenz-UI der
WorkKit-Übergabe.
**Einordnung:** Dies ist das Gegenstück zur WorkKit-Übergabe — dieselbe
Systematik (vollständige Lektüre der Referenz, Gap-Analyse, Stufenplan),
angewandt auf SubKit. Familienregeln: **Cockpit-Konvention v1.2** — §8
(Entscheidungs-Grammatik, Referenz-Impl. WorkKit) und die aus dieser
Übergabe gehobenen §9 Diff-Freigabe, §10 Sammlungs-Listen, §11
Verbindungs-Status (Referenz-Impl. SubKit). Stufe 2 implementiert §9,
Stufe 4 implementiert §10 + §11, Stufe 5 implementiert die
„Leere führt zur Handlung"-Ergänzung in §4. Die Konventions-Kopie im Repo
auf v1.2 heben bzw. als `COCKPIT-KONVENTION.md` ins Repo-Root legen.
Kein Shared Code zwischen den Produkten — Muster werden kopiert.

---

## 1. Was die Referenzarchitektur für Nutzer richtig macht

Vollständig gelesen: Web-Paket (Next.js, 12 Seiten, ~30 Agent-Tool-
Komponenten). Fünf Muster tragen die Nutzererfahrung:

**a) Agent-first mit reichen Chat-Komponenten.** Die Startseite ist der
Agent-Chat. Alles ist dort erledigbar, weil der Agent nicht Text, sondern
**interaktive Karten** in die Konversation rendert: Build-Tool-Karte,
Run-Karte mit Ergebnis, System-anlegen-Karte, OAuth-Authentifizierung,
Rollen-Test — rund 15 spezialisierte Komponenten.

**b) In-Chat-Diff-Freigabe.** Schlägt der Agent eine Änderung vor, erscheint
ein **angereicherter Diff direkt in der Konversation** (Ziel-Label, Zeilen-
Diff, JSON-Editor zum Nachschärfen) mit Freigeben/Ablehnen an Ort und
Stelle. Die Entscheidung passiert, wo der Vorschlag entstand — kein
Kontextwechsel, kein Review-Stau.

**c) Werkzeug-Detail als Schritt-Galerie mit Playground.** Ein Werkzeug ist
keine Formularseite, sondern eine **Galerie von Schritt-Karten** (je Schritt:
Konfiguration + letztes Ergebnis nebeneinander), dazu Payload-, Transform-,
Filter- und Trigger-Karten. Testlauf in place; im Editor sitzt eine
**Agent-Sidebar**, die beim Bauen hilft.

**d) Flache Navigation + Ordnung durch Ordner.** Fünf Einträge: Agent ·
Tools · Runs · Systems · Setup. Die Tools-Liste ordnet über **Ordner-Chips**
(+ Inline-Ordner-Picker pro Zeile), Templates, Import/Export, Deploy-Dialog.

**e) Geführter Erststart.** Welcome → Setup → Chat mit Beispiel-Prompts
(„Was kann das?", „Zeig mir eine Demo" mit verstecktem Starter-Prompt) und
System-Karussell. Der leere Zustand verkauft die nächste Handlung.

## 2. Was SubKit davon schon hat (Stufe 1 — gebaut, Deploy läuft)

- `/runs` nach dem Muster der Referenz-Runs-Seite: sprechende Namen
  (`workflow_name` im API), Status-Filter, Suche, Dauer-Formatierung,
  Detail-Sheet. Commits `e35606d1`, `e6b81e8b`, `ac767ca6`, `e8318bb5`.
- `/overview` als Startscreen (Zone A „Wartet auf dich" + Fehlergruppen) —
  bewusste Abweichung von der Referenzarchitektur (die hat kein Dashboard),
  gedeckt durch Konvention §1: SubKit ist Betriebsprodukt, WorkKit-Familie
  ist Overview-first. Der Chat bleibt eine Ebene darunter zentral.

## 3. Gap-Analyse — was noch fehlt, nach Wirkung sortiert

### Stufe 2: In-Chat-Diff-Freigabe für Patch-Kandidaten (größter Hebel)

Der akute Schmerz: **27 Fixes warten auf Review, der älteste seit 18 Tagen.**
SubKit hat Patch-Kandidaten mit Preview und Dry-Run in der Engine — aber das
Review lebt versteckt im Admin-Bereich. Übernahme des Musters b):

- Im Chat: schlägt eine Konversation (oder der Self-Healing-Lauf) einen
  Patch vor, rendert das Cockpit eine **Diff-Karte** in der Konversation:
  Ziel (Workflow · Version), Zeilen-Diff, Dry-Run-Ergebnis daneben,
  Aktionen „Freigeben" / „Ablehnen" / Notiz. API existiert
  (preview/dry-run/decide der Patch-Kandidaten).
- Zusätzlich `/decisions` nach Konvention §8: eine Queue für Patch-
  Kandidaten + Conversation-Approvals + Contract-Bestätigungen, mit
  Aging-Rubrik („Liegt schon länger" — die 18 Tage werden unübersehbar),
  Regalen, Zero-State, Nav-Eintrag „Entscheidungen" mit Live-Zähler unter
  der Übersicht. Die Overview-Karte „Wartet auf dich" verlinkt dorthin.

### Stufe 3: Workflow-Detail als Schritt-Galerie + Playground (Muster c)

- Workflow-Detailseite zeigt Schritte als Karten-Galerie: links
  Konfiguration (Kind, Connector, Transform), rechts das Ergebnis des
  letzten Laufs dieses Schritts (`/steps`-API liefert result_preview).
- „Testlauf"-Button je Schritt (Engine kann Step-Runs: source=step) und
  für den ganzen Workflow (source=draft), Ergebnis in place.
- Agent-Hilfe im Editor als Seitenleiste (SubKits eigene Konversations-API
  mit gebundenem Workflow — die Bindung existiert seit `4ca7e8b`).

### Stufe 4: Ordnung + Verbindungen (Muster d)

- Workflows-Liste: **Kategorie-Chips** — SubKits API führt `category`
  bereits an jedem Workflow; nur rendern (Chip-Zeile + Inline-Picker pro
  Zeile), dazu Sortier-Header und Suche wie auf `/runs`.
- Connectors-Seite nach dem Systems-Karten-Muster: eine Karte je Connector
  mit **Auth-Status** (OAuth verbunden/abgelaufen, Secret fehlt),
  „Verbindung testen" (probe-API existiert), Environment-Badge (dev/prod).

### Stufe 5: Geführter Erststart (Muster e)

- Leerer Chat zeigt Beispiel-Karten („Was kann diese Installation?",
  „Zeig mir einen Workflow-Lauf") statt leerem Eingabefeld; Katalog-
  Karussell aus `list_workflows` (Kategorien existieren).
- Leere Workflows-Liste: „Ersten Workflow anlegen" führt in den Chat mit
  vorbereitetem Prompt — nicht in ein leeres Formular.

### Bewusst NICHT übernehmen

- Kein Agent-als-Startseite (Konvention §1 gilt: Overview-first).
- Kein Telemetrie-SDK der Referenzarchitektur.
- Keine Abkehr von SubKits RBAC-gebundener Navigation (die Referenz kennt
  keine Scope-Gates in der Nav — SubKits Modell ist hier stärker und
  bleibt).
- Englisch-only der Referenz: SubKit bleibt EN + DE mit Katalog-Parität.

## 4. Reihenfolge & Schnittgrößen

Jede Stufe einzeln shipbar; Stufe 2 zuerst (löst den realen Review-Stau).
Stufe 2 und 4 sind reine Cockpit-Arbeit. Stufe 3 braucht ggf. einen kleinen
Engine-Schnitt (Step-Ergebnis-Preview am Workflow-Detail, falls die
vorhandene Steps-API nicht reicht). Stufe 5 ist reine Cockpit-Arbeit.

## 5. Qualitäts-Gates (SubKit-Repo-Regeln)

`AGENTS.md` gilt: Biome, TS strict ohne `any`, Zod an jeder Grenze,
Conventional Commits, drei Testebenen + `verify:ai`, `bun run verify` als
Release-Gate. **Nach jeder Cockpit-Quelländerung `bun run build:cockpit`
ausführen und `assets/cockpit` + `cockpit-embedded.ts` mitcommitten — der
CI-Check `check:cockpit-drift` schlägt sonst fehl** (Lehre aus dem letzten
Deploy). UI-Vertrag: `apps/cockpit/UI-UX.md`; Familienregeln:
Cockpit-Konvention v1.1 (Kopie im Repo auf v1.1 heben bzw. anlegen).

## 6. Akzeptanzkriterien (bindend, Format s. Übergaben-Index)

**AK-SK-2.1 · Diff-Karte in der Konversation**
Gegeben: eine Konversation, in der ein Patch-Kandidat vorgeschlagen wurde.
Wenn: die Konversation geöffnet wird.
Dann: Diff-Karte mit Ziel (Workflow · Version, nie UUID), Zeilen-Diff
alt/neu und Dry-Run-Ergebnis daneben; Aktionen „Einspielen / Ablehnen"
direkt in der Karte.
Prüfweg: E2E (`chat-patch-card-*`).

**AK-SK-2.2 · Entscheidung ohne Seitenwechsel, mit Audit**
Gegeben: die Karte aus 2.1 mit erfolgreichem Dry-Run.
Wenn: „Einspielen" bestätigt.
Dann: Decide-API wird gerufen, Karte zeigt den Erledigt-Zustand, Audit
enthält den Eintrag; „Einspielen" ist ohne vorliegendes Dry-Run-Ergebnis
inaktiv mit Begründung.
Prüfweg: E2E + Audit-API-Assert.

**AK-SK-2.3 · Queue gegen den Review-Stau**
Gegeben: 27 offene Patch-Kandidaten, ältester 18 Tage (Fixture).
Wenn: `/decisions` geöffnet.
Dann: alle 27 mit Alter; ältere als 3 Tage unter „Liegt schon länger";
Nav-Zähler zeigt die deduplizierte Gesamtzahl und steht auf danger.
Prüfweg: Unit (Aging/Dedupe) + E2E.

**AK-SK-3.1 · Schritt-Galerie**
Gegeben: ein Workflow mit 4 Schritten und einem letzten Lauf.
Wenn: Workflow-Detail geöffnet.
Dann: je Schritt eine Karte mit Konfiguration links und `result_preview`
des letzten Laufs rechts; Schritte in Ausführungsreihenfolge.
Prüfweg: E2E.

**AK-SK-3.2 · Testlauf in place**
Gegeben: die Galerie aus 3.1.
Wenn: „Testlauf" an einem Einzelschritt.
Dann: Step-Run (source=step) startet, Ergebnis erscheint in der Karte ohne
Navigation; Fehler zeigen die Ursache in der Karte.
Prüfweg: E2E.

**AK-SK-4.1 · Kategorie-Chips (§10)**
Gegeben: 82 Workflows mit `category`-Werten.
Dann: Chip-Zeile aus den Daten (nie hartkodiert), „Alle" als einziger
fester Chip; Filter wirkt; Inline-Umkategorisieren pro Zeile; gefilterte
Leere nennt den Filter und bietet „Alle anzeigen".
Prüfweg: E2E.

**AK-SK-4.2 · Connector-Karte (§11)**
Gegeben: ein Connector mit abgelaufenem OAuth.
Dann: Karte zeigt Auth-Zustand als Wort + Badge („abgelaufen" mit Weg zur
Erneuerung), Umgebungs-Badge (dev/prod), Fähigkeitsliste mit Risikostufe
(„schreibt" nie als Kleingedrucktes); „Verbindung testen" zeigt das
Probe-Ergebnis in place.
Prüfweg: E2E.

**AK-SK-5.1 · Leere führt zur Handlung (§4)**
Gegeben: (a) leerer Chat, (b) leere Workflows-Liste.
Dann: (a) Beispiel-Karten statt leerem Eingabefeld, (b) „Ersten Workflow
anlegen" führt in den Chat mit vorbereitetem Prompt — nie in ein leeres
Formular.
Prüfweg: E2E.

**AK-SK-G.1 · Gates**
Dann: EN/DE-Katalog-Parität; Testids ohne UUIDs; `bun run verify` grün;
**Cockpit-Bundle regeneriert und mitcommittet** (`check:cockpit-drift`
grün); Konventions-Kopie v1.4 im Repo.
Prüfweg: CI-Gate.
