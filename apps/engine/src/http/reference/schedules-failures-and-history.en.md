---
slug: schedules-failures-and-history
title: Keep an eye on schedules
summary: Read why a scheduled run failed or waits, and get it running again.
section: work
order: 17
audience: public
---
## Keep an eye on schedules

This chapter is for anyone whose workflows or tasks run on a schedule.
Afterwards you can read why a run failed, why a schedule waits or was paused, and what became of each scheduled time.
You also know how to resume a schedule and how to renew an approval before it ends.

### What you need

- A workflow or a task with a schedule. “Your first workflow” and “Hand over a goal as a task” describe how to create one.
- To read the history: `execution:read` for workflows, `task:read` for tasks.
- To resume a schedule: `workflow:write`.

### Read why a run failed

A failed run shows a notice with three parts: what happened, one recommended action and the collapsed **Technical details**.

1. Open the run through **Runs** or through the **Needs you** list on the **Overview**.
2. Read the cause and select the recommended action.

| Cause | Recommended action |
| --- | --- |
| **Sign-in rejected** | **Sign in again**: reconnect the connector. |
| **Approval no longer matches**, **Refused before the start** | **Review approval**: check and renew the approval. |
| **Timed out**, **Aborted**, **Connector unavailable**, **Provider rate limit reached**, **Not read completely**, **Error in the external system** | **Try again** |
| **AI budget reached** | **Ask an administrator**: an administrator raises the budget under **Settings** › **Budget** or continues this month without a limit. |
| **Connector missing**, **Unresolved placeholder**, **Answer in an unexpected shape**, **Message malformed**, **Not classified** | **Fix it in the chat**: the chat opens with the question about cause and fix. |

For confidential workflows (`execution_privacy: sensitive`) SubKit stores no failure details. From this version on, such a run still keeps its cause and one fixed sentence that says what to do. Example: “The connected service rejected the sign-in. Reconnect the connector, then run again. Nothing was changed by this step.” When SubKit recognizes no cause, it stays at “Sensitive execution failed.” The engine writes these sentences in English. The Cockpit says them in your language where it knows the cause, the reason for a hold or the failure code: on the overview for held and failing workflows, for a refused rerun and in error notices. In the technical details of a run, over the HTTP API and in `subkit` the engine’s English sentence remains. SubKit Desktop notifies in your language too.

### See what a schedule will cost

Before you create or change a schedule, and on every schedule, SubKit shows an estimate like “≈ €4.20 / month” with its basis, for example “from 12 runs, current model prices”.

- SubKit takes the average model cost of the last finished runs of the current version and multiplies it by the runs a month the rhythm makes.
- If the current version has not finished a run yet, SubKit takes the runs of earlier versions and says so.
- Without any finished run you read “No estimate yet”.
- Prices are the current model rates, in the currency set under **Usage**. Other costs, for example of external services, are not included.

The estimate follows the rhythm while you change it. You also see it on a schedule that waits for approval on the **Overview**.

### Why a schedule waits

A held schedule starts no run but loses nothing. As soon as you fix the reason, it goes on. The reason is shown on the workflow, on the **Overview** and in the **Schedule history**.

| What you read | What to do |
| --- | --- |
| “Held: no approval currently covers this version. Approve it and the schedule runs again.” | No approval is in force: it was never given, has expired, is used up or was revoked. Open the workflow, review it and give or renew the approval. |
| “Held: this version must change before its schedule can be approved.” | Change the workflow so that its schedule can be approved, then approve the new version. |
| “Held: the run is missing input. Add it in the schedule.” | Enter the missing input in the schedule. |
| “Held: the task has no standing permission. Give it and the schedule runs again.” | Open the task and select **Allow**. |
| “Held: the standing permission has ended. Renew it and the schedule runs again.” | Open the task and select **Allow**. |

### What happens after repeated failures

When a scheduled workflow run fails several times in a row for the same reason, SubKit slows the schedule down and then pauses it.

| Failures in a row | What SubKit does |
| --- | --- |
| 1 and 2 | Nothing. The next scheduled time runs as planned. |
| 3 | Waits 2 minutes after the last failure before the next run starts. |
| 4 | Waits 6 minutes after the last failure. |
| 5 | Pauses the schedule. No run starts until you resume it. |

- A failure is a scheduled run that failed or timed out. A run started by hand does not count.
- A successful run, a stopped run or a failure with a different cause ends the streak.
- Scheduled times that fall into a waiting period appear in the history as “Skipped: after repeated failures the schedule waits longer before it tries again.”
- SubKit reports the pause exactly once: as the item “Paused after repeated failures” under **Needs you**, as a push notification and as the event `schedule.auto_paused`.
- This applies to schedules of workflows. Schedules of tasks are not slowed down and not paused automatically.

### Resume a paused schedule

1. Open the workflow. At the top you read “Schedule paused automatically” with the number of failures and the date since which no run has started.
2. Fix the cause. If it is the approval, the notice offers **Renew approval**. Renew the approval first.
3. Select **Resume schedule**. You read “Schedule resumed”.

After resuming, SubKit counts failures afresh. The pause changed nothing else: workflow, approval and schedule are as they were.

### Read the schedule history

The history shows what became of each scheduled time.

1. Open the workflow or the task and select the **Schedule** tab.
2. Under **Schedule history**, read the entries, newest first. **Show older** loads more.
3. Select **Open the run** on an entry to see the run that belongs to it.

| Entry | Meaning |
| --- | --- |
| “On time” | The run started at the scheduled time. |
| “Started later than planned, because the engine was busy or not running.” | The run started more than 5 minutes after the scheduled time. |
| “Ran once for several missed times instead of catching up on each.” | Several missed times became one run. |
| “Skipped: this schedule does not run on weekends.” | The schedule excludes weekends. |
| “Skipped: this day is excluded in the schedule.” | The day is among the exceptions of the schedule. |
| “Skipped: the previous run was still going.” | A task only ever has one open run. |
| “Not started: the schedule paused itself after the same failure repeated.” | Resume the schedule as described above. |
| “Held: …” | The schedule waits for you. The reasons are in “Why a schedule waits”. |

Good to know:

- When the same reason repeats, SubKit merges the scheduled times into one entry. “Stands for 12 scheduled times” names the number.
- The history goes back 90 days. SubKit deletes older entries.
- A schedule that runs more often than once a minute writes no entry for runs on time.

### Renew an approval before it ends

A workflow approval and the standing permission of a task can have an end date. SubKit announces the end in two stages: a notice in the overview 7 days before, with push also on your devices, and a notification through channels and rules 3 days before.

| When | What happens |
| --- | --- |
| 7 days before: notice | A notice such as “The approval ends in 5 days” with **Renew** appears on the workflow or the task. An item appears under **Needs you**, and with push switched on the notice also reaches your devices. |
| 3 days before: notification | SubKit sends the event `workflow.approval_expiring` or `task.grant_expiring` once to subscriptions, webhooks and the `subkit` inbox. |
| Fewer than a tenth of the runs left | For an approval with a run limit, the item under **Needs you** appears as well. |

1. Select **Renew** in the notice or on the item under **Needs you**.
2. For a workflow the approval dialog opens, for a task the standing-permission dialog. Check what it lists and choose the new validity.
3. Confirm.

**Renew** extends nothing by itself. Only your confirmation in the dialog gives the new approval.

The event is sent only when the end would change something: the workflow has an active schedule in this environment or, in production, an active inbound webhook, and no longer-running approval covers the same version. For a task, a schedule or a one-time start that has not happened yet must be pending.

### Stop a running run

1. Open the running run.
2. Select **Stop this run** and confirm with **Stop run**.

The run ends right away. The schedule stays active. Steps that already reached an external system may have been carried out.

### Limits

- **The thresholds are fixed.** The waiting periods, the pause after five failures, the 90 days of history and the announcement periods cannot be set.
- **Missing input pauses nothing.** A schedule that lacks input is held and shows up on the **Overview**, but does not count as a failure.
- **The cause of the pause is coarse for confidential workflows.** For them SubKit counts all failures without a recognized cause as the same cause.
- **Some reasons for tasks have no text of their own.** When the standing permission is used up, no longer fits the changed task, the owner is missing, the AI provider is missing or the task is paused, the history only reads “Held until you act.” The task page shows the exact reason.
- **The `subkit` inbox of existing workspaces does not get the new events by itself.** Add them to the stored rule with `subkit notifications rules`.

### If something does not work

| What you see | What to do |
| --- | --- |
| “The schedule could not be resumed and stays paused.” | Check that you have `workflow:write` and try again. |
| The schedule pauses again shortly after resuming | The cause still exists. Open the latest run, read the cause and fix it first. |
| “The schedule history could not be loaded” | Select **Try again**. |
| “No scheduled time has come up yet.” | The schedule is new or paused. Entries appear only once a scheduled time was due. |
| The **Schedule** tab is missing on the workflow | You lack `execution:read`. Ask an administrator for it. |
| In the German Cockpit a notice names the cause in English, marked “Wortlaut der Engine” | The Cockpit does not know this code yet and therefore shows the engine’s sentence. The action next to it is translated. |

### The same in the terminal and over the HTTP API

With the `subkit` command line:

```bash
subkit schedules list
subkit schedules pause <schedule-id>
subkit schedules resume <schedule-id>
```

`subkit schedules resume` also resumes an automatically paused schedule and counts failures afresh. `subkit schedules list` shows the monthly estimate in the column `estimate`. There is no `subkit` command for the history.

| Route | Does |
| --- | --- |
| `GET /v1/workflows/{id}/schedule-occurrences` | Reads the history of a workflow, newest first. Needs `workflow:read`. |
| `GET /v1/tasks/{id}/schedule-occurrences` | Reads the history of a task. Needs `task:read`, and you must be allowed to see the task. |
| `PUT /v1/schedules/{id}` with `{"paused": false}` | Resumes a schedule. Needs `workflow:write`. |
| `GET /v1/schedules` | Lists schedules, each with `cost_projection`. Needs `workflow:read`. |
| `GET /v1/workflows/{id}/schedule-cost?cron=…&timezone=…` | Estimates the monthly cost for a rhythm before you save it. Needs `workflow:read`. |
| `POST /v1/executions/{id}/cancel` | Stops a running run. |

The response fields, the events and the reasons are listed in “Reference: desktop app, rules, schedules and problem reports”.
