---
slug: mcp-clients
summary: Lass einen KI-Client wie Claude Code deine Workflows finden und starten.
order: 2
section: work
audience: public
---
## KI-Clients per MCP anbinden

Dieses Kapitel ist für alle, die SubKit aus einem KI-Client wie Claude, ChatGPT, Cursor oder Codex heraus nutzen wollen.
Du trägst deine Engine dort einmal als Server ein und meldest dich an.
Danach findet und startet der Client deine Workflows, mit deinen Rechten und mit einem Eintrag im Verlauf.

SubKit ist für Claude Code, Codex, Cursor und andere KI-Clients ein MCP-Server: Jeder freigegebene Workflow ist dort ein Tool, dazu Connectors, Wissen und Skills – mit den Rechten des Zugangs, keinem darüber hinaus. Was schreibt, wartet auf ein „Einmal erlauben“ einer Person. Umgekehrt wird ein MCP-Server, den ihr schon nutzt, in SubKit ein Connector; welche seiner Tools ohne Rückfrage laufen, legt der Betreiber je Tool fest.

### Was du brauchst

- Die MCP-Adresse deiner Engine. Jede Engine hat genau eine:

  ```text
  https://<deine-engine>/mcp
  ```

  In SubKit Cloud ist das `https://subkit-cloud.mikebild.dev/mcp`, immer ohne `/cockpit`.
  Deine eigene Engine braucht HTTPS. Reines HTTP geht nur auf `localhost`.
- Ein Konto, dessen Rolle MCP-Zugriff erlaubt. Ohne dieses Recht endet die Anmeldung mit `access_denied`.
- Einen KI-Client, der entfernte MCP-Server über HTTP unterstützt. Kann er nur lokale Server starten, siehe „Mit API-Schlüssel verbinden“.

### Anmeldung wählen

| Weg | Wann | Was du tust |
| --- | --- | --- |
| **Browser-Anmeldung (OAuth)** | SubKit Cloud und Engines mit Anmeldeanbieter | Adresse eintragen. Der Client öffnet deinen Browser, dort meldest du dich an und stimmst zu. In der Cloud wählst du **Mit Firmenkonto anmelden**. |
| **API-Schlüssel** | Clients, die einen Schlüssel nutzen, und Engines ohne Anmeldeanbieter | Einen Schlüssel als Bearer-Token in den Client eintragen. |

Nimm die Browser-Anmeldung, wenn du kannst. Du kopierst keinen Schlüssel, siehst auf einer Zustimmungsseite, was der Client darf, und der Zugang erneuert sich selbst.
Ein API-Schlüssel dagegen ist ein langlebiger Zugang, der auf deinem Rechner liegt.

### Mit Browser-Anmeldung verbinden

1. Füge in deinem Client einen entfernten MCP-Server mit der Adresse `https://<deine-engine>/mcp` hinzu und nenne ihn `sk`.
2. Melde dich in dem Browserfenster, das der Client öffnet, so an wie im Cockpit.
3. Prüfe auf der Seite **Zugriff erlauben**, welcher Client auf welchen Arbeitsbereich zugreifen will.
4. Hake an, was der Client darf. **Lesen** ist immer an.
5. Wähle **Erlauben**. Der Browser kehrt zu deinem Client zurück.

Wo du den Server einträgst, hängt vom Client ab:

- **claude.ai:** in den Einstellungen für Connectors. Füge einen eigenen Connector mit der Adresse hinzu.
- **Claude Code:**

  ```bash
  claude mcp add --transport http --scope user sk https://<deine-engine>/mcp
  ```

  Führe danach in Claude Code `/mcp` aus und wähle `sk`, um dich anzumelden.
- **ChatGPT und Cursor:** in den MCP- oder Connector-Einstellungen des Clients.

Menünamen ändern sich zwischen Client-Versionen. Sieht ein Schritt anders aus, folge der Anleitung deines Clients für entfernte MCP-Server.

### Mit API-Schlüssel verbinden

1. Öffne im Cockpit **API-Zugang** und erstelle einen Schlüssel. Die Vorlage **Ausführen** passt für die meisten Clients.
2. Lege den Schlüssel in einer Umgebungsvariable ab, nicht in einer Datei, die du teilst:

   ```bash
   export SK_API_KEY=<dein-schluessel>
   ```

3. Trage den Server mit dem passenden Befehl in deinem Client ein.

Claude Code:

```bash
claude mcp add --transport http --scope user sk https://<deine-engine>/mcp --header "Authorization: Bearer ${SK_API_KEY}"
```

Codex:

```bash
codex mcp add sk --url https://<deine-engine>/mcp --bearer-token-env-var SK_API_KEY
```

Andere Clients schicken bei jeder Anfrage den Header `Authorization: Bearer <dein-schluessel>` mit.

Kann dein Client nur lokale MCP-Server starten, gibt es den Befehl `sk mcp`. Er nutzt dein angemeldetes `sk`-Profil, bietet aber nur fünf Tools: einen Verbindungstest und vier Tools für Unterhaltungen mit SubKit. Workflows, Connectors und Wissen erreicht dein Client nur über die Adresse `/mcp` deiner Engine.

Ein Schlüssel ohne MCP-Scope verbindet im Modus **Lesen**.
Soll der Client auch bauen dürfen, ergänzt du `mcp:authoring` in `--scopes`, wenn du den Schlüssel mit `sk apikeys create` anlegst.

### Die Verbindung prüfen

1. Prüfe, ob die Engine antwortet:

   ```bash
   curl https://<deine-engine>/.well-known/oauth-protected-resource
   ```

   Die Antwort nennt die MCP-Adresse und die angebotenen Scopes:

   ```json
   {
     "resource": "https://<deine-engine>/mcp",
     "authorization_servers": ["https://<deine-engine>"],
     "scopes_supported": ["mcp:read", "mcp:authoring", "mcp:admin", "metrics:read"]
   }
   ```

2. Bitte deinen Client: „Ruf das SubKit-Tool whoami auf.“ Die Antwort nennt dein Konto, deinen Arbeitsbereich und deine Scopes.
3. Bitte: „Such einen Workflow in SubKit.“ Der Client ruft `find_workflow` auf und listet die Treffer.

Klappen alle drei, ist der Client verbunden.

### Was der Client darf

Ein Scope ist die Stufe, die du dem Client beim Verbinden gibst. Er bestimmt, welche Tools der Client überhaupt sieht.
Deine Rolle begrenzt trotzdem jeden einzelnen Aufruf. Ein Scope gibt dem Client nie mehr, als du selbst darfst.

| Auf der Zugriffsseite | Scope | Der Client kann |
| --- | --- | --- |
| **Lesen** | `mcp:read` | Workflows, Runs, Connectors, Wissen und Aufgaben lesen, gespeicherte Workflows starten und Aufgaben starten und abbrechen. |
| **Bearbeiten** | `mcp:authoring` | Zusätzlich Workflows und Connectors in einer geführten Unterhaltung bauen und Aufgaben anlegen und ändern. |
| **Verwalten** | `mcp:admin` | Zusätzlich im Arbeitsbereich anlegen, ändern und löschen. |
| **Betriebszähler** | `metrics:read` | Die Betriebszähler lesen, sonst nichts. |

- Die Zugriffsseite bietet nur an, was deine Rolle erlaubt.
- Ein Schlüssel mit `*` enthält kein Bearbeiten. Dafür braucht es bewusst `mcp:authoring`.
- Eine Engine mit `mcp.read_only` blendet alle schreibenden Tools aus, auch mit `mcp:admin`.

### Lesen, ausführen, schreiben

- **Lesen** läuft sofort. Beispiele: `find_workflow`, `get_execution`, `search_knowledge`.
- **Ausführen** startet einen gespeicherten Workflow, etwa mit `run_workflow` oder einem `wf_<slug>`-Tool.
  Ein kurzer Run antwortet sofort. Ein langer Run antwortet mit einer `execution_id`, die der Client mit `get_execution` verfolgt.
- **Schreiben** verändert etwas: eine E-Mail senden, Daten ändern, den Arbeitsbereich ändern.
- **Pakete** bringen die eigenen Ressourcen deines Arbeitsbereichs mit `export_tenant_package`, `preview_package_import` und `apply_package_import` auf eine andere Engine.
  Sie fragen vorher nach einer Bestätigung. Ein Import legt nur Entwürfe und Vorschläge an.

Schreiben braucht immer einen Menschen, und zwar an zwei Stellen:

- **Schreiben in einem Workflow:** Ein Workflow schreibt erst wirklich, wenn eine Person ihn im Cockpit freigegeben hat. Ohne Freigabe ist der Run ein Probe-Run: Schreibzugriffe werden zurückgehalten, nichts wird gesendet.
  Eine neue Version braucht keine neue Freigabe, solange sie nicht mehr Systeme, Adressen oder Schreibrechte anfasst als die freigegebene. Greift sie weiter, fragt SubKit erneut und nennt den Unterschied.
  Im Chat fragt SubKit mit **Immer vorher fragen** vor jedem Schreiben, außer es gibt eine Freigabe, die genau diesen Run deckt: dieselbe Version, dieselbe Umgebung, noch gültig und mit unveränderter Wirkung. Ein Run, der Daten aus einem früheren Run weitergibt, fragt immer, ebenso eine Unterhaltung, der du gesagt hast, jeden Start zu bestätigen.
- **Schreibende Tools im Client:** Ein schreibendes Tool hält an und liefert einen Link.
  Öffne ihn, melde dich an, prüfe, was passieren wird, und wähle **Einmal erlauben** oder **Ablehnen**.
  Erst danach kann der Client den Aufruf mit `confirm_tool_call` abschließen.

Die KI kann nichts selbst freigeben oder erlauben. Auch der Link allein erlaubt nichts.

### Aufgaben aus einem KI-Client

Eine Aufgabe ist ein Ziel mit Grenzen, auf das SubKit alleine hinarbeitet. Das Kapitel „Ein Ziel als Aufgabe übergeben“ erklärt sie. Aus einem KI-Client erreichst du Aufgaben mit diesen Tools:

| Tool | Was es tut | Stufe |
| --- | --- | --- |
| `list_tasks`, `find_task`, `get_task` | Die Aufgaben auflisten, durchsuchen und lesen, die du sehen darfst. | **Lesen** |
| `get_task_run` | Den Zustand eines Runs lesen. | **Lesen** |
| `run_task` | Jetzt einen Run starten, als du. Der Aufruf liefert den Run und wartet nicht auf das Ergebnis. | **Lesen** |
| `abort_task_run` | Einen Run abbrechen, der läuft, wartet oder schläft. | **Lesen** |
| `save_task` | Eine Aufgabe anlegen oder ändern. Es speichert die Aufgabe nur und startet nichts. | **Bearbeiten** |

Du siehst deine eigenen Aufgaben. Mit der Rolle Admin siehst du alle. `get_attention` listet auch Aufgaben, die auf dich warten.

Was ein Client nicht kann:

- **Die Dauererlaubnis erteilen.** Eine Aufgabe, die alleine starten soll, braucht eine Person, die im Browser im Cockpit angemeldet ist.
- **Die Rückfragen eines Runs beantworten.** Ein Run arbeitet in einer eigenen Unterhaltung im Cockpit. Jedes Aufgaben-Ergebnis enthält `cockpit_path`, die Adresse der Aufgabe dort.
- **Ein Ergebnis bestätigen oder verwerfen.** Das tut nur ein Mensch, der im Browser im Cockpit angemeldet ist.
- **Aufgaben ohne Bearbeiten anlegen oder ändern.** Ohne `mcp:authoring` antwortet `save_task` mit `authoring_scope_required`.

Ein Run, den ein Client startet, hat dieselben Grenzen wie jeder Run: Er nutzt nur, was an die Aufgabe gebunden ist, und alles, was schreibt, fragt vorher einen Menschen, außer eine gültige Freigabe eines gebundenen Workflows deckt es.

### MCP-Server als Connector nutzen

Der umgekehrte Weg: Ein MCP-Server, den dein Team schon nutzt, wird in SubKit ein Connector. Workflows und der Chat rufen dann seine Tools auf.
Jedes Tool fragt vor dem Run nach, es sei denn, der Betreiber hat es einzeln freigeschaltet. Das darf nur, wer den Connector ändern darf; eine normale Bearbeitung des Connectors ändert diese Liste nicht.
`sk connectors mcp-inspect <id>` zeigt, welche Tools der Server wirklich anbietet. Verlangt der Server OAuth-Zugangsdaten, folge „OAuth-Zugangsdaten für externe MCP-Server“.

### Wenn etwas nicht klappt

Die Engine liefert diese Meldungen auf Englisch; sie stehen hier deshalb wörtlich.

| Was du siehst | Was du tust |
| --- | --- |
| `401` mit `missing_or_invalid_credentials` | Melde dich neu an, oder prüfe Schlüssel und `Authorization`-Header. |
| Anmeldung endet mit `access_denied` | Deine Rolle hat kein MCP-Recht. Bitte eine Administratorin oder einen Administrator um eine Rolle mit MCP-Zugriff. |
| `403` „Forbidden: invalid Origin header“ | Die Anfrage kam von einer fremden Webseite. Verbinde aus dem Client, nicht aus einer Webseite, und nutze die eigene Adresse der Engine. |
| `403` `product_caller_forbidden` | Das Token gehört zu einem App-Benutzer und hat keinen MCP-Zugang. Nutze die Anmeldung oder den Schlüssel einer Person. |
| `400` „Unsupported protocol version“ | Der Client spricht eine MCP-Version, die die Engine nicht kennt. Aktualisiere den Client. |
| `404` „Session not found“ | Die Sitzung ist abgelaufen, etwa nach einem Engine-Neustart. Verbinde den Server im Client neu. |
| Tools zum Bearbeiten fehlen | Der Zugang hat kein `mcp:authoring`. Melde dich neu an und hake **Bearbeiten** an, oder arbeite mit der sk-CLI. |
| Neue Tools fehlen nach einem Update | claude.ai behält seine alte Tool-Liste. Entferne den Connector und füge ihn neu hinzu. |
