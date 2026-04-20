---
name: subkit-rbac-and-policy
description: Work on RBAC permissions, policies, roles, resource grants, API-key scopes, portal tokens, or before-request hooks in subkit. Use whenever the task touches apps/engine/src/rbac/, auth/, identity/, or credentials/, or involves authorization decisions at any surface (HTTP, MCP, webhook, CLI).
---

# subkit RBAC And Policy

> **Project context:** Before starting work, read `AGENTS.md` at the repository root.

Authorization in subkit spans three layers and a runtime hook system. Every surface
(REST, MCP, webhook, CLI) enforces the same policy engine — don't invent parallel
checks.

## Canonical references

- `docs/07-security-governance.md` — Identity model, RBAC, Before-Request Hooks, credential vault, audit expectations.
- `docs/06-execution.md` — QuickJS-WASM sandbox for Before-Request Hooks.
- `docs/02-concepts.md` — Entity glossary (Tenant, User, API Key, Portal Token, Before-Request Hook).

## Layered model

| Layer | Subsystem | Purpose |
|---|---|---|
| **Identity** | `apps/engine/src/identity/` | SSO / OIDC, user provisioning, tenant membership. |
| **Authentication** | `apps/engine/src/auth/` | Providers: `oidc`, `api-key`, `portal-token`. Registry picks by inbound credential. |
| **Authorization (static)** | `apps/engine/src/rbac/` | 40+ permissions, roles, resource grants, ABAC rules, API-key scopes. Deterministic. |
| **Authorization (dynamic)** | `apps/engine/src/sandboxes/` | **Before-Request Hook** — per-role JavaScript interceptor, runs before every request Step. QuickJS-WASM, interrupt-budgeted. |
| **Secret storage** | `apps/engine/src/credentials/`, `crypto/` | AES-256-GCM encrypted credential envelope. OAuth2 rotation. |

## Non-negotiables

- **Every route, MCP tool, webhook, and CLI path has an explicit permission check.** A
  missing check is a security bug, not a style issue. Use the helpers in `rbac/`.
- **Every tenant boundary is enforced at the query layer.** `tenant_id` goes on every
  SELECT / INSERT / UPDATE / DELETE. No `findAll()` without a tenant filter.
- **Every authorization decision writes an `audit_log` entry.** Both grants and denials
  for sensitive actions. Include actor, request source, resource, decision, reason.
- **Before-Request Hooks run in QuickJS-WASM only.** Never `eval`, never `Function()`,
  never a raw `vm` context. Interrupt budget must be set.
- **API keys carry scoped `allowed_workflows` and `allowed_connectors`.** Scope narrowing
  beats broad keys. Rotation window is enforced.
- **Portal tokens are scoped + expiring.** They represent a specific end-user's access
  to a specific workflow — not a general-purpose key.
- **Never log the plaintext of a credential, API key, portal token, or OAuth2
  access/refresh token.** The logger's redaction helpers in `crypto/redaction.ts`
  exist for this.

## Adding a permission

1. Read `docs/07-security-governance.md` — understand the identity model and existing permissions.
   Is there already one that covers your case?
2. If not, add the permission enum + role mapping in `apps/engine/src/rbac/`.
3. Wire it into the route / MCP tool / CLI path using the existing guard helper.
4. Add an `audit_log` action type if the permission gates a state-mutating path.
5. Write tests at the appropriate layer (integration for HTTP; unit for pure policy
   logic). Include **both** a grant test and a deny test.

## Adding or modifying a Before-Request Hook

1. Read `docs/06-execution.md` (sandboxing) and `docs/07-security-governance.md` (hooks model).
2. Hooks are **per-role JavaScript**, versioned, and sandbox-executed. The user authors
   the JS through the API / CLI; your job is the runtime.
3. Confirm interrupt budget and memory limit are enforced. No I/O from within the hook.
4. Audit the hook invocation result (allow / mutate / deny).
5. Test with a benign hook, a mutating hook (e.g. adds a header), and a malicious hook
   (e.g. attempts to spin forever — must be interrupted).

## Things not to do

- **Don't add a permission check inline with business logic.** Use the `rbac/` guard
  at the edge so it's uniform and auditable.
- **Don't mix auth provider selection with authorization.** `auth/` picks the provider
  by inbound credential; `rbac/` decides what that identity can do.
- **Don't let Before-Request Hook code import Node modules.** The sandbox is
  deliberately restricted.
- **Don't store a secret (credential, token) without going through `credentials/` and
  `crypto/` (AES-256-GCM envelope).** And rotate it.
- **Don't return RBAC denial reasons that leak internal resource structure** (e.g.
  "resource X exists but you don't have permission" reveals X exists). Return
  generic 403 / not-found.
