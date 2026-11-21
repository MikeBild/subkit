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

### Anmeldung mit Client-Zugangsdaten

Für Connectors mit `oauth2_client_credentials` oder `oauth2_private_key_jwt` trägst du vor dem Verbinden die vertrauenswürdige Adresse des Autorisierungsservers als `config.mcp.auth.issuer` ein. Ohne diese Bindung verwendet SubKit die Zugangsdaten nicht. Die Discovery, das automatische Nachschlagen der Server-Adressen, kann ein Client-Secret oder eine signierte Assertion dann nicht an einen anderen Autorisierungsserver umleiten.

### Interaktive Anmeldung

Bei interaktivem MCP-OAuth speichert SubKit den Aussteller des Autorisierungsservers zusammen mit den verschlüsselten Client-Daten und Tokens. Ältere gespeicherte Zugangsdaten ohne Aussteller verwendet SubKit nicht weiter. Bei Anbietern mit dynamischer Client-Registrierung startest du über das OAuth-Setup des Connectors eine neue Anmeldung.

### Ältere Zugangsdaten ohne dynamische Registrierung

Ob sich ältere vertrauliche Clients bei Anbietern ohne dynamische Registrierung über die öffentlichen Setup-APIs wiederherstellen lassen, ist noch nicht geprüft. Geh nicht davon aus, dass ein nachgetragener Aussteller diese Zugangsdaten wiederherstellt. Nimm solche Verbindungen erst in Betrieb, wenn ihre Wiederherstellung geprüft ist. Bearbeite gespeicherte Zugangsdaten nicht, um diese Prüfung zu umgehen.

Geänderte Discovery-Metadaten übertragen bestehende Zugangsdaten nicht. Eine neue Anmeldung übernimmt nie ein Refresh-Token, das ein anderer Server ausgestellt hat. Prüfe einen Anbieterwechsel, bevor du ihn autorisierst: Die Bindung sagt nichts darüber, ob ein neu gewählter Anbieter vertrauenswürdig ist.
