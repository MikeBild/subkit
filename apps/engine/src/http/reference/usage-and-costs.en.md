---
slug: usage-and-costs
title: Keep track of usage and costs
summary: See what AI calls cost and what for, and adjust the budget and prices.
section: work
order: 11
audience: public
---
## Keep track of usage and costs

The **Usage** page shows what AI calls cost, and what for.
An AI call is one request from SubKit to an AI model. Every call costs money.
At the top, one sentence sums up the time window, for example "This week: $84.20 for 1,240 AI calls."
When costs rise, the sentence names the largest driver.

### What you need

- To view the page: `stats:read`. By default only the Admin role has it.
- For **Person** and **Conversation** under **Break down by**: `stats:read:all`. Without it you do not see these tabs.
- To change the budget and prices: `settings:write`. The Admin role has both.

### Choose the time window

Choose the **Time window** at the top right: **24 h**, **This week**, **Last week**, **This month** or **Last month**.
Weeks start on Monday, and your time zone applies.
All figures compare the window with the same span before.

How to read the trend:

- **↑ 18%** or **↓ 18%**: more or less than in the window before.
- **≈ same**: less than 5% difference.
- **New**: not used in the window before.
- **–**: there is no data for the window before.

### The five tiles

- **Cost**: the estimated cost of all AI calls in the window.
- **AI calls**: how often SubKit asked an AI model. When calls failed, it shows for example **3 failed**. A click opens the Failed AI calls.
- **Budget · Month**: how much of the monthly budget is used. This tile always covers the current month.
- **Saved by cache**: what reused input saved compared with full price.
- **From the cache**: the share of input that was reused instead of paid again. Below it, **Cache per flow** shows the share for each source. Higher is cheaper and faster. **No data** means the provider reports no cache for that flow.

The forecast sits below the budget. SubKit projects it from the last 7 days:

- **Lasts to month end.**
- **About 94% by month end.** The budget is getting tight.
- **Used up on the 26.** The budget does not last to month end.
- **Used up. Chat, creating and fixes are paused.**
- **No forecast yet. Too few days this month.** This applies to the first two days of a month.

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
| The monthly budget will likely run out before month end. | **Adjust budget** |
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

Under **Break down by** you choose **Workflow**, **Person**, **Model** or **Conversation**.
Each row shows **Cost**, **AI calls**, **Share** and **Trend**.
Some tabs add a column: **Runs** for Workflow, **Error rate** for Model, **Last active** for Conversation.

The last row collects what belongs to no row:

- **No workflow (chat, designing, knowledge …)**
- **No person (automatic)**: schedules, webhooks and background work such as cataloguing
- **Other** for models
- **No conversation (runs, knowledge, checks …)**

That way all rows together add up to the total at the top.

### Open details

Click a row to open its details at the side:

- **Workflow**: **Cost per run**, **AI calls per run**, **Most expensive runs** and **Models used**. **Open workflow** takes you to the workflow.
- **Person**: **Where usage comes from**, plus their **Workflows** and **Conversations**.
- **Model**: **Share from cache**, **Error rate**, **Price per 1M tokens** and **Response time (typical)**.
- **Conversation**: cost and AI calls. **Open conversation** takes you to the chat.
- **Origin**: under **Largest items**, the most expensive workflows, people or models of this origin.

Long conversations get more expensive because every reply reads the history so far. A new topic is worth a new conversation.

You open **Failed AI calls** from the **AI calls** tile.
Failed calls still cost money. The sheet names the amount.
Under **Where they happen** you see the workflow or conversation and the reason:
**Provider error**, **Input too large** or **Budget used up**.

### Adjust the budget

The monthly budget is the maximum number of tokens per month.

1. Click **Adjust budget** under Worth a look, or the forecast in the tile.
   Without a budget, choose **Set a budget** in the tile.
2. Enter a value under **Tokens per month**.
3. Save. The message **Budget saved** confirms the change.

You need `settings:write` for this, so by default the Admin role.
Without it you only see the current state and "Ask someone with the Admin role."

What happens as tokens are used:

- From 75% a notice appears.
- At 100% chat, creating and fixes pause until the first of the month.
- Approved workflows keep running.

Without a budget, AI calls are unlimited.

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
- The **Budget** in tokens, for example "120,000 of 150,000 tokens · 30,000 left".
- The **Price source**: built-in list prices per model, or the prices set in `tokens.prices`.
- Your **Time zone** and the **Internal flows per origin**.
- The **Query** that fetches the same numbers through the CLI or the API.

### The same numbers through the CLI or the API

`sk stats llm` and `GET /v1/stats/llm` return the same numbers as the page.
Each answer includes tokens, cost and the savings from the cache.

```bash
sk stats llm --bucket day --from <from> --to <to> --group-by workflow
```

- `group_by` breaks down by `model`, `flow`, `user`, `workflow`, `conversation` or `execution`. At most two values at once.
- `result=` filters by result: `success`, `quota_exhausted`, `context_too_large` or `error`.
- `workflow_id=` shows only the calls of one workflow.
- Breakdowns by `user` or `conversation` need `stats:read:all`. That does not apply when `user_id` is your own ID.

### When something does not work

| What you see | What you do |
| --- | --- |
| **No rights** instead of the page | Ask someone with the Admin role for `stats:read`. |
| **Person** and **Conversation** are missing | You lack `stats:read:all`. Ask someone with the Admin role for it. |
| **at least** in front of the cost | Some models have no price. Add it through **Set a price**. |
| **Cost unknown** | None of the models used has a price. Add the prices. |
| "Ask someone with the Admin role." instead of **Adjust budget** | You lack `settings:write`. Ask someone with the Admin role to change the budget. |
| Chat, creating and fixes are paused | The monthly budget is used up. Raise it or wait for the first of the month. |
| "The budget could not be read …" | Reload the page. This says nothing about whether a budget is set. |
| "No AI calls in this window." | Choose **Show this month** or another window. |
