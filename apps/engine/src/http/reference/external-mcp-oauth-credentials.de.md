---
slug: external-mcp-oauth-credentials
summary: Binde externe MCP-Server über OAuth an, ohne dass Geheimnisse umgeleitet werden.
section: operate
order: 8
audience: operator
---
## OAuth-Zugangsdaten für externe MCP-Server

Manche externen MCP-Server verlangen eine OAuth-Anmeldung, bevor SubKit ihre Tools nutzen darf. Du brauchst dieses Kapitel, wenn du einen solchen Server als Connector einrichtest oder ältere gespeicherte Anmeldungen weiterverwenden willst. Danach ist jede Anmeldung an einen festen Autorisierungsserver gebunden, und Client-Secrets gehen nur dorthin.

OAuth ist das übliche Verfahren, mit dem ein Dienst einem anderen Zugriff gewährt. Der Autorisierungsserver stellt dafür die Tokens aus.

Ein entfernter Autorisierungsserver muss HTTPS nutzen. Ein lokaler auf `localhost`, `127.0.0.1` oder `[::1]`, den ein lokaler MCP-Server ankündigt, funktioniert auch über `http`. Mehr dazu unter „Lokale Dienste verbinden“.

### Anmeldung mit Client-Zugangsdaten

Für Connectors mit `oauth2_client_credentials` oder `oauth2_private_key_jwt` trägst du vor dem Verbinden die vertrauenswürdige Adresse des Autorisierungsservers als `config.mcp.auth.issuer` ein. Ohne diese Bindung verwendet SubKit die Zugangsdaten nicht. Die Discovery, das automatische Nachschlagen der Server-Adressen, kann ein Client-Secret oder eine signierte Assertion dann nicht an einen anderen Autorisierungsserver umleiten.

### Interaktive Anmeldung

Bei interaktivem MCP-OAuth speichert SubKit den Aussteller des Autorisierungsservers zusammen mit den verschlüsselten Client-Daten und Tokens. Ältere gespeicherte Zugangsdaten ohne Aussteller verwendet SubKit nicht weiter. Bei Anbietern mit dynamischer Client-Registrierung startest du über das OAuth-Setup des Connectors eine neue Anmeldung.

Du kannst einen solchen Connector speichern, bevor sich jemand angemeldet hat, auch aus einem Chat. Er wartet dann im Zustand „Anmeldung nötig“, und ein 401 des Servers vor der Anmeldung verhindert das Speichern nicht. Der Anmeldelink am Connector oder im Chat startet die Browser-Anmeldung mit PKCE:

- **Dynamische Client-Registrierung:** Du trägst keinen Client ein. Bei der ersten Anmeldung registriert SubKit einen Client beim Autorisierungsserver und speichert ihn mit dem Aussteller. Erlaubt der Server öffentliche Clients (`none` in `token_endpoint_auth_methods_supported`), registriert sich SubKit als öffentlicher Client mit PKCE und speichert kein Secret. Sonst registriert es einen vertraulichen Client. Eine wiederholte oder abgebrochene Anmeldung verwendet diesen Client weiter und registriert keinen neuen.
- **Vorab registrierter Client:** Eine Client-ID ohne Secret ist Konfiguration, kein Geheimnis. Setze `config.mcp.auth.client_id`, optional `token_endpoint_auth_method: "none"`. Ein Client-Secret geht immer über das sichere Formular. Ohne `config.mcp.auth.issuer` ermittelt SubKit beim Speichern den Autorisierungsserver aus den Metadaten des Servers und bindet den Client daran. Klappt das nicht, lehnt SubKit das Speichern mit `mcp_oauth_issuer_unresolved` ab. Trag dann `config.mcp.auth.issuer` mit der Adresse des Autorisierungsservers selbst ein.

### Ältere Zugangsdaten ohne dynamische Registrierung

Ob sich ältere vertrauliche Clients bei Anbietern ohne dynamische Registrierung über die öffentlichen Setup-APIs wiederherstellen lassen, ist noch nicht geprüft. Geh nicht davon aus, dass ein nachgetragener Aussteller diese Zugangsdaten wiederherstellt. Nimm solche Verbindungen erst in Betrieb, wenn ihre Wiederherstellung geprüft ist. Bearbeite gespeicherte Zugangsdaten nicht, um diese Prüfung zu umgehen.

Geänderte Discovery-Metadaten übertragen bestehende Zugangsdaten nicht. Eine neue Anmeldung übernimmt nie ein Refresh-Token, das ein anderer Server ausgestellt hat. Prüfe einen Anbieterwechsel, bevor du ihn autorisierst: Die Bindung sagt nichts darüber, ob ein neu gewählter Anbieter vertrauenswürdig ist.
