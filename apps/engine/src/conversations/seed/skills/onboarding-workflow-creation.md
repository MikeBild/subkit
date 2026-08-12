---
slug: onboarding-workflow-creation
scope: global
title: Workflow Creation Onboarding
description: Guides first-time users through creating their first connector and workflow via conversation.
activates_when: [{"kind":"intent_keyword","word":"getting-started"},{"kind":"intent_keyword","word":"first workflow"},{"kind":"intent_keyword","word":"first connector"},{"kind":"intent_keyword","word":"onboarding"},{"kind":"intent_keyword","word":"new to sk"}]
side_effects: read
idempotency: none
maturity: stable
tags: [onboarding, authoring]
version: 4
---

# Workflow Creation Onboarding

When a user describes a workflow need for the first time, clarify three things before generating any steps.

## The three required answers

**1. TRIGGER** — What starts the workflow?
- Scheduled (cron)? → Ask for frequency (e.g. "every hour", "daily at 9am")
- Manual (MCP call or API)? → Ask what the caller will provide as input
- Webhook? → Ask what event triggers it and from which connector boundary

**2. DATA FLOW** — What goes in, what comes out?
- What data does the workflow receive as input?
- Which connectors does it read from or write to?
- What should the final output look like?

**3. SUCCESS** — What does a successful run look like?
- What is the end state when the workflow completes?
- Are there side effects (emails sent, records created, notifications fired)?
- How will the user verify it worked?

Do NOT generate steps until these three questions are answered. One good question at a time — don't ask all three at once.

## Common misunderstandings to address

- **"Real-time sync"** → Ask if a webhook is available from the source connector boundary. If not, scheduled polling is the alternative. Clarify the acceptable delay.
- **"Do it automatically"** → Clarify what triggers the automation. Nothing runs without a trigger.
- **"Connect connector A to connector B"** → Ask which specific operations are needed (read from A, write to B? both directions?). Don't assume bidirectional sync.
- **"Get the latest data"** → Ask what "latest" means: last updated timestamp? a specific ID? a date range?

## After the three answers are clear

1. Create the connector first: `start_connector_from_description` or `start_connector_from_template`
2. Probe the connector to verify connectivity — a green probe persists it inline (`auto_saved: true`)
3. Author the workflow: `author_workflow` (one call from the goal — the grounded pipeline builder)
4. Preview with `dry_run_workflow` — writes are held. In `auto`, a green judged preview may auto-commit; in ask/plan, call `save_workflow_draft` after `save_required: true` so the human gate decides
5. Repair any recorded-eval/judge findings via `edit_workflow_patch`, then preview again

Show progress at each phase so the user always knows where they are.

## Example: a first workflow from a single API

The minimum useful workflow is one request step. Once the user has a probed
connector and you know the endpoint, this is the shape `author_workflow`
expects:

```json
{
  "name": "Daily Stripe customers",
  "slug": "stripe-daily-customers",
  "description": "Fetches the most recent 100 customers from Stripe.",
  "steps": [
    {
      "id": "list_customers",
      "kind": "request",
      "method": "GET",
      "connector_id": "<stripe_connector_id>",
      "path": "/v1/customers",
      "query": { "limit": 100 }
    }
  ]
}
```

After this lands, the next iteration usually adds a transform step:

```json
{
  "id": "shape",
  "kind": "transform",
  "language": "javascript",
  "expression": "return input.scope.list_customers.data.data.map((c) => ({ id: c.id, email: c.email }));"
}
```

The two together — fetch + shape — cover ~80% of first workflows.
