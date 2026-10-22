---
slug: use-sk-from-a-coding-agent
summary: Gib einem Coding-Agenten SubKit-Tools und Briefings aus dem gemeinsamen Gedächtnis für dein Repository.
section: work
order: 3
audience: public
---
## SubKit aus einem Coding-Agenten verwenden

Mit MCP bekommt dein Coding-Agent die freigegebenen SubKit-Tools.
Mit `sk agent init` bekommt jede Sitzung in Claude Code und Codex ein Briefing aus dem gemeinsamen Gedächtnis für dein Repository.
Gesammeltes Material folgt einem Weg: **sammeln → mit dem Agenten prüfen → im Cockpit bestätigen → Wissen**.

### Was du brauchst

- Die sk-CLI, angemeldet an deiner Engine. In der Cloud nutzt du dafür `sk login --engine-url https://subkit-cloud.mikebild.info` und **Mit Firmenkonto anmelden**. Das Briefing nutzt dieses angemeldete Profil.
- Die MCP-Adresse deiner Engine, `https://<deine-engine>/mcp`. In SubKit Cloud ist das `https://subkit-cloud.mikebild.info/mcp`.
- Claude Code, Codex oder beide.
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

Ohne Schlüssel anmelden: siehe „KI-Clients per MCP anbinden“.

### Briefings in einem Repository einrichten

1. Lege im Repository die Domänen fest:

   ```bash
   sk agent init --domains <category>
   ```

   Mehrere Domänen trennst du mit Kommas: `--domains <category>[,<category>]`.
2. Committe `.sk/agent.json`, damit jeder Checkout dieselben Domänen nutzt.
3. Führe in Claude Code oder Codex `/hooks` aus und prüfe, ob die SubKit-Hooks aktiv sind.
4. Vertraue neuen oder geänderten SubKit-Hooks.

### Das Briefing prüfen

1. Führe im Repository `sk status` aus.
2. Führe `sk agent briefing --json` aus.
3. Prüfe die Felder `domains`, `knowledge_sources`, `skills_full` und `used_tokens`.

### Gesammeltes Material mit deinem Coding-Agenten prüfen

Dein Agent kann eine Prüfung gesammelter Einträge starten. Das Ergebnis bestätigst du im Cockpit.

1. Frag deinen Agenten: „Sieh die neuen Einträge in Research durch. Welche sind nützlich? Schlage vor, was wir als Wissen behalten sollten.“
2. Öffne den Cockpit-Link, den der Agent zurückgibt.
3. Prüfe Quellen, genauen Text und Wissensziel des Vorschlags.
4. Wähle **Als Wissen bestätigen**.
5. Führe `sk agent briefing --json` aus und prüfe `knowledge_sources`.

Eine neue Sitzung lädt das aktualisierte Briefing.

Gut zu wissen:

- Nur eine angemeldete Person mit `intake:confirm` und `knowledge:write` bestätigt einen Vorschlag. Ein API-Schlüssel, ein MCP-Client oder der Web Clipper tut das nie.
- Der Schlüssel des Web Clippers nutzt die Vorlage **Web Clipper** (`intake:read` und `intake:write`).
- Der Original-Clip bleibt mit dem Wissen verknüpft, das aus ihm entsteht.
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
- Diese Aktionen erhalten den Original-Clip und nehmen nie Wissen auf.

### So funktionieren Briefings

**Domänen.** Eine Domäne ist eine Katalogkategorie oder ein Tag `domain:<slug>`.

- `sk agent init` ergänzt die angeforderten Domänen und entfernt nichts Bestehendes.
- Ohne `.sk/agent.json` gleichen die Hooks den Ordnernamen mit deinen Projektkategorien ab. Bei einem eindeutigen Treffer legen sie `.sk/agent.json` für dich an. Sonst fragen sie nach, bevor sie raten.
- Um die Domänen selbst festzulegen, bearbeite `domains` in `.sk/agent.json` und entferne `inferred` und `inferred_folder_domain`.
- Ein Prompt kann weitere passende Domänen hinzufügen, wenn sich die Aufgabe ändert.

**Hooks.** `init` richtet die Hooks SessionStart, UserPromptSubmit und SessionEnd für Claude Code und Codex ein. `--skip-claude` und `--skip-codex` lassen die Einstellungen des jeweiligen Clients unberührt.

**Inhalt.** Budget: 1.800 Token, höchstens 9.500 Zeichen, gemeinsam für beide Clients und die sk-REPL.
Zu großer Kontext wird mit sichtbarer Warnung gekürzt.

Ein Briefing enthält:

- Domänenkontext und einen kurzen Status, blockierte Arbeit und Fristen zuerst.
- Bis zu drei konkrete nächste Schritte in deiner Sprache.
- Relevante Wissensquellen und Workflows der Ordner-Domäne, namentlich genannt, wenn sie bei einer Aufgabe helfen.
- Eine Zählung gesammelter Clips und Sitzungserkenntnisse, nie deren Inhalt. Mit `intake:read` zusätzlich eine Zählung gesammelter Einträge und offener Vorschläge im ganzen Arbeitsbereich.

**Sitzungserkenntnisse.** Am Sitzungsende senden beide Clients das Transkript.

- Die Engine behält nur Praktiken und Fakten, die eine Person gelehrt oder bestätigt hat.
- Die Engine verwirft Ereignisse, Statusmeldungen und alles, was mit Zugangsdaten zu tun hat.
- Der Rest landet im Eingang mit Herkunft `session`, in der gemeinsamen Kategorie des Projekts oder in deiner Standardkategorie. Eine wiederholte Erkenntnis ergänzt den bestehenden Eintrag um Belege.
- Erkenntnisse sind weder Wissen noch Skills, bis eine Person sie im Cockpit bestätigt. `sk intake list` zeigt, was wartet.

**Prüfungen mit einem Agenten.** Die Prüfung läuft in einer gespeicherten SubKit-Konversation.

- MCP-Clients starten sie mit `conversation_start`. `intake_item_ids` wählt bestimmte Clips aus und hält die Auswahl fest.
- Tools, die Einträge lesen oder Vorschläge vorbereiten, arbeiten nur in dieser Konversation.
- Nimm bei einem neuen Ziel die Themenkategorie oder das Tag `domain:<slug>` in den Vorschlag auf. Ein geänderter Vorschlag muss erneut geprüft werden.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| `sk agent briefing: no domains …` | Es gibt keine Deklaration. Übergib `--domains` oder führe `sk agent init --domains <category>` aus. |
| `knowledge_sources` oder `skills_full` sind leer | Das Briefing funktioniert, aber nichts ist der Domäne zugeordnet. Lege Wissen und Skills in der Kategorie der Domäne ab oder nutze das Tag `domain:<slug>`. |
| Der Client zeigt eine Warnung zum Briefing | Die Engine ist nicht erreichbar. Die Sitzung läuft weiter. Prüfe mit `sk status` Anmeldung und Verbindung. |
| Keine Briefings in Claude Code oder Codex | Öffne `/hooks`, prüfe, ob die SubKit-Hooks aktiv sind, und vertraue neuen oder geänderten Hooks. |
| `/hooks` in Codex zeigt die SubKit-Hooks als deaktiviert | Codex-Hooks sind standardmäßig aktiv, eine Änderung an `config.toml` ist normalerweise nicht nötig. Prüfe zuerst die wirksame Feature-Einstellung und die Administratorrichtlinie, dann folge dem [Codex-Hook-Leitfaden](https://learn.chatgpt.com/docs/hooks). |
| Der Hinweis auf gesammelte Einträge fehlt | Dir fehlt die Berechtigung `intake:read`. Bitte eine Administratorin oder einen Administrator darum. |
| Ein Vorschlag lässt sich nicht bestätigen | Bestätigen kann nur eine angemeldete Person mit `intake:confirm` und `knowledge:write`, nicht ein API-Schlüssel. Öffne den Cockpit-Link. |
