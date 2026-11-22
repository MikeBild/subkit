---
slug: engine-operator
summary: Lege fest, welcher Arbeitsbereich die ganze Engine verwaltet.
section: operate
order: 3
audience: operator
---
## Engine-Betreiber

Eine Engine kann mehrere Arbeitsbereiche tragen; einer davon ist der Engine-Betreiber und verwaltet die Engine als Ganzes. Dieses Kapitel brauchst du, wenn du Einstellungen änderst, Secrets pflegst oder API-Schlüssel ausstellst. Danach weißt du, welche Änderung für alle gilt und welche nur für deinen Arbeitsbereich.

### Was nur der Betreiber darf

Jeder Arbeitsbereich ist technisch ein eigener Mandant (Tenant) mit getrennten Daten, Nutzern und Rechten. Betreiber ist der Arbeitsbereich, der die Ersteinrichtung abgeschlossen hat (bei einem lokalen Entwicklungs-Seed `default`). Nur seine Admins können die ganze Engine lesen oder ändern:

- engineweite Einstellungen und ihre Revisionen,
- Laufzeit-Secrets und vorbereitete Secret-Freigaben,
- Neustarts der Engine,
- Diagnosen und Logs der Engine sowie `/metrics`,
- das Abschalten eines MCP-OAuth-Clients für alle Arbeitsbereiche.

In `GET /v1/rbac/permissions` tragen diese Rechte `operator: true`: `settings:read:global`, `settings:write:global`, `system:restart`, `metrics:read` und `mcp_oauth_client:disable`. Außerhalb des Betreiber-Arbeitsbereichs schaltet sie keine Rolle, keine Rechtezuweisung und kein Key-Scope frei. Eine solche Anfrage endet mit `403` und `details.cause: "operator_only"`. `GET /v1/identity/whoami` meldet dazu `engine_operator`.

Der Betreiber-Arbeitsbereich wird einmal gewählt. Verschieben kannst du ihn nur auf dem Host:

```bash
engine --set-operator-tenant <slug>
```

### Einstellungen deines Arbeitsbereichs

Jeder andere Arbeitsbereich behält seine eigenen Einstellungen. `GET /v1/settings` liefert die Sicht deines Mandanten: nur Einstellungen, die eine Überlagerung je Mandant unterstützen, jeweils mit ihrem wirksamen Wert. Eine Änderung gilt nur für deinen Arbeitsbereich, wenn du ihn ausdrücklich nennst:

```bash
subkit settings set llm.model '"<model>"' --tenant <your-tenant-id>
```

Im Cockpit sehen Arbeitsbereiche außerhalb des Betreibers die Einstellungen derzeit nur lesend. Zum Ändern nimmst du den CLI-Befehl oben.

Ohne `--tenant` lehnt die Engine die Änderung ab, statt sie für alle anzuwenden. Hat der Betreiber engineweite Einstellungen gespeichert, die noch nicht aktiv sind, antwortet eine Änderung im Arbeitsbereich mit `409 operator_change_pending` und wird nicht gespeichert. Widerrufst du außerhalb des Betreibers einen MCP-OAuth-Client, verliert er den Zugriff nur in deinem Arbeitsbereich.

### Scopes für API-Schlüssel und Einladungen

Ein Scope begrenzt, was ein API-Schlüssel oder eine Einladung darf. Erlaubt sind Scopes aus dem Berechtigungskatalog, `*` oder die MCP-Modi `mcp:read`, `mcp:authoring` und `mcp:admin`. Dabei gilt:

- Jeden Scope muss die ausstellende Anmeldung selbst haben.
- Nur eine Anmeldung ohne Scope-Grenzen kann `*` ausstellen.
- Ein Schlüssel ohne Scopes erbt die Grenzen der Person oder des Schlüssels, der ihn ausstellt.
- Beim Rotieren gilt dieselbe Prüfung für die Scopes, die der Schlüssel schon trägt.

Unbekannte Scopes antworten mit `422 unknown_scope`, Scopes über den Rechten des Ausstellers mit `403 scope_exceeds_issuer`.
