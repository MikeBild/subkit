---
slug: use-sk-from-a-coding-agent
summary: Gib einem Coding-Agent sk-Tools und Briefings aus dem gemeinsamen Gedächtnis für dein Repository.
section: work
order: 3
audience: public
---
## sk aus einem Coding-Agent verwenden

```bash
claude mcp add --transport http --scope user sk http://localhost:3000/mcp --header "Authorization: Bearer ${SK_API_KEY}"
codex mcp add sk --url http://localhost:3000/mcp --bearer-token-env-var SK_API_KEY
sk agent init --domains <category>   # in a repository: briefs each Claude Code and Codex session on that domain
```

Nutze MCP für freigegebene sk-Tools; führe `sk agent init` aus, um Repository-Domänen zu deklarieren und die Hooks für Claude Code und Codex zu installieren, die Briefings aus dem gemeinsamen Gedächtnis liefern. Hooks können einen aktuellen Ordnernamen auf bekannte Domänen abbilden, wenn keine ausdrückliche Deklaration existiert. Beide verwenden dasselbe authentifizierte sk-Profil wie die CLI.

### Briefings einrichten und verifizieren

Die MCP-Registrierung ist eine einmalige Einrichtung pro Rechner. Führe in jedem Repository `sk agent init --domains <category>[,<category>]` aus und committe `.sk/agent.json`, damit jeder Checkout dieselben Domänen verwendet. Eine Domäne kann eine Katalogkategorie oder ein Tag `domain:<slug>` sein. `init` führt die angeforderten Domänen zusammen, ohne bestehende Domänen oder Einstellungen zu entfernen, und verdrahtet die Hooks SessionStart, UserPromptSubmit und SessionEnd für Claude Code und Codex. Die Transkripterfassung von Codex läuft asynchron, um in sein Hook-Limit von drei Sekunden zu passen. Beide Clients und die sk-REPL teilen sich ein Briefing-Budget von 1.800 Token und eine harte Grenze von 9.500 Zeichen. `--skip-claude` und `--skip-codex` lassen die Einstellungen des jeweiligen Clients unberührt.

Führe `sk status` und dann `sk agent briefing --json` im Repository aus, um Deklaration, Zugangsdaten, Engine-Verbindung und das zurückgegebene Briefing zu verifizieren. Nutze die JSON-Felder `domains`, `knowledge_sources`, `skills_full` und `used_tokens`, um das Ergebnis zu prüfen. Leere `knowledge_sources` oder `skills_full` bedeuten, dass das Briefing funktioniert, diese Einträge aber der deklarierten Domäne nicht zugeordnet sind. Lege Wissen und Skills in der Katalogkategorie der Domäne ab oder versieh sie mit dem Tag `domain:<slug>`.

Hooks lesen zuerst `.sk/agent.json`, sofern vorhanden. Andernfalls gleichen sie den normalisierten Namen des aktuellen Ordners exakt mit lesbaren Projektkategorien ab. Ein eindeutiger Treffer legt `.sk/agent.json` mit diesem Projektbereich und, wenn verfügbar, gemeinsamem SubKit-Kontext an. Passt kein eindeutiger Projektbereich, ist aber gemeinsamer SubKit-Kontext verfügbar, legt der Hook eine reine Shared-Deklaration an und fragt, welche Projekt-Knowledge-Sources und Workflows dort hingehören, wenn das Setup relevant ist. Ist keines von beiden verfügbar, fragt er nach, bevor er rät oder eine Deklaration anlegt. Vom Hook angelegte Deklarationen bleiben als abgeleitet markiert, sodass spätere Sitzungen den Ordnernamen weiter prüfen, während sich der lesbare Katalog ändert. Behandle `inferred` und `inferred_folder_domain` als vom Hook verwaltete Felder. Um eine abgeleitete Deklaration explizit zu machen und selbst zu pflegen, entferne beide Felder und bearbeite `domains`; ältere abgeleitete Deklarationen werden migriert, indem die erste Domäne außer `subkit` als abgeleitete Ordnerdomäne behandelt wird. Ein Prompt kann weitere passende Domänen hinzufügen, wenn sich die Aufgabe ändert. Das funktioniert mit oder ohne Git-Metadaten. Das Briefing sagt dem Agent, welche Deklaration er angelegt hat. Jedes erfolgreiche Briefing gibt dem Modell begrenzten Domänenkontext und zeigt einen kurzen, sprachneutralen Status; zu großer Kontext wird mit sichtbarer Warnung gekürzt. Das Modell kann relevante Prüfungen in der Sprache deiner Unterhaltung anbieten. Das Briefing zählt nur gesammelte Clips und Sitzungserkenntnisse in den Kategorien des Projekts und enthält nie deren Inhalt. Ist das Briefing nicht verfügbar, zeigt der Client eine einfache Warnung und setzt die Sitzung fort. Nutze `/hooks` in Claude Code oder Codex, um zu sehen, ob Hooks aktiv sind. Codex-Hooks sind standardmäßig aktiviert; normalerweise ist keine Änderung an `config.toml` nötig. Prüfe neue oder geänderte SubKit-Hooks in `/hooks` und vertraue ihnen. Sind Hooks deaktiviert, prüfe die wirksame Feature-Einstellung und die Administratorrichtlinie, bevor du Einstellungen änderst; siehe den [offiziellen Codex-Hook-Leitfaden](https://learn.chatgpt.com/docs/hooks). Beide Clients senden bei SessionEnd ein Transkript. Die Codex-Erfassung läuft in einem abgekoppelten Prozess, weil seine Hook-Frist drei Sekunden beträgt. Die Engine behält nur Praktiken und Fakten, die eine Person gelehrt oder bestätigt hat, verwirft Ereignisse, Statusmeldungen und alles, was mit Zugangsdaten zu tun hat, und sammelt den Rest in Intake mit Herkunft `session`, in der gemeinsamen Kategorie des Projekts oder in deiner Standardkategorie. Dieselbe Erkenntnis aus einer späteren Sitzung ergänzt den bestehenden Eintrag um Belege, statt ein Duplikat anzulegen. Gesammelte Erkenntnisse sind weder Wissen noch Skills, bis eine Person im Cockpit einen Vorschlag bestätigt; `sk intake list` zeigt, was wartet.

Bei offenen Check-ins nutzt das Briefing die passende Domäne des aktuellen Projekts zusammen mit gemeinsamem SubKit-Kontext sowie verbundene Quellen, die die Frage am besten beantworten. Es unterscheidet den Live-Zustand von Diensten von Repository-Änderungen und statischem Wissen, priorisiert blockierte oder fehlschlagende Arbeit und anstehende Fristen und nennt bis zu drei konkrete nächste Schritte in der Sprache des Benutzers. Wartungsvorschläge müssen in Repository-Anweisungen, ausdrücklichen Plänen oder TODOs und beobachteten Problemen wie fehlschlagenden Prüfungen oder Abweichungen bei generierten Dateien begründet sein. Relevante Knowledge Sources und Workflows aus der Domäne des Ordners werden namentlich empfohlen, wenn sie bei einer konkreten Aufgabe helfen. Es meldet, wenn eine relevante Quelle nicht verfügbar ist.

### Gesammeltes Material mit deinem Coding-Agent prüfen

Gesammelte Seiten bleiben Material, das geprüft werden muss. Mit `intake:read` ergänzt das Briefing
eine kurze mandantenweite Zählung gesammelter Einträge und offener Wissensvorschläge.
Es lädt deren Text nicht, behandelt ihn nicht als Anweisung und behauptet nicht, dass er zur
Domäne des Repositorys gehört. Ohne diese Berechtigung entfällt der Hinweis.

Frag: „Sieh die neuen Einträge in Research durch. Welche sind nützlich? Schlage vor, was wir
als Wissen behalten sollten.“ Die Prüfung nutzt eine gespeicherte SubKit-Konversation. MCP-Clients starten
sie über `conversation_start`; `intake_item_ids` wählt bestimmte Clips aus und
hält diese Auswahl fest. Der zurückgegebene Cockpit-Link setzt dieselbe Prüfung fort.
Werkzeuge zum Lesen von Einträgen und zu Vorschlägen benötigen diese gespeicherte Konversation und können nicht als
eigenständige MCP-Aufrufe laufen. Der API-Schlüssel des Clippers braucht nur Intake-Lese-/Schreibrechte;
die Person, die einen Vorschlag bestätigt, benötigt `intake:confirm` und `knowledge:write`.

Im Terminal zeigt `sk intake list` gesammelte Einträge in deiner Standardkategorie. Nutze
`sk intake list --category research`, um gesammelte Einträge zu sehen, und
`sk intake review --category research`, um deren Prüfung zu starten. Ohne
Auswahl nutzt die Prüfung deine Standardkategorie. `--items <comma-separated-ids>`
wählt bestimmte Einträge aus; `--json` liefert maschinenlesbare Ergebnisse. Der Befehl
gibt den Cockpit-Link aus, um die Konversation fortzusetzen und Vorschläge zu prüfen.
Nutze `sk intake default --category research`, um deine persönliche Standardkategorie zu ändern,
`sk intake move --item <id> --category research`, um einen Eintrag zu ordnen, und
`sk intake discard --item <id>` oder `sk intake restore --item <id>`, um seinen
Prüfstatus zu ändern. Diese Aktionen erhalten den Original-Clip und nehmen nie Wissen auf.

Der Vorschlag zeigt seine Quellen, den genauen Text und das Wissensziel. Ein bestehendes
Ziel behält seine Themenzuordnung. Nimm bei einem neuen Ziel die Themenkategorie
oder das Tag `domain:<slug>` in den geprüften Vorschlag auf, damit das entstehende Wissen
im vorgesehenen Repository-Briefing erscheinen kann. Das Ändern dieser Zuordnung erfordert
die Prüfung des geänderten Vorschlags. Führe nach der Bestätigung `sk agent briefing --json` aus,
um `knowledge_sources` zu prüfen, und suche dann nach dem übernommenen Material. Der Original-Clip
bleibt verknüpft. Eine neue Sitzung lädt das aktualisierte Briefing.

### Eine installierte Intake-API verifizieren

Während der Intake-Entwicklung führt `bun run verify:intake` die fokussierten Prüfungen für Typen,
Domäne, HTTP, Briefing, MCP und CLI aus, einschließlich eines echten lokalen
PostgreSQL/API-Smoke-Ablaufs. Es vermeidet die Test-Suite des gesamten Repositorys. Nutze browser-use
mit Codex oder Claude Code für Browser-Abläufe; die visuelle Abnahme erfolgt manuell.

`bun run verify:intake-live` prüft einen gewählten Server über seine öffentliche API.
Setze `SK_ENGINE_URL` und `SK_INTAKE_TEST_KEY` außerhalb des Repositorys. Der Standardlauf
ist schreibgeschützt und meldet Kompatibilität, Bereitschaft und das ausgelieferte Archiv.
Er ist vom lokalen Gate `bun run verify` getrennt.

Nutze für eine synthetische Schreibprüfung einen eigenen Testmandanten und dessen Benutzerschlüssel:
füge `--allow-writes --test-tenant-id <uuid> --run-id <unique-run-name>
--json <report-path>` hinzu. Der Mandant muss zur authentifizierten Identität passen. Die
Prüfung sammelt in einer eigenen Kategorie, testet den Ausschluss vor der Bestätigung und den
genauen Vorschlag und verifiziert, dass der API-Schlüssel ihn nicht bestätigen kann. Der Wert
`handoff.review_url` des Berichts öffnet den Vorschlag im Cockpit, wo eine Person dieses
Mandanten ihn bestätigt. Führe dann denselben Befehl mit `--after-confirm --proposal-id <id>` aus,
um die einmalige Aufnahme, die Herkunft, die Suche und das Domänen-Briefing zu prüfen.
Er meldet Zeiten und behaltene Ressourcen-IDs. Intake hat keine Lösch-API, daher
bleiben Testdatensätze zur Prüfung erhalten. Diese API-Prüfung misst weder das Urteil des Modells
noch ersetzt sie eine echte Browser-/Chat-Verifikation. Sie deployt nie Code.
