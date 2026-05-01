---
slug: self-healing
scope: global
title: Self-Healing And Patch Candidates
description: How the engine detects drift, proposes bounded repairs, and gates their promotion via classification and approval.
activates_when: [{"kind":"tool","tool":"approve_patch_candidate"},{"kind":"tool","tool":"approve_skill_candidate"}]
side_effects: read
idempotency: none
maturity: stable
tags: [self-healing, drift, repair]
version: 3
---

# Self-Healing And Patch Candidates

When a step fails repeatedly in ways that match known drift patterns — a field
was renamed upstream, a schema moved, a new required header appeared — sk's
repair loop proposes a **patch candidate**. A candidate is *never* auto-applied.
It's a structured proposal, classified, durably stored, and promoted only when
it proves itself or a human approves.

## What a patch candidate is

A `patch_candidate` is:

- A **bounded** change. It edits a small, well-defined surface (a single step's
  config, a single JSONata expression, a single schema field). It does not
  rewrite whole workflows.
- A **classified** proposal. Either `safe` (auto-applicable after soak) or
  `unsafe` (requires explicit human approval via `patch:approve`).
- A **reversible** change. Every candidate stores the pre-patch state so a
  revert is a single write.
- An **attributed** change. The repair-LLM turn that produced it is linked to
  the candidate, including the failing-step fixture, the drift signal, and the
  LLM's reasoning.

Row shape, conceptually:

```json
{
  "id": "pc_01HYX...",
  "workflow_id": "weekly_digest",
  "target": { "step_id": "fetch_orders", "field": "data_selector" },
  "before": "$.orders.{ 'id': id, 'total': total }",
  "after":  "$.orders.{ 'id': id, 'total': total_price }",
  "classification": "safe",
  "reason": "upstream renamed field 'total' -> 'total_price' (detected 12 consecutive 200s with null 'total')",
  "produced_by": { "conversation_id": "conv_...", "turn_id": "..." },
  "outcome_window": { "successes": 0, "failures": 0, "window_size": 20 },
  "state": "proposed"
}
```

## Safe vs unsafe classification

The repair flow assigns a classification based on the target surface and the
blast radius of the change:

| Classification | Examples | Promotion path |
|---|---|---|
| `safe` | JSONata expression fix, field rename in `data_selector`, non-breaking schema widening, `onError` tuning | Auto-applied after a soak window of N successes with zero failures |
| `unsafe` | Changing a step's `connector`, editing SQL that writes, removing a schema required field, altering `outputTransform` shape | Requires a user with `patch:approve` to explicitly approve |

The boundary is sharp: if the patch could change a value an external caller
depends on, it's unsafe. If it's a purely internal reshape that restores the
prior contract, it's safe.

## Outcome tracking

After promotion, the engine watches the patched step for a **outcome window**
of runs:

- `window_size: 20` by default for safe patches, `50` for unsafe.
- Every run increments `successes` or `failures`.
- If `failures` exceeds a threshold (typically `3` for safe, `1` for unsafe)
  before the window closes, the patch is auto-reverted and the candidate is
  marked `rolled_back`. A fresh candidate may be proposed from the new
  failures.
- If the window closes with an acceptable failure rate, the candidate is
  marked `confirmed` and the repair signal clears.

This means a promotion is not final; the engine keeps watching.

## `approve_patch_candidate`

For unsafe candidates, the approval tool materializes the patch:

```
approve_patch_candidate({
  candidate_id: "pc_01HYX...",
  approver_note: "verified upstream field rename via vendor changelog 2026-04-15"
})
-> { ok: true, state: "promoted", outcome_window: { successes: 0, failures: 0, window_size: 50 } }
```

The call requires the caller to have `patch:approve` on the target workflow.
The approval is audited: who, when, and the reasoning note.

## When to reject

Some candidates should not be promoted even if they "work":

- **Conflicting schema changes.** The patch widens a type, but a sibling
  workflow depends on the narrower shape. Rejecting forces a coordinated
  migration.
- **Breaking existing callers.** The `outputTransform` patch would change the
  shape returned to a scheduled job. Even if the new shape is more correct,
  breaking a consumer silently is worse.
- **Low-confidence reasoning.** The candidate's `reason` is vague
  ("possibly related to upstream changes"). Require a clearer signal before
  promoting — either more failing runs or a fresh repair turn with better
  context.
- **Candidate proposed during an incident.** Do not promote patches while the
  upstream vendor has an active incident; wait for steady-state signal.

Reject via `reject_patch_candidate` with a note. Rejections are also audited
and feed back into the repair flow's priors — a rejected candidate type is
less likely to be re-proposed.

## Example lifecycle

1. **Detection.** `fetch_orders` returns 200 but `data.total` is consistently
   null. Drift detector flags this after 12 such runs.
2. **Repair turn.** The repair-LLM is invoked with the failing fixture,
   the connector's current shape (from `probe_connector`), and the recent
   audit trail. It proposes `data_selector` update `total -> total_price`.
3. **Candidate stored.** `pc_01HYX...` in state `proposed`, classification
   `safe` (only trims a selector).
4. **Auto-promote.** After no user objection within the soak timer, the engine
   applies the patch and enters the outcome window.
5. **Outcome.** 20/20 success. Candidate marked `confirmed`.

Contrast with an unsafe example:

1. A workflow's `send_invoice` step returns 4xx consistently. Repair proposes
   adding a new required `idempotency-key` header whose value is the run id.
2. Classification: `unsafe` (change to an external-writing step).
3. Engine stops here. A human with `patch:approve` reviews, calls
   `approve_patch_candidate`, and the window opens with `window_size: 50`.
4. Outcome window closes clean: candidate is `confirmed`.

## Common pitfalls

- **Treating a proposed candidate as applied.** Proposed means "stored for
  review", not "active". The underlying bug still occurs until promotion.
- **Approving without reading `before` and `after`.** `patch:approve` is a
  binary decision on a specific diff. Skim it.
- **Approving inside an incident.** If the upstream is flapping, the signal
  that generated the candidate is noisy. Wait.
- **Over-widening the soak window.** A `window_size: 500` never closes on a
  low-volume workflow. Keep windows proportional to run frequency.
- **Manually editing a patched step.** If you hand-edit a step that's inside
  an active outcome window, the engine loses its baseline. Close or revert the
  candidate first, then edit.
- **Chaining patch candidates.** If two candidates target the same step, only
  one can be in-flight. Apply, confirm, then propose the next.

## See also

- `rbac-and-scopes.md` — `patch:approve` permission semantics.
- `error-recovery.md` — the error shapes that feed the drift detector.
- `sk-concepts.md` — step and envelope shapes being patched.
