---
slug: onboarding-workflow-creation
scope: global
title: Workflow Creation Onboarding
description: Guides first-time users through creating their first connector and workflow via conversation.
activates_when: [{"kind":"intent_keyword","word":"getting-started"},{"kind":"intent_keyword","word":"first workflow"},{"kind":"intent_keyword","word":"first connector"},{"kind":"intent_keyword","word":"onboarding"},{"kind":"intent_keyword","word":"new to sk"},{"kind":"intent_keyword","word":"erster workflow"},{"kind":"intent_keyword","word":"ersten workflow"},{"kind":"intent_keyword","word":"erster connector"},{"kind":"intent_keyword","word":"neu in subkit"}]
side_effects: read
idempotency: none
maturity: stable
tags: [onboarding, authoring]
version: 4
---

# Workflow Creation Onboarding

When a user describes a workflow need for the first time, clarify three things before generating any steps.

## Explain who acts and what is allowed

Use the user's language and a concrete business example: "Your sign-in identifies who started the workflow. The connector lets SubKit connect to another service. Permissions determine which resources you may use. A human approval allows the reviewed external actions in an environment." This applies to exports, order changes, reports and maintenance as well as AI workflows. Do not add an extra mandatory approval or login step to workflows that do not require one.

SubKit supplies immutable `$caller`; never ask users to enter it, an owner identity, or a login token as workflow input. Additional context such as language, project or request ID is ordinary untrusted input. An object ID still needs an access check by the authoritative service. Explain the exact types and expression syntax from `workflow-authoring` when authoring requires them.

HTTP and MCP can start runs as an authenticated user or system account. A trusted schedule or webhook without a principal has a null caller, not the identity of the person who configured or approved it. A webhook signature identifies the accepted sender boundary; names in its payload do not automatically establish user identity. Child workflows retain the original caller. Establish the actual authentication contract before promising user-owned access; do not invent delegation or a new identity from an event payload.

Ask about the initiator and accessible data within the existing trigger and data-flow questions. Keep a human approver separate from the initiator. Saving or activating a workflow, a connector healthcheck and an approved request are not proof that an external action succeeded. An effect approval covers reviewed connectors, addresses, read/write effects and environment, with standing or finite limits and revocation; growing that boundary requires renewed approval.

After a test, explain the recorded run ID, workflow version, step outcomes and audit evidence. Runs expose source, timing, status, steps and authority references; audit exposes actors, actions, resources, results and available trace/metadata. The stored `caller_context` is not currently returned by public execution serializers or `get_execution`, and Cockpit has no complete caller/auth graph. Do not promise complete correlation or show tokens. Use `inspect_execution` and `inspect_execution_step` for permitted diagnostics, and the API knowledge for exact HTTP/MCP capabilities. A successful remote response is not proof of an intended data change without the target's result or a read-back check.

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
