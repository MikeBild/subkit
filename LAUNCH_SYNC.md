# SubKit Launch: gemeinsamer Arbeitsvertrag

[LAUNCH.md](LAUNCH.md) enthält den freigegebenen Plan, [LAUNCH_STATUS.md](LAUNCH_STATUS.md)
den belegten Fortschritt. [AGENTS.md](AGENTS.md) und nähere Guides bleiben maßgeblich.
Diese Dateien bleiben die Informationsbasis für die bestehenden L-Aufgaben.
Cloud-Zielbild und zusätzliche Produktaufgaben führen
[docs/PRODUCT-ROADMAP.md](docs/PRODUCT-ROADMAP.md) und [docs/TODO.md](docs/TODO.md).
Website-Arbeit bleibt in WEBSITE-TODO.md, ihr Briefing und Setup unter docs/.
Dies ist keine neue Synchronisationsplattform.

## Rollen und Quellen

| Rolle/System | Verantwortung |
| --- | --- |
| GitHub main | Gemeinsamer freigegebener Code-, Plan-, Aufgaben- und Nachweisstand |
| GitHub Issues und SubKit Product Project | Operative Aufgaben, Priorität, Status und getrennte Ansichten für Self-hosted Beta, GA und Hosted Beta |
| Codex | Tatsächlichen Checkout prüfen, vereinbarte Aufgaben umsetzen, testen, Status lokal aktualisieren |
| ChatGPT Daily | Tagesprioritäten, Countdown, Risiken und ausführbaren Arbeitsauftrag aus aktuellem main ableiten |
| ChatGPT Weekly | Wochenmeilensteine, kritischen Pfad und Terminprognose bewerten |
| SubKit Knowledge/MCP | Ergänzendes bestätigtes Architektur-, Produkt- und Domänenwissen; Skills und technische Hintergründe |
| Nutzer | Produktentscheidungen, Prioritätskonflikte, Recht/Sichtabnahme und Freigaben für Commit, Push und Veröffentlichung |

ChatGPT-Konversationen und Codex-Sessions haben nicht automatisch denselben Gesprächsverlauf.
Ein MCP-Eintrag gibt keinen pauschalen Zugriff auf alle ChatGPT-Chats. SubKit Knowledge ist
kein Nachweis eines Releases. Lokale Änderungen sind für GitHub-basierte Briefings erst
nach einem freigegebenen Push sichtbar. Keine unbelegte automatische Synchronisierung behaupten.

### Drei Wege der Kontextübergabe

1. **Repository, bevorzugt:** dauerhafte Entscheidungen und Status einmal in der jeweils zuständigen Datei pflegen.
2. **Manuell:** neue ChatGPT-Entscheidungen als Prompt/Markdown an Codex übergeben und nach
   Abgleich übernehmen. Chatlinks nur verwenden, wenn tatsächlich zugänglich; vertrauliche
   Inhalte nicht ungeprüft über öffentliche Links teilen.
3. **SubKit MCP:** ergänzende bestätigte Quellen im passenden Domain-Kontext. Kein automatischer
   Import ganzer Chatverläufe, keine ungeprüfte Übernahme von Clipbodies oder Learning-Kandidaten.

## Status- und Evidenzvertrag

Zulässige Aufgabenstatus: `TODO`, `IN_PROGRESS`, `BLOCKED`, `UNVERIFIED`, `DONE`.
`UNVERIFIED` bedeutet, dass behauptete/vorhandene Umsetzung noch nicht ausreichend belegt ist.
`BLOCKED` benennt eine konkrete fehlende Voraussetzung und den nächsten Entblockungsschritt.
`DONE` setzt die vollständige DoD aus LAUNCH.md und einen passenden Nachweis voraus.

Lokal fertig, technisch getestet, releasefähig, öffentliche Beta, Store-eingereicht,
Google-freigegeben und vollständig öffentlich sind getrennte Zustände. Ein GitHub-Gatestatus
ist kein öffentliches Deployment. Ein erfolgreicher Test mit Mock ist kein Live-Nachweis.

Pro Nachweis erfassen: ID, Task-ID, Quellcommit/Artefaktversion, Prüfmethode/Befehl, Datum,
Toolchain/Umgebungsklasse, Ergebnis und numerischen Exit soweit vorhanden, Einschränkungen
und sicheren Verweis. Rohlogs dürfen privat bleiben; die bereinigte Zusammenfassung muss
für ChatGPT verständlich sein. Private Logpfade allein sind kein gemeinsamer Nachweis.

Nach jeder erledigten Aufgabe Status, Evidenz und nächste drei Aufgaben aktualisieren.
LAUNCH_STATUS.md bleibt die kompakte aktuelle Übersicht. Vollständige bereinigte
Prüfnachweise mit stabilen E-IDs stehen in [LAUNCH_EVIDENCE.md](LAUNCH_EVIDENCE.md);
das Archiv enthält keine zweite aktuelle Aufgabenliste. Historische Einträge erhalten,
neue Ergebnisse ergänzen und die betroffene Statuszeile auf den neuesten Nachweis beziehen.
Nicht gepushte Ergebnisse mit `LOCAL_ONLY` kennzeichnen. Das ist ein Synchronisationsmerkmal,
kein sechster Aufgabenstatus. Eine nachgewiesene lokale Aufgabe kann DONE und LOCAL_ONLY sein.
Beim nächsten lesenden Refresh tatsächlichen Remote-Commit prüfen, statt allein eine alte
Synchronisationsbehauptung zu übernehmen. Keine selbstreferenzielle Commit-ID voraussetzen:
Datei nennt den geprüften Produktcommit; der lesende Client protokolliert den gelesenen main-Commit.

Gültige Ergebnisse wiederverwenden. Bei Source-/Runtimeänderung Geltungsbereich neu prüfen;
alte Ergebnisse nicht löschen oder als frisch ausgeben. Neue Nutzerentscheidungen mit Datum,
Umfang und betroffenen Tasks dokumentieren. LAUNCH.md enthält Plan/DoD;
GitHub Issues und das Project führen den operativen Status. LAUNCH_STATUS.md
und docs/TODO.md bewahren datierte Nachweise und fachliche Grenzen. Status
und Evidenz beim Abschluss miteinander abgleichen, keine zweite vollständige
operative Aufgabenliste pflegen.

Keine Secrets, Produktionshosts, privaten Deploymentkennungen oder personenbezogenen
Entwurfsangaben speichern. Berichte enthalten nur notwendige bereinigte Daten.

## Standardablauf für Codex

### Start

1. Branch und Git-Status prüfen, vorhandene Arbeiten erhalten.
2. AGENTS.md, LAUNCH.md, LAUNCH_STATUS.md und LAUNCH_SYNC.md lesen.
3. Daily-/Weekly-Auftrag gegen aktuellen Checkout und Nachweise abgleichen.
4. DONE-Aufgaben überspringen; offene P0 des kritischen Pfads priorisieren.
5. Bei externem Blocker nächste ausführbare Launchaufgabe wählen, Blocker nicht verbergen.
6. Vor Implementierung nach AGENTS.md synchronisieren; schmutzige Arbeitsstände vorher
   sicher erhalten und nachher wiederherstellen, keine fremden Änderungen verwerfen.

### Umsetzung und Übergabe

Betroffenen Code/Guide lesen, kleinste sinnvolle Änderung umsetzen, gezielt prüfen,
Regressionen bewerten und DoD kontrollieren. Fehlende Nachweise explizit belassen.
LAUNCH_STATUS.md lokal aktualisieren, Diff/Nachweise und nächsten Schritt vorlegen.
Commit/Push nur nach Nutzerfreigabe; normale Hooks verwenden. Die fortlaufende Freigabe
für autonome Launch-Arbeit einschließlich Commit/Push vom 17.10.2026 ist in LAUNCH.md
dokumentiert und muss nicht pro Paket erneut eingeholt werden. Danach Remote-Stand prüfen.
Veröffentlichung, Deployment und Store-Einreichung benötigen ihre eigenen Freigaben.
Eine Freigabe für Dateierstellung ist keine Freigabe für diese weiteren Wirkungen.

### Mehrere Sessions, Konflikte und Wiederaufnahme

- Nur eine schreibende Hauptsession im gemeinsamen Checkout; andere Sessions arbeiten lesend
  oder an ausdrücklich getrennten, koordinierten Bereichen. Kein paralleles Bearbeiten der Tracker.
- IN_PROGRESS dokumentiert Session/Verantwortlichen, Basiscommit, betroffene Bereiche und
  letzten sicheren Zwischenstand. Keine Übernahme aktiver Arbeit ohne Übergabe.
- Bei Unterbrechung Git-Status, vorhandene Artefakte und Testprozesse prüfen, bevor neu gestartet wird.
  Abgebrochener Test ist kein PASS. Keine fremden Prozesse oder Testdaten pauschal entfernen.
- Technische Widersprüche anhand Source und Tests klären, Konflikt und Auflösung dokumentieren.
  Produkt-/Prioritätskonflikte entscheidet der Nutzer. Keine Last-write-wins-Statusüberschreibung.
- Bei Remote-Konflikten Arbeit sichern; kein Reset, Force-Push oder Umgehen der Fast-forward-Regel.

## Daily und Weekly

Für SubKit und Harmoniqs bestehen je ein Daily- und ein Weekly-Briefing. Am
19.10.2026 wurden die vier Aufgaben und ihre Zeitpläne im ChatGPT-Client geprüft;
die alten chatgebundenen Duplikate wurden pausiert. Die zwei privaten,
rein lesenden GitHub-Workflows sind aktiv und haben je einen erfolgreichen
Daily- und Weekly-PROD-Lauf über autorisierte Browser-Sitzungen. ChatGPT kann
die sensiblen Ergebnisse aktuell nicht zuverlässig direkt dispatchen
(`sensitive_execution_unsupported`); die Aufgaben benennen diese Grenze und
verwenden dann autorisierte GitHub-GET-Abfragen. Das ist kein Nachweis einer
vollständigen Workflow-zu-ChatGPT-Datenübergabe oder eines neuen geplanten Laufs
nach der Prompt-Aktualisierung; [Issue B01](https://github.com/MikeBild/subkit/issues/410)
führt die Lücke. Keine weiteren redundanten Automationen erstellen.

### Daily: täglich 06:00 Europe/Berlin

Liest GitHub main, [Issues](https://github.com/MikeBild/subkit/issues),
[Project](https://github.com/users/MikeBild/projects/4), Milestones und die
zuständigen Launch-/Hosted-/Website-Dateien. Liefert:

1. Launch-Lage und gelesenen Commit/Prüfzeitpunkt.
2. Kalendertage bis Beta und GA, bezogen auf Europe/Berlin.
3. Belegten Fortschritt seit dem vorherigen geprüften Stand.
4. Drei priorisierte Tasks mit IDs, konkretem Ergebnis, Abhängigkeiten und DoD.
5. Dominanten nächsten Arbeitsschritt und vollständigen ausführbaren Codex-Prompt.
6. Größtes Risiko und notwendige Nutzerentscheidung.

Daily zahlt auf Wochenmeilensteine ein. Keine neuen Features/Refactorings ohne Launch-Blocker,
keine wiederholten DONE-Aufgaben, keine Billing-Analyse. Wenn GitHub nicht lesbar ist:
UNVERIFIED, letzten bekannten Stand nennen, keine neuen Fortschritte erfinden.

### Weekly: montags ungefähr 08:00 Europe/Berlin

Liest denselben Stand und liefert Gesamtstatus, belegten Wochenfortschritt, unerledigte Issues,
drei bis fünf Wochenmeilensteine mit DoD, kritischen Pfad, Terminprognose, drei Risiken,
menschliche Entscheidungen und nächsten ausführbaren Codex-Prompt. Strategische Priorisierung
vorschlagen; verbindliche Scopeänderungen entscheidet der Nutzer. Bestätigte Änderungen werden
anschließend in LAUNCH.md übernommen. Daily bleibt operativ, Weekly strategisch.

Für beide Zeitzone Europe/Berlin verwenden, keinen festen UTC-Offset: die Zeitumstellung liegt
im Launchzeitraum. Countdown bei jeder Aktualisierung berechnen, nicht unverändert kopieren.

### End-to-End-Synchronisationsnachweis

Nach Nutzerreview und freigegebenem Commit/Push die Remote-Verfügbarkeit der drei Dateien
prüfen. Im nächsten tatsächlich ausgeführten Daily und Weekly kontrollieren: richtige Dateien,
beobachteter main-Commit, keine Wiederholung erledigter Tasks, korrekte nächste Aufgabe.
Bis dahin bleibt die Automation UNVERIFIED. Kein Testeintrag in produktivem Knowledge nötig.

### Kopierbarer Daily-Arbeitsauftrag

```text
Arbeite im Repository MikeBild/subkit. Prüfe zuerst Branch und Git-Status;
erhalte vorhandene Änderungen. Lies AGENTS.md, README.md, LAUNCH.md,
LAUNCH_STATUS.md, LAUNCH_SYNC.md und docs/roadmap-issues.json. Prüfe
GitHub Issues, das SubKit Product Project und Milestones als operative
Aufgabenquelle. Der aktuelle Checkout hat Vorrang vor diesem Briefing.

Briefing-Basis: <gelesener GitHub-Commit und Prüfzeit>
Tagesziel: <Meilenstein>
Aufgaben: <bis zu drei offene Issue-Links mit Ergebnis und DoD>
Dominanter nächster Schritt: <konkrete Aktion>

Überspringe nachweislich erledigte Aufgaben. Prüfe vor Implementierungen
die Synchronisationsregel aus AGENTS.md. Setze den vereinbarten Umfang um,
führe passende Tests aus und aktualisiere das betroffene Issue sowie
LAUNCH_STATUS.md mit Nachweisen, Grenzen und nächsten Schritten.

Keine Features ohne unmittelbaren Launch-Nutzen. Beachte die bestehenden
Freigaben für normale geprüfte Commits und Pushes; Tags, Releases,
Deployments, globale Konfigurationsänderungen und Store-Einreichungen
bleiben gesondert freizugeben.
Am Ende: Ergebnis, Tests, verbleibende Blocker und nächster Schritt.
```

Für eine neue Session denselben Auftrag mit einem einzelnen aktuellen Task verwenden.
Das Wiederlesen der Dateien ersetzt die manuelle Übertragung des ganzen Gesprächs.

## SubKit-Briefings und MCP: Implementierung und Einrichtung

Quellen: [README](README.md#use-sk-from-a-coding-agent),
[Agent-Befehle](apps/sk/src/commands/agent.ts),
[Hook-Konfiguration](apps/sk/src/commands/agent-hook-config.ts),
[Briefing-Route](apps/engine/src/http/routes/agent-briefing.ts),
[Session-Route](apps/engine/src/http/routes/agent-sessions.ts).

### Was bereits implementiert ist

- `sk agent init --domains subkit` ergänzt die Repository-Deklaration `.sk/agent.json`,
  erhält vorhandene Domains/Settings und installiert globale Hooks für beide Clients.
- Claude: `~/.claude/settings.json`; Codex: `~/.codex/hooks.json`.
  `--skip-claude` beziehungsweise `--skip-codex` lässt den betreffenden Client unverändert.
- SessionStart und UserPromptSubmit rufen `sk agent briefing --hook` auf. Sie nutzen das
  authentifizierte sk-Profil, Domänen und berechtigte Quellen; Warnungen blockieren die Session nicht.
- `sk agent briefing` liefert lesbare Ausgabe; `--json` enthält unter anderem `domains`,
  `knowledge_sources`, `skills_full` und `used_tokens`.
- Knowledge/Skills werden über passende Kategorie oder `domain:<slug>` zugeordnet.
  Leere Quellenlisten können fehlende Zuordnung bedeuten, nicht zwingend Verbindungsfehler.
- Hook-Kontext ist zusätzlich zum konfigurierten Budget auf 1800 Tokens und 9500 Zeichen begrenzt.
  Die vorhandene lokale Deklaration mit Budget 4000 erhöht nicht diese Hook-Obergrenze.
- Briefing/Domain-Routen erfordern Authentifizierung und `skill:read`; weitere Inhalte werden
  nach ihren Berechtigungen gefiltert. Capture erfordert `skill:propose`.
- SessionEnd nutzt `sk agent capture --hook`; Codex zusätzlich `--agent codex --detach`.
  Ein abgetrennter SubKit-Prozess verarbeitet den Capture innerhalb der Client-Lifecycle-Grenze.
  Das ist nicht gleichbedeutend mit einem asynchronen Codex-SessionEnd-Hook.
- MCP-Registrierung, sk-Profil und Hooks sind getrennte Einrichtungen.

### Datenfluss vor globaler Aktivierung freigeben

UserPromptSubmit kann Prompttext zur Domain-Auflösung an die Engine senden. SessionEnd liest
das lokale Transkript und überträgt begrenzten Text sowie Session-/Repository-/Domain-Metadaten
zur Engine. Die Learning-Analyse verwendet einen konfigurierten Modellanbieter. Extrahierte
Learnings werden als Intake-Sammelgut mit Origin `session` in der passenden gemeinsamen
Projektkategorie oder der Standardkategorie gesammelt. Erst eine Person bestätigt einen
Vorschlag im Cockpit als Wissen oder Skill; Sammelgut ist kein bestätigter Releasefortschritt.

Die CLI begrenzt das Transkript vor der Übertragung. Die Engine wendet vor dem
Einreihen des Analysejobs `scrubString` an; die dokumentierte Sammlung schließt
Statusereignisse und credential-bezogene Learnings aus. Das ist keine Garantie,
dass beliebige Geheimnisse vollständig erkannt werden; die serverseitige Bereinigung
verhindert auch nicht die vorherige Übertragung an die Engine. Globale Hooks gelten auch in anderen Repositories und können dort
Domänen inferieren. Deshalb vor Aktivierung Auswirkungen, Empfänger, Retention und erlaubte
Repository-Inhalte prüfen. Keine produktiven Transkripte als Einrichtungsprobe übertragen.
Bis zur Freigabe manuelles Briefing verwenden. Kein neuer Capture-Opt-out-Schalter wird behauptet.

### Einrichtungsschritte für L25

1. Geprüfte sk-Version installieren; PATH im tatsächlichen Codex-/Claude-Prozess kontrollieren.
2. Vorhandenes authentifiziertes sk-Profil sicher konfigurieren. Keine Schlüssel erzeugen oder
   in Prompts/Reports ausgeben. MCP-OAuth allein authentifiziert nicht das sk-Profil.
3. Im Repository zunächst `sk status` und `sk agent briefing --json` ausführen. Nur bereinigte
   Metadaten berichten; vollständige vertrauliche Briefinginhalte nicht in Launchdateien speichern.
4. Bestehende `.sk/agent.json` erhalten, Domain-Zuordnung und Leserechte prüfen.
5. Geplante globale Dateidiffs und beschriebenen Datenfluss vorlegen. Erst nach Freigabe
   `sk agent init --domains subkit` ausführen. Keine bestehende Konfiguration überschreiben.
6. In beiden Clients Hook-Aktivität prüfen, gegebenenfalls Vertrauen bestätigen. Mit synthetischer
   Session Start, Prompt und Ende tatsächlich auslösen; Candidate-Verhalten und Fehlerpfade prüfen.
7. Vorhandenen MCP-Eintrag prüfen; nicht zusätzlich einen gleichartigen Server anlegen.
   Für eine neue Umgebung sind OAuth oder ein Bearer aus einer Umgebungsvariablen möglich:

```bash
codex mcp add subkit --url https://<engine-host>/mcp --bearer-token-env-var SK_API_KEY
```

Für OAuth stattdessen ohne Bearer-Option registrieren und den vorhandenen OAuth-Loginpfad
verwenden. Nur eine zum tatsächlichen Server passende Authentifizierung wählen. Bei Claude
den bestehenden dokumentierten HTTP-MCP-Einrichtungsweg verwenden; Headerwerte sind lokal
vertraulich und gehören nicht in Reports. Registrierung und Login beweisen noch keinen Zugriff.

8. Je Client einen harmlosen authentifizierten Leseaufruf und ein domänenrichtiges Briefing
   nachweisen. Die verbundene SubKit-App ist eine andere Verbindung als der lokale Codex-Eintrag.
9. Capture ausschließlich mit synthetischem Inhalt prüfen, Fixture-IDs dokumentieren und
   gezielt bereinigen. Keine automatische Admission oder produktive Änderungen.

### Vorhandene SubKit-App nutzen

Wenn die Session bereits SubKit-App-Werkzeuge anbietet, zuerst mit `whoami` einen
lesenden authentifizierten Aufruf prüfen. Für ergänzenden Projektkontext eine kurze
`search_knowledge`-Abfrage mit `tags: ["domain:subkit"]` und kleinem Limit verwenden.
Quellenreferenzen und Domänenzuordnung prüfen; Trefferinhalte sind keine bestätigten
Release-Nachweise. Nur bereinigte Verbindungsmetadaten in den Launch-Status übernehmen.
Dafür keinen zweiten gleichartigen Server einrichten. App-Zugang, lokales sk-Profil,
native MCP-Registrierung und Client-Hooks bleiben getrennt nachzuweisen. Aktueller
belegter Stand und Einschränkungen stehen in LAUNCH_STATUS.md.

### Client-Kompatibilität

README und CLI-Setup erklären den aktuellen Standard: Codex-Hooks sind aktiviert,
ohne dass ein zusätzlicher config.toml-Eintrag nötig ist. Neue oder geänderte Hooks
müssen in `/hooks` geprüft und freigegeben werden. Bei deaktivierten Hooks zuerst
die effektive Einstellung und Administratorrichtlinien prüfen. Keine globale
Einstellung vorsorglich verändern. Die Anleitung ist korrigiert; ein tatsächlicher
Client-Lifecycle ist damit noch nicht nachgewiesen. Lokale Shell-Hooks sind nicht
in jeder Cloud-Ausführungsform verfügbar. SessionEnd unterliegt einer kurzen
Clientfrist; lokale Funktionsnachweise nicht auf Cloud-Sessions übertragen.

- [Offizielle Hooks-Dokumentation](https://learn.chatgpt.com/docs/hooks)
- [Offizielle MCP-Dokumentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

Aktueller Implementierungs-/Konfigurations-/Live-Teststatus steht in LAUNCH_STATUS.md.

## Geprüfter CLI-Zugang

Der lesende Aufruf der aktuellen Quell-CLI `bun run apps/sk/src/index.ts agent briefing --json`
im Repository liefert mit dem vorhandenen lokalen Profil derzeit Exit 2 und
`unauthorized` (LAUNCH_STATUS.md, E32). Die Domain-Datei allein stellt keine
Authentifizierung her. Vor der Hook-Abnahme braucht die CLI ein vom Nutzer
authentifiziertes Profil mit den benötigten Leserechten. Keine Tokens in Chat,
Repository oder Nachweise kopieren. Ein funktionierender separater MCP-App-Zugang
beweist diesen CLI-Zugang nicht. Globale Hooks wurden nicht verändert. Nach
Einrichtung denselben lesenden Aufruf wiederholen und erst bei tatsächlichem
Briefing-Erfolg den Status aktualisieren.

### Isolierter Integrationsnachweis

E38 in LAUNCH_STATUS.md belegt das aktuelle CLI-Briefing mit expliziten
`SUBKIT_ENGINE_URL`, `SUBKIT_API_KEY` und `SUBKIT_TENANT` einer synthetischen
lokalen Testidentität. Diese Variablen werden nur im Kindprozess gesetzt;
keine Zugangsdaten oder Profile werden in Git gespeichert. Der gemeinsame
Codex-/Claude-Hook-Handler wurde mit SessionStart und UserPromptSubmit gegen
die reale isolierte Engine geprüft. Bestätigte Quellen sind auffindbar; rohe
Clips werden nicht als Kontext ausgegeben. Dies ersetzt weder den tatsächlichen
Hook-Dispatch durch die Agent-Clients noch die Reparatur des bestehenden
Nutzerprofils (E32: unauthorized). Globale Hooks bleiben unverändert.

## Browser-Abnahme

Nutzerentscheidung vom 18.10.2026: Browser-Journeys werden mit browser-use und
Codex oder Claude Code geprüft. Keine Playwright- oder Screenshot-Testprogramme
erstellen, wiederherstellen oder ausführen. API-/Security-/Domänen-/Build-Prüfungen
bleiben automatisiert. Für Browserprüfungen Quellstand, tatsächliche lokale
Installation, Aktionen, Ergebnisse, Modellmodus und Cleanup dokumentieren.
Ein API-PASS ersetzt keine Browser-Abnahme. Historische Playwright-Nachweise
bleiben historische Evidenz; die entfernten Skripte sind kein künftiger Testweg.
