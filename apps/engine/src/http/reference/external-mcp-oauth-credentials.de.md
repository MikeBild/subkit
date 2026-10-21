---
slug: external-mcp-oauth-credentials
summary: Verbinde externe MCP-Server, die OAuth-Client-Zugangsdaten verlangen.
section: operate
order: 8
audience: operator
---
## OAuth-Zugangsdaten für externe MCP-Server

Für externe MCP-Konnektoren mit `oauth2_client_credentials` oder `oauth2_private_key_jwt`
konfiguriere vor dem Verbinden die vertrauenswürdige Adresse des Autorisierungsservers als
`config.mcp.auth.issuer`. SubKit weigert sich, diese Zugangsdaten ohne diese Bindung zu verwenden.
Die Discovery kann ein Client-Secret oder eine signierte Assertion nicht an einen anderen
Autorisierungsserver umleiten.

Interaktives MCP-OAuth speichert den Aussteller des Autorisierungsservers zusammen mit den
verschlüsselten Client-Informationen und Tokens. Ältere gespeicherte Zugangsdaten ohne Aussteller
werden nicht wiederverwendet. Anbieter mit dynamischer Client-Registrierung können über das
OAuth-Setup des Konnektors eine neue Anmeldung starten. Die Wiederherstellung älterer
vertraulicher Clients bei Anbietern ohne dynamische Registrierung ist über die öffentlichen
Setup-APIs noch nicht verifiziert; geh nicht davon aus, dass die Eingabe eines Ausstellers
diese gespeicherten Zugangsdaten wiederherstellt. Halte solche Verbindungen aus dem Rollout
heraus, bis ihre Wiederherstellung verifiziert ist. Bearbeite gespeicherte Zugangsdaten nicht,
um diese Prüfung zu umgehen. Das Ändern der Discovery-Metadaten migriert bestehende Zugangsdaten
nicht, und eine neue Anmeldung erbt nie ein Refresh-Token, das von einem anderen Server ausgestellt
wurde. Prüfe Anbieterwechsel, bevor du sie autorisierst; die Bindung stellt nicht fest, dass
ein neu gewählter Anbieter vertrauenswürdig ist.

