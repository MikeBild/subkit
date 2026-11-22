---
slug: reference-vault
title: Referenz: der Tresor
summary: Lege API-Keys, Logins und Connector-Zugänge im Tresor ab, nutze sie per Handle in Workflows und sieh, wer sie wann genutzt hat.
section: reference
order: 10
audience: public
---
## Referenz: der Tresor

Der Tresor ist der eine Ort für alle Geheimnisse deines Workspace: API-Keys, Logins und die Zugänge deiner Connectors.
Ein Workflow nennt einen Eintrag nur beim Namen. Den Wert setzt SubKit erst ein, wenn ein freigegebener Run den Schritt ausführt. Die KI sieht ihn nie.

### Was im Tresor liegt

| Art | Wofür | Felder |
| --- | --- | --- |
| Secret | ein API-Key oder Token, den mehrere Workflows brauchen | `token` |
| Login | Benutzername und Passwort | `username`, `password` |
| Connector-Zugang | der Zugang eines Connectors, angelegt beim Verbinden | je nach Anmeldeart |
| Template-Client | der OAuth-Client einer Connector-Vorlage | `client_id`, `client_secret` |

Secrets und Logins legst du im Tresor an und änderst sie dort. Connector-Zugänge und Template-Clients änderst du am Connector. Im Tresor siehst du sie, deckst sie auf oder löschst sie.

Jeder Eintrag hat einen Namen aus Kleinbuchstaben, Ziffern, `-` und `_`, zum Beispiel `crm-token`. Der Name ist zugleich das Handle. Er gilt pro Umgebung: `crm-token` in Test und `crm-token` in Produktion sind zwei Einträge.

### Für wen ein Eintrag gilt

| Bereich | Wer ihn sieht | Wann sein Wert eingesetzt wird |
| --- | --- | --- |
| Workspace | alle mit `vault:read`, nur Metadaten | in jedem freigegebenen Run des Workspace |
| Nur ich | nur du | nur in Runs, die du startest |
| Dieses Gerät | nur SubKit Desktop auf diesem Gerät | nie in Workflows; er bleibt auf dem Gerät |

Geräteeinträge legt SubKit Desktop selbst an, zum Beispiel den Schlüssel, mit dem sich das Gerät beim Server ausweist. Sie liegen verschlüsselt in der sicheren Ablage des Betriebssystems und verlassen das Gerät nie.

### Einen Eintrag in einem Workflow nutzen

Schreib das Handle in einen Header, einen Query-Wert oder den Body eines Request-Schritts mit Connector:

```json
{
  "id": "contacts",
  "kind": "request",
  "connector_id": "<crm-connector-id>",
  "method": "GET",
  "path": "/contacts",
  "headers": { "authorization": "Bearer ${secret.crm-token}" },
  "query": { "account": "${secret.crm-account}" },
  "boundary": { "variables": {}, "max_body_bytes": 0, "max_calls": 1 }
}
```

| Schreibweise | Bedeutung |
| --- | --- |
| `${secret.crm-token}` | der Token eines Workspace-Secrets |
| `${secret.erp.username}`, `${secret.erp.password}` | die Felder eines Logins |
| `${secret.me.crm-token}` | dein eigener Eintrag „Nur ich“ |

Diese Regeln gelten immer:

- **Die Freigabe nennt die Einträge.** Sie zeigt „Nutzt aus dem Tresor: crm-token, …“ und bindet die Namen, nie die Werte. Nutzt eine neue Version einen weiteren Eintrag, braucht sie eine neue Freigabe. Weniger Einträge übernehmen die Freigabe.
- **Nur in freigegebenen Runs.** In Entwürfen, Probe-Runs und zurückgehaltenen Schritten bleibt das Handle unaufgelöst (`secret_withheld`), und es wird nichts gesendet.
- **Nur zum eigenen Connector.** Ein Schritt mit Tresor-Wert darf nur an den Origin seines Connectors gehen. Jede andere Adresse bricht mit `credential_boundary_violation` ab, bevor etwas gesendet wird.
- **Nur in Header, Query und Body.** In Pfad, URL, einer GraphQL-Abfrage oder einem MCP-Aufruf wird ein Handle nie aufgelöst; in Pfad oder URL stoppt der Schritt, bevor etwas gesendet wird.
- **Überall dieselben Regeln.** Ein Handle in Query oder Body wird genauso aufgelöst, unkenntlich gemacht und freigegeben wie eines im Header. Ein Query-Wert darf festen Text um ein Handle enthalten, aber keinen anderen Platzhalter. Die Freigabe prüft, dass der Schlüssel gesendet wird, nicht seinen Wert; eine Rotation braucht deshalb keine neue Freigabe.
- **Fehlt der Eintrag, scheitert der Schritt** mit `placeholder_unresolved`, und nichts wird gesendet.

### Was die KI und die Aufzeichnung sehen

Die KI, der Chat, MCP und die subkit-CLI bekommen Namen, Art, Bereich, Umgebung, Version und letzte Nutzung, aber nie den Wert.
Ergebnis, Fehlermeldung, Log und Audit-Trail eines Runs enthalten den Wert nicht. SubKit ersetzt ihn, auch URL- oder JSON-kodiert, durch `***redacted***`.

### Rotation

**Wert ersetzen** im Tresor oder `subkit vault rotate` speichert einen neuen Wert und erhöht die Version. Der nächste Run nutzt ihn. Die Freigabe des Workflows bleibt gültig, weil sie das Handle bindet und nicht den Wert.
Den Master-Schlüssel der Engine (`MASTER_KEY`) tauschst du wie bisher mit der Rewrap-Wartung.

### Aufdecken und Aktivität

**Aufdecken** zeigt dir den Wert für kurze Zeit, `subkit vault reveal <id> --yes` gibt ihn im Terminal aus. Jedes Aufdecken steht im Audit-Trail.
Die Aktivität eines Eintrags zeigt, wann er angelegt, genutzt, aufgedeckt, rotiert oder gelöscht wurde. Bei einer Nutzung stehen Run und Schritt dabei.

### Rechte

| Recht | Standard | Erlaubt |
| --- | --- | --- |
| `vault:read` | alle Rollen | Workspace-Einträge sehen, ohne Werte |
| `vault:write` | Admin | Einträge anlegen und beschreiben |
| `vault:rotate` | Admin | Werte ersetzen |
| `vault:delete` | Admin | Einträge löschen |
| `vault:reveal` | Admin | Werte von Workspace-Einträgen aufdecken |

Deine Einträge „Nur ich“ verwaltest du immer selbst, auch ohne diese Rechte.

### Im Cockpit, mit subkit und per MCP

- **Cockpit:** Einstellungen › Tresor.
- **subkit:** `subkit vault list`, `show`, `add`, `rotate`, `reveal`, `refresh`, `rm`, `attach` und `connector`. `add` und `rotate` lesen den Wert von stdin oder aus einer verdeckten Eingabe, nie aus Argumenten.
- **MCP:** `list_vault_items` und `get_vault_item` liefern nur Metadaten.
- **HTTP:** `/v1/vault`, siehe die HTTP-API.

### Sicherung und Umzug

Eine Sicherung des Servers braucht die Datenbank und den `MASTER_KEY`. Ohne ihn lassen sich die Werte nicht öffnen.
Ein Paket oder ein Umzug in einen anderen Workspace nimmt nur Namen und Metadaten mit, nie Werte. Einen Klartext-Export gibt es nicht.
