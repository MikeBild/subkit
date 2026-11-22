---
slug: cockpit-branding
summary: Gib dem Cockpit den Namen, das Logo und die Farben deiner Firma.
section: operate
order: 1
audience: operator
---
## Cockpit-Branding

Mit dem Branding zeigt das angemeldete Cockpit deinen Namen, dein Logo und eine passende Farbpalette statt des SubKit-Auftritts. Du brauchst es, wenn dein Team das Cockpit als eigenes Werkzeug erkennen soll. Danach sehen alle Angemeldeten deines Arbeitsbereichs denselben Auftritt; Anmeldung, E-Mails und andere Clients bleiben bei SubKit.

### Im Cockpit ändern

Dein Arbeitsbereich ist in der Engine ein eigener Mandant: eigene Daten, eigene Nutzer, eigene Rechte. Zum Ändern brauchst du dort die Rechte `settings:write` und `identity:write`. In den Einstellungen unter „Betrieb“, Bereich „Erscheinungsbild“ (Abschnitt „Arbeitsbereich-Branding“), legst du fest:

- das Wortzeichen, also den angezeigten Namen, und einen optionalen Untertitel,
- je ein Logo für die helle und die dunkle Darstellung,
- eines von drei geprüften Farbpaletten-Paaren.

Die Vorschau bleibt in deinem Browser, bis du speicherst. Zurücksetzen stellt den SubKit-Auftritt wieder her. Ein barrierefreier Hinweis „powered by SubKit“ bleibt auch mit eigenem Branding erhalten.

### Was mit hochgeladenen Logos passiert

Erlaubt sind PNG, JPEG und WebP bis 2 MiB und 4 Megapixel. SubKit dekodiert jedes Bild und speichert es neu als unbewegtes PNG mit höchstens 512 Pixeln je Kante; Metadaten der Quelle fallen dabei weg. Animationen, SVG, externe Bildadressen, Skripte und eigenes CSS lehnt SubKit ab. Die Palette lässt die Statusfarben unverändert, die etwa Fehler oder Erfolg anzeigen.

Das Branding liegt im PostgreSQL-Schema deines Arbeitsbereichs. Im gehosteten Betrieb wird es auf das Speicherkontingent angerechnet.

### Über HTTP, CLI und MCP

Cockpit, HTTP-API, `subkit` und MCP folgen denselben Regeln: gleiche Bildprüfung, gleiche Berechtigungen, gleiche Revisionen. Jede gespeicherte Fassung hat eine Revision. Hat jemand anderes inzwischen gespeichert, schlägt dein Speichern mit einem Konflikt fehl und die gespeicherte Fassung bleibt erhalten. Lade dann neu und versuche es noch einmal.

Angemeldete Aufrufer lesen mit `GET /v1/tenant/branding`, speichern mit `PUT` und setzen mit `DELETE` zurück. Schreiben braucht beide Rechte, `settings:write` und `identity:write`. Ein API-Schlüssel mit Scope bleibt auf seine Rechte begrenzt; Schreibzugriffe aus dem Browser prüfen zusätzlich das CSRF-Token. Logo-Abrufe sind an Arbeitsbereich und Revision gebunden. Ist nur ein Logo hinterlegt, nutzt das Cockpit es für das helle und das dunkle Design; HTTP, CLI und MCP liefern beide Logo-Adressen aus.

Die CLI bietet diese Befehle:

```bash
subkit branding get
subkit branding update <json-file|->
subkit branding reset <revision>
subkit branding logo <light|dark> --output <file>
```

Über MCP stehen `get_tenant_branding`, `update_tenant_branding`, `reset_tenant_branding` und `get_tenant_branding_logo` bereit. Änderungen über MCP brauchen wie üblich die Freigabe einer angemeldeten Person. SubKit prüft beide Schreibrechte, bevor es die Freigabe anfordert. Normale Lesezugriffe liefern Metadaten; nur `get_tenant_branding_logo` liefert die normalisierten PNG-Bytes. Die OpenAPI- und MCP-Eingabeschemas werden aus derselben Anfragebeschreibung erzeugt.
