---
slug: engine-operator
summary: Welcher Workspace die Engine betreibt und was nur er darf.
section: operate
order: 3
audience: operator
---
## Engine-Betreiber

Ein Workspace ist der Engine-Betreiber: der Workspace, der das erstmalige Setup abgeschlossen hat
(bei einem lokalen Entwicklungs-Seed `default`). Nur dessen Admins können die gesamte Engine ändern
oder lesen: engineweite Einstellungen und ihre Revisionen, Laufzeit-Secrets und vorbereitete
Secret-Freigaben, Engine-Neustarts, Engine-Diagnosen und -Logs, `/metrics` sowie das Deaktivieren
eines MCP-OAuth-Clients für alle Workspaces. Diese Berechtigungen sind in
`GET /v1/rbac/permissions` mit `operator: true` markiert (`settings:read:global`,
`settings:write:global`, `system:restart`, `metrics:read`, `mcp_oauth_client:disable`). Keine Rolle,
kein Grant und kein Key-Scope außerhalb des Betreiber-Workspace kann sie freischalten; eine solche
Anfrage antwortet mit `403` und `details.cause: "operator_only"`. `GET /v1/identity/whoami`
meldet `engine_operator`.

Jeder andere Workspace behält seine eigenen Einstellungen. `GET /v1/settings` liefert die
Mandantensicht: nur Einstellungen, die ein Mandanten-Overlay unterstützen, mit ihrem wirksamen
Wert. Eine Änderung gilt nur dann für deinen Workspace, wenn du ihn benennst:

```bash
sk settings set llm.model '"<model>"' --tenant <your-tenant-id>
```

Im Cockpit sehen Workspaces außerhalb des Engine-Betreibers Einstellungen derzeit nur lesend.
Verwende den obigen CLI-Befehl, um die Einstellungen deines eigenen Workspace zu ändern.

Ohne `--tenant` lehnt die Engine die Änderung ab, statt sie für alle anzuwenden. Solange der
Betreiber engineweite Einstellungen gespeichert hat, die noch nicht aktiv sind, antwortet eine
Workspace-Änderung mit `409 operator_change_pending` und wird nicht gespeichert. Das Widerrufen
eines MCP-OAuth-Clients außerhalb des Betreiber-Workspace entzieht ihm nur in deinem Workspace den
Zugriff.

Der Betreiber-Workspace wird einmal gewählt und nur auf dem Host verschoben:

```bash
engine --set-operator-tenant <slug>
```

API-Schlüssel und Einladungen tragen Scopes aus dem Berechtigungskatalog, `*` oder die
MCP-Modusmarker `mcp:read`, `mcp:authoring` und `mcp:admin`. Jeder Scope muss von der Anmeldung
gehalten werden, die ihn ausstellt; nur eine Anmeldung ohne Scope-Grenzen kann `*` ausstellen, und
ein Schlüssel, der Scopes weglässt, erbt die eigenen Grenzen des Ausstellers. Das Rotieren eines
Schlüssels wendet dieselbe Prüfung auf die Scopes an, die er bereits trägt. Unbekannte Scopes
antworten mit `422 unknown_scope`, Scopes jenseits des Ausstellers mit `403 scope_exceeds_issuer`.

