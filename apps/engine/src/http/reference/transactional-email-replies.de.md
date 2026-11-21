---
slug: transactional-email-replies
summary: Bestätige eine Formularanfrage mit genau einer E-Mail an die anfragende Person.
section: work
order: 8
audience: public
---
## Per E-Mail auf eine signierte Anfrage antworten

Jemand schickt über dein Formular eine Anfrage, etwa um Zugang, und soll eine Bestätigung per E-Mail bekommen: genau eine und nur an die eigene Adresse.
Dieses Kapitel zeigt Entwicklern, wie ein Workflow diese Antwort als reinen Text über Gmail schickt.
Danach prüft SubKit vor jedem Versand Herkunft, Freigabe und Empfänger, und eine doppelt gesendete Anfrage erzeugt keine zweite Mail.

Signiert heißt: Deine Website oder dein Backend rechnet mit einem geheimen Schlüssel eine Prüfsumme über die Anfrage.
SubKit rechnet sie nach und startet nichts, wenn sie nicht passt.
Absender, Vorlage und Grenzen prüft eine Person, bevor etwas gesendet wird.

Der Weg ist immer gleich: **signierte Anfrage → geprüfter Workflow → Freigabe → eine Antwort**.

### Was du brauchst

- Eine Gmail-Verbindung (Connector) in deinem Arbeitsbereich.
- Eine signierte Quelle, also dein Formular-Backend, das Anfragen im Format Standard Webhooks schickt. Standard Webhooks ist ein offenes Format für signierte HTTP-Meldungen.
- Eine Person, die den Workflow freigibt.
- Einen Betreiber, der den Workflow vor der Aktivierung prüft.

Überspring nie die Signaturprüfung.
Nutze für die Quelle nie einen öffentlichen API-Schlüssel oder Zugangsdaten aus dem Browser.

### Den Workflow einrichten

1. Setze `execution_privacy: sensitive` und ein striktes Eingabeschema mit begrenzten Längen.
2. Füge genau einen Gmail-Sendeschritt mit reinem Text hinzu. Sein Request-Body enthält nur `raw`.
3. Behalte Absender, Verbindung und Vorlage im Workflow. Die Anfrage wählt nur den geprüften ursprünglichen Empfänger.
4. Ergänze am Gmail-Schritt das Profil `transactional_delivery` und `max_retries: 0`.
5. Leite `max_body_bytes` aus der begrenzten Vorlage ab, nicht aus dem größten erlaubten Wert.

Der signierte JSON-Body muss die UUID der Anfrage und den Ereignistyp enthalten.
Eingabepfade beginnen bei `body`.
Für einen Body mit `event`, `reference` und `contact.address` sieht das Profil so aus:

```json
{
  "kind": "gmail_transactional",
  "webhook_id": "<reviewed-binding-uuid>",
  "event_type": "registration.requested",
  "event_type_input": "body.event",
  "request_id_input": "body.reference",
  "recipient_input": "body.contact.address",
  "from": "sender@example.test",
  "content_type": "text/plain",
  "max_body_bytes": 8192
}
```

`max_body_bytes` misst das fertige Gmail-JSON einschließlich des Aufschlags durch Base64.
Dieser Schritt kann nicht seitenweise lesen und nicht an mehrere Empfänger verteilen. Ein zweites Profil mit festem Empfänger und Antwortfilter unterstützt er ebenfalls nicht.

Du kannst diesen Workflow auch im Cockpit-Chat beschreiben. Der Chat kennt dieses Profil und seine Grenzen.

### Binden und prüfen

1. Lege im selben Arbeitsbereich eine aktive Standard-Webhooks-Bindung für den Workflow an. Die Bindung verknüpft die Quelle mit dem Workflow. Nutze genau den geprüften Ereignistyp und ein eigenes Signaturgeheimnis.
2. Speichere in der Quelle die UUID der Anfrage und die ursprünglichen Daten vor dem Senden.
3. Sende die UUID im signierten Body und in `webhook-id`.
4. Lass Version, Absender, Verbindung, signierte Quelle, Feldpfade, Byte-Grenze und Run-Grenzen vom Betreiber prüfen.
5. Aktiviere den Workflow und gib ihn frei.

### Die Antwort testen

1. Sende eine Testanfrage an einen kontrollierten Empfänger.
2. Prüfe, dass die signierte Quelle nach der Aktivierung noch existiert.
3. Verbinde das öffentliche Formular.
4. Sende dieselbe Anfrage zweimal und prüfe, dass genau eine Nachricht ankommt.

### Die Signatur berechnen

Deine Quelle signiert jede Anfrage mit HMAC-SHA256, einer Prüfsumme mit geheimem Schlüssel.
Nutze das Geheimnis unverändert als UTF-8-Schlüssel. SubKit entfernt kein Präfix `whsec_` und dekodiert den Schlüssel nicht aus Base64.

1. Berechne HMAC-SHA256 über `id.timestamp.rawBody`.
2. Kodiere das Ergebnis in Base64.
3. Sende `webhook-signature: v1,<base64>`.

Sende auch passende Header für Zeitstempel und Ereignistyp.
Der Header allein ist nicht signiert. Deshalb muss der Ereignistyp auch zum geprüften Feld im signierten Body passen.

### Wie es weitergeht

Vor dem Senden prüft die Engine Freigabe, signierte Quelle und Empfänger erneut.
CC, BCC und zusätzliche Empfänger lehnt sie ab.

Gut zu wissen:

- Ein fehlgeschlagener oder unklarer Versand wird nie automatisch wiederholt. Es gibt kein Wiederholen und kein Zurücksetzen.
- Jede ursprüngliche Anfrage bekommt höchstens eine Antwort, über Workflow-Versionen und Runs hinweg.
- Eine Signatur bestätigt nur, woher die Anfrage kommt. Erst die Freigabe erlaubt dem Workflow das Senden.
- Eine wiederholte Übergabe behält dieselben Daten und dieselbe ID und erneuert nur Zeitstempel und Signatur. Geänderter Inhalt unter derselben ID wird abgelehnt.

### Eine E-Mail je Eintrag einer Warteschlange senden

Manchmal kann die Quelle keinen Webhook schicken, etwa weil ihr Server keine Verbindung nach außen aufbauen darf.
Dann legt sie Nachrichten in eine Warteschlange, und ein Workflow mit Zeitplan holt sie mit `outbox_delivery` ab.
Ein früherer, fester Lese-`GET`-Schritt liefert den nächsten Eintrag. Der Mail-Schritt deklariert `{kind: "gmail_outbox", source_step_id, recipient_field, item_id_field, from, content_type: "text/plain", max_body_bytes, max_per_day}`. Nutze `execution_privacy: sensitive` und `max_retries: 0`.

- Der Empfänger stammt nur aus dieser Antwort der Warteschlange im selben Run. Die Engine vergleicht ihn vor dem Senden mit der Nachricht.
- Jeder Eintrag bekommt höchstens einen Versuch, über Workflow-Versionen und Runs hinweg. Ein unklares Ergebnis wird nie automatisch erneut gesendet.
- `max_per_day` begrenzt die Nachrichten innerhalb von 24 Stunden.
- Wer die Warteschlange füllen kann, bestimmt die Empfänger. Gib nur eine Warteschlange frei, der du vertraust; der Freigabedialog nennt sie.

### Ergebnisse prüfen

`GET /v1/workflows/{id}/transactional-mail-receipts?limit=20&offset=0` erfordert `workflow:read` für diesen Workflow.

Der Aufruf liefert:

- IDs von Anfrage, Run und Schritt
- Status und Zeitstempel

Adresse des Antragstellers und Nachrichteninhalt liefert er nicht.

Der Verlauf hält fest, wann ein Versand vorgemerkt wurde und wie er ausging.

| Status | Bedeutung |
| --- | --- |
| `sent` | Gmail hat mit einer Nachrichten-ID geantwortet. Das bestätigt die Annahme durch Gmail, nicht die Zustellung im Posteingang. |
| `attempted`, `delivery_unknown` | Der Betreiber prüft den Fall. |

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| Der Status ist `attempted` oder `delivery_unknown` | Der Betreiber prüft den Fall. Es gibt kein automatisches erneutes Senden und keinen Endpunkt zum Zurücksetzen. |
| Eine Anfrage wird abgelehnt, obwohl die Signatur stimmt | Prüfe, ob der Ereignistyp im signierten Body zum Header und zum geprüften Feldpfad passt und ob die UUID im Body und in `webhook-id` übereinstimmt. |
| Eine wiederholte Übergabe wird abgelehnt | Der Inhalt unter dieser signierten ID hat sich geändert. Sende dieselben Daten und dieselbe ID erneut und erneuere nur Zeitstempel und Signatur. |
| Der Versand wird abgelehnt, weil Empfänger-Header vorhanden sind | Entferne CC, BCC und zusätzliche Empfänger-Header. Nur der geprüfte ursprüngliche Empfänger ist erlaubt. |
| Die signierte Quelle ist nach der Aktivierung verschwunden | Lege eine neue Bindung an und aktiviere eine geprüfte Workflow-Version, die ihre tatsächliche ID referenziert. |
