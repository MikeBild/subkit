---
slug: execution-identity-and-permission
summary: Erkenne, wer einen Lauf ausgelöst hat und was er darf.
section: operate
order: 4
audience: operator
---
## Ausführungsidentität und Berechtigung

Bei jedem Lauf zählen vier getrennte Dinge: wer ihn ausgelöst hat, womit er sich anmeldet, was er darf und was eine Person freigegeben hat. Dieses Kapitel brauchst du, wenn ein Workflow nur für bestimmte angemeldete Personen oder Apps laufen soll oder du einen Lauf im Nachhinein zuordnen willst. Danach weißt du, wo du die Identität eines Laufs findest und welche Angaben dafür nicht taugen.

### Die vier Begriffe

- `$caller` beantwortet, wer diesen Lauf authentifiziert hat.
- Konnektor-Zugangsdaten melden eine ausgehende Anfrage bei einem anderen Dienst an.
- RBAC, die rollenbasierte Rechteprüfung, entscheidet, welche Workflows und Ressourcen dieser Principal nutzen darf. Ein Principal ist die angemeldete Identität, also eine Person, eine App oder ein Schlüssel.
- Die Freigabe einer Person erlaubt für eine Umgebung eine geprüfte Reichweite der Wirkung.

Die vier hängen nicht voneinander ab. Zugangsdaten oder eine Freigabe erzeugen keine Aufruferidentität und ersetzen keine Rechteprüfung. Wer freigibt, muss nicht der Aufrufer des Laufs sein.

### Wer der Aufrufer ist

HTTP- und MCP-Läufe übernehmen den Aufrufer aus ihrem angemeldeten Principal. Vertrauenswürdige Webhook- und Zeitplan-Läufe ohne Aufrufer bekommen `null`. Wer sie eingerichtet oder freigegeben hat, wird dadurch nicht automatisch ihr Aufrufer. Untergeordnete Workflows behalten den Aufrufer des übergeordneten.

Soll ein Workflow nur für eine bestimmte angemeldete Identität laufen, setze `required_caller_kind` und `product_id`. Leite diese Identität nie aus Eingabefeldern oder `request_source` ab.

### Einen Lauf nachvollziehen

Über HTTP und MCP zeigt jeder Lauf Quelle, Status, Workflow-Version, Freigabe, Schrittnachweise und eine sichere Zusammenfassung unter `caller`. Sie nennt gespeicherten Principal, Produkt, Anmeldeart, Kanal und Ursprungslauf, aber keine Zugangsdaten und keine Sitzungskennungen. Fehlt die gespeicherte Identität, steht dort `kind: unknown`; ein Kanal allein identifiziert keinen Aufrufer.

Audit-Abfragen über HTTP und `list_audit` über MCP filtern nach Akteur und Trace. Diese Einträge lassen sich nur teilweise zuordnen und ergeben keine vollständige Zeitleiste eines Aufrufers. Die genauen Regeln und ihre Grenzen stehen in den eingebauten Hinweisen zu Kernkonzepten, Auth-Abläufen und REST-API.

### Im Chat: Entwurf, Lauf und Kosten

Ändert sich ein gespeicherter Entwurf, während du im Chat daran arbeitest, behält der Chat deine lokalen Änderungen. Speichern, Aktivieren und Ausführen sind getrennte Schritte mit eigenem Ergebnis. Übernimmst du einen Entwurf in DEV, startet ein einzelner Lauf mit den aufgezeichneten Testeingaben nur, wenn du **Danach einen Lauf starten** anhakst. Bittest du darum, nicht live auszuführen, unterbleibt dieser Lauf. In PROD braucht ein Live-Lauf eine ausdrückliche Anforderung.

Was tatsächlich geschehen ist, zeigt der aufgezeichnete Lauf. Die Modellkosten im Chat sind eine Schätzung aus der gemeldeten Nutzung beim Anbieter und den hinterlegten Preisen, keine Rechnung. Die Token-Zahl enthält Kontext, der über mehrere Modellaufrufe wiederholt gesendet wird. Kurze Versionshinweise findest du unter **Änderungen** im Kontomenü unten links; noch nicht veröffentlichte Änderungen stehen dort getrennt.
