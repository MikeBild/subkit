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
- To accept a proposed fix: `workflow:write`.

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

### Why a schedule waits

A held schedule starts no run but loses nothing. As soon as you fix the reason, it goes on. The reason is shown on the workflow, on the **Overview** and in the **Schedule history**.

| What you read | What to do |
| --- | --- |
| “On hold: this version has no approval. Approve it and the schedule runs again.” | Open the workflow, review it and give the approval. |
| “On hold: the approval has expired. Renew it and the schedule runs again.” | Renew the approval. |
| “On hold: the approved number of runs is used up. Renew the approval and the schedule runs again.” | Renew the approval. |
| “On hold: the approval was revoked. Approve it again and the schedule runs again.” | Review the workflow and approve it again. |
| “On hold: the workflow changed since it was approved. Review and approve the new version.” | Open the new version, review it and approve it. |
| “On hold: the run is missing input. Add it in the schedule.” | Enter the missing input in the schedule. |
| “On hold: the task has no standing permission. Give it and the schedule runs again.” | Open the task and select **Allow**. |
| “On hold: the standing permission has ended. Renew it and the schedule runs again.” | Open the task and select **Allow**. |

### Why a workflow is on hold

While a workflow is on hold, its automatic starts wait. Nothing starts automatically until you fix the reason. On the **Overview**, the item under **Needs you** names the reason with a short label and one sentence.

| Short label | What the sentence says | What to do |
| --- | --- | --- |
| **Change needed before approval** | The schedule cannot be approved without a change to the workflow. If SubKit knows the step, the sentence names it and the cause. | Change the named step, for example with **Fix it in the chat**. Then approve the new version. |
| **Approval expired** | The approval for its schedule has expired. | Renew the approval. |
| **Approved runs used up** | The approved runs of its schedule are used up. | Renew the approval. |
| **Approval revoked** | The approval for its schedule was revoked. | Approve the workflow again. |
| **Changed since approval** | The workflow changed since its schedule was approved. | Review the new version and approve it. |
| **Input missing** | Its schedule is missing an input. | Add the input in the schedule. |

The same reasons also hold back an inbound webhook. The sentence then reads, for example: “… is on hold: it refuses calls from the webhook ‘…’ because its approval has expired”. Fix the reason in the same way.

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

### Accept only part of a proposed fix

When a workflow keeps failing, SubKit can propose a fix. You find it on the **Overview** under **Needs you**. A fix can consist of several changes. You can take only the ones you want.

1. Open the proposed fix on the **Overview**. Each change appears as one sentence, for example “Changes the address from … to ….”
2. Untick the changes you do not want. Changes you untick are left out. “2 of 3 selected” shows your choice.
3. If you left out a change, select **Test first**. The test replays the failing step with your selection and writes nothing to other systems. After a passing test you read “The test ran without an error. Nothing was written to other systems.”
4. Select **Accept and save**. SubKit applies the selected changes to the workflow.

Good to know:

- With every change selected, you can accept without a test.
- Once you leave out a change, **Accept and save** only becomes available after a passing test of exactly this selection. If you change the selection after the test, test again.
- To turn down the whole fix, open the menu next to the buttons and choose **Reject**.
- When the chat proposes a change to a step, it lists the changes the same way. There you choose **Accept** or **Accept and save**, without a test.

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
| “Not started: the schedule was paused automatically after the same failure repeated.” | Resume the schedule as described above. |
| “On hold: …” | The schedule waits for you. The reasons are in “Why a schedule waits”. |

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

### Settle a run with an unknown outcome

Sometimes SubKit stops while a step is sending a change to another system, for example during a restart. Then it is unclear whether the change arrived. SubKit never sends such a change again by itself. The run gets the status **Outcome unknown** and waits for your answer.

1. Open the run, for example through **Runs**. It reads “It is unclear whether the change of step ‘…’ arrived”.
2. Check in the other system whether the change is there. For example, check whether the email went out or the record exists.
3. Select the answer that fits.

| Answer | What happens |
| --- | --- |
| **It arrived** | The step counts as done and is not sent again. You read “Noted. The run continues after this step.” |
| **It did not arrive** | The run sends this step again. You read “Noted. The run sends this step again.” |

- Until you answer, nothing is sent again.
- If several steps were sending, answer for each of them. The run continues once every step has an answer.
- A trial run of a single step can end the same way. It then reads “It is unclear whether this step went through. Open the Run to settle it.”

### Limits

- **The thresholds are fixed.** The waiting periods, the pause after five failures, the 90 days of history and the announcement periods cannot be set.
- **Missing input pauses nothing.** A schedule that lacks input is held and shows up on the **Overview**, but does not count as a failure.
- **The cause of the pause is coarse for confidential workflows.** For them SubKit counts all failures without a recognized cause as the same cause.
- **Some reasons for tasks have no text of their own.** When the standing permission is used up, no longer fits the changed task, the owner is missing, the AI provider is missing or the task is paused, the history only reads “On hold until you act.” The task page shows the exact reason.
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
| “Your answer could not be saved. Try again.” | Select the answer again. |
| “You may not start this workflow, so you cannot answer this.” | Ask an administrator for the permission, or ask someone who may start the workflow to answer. |
| “This run was interrupted while sending a change. The step is not known yet.” | Answer in the terminal. `subkit executions steps <run-id>` shows the step key. |
| “Test this selection first.” | Select **Test first**, or select every change again. |
| “The test did not confirm this selection, so it cannot be accepted.” | Choose another selection, or accept the whole fix. |
| “No test is available for this change.” | Accept the fix as a whole, or reject it. |

### The same in the terminal and over the HTTP API

With the `subkit` command line:

```bash
subkit schedules list
subkit schedules pause <schedule-id>
subkit schedules resume <schedule-id>
```

`subkit schedules resume` also resumes an automatically paused schedule and counts failures afresh. There is no `subkit` command for the history.

Answer a run with an unknown outcome, and accept part of a proposed fix:

```bash
subkit executions resolve-write <run-id> --step <step-key> --outcome arrived
subkit executions resolve-write <run-id> --step <step-key> --outcome not_arrived
subkit patch-candidates preview <candidate-id>
subkit patch-candidates dry-run <candidate-id> --accept 0,2
subkit patch-candidates approve <candidate-id> --review-digest <digest> --accept 0,2
```

`subkit` shows a run with an unknown outcome as `uncertain (Outcome unknown)` and names the steps that wait for an answer. `--accept` takes the numbers of the changes, starting at 0, in the order of the preview. For part of a fix, use the `review_digest` from the dry-run of exactly that selection. Without `--accept` you take the whole fix, with the digest from `preview`.

| Route | Does |
| --- | --- |
| `GET /v1/workflows/{id}/schedule-occurrences` | Reads the history of a workflow, newest first. Needs `workflow:read`. |
| `GET /v1/tasks/{id}/schedule-occurrences` | Reads the history of a task. Needs `task:read`, and you must be allowed to see the task. |
| `PUT /v1/schedules/{id}` with `{"paused": false}` | Resumes a schedule. Needs `workflow:write`. |
| `POST /v1/executions/{id}/cancel` | Stops a running run. A run with an unknown outcome ends as aborted. |
| `POST /v1/executions/{id}/resolve-write` with `{"step_key": "<step-key>", "outcome": "arrived"}` | Answers for one step of a run with an unknown outcome: `arrived` or `not_arrived`. Needs `execution:abort`. Answers `409` when the run or the step is not waiting for an answer. |
| `POST /v1/patch-candidates/{id}/dry-run` with `{"accepted_operations": [0, 2]}` | Tests the selected changes of a fix without changing the workflow. Needs `workflow:read`. |
| `POST /v1/patch-candidates/{id}/approve` with `expected_review_digest` and `accepted_operations` | Applies the selected changes. Needs `workflow:write`. |

The response fields, the events and the reasons are listed in “Reference: desktop app, rules, schedules and problem reports”.
