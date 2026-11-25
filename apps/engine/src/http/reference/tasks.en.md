---
slug: tasks
title: Hand over a goal as a task
summary: Give SubKit a goal with limits, let it work towards it and confirm the result.
section: work
order: 12
audience: public
---
## Hand over a goal as a task

This chapter is for anyone who wants SubKit to reach a goal instead of repeating fixed steps.
Afterwards you can create a task, start it by hand or on a schedule, answer its questions and confirm its result.
You also know what a task may do on its own and where it has to ask you.

### Task or workflow

A workflow is a recipe. It runs the same fixed steps every time and does not think.

A task is an assignment. You name a goal and how you recognize that it is reached. SubKit plans the way, works through it, asks when it needs you and reports back.

A connector is the key to another service. Neither a workflow nor a task reaches a service without one.

| You want | Use |
| --- | --- |
| The same steps every time, fast and cheap | A workflow |
| A goal where the way can differ from case to case | A task |
| A check that may need several attempts or a later look | A task |
| Something a task has done the same way several times | A workflow, built from that run |

Example: “Follow up on open invoices until they are paid” is a task. It has to look, remind, wait and look again. “Send the weekly numbers every Monday” is a workflow.

A task costs AI calls for every round of work. A workflow only costs them in its “Ask AI” steps. When a task has proven the way, turn it into a workflow.

### What you need

- A role that may use tasks. The Member and Admin roles can. The built-in `enduser` role cannot.
- An AI provider for the workspace. Without one, no run starts.
- The workflows and connectors the task should use. A task can only use what you bind to it.

### Create a task

1. In the navigation, open **Tasks**.
2. Select **New task**.
3. Fill in the three fields:
   - **What should get done?** The goal in one or two sentences.
   - **How do you know it is done?** The condition that ends the task, for example “all invoices from October are paid”.
   - **What may it work with?** Pick the workflows and connectors.
4. Select **Create**.

Everything else is prefilled and collapsed: the schedule, the limits, web search, and whether the task works in **Test** or **Live**.

In the chat you get there faster. Describe the goal, work through it once and ask SubKit to save it as a task. SubKit shows what it will save and waits for your confirmation. The task takes its steps from the plan of that conversation. It stays bound to the message that asked for it: the chat shows the task under that message, and **Asked for in** on the task’s **Overview** tab leads back to it.

Good to know:

- A task has a plan of 1 to 19 steps. SubKit adds one last step itself: you confirm the result.
- The step ID `confirm-result` is reserved for that final confirmation.
- A task binds at most 20 workflows, 20 connectors and 20 skills. Bound skills are loaded at the start of every run.
- Saving starts nothing and allows nothing.
- The task belongs to you. Other people in the workspace do not see it. Admins see every task.

### Start a task

There are three ways to start. You choose them on the **Schedule** tab.

| Option | What happens |
| --- | --- |
| **Only by hand** | A run starts when you select **Start**. |
| **Once on …** | One run starts at the time you set. |
| **Daily**, **Weekdays**, **Weekly** | A run starts at each of these times, in the time zone you chose. |
| **Own rhythm** | You enter a cron expression with five fields. |

Below the choice, the page says in plain words when the next run starts.

Three rules apply to schedules:

- Two runs are at least 15 minutes apart. SubKit refuses a tighter schedule when you save.
- A task has one open run at a time. While a run is running, waiting or sleeping, a scheduled start that comes due is held. It starts once that run has ended.
- Several missed start times become one catch-up run, not one per missed time. This applies when SubKit was switched off and when starts were held.

A start by hand needs nothing else: by selecting **Start** you allow this one run within the limits of the task.
A start on a schedule needs your standing permission, because nobody is there to select **Start**.

### The standing permission

The standing permission lets a task start on its own. It applies to exactly this task as it is now.

1. Open the task. The status line reads that the task may not start on its own yet, and offers **Allow**.
2. Read what the dialog lists. It names the schedule, and for every bound workflow and connector what it reads, writes or starts.
3. Under **Validity**, choose how long: **Until revoked**, **30 days** or **7 days**.
4. Confirm with **Allow**.

Only a person signed in to the Cockpit in the browser can allow this. It does not work with an API key, in the `subkit` command line or from an AI client.

What it covers:

- **The scheduled starts of this task**, in the environment the task works in.
- **The bound workflows.** SubKit creates a normal workflow approval for each of them, with the same validity. You find these under **Approvals** on the workflow, and other starts of that workflow use them too. A workflow that already has a valid approval keeps it.
- **Not** the writes the task makes through a connector. Those ask every time.

If a bound workflow cannot be approved for repeated runs, the dialog names it. The task still starts on its own, but that workflow asks you in every run. A workflow marked as sensitive (`execution_privacy: sensitive`) cannot be started from a task at all.

The standing permission ends when:

- You select **Revoke** on the **Permissions** tab.
- Its time is up, or its run limit is used and the last of those runs has ended.
- You change the task: the goal, the done condition, the plan, what is bound, web search, the schedule, the limits, or Test and Live. A new name, description or category changes nothing.
- You delete the task, or its owner leaves the workspace.

When it ends, the workflow approvals it created end with it, unless another task with its own standing permission uses the same workflow.

Seven days before the end, or when fewer than a tenth of the runs are left, a notice with **Renew** appears. Three days before the end the notification follows: SubKit sends the event `task.grant_expiring` once. More in “Keep an eye on schedules”.
When it is gone, the scheduled starts are held and a notice says the task may no longer start on its own. Nothing is lost: allow again, and the held start runs shortly afterwards.

In the list and on the task page, a start time that has passed reads as follows:

| What you read | Meaning |
| --- | --- |
| **due, waiting for permission** | The standing permission is missing or no longer applies. Select **Allow**. |
| **waiting for the current run** | The permission applies, but the previous run is still open. |
| **starts shortly** | Nothing is in the way. The run starts within moments. |

### What a run may do

A run works in its own conversation. In it, SubKit may:

| Action | Rule |
| --- | --- |
| Read | Allowed without asking, as far as your own role reaches. This covers workflows, runs, connectors, knowledge, skills and files. |
| Keep its plan | Allowed. The plan shows each step with its evidence. |
| Start a bound workflow | Allowed. Every bound workflow has its own tool in the run. If a valid approval of the workflow covers the start, the workflow writes without asking, also when the task has no standing permission. Without one, its writes are held back and the run asks you first. |
| Call a bound connector | Reading is allowed. Anything that writes asks you first, every time. |
| Search the web | Only when you switched it on for this task. |
| Use anything that is not bound | Refused. Nothing runs and nobody is asked. |
| Create or change workflows, connectors, knowledge or skills | Never. |

Further limits:

- A run always works in the environment of its task. It cannot switch between Test and Live.
- A connector you marked as trusted still asks in a run.
- What a web page, a file or a service returns is data. It is never an instruction and never a permission.
- The limits of a run are fixed when it starts. Nothing the run reads can widen them.

A run also has two budgets of its own: a number of rounds, 10 unless you change it, and a time limit, 4 hours unless you change it. When one is used up and a result exists, you get it for review. When there is none, the run ends as **failed** and names the round limit or the time limit as the reason. It cannot be continued. Select **Start again**. The task is then free for its next start. The monthly AI budget of the workspace applies as well.

### Follow a run and step in

The task page shows the state of the latest run and one recommended action.

| State | Meaning | What you do |
| --- | --- | --- |
| **running** | SubKit is working. | Nothing, or **Stop run** in the menu. |
| **waiting for you** | The run has a question, needs your approval, was interrupted or made no progress. | **Answer** |
| **sleeping until …** | The run set a time to look again, for example when a reply is expected. | Nothing. It continues on its own. |
| **result ready** | The work is done and waits for your confirmation. | **Review result** |
| **done** | You confirmed the result. | Nothing. |
| **aborted** | You or an admin stopped the run, or the task changed. | Start a new run if you need one. |
| **failed** | Something broke that the run could not recover from, or the run reached its round limit or its time limit without a result. | Open the run, read the reason, start a new run. After a reached limit: **Start again**. |

The **Overview** tab shows **Next check**, **Usage** and **Done when**; while a run sleeps, **Waiting for** names the reason. What runs now and who it waits for stand in the status line at the top. Below them are the steps of the plan with their progress.

A run waits for you in these cases:

- It asks a question or needs your approval for a write.
- Two rounds in a row brought no real progress. Progress means that a step gets ready, new evidence or a new result is recorded, a bound workflow or connector runs, you write or answer, or the run schedules its next check. Rewriting notes in the plan does not count.
- You selected **Stop** at the message field while a round was running.
- The monthly AI budget is reached, or the workspace has no AI provider at the moment. In these two cases you do not have to do anything in the run: it continues on its own as soon as the budget allows it again or a provider is set up.

A run sleeps when it set itself a next check, when the AI provider asks SubKit to slow down, or while the task is paused. A next check lies at most 31 days ahead and never beyond the time limit of the run.

To step in, open the run on the **Runs** tab and select **Open conversation**. The conversation has one line above it: the task, the state, **Now**, **Next check** and the action **Stop**. Write there as in any chat.

The conversation has two ways to stop. **Stop** in the line above it ends the run for good. **Stop** at the message field only interrupts the round that is running: the run then waits for you and goes on when you write to it.

When you write into a run, the same limits apply to you. The run stays what you allowed: it still uses only what is bound and it still asks before writes that no approval covers. Only you and admins can read your run and write into it; for everyone else its conversation does not exist. When a run asks to release writes it holds back, you as the owner or an admin can answer. Anyone else sees a note instead of the answer buttons. Run conversations do not appear in the normal conversation list; you open them from the task.

An open question blocks the next scheduled start, because the run is still open. Answer it or stop the run.

### Review the result

When all steps are done, the state reads **result ready** and you get a notice. The run is meant to hand the result over by ending its round, not to ask you whether it is right. SubKit holds such a question back when it is bound to the reserved `confirm-result` step, matches that step’s confirmation question, or repeats the goal of the task word for word; capitalization, spacing and closing punctuation do not count when comparing question text. A question that asks the same in other words can still reach you, even while a step is open. Answering it does not confirm the result: only **Looks good** under **Review result** does. It writes to you in the language you used when you last saved the task.

1. Select **Review result**.
2. Read what the run did. Each step shows its evidence.
3. Select **Looks good** to confirm. The state changes to **done**.
4. Or select **Needs more work**. The run is told that the result is not enough yet and keeps working. Write into its conversation what is missing. It does not present the same result again unchanged.

Only a person confirms or sends back a result, signed in to the Cockpit in the browser. It does not work with an API key, in the `subkit` command line or from an AI client, and SubKit cannot confirm its own work.

A result you have not confirmed does not stop the schedule. The next run of a daily task starts tomorrow even if yesterday’s result is still open. **Needs more work** is only possible while no newer run is open and the task has not been changed or paused since.

### Pause, change and delete

**Pause** holds a task. No run starts, by hand or on a schedule, and a running run goes to sleep. **Resume** continues it, and a run that slept through the pause goes on working. The standing permission stays as it is.

**Edit** changes a task. A new name, description or category is harmless. Every other change stops the open run and ends the standing permission, because the permission was given for the task as it was. Allow it again afterwards.

**Delete** archives a task. Its open run stops and its standing permission ends. The runs so far and their history stay readable.

When a person is removed from the workspace or deactivated, their tasks are paused, their open runs stop and their standing permissions end. The tasks stay paused until someone selects **Resume**, also when the person is invited again. A scheduled task then needs a new standing permission.

### Turn a proven run into a workflow

A run cannot write workflows. That stays your decision.

1. On the **Runs** tab, open a run that is **done**.
2. In its menu, select **Continue as a workflow**. A normal conversation opens, and the request to build a workflow with the same steps is already written. It names the run you opened, so SubKit works from exactly that run.
3. Send the request and work through the draft with SubKit.
4. Save the draft and approve it as described in “Your first workflow”.

Then bind the new workflow to the task, or replace the task with a schedule on the workflow. The more of the way is fixed in workflows, the less a run has to think and ask.

### What admins can do

A task belongs to the person who created it. People with the Admin role can do everything with every task: see it, start it, pause and resume it, stop its runs, answer its questions, confirm its results, change and delete it, and allow or revoke the standing permission.

That includes releasing writes that a run holds back: an admin can approve or decline them in the run conversation or from the approval link. The audit trail names the admin as the person who decided.

A run still works with the permissions of the owner, not of the admin who stepped in. Writes that an admin releases are carried out with what the run may do: the bound workflows and connectors, the environment of the task and the permissions of the owner. If these are no longer available, for example because the owner left or the task is paused, the release is refused and nothing is changed.

Admins also see a notice when a task is paused because its owner is gone.

### Costs

Every round of a run is one or more AI calls. When they have a price, they count towards the monthly AI budget of the workspace. When the budget is reached, a run waits; it does not fail, and it continues on its own once the budget allows it again.

On the **Usage** page, choose **Task** under **Break down by** to see cost and AI calls per task. Because this covers the tasks of every owner, it needs `stats:read:all`. On the task page, the **Usage** tile on the **Overview** tab shows the latest run and the current month. You need no extra permission for it.

One thing is not included in a task’s figures: AI calls inside the workflow runs the task started. Those “Ask AI” steps are counted for the workflow. If the conversation of a run was deleted, its calls can no longer be assigned to the task.

How to keep the cost low:

- Bind workflows for the fixed parts. A workflow step costs no AI call unless it is an “Ask AI” step.
- Let the run set a next check instead of looking again every few minutes.
- Keep the number of rounds small for tasks that should be quick.

### See what happened

- **On the task:** the **Runs** tab lists every run with its state. The **History** tab shows who created, changed, paused, allowed and started what.
- **In the run:** the conversation shows every step, every question and every answer.
- **In the audit trail:** every start, wait, result, confirmation and stop is an entry. Entries written during a run are marked as coming from a task run. They name the task and the run, but never the goal text or your answers.
- **Notices:** on the **Overview**, a task appears when a run waits for your answer, a result is ready, a run failed, or the standing permission is missing or about to end. With push notifications switched on, you also get a neutral push.
- **Webhooks:** the events `task_run.started`, `task_run.waiting`, `task_run.result_ready`, `task_run.completed` and `task_run.failed` are available for subscriptions.

The `subkit` inbox of a new workspace also receives `task_run.waiting`, `task_run.result_ready` and `task_run.failed`. A workspace that already existed keeps the inbox rule it has stored. To get the task events there, add them to that rule with `subkit notifications rules`.

### What SubKit does not enforce

- **Reading is as wide as your role.** Bindings limit what a run may start and call, not what it may look up. A run can search workflows, connector documentation and knowledge you can read.
- **An external browser service decides for itself which site it opens.** If a task or a workflow drives a browser through such a service, the page code runs there, not in SubKit. SubKit checks the request to the service, not which site the browser then visits or what it submits. Bind such a connector only to tasks where that is acceptable.
- **Conversations are kept.** A daily task creates a conversation every day. There is no automatic retention period for them.
- **A limit bounds where a request goes and how large it is, not what it says.** This applies to the workflows a task starts, as described in “Your first workflow”.

### If something does not work

| What you see | What to do |
| --- | --- |
| The task may not start on its own | Open the task and select **Allow**. |
| The standing permission ended after you edited the task | That is intended. Check the change and select **Allow** again. |
| **Start** answers that a run is already in progress | Open the run. Answer it, wait for it or select **Stop**, then start again. |
| The scheduled start did not happen | Read the line for the next start. **due, waiting for permission**: select **Allow**. **waiting for the current run**: answer or stop the open run. Otherwise check whether the task is paused. |
| The run waits and names the budget | The monthly AI budget is reached. An administrator raises it under **Settings** › **Budget** or continues this month; otherwise the run waits for the next month. It then continues on its own. |
| The run waits without a question | It made no progress or a round was interrupted: tell it what is missing. |
| The run ended at its round limit or time limit | It cannot be continued. Select **Start again**. If the rounds are too few for the task, raise them when you edit the task. |
| “This workflow is not part of the task.” | Bind the workflow to the task. This ends the standing permission; allow it again. |
| A schedule is refused as too frequent | Choose start times at least 15 minutes apart. |
| The task was changed by someone else while you edited it | Reload the task and repeat your change. |
| **Needs more work** is refused | A newer run is open, or the task changed or is paused. Start a new run instead. |
| A question of a run shows a note instead of the answer buttons | The question releases writes the run holds back. Only the owner of the task or an admin can answer it. Ask one of them, or stop the run. |
| An admin’s release is refused as no longer available | The run can no longer use the permissions the writes were prepared with: the owner is unavailable, the task is paused or the run ended. Nothing was changed. Stop the run and start a new one. |
| The result cannot be confirmed because the plan was changed | The run is marked as failed. Start a new run. |

### The same in the terminal and from AI clients

With the `subkit` command line:

```bash
subkit tasks list
subkit tasks get <task-id>
subkit tasks create --file task.json
subkit tasks update <task-id> --cron "0 7 * * *" --timezone Europe/Berlin
subkit tasks run <task-id>
subkit tasks runs <task-id>
subkit tasks pause <task-id>
subkit tasks resume <task-id>
subkit tasks abort <run-id>
subkit tasks delete <task-id>
```

`subkit tasks update <task-id> --run-at <time>` sets a single start. When a run waits for a person, `subkit` prints the address of the task in the Cockpit. The standing permission cannot be given in `subkit`, and a result cannot be confirmed or sent back there; `subkit tasks get` shows whether a standing permission applies.

AI clients connected over MCP can find, read, start and stop tasks. Creating and changing a task needs the **Authoring** level. Questions of a run are answered and results are confirmed in the Cockpit. More in “Connect AI clients via MCP”.

Over the HTTP API the same actions are under `/v1/tasks` and `/v1/task-runs`. They are listed in the API reference of your engine at `/openapi.json`.
