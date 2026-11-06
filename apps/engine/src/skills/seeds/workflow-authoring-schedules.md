---
slug: workflow-authoring-schedules
scope: global
title: Workflow Schedules And Cadence
description: A cadence in the goal becomes the workflow's own `schedule` trigger (cron and timezone rules, phrases that are not cadence), and questions about existing schedules are answered from `list_schedules`.
activates_when: [{"kind":"tool","tool":"list_schedules"},{"kind":"tool","tool":"create_schedule"},{"kind":"tool","tool":"update_schedule"},{"kind":"tool","tool":"get_schedule"},{"kind":"intent_keyword","word":"cron"},{"kind":"intent_keyword","word":"schedule"},{"kind":"intent_keyword","word":"zeitplan"},{"kind":"intent_keyword","word":"every day"},{"kind":"intent_keyword","word":"every weekday"},{"kind":"intent_keyword","word":"every monday"},{"kind":"intent_keyword","word":"every 10 minutes"},{"kind":"intent_keyword","word":"daily"},{"kind":"intent_keyword","word":"hourly"},{"kind":"intent_keyword","word":"weekly"},{"kind":"intent_keyword","word":"täglich"},{"kind":"intent_keyword","word":"stündlich"},{"kind":"intent_keyword","word":"wöchentlich"},{"kind":"intent_keyword","word":"jeden tag"},{"kind":"intent_keyword","word":"jeden werktag"},{"kind":"intent_keyword","word":"jeden montag"},{"kind":"intent_keyword","word":"alle 10 minuten"}]
side_effects: read
idempotency: none
maturity: stable
tags: [authoring, workflow, schedule]
version: 1
---

# Workflow Schedules And Cadence

## Recurring cadence is part of the workflow definition

If the user's goal phrases a cadence — examples below — the workflow
**MUST** carry a `trigger: { kind: "schedule", cron, tz, execution_mode }` field. The
execution mode defaults to `prod`; use `dev` explicitly only for an authoring loop. The
schedule binding is part of the workflow definition, not a separate
call. `author_workflow` generates the trigger from the goal phrasing (and
`edit_workflow_patch` can set or change it later); on commit `applyTriggerBindings`
upserts the `workflows_schedules` row and emits the
`schedule.trigger.bound` audit event. **Do not call `create_schedule`
separately for a brand-new workflow** — that path is for binding a cron
to an already-saved workflow, and creating a parallel binding without the
workflow's own `trigger` field leaves the two out of sync.

Cadence phrasings that require a `schedule` trigger:

- English: "every day at 7pm", "daily at 9am", "hourly", "every weekday
  at 09:00", "every Monday morning", "every 10 minutes", "weekly on
  Friday", "at 18:00 UTC".
- German: "täglich um 18 Uhr", "stündlich", "jeden Werktag um 9", "jeden
  Montagmorgen", "alle 10 Minuten", "wöchentlich freitags".

Cron-translation contract (the LLM owns this; **do not** ask the engine
for a regex-to-cron translator — none exists):

| Phrase | Cron |
|---|---|
| "every day at 7pm" | `0 19 * * *` |
| "daily at 9am" | `0 9 * * *` |
| "weekdays at 09:00" | `0 9 * * 1-5` |
| "every Monday morning" | `0 8 * * 1` |
| "every 10 minutes" | `*/10 * * * *` |
| "hourly" | `0 * * * *` |
| "weekly on Friday" | `0 9 * * 5` |

Timezone resolution chain — apply in order, stop at the first match:

1. If the user prompt names an IANA timezone (`Europe/Berlin`,
   `America/New_York`, `Asia/Tokyo`) or a colloquial city ("Berlin",
   "New York"), use it verbatim — translate colloquial names to IANA.
2. Otherwise, fall back to the tenant default exposed in the
   conversation context (when present).
3. Otherwise, default to `UTC`.

Negative examples — these phrases are NOT cadence and must not produce
`trigger.kind=schedule`:

- "send a webhook every time stripe charges fail" → `trigger.kind = "webhook"`.
- "retry the failed step every 30 seconds" → step-level retry config, not a workflow trigger.
- "the workflow runs in production" → operational note, not cadence.

## Schedule questions must be grounded by `list_schedules`

When the user asks about existing schedules ("list my scheduled
workflows", "is my daily report still scheduled", "which jobs run at
night"), call `list_schedules` **this turn** before answering. Do not
infer schedule state from prior turns or session memory — the table can
change between turns. The same rule applies to `get_schedule` /
`list_workflows` when the question is workflow-specific.

If the user asks to "reschedule" or "change the time of" a workflow,
the path is:

1. `list_schedules` (or `list_workflows`) to locate the row.
2. `update_schedule` (or re-author the workflow with a new
   `trigger.cron`) to apply the new cadence.

Never claim a tool is unavailable without naming the structured
envelope it returned. The palette in this conversation is fixed and
listed in the tool schemas — if a tool you need is genuinely absent,
call `cannot_help` with `reason: "tool_missing"` and the tool name.
