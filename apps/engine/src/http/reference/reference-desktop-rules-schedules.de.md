---
slug: reference-desktop-rules-schedules
title: Referenz: Desktop-App, Regeln, Zeitpläne und Fehlerberichte
summary: Schlag die Routen, Felder, Ereignisse, Audit-Aktionen und Einstellungen für die Desktop-App, Regeln, Zeitpläne und Fehlerberichte nach.
section: reference
order: 5
audience: public
---
## Referenz: Desktop-App, Regeln, Zeitpläne und Fehlerberichte

Diese Seite listet die HTTP-API, die Ereignisse, den Audit-Trail und die Einstellungen für die Desktop-App, Regeln, Zeitpläne und Fehlerberichte.
Sie ist für alle, die mit eigenem Code oder im Betrieb auf diesen Teilen aufbauen. Die Kapitel mit den Arbeitsschritten sind „SubKit Desktop“, „Wann SubKit fragt“, „Zeitpläne im Blick behalten“, „Benachrichtigungen und Ruhezeiten“, „SubKit auf dich einstellen“ und „Einen Fehler melden“.
Die vollständige, maschinenlesbare Beschreibung jeder Route steht unter `/openapi.json` auf deiner Engine.

### Routen

| Route | Wer sie aufrufen darf | Bewirkt |
| --- | --- | --- |
| `GET /v1/workflows/{id}/schedule-occurrences` | `workflow:read` | Zeitplan-Verlauf eines Workflows, neueste zuerst. |
| `GET /v1/tasks/{id}/schedule-occurrences` | `task:read`, und du musst die Aufgabe sehen dürfen | Zeitplan-Verlauf einer Aufgabe, neueste zuerst. |
| `GET /v1/identity/me/setup` | Eine Person | Liest deine Einrichtung, mit empfohlenen Werten, wo nichts gewählt ist. |
| `PUT /v1/identity/me/setup` | Eine Person | Speichert die Einrichtung. Felder, die fehlen, behalten ihren Wert. |
| `GET /v1/approval-rules` | Eine Person | Listet deine angebotenen und aktiven Regeln. |
| `POST /v1/approval-rules/{id}/accept` | Eine Person in einer Browsersitzung | Speichert eine angebotene Regel. |
| `POST /v1/approval-rules/{id}/dismiss` | Eine Person | Lehnt eine angebotene Regel ab. |
| `POST /v1/approval-rules/{id}/renew` | Eine Person in einer Browsersitzung | Verlängert eine aktive Regel um 90 Tage ab jetzt. |
| `DELETE /v1/approval-rules/{id}` | Eine Person | Widerruft eine aktive Regel. |
| `POST /v1/feedback` | Eine Person in einer Browsersitzung | Legt einen Bericht im Eingang des Arbeitsbereichs ab. |
| `GET /v1/identity/desktop-login/start` | Niemand Angemeldetes; die App öffnet sie im Browser | Startet eine Desktop-Anmeldung und leitet auf die Bestätigungsseite weiter. |
| `GET` und `POST /v1/identity/desktop-login/confirm` | Die Person im Browser | Zeigt die Bestätigungsseite und nimmt die Entscheidung entgegen. Steht nicht in `/openapi.json`. |
| `POST /v1/identity/desktop-session` | Die Desktop-App, ohne Cookie | Tauscht den Anmeldecode gegen eine Cockpit-Sitzung. |
| `GET /v1/cockpit/installations` | Eine Sitzung des Cockpits: Browser, installierte Web-App oder Desktop-Gerät | Liefert `installations` mit jeder Installation der Person. `installation` nennt die installierte Web-App und ist nur für die Sitzung des normalen Cockpits gefüllt. |
| `POST /v1/cockpit/installations` | Die Sitzung des normalen Cockpits | Die Antwort enthält jetzt `kind`. |
| `DELETE /v1/cockpit/installations/{installationId}` | Die Sitzung des normalen Cockpits für jede eigene Installation; die Sitzung einer Installation nur für sich selbst | Widerruft eine Web-App oder ein Desktop-Gerät. |

„Eine Person“ heißt ein Benutzerkonto, kein Systemkonto. Ein Systemkonto bekommt `403 person_required`. Routen, die eine Browsersitzung brauchen, antworten anderen Aufrufern mit `403 human_confirmation_required`.

### Zeitplan-Verlauf

Abfrage-Parameter beider Routen: `limit` (Standard 50, höchstens 200) und `before` (ein Zeitpunkt nach ISO 8601). Die Antwort ist `{items, next_before}`. Gib `next_before` als `before` mit, um ältere Einträge zu lesen.

| Feld | Bedeutung |
| --- | --- |
| `id` | ID des Eintrags. |
| `workflow_id`, `task_id`, `schedule_id` | Wozu der Eintrag gehört. |
| `due_at` | Der fällige Termin. |
| `last_due_at` | Der letzte Termin, für den der Eintrag steht, wenn mehrere zusammengefasst wurden. |
| `started_at` | Wann der Run gestartet ist, falls einer gestartet ist. |
| `state` | `ran`, `ran_late`, `skipped` oder `held`. |
| `reason_code` | Der Grund, siehe die nächste Tabelle. Leer bei einem pünktlichen Run. |
| `skipped_count` | Für wie viele weitere Termine der Eintrag steht. |
| `execution_id`, `task_run_id` | Der Run, der zum Eintrag gehört. |
| `run_outcome` | Wie dieser Run endete: `running`, `succeeded`, `failed` oder `aborted`; `null` ohne Run. |
| `created_at`, `updated_at` | Wann der Eintrag geschrieben und zuletzt geändert wurde. |

| `reason_code` | `state` | Bedeutung |
| --- | --- | --- |
| `late_start` | `ran_late` | Mehr als 5 Minuten nach dem Termin gestartet. |
| `merged_missed` | `ran_late` | Ein Run für mehrere verpasste Termine. |
| `calendar_weekend` | `skipped` | Der Zeitplan schließt Wochenenden aus. |
| `calendar_skip_date` | `skipped` | Der Tag ist im Zeitplan ausgenommen. |
| `failure_backoff` | `skipped` | Wartezeit nach wiederholten Fehlern. |
| `previous_run_active` | `skipped` | Der vorige Run der Aufgabe war noch offen. |
| `repeated_failures` | `held` | Der Zeitplan hat sich selbst pausiert. |
| `input_required` | `held` | Dem Zeitplan fehlen Pflichteingaben. |
| `execution_authority_required` | `held` | Die aktuelle Version muss geändert werden, bevor sie freigegeben werden kann. |
| `execution_authority_unavailable` | `held` | Für die aktuelle Version gilt keine Freigabe: Sie wurde nie erteilt, ist abgelaufen, aufgebraucht oder widerrufen. Erteile oder erneuere sie. |
| `grant_required`, `grant_expired`, `grant_exhausted`, `grant_fingerprint_mismatch` | `held` | Die Dauererlaubnis der Aufgabe fehlt, ist abgelaufen, aufgebraucht oder passt nicht mehr zur Aufgabe. |
| `owner_unavailable`, `ai_access_missing`, `paused` | `held` | Die Besitzerin der Aufgabe ist nicht verfügbar, der Arbeitsbereich hat keinen KI-Anbieter, oder die Aufgabe ist pausiert. |

Einträge bleiben 90 Tage erhalten. Ein Zeitplan-Eintrag aus den Zeitplan-Routen trägt jetzt `auto_pause`: `null` oder `{paused_reason, failure_class, consecutive_failures, since}`, solange der Zeitplan nach wiederholten Fehlern pausiert ist.

Ein Run nennt die Ursache eines Fehlers jetzt als `outcome.cause_class` in `GET /v1/executions/{id}` und als `failure.cause_class` in der Liste, auch bei vertraulichen Workflows. Werte sind unter anderem `auth_failed`, `authority_mismatch`, `connector_missing`, `connector_unavailable`, `budget_exhausted`, `rate_limited`, `timeout`, `placeholder_unresolved`, `schema_mismatch`, `incomplete_read` und `payload_invalid`.

### Einrichtung

| Feld | Werte | Stellt ein |
| --- | --- | --- |
| `ask_before_writing` | `true`, `false` | Die Regel **Immer vorher fragen**: Jeder schreibende Schritt fragt, auch wenn der Auftrag ihn deckt. Standard `false`. |
| `default_environment` | `dev`, `prod` | Die Umgebung für neue Aufgaben und für die Prüfung neuer Workflows. Empfohlen: `dev`. |
| `approver` | `{"kind":"self"}` oder `{"kind":"teammate","email":"…"}` | Wer Freigabe-Hinweise bekommt. Empfohlen: `self`. |
| `notifications` | `{"mode":"immediately"}`, `{"mode":"working_hours","from":"HH:MM","to":"HH:MM","days":[1,2,3,4,5]}` oder `{"mode":"daily_digest","at":"HH:MM"}` | Wann Push zugestellt wird. Empfohlen: `immediately`. `days` nennt die Arbeitstage als Wochentage von `1` (Montag) bis `7` (Sonntag), jeden höchstens einmal; fehlt das Feld, gilt Montag bis Freitag. |
| `timezone` | Eine IANA-Zeitzone oder `null` für die Zeitzone des Arbeitsbereichs | Die Zone, in der die Uhrzeiten oben gelesen werden. |
| `critical_breakthrough` | `true`, `false` | Ob kritische Punkte trotz zurückgehaltenem Push sofort gemeldet werden. Standard `false`. |
| `first_job` | Text mit höchstens 120 Zeichen oder `null` | Den ersten Vorschlag im Cockpit. |
| `services` | Bis zu 50 Connector-Slugs | Welche Connectors das Cockpit zuerst anbietet. |

Die Antwort ergänzt `unset` (was von Umgebung, Freigaben und Benachrichtigungen noch nicht gewählt ist), `recommended`, `updated_at` und bei einer anderen Person `approver.user_id`, `approver.invitation` mit `member`, `pending` oder `needs_admin`, `approver.can_approve` und `approver.missing_permissions`. `can_approve` ist `true`, wenn die Rolle der Person `conversation:approve`, `task:grant` und `workflow:write` enthält; die Rolle Mitglied enthält alle drei. Bei `false` nennt `missing_permissions` die fehlenden Rechte, und Freigabe-Hinweise bleiben bei der Person, die fragt. Solange es die Person im Arbeitsbereich nicht gibt, ist `can_approve` `null`. Nennt ein Administrator eine unbekannte Adresse, enthält die Antwort genau einmal `invitation` mit `invite_id`, `plaintext_token` und `expires_at`; die Einladung trägt die Rolle Mitglied, und eine E-Mail wird nicht verschickt. Hat jemand ohne das Recht einzuladen eine Adresse genannt (`needs_admin`), verknüpft die Engine die Wahl von selbst, sobald ein Administrator diese Adresse einlädt oder anlegt. `PUT` antwortet mit `409 approver_already_known`, wenn die Adresse schon einer Person gehört, die nicht erneut eingeladen werden kann.

### Regeln

| Feld | Bedeutung |
| --- | --- |
| `id` | ID der Regel. |
| `state` | `offered`, `active`, `dismissed` oder `revoked`. Nur Regeln im Zustand `active` gelten. |
| `tool`, `verb` | Das Tool und die Art der Aktion: `send`, `create`, `update`, `run`, `save` oder `other`. |
| `connector`, `account` | Der Connector, auf den die Regel begrenzt ist. |
| `operation`, `target` | Die eine Operation, auf die die Regel begrenzt ist, zum Beispiel `POST /v1/messages/send`. |
| `recipients` | Die einzigen Empfänger, die die Regel deckt. Leer: Aktionen ohne Empfänger. |
| `content_class` | `no_content`: nur Aktionen ohne Text. `same_content`: nur genau der Text, der erlaubt wurde. `person_given`: nur Text, den die Person geschrieben oder als Entwurf gesehen hat. |
| `expires_at`, `expired` | Wann die Regel nicht mehr gilt und ob dieser Zeitpunkt vorbei ist. |
| `daily_limit`, `uses_today` | Erlaubte Ausführungen pro Tag nach UTC und Ausführungen heute. |
| `approvals_count`, `use_count` | Wie oft die Person diese Aktion von Hand erlaubt hat und wie oft die Regel sie laufen ließ. |
| `offered_at`, `decided_at`, `revoked_at`, `last_used_at`, `created_at` | Zeitpunkte. |

Passt eine Route nicht zum Zustand der Regel, antwortet sie mit `409 approval_rule_wrong_state`.

Ein Tool-Aufruf in einer Unterhaltung trägt `policy`, wenn die Chat-Regel ihn geprüft hat: `ran_without_asking`, `rule` (`user_instruction` oder `standing_rule`), `bound_action` (`verb`, `effect_class`, `target`, `account`, `recipients`, `content_summary`, `content`), `because` (`quote`, `message_id`), `rule_id`, `ask_reason`, `ask_detail` und `rule_offer`.

| `ask_reason` | Bedeutung |
| --- | --- |
| `ask_before_writing` | Die Person hat **Immer vorher fragen** eingeschaltet, deshalb fragt jeder Schritt, der schreibt. |
| `no_person` | Hinter dem Aufruf steht keine Person, zum Beispiel ein Systemkonto oder ein Run einer Aufgabe, den jemand anderes gestartet hat. |
| `write_gate` | Keine aktuelle Bitte der Person kann die Aktion abdecken. |
| `no_browser_session` | Der Aufrufer ist keine im Browser angemeldete Person. |
| `tool_not_coverable`, `effect_class_never`, `effect_unknown` | Diese Art von Aktion fragt immer, oder die Wirkung ist unbekannt. |
| `no_user_message`, `no_quote`, `quote_too_short`, `quote_too_long`, `quote_not_in_user_words`, `not_a_request`, `verb_mismatch` | Die Person hat diese Aktion nicht mit eigenen Worten verlangt. |
| `quote_in_pasted_text` | Der Auftrag steht in eingefügtem oder zitiertem Text. |
| `conditional_or_negated` | Der Auftrag enthält eine Bedingung oder eine Verneinung. |
| `recipient_not_named`, `target_not_named`, `value_not_said`, `date_not_said`, `header_not_requested` | Die Aktion enthält etwas, das die Person nicht genannt hat. |
| `content_not_given` | Der Text stammt nicht von der Person und wurde nicht als Entwurf gezeigt. |
| `already_used` | Der Auftrag hat diese Aktion schon einmal gedeckt. |
| `rule_expired`, `rule_daily_limit`, `rule_content` | Es gibt eine Regel, aber sie gilt gerade nicht. |
| `undecidable` | Die Prüfung ließ sich nicht abschließen, deshalb fragt die Aktion. |

### Fehlerberichte

Body von `POST /v1/feedback`:

| Feld | Grenzen |
| --- | --- |
| `kind` | `bug`, `idea` oder `other`. |
| `message` | 1 bis 5.000 Zeichen. |
| `client_request_id` | Optionale UUID. Dieselbe ID noch einmal zu senden legt den Bericht nicht doppelt ab. |
| `diagnostics` | Optional: `app_version`, `platform`, `server_version`, `connection` (je bis 200 Zeichen), `client_kind` (`browser`, `desktop` oder `pwa`), `route` (bis 2.000 Zeichen) und `recent_errors` (bis zu 10 Einträge mit `code` und `at`). |
| `attachments` | Bis zu 3 Einträge mit `filename` und `content_base64`, je 2 MB: PNG, JPG, PDF, TXT oder JSON. |
| `screenshot_png_base64` | Optionales PNG mit höchstens 4 MB. |

Die Antwort ist `201` mit `id`, `intake_item_id` und `replayed`. Fehler: `409 report_id_taken`, `413 attachment_too_large` oder `screenshot_too_large`, `422 attachment_invalid`, `attachment_type`, `attachment_rejected` oder `screenshot_invalid` und `429 rate_limit_exceeded` nach 5 Berichten in 10 Minuten je Person.

### Desktop-Anmeldung und Installationen

Abfrage-Parameter von `GET /v1/identity/desktop-login/start`:

| Parameter | Format |
| --- | --- |
| `code_challenge` | 43 Zeichen, base64url. |
| `code_challenge_method` | `S256`. |
| `state` | 16 bis 128 Zeichen. |
| `device_id` | Eine UUID, die die App einmal je Serverprofil erzeugt. |
| `device_label` | 1 bis 64 Zeichen ohne Steuerzeichen. |
| `redirect_uri` | Optional: `subkit://callback` oder, wo angenommen, `subkit-dev://callback`. |
| `app_version` | Die Version der App wie `@@SUBKIT_VERSION@@`, auch mit Vorabkennung wie `@@SUBKIT_VERSION@@-beta.1`. Fehlt sie oder liegt sie unter `server.desktop_min_version`, antwortet die Engine mit `426`. |

Body von `POST /v1/identity/desktop-session`: `code` (43 Zeichen), `code_verifier` (43 bis 128 Zeichen), `app_version` und optional `state`. Die Antwort ist `200` mit `installation_id`, `cockpit_path` und `created` und setzt das Sitzungs-Cookie.

Der Start und die Bestätigung sind Seiten im Browser. Ein Browser, der sie öffnet, bekommt jede der folgenden Ablehnungen als Seite mit dem nächsten Schritt und dem Code, nie als JSON. Ein API-Client bekommt JSON.

| Antwort | Bedeutung |
| --- | --- |
| `400 invalid_redirect_uri` | Dieser Server nimmt das Ziel nicht an. |
| `401 invalid_grant` | Der Code ist unbekannt, verbraucht, abgelaufen oder passt nicht zum Verifier oder zum State. |
| `403 cross_origin_rejected` | Der Tausch wurde aus einer Webseite aufgerufen. |
| `403 csrf_rejected` | Die Bestätigung kam von einer fremden Seite. Ein Token aus einer früheren Browser-Sitzung öffnet stattdessen die Bestätigungsseite erneut. |
| `403 user_inactive` | Das Konto ist deaktiviert. |
| `403 tenant_unavailable` | Der Arbeitsbereich ist nicht verfügbar. |
| `426 desktop_app_outdated` | Die App ist älter als `server.desktop_min_version` oder nennt keine `app_version`. Beim Start und auf der Bestätigungsseite ist die Antwort eine Seite mit dem Header `X-SubKit-Error: desktop_app_outdated`, beim Tausch JSON. Der Anmeldecode wird nicht verbraucht. |
| `429 rate_limit_exceeded` | Zu viele Aufrufe von einer Adresse; siehe `Retry-After`. |

Jeder Eintrag von `installations` in `GET /v1/cockpit/installations` hat `id`, `kind` (`browser` oder `desktop`), `device_label` (`null` bei der installierten Web-App), `created_at`, `last_used_at` (die letzte Anfrage einer Sitzung dieser Installation oder `null`) und `current` (`true` für die Installation, aus der die Anfrage kommt). Eine Anfrage mit dem Cookie einer widerrufenen Installation bekommt `403 installation_revoked`. `DELETE` aus der Sitzung einer Installation für eine andere Installation bekommt `403 own_installation_only`.

Die Sitzung eines Desktop-Geräts gilt 30 Tage ohne Nutzung und höchstens 90 Tage seit der Anmeldung; die des Browsers und der installierten Web-App 8 Stunden ohne Nutzung und höchstens 24 Stunden. Ein Widerruf beendet jede sofort.

### Ereignisstrom des Cockpits

`GET /v1/cockpit/events/stream` sendet neben den Änderungen diese Rahmen und Felder:

| Rahmen oder Feld | Bedeutung |
| --- | --- |
| `hello` | Erster Rahmen mit `cursor`, `version` und `heartbeat_ms`. Trägt `delivery`, solange Hinweise für die Person zurückgehalten werden. |
| `ping` | Lebenszeichen im Abstand von `heartbeat_ms`. Trägt `delivery` wie `hello`; ein `ping` ohne das Feld heißt, dass wieder angekündigt werden darf. |
| `delivery` an einer Änderung | `held`: nicht ankündigen. `critical_only`: nur kritische Punkte ankündigen. Die Liste dessen, was dich braucht, und ihr Zähler werden trotzdem aktualisiert. |
| `server.shutdown` | Letzter Rahmen, wenn die Engine stoppt. Der Client zeigt den Zustand „offline“ ohne Fehlerhinweis und verbindet sich mit wachsendem Abstand neu. |

Das Cockpit kündigt aus dem Strom nichts an; es aktualisiert nur seine Listen. SubKit Desktop kündigt neue Punkte als Benachrichtigung des Systems an und hält sich dabei an `delivery`: Zurückgehaltene Punkte meldet es, sobald ein Rahmen ohne `delivery` eintrifft. Pausieren mehrere Zeitpläne zugleich, fassen SubKit Desktop und die Web-Push-Benachrichtigung sie zu einer Meldung zusammen, zum Beispiel „3 Zeitpläne wurden pausiert“; der Push trägt dafür `summary.schedules_paused`.

Die Felder von `clients.desktop` in `/.well-known/service-descriptor.json` sind in „Desktop-Anmeldung betreiben“ beschrieben.

### Ereignisse und Punkte der Liste „Braucht dich“

Drei Ereignistypen sind neu. Alle drei lassen sich in Abonnements und Webhooks nutzen, und der `subkit`-Eingang eines neuen Arbeitsbereichs bekommt sie.

| Ereignis | Wird gesendet, wenn | Felder |
| --- | --- | --- |
| `schedule.auto_paused` | Ein Zeitplan eines Workflows sich nach fünf Fehlern in Folge selbst pausiert hat. Einmal. | `severity`, `workflow_id`, `workflow_name`, `schedule_id`, `environment`, `paused_reason`, `failure_class`, `consecutive_failures`, `paused_at`, `remedy` |
| `workflow.approval_expiring` | Eine Freigabe, von der ein Zeitplan oder ein eingehender Webhook abhängt, in 3 Tagen endet. Einmal je Freigabe. | `workflow_id`, `workflow_name`, `authority_id`, `environment`, `valid_until`, `remedy` |
| `task.grant_expiring` | Die Dauererlaubnis einer geplanten Aufgabe in 3 Tagen endet. Einmal je Dauererlaubnis. | `task_id`, `task_name`, `grant_id`, `environment`, `valid_until`, `remedy` |

`remedy` nennt als `{kind, href}`, was hilft: `resume` bei einem pausierten Zeitplan, `renew` bei einer Freigabe.

Änderungen an der Liste unter `GET /v1/attention`:

- Neuer Grund `schedule_auto_paused`, Klasse `stopped`, mit `counts.consecutive_failures`.
- Die Gründe `approval_expiring` und `task_grant_expiring` erscheinen jetzt 7 Tage vor dem Ende, und die erste Handlung einer endenden Workflow-Freigabe ist `renew`.
- `subject.environment` nennt bei Connectors `dev` oder `prod`.
- `waiting_on` mit `user_id` und `name` ist gesetzt, wenn du eine andere Person für Freigaben genannt hast.

Änderungen am Ereignisstrom des Cockpits unter `/v1/cockpit/events/stream`:

- `hello` trägt `heartbeat_ms`.
- Ereignisse zu einem Connector, einem Workflow oder einer Aufgabe tragen `attention_id` mit dem Punkt, um den es geht.
- `session.ended` mit `status` und `code` ist das letzte Ereignis, wenn die Sitzung einer Installation endet.

### Audit-Aktionen

| Aktion | Wird geschrieben, wenn |
| --- | --- |
| `user.setup_updated` | Eine Person ihre Einrichtung geändert hat. |
| `tool_approval_rule.created` | Eine Person eine angebotene Regel gespeichert hat. |
| `tool_approval_rule.dismissed` | Eine Person eine angebotene Regel abgelehnt hat. |
| `tool_approval_rule.revoked` | Eine Person eine Regel widerrufen hat. |
| `tool_approval_rule.renewed` | Eine Person eine Regel verlängert hat. |
| `feedback.submitted` | Ein Bericht abgelegt wurde. Der Eintrag verweist auf den Eintrag im Eingang. |
| `desktop_login.code_issued` | Eine Person ein Desktop-Gerät im Browser bestätigt hat. |
| `desktop_login.denied` | Eine Desktop-Anmeldung abgebrochen wurde oder ihr Tausch gescheitert ist. |
| `desktop_login.completed` | Die Desktop-App ihre Sitzung bekommen hat. |

Eine Aktion, die im Chat ohne Frage lief, steht als `tool_policy.confirmation_skipped` mit dem Grund `user_instruction` oder `standing_rule` im Audit-Trail. Der Eintrag nennt das Verb, die Wirkung, das Ziel, das Konto, die Empfänger, eine Kurzfassung des Inhalts und bei eigenen Worten das Zitat. Ein Zeitplan, der sich selbst pausiert hat, steht als `schedule.paused` mit dem Grund `repeated_failures` und dem Akteur `system` darin.

### Einstellungen

| Einstellung | Typ | Standard | Bedeutung |
| --- | --- | --- | --- |
| `server.desktop_min_version` | Version wie `@@SUBKIT_VERSION@@` | `@@DESKTOP_MIN_APP_VERSION@@` | Die älteste Version von SubKit Desktop, die diese Engine annimmt. Wird als `clients.desktop.min_version` veröffentlicht und bei der Desktop-Anmeldung von der Engine durchgesetzt (`426 desktop_app_outdated`). |
| `server.desktop_dev_callback` | `true` oder `false` | `false` | Nimmt zusätzlich `subkit-dev://callback` als Anmeldeziel an, für Entwicklungs-Builds. |

Beide stehen auch in der erzeugten Referenz der Einstellungen. Die Schwellen für Zeitpläne, Regeln und Ankündigungen sind fest und haben keine Einstellung: Wartezeit ab 3 Fehlern, Pause bei 5, Verlauf für 90 Tage, Regeln für 90 Tage mit 20 Ausführungen pro Tag, vor dem Ende einer Freigabe ein Hinweis 7 Tage vorher in der Übersicht, mit Push auch auf den Geräten, und eine Benachrichtigung über Kanäle und Regeln 3 Tage vorher.
