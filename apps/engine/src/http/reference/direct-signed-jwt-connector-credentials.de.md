---
slug: direct-signed-jwt-connector-credentials
summary: Authentifiziere Konnektoren bei APIs, die ein signiertes JWT direkt akzeptieren.
section: operate
order: 9
audience: operator
---
## Direkte signierte JWT-Konnektor-Zugangsdaten

Einige Ressourcen-APIs akzeptieren ein signiertes JWT direkt im Header `Authorization: Bearer`.
Das unterscheidet sich von OAuth `private_key_jwt`: Ein direktes signiertes JWT wird an die
Ressourcen-API selbst gesendet und geht nie an einen Token-Endpunkt. SubKit erzeugt es für die
ausgehende Anfrage, hält es nur im Speicher und legt es weder in einem Workflow noch in einem
Audit-Eintrag oder Log ab.

Die Konnektorkonfiguration enthält die öffentliche Signaturrichtlinie: Algorithmus (`ES256`
oder `RS256`), Audience, optionaler Aussteller, Subject, Schlüssel-ID, wörtliche benutzerdefinierte Claims
und eine Lebensdauer von 60–3600 Sekunden. Die Konnektor-Zugangsdaten enthalten nur den verschlüsselten
privaten Schlüssel. SubKit setzt `iat` und `exp`; sie können nicht als benutzerdefinierte
Claims gesetzt werden. Ersetze die Zugangsdaten über die normale Konnektor-Zugangsdatenmaske, um
einen Schlüssel zu rotieren, und verifiziere ihn dann mit der authentifizierten Probe des Konnektors.

Die eingebaute Vorlage **App Store Connect** ist ein Konnektor mit direktem signiertem JWT für
`https://api.appstoreconnect.apple.com`. Die Richtlinie der Vorlage ist fest auf `ES256`, die Audience
`appstoreconnect-v1` und eine Lebensdauer von fünf Minuten gesetzt. Füge den privaten `.p8`-Schlüssel als
Zugangsdatum hinzu und konfiguriere die öffentliche Key ID. Setze bei einem Team-Schlüssel die App-Store-Connect-Issuer-ID
als `issuer`; lass bei einem individuellen Schlüssel `issuer` weg und setze
`subject` auf `user`. Die erste Probe ist `GET /v1/apps`. Konfiguriere für diesen Konnektor weder OAuth,
noch einen Token-Endpunkt, noch eine OAuth-Client-Assertion.

Die Vorlage ermittelt Endpunkte aus dem offiziellen OpenAPI-ZIP-Download von Apple.
Die Discovery akzeptiert eine einzelne JSON- oder YAML-Spezifikation in einem Archiv, begrenzt
komprimierte und extrahierte Inhalte auf 16 MiB und lehnt mehrdeutige Archive ab.
Der entstehende Endpunktkatalog steht Agents zur Verfügung; die Konnektor-Dokumentation
kann außerdem mit `POST /v1/connectors/{id}/docs/ingest` importiert werden, mit
`source_type: "openapi"` und der extrahierten Spezifikation als `content`.

### Einen Konnektor mit signiertem JWT einrichten

Wähle im Cockpit **Create → Connector → App Store Connect** und öffne dann den
vorhandenen Bearbeitungsdialog des Konnektors. Gib die öffentliche Key ID und entweder die Issuer-ID
(Team-Schlüssel) oder das Subject `user` (individueller Schlüssel) ein. Füge den privaten Schlüssel in das
Feld für den privaten Schlüssel ein, speichere und führe den Konnektortest aus. Das Speichern eines Schlüssels ist kein Beleg dafür,
dass der Anbieter ihn akzeptiert; ein erfolgreicher authentifizierter Test ist es.

Verwende einen App-Store-Connect-API-Schlüssel, der die vorgesehenen Apps und TestFlight-Ressourcen lesen kann.
Ein Sign-in-with-Apple-Schlüssel ist ein anderes Zugangsdatum. Die Vorlage
legt keine Tester an, sendet keine Einladungen und kann die Beta-Prüfung von Apple nicht umgehen.
Sie bleibt im Katalog unverifiziert, bis ein echter Anbietertest erfolgreich war.

Für andere Anbieter akzeptiert derselbe HTTP- oder GraphQL-Konnektormodus diese öffentliche
Konfiguration, ohne Apple-spezifischen Transport oder Token-Austausch:

```json
{
  "auth_type": "signed_jwt",
  "config": {
    "signed_jwt": {
      "algorithm": "RS256",
      "audience": "https://api.example.com",
      "issuer": "service-account",
      "subject": "integration",
      "key_id": "provider-key-id",
      "ttl_seconds": 300,
      "claims": { "role": "reader" }
    }
  }
}
```

Das ist das Auth-Fragment einer Konnektordefinition, keine vollständige Anlege-Anfrage.
Behalte den üblichen Konnektornamen, Treiber, die Umgebung und die Basis-URL bei.
Setze bei GraphQL den Endpunkt über die bestehende GraphQL-Konfiguration. Öffentliche
Claims müssen dem dokumentierten Vertrag des Anbieters entsprechen. Die App-Store-Vorlage legt
Algorithmus, Audience, benutzerdefinierte Claims und Lebensdauer fest; deren Änderung erfordert das ausdrückliche
Löschen oder Ersetzen der Vorlagenbindung. Änderungen an öffentlicher Identität oder Schlüssel werden
gegen bestehende Ausführungsautoritäten geprüft.

Hänge den Schlüssel über die CLI an einen bereits konfigurierten Konnektor an oder ersetze ihn:

```sh
sk credentials set <connector-id> --mode signed_jwt --private-key-file ./provider-key.p8 --json
```

Die CLI liest die Datei lokal und sendet ihren Inhalt nur an den authentifizierten
Zugangsdaten-Endpunkt. Das JSON-Ergebnis enthält das Ergebnis der Probe; eine fehlgeschlagene Probe
beendet mit Fehlerstatus. `--skip-checks` überspringt den Test und macht keine Aussage zur Konnektivität.
Füge einen Schlüssel nie in ein Befehlsargument, eine Konnektorkonfiguration, einen Workflow oder einen Chat ein.
Die Zugangsdaten-API akzeptiert `{ "mode": "signed_jwt", "private_key": "<PEM>" }`
und liefert die Zugangsdaten-ID zurück, nie den Schlüssel oder ein erzeugtes Token.

Schlüssel müssen unverschlüsseltes PKCS#8-PEM sein: P-256 für ES256 oder RSA mit 2048–4096 Bit für
RS256. SubKit verschlüsselt gespeicherte Schlüssel, erzeugt für jeden tatsächlichen
Anfrageversuch ein frisches Token und erzeugt Tokens nach einem Neustart ohne Refresh-Job neu.
Die Entwurfseinrichtung hält das übermittelte Geheimnis im bestehenden geschützten
Zugangsdaten-Ablauf vorübergehend, bis es gespeichert ist; es wird nicht in Konversationsnachrichten abgelegt.
Anfragen können nicht auf eine andere Ressource umleiten, und Konnektor-Hooks sehen das
erzeugte Token nicht. Gespiegelte Tokens werden aus Anbieterergebnissen entfernt.

| Problem | Nächste Maßnahme |
| --- | --- |
| Der private Schlüssel ist ungültig oder hat den falschen Algorithmus | Verwende den passenden vom Anbieter ausgestellten PKCS#8-Schlüssel. Übermittle kein Zertifikat, keinen öffentlichen Schlüssel, kein JWK und kein erzeugtes JWT. |
| Der Anbieter liefert 401 | Prüfe Key ID, Aussteller/Subject, Audience, widerrufene Schlüssel und die Uhr der Engine. Das Ersetzen eines Schlüssels behebt keine falsche Identität. |
| Der Anbieter liefert 403 | Prüfe die Anbieterrolle des API-Schlüssels und den Zugriff auf die vorgesehene Ressource. |
| Der Anbieter leitet um oder der Ziel-Origin weicht ab | Verwende im Konnektor den endgültigen dokumentierten API-Origin. Signierte Anfragen folgen keinen Weiterleitungen. |
| Der Anbieter ist nicht verfügbar | Wiederhole den schreibgeschützten Test nach der Wiederherstellung; ersetze einen gültigen Schlüssel nicht allein wegen eines vorübergehenden Ausfalls. |
| Schlüsselrotation | Aktualisiere bei Bedarf die öffentlichen Identitätsfelder, ersetze das Zugangsdatum mit dem privaten Schlüssel und führe dann den schreibgeschützten Test erneut aus. Verwende nie ein zuvor erzeugtes JWT wieder. |

### Agent-Vertrag für signierte JWTs

Ermittle die Vorlage, bevor du einen Konnektor erstellst. Konfiguriere nur öffentliche Felder
unter `config.signed_jwt`. Fordere den privaten Schlüssel über das bestehende sensible
Zugangsdatenformular von SubKit oder die Übergabe an die Browser-Einrichtung an; fordere ihn nicht im Freitext-Chat an
und erzeuge, drucke oder speichere JWTs nicht selbst. Das sichere Formularfeld ist
`private_key`; `token` und OAuth-`client_secret` sind kein Ersatz.

Lies nach dem Speichern das Ergebnis der authentifizierten Probe und melde Anbieterfehler,
ohne Konnektivität zu behaupten. Prüfe den aktuellen Build-/Prüfstatus, bevor du sagst, dass eine
Einladung verwendet werden kann. Eine Einladung oder jede andere Anbieter-Mutation erfordert einen eigenen
autorisierten Workflow; der Einrichtungstest des Konnektors führt nur einen Lesezugriff aus.

Verwende die generierten OpenAPI-Schemas als maschinenlesbaren Vertrag und den an die Vorlage gebundenen
Skill `app-store-connect-basics` für Anbieterhinweise. Die generierten `/llms/setup.md`,
`/llms/connectors.md`, `/llms/cli.md` und `/llms-full.txt` werden mit der Engine ausgeliefert und
aus diesen Quellen neu generiert; pflege keine zweite Auth-Spezifikation.
