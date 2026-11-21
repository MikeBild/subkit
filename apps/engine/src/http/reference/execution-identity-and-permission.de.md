---
slug: execution-identity-and-permission
summary: Erkenne, wer einen Run ausgelöst hat und was er darf.
section: operate
order: 4
audience: operator
---
## Ausführungsidentität und Berechtigung

Bei jedem Run zählen vier getrennte Dinge: wer ihn ausgelöst hat, womit er sich anmeldet, was er darf und was eine Person freigegeben hat. Dieses Kapitel brauchst du, wenn ein Workflow nur für bestimmte angemeldete Personen oder Apps laufen soll oder du einen Run im Nachhinein zuordnen willst. Danach weißt du, wo du die Identität eines Runs findest und welche Angaben dafür nicht taugen.

### Die vier Begriffe

- `$caller` beantwortet, wer diesen Run authentifiziert hat.
- Connector-Zugangsdaten melden eine ausgehende Anfrage bei einem anderen Dienst an.
- RBAC, die rollenbasierte Rechteprüfung, entscheidet, welche Workflows und Ressourcen dieser Principal nutzen darf. Ein Principal ist die angemeldete Identität, also eine Person, eine App oder ein Schlüssel.
- Die Freigabe einer Person erlaubt für eine Umgebung eine geprüfte Reichweite der Wirkung.

Die vier hängen nicht voneinander ab. Zugangsdaten oder eine Freigabe erzeugen keine Aufruferidentität und ersetzen keine Rechteprüfung. Wer freigibt, muss nicht der Aufrufer des Runs sein.

### Wer der Aufrufer ist

HTTP- und MCP-Runs übernehmen den Aufrufer aus ihrem angemeldeten Principal. Vertrauenswürdige Webhook- und Zeitplan-Runs ohne Aufrufer bekommen `null`. Wer sie eingerichtet oder freigegeben hat, wird dadurch nicht automatisch ihr Aufrufer. Untergeordnete Workflows behalten den Aufrufer des übergeordneten.

Soll ein Workflow nur für eine bestimmte angemeldete Identität laufen, setze `required_caller_kind` und `product_id`. Leite diese Identität nie aus Eingabefeldern oder `request_source` ab.

### Einen Run nachvollziehen

Über HTTP und MCP zeigt jeder Run Quelle, Status, Workflow-Version, Freigabe, Schrittnachweise und eine sichere Zusammenfassung unter `caller`. Sie nennt gespeicherten Principal, Produkt, Anmeldeart, Kanal und Ursprungslauf, aber keine Zugangsdaten und keine Sitzungskennungen. Fehlt die gespeicherte Identität, steht dort `kind: unknown`; ein Kanal allein identifiziert keinen Aufrufer.

Audit-Abfragen über HTTP und `list_audit` über MCP filtern nach Akteur und Trace. Diese Einträge lassen sich nur teilweise zuordnen und ergeben keine vollständige Zeitleiste eines Aufrufers. Die genauen Regeln und ihre Grenzen stehen in den eingebauten Hinweisen zu Kernkonzepten, Auth-Abläufen und REST-API.

### Runs von Aufgaben

Eine Aufgabe ist ein Ziel mit Grenzen, auf das SubKit alleine hinarbeitet. Für den Run einer Aufgabe lesen sich die vier Begriffe so:

- **Wer er ist.** Ein Run handelt als die Besitzerin der Aufgabe, auch wenn ein Zeitplan ihn gestartet hat und niemand angemeldet ist. Jeder Eintrag des Runs trägt die Herkunftsart „Aufgaben-Run“ mit Aufgabe und Run. So unterscheidest du ihn von dem, was die Besitzerin von Hand getan hat.
- **Was er darf.** Die Rolle der Besitzerin ist die Obergrenze. Innerhalb davon darf der Run nur die Workflows starten und die Connectors aufrufen, die an die Aufgabe gebunden sind, in der Umgebung der Aufgabe. Er kann keine Workflows anlegen oder ändern und keinen Workflow mit `execution_privacy: sensitive` starten.
- **Was eine Person freigegeben hat.** Ein Start von Hand erlaubt diesen einen Run. Ein Start nach Zeitplan braucht die Dauererlaubnis der Aufgabe. Sie hängt am Inhalt der Aufgabe: Jede Änderung an Ziel, Plan, Bindungen, Zeitplan, Grenzen oder Umgebung beendet sie. Ein neuer Name nicht. Ob ein gebundener Workflow schreiben darf, entscheidet die Freigabe dieses Workflows: Deckt eine gültige Freigabe den Start, schreibt der Workflow ohne Rückfrage, auch wenn die Aufgabe keine Dauererlaubnis hat. Sonst werden seine Schreibzugriffe zurückgehalten, und der Run fragt.
- **Wer freigegeben hat.** Die Dauererlaubnis erteilt eine Person, die im Browser im Cockpit angemeldet ist, die Besitzerin oder ein Admin. Diese Person steht als Freigebende im Eintrag und wird nicht zum Aufrufer der Runs.

Vor jeder Hintergrund-Runde prüft SubKit erneut, dass die Besitzerin noch aktiv ist, der Run noch offen ist, die Aufgabe weder pausiert noch archiviert ist und die Dauererlaubnis des Runs nicht widerrufen wurde. Trifft eines davon nicht zu, läuft die Runde nicht.

Wer in einen Run hineinschreibt, erweitert ihn nicht. Die Besitzerin und Admins können schreiben. Für ihre Runden gelten dieselben Grenzen. Schreibzugriffe, die ein Run zurückhält, gibt die Besitzerin oder ein Admin frei. Ausgeführt werden sie mit den Rechten des Runs, nicht mit denen des Admins, und der Audit-Trail nennt die Person, die entschieden hat. Ein Ergebnis bestätigt oder verwirft eine Person, die im Browser im Cockpit angemeldet ist, nicht mit einem API-Schlüssel, in `sk` oder aus einem KI-Client.

Im Audit-Trail steht die Hintergrundarbeit eines Runs als System mit dem Zeitplan oder der Warteschlange als Quelle. Erlaubnisse, Bestätigungen und Abbrüche nennen die Person, die gehandelt hat. Die Einträge enthalten Kennungen, Zustände und Grund-Codes, nie den Text des Ziels oder eine Antwort.

### Im Chat: Entwurf, Run und Kosten

Ändert sich ein gespeicherter Entwurf, während du im Chat daran arbeitest, behält der Chat deine lokalen Änderungen. Speichern, Aktivieren und Ausführen sind getrennte Schritte mit eigenem Ergebnis. Übernimmst du einen Entwurf in DEV, startet ein einzelner Run mit den aufgezeichneten Testeingaben nur, wenn du **Danach einen Run starten** anhakst. Bittest du darum, nicht live auszuführen, unterbleibt dieser Run. In PROD braucht ein Live-Run eine ausdrückliche Anforderung.

Was tatsächlich geschehen ist, zeigt der aufgezeichnete Run. Die Modellkosten im Chat sind eine Schätzung aus der gemeldeten Nutzung beim Anbieter und den hinterlegten Preisen, keine Rechnung. Die Token-Zahl enthält Kontext, der über mehrere Modellaufrufe wiederholt gesendet wird. Kurze Versionshinweise findest du unter **Änderungen** im Kontomenü unten links; noch nicht veröffentlichte Änderungen stehen dort getrennt.
