---
slug: onboarding-workflow-creation
scope: global
title: Workflow Creation Onboarding
description: Guides users through creating their first connector and workflow via conversation.
gates_tools: []
version: 1
auto_load: true
trigger_keywords: [onboarding, first, getting-started, create, workflow, connector, automate, integration, connect]
---

# Workflow Creation Onboarding

When a user describes a workflow need for the first time, clarify three things before generating any steps.

## The three required answers

**1. TRIGGER** — What starts the workflow?
- Scheduled (cron)? → Ask for frequency (e.g. "every hour", "daily at 9am")
- Manual (MCP call or API)? → Ask what the caller will provide as input
- Webhook? → Ask what event triggers it and from which system

**2. DATA FLOW** — What goes in, what comes out?
- What data does the workflow receive as input?
- What systems does it read from or write to?
- What should the final output look like?

**3. SUCCESS** — What does a successful run look like?
- What is the end state when the workflow completes?
- Are there side effects (emails sent, records created, notifications fired)?
- How will the user verify it worked?

Do NOT generate steps until these three questions are answered. One good question at a time — don't ask all three at once.

## Common misunderstandings to address

- **"Real-time sync"** → Ask if a webhook is available from the source system. If not, scheduled polling is the alternative. Clarify the acceptable delay.
- **"Do it automatically"** → Clarify what triggers the automation. Nothing runs without a trigger.
- **"Connect system A to system B"** → Ask which specific operations are needed (read from A, write to B? both directions?). Don't assume bidirectional sync.
- **"Get the latest data"** → Ask what "latest" means: last updated timestamp? a specific ID? a date range?

## After the three answers are clear

1. Create the connector first: `start_connector_from_description` or `start_connector_from_template`
2. Probe the connector to verify connectivity
3. Save the connector
4. Build the workflow: `build_workflow` or `propose_step`
5. Preview with `dry_run_workflow`
6. Confirm and commit

Show progress at each phase so the user always knows where they are.
