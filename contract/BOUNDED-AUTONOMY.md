# Bounded autonomy

Version: 1.0

A human approves a comprehensible action boundary; the executing product works
autonomously inside that boundary and asks again for a material deviation.

This is the normative portfolio contract, not evidence that a particular build
has implemented every requirement. Product-local APIs, migrations and tests
establish implementation status. Keep repository copies identical; do not import
another product's runtime, database or configuration to enforce this contract.

## Common terms

| Term                 | Meaning                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preparation`        | Reading, analysis, planning, inert drafts, validation and previews that do not perform an unapproved external effect.                                                                             |
| `external_effect`    | A visible publication, repository mutation, connector write, knowledge application or external reaction owned by the executing product. A notification also has an external recipient.            |
| `bound_authority`    | A locally verifiable human decision bound to an exact version or digest, allowed effects, operations, targets, environment, credential authority, finite validity and applicable resource limits. |
| `material_deviation` | A change outside that approved boundary, including an unknown effect or a different base revision.                                                                                                |
| `reauthorization`    | A new human decision over the changed boundary. It does not modify or extend the earlier decision retroactively.                                                                                  |
| `expired`            | The authority's execution window has ended.                                                                                                                                                       |
| `revoked`            | The authority was withdrawn. Already completed external effects are not undone.                                                                                                                   |
| `exhausted`          | An approved run, cost or other resource limit has been consumed.                                                                                                                                  |
| `unknown_effect`     | The product cannot establish the operation's effect or target within a supported, reviewed classification. It cannot execute autonomously.                                                        |

Preparation is a property of the actual operation, not its tool name or an
agent-supplied label. A test, development check, repair, preview or report can
still make external writes, send data, use credentials or consume a budget.
Such effects must be held or independently covered by valid local authority.

## Decision and execution rules

1. Authenticate and authorize the caller using the product's existing policy.
   A human-shaped actor ID, API-key role, model response or confirmation
   preference is not proof of a human decision.
2. Resolve the exact immutable version and its effective execution boundary.
   Include relevant connector/configuration and credential-permission changes,
   not just a hash of the authored text.
3. Allow preparation automatically. Do not put routine analysis or correction
   loops in the decision queue.
4. Before any external effect, check the local authority against that exact
   boundary, current validity, revocation and remaining limits. Unknown effects
   fail closed. An approval in another product does not substitute this check.
5. Reserve limited executions transactionally before enqueueing. Queue retries,
   concurrent workers and process restarts must not widen the reservation.
   Check authority again at dispatch; define cancellation and expiry behavior
   for queued and already-running work.
6. Use external idempotency support where available. Do not promise exactly-once
   effects in foreign systems. Record the actual outcome and uncertainty.
7. Record human decisions, automatic work, denials and material deviations in
   the local activity/audit system. Never expose secrets in evidence or diffs.

Changed version/content, effect manifest, destination/recipient, environment,
capability/operation, validity window, budget, run limit, base revision, fixed
batch membership or credential permissions require reauthorization when outside
the approved boundary. A normal correction within the approved scope does not.
Unchanged repeated runs need no new gate while their authority remains valid.

Activation and repeated-run authority are distinct facts. A UI may collect both
in one understandable decision, but neither may be inferred from the other.
Scheduled execution needs no second confirmation at its due time when the exact
artifact, destination and finite execution window were already authorized.

A batch or finding-group decision binds fixed members and their exact revisions.
New members never inherit an older decision. An atomic knowledge batch applies
all approved members or none; incomplete observation is not partial application.
A report without an external reaction is not an approval request. Previously
configured report delivery may execute only to its authorized recipients.

## Cockpit, localization and zero configuration

Every decision shows what will happen, where, the external effect, validity,
allowed quantity or budget, why a decision is needed, and what changed since
the previous decision. Show a readable before/after diff for material changes;
a generic Approve button or a digest alone is insufficient.

Keep each product's data, navigation and permissions isolated. Reuse its local
design system while maintaining consistent labels, status semantics, keyboard
access, focus, responsive layout and non-color-only status cues. Translate
visible labels, errors, explanations and accessibility text in supported locales;
format dates, time zones and quantities explicitly. Do not translate machine
codes, hashes or API enum values.

Show applicable loading, empty, pending, approved, rejected, expired, revoked,
exhausted, stale, invalidated and failed states honestly after reload. A read
snapshot never grants authority and must not claim more than the backend can
currently verify. Automatic activity belongs in history, not in approval counts.

New-object defaults favor autonomous preparation and bounded execution.
Explicit manual/approval/guarded preferences remain available where supported.
An explicitly armed unrestricted exception is never the default and never
overrides authentication or tenant isolation.

Derive useful finite limits and environment-aware suggestions from product
context. Do not require a new central service, policy language, environment
variable or configuration file for the ordinary workflow. A safe zero-config
experience never means silently granting live execution or production access.

## Existing installations and verification

Preserve stored object modes, explicit operator defaults and completed decisions.
Do not fabricate execution authorities for existing active versions, promote
old proposals, or replay old finding groups. Document an explicit activation
path for changed defaults on future objects.

Verify each product independently: tenant/role denial, exact version/digest/base
binding, expiry, revocation, exhausted limits, concurrent last-run reservation,
retry/idempotency behavior, migration compatibility, localized cockpit reload
and a complete browser workflow. Verify the portfolio separately for matching
terminology, no transitive approval, truthful UI boundaries and identical
contract copies. Green intermediate commits are checkpoints, not portfolio
completion or permission to deploy.
