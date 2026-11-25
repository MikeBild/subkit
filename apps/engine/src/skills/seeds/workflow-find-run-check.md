---
slug: workflow-find-run-check
scope: global
title: Workflow finden, ausführen, Lauf prüfen
description: The path from a request to a checked result with workflows that already exist — `find_workflow` to pick one, `run_workflow` (or its `wf_<slug>` tool) to start it, `get_execution` and `inspect_execution_step` to confirm what actually happened.
activates_when: [{"kind":"intent_keyword","word":"run the workflow"},{"kind":"intent_keyword","word":"run workflow"},{"kind":"intent_keyword","word":"start the workflow"},{"kind":"intent_keyword","word":"starte den workflow"},{"kind":"intent_keyword","word":"führe den workflow"},{"kind":"intent_keyword","word":"check the run"},{"kind":"intent_keyword","word":"lauf prüfen"},{"kind":"intent_keyword","word":"find_workflow"},{"kind":"intent_keyword","word":"run_workflow"},{"kind":"intent_keyword","word":"get_execution"}]
side_effects: read
idempotency: none
maturity: stable
tags: [workflows, execution, agent-briefing]
audience: [runtime]
version: 1
---

# Workflow finden, ausführen, Lauf prüfen

Most requests are already covered by a workflow someone built and approved.
Running it is faster, governed and audited; rebuilding it is none of these.

## 1. Find

- Call `find_workflow` with a short description of the job ("weekly sales
  report", "invoice attachments"). Narrow with `category` or `connector` when
  the user names one. Each match says why it matched (`reasons`).
- The session briefing may already list the domain's workflows under
  "Workflows" — use those slugs directly.
- Only when nothing fits is building a new workflow the right answer; say so
  and let the person decide.

## 2. Run

- To perform the job now, use the workflow's own `wf_<slug>` tool when it is
  listed, or `run_workflow` with `workflow` set to the slug.
- Pass the inputs the workflow declares. Explicit input, even `{}`, is used as
  given; omitted input lets a scheduled workflow use its schedule's input.
- Writes need a standing approval for the environment. Without one the run
  holds its writes (`writes_held`, `held_step_ids`) — report that honestly; a
  person grants the approval in the cockpit. Never retry to get around it.
- For a preview without spending a live run, use `execute_writes: false`.

## 3. Check

- A run can outlive the call. Follow it with `get_execution` by id until its
  `outcome.kind` is `succeeded`, `failed`, `held` or `partial`.
- `succeeded` with an output that looks wrong (empty list, missing fields):
  read the step that produced it with `inspect_execution_step` (by `step_key`)
  before guessing. Its `output_preview` shows the real shape.
- `failed`: report the failed step, its cause class and error code from
  `outcome`, then follow the skill "Wenn etwas hakt" (`when-something-is-stuck`).
- Answer with what the run produced and its execution id, so the person can
  open the run in the cockpit.

## Pitfalls

- Do not claim success from the start response; only the finished execution
  says what happened.
- Do not run a workflow twice to "check" it — read the execution instead.
- Do not edit a saved workflow to make one run pass; propose the change and let
  a person approve it.
