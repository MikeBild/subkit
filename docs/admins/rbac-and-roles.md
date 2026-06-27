# RBAC & Roles

> **Audience:** Security engineers, compliance reviewers, operators wiring access

This document describes how sk authenticates callers and authorises every action: the pluggable identity chain, the four built-in roles plus custom roles and resource grants, and the dynamic policy layer added by Before-Request Hooks. The structural guarantees that surround it — multi-tenant isolation, the immutable audit trail, the compliance posture — live in [Governance & Audit](../concepts/governance-and-audit.md).

---

## Identity and Authentication

sk supports multiple authentication methods in a pluggable chain. Organisations choose the combination that fits their security posture.

**OIDC** enables enterprise SSO. Users log in with their organization's identity provider — Azure AD, Okta, Google Workspace, or any OIDC-compliant provider. The engine provisions tenant accounts from the claims in the identity token. For organizations with existing SSO infrastructure, this is the right path: users get seamless access through the same credential they use everywhere else, and the organization retains control over provisioning and deprovisioning.

**API Keys** are the standard programmatic credential. They are long-lived, revocable, and scoped to a tenant and a specific permission set. Every key is hashed before storage — the raw key is shown exactly once at creation. There is no way to retrieve a plaintext key after that point. If a key is lost, a new one is issued and the old one revoked. API keys support overlap-window rotation: a new key can be issued before the old one expires, so access is never interrupted during rotation.

**Portal Tokens** are short-lived, single-purpose credentials issued for specific end-user flows. They expire automatically. They carry only the permissions required for their specific purpose — nothing more. Portal tokens are the right choice for customer-facing integrations and controlled access flows where a user needs to interact with a specific workflow without becoming a full tenant member.

---

## Role-Based and Attribute-Based Access Control

Every API route, MCP call, and workflow trigger is protected by RBAC. The permission check happens before any resource is accessed or any action is taken. There is no path through the platform that bypasses authorization.

sk ships four built-in roles: **admin** (full platform control), **member** (can author and trigger workflows), **end-user** (can trigger and view, cannot modify), and **service account** (programmatic access, no interactive surface). Operators can create custom roles for more granular control, define resource-level grants with expiration times, and group users for assignment.

**Before-Request Hooks** add a dynamic policy layer on top of static RBAC. A Before-Request Hook is a sandboxed script that runs before a Connector request executes. The hook receives the full request context — caller identity, target connector, operation type, request parameters — and can enforce policy that is impossible to express in static roles. Examples: blocking write operations during a maintenance window, requiring additional approval for specific production connectors, enforcing data residency constraints, or logging requests that match a specific pattern.

Hooks run in an isolated QuickJS-WASM sandbox with a strict CPU budget. They cannot access the network, the file system, or the database. An error or timeout in a hook fails closed: the request is denied. Hook execution is recorded in the audit log. The operator how-to for authoring and wiring a hook is in [Scheduling & Hooks](../operators/scheduling-and-hooks.md).

**Policy evaluation order:** RBAC is evaluated first. If the caller has no permission for the action, the request is denied before the hook is consulted. If RBAC passes, the Before-Request Hook runs. If the hook aborts, the request is denied with the hook's reason. Only if both pass does the request proceed.

**`stats:read` exposes process-scoped operational signals.** The operator health digest (`GET /v1/operator/health-digest`, the `subkit://operator/health-digest` MCP resource, and the on-connect MCP `instructions` summary) is gated on `stats:read`. Its **failing-runs** and **pending-patch** sections are tenant-scoped, but its predictive-maintenance **risk signals** (Postgres-pool saturation, dead-letter-queue growth, transient-DB-retry rate, connector-health mix, LLM-fallback fraction, RSS high-water) read *engine-wide* gauges — the pool, the DLQs, and the host RSS are shared infrastructure, not per-tenant. A principal with `stats:read` on a multi-tenant deployment can therefore infer host-level load that other tenants contribute to. This is intentional — `stats:read` is the operator-tier permission, and "your runs are fine but the host is about to OOM" is exactly the warning the per-tenant lagging signals cannot give in time — but grant `stats:read` only to operator/admin principals on a shared deployment. Portal-token-class principals are **structurally barred** from it regardless of role: the RBAC evaluator short-circuits every identity path (resource grant, group, role) for a `portal_token` provider and admits only the workflow/conversation allow-list (`apps/engine/src/rbac/evaluator.ts:256-306`), so a portal token can never resolve `stats:read` even if a tenant admin mints a custom role carrying it. The risk values themselves are also written to the audit trail under the **system** tenant (`operator.risk_signal_raised` / `operator.risk_signal_cleared`), not the reading tenant's, so the SIEM trail attributes a host condition once rather than per reader.

```mermaid
flowchart LR
    Req(["Inbound request<br/>(any surface)"])
    RBAC{{"RBAC<br/>can(actor, action, resource)?"}}
    Hook{{"Before-Request Hook<br/>(sandboxed, fail-closed)"}}
    Driver[/Connector driver/]
    Deny["Deny + audit row<br/>(policy.denied)"]

    Req --> RBAC
    RBAC -- deny --> Deny
    RBAC -- allow --> Hook
    Hook -- abort --> Deny
    Hook -- proceed --> Driver
```

---

## Further reading

- [Governance & Audit](../concepts/governance-and-audit.md) — multi-tenancy, the immutable audit trail, the compliance posture, and conversational secret hygiene.
- [Credentials & Keys](./credentials-and-keys.md) — the credential vault, master-key rotation, and release signing.
- [Scheduling & Hooks](../operators/scheduling-and-hooks.md) — the operator how-to for Before-Request Hooks.
- [glossary — governance terms](../concepts/glossary.md#group-5-governance) — Audit Log, RBAC, Before-Request Hook, Self-Healing, Patch Candidate.
