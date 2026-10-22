---
slug: execution-identity-and-permission
summary: Wer einen Lauf ausführt und welche Rechte dabei gelten.
section: operate
order: 4
audience: operator
---
## Ausführungsidentität und Berechtigung

Der Chat behält lokale Workflow-Änderungen, wenn sich ein gespeicherter Entwurf gleichzeitig
ändert. Speichern, Aktivieren und Ausführen sind getrennte Ergebnisse. Nachdem du einen
Entwurf in DEV übernommen hast, startet ein Einzellauf mit seinen aufgezeichneten Testeingaben nur,
wenn du **Danach einen Lauf starten** anhakst. Eine Bitte, nicht live auszuführen, verhindert
diese Fortsetzung. PROD erfordert eine ausdrückliche Anforderung zur
Live-Ausführung. Der aufgezeichnete Lauf zeigt, was tatsächlich geschehen ist.

Die Modellkosten des Chats sind eine ungefähre Berechnung aus gemeldeter Anbieternutzung und
konfigurierten Preisen, keine Rechnung. Die Token-Anzahl enthält wiederholten Kontext über
mehrere Modellaufrufe hinweg. Öffne **Changes** im Kontomenü unten links für kurze
Versionshinweise; unveröffentlichte Änderungen werden separat aufgeführt.

`$caller` beantwortet, wer diese Ausführung authentifiziert hat. Konnektor-Zugangsdaten
authentifizieren eine ausgehende Anfrage an einen anderen Dienst. RBAC entscheidet, welche
Workflows und Ressourcen dieser Principal verwenden darf. Die menschliche Freigabe erlaubt eine
geprüfte Wirkungsgrenze für eine Umgebung. Diese vier Konzepte sind unabhängig voneinander:
Zugangsdaten oder eine Freigabe erzeugen keine Aufruferidentität und ersetzen keine Autorisierung,
und der Freigebende muss nicht der Aufrufer der Ausführung sein.

HTTP- und MCP-Läufe leiten die Aufruferidentität aus ihrem authentifizierten Principal ab.
Vertrauenswürdige aufruferlose Webhook- und geplante Läufe erhalten `null`; die Person, die sie
konfiguriert oder freigegeben hat, ist nicht automatisch ihr Aufrufer. Untergeordnete Workflows
behalten den Aufrufer des übergeordneten. Verwende `required_caller_kind` und `product_id`,
wenn ein Workflow eine bestimmte authentifizierte Identität verlangt, und leite eine solche
nie aus Eingabefeldern oder `request_source` ab.

Die Laufinspektion zeigt über HTTP und MCP Quelle, Status, Workflow-Version, Ausführungsautorität,
Schrittnachweise und eine sichere `caller`-Zusammenfassung. Die Zusammenfassung nennt den
gespeicherten Principal, das Produkt, die Authentifizierungsmethode, den Kanal und den
Ursprungslauf, ohne Zugangsdaten oder Sitzungskennungen offenzulegen. Eine fehlende gespeicherte
Identität ist `kind: unknown`; ein Kanal allein kann keinen Aufrufer identifizieren.
HTTP-Audit-Abfragen und MCP `list_audit` können nach Akteur und Trace filtern. Diese Einträge
bieten eine teilweise Korrelation, keine vollständige Aufrufer-Zeitleiste. Den Vertrag und seine
Grenzen findest du in den eingebauten Hinweisen zu Kernkonzepten, Auth-Abläufen und REST-API.

