---
slug: use-sk-from-a-coding-agent
summary: Gib Claude Code oder Codex SubKit als Tool und das Wissen deines Teams.
section: work
order: 3
audience: public
---
## SubKit aus einem Coding-Agenten verwenden

Dieses Kapitel ist für Entwicklerinnen und Entwickler, die mit Claude Code, Codex oder Hermes arbeiten.
Du gibst deinem Agenten die SubKit-Tools und für jedes Repository ein Briefing aus dem gemeinsamen Wissen deines Teams.
Danach startet der Agent freigegebene Workflows, kennt die Hausregeln des Projekts und legt Gelerntes zur Prüfung in deine Inbox.

### Warum Coding-Agent und SubKit

Dein Coding-Agent bleibt das Werkzeug für Software: Code lesen, ändern, testen.
Wiederkehrende Geschäftsarbeit braucht mehr als ein Skript, nämlich Rechte, Freigaben, Verlauf, Zeitpläne und sicher verwahrte Zugangsdaten. Das trägt SubKit.
Für den Agenten ist SubKit ein Tool: Er ruft einen freigegebenen Workflow auf, statt selbst Zugangsdaten zu halten.
Jeder Aufruf läuft durch dieselbe Rechteprüfung wie im Cockpit und steht im Verlauf.

Gesammeltes Material folgt immer einem Weg: **sammeln → mit dem Agenten prüfen → im Cockpit bestätigen → Wissen**.

### Was du brauchst

- Die sk-CLI, angemeldet an deiner Engine. In der Cloud nutzt du dafür `sk login --engine-url https://subkit-cloud.mikebild.dev` und **Mit Firmenkonto anmelden**. Das Briefing nutzt dieses angemeldete Profil.
- Die MCP-Adresse deiner Engine, `https://<deine-engine>/mcp`. In SubKit Cloud ist das `https://subkit-cloud.mikebild.dev/mcp`.
- Claude Code, Codex oder Hermes.
- Ein Repository, in dem die Briefings erscheinen sollen.

### Die SubKit-Tools einmal pro Rechner einrichten

1. Öffne im Cockpit **API-Zugang** und erstelle einen Schlüssel.
2. Lege den Schlüssel in `SK_API_KEY` ab.
3. Trage SubKit mit dem passenden Befehl in deinem Client ein.

Claude Code:

```bash
claude mcp add --transport http --scope user sk https://<deine-engine>/mcp --header "Authorization: Bearer ${SK_API_KEY}"
```

Codex:

```bash
codex mcp add sk --url https://<deine-engine>/mcp --bearer-token-env-var SK_API_KEY
```

Ein Schlüssel ohne `mcp:authoring` lässt den Agenten lesen und Workflows starten, aber nichts bauen. Soll er Workflows und Connectors entwerfen, legst du den Schlüssel mit `sk apikeys create --scopes …,mcp:authoring` an.
Ohne Schlüssel anmelden: siehe „KI-Clients per MCP anbinden“.

### Briefings in einem Repository einrichten

1. Lege im Repository die Domänen fest:

   ```bash
   sk agent init --domains <category>
   ```

   Mehrere Domänen trennst du mit Kommas: `--domains <category>[,<category>]`.
   Der Befehl schreibt `.sk/agent.json` und trägt die SubKit-Hooks in `~/.claude/settings.json` und `~/.codex/hooks.json` ein. Hooks anderer Werkzeuge bleiben erhalten.
2. Committe `.sk/agent.json`, damit jeder Checkout dieselben Domänen nutzt.
3. Führe in Claude Code oder Codex `/hooks` aus und prüfe, ob die SubKit-Hooks aktiv sind.
4. Vertraue neuen oder geänderten SubKit-Hooks.

### Hermes von Hand einrichten

Für Hermes richtet `sk agent init` keine Hooks ein. Die Ausgabe des Befehls zeigt die nötigen Angaben unter „Hermes (manual)“.

1. Trage in Hermes einen MCP-Server über streamable HTTP mit der Adresse `https://<deine-engine>/mcp` ein.
2. Gib als Header `Authorization: Bearer ${SK_API_KEY}` mit.
3. Führe zu Beginn einer Sitzung im Repository `sk agent briefing` aus und gib die Ausgabe Hermes als Kontext mit.

### Das Briefing prüfen

1. Führe im Repository `sk status` aus.
2. Führe `sk agent briefing --json` aus.
3. Prüfe die Felder `domains`, `knowledge_sources`, `skills_full` und `used_tokens`.

### Gesammeltes Material mit deinem Coding-Agenten prüfen

Dein Agent kann eine Prüfung gesammelter Einträge starten. Das Ergebnis bestätigst du im Cockpit.

1. Frag deinen Agenten: „Sieh die neuen Einträge in Research durch. Welche sind nützlich? Schlage vor, was wir als Wissen behalten sollten.“
2. Öffne den Cockpit-Link, den der Agent zurückgibt. Er führt zum Tab **Prüfen** des Eintrags.
3. Prüfe Quellen, genauen Text und Wissensziel des Vorschlags.
4. Wähle **Als Quelle bestätigen**.
5. Führe `sk agent briefing --json` aus und prüfe `knowledge_sources`.

Eine neue Sitzung lädt das aktualisierte Briefing.

Gut zu wissen:

- Nur eine angemeldete Person mit `intake:confirm` und `knowledge:write` bestätigt einen Vorschlag. Ein API-Schlüssel, ein MCP-Client oder der Web Clipper tut das nie.
- Das Original des Eintrags bleibt mit dem Wissen verknüpft, das aus ihm entsteht.
- Verschieben, Bearbeiten oder Verwerfen nimmt einen Eintrag nie als Wissen auf.

### Gesammeltes Material im Terminal prüfen

| Befehl | Was er tut |
| --- | --- |
| `sk intake list` | Zeigt gesammelte Einträge in deiner Standardkategorie. |
| `sk intake list --category research` | Zeigt gesammelte Einträge einer Kategorie. |
| `sk intake review --category research` | Startet die Prüfung und gibt den Cockpit-Link aus. |
| `sk intake review --items <comma-separated-ids>` | Prüft nur bestimmte Einträge. |
| `sk intake default --category research` | Ändert deine persönliche Standardkategorie. |
| `sk intake move --item <id> --category research` | Ordnet einen Eintrag einer Kategorie zu. |
| `sk intake discard --item <id>` | Verwirft einen Eintrag. |
| `sk intake restore --item <id>` | Stellt einen verworfenen Eintrag wieder her. |

- Ohne Auswahl nutzt `review` deine Standardkategorie.
- `--json` liefert maschinenlesbare Ergebnisse.
- Diese Aktionen erhalten das Original des Eintrags und nehmen nie Wissen auf.

### So funktionieren Briefings

**Domänen.** Eine Domäne ist eine Katalogkategorie oder ein Tag `domain:<slug>`.

- `sk agent init` ergänzt die angeforderten Domänen und entfernt nichts Bestehendes.
- Ohne `.sk/agent.json` gleichen die Hooks den Ordnernamen mit deinen Projektkategorien ab. Bei einem eindeutigen Treffer legen sie `.sk/agent.json` für dich an. Sonst fragen sie nach, statt zu raten.
- Um die Domänen selbst festzulegen, bearbeite `domains` in `.sk/agent.json` und entferne `inferred` und `inferred_folder_domain`.
- Ein Prompt kann weitere passende Domänen hinzufügen, wenn sich die Aufgabe ändert.

**Hooks.** `init` richtet die Hooks SessionStart, UserPromptSubmit und SessionEnd für Claude Code und Codex ein. `--skip-claude` und `--skip-codex` lassen die Einstellungen des jeweiligen Clients unberührt.

**Umfang.** Ein Briefing hat höchstens 1.800 Token und 9.500 Zeichen, gemeinsam für beide Clients und die interaktive sk-Sitzung.
Was nicht hineinpasst, wird gekürzt, und du siehst eine Warnung.

Ein Briefing enthält:

- Domänenkontext und einen kurzen Status, blockierte Arbeit und Fristen zuerst.
- Bis zu drei konkrete nächste Schritte in deiner Sprache.
- Passende Quellen und Workflows der Ordner-Domäne, namentlich genannt, wenn sie bei einer Aufgabe helfen.
- Die Zahl gesammelter Seiten und Sitzungserkenntnisse, nie deren Inhalt. Mit `intake:read` zusätzlich die Zahl gesammelter Einträge und offener Vorschläge im ganzen Arbeitsbereich.

**Sitzungserkenntnisse.** Am Sitzungsende senden Claude Code und Codex das Transkript an die Engine.

- Die Engine behält nur Praktiken und Fakten, die eine Person gelehrt oder bestätigt hat.
- Sie verwirft Ereignisse, Statusmeldungen und alles, was mit Zugangsdaten zu tun hat.
- Der Rest landet in der Inbox (im Cockpit **Eingang**) mit Herkunft `session`, in der gemeinsamen Kategorie des Projekts oder in deiner Standardkategorie. Eine wiederholte Erkenntnis ergänzt den bestehenden Eintrag um Belege.
- Erkenntnisse sind weder Wissen noch Skills, bis eine Person sie im Cockpit bestätigt. `sk intake list` zeigt, was wartet.

**Prüfungen mit einem Agenten.** Die Prüfung läuft in einer gespeicherten SubKit-Unterhaltung.

- MCP-Clients starten sie mit `conversation_start`. `intake_item_ids` wählt bestimmte Einträge aus und hält die Auswahl fest.
- Tools, die Einträge lesen oder Vorschläge vorbereiten, arbeiten nur in dieser Unterhaltung.
- Nimm bei einem neuen Ziel die Themenkategorie oder das Tag `domain:<slug>` in den Vorschlag auf. Ein geänderter Vorschlag muss erneut geprüft werden.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| `sk agent briefing: no domains …` | Es gibt keine Deklaration. Übergib `--domains` oder führe `sk agent init --domains <category>` aus. |
| `knowledge_sources` oder `skills_full` sind leer | Das Briefing funktioniert, aber nichts ist der Domäne zugeordnet. Lege Wissen und Skills in der Kategorie der Domäne ab oder nutze das Tag `domain:<slug>`. |
| Der Client zeigt eine Warnung zum Briefing | Die Engine ist nicht erreichbar. Die Sitzung läuft weiter. Prüfe mit `sk status` Anmeldung und Verbindung. |
| Keine Briefings in Claude Code oder Codex | Öffne `/hooks`, prüfe, ob die SubKit-Hooks aktiv sind, und vertraue neuen oder geänderten Hooks. |
| `/hooks` in Codex zeigt die SubKit-Hooks als deaktiviert | Codex-Hooks sind standardmäßig aktiv, eine Änderung an `config.toml` ist normalerweise nicht nötig. Prüfe zuerst die wirksame Feature-Einstellung und die Administratorrichtlinie, dann folge dem [Codex-Hook-Leitfaden](https://learn.chatgpt.com/docs/hooks). |
| Der Agent kann nichts entwerfen | Sein Schlüssel hat kein `mcp:authoring`. Lege einen neuen Schlüssel mit diesem Scope an. |
| Der Hinweis auf gesammelte Einträge fehlt | Dir fehlt das Recht `intake:read`. Bitte eine Administratorin oder einen Administrator darum. |
| Ein Vorschlag lässt sich nicht bestätigen | Bestätigen kann nur eine angemeldete Person mit `intake:confirm` und `knowledge:write`, nicht ein API-Schlüssel. Öffne den Cockpit-Link. |
