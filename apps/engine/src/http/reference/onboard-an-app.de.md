---
slug: onboard-an-app
summary: Binde eine App an SubKit an, die ihre Benutzer bei einem Identitätsanbieter anmeldet.
section: work
order: 7
audience: public
---
## Eine App anbinden

Diese Checkliste gilt für jede App, die ihre Benutzer bei einem Identitätsanbieter anmeldet und SubKit mit dem Access-Token dieses Anbieters aufruft. Hosts und IDs unten sind Platzhalter (`example.test`, `<...>`). Arbeite sie der Reihe nach ab; die App braucht am Ende nur die Produkt-ID und die Workflow-IDs.

### 1. Entscheiden

- `product_id`: ein kleingeschriebener Name (`^[a-z][a-z0-9-]{0,62}$`), einer pro App. Er verbindet Anbieter, Workflows, Budgetzeilen und die Identitätsbindung.
- `issuer_url`: der Aussteller des Anbieters, genau so, wie er im `iss`-Claim des Tokens steht. HTTPS außerhalb von localhost.
- `audience`: der Wert, den der `aud`-Claim des Tokens trägt. Lies ihn aus einem echten Token der App; der Aussteller legt ihn fest, SubKit hat keinen Standardwert.
- `required_claims`: wer sich anmelden darf. Jeder Eintrag ist ein Punktpfad in die verifizierte Nutzlast mit einem exakten Wert, zum Beispiel `{ "path": "idp", "equals": "primary" }`. Der Schlüssel ist erforderlich. Eine leere Liste `[]` lässt jedes Token dieses Ausstellers und dieser Audience zu und sollte eine bewusste Entscheidung sein.
- Registrierung durch das erste Token: Das erste verifizierte Token eines Subjects legt einen Produktbenutzer mit der eingebauten Mitgliedsrolle an (siehe oben). Darf jeder Inhaber eines gültigen Tokens Benutzer werden, ist nichts weiter nötig. Falls nicht, schränke `required_claims` so ein, dass nur die vorgesehenen Konten qualifiziert sind.

### 2. Laufzeitkonfiguration

`auth.providers` wird als gesamtes Array ersetzt. Lies zuerst den aktuellen Wert und sende ihn mit dem hinzugefügten neuen Anbieter zurück; andernfalls werden die anderen Anbieter entfernt.

```bash
sk settings get auth.providers --json
sk settings set auth.providers '[
  {"protocol":"api_key","id":"api-key","label":"SubKit API key"},
  {"protocol":"oidc_bearer","id":"<provider-id>","label":"<app> account",
   "issuer_url":"https://idp.example.test","audience":"<audience>","algorithms":["ES256"],
   "product_id":"<product-id>","tenant_slug":"default",
   "required_claims":[{"path":"idp","equals":"primary"}],
   "reject_anonymous":true,"clock_tolerance_s":30}
]'
sk settings get products --json
sk settings set products '{"<product-id>":{"execution_environment":"prod",
  "assistant_workflow_id":"<assistant-workflow-id>","budget_bucket":"<bucket>"}}'
```

`products` wird ebenfalls als gesamtes Objekt ersetzt. `assistant_workflow_id` muss die ID sein, die du in Schritt 4 für den abgesicherten Workflow wählst.

`sk apps show <product-id>` zeigt, was diese Werte ergeben, sobald die Schritte 3 bis 5 erledigt sind; siehe „App prüfen“ unten.

### 3. Konnektoren

Lege pro aufgerufenem Upstream der Workflows einen Konnektor an: die Modell-API und, falls die App Konten löscht, die Admin-API des Identitätsanbieters. Schreibe jede Definition ohne Geheimnis in eine JSON-Datei und führe dann aus:

```bash
sk connectors create --file connector-model.json --skip-checks
sk credentials set <model-connector-id> --mode bearer --token "$MODEL_API_KEY"
sk credentials set <idp-admin-connector-id> --mode header --header "Authorization=Bearer $IDP_ADMIN_KEY,apikey=$IDP_ADMIN_KEY"
```

`--skip-checks` ist nötig, weil eine Definition vor dem Speichern geprüft wird und das Zugangsdatum noch nicht existiert; `credentials set` prüft anschließend. `bearer` sendet `Authorization: Bearer <token>`; `header` sendet die genannten Header (kommagetrennt `Name=Value`). Geheimnisse stammen aus deiner Shell oder deinem Secret-Speicher, nie aus einer Datei, der App oder diesem Repository. Ein Workflow liest das Zugangsdatum seines eigenen Konnektors nur als `${cred.<own-slug>.<field>}` unter einer freigegebenen Autorität.

SubKit prüft jeden Konnektor im Hintergrund und markiert ihn als abgemeldet, wenn seine konfigurierte Probe mit 401 oder 403 antwortet; Workflows, die einen markierten Konnektor verwenden, werden blockiert, bis er wieder angemeldet ist. Ohne konfigurierte Probe sendet SubKit `GET /` an die Basis-URL des Konnektors. Viele Admin-APIs antworten dort auch mit gültigem Zugangsdatum mit 401 oder 403, daher markiert diese Antwort den Konnektor nicht: Die Probe meldet `credential_unverified` mit der Warnung `PROBE_AUTH_UNVERIFIED`, `sk connectors test <id>` gibt die Warnung aus und beendet mit einem Wert ungleich null, und das Cockpit zeigt „Verbunden · Anmeldung nicht geprüft“ mit einem Hinweis, einen Probe-Pfad zu setzen. Um das Zugangsdatum zu verifizieren, gib dem Konnektor einen günstigen authentifizierten Lesezugriff als Probe, zum Beispiel `"config": {"probe_endpoint": {"method": "GET", "path": "/admin/users?per_page=1", "expected_status": [200, 200]}}`, und prüfe ihn mit `sk connectors test <id>`.

Um ein gespeichertes Zugangsdatum zu ersetzen, bearbeite den Konnektor im Cockpit. Ein Header-Zugangsdatum mit mehreren Headern, wie `Authorization` und `apikey` oben, zeigt ein Feld pro Header-Namen: Fülle alle aus, um sie gemeinsam zu ersetzen, oder lass alle leer, um sie zu behalten. Nur einige auszufüllen wird abgelehnt, damit kein Header verloren geht.

### 4. Workflows

Halte die Definitionen im eigenen Repository der App und lege sie mit vom Betreiber gewählten IDs an, damit die App sie fest hinterlegen kann. Eine Workflow-Definition akzeptiert `id` (eine UUID, die unbenutzt sein muss; nur ein Administrator darf sie wählen).

```bash
sk workflows create --file workflows/assistant.json
sk workflows create --file workflows/delete-account.json
```

Jeder Produkt-Workflow setzt:

- `"id": "<fixed-uuid>"` und `"product_id": "<product-id>"`.
- `"required_caller_kind": "user"` und `"execution_privacy": "sensitive"`.
- Beim abgerechneten Workflow `execution_guards.caller_daily_limit` (Bucket gleich `budget_bucket`, Limit, `tz`, Einheitenpfad) und `execution_guards.input_bytes`.
- Beim Lösch-Workflow `"caller_erasure": "on_success"`.

Aufgabenteilung. Der Identitätsanbieter besitzt das Konto: Zugangsdaten, E-Mail, Anmeldemethoden und die Existenz des Kontos. SubKit besitzt nur seine Schattendatensätze des Aufrufers: die Identitätsbindung, Budgetzeilen, Sitzungen und Schlüssel, den Benutzerdatensatz, den an seinen Ausführungen gespeicherten Aufrufer-Kontext und den Tombstone. Der Lösch-Workflow läuft daher in dieser Reihenfolge:

1. Lösche das Konto beim Identitätsanbieter mit dem Admin-Konnektor, unter Verwendung von `${caller.subject}` (gebunden mit `{caller_bound: true}`). Ein 404 bedeutet, dass das Konto bereits weg ist, und gilt als Erfolg, sodass eine Wiederholung sicher ist.
2. Widerrufe nach bestem Bemühen bei anderen Upstreams, zum Beispiel ein Anmeldeanbieter-Token. Ein Fehler hier darf Schritt 3 nicht blockieren.
3. SubKit löscht seine eigenen Aufruferdaten zuletzt, über `caller_erasure: "on_success"`, wenn der Lauf erfolgreich ist. Danach werden früher ausgestellte Tokens vom Tombstone abgelehnt.

Schlägt Schritt 1 fehl, schlägt der Lauf fehl, nichts wird gelöscht, und die App versucht es mit demselben `idempotency_key` erneut.

### 5. Die Ausführungsautorität freigeben

Ohne Live-Ausführungsautorität antwortet ein Produktlauf mit 403. Eine Person mit Schreibzugriff gibt jeden Produkt-Workflow einmal pro Umgebung frei:

1. Öffne den Workflow im Cockpit. Ein Workflow, den nichts außer den HTTP-Aufrufen der App startet (kein Zeitplan, kein Webhook), wird in der Umgebung geprüft, in der seine Konnektoren leben; bei einem reinen Produktions-Workflow lautet die Statuszeile also „Nicht freigegeben“, ohne Reparaturbanner. Löst sich ein Schritt zu einem Konnektor in einer anderen Umgebung auf oder fehlt ein Konnektor, bleibt der Reparaturzustand bestehen; behebe das zuerst.
2. Wähle „Freigeben…“ in der Statuszeile oder auf dem Tab „Freigaben“, der dieselbe Schaltfläche zeigt, solange keine Freigabe live ist. Der Dialog „Freigabe prüfen“ öffnet sich mit bereits gewählter Umgebung im Feld „Umgebung“ („Produktion“ oder „Entwicklung“). Ändere sie nur, wenn die `execution_environment` des Produkts eine andere ist.
3. Prüfe die Wirkungsgrenze (Konnektoren, Adressen, Lesen oder Schreiben), wähle unbefristet oder begrenze sie nach Läufen und Zeit, und bestätige.

Die Freigabe wandert mit einer neu aktivierten Version, deren Grenze nicht wächst, und wird erneut verlangt, wenn sie wächst. Widerrufe sie auf dem Tab „Freigaben“.

### 6. Verifizieren

Prüfe zuerst die Bereitschaft. Jede Prüfung von `sk apps show <product-id>` sollte `ok` lauten; eine fehlschlagende Prüfung gibt ihre nächste Maßnahme aus.

```bash
sk apps show <product-id>
```

Verwende ein echtes Access-Token `$TOKEN` eines Testkontos und die Workflow-IDs aus Schritt 4. `$BAD_TOKEN` ist `$TOKEN` mit geänderten letzten Zeichen der Signatur. `$BASE` ist die Engine-URL.

```bash
curl -s -w '\n%{http_code}\n' -H "Authorization: Bearer $BAD_TOKEN" $BASE/v1/budget
curl -s -H "Authorization: Bearer $TOKEN" $BASE/v1/health
curl -s -H "Authorization: Bearer $TOKEN" $BASE/v1/budget
curl -s -X POST $BASE/v1/executions -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"workflow_id":"<workflow-id>","idempotency_key":"check-1","async":true,"input":{}}'
```

Erwartet:

- `$BAD_TOKEN`, eine falsche Audience, ein fehlender erforderlicher Claim oder ein abgelaufenes Token antwortet mit `401 invalid bearer token`.
- `GET /v1/health` mit `ok: false` und ein Lauf, der mit `403` antwortet, bedeuten, dass die Autorität aus Schritt 5 oder ein Konnektor-Zugangsdatum fehlt.
- Das Aufbrauchen des Tageslimits antwortet mit `429 rate_limited`; ein zweiter Aufruf, während eine Einheit läuft, antwortet mit `409 turn_busy`; derselbe `idempotency_key` wiederholt stattdessen.
- `sk executions` und der Ausführungsdatensatz zeigen die Aufrufer-Zusammenfassung und die verwendete Autorität.

In Konnektoren gehaltene Geheimnisse können ablaufen: Client-Secrets von Anbietern haben oft eine begrenzte Lebensdauer, und Admin-Schlüssel werden gegebenenfalls rotiert. Halte Name, Konnektor, Eigentümer und Ablaufdatum jedes Geheimnisses im eigenen Repository der App fest (nicht den Wert) und erneuere es vor Ablauf: Hänge den neuen Wert mit `sk credentials set` an, prüfe ihn und entferne dann den alten mit `sk credentials delete <credential-id>`. Eine Probe mit `sk connectors test <connector-id>` zeigt, ob ein Zugangsdatum noch funktioniert. Cockpit und `GET /v1/health` zeigen fehlschlagende Konnektoren.

Rollback: Widerrufe die Ausführungsautorität des Workflows (die App erhält dann 403 und nichts läuft), stelle die in Schritt 2 gelesenen früheren Werte von `auth.providers` und `products` wieder her und nutze `sk workflows history <id>` und `sk workflows restore <id>` für eine Workflow-Version. Das Entfernen des Anbieters macht die Tokens der App unbeansprucht; bestehende Schattendatensätze bleiben, bis der Lösch-Workflow sie löscht.

### App prüfen

Eine App ist eine schreibgeschützte Ansicht, die zum Lesezeitpunkt aus dem `products`-Eintrag, den Anmeldeanbietern mit ihrer `product_id`, den Workflows, deren Definition sie trägt, den darüber angemeldeten Benutzern und dem heutigen Aufruferbudget zusammengesetzt wird. Sie hat keinen eigenen Speicher: Änderungen laufen über `auth.providers`, `products` und die Workflows, wie in den Schritten 2 bis 5.

```bash
sk apps list                      # app, environment, users, budget today, readiness
sk apps show <product-id>         # settings, sign-in, workflows, users, budget today, readiness
sk apps show <product-id> --json
sk users list --app <product-id>  # users who signed in to that app
```

Im Cockpit ist dieselbe Ansicht der Tab „Apps“ unter „Personen & Rechte“; die Auswahl einer App öffnet ihre Details. Sie ist auch als `GET /v1/apps` und `GET /v1/apps/{id}` verfügbar sowie im Admin-Modus von MCP als die schreibgeschützten Tools `list_apps` und `get_app`. Alle erfordern `settings:read`; Produkt-Principals werden immer mit 403 abgelehnt. Ein Workspace sieht eine App, wenn einer seiner Anmeldeanbieter (`tenant_slug`), Workflows oder angemeldeten Benutzer die `product_id` trägt oder wenn der Assistenten-Workflow der App ihm gehört; jede andere ID antwortet mit 404. Eine ID ohne `products`-Eintrag wird weiterhin aufgeführt, mit `configured: false`.

Die Bereitschaft besteht aus sechs Prüfungen, jede mit einer Meldung und, wenn sie fehlschlägt, einer nächsten Maßnahme: `product_configured`, `sign_in_provider`, `assistant_workflow` (existiert im Workspace, trägt die `product_id`, ist aktiv und gültig), `execution_authority` (live für die Umgebung des Produkts), `credentials` (nutzbar an jedem vom Assistenten verwendeten Konnektor) und `budget_guard` (ein `caller_daily_limit`, dessen Bucket `budget_bucket` entspricht). Das heutige Budget zeigt die im Bucket der Schranke verbrauchten und reservierten Einheiten für den aktuellen lokalen Tag, die auditierten Ablehnungen der Workflows der App seit lokaler Mitternacht (`rate_limited`, `turn_limit`, `turn_busy`) und wann der Tag zurückgesetzt wird. Jeder Eintrag in den `identities` eines Benutzerdatensatzes listet Anbieter, `product_id` und letzte Anmeldung, ohne das Subject; die Platzhalter-`email` eines Produkt-Principals enthält es weiterhin.

### Einen App-Benutzer löschen

Das Löschen entfernt die eigenen Daten von SubKit über eine Person für eine App: ihre Anmeldebindungen, Budgetzähler, Sitzungen und API-Schlüssel sowie das Subject im Aufrufer-Kontext vergangener Läufe. Der Benutzerdatensatz wird anonymisiert, und ein Tombstone sorgt dafür, dass vor der Löschung ausgestellte Tokens abgelehnt werden; eine neue Anmeldung beim Anbieter legt einen neuen, leeren App-Benutzer an. Eine Person, die auch Anmeldeverknüpfungen zu einer anderen App oder zu SubKit selbst hat, wird nicht gelöscht (409), da das auch diesen Zugang entfernen würde. Das Konto beim Anmeldeanbieter wird nicht angetastet; dessen Löschung bleibt bei der App und ihrem Identitätsanbieter. Das Löschen ist unumkehrbar und erfordert eine ausdrückliche Bestätigung durch eine Person. Es erfordert `identity:write` und eine Admin-Rolle; Produkt-Principals werden abgelehnt. Der Audit-Eintrag nennt den Betreiber als Akteur mit `source: operator_erasure`.

```bash
sk apps show <product-id>                          # lists the user ids of the app
sk apps erase-user <product-id> <user-id>          # asks for confirmation
sk apps erase-user <product-id> <user-id> --yes    # non-interactive; --json prints the result
```

Im Cockpit befindet sich dieselbe Aktion beim Benutzer in den Details der App, hinter einem Bestätigungsdialog. Über HTTP ist es `DELETE /v1/apps/{id}/users/{user_id}`, das mit `{ "user_id", "app_id", "erased": true }` antwortet, oder mit 404 bei einem unbekannten, fremden oder bereits gelöschten Benutzer. Apps in MCP bleiben schreibgeschützt. `DELETE /v1/identity/users/{id}` ist unverändert und deaktiviert nur einen Benutzer.

Das Aktivieren einer Einstellungsrevision, die einen Anmeldeanbieter hinzufügt, entfernt, umsortiert oder ändert oder einen `products`-Eintrag hinzufügt, entfernt oder ändert, schreibt einen Audit-Eintrag (`auth_provider.*`, `product.*`), der den Anbieter oder das Produkt und die geänderten Felder nennt; die geänderten Werte werden nicht erfasst.

### Generisch oder pro App

| Belang | Wo er liegt |
| --- | --- |
| Token-Verifikation, Bindung, Budgets, Löschung, Autoritätsprüfungen | Engine-Code, für jede App identisch |
| Anbietereintrag, `products`-Eintrag, Konnektoren und ihre Zugangsdaten | Laufzeitkonfiguration pro Deployment, gesetzt mit `sk` |
| Workflow-Definitionen und ihre festen IDs | Das eigene Repository der App, angelegt mit `sk workflows create` |
| Freigaben der Ausführungsautorität | Eine Person, pro Workflow und Umgebung, im Cockpit |
| Ablaufnachweise für Geheimnisse | Das eigene Repository der App (nur Metadaten) |
