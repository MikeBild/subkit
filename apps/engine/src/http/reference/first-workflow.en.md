---
slug: first-workflow
summary: Build, approve and run your first workflow from the Cockpit chat.
order: 5
section: start
audience: public
---
## Your first workflow

In this chapter you go from signing in to your first successful run.
You describe a task in the chat, SubKit builds the workflow, you approve
what it may touch, you start it, and you read the result in the history.

It works the same in SubKit Cloud and on a self-hosted engine.

### What you need

- A SubKit account in a workspace.
  - Cloud: `https://subkit-cloud.mikebild.info/cockpit`
  - Self-hosted: `https://<your-engine>/cockpit`
- Permission to create and run workflows. Ask your administrator if a button is missing.
- An AI provider. Cloud provides one. A self-hosted engine uses the provider you chose in `sk init`.

> Trying a self-hosted engine without an AI account? `sk init --llm-provider mock --llm-api-key mock`
> sets up a mock provider. It is good for checking the installation and the Cockpit.
> The chat only answers with "Acknowledged: … (mock)" and builds no workflow.
> For this chapter, use a real provider.

### Step 1: Sign in

1. Open the Cockpit.
2. Cloud: sign in with your password or a sign-in link by email.
   Self-hosted without an identity provider: sign in with an API key.
3. You land on **Overview** in your workspace.

### Step 2: Describe the task in the chat

1. Open **Chat** in the navigation.
2. Choose **New conversation**.
3. Describe the task in plain words. Say what goes in, what should happen and what comes out.
   Example: "Fetch the open issues of my GitHub repository and give me a short list with title and link."
4. Answer the questions SubKit asks. If the task needs a service, SubKit asks you to connect it
   or to sign in to it.

Tip: one small task is easier to check than a large one. You can extend the workflow later in the same chat.

### Step 3: Save the workflow

When the workflow is ready, SubKit shows a card **Save workflow draft**.

1. Open **What will change** and read which steps and targets are included.
2. Choose **Save inactive version**.

Saving starts nothing. The workflow now appears under **Workflows**.

### Step 4: Approve what it may touch

A new version does not touch anything outside SubKit until a person approves it.
Without an approval, a run starts only as a preview without effects.

1. Open **Workflows** and select your workflow.
2. The status line shows **Waiting for approval** or **Not approved**. Choose **Approve…**.
3. Check the dialog:
   - **Environment**: where the runs are allowed, for example **Production**.
   - **Operations and external targets**: which services and addresses the workflow reaches.
   - **Maximum runs** and the time window: how long and how often the approval applies.
4. Confirm with **Allow 1 run** or **Allow … runs**.

Approving starts no run. An approval covers one version, one environment and a duration.
You can revoke it at any time in the **Approvals** tab.

The chat can also take you there. Choose **Review saved change** and then **Use change and allow runs**.

### Step 5: Run it

1. On the workflow page, choose **Run**.
2. Fill in the inputs if the workflow asks for any.
3. The dialog says **Starts a run of the approved version.** Confirm with **Run**.

You see **Run started**. If the button is unavailable, the hint says why, for example
**Enable the workflow before running it.**

### Step 6: Check the result

1. Open the **History** tab on the workflow page.
2. The newest run is at the top, with its status. **Succeeded** means the run finished.
3. Open the run. You see every step with its output.
   A failed step shows **Error in step "…"** with the cause.
4. **In the audit trail** shows who started and approved what.

You can check the same with the sk CLI:

```bash
sk executions list --limit 5
sk executions steps <run-id>
sk executions result <run-id>
```

`sk workflows run <workflow-slug> --follow` starts another run and streams its steps.

### If something does not work

| What you see | What to do |
| --- | --- |
| The chat only answers "Acknowledged: … (mock)" | The engine uses the mock provider. Set up a real AI provider. |
| The run result is headed **Preview — not written** | The version has no approval yet. Do step 4. |
| "Not started (…): no valid approval covers this run." | The approval is missing, expired or used up. Approve again or extend it. |
| "… must be reconnected" | Sign in to the connector again under **Connectors**. |
| **You do not have permission to run this workflow.** | Ask your administrator for a role that may run workflows. |
| A step failed | Open the run, read the error and describe it in the same chat. SubKit suggests a fix that you review again. |
