---
slug: reference-desktop-rules-schedules
title: Reference: desktop app, rules, schedules and problem reports
summary: Look up the routes, fields, events, audit actions and settings for the desktop app, rules, schedules and problem reports.
section: reference
order: 5
audience: public
---
## Reference: desktop app, rules, schedules and problem reports

This page lists the HTTP API, the events, the audit trail and the settings for the desktop app, rules, schedules and problem reports.
It is for developers and operators who build on these parts. The task-oriented chapters are “SubKit Desktop”, “When SubKit asks”, “Keep an eye on schedules”, “Notifications and quiet hours”, “Set SubKit up for yourself” and “Report a bug”.
The complete, machine-readable description of every route is at `/openapi.json` on your engine.

### Routes

| Route | Who may call it | Does |
| --- | --- | --- |
| `GET /v1/workflows/{id}/schedule-occurrences` | `workflow:read` | Schedule history of a workflow, newest first. |
| `GET /v1/tasks/{id}/schedule-occurrences` | `task:read`, and the task must be visible to you | Schedule history of a task, newest first. |
| `GET /v1/identity/me/setup` | A person | Reads your setup choices, with recommended values where unset. |
| `PUT /v1/identity/me/setup` | A person | Stores setup choices. Fields left out keep their value. |
| `GET /v1/approval-rules` | A person | Lists your offered and active approval rules. |
| `POST /v1/approval-rules/{id}/accept` | A person in a browser session | Stores an offered rule. |
| `POST /v1/approval-rules/{id}/dismiss` | A person | Declines an offered rule. |
| `POST /v1/approval-rules/{id}/renew` | A person in a browser session | Renews an active rule for 90 days from now. |
| `DELETE /v1/approval-rules/{id}` | A person | Revokes an active rule. |
| `POST /v1/feedback` | A person in a browser session | Files a report in the workspace inbox. |
| `GET /v1/identity/desktop-login/start` | Nobody signed in; opened by the app in the browser | Starts a desktop sign-in and redirects to the confirmation page. |
| `GET` and `POST /v1/identity/desktop-login/confirm` | The person in the browser | Shows the confirmation page and takes the decision. Not part of `/openapi.json`. |
| `POST /v1/identity/desktop-session` | The desktop app, without a cookie | Exchanges the sign-in code for a Cockpit session. |
| `GET /v1/cockpit/installations` | A session of the Cockpit: browser, installed web app or desktop device | Returns `installations` with every installation of the person. `installation` names the installed web app and is filled for the session of the normal Cockpit only. |
| `POST /v1/cockpit/installations` | The session of the normal Cockpit | The answer now carries `kind`. |
| `DELETE /v1/cockpit/installations/{installationId}` | The session of the normal Cockpit for any of your installations; the session of an installation only for itself | Revokes a web app or a desktop device. |

“A person” means a user account, not a system account. A system account gets `403 person_required`. Routes that need a browser session answer other callers with `403 human_confirmation_required`.

### Schedule history

Query parameters of both routes: `limit` (default 50, at most 200) and `before` (a time in ISO 8601). The answer is `{items, next_before}`. Pass `next_before` as `before` to read older entries.

| Field | Meaning |
| --- | --- |
| `id` | ID of the entry. |
| `workflow_id`, `task_id`, `schedule_id` | What the entry belongs to. |
| `due_at` | The scheduled time. |
| `last_due_at` | The last scheduled time the entry stands for, when several were merged. |
| `started_at` | When the run started, if one started. |
| `state` | `ran`, `ran_late`, `skipped` or `held`. |
| `reason_code` | Why, see the next table. Empty for a run on time. |
| `skipped_count` | How many further scheduled times the entry stands for. |
| `execution_id`, `task_run_id` | The run that belongs to the entry. |
| `run_outcome` | How that run ended: `running`, `succeeded`, `failed` or `aborted`; `null` without a run. |
| `created_at`, `updated_at` | When the entry was written and last changed. |

| `reason_code` | `state` | Meaning |
| --- | --- | --- |
| `late_start` | `ran_late` | Started more than 5 minutes after the scheduled time. |
| `merged_missed` | `ran_late` | One run for several missed times. |
| `calendar_weekend` | `skipped` | The schedule excludes weekends. |
| `calendar_skip_date` | `skipped` | The day is excluded in the schedule. |
| `failure_backoff` | `skipped` | Waiting period after repeated failures. |
| `previous_run_active` | `skipped` | The previous run of the task was still open. |
| `repeated_failures` | `held` | The schedule paused itself. |
| `input_required` | `held` | The schedule lacks required input. |
| `execution_authority_required` | `held` | No approval covers the current version. |
| `execution_authority_expired` | `held` | The approval has expired. |
| `execution_authority_exhausted` | `held` | The approval is used up. |
| `execution_authority_revoked` | `held` | The approval was revoked. |
| `execution_authority_changed` | `held` | The workflow would now do something the approval does not cover. |
| `grant_required`, `grant_expired`, `grant_exhausted`, `grant_fingerprint_mismatch` | `held` | The standing permission of the task is missing, ended, used up or no longer fits the task. |
| `owner_unavailable`, `ai_access_missing`, `paused` | `held` | The owner of the task is unavailable, the workspace has no AI provider, or the task is paused. |

Entries are kept for 90 days. A schedule entry returned by the schedule routes now carries `auto_pause`: `null`, or `{paused_reason, failure_class, consecutive_failures, since}` while the schedule is paused after repeated failures.

A run now names the cause of a failure as `outcome.cause_class` in `GET /v1/executions/{id}` and as `failure.cause_class` in the list, also for confidential workflows. Values include `auth_failed`, `authority_mismatch`, `connector_missing`, `connector_unavailable`, `budget_exhausted`, `rate_limited`, `timeout`, `placeholder_unresolved`, `schema_mismatch`, `incomplete_read` and `payload_invalid`.

### Setup choices

| Field | Values | Sets |
| --- | --- | --- |
| `ask_before_writing` | `true`, `false` | The rule **Always ask first**: every step that writes asks, even when the request covers it. Default `false`. |
| `default_environment` | `dev`, `prod` | The environment for new tasks and for the review of new workflows. Recommended: `dev`. |
| `approver` | `{"kind":"self"}` or `{"kind":"teammate","email":"…"}` | Who gets approval notifications. Recommended: `self`. |
| `notifications` | `{"mode":"immediately"}`, `{"mode":"working_hours","from":"HH:MM","to":"HH:MM","days":[1,2,3,4,5]}` or `{"mode":"daily_digest","at":"HH:MM"}` | When push is delivered. Recommended: `immediately`. `days` names the working days as weekdays from `1` (Monday) to `7` (Sunday), each at most once; without the field, Monday to Friday applies. |
| `timezone` | An IANA time zone, or `null` for the time zone of the workspace | The zone the times above are read in. |
| `critical_breakthrough` | `true`, `false` | Whether critical items are pushed at once despite held push. Default `false`. |
| `first_job` | Text of at most 120 characters, or `null` | The first suggestion in the Cockpit. |
| `services` | Up to 50 connector slugs | Which connectors the Cockpit offers first. |

The answer adds `unset` (which of environment, approver and notifications are not chosen yet), `recommended`, `updated_at` and, for a teammate, `approver.user_id`, `approver.invitation` with `member`, `pending` or `needs_admin`, `approver.can_approve` and `approver.missing_permissions`. `can_approve` is `true` when the person’s role holds `conversation:approve`, `task:grant` and `workflow:write`; the member role holds all three. With `false`, `missing_permissions` names the missing permissions, and approval notifications stay with the person who asks. While the person does not exist in the workspace, `can_approve` is `null`. When an administrator names an unknown address, the answer carries `invitation` with `invite_id`, `plaintext_token` and `expires_at` exactly once; the invitation carries the member role, and no email is sent. When someone without the right to invite named an address (`needs_admin`), the engine links the choice by itself as soon as an administrator invites or adds that address. `PUT` answers `409 approver_already_known` when the address already belongs to a person who cannot be invited again.

### Approval rules

| Field | Meaning |
| --- | --- |
| `id` | ID of the rule. |
| `state` | `offered`, `active`, `dismissed` or `revoked`. Only `active` rules apply. |
| `tool`, `verb` | The tool and the kind of action: `send`, `create`, `update`, `run`, `save` or `other`. |
| `connector`, `account` | The connector the rule is limited to. |
| `operation`, `target` | The one operation the rule is limited to, for example `POST /v1/messages/send`. |
| `recipients` | The only recipients the rule covers. Empty: actions without a recipient. |
| `content_class` | `no_content`: only actions without text. `same_content`: only the exact text that was approved. `person_given`: only text the person wrote or saw as a draft. |
| `expires_at`, `expired` | When the rule stops applying, and whether that time has passed. |
| `daily_limit`, `uses_today` | Runs allowed per day in UTC, and runs today. |
| `approvals_count`, `use_count` | How often the person approved this action by hand, and how often the rule let it run. |
| `offered_at`, `decided_at`, `revoked_at`, `last_used_at`, `created_at` | Times. |

A route that does not fit the state of the rule answers `409 approval_rule_wrong_state`.

A tool call in a conversation carries `policy` when the chat rule looked at it: `ran_without_asking`, `rule` (`user_instruction` or `standing_rule`), `bound_action` (`verb`, `effect_class`, `target`, `account`, `recipients`, `content_summary`, `content`), `because` (`quote`, `message_id`), `rule_id`, `ask_reason`, `ask_detail` and `rule_offer`.

| `ask_reason` | Meaning |
| --- | --- |
| `ask_before_writing` | The person turned on **Always ask first**, so every step that writes asks. |
| `no_person` | No person stands behind the call, for example a system account or a task run someone else started. |
| `write_gate` | No current request of the person can cover the action. |
| `no_browser_session` | The caller is not a person signed in in the browser. |
| `tool_not_coverable`, `effect_class_never`, `effect_unknown` | The kind of action always asks, or its effect is unknown. |
| `no_user_message`, `no_quote`, `quote_too_short`, `quote_too_long`, `quote_not_in_user_words`, `not_a_request`, `verb_mismatch` | The person did not ask for this action in their own words. |
| `quote_in_pasted_text` | The request stands in pasted or quoted text. |
| `conditional_or_negated` | The request carries a condition or a negation. |
| `recipient_not_named`, `target_not_named`, `value_not_said`, `date_not_said`, `header_not_requested` | The action contains something the person did not state. |
| `content_not_given` | The text is not the person’s and was not shown as a draft. |
| `already_used` | The request already covered this action once. |
| `rule_expired`, `rule_daily_limit`, `rule_content` | A rule exists but does not apply. |
| `undecidable` | The check could not be completed, so the action asks. |

### Problem reports

Body of `POST /v1/feedback`:

| Field | Limits |
| --- | --- |
| `kind` | `bug`, `idea` or `other`. |
| `message` | 1 to 5,000 characters. |
| `client_request_id` | Optional UUID. Sending the same ID again does not file the report twice. |
| `diagnostics` | Optional: `app_version`, `platform`, `server_version`, `connection` (up to 200 characters each), `client_kind` (`browser`, `desktop` or `pwa`), `route` (up to 2,000 characters) and `recent_errors` (up to 10 entries with `code` and `at`). |
| `attachments` | Up to 3 entries with `filename` and `content_base64`, 2 MB each: PNG, JPG, PDF, TXT or JSON. |
| `screenshot_png_base64` | Optional PNG of at most 4 MB. |

The answer is `201` with `id`, `intake_item_id` and `replayed`. Errors: `409 report_id_taken`, `413 attachment_too_large` or `screenshot_too_large`, `422 attachment_invalid`, `attachment_type`, `attachment_rejected` or `screenshot_invalid`, and `429 rate_limit_exceeded` after 5 reports in 10 minutes per person.

### Desktop sign-in and installations

Query parameters of `GET /v1/identity/desktop-login/start`:

| Parameter | Format |
| --- | --- |
| `code_challenge` | 43 characters, base64url. |
| `code_challenge_method` | `S256`. |
| `state` | 16 to 128 characters. |
| `device_id` | A UUID the app creates once per server profile. |
| `device_label` | 1 to 64 characters without control characters. |
| `redirect_uri` | Optional: `subkit://callback` or, where accepted, `subkit-dev://callback`. |
| `app_version` | The version of the app such as `@@SUBKIT_VERSION@@`, also with a pre-release tag such as `@@SUBKIT_VERSION@@-beta.1`. Without it, or below `server.desktop_min_version`, the engine answers `426`. |

Body of `POST /v1/identity/desktop-session`: `code` (43 characters), `code_verifier` (43 to 128 characters), `app_version` and optionally `state`. The answer is `200` with `installation_id`, `cockpit_path` and `created`, and it sets the session cookie.

The start and the confirmation are pages in the browser. A browser that opens them gets every refusal below as a page with the next step and the code, never as JSON. An API client gets JSON.

| Answer | Meaning |
| --- | --- |
| `400 invalid_redirect_uri` | The target is not accepted by this server. |
| `401 invalid_grant` | The code is unknown, used, expired or does not match the verifier or the state. |
| `403 cross_origin_rejected` | The exchange was called from a web page. |
| `403 csrf_rejected` | The confirmation came from another site. A token from an earlier browser session opens the confirmation page again instead. |
| `403 user_inactive` | The account is deactivated. |
| `403 tenant_unavailable` | The workspace is unavailable. |
| `426 desktop_app_outdated` | The app is older than `server.desktop_min_version` or names no `app_version`. At the start and on the confirmation page the answer is a page with the header `X-SubKit-Error: desktop_app_outdated`, at the exchange JSON. The sign-in code is not consumed. |
| `429 rate_limit_exceeded` | Too many calls from one address; see `Retry-After`. |

Each entry of `installations` in `GET /v1/cockpit/installations` has `id`, `kind` (`browser` or `desktop`), `device_label` (`null` for the installed web app), `created_at`, `last_used_at` (the last request a session of this installation made, or `null`) and `current` (`true` for the installation the request comes from). A request with the cookie of a revoked installation answers `403 installation_revoked`. `DELETE` from the session of an installation for another installation answers `403 own_installation_only`.

The session of a desktop device lasts 30 days without use and at most 90 days since the sign-in; that of the browser and the installed web app 8 hours without use and at most 24 hours. A revocation ends any of them at once.

### Event stream of the Cockpit

`GET /v1/cockpit/events/stream` sends these frames and fields besides the changes:

| Frame or field | Meaning |
| --- | --- |
| `hello` | First frame with `cursor`, `version` and `heartbeat_ms`. Carries `delivery` while notifications for the person are held back. |
| `ping` | Heartbeat every `heartbeat_ms`. Carries `delivery` like `hello`; a `ping` without the field means announcing is allowed again. |
| `delivery` on a change | `held`: do not announce. `critical_only`: announce only critical items. The list of what needs you and its counter are updated all the same. |
| `server.shutdown` | Last frame when the engine stops. The client shows the state “offline” without an error notice and reconnects with a growing delay. |

The Cockpit announces nothing from the stream; it only updates its lists. SubKit Desktop announces new items as a system notification and follows `delivery`: it reports held items as soon as a frame without `delivery` arrives. When several schedules pause at once, SubKit Desktop and the web push notification fold them into one message, for example “3 schedules were paused”; the push carries `summary.schedules_paused` for that.

The fields of `clients.desktop` in `/.well-known/service-descriptor.json` are described in “Operate the desktop sign-in”.

### Events and attention items

Three event types are new. All three can be used in subscriptions and webhooks, and the `subkit` inbox of a new workspace receives them.

| Event | Sent when | Fields |
| --- | --- | --- |
| `schedule.auto_paused` | A workflow schedule paused itself after five failures in a row. Sent once. | `severity`, `workflow_id`, `workflow_name`, `schedule_id`, `environment`, `paused_reason`, `failure_class`, `consecutive_failures`, `paused_at`, `remedy` |
| `workflow.approval_expiring` | An approval that a schedule or an inbound webhook depends on ends within 3 days. Sent once per approval. | `workflow_id`, `workflow_name`, `authority_id`, `environment`, `valid_until`, `remedy` |
| `task.grant_expiring` | The standing permission of a scheduled task ends within 3 days. Sent once per permission. | `task_id`, `task_name`, `grant_id`, `environment`, `valid_until`, `remedy` |

`remedy` names what helps as `{kind, href}`: `resume` for a paused schedule, `renew` for an approval.

Changes to the attention list at `GET /v1/attention`:

- New reason `schedule_auto_paused`, class `stopped`, with `counts.consecutive_failures`.
- The reasons `approval_expiring` and `task_grant_expiring` now appear 7 days before the end, and the first action of an expiring workflow approval is `renew`.
- `subject.environment` names `dev` or `prod` for connectors.
- `waiting_on` with `user_id` and `name` is set when you named another person as approver.

Changes to the Cockpit event stream at `/v1/cockpit/events/stream`:

- `hello` carries `heartbeat_ms`.
- Events about a connector, a workflow or a task carry `attention_id` with the item they are about.
- `session.ended` with `status` and `code` is the last event when the session of an installation ends.

### Audit actions

| Action | Written when |
| --- | --- |
| `user.setup_updated` | A person changed their setup choices. |
| `tool_approval_rule.created` | A person stored an offered rule. |
| `tool_approval_rule.dismissed` | A person declined an offered rule. |
| `tool_approval_rule.revoked` | A person revoked a rule. |
| `tool_approval_rule.renewed` | A person renewed a rule. |
| `feedback.submitted` | A report was filed. The entry points at the inbox item. |
| `desktop_login.code_issued` | A person confirmed a desktop device in the browser. |
| `desktop_login.denied` | A desktop sign-in was cancelled or its exchange failed. |
| `desktop_login.completed` | The desktop app received its session. |

An action that ran in chat without a question is written as `tool_policy.confirmation_skipped` with the reason `user_instruction` or `standing_rule`. The entry names the verb, the effect, the target, the account, the recipients, a short summary of the content and, for the person’s own words, the quote. A schedule that paused itself is written as `schedule.paused` with the reason `repeated_failures` and the actor `system`.

### Settings

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `server.desktop_min_version` | Version such as `@@SUBKIT_VERSION@@` | `@@DESKTOP_MIN_APP_VERSION@@` | Oldest SubKit Desktop version this engine accepts. Published as `clients.desktop.min_version` and enforced by the engine at the desktop sign-in (`426 desktop_app_outdated`). |
| `server.desktop_dev_callback` | `true` or `false` | `false` | Also accept `subkit-dev://callback` as a sign-in target, for development builds. |

Both also appear in the generated settings reference. The thresholds for schedules, rules and notices are fixed and have no setting: backoff from 3 failures, pause at 5, history for 90 days, rules for 90 days with 20 runs a day, before an approval ends a notice in the overview 7 days before, with push also on devices, and a notification through channels and rules 3 days before.
