---
slug: reference-pair-invites-pause
title: Reference: pair approval, invitations, offline reports and notification pause
summary: Look up the routes, fields, states and audit actions for two-person approval, sending invitations, reports from an offline queue and pausing notifications.
section: reference
order: 6
audience: public
---
## Reference: pair approval, invitations, offline reports and notification pause

This page lists the routes, fields and audit actions behind four features: two-person workflow approval, sending an invitation, reports that were written offline, and a personal notification pause.
It is for developers and operators who build on them. The task-oriented chapters are “Set SubKit up for yourself”, “Notifications and quiet hours” and “Report a bug”.
The complete, machine-readable description of every route is at `/openapi.json` on your engine.

### Routes

| Route | Who may call it | Does |
| --- | --- | --- |
| `GET /v1/workspace/approval-policy` | `workflow:read` | Says whether one person or two people approve a workflow, and how many people may approve. |
| `PUT /v1/workspace/approval-policy` | `rbac:write` | Switches between `single` and `pair`. |
| `POST /v1/workflows/{id}/pair-approvals` | `workflow:write` in a browser session | Records the first of two approvals. |
| `GET /v1/workflows/{id}/pair-approvals` | `workflow:read` | Lists the requests of a workflow, newest first. Optional `state`. |
| `POST /v1/workflows/{id}/pair-approvals/{request_id}/approve` | `workflow:write` in a browser session, not the first approver | Records the second approval. The execution authority exists from now on. |
| `POST /v1/workflows/{id}/pair-approvals/{request_id}/decline` | `workflow:write` in a browser session, not the first approver | Closes the request as declined. |
| `POST /v1/workflows/{id}/pair-approvals/{request_id}/withdraw` | The first approver, or someone with `rbac:write`, in a browser session | Closes the request as withdrawn. |
| `POST /v1/identity/users/{id}/invites/send` | An administrator | Issues a new invitation link for a person who has not joined yet and tries to deliver it. |
| `GET /v1/identity/me/notification-pause` | A person | Reads your pause. |
| `PUT /v1/identity/me/notification-pause` | A person | Pauses your notifications. |
| `DELETE /v1/identity/me/notification-pause` | A person | Resumes your notifications. |
| `POST /v1/feedback` | A person in a browser session | Takes the new field `created_on_device_at` and answers with `replayed`. |

### Pair approval

Under `pair`, an approval only takes effect when two different people with `workflow:write` have both approved the same reviewed boundary: version, effect digest, environment, window and run limit.

- The first approval creates a request, not an execution authority. Nothing may run.
- The execution authority is created only with the second approval. The engine checks the boundary again at that moment.
- One person can never take both places. A second browser session of the same person is the same person.
- While `pair` applies, every way that would let one person approve alone answers `409 pair_approval_required`. That covers `POST /v1/workflows/{id}/execution-authorities`, standing permissions of tasks and `…/until-revoked`.
- The approval card in chat saves the workflow and records the first of two approvals instead. The completed review names the request in `result.pair_request_id`. A schedule cannot be added in the same step: `422 pair_schedule_unsupported`.
- `pair` can only be switched on when at least two active people may approve: `409 pair_needs_two_approvers` with `details.eligible_approvers`. If people leave later, open requests stay open. An administrator switches back to `single` explicitly. There is no silent fallback.

States of a request:

| `state` | Meaning |
| --- | --- |
| `pending` | Waits for the second person. |
| `approved` | Both approved. `authority_id` names the execution authority. |
| `declined` | The second person declined. |
| `withdrawn` | The first person or an administrator withdrew the request. |
| `expired` | Nobody approved within 72 hours, or before the approval would have ended. |
| `stale` | `stale_reason` is `manifest_changed` (the workflow changed) or `first_approver_unavailable` (the first person can no longer approve). |

Error codes: `pair_same_person` (403), `pair_not_requester` (403), `pair_request_not_found` (404), `pair_not_required`, `pair_request_closed`, `pair_request_expired`, `pair_request_stale`, `authority_manifest_changed` (409) and `pair_start_run_unsupported` (422).

In the setup, `approver: {kind: "pair", email}` names the partner. The answer adds `pair`: `active`, `needs_second_approver` (pair starts once the partner has joined with a role that may approve) or `needs_admin` (an administrator switches it on). Choosing **Me** later does not switch the workspace back.

The attention list shows an open request with the reason `pair_approval_requested` to everyone who may take the second place. The person who asked sees it with `waiting_on` set to the named partner.

### Send an invitation

`POST /v1/identity/users/{id}/invites/send` with an optional `ttl_minutes`. It answers `201`, because a new invitation exists in every case. The previous link stops working.

| `delivery` | Meaning |
| --- | --- |
| `sent` | The invitation went out by email. `to` shows the address partly masked. |
| `copy_link` | Nothing was sent. `reason` says why: `no_mail_transport`, `mail_failed` or `no_public_url`. The answer carries `plaintext_token`, `link_path` and, when the engine knows its address, `url`. Hand the link over yourself. |

The engine has no mail transport yet, so the answer is `copy_link` with `no_mail_transport`. Further errors: `409 not_invited` (the person has already joined) and `429 rate_limit_exceeded` with `retry_after_seconds` (at most 5 sends per administrator and 2 per invited person within 10 minutes).

### Reports from an offline queue

- `client_request_id` makes a report idempotent. The same id files nothing twice; the answer then carries `replayed: true`. A retry of a report that was already filed never counts against the rate limit.
- `created_on_device_at` is the time the report was written on the device. It is kept as the capture time when it lies within the last 30 days and at most 5 minutes in the future; otherwise the server time counts.
- The queue lives in the client. Both the Cockpit and SubKit Desktop use the same model: one report at a time, retries after 30 seconds, doubling up to 30 minutes; `429` waits as long as the server says; `401` and `403` wait until you sign in again; `409`, `413` and `422` end the attempt. A report is only ever sent for the server and the person it was written for, and is dropped after 14 days.

### Notification pause

Body of `PUT`: `{"mode": "for", "minutes": 60}`, `{"mode": "until", "until": "…"}` or `{"mode": "until_resumed"}`. The end has to lie in the future and at most 30 days ahead, otherwise `422 pause_in_past` or `422 pause_too_long`. The answer is `{paused, mode, paused_at, until}`. A pause that has ended reads as `paused: false`.

During the pause, push notifications and desktop banners are held back. The attention list and the counters keep counting. If you opted into critical items despite quiet hours, they still reach you. On the Cockpit event stream, announcements carry `delivery: held` (or `critical_only`), `held_by: pause` and, for a pause with an end, `held_until`. Quiet hours show up there with `held_by: schedule`. An open stream picks up a change within 30 seconds.

### Audit actions

| Action | Written when |
| --- | --- |
| `workspace.approval_policy_changed` | The workspace switches between `single` and `pair`. `metadata.source` is `policy`, `setup` or `approver_joined`. |
| `workflow.pair_approval_requested` | The first person approves. |
| `workflow.pair_approval_approved` | The second person approves. `workflow.authority_granted` follows. |
| `workflow.pair_approval_declined`, `workflow.pair_approval_withdrawn` | A person closes the request. |
| `workflow.pair_approval_expired`, `workflow.pair_approval_stale` | The engine closes the request. `reason` names the cause for `stale`. |
| `user.invite_delivery` | An invitation was sent or handed back as a link. `reason` is the `copy_link` reason. |
| `user.notifications_paused`, `user.notifications_resumed` | You pause or resume notifications. |
