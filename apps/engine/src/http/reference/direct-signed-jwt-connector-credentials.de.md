---
slug: direct-signed-jwt-connector-credentials
summary: Verbinde APIs wie App Store Connect, die ein signiertes JWT direkt akzeptieren.
section: operate
order: 9
audience: operator
---
## Direkte signierte JWT-Connector-Zugangsdaten

Manche APIs, etwa App Store Connect, erwarten statt eines Passworts oder OAuth-Tokens ein JWT, das mit deinem privaten Schlüssel signiert ist. Du brauchst dieses Kapitel, wenn du einen solchen Dienst als Connector einrichtest. Danach erzeugt SubKit für jede Anfrage ein frisches Token, und dein privater Schlüssel liegt nur verschlüsselt am Connector.

Ein JWT (JSON Web Token) ist ein kurzes, signiertes Datenpaket; der Empfänger prüft es mit deinem öffentlichen Schlüssel. Hier schickt SubKit es direkt im Header `Authorization: Bearer` an die Ressourcen-API. Das unterscheidet sich von OAuth `private_key_jwt`: Ein direktes signiertes JWT geht nie an einen Token-Endpunkt. SubKit erzeugt es für die ausgehende Anfrage, hält es nur im Speicher und legt es weder in einem Workflow noch in einem Audit-Eintrag oder Log ab.

Die Connector-Konfiguration enthält die öffentliche Signaturrichtlinie: Algorithmus (`ES256` oder `RS256`), Audience, optionaler Aussteller, Subject und Schlüssel-ID. Dazu kommen wörtliche eigene Claims (Felder im Token) und eine Lebensdauer von 60–3600 Sekunden. Die Connector-Zugangsdaten enthalten nur den verschlüsselten privaten Schlüssel. SubKit setzt `iat` und `exp`; als eigene Claims lassen sie sich nicht setzen. Um einen Schlüssel zu rotieren, ersetze die Zugangsdaten über die normale Zugangsdaten-Maske des Connectors und prüfe ihn dann mit dem authentifizierten Test des Connectors.

Die eingebaute Vorlage **App Store Connect** ist ein Connector mit direktem signiertem JWT für
`https://api.appstoreconnect.apple.com`. Die Richtlinie der Vorlage ist fest auf `ES256`, die Audience
`appstoreconnect-v1` und eine Lebensdauer von fünf Minuten gesetzt.

Füge den privaten `.p8`-Schlüssel als
Zugangsdatum hinzu und konfiguriere die öffentliche Key ID. Setze bei einem Team-Schlüssel die App-Store-Connect-Issuer-ID
als `issuer`; lass bei einem individuellen Schlüssel `issuer` weg und setze
`subject` auf `user`. Die erste Probe ist `GET /v1/apps`. Konfiguriere für diesen Connector weder OAuth,
noch einen Token-Endpunkt, noch eine OAuth-Client-Assertion.

Die Vorlage ermittelt Endpunkte aus dem offiziellen OpenAPI-ZIP-Download von Apple.
Die Discovery akzeptiert eine einzelne JSON- oder YAML-Spezifikation in einem Archiv, begrenzt
komprimierte und extrahierte Inhalte auf 16 MiB und lehnt mehrdeutige Archive ab.
Der entstehende Endpunktkatalog steht Agenten zur Verfügung; die Connector-Dokumentation
kann außerdem mit `POST /v1/connectors/{id}/docs/ingest` importiert werden, mit
`source_type: "openapi"` und der extrahierten Spezifikation als `content`.

### Einen Connector mit signiertem JWT einrichten

Wähle im Cockpit unter **Connectors** **Connector hinzufügen → Aus Vorlage → App Store Connect** und öffne dann den
vorhandenen Bearbeitungsdialog des Connectors. Gib die öffentliche Key ID und entweder die Issuer-ID
(Team-Schlüssel) oder das Subject `user` (individueller Schlüssel) ein. Füge den privaten Schlüssel in das
Feld für den privaten Schlüssel ein, speichere und führe den Connector-Test aus. Dass ein Schlüssel gespeichert ist,
belegt nicht, dass der Anbieter ihn akzeptiert; das belegt erst ein erfolgreicher authentifizierter Test.

Verwende einen App-Store-Connect-API-Schlüssel, der die vorgesehenen Apps und TestFlight-Ressourcen lesen kann.
Ein Sign-in-with-Apple-Schlüssel ist ein anderes Zugangsdatum. Die Vorlage
legt keine Tester an, sendet keine Einladungen und kann die Beta-Prüfung von Apple nicht umgehen.
Sie bleibt im Katalog unverifiziert, bis ein echter Anbietertest erfolgreich war.

Für andere Anbieter akzeptiert derselbe HTTP- oder GraphQL-Connector-Modus diese öffentliche
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

Das ist der Auth-Teil einer Connector-Definition, keine vollständige Anlege-Anfrage.
Connector-Name, Treiber, Umgebung und Basis-URL setzt du wie üblich.
Bei GraphQL setzt du den Endpunkt über die bestehende GraphQL-Konfiguration. Öffentliche
Claims müssen den dokumentierten Vorgaben des Anbieters entsprechen.

Die App-Store-Vorlage legt Algorithmus, Audience, eigene Claims und Lebensdauer fest. Willst du sie ändern, musst du die
Vorlagenbindung ausdrücklich löschen oder ersetzen. Änderungen an öffentlicher Identität oder Schlüssel prüft SubKit
gegen bestehende Freigaben.

Hänge den Schlüssel über die CLI an einen bereits konfigurierten Connector an oder ersetze ihn:

```sh
subkit vault attach <connector-id> --mode signed_jwt --json < ./provider-key.p8
```

Die CLI liest die Datei lokal und sendet ihren Inhalt nur an den authentifizierten
Zugangsdaten-Endpunkt. Das JSON-Ergebnis enthält das Ergebnis der Probe; eine fehlgeschlagene Probe
beendet mit Fehlerstatus. `--skip-checks` überspringt den Test und macht keine Aussage zur Konnektivität.
Füge einen Schlüssel nie in ein Befehlsargument, eine Connector-Konfiguration, einen Workflow oder einen Chat ein.
Die Zugangsdaten-API akzeptiert `{ "mode": "signed_jwt", "private_key": "<PEM>" }`
und liefert die Zugangsdaten-ID zurück, nie den Schlüssel oder ein erzeugtes Token.

Schlüssel müssen unverschlüsseltes PKCS#8-PEM sein: P-256 für ES256 oder RSA mit 2048–4096 Bit für
RS256. SubKit verschlüsselt gespeicherte Schlüssel, erzeugt für jeden tatsächlichen
Anfrageversuch ein frisches Token und erzeugt Tokens nach einem Neustart ohne Refresh-Job neu.
Beim Einrichten eines Entwurfs hält SubKit den übermittelten Schlüssel nur vorübergehend im geschützten
Zugangsdaten-Weg, bis er gespeichert ist; in Chat-Nachrichten landet er nicht.
Anfragen können nicht auf eine andere Ressource umleiten, und Connector-Hooks sehen das
erzeugte Token nicht. Gespiegelte Tokens werden aus Anbieterergebnissen entfernt.

| Problem | Nächste Maßnahme |
| --- | --- |
| Der private Schlüssel ist ungültig oder hat den falschen Algorithmus | Verwende den passenden vom Anbieter ausgestellten PKCS#8-Schlüssel. Übermittle kein Zertifikat, keinen öffentlichen Schlüssel, kein JWK und kein erzeugtes JWT. |
| Der Anbieter liefert 401 | Prüfe Key ID, Aussteller/Subject, Audience, widerrufene Schlüssel und die Uhr der Engine. Das Ersetzen eines Schlüssels behebt keine falsche Identität. |
| Der Anbieter liefert 403 | Prüfe die Anbieterrolle des API-Schlüssels und den Zugriff auf die vorgesehene Ressource. |
| Der Anbieter leitet um oder der Ziel-Origin weicht ab | Verwende im Connector den endgültigen dokumentierten API-Origin. Signierte Anfragen folgen keinen Weiterleitungen. |
| Der Anbieter ist nicht verfügbar | Wiederhole den schreibgeschützten Test nach der Wiederherstellung; ersetze einen gültigen Schlüssel nicht allein wegen eines vorübergehenden Ausfalls. |
| Schlüsselrotation | Aktualisiere bei Bedarf die öffentlichen Identitätsfelder, ersetze das Zugangsdatum mit dem privaten Schlüssel und führe dann den schreibgeschützten Test erneut aus. Verwende nie ein zuvor erzeugtes JWT wieder. |

### Regeln für Agenten bei signierten JWTs

Ermittle die Vorlage, bevor du einen Connector erstellst. Konfiguriere nur öffentliche Felder
unter `config.signed_jwt`. Fordere den privaten Schlüssel über das bestehende sensible
Zugangsdatenformular von SubKit oder die Übergabe an die Browser-Einrichtung an. Fordere ihn nie im Freitext-Chat an,
und erzeuge, drucke oder speichere JWTs nicht selbst. Das sichere Formularfeld ist
`private_key`; `token` und OAuth-`client_secret` sind kein Ersatz.

Lies nach dem Speichern das Ergebnis der authentifizierten Probe und melde Anbieterfehler,
ohne Konnektivität zu behaupten. Prüfe den aktuellen Build-/Prüfstatus, bevor du sagst, dass eine
Einladung verwendet werden kann. Eine Einladung oder jede andere Anbieter-Mutation erfordert einen eigenen
autorisierten Workflow; der Einrichtungstest des Connectors führt nur einen Lesezugriff aus.

Verwende die generierten OpenAPI-Schemas als maschinenlesbare Beschreibung und den an die Vorlage gebundenen
Skill `app-store-connect-basics` für Anbieterhinweise. Die generierten `/llms/setup.md`,
`/llms/connectors.md`, `/llms/cli.md` und `/llms-full.txt` werden mit der Engine ausgeliefert und
aus diesen Quellen neu generiert; pflege keine zweite Auth-Spezifikation.
