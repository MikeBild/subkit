---
slug: when-something-is-stuck
scope: global
title: Wenn etwas hakt
description: What to do when a workflow is held, refused or keeps failing — read the diagnosis with `diagnose_workflow`, file the deterministic repair with `propose_workflow_repair` when one exists, and hand everything else to a person with the exact next step.
activates_when: [{"kind":"intent_keyword","word":"stuck"},{"kind":"intent_keyword","word":"hakt"},{"kind":"intent_keyword","word":"is held"},{"kind":"intent_keyword","word":"wird gehalten"},{"kind":"intent_keyword","word":"blocked"},{"kind":"intent_keyword","word":"blockiert"},{"kind":"intent_keyword","word":"refused"},{"kind":"intent_keyword","word":"diagnose_workflow"},{"kind":"intent_keyword","word":"propose_workflow_repair"}]
side_effects: read
idempotency: none
maturity: stable
tags: [diagnosis, repair, agent-briefing]
audience: [runtime]
version: 1
---

# Wenn etwas hakt

A stuck workflow has one cause the engine can name. Read it, act on exactly that
cause, and leave every decision to a person.

## 1. Ask the engine why

Call `diagnose_workflow` with the workflow id (and `environment`, default
`prod`). It lists every refused step with:

- the gate code and, when the gate named one, its own reason;
- the remedy kind: `patch`, `prepare`, `declare`, `reconnect` or `author`;
- a `fixer` when a deterministic repair exists;
- `candidate_id` when that repair already waits for review;
- `is_current` — `false` means the diagnosis is about a draft.

For a run that failed instead of being held, read the run first with
`get_execution` (its `outcome` names the failed step, cause class and error
code) and the step itself with `inspect_execution_step`.

## 2. Act on the remedy

| Remedy | What you do |
|---|---|
| `patch` with `fixer`, `is_current: true`, no `candidate_id` | `propose_workflow_repair` with that `step_id` and `fixer`; it files a proposal and changes nothing yet |
| `patch` with a `candidate_id` | nothing to file — tell the person a repair waits for review |
| `patch` with `is_current: false` | make the fixer's change in the draft itself, or apply the draft and diagnose again |
| `prepare` | a held preparation run is missing; start one with `run_workflow` and `execute_writes: false` |
| `reconnect` | the connector's sign-in expired or was refused; the person signs in again on the connector page |
| `declare` / `author` | the definition needs a person's decision; say which step and what is missing |

After any change, call `diagnose_workflow` again instead of assuming the block
is gone.

## 3. Report

Say what is blocked, why (in the engine's words for the code), and the one next
step — including who has to take it. Name proposals as waiting for review; never
call them applied. If the same failure repeats and nothing above applies, say so
and stop instead of trying variations.

## Never

- Retry a refused run in a loop.
- Edit connector credentials or approvals on the person's behalf.
- Work around a gate by rebuilding the workflow under another name.
