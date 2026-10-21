---
slug: transactional-email-replies
summary: Lass einen Workflow per E-Mail an den Absender einer signierten Anfrage antworten.
section: work
order: 8
audience: public
---
## Transaktionale E-Mail-Antworten

Ein Gmail-Request-Schritt kann das ausdrückliche Profil `transactional_delivery` verwenden, um an
die Adresse in einer ursprünglichen signierten Anfrage zu antworten. Das ist wiederverwendbar für
Zugangsanfragen, Registrierungen und andere angeforderte Antworten. Ereignisnamen und Feldpfade
sind konfigurierbar; keine Website, kein Produkt und kein Antragsteller ist in die Engine eingebaut.
`report_delivery` mit festem Empfänger folgt weiterhin seinen bestehenden Regeln.

### Den Workflow erstellen

Verwende sensible Ausführungsprivatsphäre, ein striktes Eingabeschema mit begrenzten Längen und
einen Nur-Text-Gmail-Sendeschritt. Behalte Absender, Verbindung und Vorlage im geprüften
Workflow; die Eingabe des Besuchers wählt nur den geprüften ursprünglichen Empfänger.
Die Nutzlast muss ihre UUID und ihren Ereignistyp im signierten JSON-Body enthalten.
Ein Ereignis-Body mit `event`, `reference` und `contact.address` kann zum Beispiel Folgendes verwenden:

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

Setze das Profil auf den Gmail-Request-Schritt neben `max_retries: 0`. Sein Request-Body
darf nur `raw` enthalten. Paginierung, Fan-out, generische Grenzen, gleichzeitige Profile mit
festem Empfänger sowie Antwortauswahl oder -filterung werden nicht unterstützt. Eingabepfade
beginnen bei `body`, durchlaufen eigene Objekteigenschaften und lehnen Prototyp-Schlüssel ab. Wähle
eine Obergrenze für die Request-Bytes anhand der begrenzten Vorlage, nicht anhand des größten
erlaubten Werts. Die Obergrenze misst das serialisierte UTF-8-Gmail-JSON einschließlich des Base64-Overheads.

### Binden und prüfen

1. Lege für diesen Workflow im selben Mandanten eine aktive Standard-Webhooks-Bindung an.
   Konfiguriere genau den geprüften Ereignistyp und ein eigenes Signaturgeheimnis. Verwende
   nie übersprungene Verifikation, einen öffentlichen API-Schlüssel oder Browser-Zugangsdaten.
2. Persistiere die Anfrage-UUID und die ursprüngliche Nutzlast vor der Übergabe. Sende die UUID
   sowohl im signierten Body als auch in `webhook-id`. Signiere `id.timestamp.rawBody` und sende die
   passenden Header für Zeitstempel, Signatur und Ereignistyp. Der Ereignistyp muss außerdem
   mit dem geprüften Feld im signierten Body übereinstimmen: Der Header allein ist nicht signiert.
3. Bereite den Workflow normal vor und validiere ihn. Der Betreiber prüft die genaue
   Version, den Absender, die Verbindung, die signierte Quelle und die Feldpfade, die Byte-Obergrenze und die
   Lauf-/Zeitgrenzen. Eine Signatur authentifiziert den Eingang; sie gewährt keine Wirkungen.
   Erzwinge einen sensiblen Workflow nicht durch eine fehlende Vorbereitung und gib keinen
   statischen Berichtsempfänger frei, während tatsächlich jemand anderes adressiert wird.
4. Aktiviere erst nach diesen Prüfungen und der normalen menschlichen Prüfung der
   Ausführungsautorität. Bestätige das Verhalten mit einem kontrollierten Empfänger, verbinde dann das öffentliche
   Formular und verifiziere, dass dieselbe Anfrage zweimal genau eine Nachricht erzeugt.

Separat verwaltete eingehende Bindungen bleiben unabhängig vom Trigger der Definition.
Die Aktivierung per Request oder Zeitplan entfernt nur rückwärts gebundene Webhook-Trigger;
die Webhook-Aktivierung aktualisiert nur ihre eigene rückwärts gebundene Bindung. Sie
schreibt oder entfernt nie CRUD-Bindungen, deren Signaturgeheimnisse oder Ereignisfilter.
Das Archivieren oder Löschen eines Workflows entfernt weiterhin alle seine eingehenden Bindungen. Verifiziere nach der
Aktivierung, dass die geprüfte signierte Quelle noch vorhanden ist, bevor du ein öffentliches Formular
freischaltest. Eine entfernte Quelle erfordert eine neue Bindung und eine normal
geprüfte Workflow-Version, die ihre tatsächliche ID referenziert; verwende nie eine veraltete ID wieder und
schwäche die Signaturverifikation nie ab.

Beim Dispatch prüft die Engine Autorität, Quellherkunft, aktive Bindung,
ursprüngliche Eingabeidentität, tatsächlichen MIME-Empfänger/-Absender/-Typ und Request-Größe erneut. Ein
Nutzlastfeld, das Herkunft vortäuscht, wird ignoriert. On-Demand-Aufrufe, untergeordnete
Workflows und konkrete einmalige Tool-Freigaben können die signierte
Zulassung und die geprüfte wiederkehrende Autorität nicht ersetzen. CC/BCC und zusätzliche Empfänger-Header
werden abgelehnt. Die ausgehende Anfrage kann keinen Weiterleitungen folgen und nicht automatisch wiederholt werden.

Der bestehende Signierer von SubKit verwendet die gespeicherte Geheimniszeichenkette unverändert als UTF-8-HMAC-Schlüssel.
Berechne HMAC-SHA256 über `id.timestamp.rawBody`, kodiere das Ergebnis in Base64 und
sende `webhook-signature: v1,<base64>`. Es gibt kein automatisches Entfernen des Präfixes `whsec_`
und keine Base64-Dekodierung des Schlüssels. Verwende in einem externen Adapter genau diese Schlüssel-Bytes; der
Protokollname einer Bibliothek allein garantiert keine Interoperabilität.

### Ergebnisse prüfen

`GET /v1/workflows/{id}/transactional-mail-receipts?limit=20&offset=0` erfordert
`workflow:read` für diesen Workflow. Es liefert Anfrage-/Ausführungs-/Schritt-IDs, Status und
Zeitstempel, ohne Antragstelleradresse oder MIME. Der öffentliche OpenAPI-Vertrag enthält
diese Leseoperation. Das Audit erfasst außerdem Reservierung und Abrechnung.

Eine Reservierung wird atomar vor dem Netzwerkzugriff geschrieben. Der eindeutige Schlüssel der Reservierung ist
Mandant, Workflow und ursprüngliche Anfrage-UUID, über Workflow-Versionen und Ausführungs-IDs hinweg.
Sie überlebt die Bereinigung der Ausführung; das Löschen von Workflow oder Mandant entfernt sie.
`sent` erfordert eine erfolgreiche Gmail-Antwort mit einer Nachrichten-ID und bestätigt die
Annahme durch die API, nicht die Zustellung im Posteingang. `attempted` und `delivery_unknown` erfordern die Prüfung
durch den Betreiber. Ein Absturz, Timeout oder eine mehrdeutige Antwort autorisiert nie ein automatisches
erneutes Senden. Dieser Endpunkt hat keine Operation zum Wiederholen oder Zurücksetzen. Wiederholungen der Übergabe
durch den Produzenten behalten genau dieselbe Nutzlast und ID und erneuern nur Zeitstempel/Signatur; geänderter
Inhalt unter einer zuvor zugelassenen signierten ID wird abgelehnt.

### Modell- und Authoring-Verhalten

Der mitgelieferte Skill zur Workflow-Erstellung und das Webhook-Wissen erklären dieses Profil,
seine Grenzen und die Abhilfen bei Ablehnungen. Die generierte Agent-Dokumentation und die OpenAPI-Schemas
beschreiben denselben Vertrag. Die Bestätigung von Mandantenwissen bleibt ein
menschlicher Prüfschritt; Quelländerungen geben Mandantenmaterial nicht stillschweigend frei.
Tool-Paletten, einschließlich MCP-Workflow-Aliasse, validieren Objektschemas, bevor sie einen Anbieter aufrufen. Inkompatible
Root-Kombinatoren/-Referenzen werden ausgelassen, ohne die Workflow-Validierung abzuschwächen;
verwende die generische Workflow-Operation. Verbleibende Schemafehler werden als
Schema-Inkompatibilität klassifiziert, nicht als Nichtverfügbarkeit von Netzwerk/Anbieter.
