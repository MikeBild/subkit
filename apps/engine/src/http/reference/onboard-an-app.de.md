---
slug: onboard-an-app
summary: Binde eine App mit eigener Anmeldung an, damit sie Workflows startet.
section: work
order: 7
audience: public
---
## Eine App anbinden

Deine App meldet ihre Nutzer bei einem eigenen Identitätsanbieter an und soll in deren Namen SubKit-Workflows starten.
Diese Checkliste ist für Entwickler, die diese Anbindung einrichten.
Am Ende ruft die App SubKit mit dem Token ihrer Nutzer auf und braucht dafür nur die Produkt-ID und die Workflow-IDs.

Der Identitätsanbieter ist der Dienst, bei dem sich deine Nutzer anmelden.
Nach der Anmeldung stellt er ein Access-Token aus, einen signierten und befristeten Nachweis, wer die Person ist.
Die App schickt dieses Token als Bearer-Token im Header `Authorization` an SubKit.
SubKit prüft Signatur, Aussteller und Empfänger des Tokens, bevor ein Lauf startet.

Arbeite die Schritte der Reihe nach ab.
Hosts und IDs in den Beispielen sind Platzhalter (`example.test`, `<...>`).

### Was du brauchst

- Die `sk`-CLI, angemeldet an deiner Engine. In SubKit Cloud ist die Engine-Adresse `https://subkit-cloud.mikebild.dev`, ohne `/cockpit`.
- Ein echtes Access-Token eines Testkontos der App.
- Zugang zu den Diensten, die die Workflows aufrufen, etwa zur API deines KI-Modells.

### 1. Produkt-ID und Anmelderegeln festlegen

Leg diese Werte fest, bevor du eine Einstellung änderst.
Ein Claim ist ein Feld im Token, etwa `iss` (wer es ausgestellt hat) oder `aud` (für wen es gedacht ist).
Lies beide aus einem echten Token der App.

| Einstellung | Was du einträgst | Beispiel |
| --- | --- | --- |
| `product_id` | Ein kleingeschriebener Name (`^[a-z][a-z0-9-]{0,62}$`), einer pro App. Er verbindet Anbieter, Workflows, Budget und Identitätsbindung. | `<product-id>` |
| `issuer_url` | Der Aussteller des Anbieters, genau wie im `iss`-Claim des Tokens. HTTPS außerhalb von localhost. | `https://idp.example.test` |
| `audience` | Für wen das Token gedacht ist: der Wert des `aud`-Claims. Der Aussteller legt ihn fest, SubKit hat keinen Standardwert. | `<audience>` |
| `required_claims` | Wer sich anmelden darf: ein Punktpfad in das verifizierte Token mit exaktem Wert. Der Schlüssel ist erforderlich. | `[{"path":"idp","equals":"primary"}]` |

Das erste geprüfte Token einer Person legt einen Produktbenutzer mit der eingebauten Mitgliedsrolle an.
Eine leere Liste `required_claims: []` lässt jedes Token dieses Ausstellers und dieser Audience zu.
Soll nicht jede Person mit einem Token Benutzer werden, schränke `required_claims` auf die vorgesehenen Konten ein.

### 2. Laufzeitkonfiguration setzen

Die Laufzeitkonfiguration sind Einstellungen deiner Engine, die du mit `sk settings` liest und schreibst.
`auth.providers` und `products` werden dabei jeweils als Ganzes ersetzt.
Lies deshalb jeden Wert zuerst und schreib ihn mit deiner Ergänzung zurück.

1. Lies die aktuellen Anmeldeanbieter.

```bash
sk settings get auth.providers --json
```

2. Ergänze deinen Anbietereintrag und schreib die ganze Liste zurück. Behalte jeden bestehenden Eintrag, sonst geht er verloren.

```bash
sk settings set auth.providers '[
  {"protocol":"api_key","id":"api-key","label":"SubKit API key"},
  {"protocol":"oidc_bearer","id":"<provider-id>","label":"<app> account",
   "issuer_url":"https://idp.example.test","audience":"<audience>","algorithms":["ES256"],
   "product_id":"<product-id>","tenant_slug":"default",
   "required_claims":[{"path":"idp","equals":"primary"}],
   "reject_anonymous":true,"clock_tolerance_s":30}
]'
```

3. Lies die aktuellen Produkte.

```bash
sk settings get products --json
```

4. Ergänze deinen Produkteintrag und schreib den ganzen Wert zurück.

```bash
sk settings set products '{"<product-id>":{"execution_environment":"prod",
  "assistant_workflow_id":"<assistant-workflow-id>","budget_bucket":"<bucket>"}}'
```

`tenant_slug` nennt den Arbeitsbereich, also den abgetrennten Bereich in der Engine, in dem SubKit die Nutzer der App anlegt.
`assistant_workflow_id` ist die ID, die du in Schritt 4 für den abgesicherten Workflow wählst.
Sobald die Schritte 3 bis 5 erledigt sind, zeigt `sk apps show <product-id>`, was die Werte ergeben.

### 3. Konnektoren anlegen

Lege für jeden Dienst, den die Workflows aufrufen, einen Konnektor an.
Das ist meist die API des KI-Modells und, falls die App Konten löscht, die Admin-API des Identitätsanbieters.

1. Schreibe jede Definition ohne Zugangsdaten in eine JSON-Datei.
2. Lege den Konnektor an.
3. Hinterlege die Zugangsdaten.

```bash
sk connectors create --file connector-model.json --skip-checks
sk credentials set <model-connector-id> --mode bearer --token "$MODEL_API_KEY"
sk credentials set <idp-admin-connector-id> --mode header --header "Authorization=Bearer $IDP_ADMIN_KEY,apikey=$IDP_ADMIN_KEY"
```

- `--skip-checks` ist nötig, weil die Zugangsdaten beim Anlegen des Konnektors noch fehlen. `credentials set` prüft sie anschließend.
- `bearer` sendet `Authorization: Bearer <token>`. `header` sendet die genannten Header (kommagetrennt `Name=Value`).
- Zugangsdaten stammen aus deiner Shell oder deinem Secret-Speicher, nie aus einer Datei, der App oder diesem Repository.
- Ersetzt du im Cockpit Zugangsdaten mit mehreren Headern, füll alle Header-Felder aus. Lässt du alle leer, bleiben die alten Werte.

Damit SubKit die Zugangsdaten prüfen kann, gib dem Konnektor eine Probe. Das ist ein kleiner Lesezugriff, der eine Anmeldung braucht:

```json
"config": {"probe_endpoint": {"method": "GET", "path": "/admin/users?per_page=1", "expected_status": [200, 200]}}
```

Führe dann `sk connectors test <id>` aus.
Antwortet die Probe mit 401 oder 403, gilt der Konnektor als abgemeldet. Seine Workflows sind dann blockiert.

### 4. Workflows anlegen

Halte die Definitionen im eigenen Repository der App.
Lege sie mit festen IDs an, damit die App sie fest im Code hinterlegen kann.
Nur ein Administrator darf eine Workflow-`id` (eine unbenutzte UUID) wählen.

```bash
sk workflows create --file workflows/assistant.json
sk workflows create --file workflows/delete-account.json
```

Jeder Produkt-Workflow setzt:

- `"id": "<fixed-uuid>"` und `"product_id": "<product-id>"`.
- `"required_caller_kind": "user"` und `"execution_privacy": "sensitive"`.
- Beim Workflow, dessen Verbrauch je Nutzer und Tag begrenzt ist, `execution_guards.caller_daily_limit` (Bucket gleich `budget_bucket`, Limit, `tz`, Einheitenpfad) und `execution_guards.input_bytes`.
- Beim Lösch-Workflow `"caller_erasure": "on_success"`.

Das Konto gehört dem Identitätsanbieter. SubKit besitzt nur seine eigenen Datensätze über die aufrufende Person.
Der Lösch-Workflow läuft deshalb in dieser Reihenfolge:

1. Lösche das Konto beim Identitätsanbieter mit dem Admin-Konnektor, über `${caller.subject}` (gebunden mit `{caller_bound: true}`). Ein 404 bedeutet „schon weg“ und gilt als Erfolg.
2. Widerrufe Tokens bei anderen Diensten, so weit das möglich ist. Ein Fehler hier darf Schritt 3 nicht blockieren.
3. SubKit löscht seine eigenen Aufruferdaten zuletzt, über `caller_erasure: "on_success"`. Früher ausgestellte Tokens werden danach abgelehnt.

Schlägt Schritt 1 fehl, schlägt der Lauf fehl, und nichts wird gelöscht. Die App versucht es mit demselben `idempotency_key` erneut.

### 5. Die Workflows freigeben

Ohne gültige Freigabe antwortet ein Produktlauf mit 403.
Eine Person mit Schreibrecht gibt jeden Produkt-Workflow einmal pro Umgebung frei.

1. Öffne im Cockpit **Workflows** und klicke auf den Workflow.
2. Wähle **Freigeben** in der Statuszeile oder auf dem Tab **Freigaben**. Der Dialog **<Workflow> v<n> freigeben** öffnet sich.
3. Prüfe, ob **Umgebung** (**Produktion** oder **Test**) zur `execution_environment` des Produkts passt.
4. Prüfe Konnektoren, Adressen und Lese- oder Schreibzugriff.
5. Wähle unter **Gültigkeit** **7 Tage**, **30 Tage** oder **Bis auf Widerruf**. **Bis auf Widerruf** ist vorausgewählt und setzt weder eine Laufgrenze noch ein Ablaufdatum.
6. Wähle **Freigeben**. Die Freigabe startet keinen Lauf.

Ein Workflow, den nur die HTTP-Aufrufe der App starten, wird in der Umgebung seiner Konnektoren geprüft.
Seine Statuszeile zeigt dann eventuell „Nicht freigegeben“ ohne Korrekturbanner.
Fehlt ein Konnektor oder liegt er in einer anderen Umgebung, behebe das zuerst.

Eine neue Version braucht keine neue Freigabe, solange sie nicht mehr Systeme, Adressen oder Schreibrechte anfasst als die freigegebene. Greift sie weiter, fragt SubKit erneut und nennt den Unterschied.

### 6. Den Zugriff der App testen

Prüfe zuerst die Bereitschaft. Jede Prüfung sollte `ok` lauten. Eine fehlschlagende Prüfung nennt ihre nächste Maßnahme.

```bash
sk apps show <product-id>
```

Ruf dann die Engine mit einem echten Token auf:

- `$TOKEN` ist das Access-Token eines Testkontos.
- `$BAD_TOKEN` ist `$TOKEN`, bei dem du die letzten Zeichen der Signatur änderst.
- `$BASE` ist die Adresse der Engine.

```bash
curl -s -w '\n%{http_code}\n' -H "Authorization: Bearer $BAD_TOKEN" $BASE/v1/budget
curl -s -H "Authorization: Bearer $TOKEN" $BASE/v1/health
curl -s -H "Authorization: Bearer $TOKEN" $BASE/v1/budget
curl -s -X POST $BASE/v1/executions -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"workflow_id":"<workflow-id>","idempotency_key":"check-1","async":true,"input":{}}'
```

Erwartet:

- `$BAD_TOKEN`, eine falsche Audience, ein fehlender Pflicht-Claim oder ein abgelaufenes Token antworten `401 invalid bearer token`.
- `sk executions` und der Datensatz des Laufs zeigen, wer aufgerufen hat und welche Freigabe galt.

### Zugangsdaten eines Konnektors erneuern

Zugangsdaten in Konnektoren können ablaufen, und Admin-Schlüssel werden regelmäßig getauscht.
Halte Name, Konnektor, Verantwortliche und Ablaufdatum aller Zugangsdaten im Repository der App fest, nie den Wert.
Erneuere sie vor Ablauf.

1. Hinterlege den neuen Wert mit `sk credentials set`.
2. Prüfe ihn mit `sk connectors test <connector-id>`.
3. Entferne den alten mit `sk credentials delete <credential-id>`.

Das Cockpit und `GET /v1/health` zeigen fehlschlagende Konnektoren.

### Eine App zurückrollen

1. Widerrufe die Freigabe des Workflows im Tab **Freigaben**. Die App erhält dann 403, nichts läuft.
2. Stell die Werte von `auth.providers` und `products` aus Schritt 2 wieder her.
3. Stell eine Workflow-Version mit `sk workflows history <id>` und `sk workflows restore <id>` wieder her.

Ohne den Anbietereintrag werden die Tokens der App nicht mehr angenommen. Bestehende Aufruferdatensätze bleiben, bis der Lösch-Workflow sie löscht.

### Einen App-Benutzer löschen

Das Löschen lässt sich nicht rückgängig machen.
Es entfernt die eigenen Daten von SubKit über eine Person für eine App:

- Anmeldebindungen
- Budgetzähler
- Sitzungen
- API-Schlüssel
- die ID der Person in vergangenen Läufen

Eine neue Anmeldung beim Anbieter legt einen neuen, leeren App-Benutzer an.

1. Ermittle die Benutzer-ID mit `sk apps show <product-id>`.
2. Führe `sk apps erase-user <product-id> <user-id>` aus und bestätige.

```bash
sk apps show <product-id>                          # lists the user ids of the app
sk apps erase-user <product-id> <user-id>          # asks for confirmation
sk apps erase-user <product-id> <user-id> --yes    # non-interactive; --json prints the result
```

Gut zu wissen:

- Das Löschen braucht `identity:write` und eine Admin-Rolle. Produktbenutzer werden abgelehnt.
- Das Konto beim Anmeldeanbieter bleibt bestehen. Dessen Löschung liegt bei der App und ihrem Identitätsanbieter.
- Eine Person mit Anmeldeverknüpfungen zu einer anderen App oder zu SubKit selbst wird nicht gelöscht (409).
- Im Cockpit liegt dieselbe Aktion beim Benutzer in den Details der App, hinter einem Bestätigungsdialog.

| Schnittstelle | Aufruf | Ergebnis |
| --- | --- | --- |
| HTTP | `DELETE /v1/apps/{id}/users/{user_id}` | `{ "user_id", "app_id", "erased": true }`, oder 404 bei einem unbekannten, fremden oder bereits gelöschten Benutzer. |
| HTTP | `DELETE /v1/identity/users/{id}` | Deaktiviert einen Benutzer nur. |
| MCP (Admin-Modus) | `list_apps`, `get_app` | Nur lesend. Löschen ist nicht möglich. |

### App prüfen

Eine App ist eine reine Ansicht.
SubKit setzt sie beim Lesen aus fünf Quellen zusammen:

- dem `products`-Eintrag
- den Anmeldeanbietern mit derselben `product_id`
- den Workflows mit derselben `product_id`
- den angemeldeten Benutzern
- dem heutigen Budget

Die App selbst speichert nichts.
Änderungen machst du über `auth.providers`, `products` und die Workflows (Schritte 2 bis 5).

```bash
sk apps list                      # app, environment, users, budget today, readiness
sk apps show <product-id>         # settings, sign-in, workflows, users, budget today, readiness
sk apps show <product-id> --json
sk users list --app <product-id>  # users who signed in to that app
```

Im Cockpit öffnest du **Personen & Rechte** > **Apps** und wählst eine App. Über HTTP nutzt du `GET /v1/apps` und `GET /v1/apps/{id}`. Beide brauchen `settings:read`.

Die Bereitschaft besteht aus sechs Prüfungen:

| Prüfung | Bedeutung |
| --- | --- |
| `product_configured` | Es gibt einen `products`-Eintrag. |
| `sign_in_provider` | Ein Anmeldeanbieter trägt die `product_id`. |
| `assistant_workflow` | Existiert im Arbeitsbereich, trägt die `product_id`, ist aktiv und gültig. |
| `execution_authority` | Für die Umgebung des Produkts gibt es eine gültige Freigabe. |
| `credentials` | Nutzbar an jedem vom Assistenten verwendeten Konnektor. |
| `budget_guard` | Ein `caller_daily_limit`, dessen Bucket `budget_bucket` entspricht. |

Das heutige Budget zeigt die heute verbrauchten und reservierten Einheiten, die Ablehnungen seit lokaler Mitternacht (`rate_limited`, `turn_limit`, `turn_busy`) und wann der Tag zurückgesetzt wird.

### Wo welche Einstellung liegt

| Einstellung | Wo sie liegt |
| --- | --- |
| Anbietereintrag, `products`-Eintrag, Konnektoren und ihre Zugangsdaten | Laufzeitkonfiguration pro Deployment, gesetzt mit `sk` |
| Workflow-Definitionen und ihre festen IDs | Das eigene Repository der App, angelegt mit `sk workflows create` |
| Freigaben der Workflows | Eine Person, pro Workflow und Umgebung, im Cockpit |
| Ablaufnachweise für Zugangsdaten | Das eigene Repository der App (nur Metadaten) |

Jede Änderung an einem Anmeldeanbieter oder `products`-Eintrag landet im Verlauf. Der Eintrag nennt die geänderten Felder, nicht ihre Werte.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| `401 invalid bearer token` | Das Token wurde abgelehnt. Prüfe `issuer_url`, `audience` und `required_claims` gegen ein echtes Token und ob es abgelaufen ist. |
| `403` bei einem Produktlauf oder `ok: false` bei `GET /v1/health` | Es fehlt die Freigabe aus Schritt 5 oder Zugangsdaten. Prüfe `sk apps show <product-id>`. |
| `429 rate_limited` | Das Tageslimit ist verbraucht. `sk apps show` nennt, wann der Tag zurückgesetzt wird. |
| `409 turn_busy` | Ein Aufruf desselben Durchgangs läuft noch. Warte ab, oder sende den ersten Aufruf mit seinem `idempotency_key` erneut; dann liefert die Engine dessen Ergebnis noch einmal. Ein anderer Schlüssel bekommt weiter 409, bis der erste Aufruf fertig ist. |
| `credential_unverified` und `PROBE_AUTH_UNVERIFIED`, oder „Verbunden · Anmeldung nicht geprüft“ im Cockpit | Der Konnektor hat keine Probe, und `GET /` lieferte keine klare Antwort. Setze einen Probe-Pfad mit authentifiziertem Lesezugriff (Schritt 3) und prüfe mit `sk connectors test <id>`. |
| Ein Konnektor gilt als abgemeldet | Dessen Probe hat 401 oder 403 geliefert. Hinterlege die Zugangsdaten neu (Schritt 3) und prüfe mit `sk connectors test <id>`. |
| `409` beim Löschen eines App-Benutzers | Die Person hat Anmeldeverknüpfungen zu einer anderen App oder zu SubKit selbst und wird nicht gelöscht. |
