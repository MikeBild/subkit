---
slug: usage-and-costs
title: Keep track of usage and costs
summary: See what AI calls cost, and set the AI budget and prices.
section: work
order: 11
audience: public
---
## Keep track of usage and costs

This chapter is for anyone who needs to know what AI costs in the workspace, usually team leads or admins. Afterwards you know the cost per workflow, person and model, and you know how the monthly AI budget works. An AI call is one request from SubKit to an AI model.

Everything is on the **Usage** page. At the top, one sentence sums up the time window, for example "This week: $84.20 for 1,240 AI calls." When costs rise, the sentence names the largest driver.

### What you need

- To view the page: `stats:read`. By default only the Admin role has it.
- For **Person**, **Conversation** and **Task** under **Break down by**: `stats:read:all`. Without it you do not see these tabs.
- To change prices: `settings:write`. To change the AI budget: `identity:write`. The Admin role has both.

### Choose the time window

Choose the **Time window** at the top right: **24 h**, **This week**, **Last week**, **This month** or **Last month**.
Weeks start on Monday, and your time zone applies.
All figures compare the window with the same span before.

The **Overview** offers the same choice. Its **Usage** tile follows the chosen time window and shows the cost in it or "No AI calls in this window". Below that it shows how much of the AI budget is spent, for example "42% of the monthly AI budget". The tile is enough for a quick look; for the reasons, open **Usage**.

How to read the trend:

- **↑ 18%** or **↓ 18%**: more or less than in the window before.
- **≈ same**: less than 5% difference.
- **New**: not used in the window before.
- **–**: there is no data for the window before.

### The five tiles

- **Cost**: the estimated cost of all AI calls in the window.
- **AI calls**: how often SubKit asked an AI model. When calls failed, it shows for example **3 failed**. A click opens the Failed AI calls.
- **AI budget · Month**: how much of the monthly AI budget is spent. This tile always covers the current month.
- **Saved by cache**: what reused input saved compared with full price.
- **From the cache**: the share of input that was reused instead of paid again. Below it, **Cache per flow** shows the share for each source. Higher is cheaper and faster. **No data** means the provider reports no cache for that source.

When a model has no price, the cost shows **at least** in front.
The amount is then a floor. The real cost is higher.
Below it you see how many calls have no price, for example **Calls without a price: 12**.
When no prices are known at all, the tile shows **Cost unknown**.

### Worth a look

**Worth a look** lists what changed clearly or costs money.
Each notice has a matching action:

| Notice | Action |
| --- | --- |
| A workflow costs at least 1.5 times as much per run as in the window before. | **View cost** |
| A model has no price. | **View model** |
| Several models have no price. | **View models** |
| One person accounts for at least half of the cost. | **View breakdown** |

When nothing stands out, it says "Nothing unusual in this window."

### Cost by origin

**Cost by origin** shows the cost per day, or per hour for **24 h**.
The bars are stacked by origin:

- **Chat**: replies in conversations.
- **Designing workflows**: creating and fixing workflows in chat.
- **Summaries**: short summaries of runs and content.
- **Checks**: AI checks drafts and results.
- **Knowledge & files**: reading and describing sources and files.
- **Workflow runs**: "Ask AI" steps in runs.
- **Other**: everything without a known origin.

**As table** shows the same values as a table with a **Total** column. **As chart** switches back.
Click an origin in the list below to open its details.
When prices are missing, the chart shows token amounts instead of cost.

### Break down by

Under **Break down by** you choose **Workflow**, **Person**, **Model**, **Conversation** or **Task**.
Each row shows **Cost**, **AI calls**, **Share** and **Trend**.
Some tabs add a column: **Runs** for Workflow, **Error rate** for Model, **Last active** for Conversation.

The last row collects what belongs to no row:

- **No workflow (chat, designing, knowledge …)**
- **No person (automatic)**: schedules, webhooks and background work such as cataloguing
- **Other** for models
- **No conversation (runs, knowledge, checks …)**

That way all rows together add up to the total at the top.

**Task** shows what each task cost: the AI calls of its runs, including the rounds in which you wrote into a run yourself. Two things are not in a task’s row. AI calls inside the workflow runs a task started count for the workflow, under **Workflow**. And when the conversation of a run was deleted, its calls can no longer be assigned to the task. The chapter “Hand over a goal as a task” explains how to keep a task cheap.

### Open details

Click a row to open its details at the side:

- **Workflow**: **Cost per run**, **AI calls per run**, **Most expensive runs** and **Models used**. **Open workflow** takes you to the workflow.
- **Person**: **Where usage comes from**, plus their **Workflows** and **Conversations**.
- **Model**: **Share from cache**, **Error rate**, **Price per 1M tokens** and **Response time (typical)**.
- **Conversation**: cost and AI calls. **Open conversation** takes you to the chat.
- **Origin**: under **Largest items**, the most expensive workflows, people or models of this origin.

Long conversations get more expensive because every reply reads the history so far. A new topic is worth a new conversation.

You open **Failed AI calls** from the **AI calls** tile.
Failed calls can still cost money. The sheet names the amount.
Under **Where they happen** you see the workflow or conversation and the reason:
**Provider error**, **Input too large**, **API key rejected** or **AI budget reached**.
When the provider rejects the API key during a run, **Needs you** asks you to reconnect the key under **Settings** › **AI assistant**.

### The AI budget

Every workspace has exactly one limit on AI cost: the monthly AI budget in US dollars. Tokens are still counted, but not limited. A new workspace starts at $50 per month. A workspace that existed before the AI budget starts without a limit and gets one item under **Needs you**: "Set a monthly AI budget". The month follows the time zone of your workspace.

The budget lives in one place: **Settings** › **Budget**. It shows what this month's model calls cost, for example "$12.40 of $50". You need `stats:read` to see it; administrators change it there, everyone else with `stats:read` sees it read-only.

- Only priced calls count. A local model, or a model without a price, never counts towards the AI budget.
- At 80% you get one item under **Needs you** and one notification per month.
- At 100% chat, tasks and model steps in workflows pause. A task run waits and continues on its own. A workflow run waits before its model step, frees its worker and continues on its own once the budget allows it again: after **Raise budget**, after **Continue without a limit this month**, or when the next month starts. Steps it already ran don't run again. Workflows without a model step keep running.
- One chat answer or one task run that costs more than $5 shows one notice. Nothing stops.

What an administrator can do when the budget is reached:

1. Open the item under **Needs you**, or **Settings** › **Budget**.
2. Choose **Raise budget** and pick a new limit: $20, $50, $200 or **No limit**.
3. Or choose **Continue without a limit this month**. The next month starts with the limit again.

You need `identity:write` for both, so the Admin role. This also applies to hosted workspaces: the AI budget is a decision of the workspace. The audit trail records each change as "Monthly AI budget changed" or "AI work continues without a limit this month".

If the workspace prices models in another currency than USD (`tokens.currency`), there is no dollar figure and the AI budget does not apply.

For developers: `GET /v1/workspace/spend-limit` (`stats:read`) reads the month, `PUT /v1/workspace/spend-limit` with `{"limit_usd": 200}` sets the limit (0 means no limit) and `POST /v1/workspace/spend-limit/continue` continues this month. A refused model call answers with the code `llm_spend_limit_reached` (HTTP 429); a provider account without quota answers with `llm_provider_quota_exhausted`. A waiting workflow run keeps the status `queued` and shows `waiting_reason: "budget"`; a model step that cannot wait fails with `llm_spend_limit_reached`.

### Set a price

When a model has no price, its calls are missing from the cost.

1. Open the model, for example through **View model** or the **Model** tab.
2. Choose **Set a price**.
3. Enter **Input per 1M tokens** and **Output per 1M tokens** and save.

The message **Price saved** confirms the change. The page then calculates with the new price.
You need `settings:write` for this too, so by default the Admin role.
The price applies to your workspace. In the settings it sits under `tokens.prices`.

### Export

1. Choose **Export** at the top.
2. Confirm with **Export**.

You get a CSV file for the chosen window.
The file has one line per day, origin and model, or per hour for **24 h**.
The columns are the time, **Origin**, **Model**, **AI calls**, the four token kinds, **Cost** and **Currency**.

### Technical details

Expand **Technical details** at the end of the page. It shows:

- **Input tokens**, **Output tokens**, **Cache read**, **Cache written** and **Total**.
- **Models without a price** and the number of calls without a price.
- The **AI budget**, for example "$12.40 of $50 · $37.60 left".
- The **Price source**: built-in list prices per model, or the prices set in `tokens.prices`.
- Your **Time zone** and the **Internal flows per origin**.
- The **Query** that fetches the same numbers through the CLI or the API.

### When something does not work

| What you see | What you do |
| --- | --- |
| **No rights** instead of the page | Ask someone with the Admin role for `stats:read`. |
| **Person**, **Conversation** and **Task** are missing | You lack `stats:read:all`. Ask someone with the Admin role for it. |
| **at least** in front of the cost | Some models have no price. Add it through **Set a price**. |
| **Cost unknown** | None of the models used has a price. Add the prices. |
| Chat, tasks and model steps are paused | The AI budget is reached. An administrator raises it under **Settings** › **Budget** or continues this month. |
| "No AI calls in this window." | Choose **Show this month** or another window. |
| A workflow run fails with `llm_spend_limit_reached` | Its model step sits inside a loop, a parallel block or a "for each", where a run cannot wait without repeating steps. Raise the limit or continue this month under **Settings** › **Budget**, then run the workflow again. |
| A workflow run stays **queued** with "Waiting for budget" | The AI budget is reached. Raise it or continue this month; the run then continues by itself. |

### The same in the terminal

You get the same numbers with `subkit stats llm` or through the HTTP API with `GET /v1/stats/llm`. Each answer includes tokens, cost and the savings from the cache. How to set up `subkit` is in the chapter "Use the subkit CLI on your machine".

```bash
subkit stats llm --bucket day --from <from> --to <to> --group-by workflow
```

- `group_by` breaks down by `model`, `flow`, `user`, `workflow`, `conversation`, `execution` or `task`. At most two values at once.
- `result=` filters by result: `success`, `quota_exhausted`, `context_too_large`, `key_rejected` or `error`.
- `workflow_id=` shows only the calls of one workflow.
- Breakdowns by `user`, `conversation` or `task` need `stats:read:all`. That does not apply when `user_id` is your own ID.
