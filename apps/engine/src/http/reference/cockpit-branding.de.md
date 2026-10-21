---
slug: cockpit-branding
summary: Passe Name, Logos und Farben des Cockpits für deinen Workspace an.
section: operate
order: 1
audience: operator
---
## Cockpit-Branding

Workspace-Administratoren mit `settings:write` und `identity:write` können unter
Settings → Branding das Wortzeichen, einen optionalen Untertitel, themenspezifische
Logos und eines von drei geprüften Farbpaletten-Paaren des angemeldeten Cockpits ändern.
Entwurfsvorschauen bleiben lokal, bis sie gespeichert werden. Zurücksetzen stellt das
bisherige SubKit-Erscheinungsbild wieder her. Konfiguriertes Branding behält einen
barrierefreien Hinweis „powered by SubKit“; Anmeldung, E-Mail und andere Clients behalten
ihre bisherige Identität.

Das Branding wird im PostgreSQL-Schema des Workspace gespeichert und zählt auf die
Speichergrenzen des Hostings. PNG-, JPEG- und WebP-Uploads sind auf 2 MiB und 4 Megapixel
begrenzt, werden dekodiert und zu einem Standbild-PNG mit höchstens 512 Pixeln pro Kante
normalisiert. Animationen, SVG, externe Bildadressen, Skripte und beliebiges CSS werden
abgelehnt. Die neue Kodierung entfernt Quell-Metadaten. Die Palettenauswahl erhält die
semantischen Statusfarben.

HTTP, sk CLI, MCP und Cockpit teilen sich denselben mandanteneigenen Branding-Vertrag,
dieselbe Normalisierung, dieselben Berechtigungen und optimistische Revisionen.
Authentifizierte Aufrufer lesen mit `GET /v1/tenant/branding`, speichern mit `PUT` und
setzen mit `DELETE` zurück. Schreibzugriffe erfordern sowohl `settings:write` als auch
`identity:write`; API-Schlüssel mit Scope behalten ihre Berechtigungsobergrenze.
Schreibzugriffe aus dem Browser behalten zusätzlich den CSRF-Schutz. Bei einem Konflikt
bleibt die gespeicherte Konfiguration erhalten; lade vor einem erneuten Versuch neu.
Logo-Abrufe sind an Workspace und Revision gebunden und wenden in jedem Client denselben
Rückgriff auf ein einzelnes Logo an.

Die CLI bietet `sk branding get`, `sk branding update <json-file|->`,
`sk branding reset <revision>` und `sk branding logo <light|dark> --output <file>`.
MCP stellt `get_tenant_branding`, `update_tenant_branding`,
`reset_tenant_branding` und `get_tenant_branding_logo` bereit. MCP-Änderungen behalten den
normalen Freigabeweg durch einen authentifizierten Menschen; beide Schreibberechtigungen
werden geprüft, bevor eine Freigabe angefordert wird. Gewöhnliche Lesezugriffe enthalten
Metadaten, während die ausdrückliche Logo-Operation normalisierte PNG-Bytes liefert. Die
generierten OpenAPI- und MCP-Eingabeschemas leiten sich aus dem gemeinsamen
Anfragevertrag ab. Visuelles Branding bleibt auf das angemeldete Cockpit beschränkt.

