---
slug: rbac-and-scopes
scope: global
title: RBAC And Scopes
description: How subkit authorizes workflow authoring, connector changes, and run invocation across subjects.
activates_when: [{"kind":"tool","tool":"test_rbac_expression"}]
side_effects: read
idempotency: none
maturity: stable
tags: [security, rbac]
audience: [runtime]
version: 3
---

# RBAC And Scopes

subkit's authorization model is permission-based: every API call, tool
invocation, and workflow run is checked against the subject's permissions
within the tenant. This skill covers the model and the common recovery paths.

## The core permission set

Permissions are strings like `resource:verb`. The permissions you'll see most
often in authoring contexts:

| Permission | What it grants |
|---|---|
| `workflow:read` | List workflows, read drafts, read run history |
| `workflow:write` | Create/edit drafts, commit, delete |
| `workflow:run` | Invoke a workflow (start a run) |
| `connector:read` | List connectors, read config, probe |
| `connector:write` | Create/edit connectors, delete |
| `vault:write` | Create/rotate credentials (read is never exposed) |
| `skill:write` | Promote a skill candidate, edit a skill |
| `patch:approve` | Approve an unsafe patch candidate from self-healing |

Note: there is no `vault:read`. Credential values are decrypted only at
step-execution time inside the engine; no API or tool exposes them in plaintext.

## Subject kinds

Who holds permissions:

| Subject | Typical use | Identified by |
|---|---|---|
| `user` | Humans in the web app, CLI operators | user id + tenant id |
| `system_account` | Machine-to-machine (CI/CD, webhooks, sibling services) | api key |
| `portal_token` | Short-lived delegated tokens for end-user portal UIs | signed jwt + allowlist |

`portal_token` subjects are always read-mostly: they can invoke workflows the
portal has whitelisted, and read grants the portal owner pre-authorized, but
they cannot create connectors or edit drafts.

## Four ways a permission attaches

The authorizer checks permissions in this order:

1. **Resource grant** — a direct grant on a specific resource:
   `("user:alice", "workflow:run", "workflow:weekly_digest")`. Most specific.
2. **Role** — the subject has role `developer` which has `workflow:write` for
   all workflows in the tenant. Most common for human users.
3. **Group** — the subject is in group `eng-oncall` which has
   `workflow:run` for a set of runbooks. Useful for rotating on-call access.
4. **Portal-token allowlist** — the token explicitly lists workflow ids it can
   invoke, overriding broader role inference. Narrow by design.

First match wins. If none match, the request is denied.

## `test_rbac_expression` — validate before you ship

The `test_rbac_expression` tool evaluates a hypothetical permission check
against the current RBAC store without performing the action. Use it to
validate authoring changes:

```
test_rbac_expression({
  subject: "user:alice@example.com",
  permission: "workflow:run",
  resource: "workflow:weekly_digest"
})
-> { ok: true, allowed: true, matched_by: "role:developer" }
```

Or for a portal token before minting it:

```
test_rbac_expression({
  subject: "portal_token:hypothetical",
  permission: "workflow:run",
  resource: "workflow:customer_self_service",
  allowlist: ["workflow:customer_self_service"]
})
```

This catches misconfigurations at dev-time, not at run-time.

## How `permission_denied` surfaces

When a tool or HTTP call is denied, the tool result is:

```json
{
  "ok": false,
  "error": {
    "code": "permission_denied",
    "message": "subject user:alice lacks workflow:write on workflow:weekly_digest",
    "details": {
      "subject": "user:alice@example.com",
      "permission": "workflow:write",
      "resource": "workflow:weekly_digest"
    }
  }
}
```

The run (or draft-write) is aborted. Audit writes the denial to
`audit.policy_denied` before returning.

## Recovery paths

Given a `permission_denied`:

1. **Read `details.permission` and `details.resource`**. They tell you exactly
   which grant is missing.
2. **If the subject should have the permission**, the fix is in RBAC config,
   not the workflow. Surface this to the user with a clear ask ("role X needs
   `workflow:write` on tenant Y").
3. **If the subject should not**, stop trying. Explain to the user that the
   operation exceeds their scope, and suggest a narrower alternative (e.g.
   "propose a draft for review" instead of "commit directly").
4. **Never** silently downgrade the request or skip the step. The denial is
   the correct outcome; recovery is either a policy change or a different plan.

## Example: a locked-down portal token

```
subject:      portal_token:abcd1234
permissions:  workflow:run (scoped to allowlist)
allowlist:    ["workflow:customer_ticket_create", "workflow:customer_ticket_lookup"]
read grants:  workflow:customer_ticket_lookup (result data only)
```

This token can:

- Start runs of the two allowlisted workflows.
- Read the result of past runs of `customer_ticket_lookup`.

It cannot:

- List other workflows (`workflow:read` on others isn't granted).
- Edit or delete anything (`workflow:write` not present).
- See credential-wrapped fields (credentials never leave the engine).

## Common pitfalls

- **Granting `workflow:write` when `workflow:run` is enough.** A service that
  only triggers workflows doesn't need to edit them. Over-granting widens the
  blast radius of a key leak.
- **Testing only the happy path.** Always `test_rbac_expression` at least one
  negative case (e.g. a different tenant's resource) before shipping.
- **Relying on portal-token inference.** Portal tokens must have explicit
  allowlists; inheriting broad user permissions into a public token is a
  common leak vector.
- **Reading `vault:read` expecting values.** Neither exists. The engine
  surfaces credentials only to the driver layer at run-time.
- **Skipping the audit check after a denial.** Every denial is logged in
  `audit.policy_denied`. If your workflow is hitting denials, read the audit
  log first — you'll often see a pattern (wrong env, wrong tenant) immediately.

## See also

- `subkit-concepts.md` — environment scoping (dev/prod credentials).
- `self-healing.md` — `patch:approve` and the safe/unsafe classification.
- `error-recovery.md` — general shape of `{ok:false, error:{...}}` and recovery.
