---
slug: multi-step-best-practices
scope: global
title: Multi-Step Workflow Best Practices
description: Best practices for orchestrating multi-step workflows with branches, loops, and error handling.
gates_tools: []
version: 1
auto_load: true
trigger_keywords: [multi-step, orchestration, workflow, branch, loop, parallel, error-handling, retry]
---

# Multi-Step Workflow Best Practices

## Always include error branches for external API calls

Every `request` step that calls an external API should have a corresponding `branch` step that checks the response:
- Branch on a response field (e.g. `steps.api_call.status = 'Accepted'`), not just HTTP status code
- Include a fallback step: log, notify, or compensate
- Set `expected_statuses` to include only the documented success codes

Pattern:
```
request → branch → [then: log_success] [else: handle_rejection]
```

## Schema contracts on every step

Set `body_schema` on request steps to validate the outgoing payload before sending. Set `response_schema` to validate what comes back. When schemas are set, failures are caught at the right step instead of propagating silently.

For transform steps, set `input_schema` to document what must be in scope and `output_schema` to enforce what the expression must produce.

## Loop step guidelines

- Set `timeout_ms` per step inside the loop body (not on the loop step itself)
- Use `data_selector` to reduce the scope size passed between steps
- Set `max_retries: 0` for request steps inside loop bodies (fail fast per item, not retry per item)
- The `item` variable (or custom `item_var`) holds the current iteration value; `$loop_index` holds the zero-based index

## Parallel step guidelines

Each branch of a `parallel` step runs concurrently. Use parallel steps when:
- Steps are fully independent (no data dependency between branches)
- Each branch targets a different connector boundary
- You want to reduce total wall-clock time

Do NOT use parallel when one branch's output feeds another branch's input — use sequential steps instead.

## Input and output schema discipline

- `input_schema` on the WorkflowDef: always specify required fields with types
- `output_schema` on the WorkflowDef: match what downstream consumers expect
- Use ISO 8601 date formats and consistent key names across all output fields
- Sort array outputs by a stable key for reproducible results across runs
