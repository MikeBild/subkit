---
slug: reference-pair-invites-pause
title: Referenz: Freigabe zu zweit, Einladungen, Offline-Berichte und Benachrichtigungspause
summary: Schlag die Routen, Felder, Zustände und Audit-Aktionen für die Freigabe zu zweit, das Senden von Einladungen, Berichte aus der Offline-Warteschlange und die Benachrichtigungspause nach.
section: reference
order: 6
audience: public
---
## Referenz: Freigabe zu zweit, Einladungen, Offline-Berichte und Benachrichtigungspause

Diese Seite listet Routen, Felder und Audit-Aktionen zu vier Funktionen: Workflow-Freigabe zu zweit, Einladung senden, offline geschriebene Berichte und die persönliche Benachrichtigungspause.
Sie richtet sich an Entwicklerinnen, Entwickler und Betreibende, die darauf aufbauen. Die aufgabenbezogenen Kapitel heißen „SubKit auf dich einstellen“, „Benachrichtigungen und Ruhezeiten“ und „Einen Fehler melden“.
Die vollständige, maschinenlesbare Beschreibung jeder Route findest du unter `/openapi.json` auf deiner Engine.

### Routen

| Route | Wer darf sie aufrufen | Tut |
| --- | --- | --- |
| `GET /v1/workspace/approval-policy` | `workflow:read` | Sagt, ob eine Person oder zwei Personen einen Workflow freigeben und wie viele Personen freigeben dürfen. |
| `PUT /v1/workspace/approval-policy` | `rbac:write` | Schaltet zwischen `single` und `pair` um. |
| `POST /v1/workflows/{id}/pair-approvals` | `workflow:write` in einer Browser-Sitzung | Hält die erste von zwei Freigaben fest. |
| `GET /v1/workflows/{id}/pair-approvals` | `workflow:read` | Listet die Anfragen eines Workflows, neueste zuerst. Optional `state`. |
| `POST /v1/workflows/{id}/pair-approvals/{request_id}/approve` | `workflow:write` in einer Browser-Sitzung, nicht die erste Person | Hält die zweite Freigabe fest. Ab jetzt gibt es die Ausführungsberechtigung. |
| `POST /v1/workflows/{id}/pair-approvals/{request_id}/decline` | `workflow:write` in einer Browser-Sitzung, nicht die erste Person | Schließt die Anfrage als abgelehnt. |
| `POST /v1/workflows/{id}/pair-approvals/{request_id}/withdraw` | Die erste Person oder jemand mit `rbac:write`, in einer Browser-Sitzung | Schließt die Anfrage als zurückgezogen. |
| `POST /v1/identity/users/{id}/invites/send` | Eine Administratorin oder ein Administrator | Stellt einer noch nicht beigetretenen Person einen neuen Einladungslink aus und versucht, ihn zuzustellen. |
| `GET /v1/identity/me/notification-pause` | Eine Person | Liest deine Pause. |
| `PUT /v1/identity/me/notification-pause` | Eine Person | Pausiert deine Benachrichtigungen. |
| `DELETE /v1/identity/me/notification-pause` | Eine Person | Setzt deine Benachrichtigungen fort. |
| `POST /v1/feedback` | Eine Person in einer Browser-Sitzung | Nimmt das neue Feld `created_on_device_at` an und antwortet mit `replayed`. |

### Freigabe zu zweit

Unter `pair` gilt eine Freigabe erst, wenn zwei verschiedene Personen mit `workflow:write` dieselbe geprüfte Grenze freigegeben haben: Version, Effekt-Digest, Umgebung, Zeitraum und Run-Grenze.

- Die erste Freigabe legt eine Anfrage an, keine Ausführungsberechtigung. Nichts darf laufen.
- Erst die zweite Freigabe legt die Ausführungsberechtigung an. Die Engine prüft die Grenze dabei erneut.
- Eine Person kann nie beide Plätze besetzen. Eine zweite Browser-Sitzung derselben Person ist dieselbe Person.
- Solange `pair` gilt, antwortet jeder Weg, auf dem eine Person allein freigeben würde, mit `409 pair_approval_required`. Das betrifft `POST /v1/workflows/{id}/execution-authorities`, dauerhafte Berechtigungen von Aufgaben und `…/until-revoked`.
- Die Freigabekarte im Chat speichert den Workflow stattdessen und hält die erste von zwei Freigaben fest. Die abgeschlossene Prüfung nennt die Anfrage in `result.pair_request_id`. Einen Zeitplan legst du nicht im selben Schritt an: `422 pair_schedule_unsupported`.
- `pair` lässt sich nur einschalten, wenn mindestens zwei aktive Personen freigeben dürfen: `409 pair_needs_two_approvers` mit `details.eligible_approvers`. Gehen später Personen, bleiben offene Anfragen offen. Eine Administratorin oder ein Administrator schaltet ausdrücklich auf `single` zurück. Einen stillen Rückfall gibt es nicht.

Zustände einer Anfrage:

| `state` | Bedeutung |
| --- | --- |
| `pending` | Wartet auf die zweite Person. |
| `approved` | Beide haben freigegeben. `authority_id` nennt die Ausführungsberechtigung. |
| `declined` | Die zweite Person hat abgelehnt. |
| `withdrawn` | Die erste Person oder eine Administratorin bzw. ein Administrator hat die Anfrage zurückgezogen. |
| `expired` | Niemand hat innerhalb von 72 Stunden freigegeben, oder bevor die Freigabe geendet hätte. |
| `stale` | `stale_reason` ist `manifest_changed` (der Workflow hat sich geändert) oder `first_approver_unavailable` (die erste Person darf nicht mehr freigeben). |

Fehlercodes: `pair_same_person` (403), `pair_not_requester` (403), `pair_request_not_found` (404), `pair_not_required`, `pair_request_closed`, `pair_request_expired`, `pair_request_stale`, `authority_manifest_changed` (409) und `pair_start_run_unsupported` (422).

In der Einrichtung nennt `approver: {kind: "pair", email}` die zweite Person. Die Antwort ergänzt `pair`: `active`, `needs_second_approver` (startet, sobald die zweite Person mit einer Rolle beigetreten ist, die freigeben darf) oder `needs_admin` (eine Administratorin oder ein Administrator schaltet es ein). Wählst du später **Ich selbst**, schaltet das den Arbeitsbereich nicht zurück.

Die Aufmerksamkeitsliste zeigt eine offene Anfrage mit dem Grund `pair_approval_requested` allen, die den zweiten Platz einnehmen dürfen. Die anfragende Person sieht sie mit `waiting_on` auf die genannte zweite Person.

### Einladung senden

`POST /v1/identity/users/{id}/invites/send` mit optionalem `ttl_minutes`. Die Antwort ist immer `201`, weil in jedem Fall eine neue Einladung entsteht. Der bisherige Link gilt nicht mehr.

| `delivery` | Bedeutung |
| --- | --- |
| `sent` | Die Einladung ging per E-Mail hinaus. `to` zeigt die Adresse teilweise verdeckt. |
| `copy_link` | Nichts wurde gesendet. `reason` sagt warum: `no_mail_transport`, `mail_failed` oder `no_public_url`. Die Antwort enthält `plaintext_token`, `link_path` und, wenn die Engine ihre Adresse kennt, `url`. Gib den Link selbst weiter. |

Die Engine hat noch keinen Mailversand, deshalb lautet die Antwort `copy_link` mit `no_mail_transport`. Weitere Fehler: `409 not_invited` (die Person ist schon beigetreten) und `429 rate_limit_exceeded` mit `retry_after_seconds` (höchstens 5 Sendungen je Administratorin oder Administrator und 2 je eingeladener Person in 10 Minuten).

### Berichte aus der Offline-Warteschlange

- `client_request_id` macht einen Bericht idempotent. Dieselbe ID legt nichts doppelt ab; die Antwort trägt dann `replayed: true`. Ein erneuter Versuch für einen schon abgelegten Bericht zählt nie gegen das Limit.
- `created_on_device_at` ist der Zeitpunkt, zu dem der Bericht auf dem Gerät geschrieben wurde. Er gilt als Erfassungszeit, wenn er in den letzten 30 Tagen und höchstens 5 Minuten in der Zukunft liegt; sonst zählt die Serverzeit.
- Die Warteschlange liegt im Client. Cockpit und SubKit Desktop nutzen dasselbe Modell: ein Bericht nach dem anderen, neue Versuche nach 30 Sekunden, verdoppelt bis 30 Minuten; bei `429` wartet sie so lange, wie der Server sagt; bei `401` und `403` bis zur nächsten Anmeldung; `409`, `413` und `422` beenden den Versuch. Ein Bericht geht nur an den Server und für die Person, für die er geschrieben wurde, und verfällt nach 14 Tagen.

### Benachrichtigungspause

Inhalt von `PUT`: `{"mode": "for", "minutes": 60}`, `{"mode": "until", "until": "…"}` oder `{"mode": "until_resumed"}`. Bei `for` und `until` muss das Ende in der Zukunft und höchstens 30 Tage voraus liegen, sonst `422 pause_in_past` oder `422 pause_too_long`; `until_resumed` hat kein Ende (`until: null`) und keine Grenze. Die Antwort ist `{paused, mode, paused_at, until}`. Eine abgelaufene Pause liest sich als `paused: false`.

Während der Pause hält SubKit Push-Benachrichtigungen und Desktop-Banner zurück. Die Aufmerksamkeitsliste und die Zähler zählen weiter. Hast du dringende Punkte trotz Ruhezeiten eingeschaltet, erreichen sie dich weiterhin. Im Cockpit-Ereignisstrom tragen Ankündigungen `delivery: held` (oder `critical_only`), `held_by: pause` und bei einer Pause mit Ende `held_until`. Ruhezeiten erscheinen dort mit `held_by: schedule`. Ein offener Strom übernimmt eine Änderung innerhalb von 30 Sekunden.

### Audit-Aktionen

| Aktion | Geschrieben, wenn |
| --- | --- |
| `workspace.approval_policy_changed` | Der Arbeitsbereich zwischen `single` und `pair` wechselt. `metadata.source` ist `policy`, `setup` oder `approver_joined`. |
| `workflow.pair_approval_requested` | Die erste Person freigibt. |
| `workflow.pair_approval_approved` | Die zweite Person freigibt. `workflow.authority_granted` folgt. |
| `workflow.pair_approval_declined`, `workflow.pair_approval_withdrawn` | Eine Person die Anfrage schließt. |
| `workflow.pair_approval_expired`, `workflow.pair_approval_stale` | Die Engine die Anfrage schließt. `reason` nennt bei `stale` die Ursache. |
| `user.invite_delivery` | Eine Einladung gesendet oder als Link zurückgegeben wurde. `reason` ist der Grund für `copy_link`. |
| `user.notifications_paused`, `user.notifications_resumed` | Du Benachrichtigungen pausierst oder fortsetzt. |
