---
slug: mcp-clients
summary: Verbinde einen KI-Client per MCP, damit er deine Workflows findet und startet.
order: 2
section: work
audience: public
---
## KI-Clients per MCP anbinden

Nach diesem Kapitel findet und startet dein KI-Client deine SubKit-Workflows. Claude, ChatGPT,
Cursor und Codex sprechen mit SubKit über das Model Context Protocol (MCP). Jeder Aufruf wird
gegen deine Rechte geprüft und im Audit-Log festgehalten.

Jede Engine hat genau eine MCP-Adresse:

```text
https://<deine-engine>/mcp
```

Bei SubKit Cloud ist das `https://subkit-cloud.mikebild.info/mcp`.

### Was du brauchst

- **Eine Engine-Adresse.** SubKit Cloud oder deine eigene Engine mit HTTPS.
  Reines HTTP geht nur auf `localhost`.
- **Ein Konto in einem Workspace**, dessen Rolle MCP-Zugriff erlaubt.
  Ohne dieses Recht endet die Anmeldung mit `access_denied`.
- **Einen KI-Client**, der entfernte MCP-Server über HTTP unterstützt.

### Anmeldung wählen

Es gibt zwei Wege. Wähle einen.

| Weg | Wann | Was du tust |
| --- | --- | --- |
| **Browser-Anmeldung (OAuth)** | SubKit Cloud und Engines mit Anmeldeanbieter | Adresse eintragen. Der Client öffnet deinen Browser. |
| **API-Schlüssel** | Selbst betriebene Engines ohne Identitätsanbieter | Einen Schlüssel als Bearer-Token in den Client kopieren. |

Nimm die Browser-Anmeldung, wenn du kannst. Du kopierst kein Geheimnis, und der Zugang
erneuert sich selbst. Ein API-Schlüssel ist ein langlebiges Geheimnis auf deinem Rechner.

### Mit Browser-Anmeldung verbinden

1. Füge in deinem Client einen entfernten MCP-Server mit der Adresse
   `https://<deine-engine>/mcp` hinzu. Nenne ihn `sk`.
2. Der Client öffnet deinen Browser. Melde dich an wie im Cockpit.
3. Die Seite **Zugriff freigeben** zeigt, welcher Client auf welchen Workspace zugreifen will.
4. Hake an, was der Client darf (siehe „Was der Client darf“ weiter unten).
   **Lesen** ist immer an.
5. Klicke auf **Freigeben**. Der Browser kehrt zu deinem Client zurück.

Wo du den Server einträgst, hängt vom Client ab:

- **claude.ai:** in den Einstellungen für Konnektoren. Füge einen eigenen Konnektor mit der Adresse hinzu.
- **Claude Code:**

  ```bash
  claude mcp add --transport http --scope user sk https://<deine-engine>/mcp
  ```

  Führe danach in Claude Code `/mcp` aus und wähle `sk`, um dich anzumelden.
- **ChatGPT und Cursor:** in den MCP- oder Konnektor-Einstellungen des Clients.

Menünamen ändern sich zwischen Client-Versionen. Sie sind hier nicht geprüft.
Sieht ein Schritt anders aus, folge der Anleitung deines Clients für entfernte MCP-Server.

### Mit API-Schlüssel verbinden

Nutze das nur auf einer selbst betriebenen Engine ohne Identitätsanbieter.

1. Öffne im Cockpit **API-Zugang** und erstelle einen Schlüssel.
   Die Vorlage **Ausführen** passt für die meisten Clients.
2. Lege den Schlüssel in einer Umgebungsvariable ab. Kopiere ihn nicht in eine Datei, die du teilst.

   ```bash
   export SK_API_KEY=<dein-schluessel>
   ```

3. Trage den Server ein.

   Claude Code:

   ```bash
   claude mcp add --transport http --scope user sk https://<deine-engine>/mcp --header "Authorization: Bearer ${SK_API_KEY}"
   ```

   Codex:

   ```bash
   codex mcp add sk --url https://<deine-engine>/mcp --bearer-token-env-var SK_API_KEY
   ```

   Andere Clients: Schick bei jeder Anfrage den Header `Authorization: Bearer <dein-schluessel>` mit.

Ein Schlüssel ohne MCP-Modusmarker verbindet im Modus **Lesen**.
Wie Schlüssel `mcp:authoring` oder `mcp:admin` tragen, steht im Kapitel „Engine-Betreiber“.

### Prüfen

1. Prüfe, ob die Engine antwortet. Sie nennt ihre MCP-Adresse und die angebotenen Scopes:

   ```bash
   curl https://<deine-engine>/.well-known/oauth-protected-resource
   ```

   ```json
   {
     "resource": "https://<deine-engine>/mcp",
     "authorization_servers": ["https://<deine-engine>"],
     "scopes_supported": ["mcp:read", "mcp:authoring", "mcp:admin", "metrics:read"]
   }
   ```

2. Bitte deinen Client: „Ruf das sk-Tool whoami auf.“
   Die Antwort nennt dein Konto, deinen Workspace und deine Scopes.
3. Bitte: „Such einen Workflow in sk.“ Der Client ruft `find_workflow` auf und listet die Treffer.

Klappen alle drei, ist der Client verbunden.

### Was der Client darf

Der Scope bestimmt, welche Tools der Client sieht. Er erweitert nie deine Rechte.
Deine Rolle begrenzt weiterhin jeden Aufruf.

| Auf der Freigabeseite | Scope | Der Client kann |
| --- | --- | --- |
| **Lesen** | `mcp:read` | Workflows, Läufe, Konnektoren und Wissen lesen und gespeicherte Workflows starten. |
| **Bearbeiten** | `mcp:authoring` | Zusätzlich Workflows und Konnektoren in einer geführten Konversation bauen. |
| **Verwalten** | `mcp:admin` | Zusätzlich im Workspace anlegen, ändern und löschen. |
| **Betriebszähler** | `metrics:read` | Die Betriebszähler lesen, sonst nichts. |

- Die Freigabeseite bietet nur an, was deine Rolle erlaubt.
- Ein Schlüssel mit `*` enthält kein Bearbeiten. Dafür braucht es bewusst `mcp:authoring`.
- Eine Engine mit `mcp.read_only` blendet alle schreibenden Tools aus, auch mit `mcp:admin`.

### Lesen, ausführen, schreiben

SubKit unterscheidet drei Arten von Wirkung.

- **Lesen** läuft sofort. Beispiele: `find_workflow`, `get_execution`, `search_knowledge`.
- **Ausführen** startet einen gespeicherten Workflow, etwa mit `run_workflow` oder einem
  `wf_<slug>`-Tool. Ein kurzer Lauf antwortet sofort. Ein langer Lauf antwortet mit einer
  `execution_id`. Der Client verfolgt ihn mit `get_execution`.
- **Schreiben** verändert etwas: eine E-Mail senden, Daten ändern, den Workspace ändern.

Schreiben braucht immer einen Menschen. Es gibt zwei Prüfungen:

1. **Schreiben in einem Workflow.** Ein Workflow schreibt erst wirklich, wenn eine Person ihn
   im Cockpit freigegeben hat: die genaue Version, ihre Ziele und ihre Grenzen. Ohne diese
   Freigabe ist der Lauf eine Vorschau. Schreibzugriffe werden zurückgehalten, nichts wird gesendet.
2. **Schreibende Tools im Client.** Ein schreibendes Tool kann anhalten und einen Freigabe-Link
   liefern. Öffne den Link, melde dich an und prüfe, was passieren wird. Entscheide dann:
   **freigeben** oder **ablehnen**. Erst nach deiner Freigabe kann der Client den Aufruf mit
   `confirm_tool_call` abschließen.

Die KI kann nichts selbst freigeben. Auch der Link allein ist keine Freigabe.

### Fehlerbehebung

| Was du siehst | Ursache | Was du tust |
| --- | --- | --- |
| `401` mit `missing_or_invalid_credentials` | Keine oder ungültige Anmeldung. | Melde dich neu an, oder prüfe Schlüssel und `Authorization`-Header. |
| Anmeldung endet mit `access_denied` | Deine Rolle hat kein MCP-Recht. | Bitte eine Administratorin oder einen Administrator um eine Rolle mit MCP-Zugriff. |
| `403` „Forbidden: invalid Origin header“ | Die Anfrage kam von einer fremden Webseite. | Nutze die eigene Adresse der Engine. Verbinde aus dem Client, nicht aus einer Webseite. |
| `403` `product_caller_forbidden` | Das Token gehört zu einem App-Benutzer. | App-Tokens haben keinen MCP-Zugang. Nutze die Anmeldung oder den Schlüssel einer Person. |
| `400` „Unsupported protocol version“ | Der Client spricht eine MCP-Version, die die Engine nicht kennt. | Aktualisiere den Client. |
| `404` „Session not found“ | Die Sitzung ist abgelaufen, etwa nach einem Engine-Neustart. | Verbinde den Server im Client neu. |
| Tools zum Bearbeiten fehlen | Der Zugang hat kein `mcp:authoring`. | Melde dich neu an und hake **Bearbeiten** an, oder arbeite mit der sk CLI. |
| Neue Tools fehlen nach einem Update | claude.ai behält seine alte Tool-Liste. | Entferne den Konnektor und füge ihn neu hinzu. |

### Weiter

- „sk aus einem Coding-Agent verwenden“: Claude Code und Codex für dein Repository briefen.
- „Die sk-CLI auf deinem Rechner verwenden“: Workflows als Dateien bauen, die du prüfen kannst.
