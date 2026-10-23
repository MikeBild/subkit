---
slug: mcp-clients
summary: Verbinde einen KI-Client per MCP, damit er deine Workflows findet und startet.
order: 2
section: work
audience: public
---
## KI-Clients per MCP anbinden

Verbinde einen KI-Client wie Claude, ChatGPT, Cursor oder Codex per MCP mit SubKit.
Der Client findet und startet dann deine Workflows.
Jeder Aufruf wird gegen deine Rechte geprüft und im Audit-Log festgehalten.

### Was du brauchst

- Die MCP-Adresse deiner Engine. Jede Engine hat genau eine:

  ```text
  https://<deine-engine>/mcp
  ```

  In SubKit Cloud ist das `https://subkit-cloud.mikebild.info/mcp`, immer ohne `/cockpit`.
  Deine eigene Engine braucht HTTPS. Reines HTTP geht nur auf `localhost`.
- Ein Konto in einem Arbeitsbereich, dessen Rolle MCP-Zugriff erlaubt. Ohne dieses Recht endet die Anmeldung mit `access_denied`.
- Einen KI-Client, der entfernte MCP-Server über HTTP unterstützt.

### Anmeldung wählen

| Weg | Wann | Was du tust |
| --- | --- | --- |
| **Browser-Anmeldung (OAuth)** | SubKit Cloud und Engines mit Anmeldeanbieter | Adresse eintragen. Der Client öffnet deinen Browser. In der Cloud wählst du dort **Mit Firmenkonto anmelden**. |
| **API-Schlüssel** | Clients, die einen Schlüssel nutzen, und Engines ohne Anmeldeanbieter | Einen Schlüssel als Bearer-Token in den Client eintragen. |

Nimm die Browser-Anmeldung, wenn du kannst. Du kopierst keinen Schlüssel, und der Zugang erneuert sich selbst.
Ein API-Schlüssel ist ein langlebiger Zugang, der auf deinem Rechner liegt.

### Mit Browser-Anmeldung verbinden

1. Füge in deinem Client einen entfernten MCP-Server mit der Adresse `https://<deine-engine>/mcp` hinzu und nenne ihn `sk`.
2. Melde dich in dem Browserfenster, das der Client öffnet, an wie im Cockpit.
3. Prüfe auf der Seite **Zugriff erlauben**, welcher Client auf welchen Arbeitsbereich zugreifen will.
4. Hake an, was der Client darf. **Lesen** ist immer an.
5. Wähle **Erlauben**. Der Browser kehrt zu deinem Client zurück.

Wo du den Server einträgst, hängt vom Client ab:

- **claude.ai:** in den Einstellungen für Konnektoren. Füge einen eigenen Konnektor mit der Adresse hinzu.
- **Claude Code:**

  ```bash
  claude mcp add --transport http --scope user sk https://<deine-engine>/mcp
  ```

  Führe danach in Claude Code `/mcp` aus und wähle `sk`, um dich anzumelden.
- **ChatGPT und Cursor:** in den MCP- oder Konnektor-Einstellungen des Clients.

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

Ein Schlüssel ohne MCP-Modusmarker verbindet im Modus **Lesen**.
Zum Bearbeiten ergänzt du `mcp:authoring` in `--scopes`, wenn du den Schlüssel mit `sk apikeys create` anlegst.

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

Der Scope bestimmt, welche Tools der Client sieht. Er erweitert nie deine Rechte, deine Rolle begrenzt weiterhin jeden Aufruf.

| Auf der Zugriffsseite | Scope | Der Client kann |
| --- | --- | --- |
| **Lesen** | `mcp:read` | Workflows, Läufe, Konnektoren und Wissen lesen und gespeicherte Workflows starten. |
| **Bearbeiten** | `mcp:authoring` | Zusätzlich Workflows und Konnektoren in einer geführten Unterhaltung bauen. |
| **Verwalten** | `mcp:admin` | Zusätzlich im Arbeitsbereich anlegen, ändern und löschen. |
| **Betriebszähler** | `metrics:read` | Die Betriebszähler lesen, sonst nichts. |

- Die Zugriffsseite bietet nur an, was deine Rolle erlaubt.
- Ein Schlüssel mit `*` enthält kein Bearbeiten. Dafür braucht es bewusst `mcp:authoring`.
- Eine Engine mit `mcp.read_only` blendet alle schreibenden Tools aus, auch mit `mcp:admin`.

### Lesen, ausführen, schreiben

- **Lesen** läuft sofort. Beispiele: `find_workflow`, `get_execution`, `search_knowledge`.
- **Ausführen** startet einen gespeicherten Workflow, etwa mit `run_workflow` oder einem `wf_<slug>`-Tool.
  Ein kurzer Lauf antwortet sofort. Ein langer Lauf antwortet mit einer `execution_id`, die der Client mit `get_execution` verfolgt.
- **Schreiben** verändert etwas: eine E-Mail senden, Daten ändern, den Arbeitsbereich ändern.

Schreiben braucht immer einen Menschen. Es gibt zwei Prüfungen:

- **Schreiben in einem Workflow:** Ein Workflow schreibt erst wirklich, wenn eine Person ihn im Cockpit freigegeben hat. Die Freigabe gilt für die genaue Version, ihre Ziele und ihre Grenzen.
  Ohne Freigabe ist der Lauf ein Probelauf: Schreibzugriffe werden zurückgehalten, nichts wird gesendet.
- **Schreibende Tools im Client:** Ein schreibendes Tool kann anhalten und einen Link zum einmaligen Erlauben liefern.
  Öffne den Link, melde dich an, prüfe, was passieren wird, und wähle **Einmal erlauben** oder **Ablehnen**.
  Erst wenn du es erlaubt hast, kann der Client den Aufruf mit `confirm_tool_call` abschließen.

Die KI kann nichts selbst freigeben oder erlauben. Auch der Link allein erlaubt nichts.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| `401` mit `missing_or_invalid_credentials` | Melde dich neu an, oder prüfe Schlüssel und `Authorization`-Header. |
| Anmeldung endet mit `access_denied` | Deine Rolle hat kein MCP-Recht. Bitte eine Administratorin oder einen Administrator um eine Rolle mit MCP-Zugriff. |
| `403` „Forbidden: invalid Origin header“ | Die Anfrage kam von einer fremden Webseite. Verbinde aus dem Client, nicht aus einer Webseite, und nutze die eigene Adresse der Engine. |
| `403` `product_caller_forbidden` | Das Token gehört zu einem App-Benutzer und hat keinen MCP-Zugang. Nutze die Anmeldung oder den Schlüssel einer Person. |
| `400` „Unsupported protocol version“ | Der Client spricht eine MCP-Version, die die Engine nicht kennt. Aktualisiere den Client. |
| `404` „Session not found“ | Die Sitzung ist abgelaufen, etwa nach einem Engine-Neustart. Verbinde den Server im Client neu. |
| Tools zum Bearbeiten fehlen | Der Zugang hat kein `mcp:authoring`. Melde dich neu an und hake **Bearbeiten** an, oder arbeite mit der sk-CLI. |
| Neue Tools fehlen nach einem Update | claude.ai behält seine alte Tool-Liste. Entferne den Konnektor und füge ihn neu hinzu. |
