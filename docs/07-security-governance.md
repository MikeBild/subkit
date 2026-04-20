# Security & Governance

Enterprise AI requires enterprise-grade security from the start. A platform that touches production integrations, sensitive credentials, and automated business processes cannot treat security as a layer added later. It has to be the foundation.

sk is designed so that the right security behavior is the default behavior. Every interaction is authorized, every action is auditable, and every secret is protected — by architecture, not by configuration.

---

## Multi-Tenancy as a First-Class Concern

sk is multi-tenant from the ground up. Every resource in the platform — workflows, connectors, credentials, users, skills, conversations, audit log entries — belongs to exactly one Tenant. This is not a deployment mode or a configuration setting. It is the data model.

Tenant isolation is enforced at every layer. Database queries always filter by tenant identity. API responses never include cross-tenant data. The audit log is tenant-scoped. A single engine instance can serve multiple organizations with complete isolation between them.

This design means there is no "global" namespace to accidentally share, no configuration flag to toggle isolation on or off, and no way for one tenant's data to appear in another tenant's context. Isolation is structural.

---

## Identity and Authentication

sk supports multiple authentication methods in a pluggable chain. Organizations choose the combination that fits their security posture.

**OIDC** enables enterprise SSO. Users log in with their organization's identity provider — Azure AD, Okta, Google Workspace, or any OIDC-compliant provider. The engine provisions tenant accounts from the claims in the identity token. For organizations with existing SSO infrastructure, this is the right path: users get seamless access through the same credential they use everywhere else, and the organization retains control over provisioning and deprovisioning.

**API Keys** are the standard programmatic credential. They are long-lived, revocable, and scoped to a tenant and a specific permission set. Every key is hashed before storage — the raw key is shown exactly once at creation. There is no way to retrieve a plaintext key after that point. If a key is lost, a new one is issued and the old one revoked. API keys support overlap-window rotation: a new key can be issued before the old one expires, so access is never interrupted during rotation.

**Portal Tokens** are short-lived, single-purpose credentials issued for specific end-user flows. They expire automatically. They carry only the permissions required for their specific purpose — nothing more. Portal tokens are the right choice for customer-facing integrations and controlled access flows where a user needs to interact with a specific workflow without becoming a full tenant member.

---

## Role-Based and Attribute-Based Access Control

Every API route, MCP tool, and workflow trigger is protected by RBAC. The permission check happens before any resource is accessed or any action is taken. There is no path through the platform that bypasses authorization.

sk ships four built-in roles: **admin** (full platform control), **member** (can author and trigger workflows), **end-user** (can trigger and view, cannot modify), and **service account** (programmatic access, no interactive surface). Operators can create custom roles for more granular control, define resource-level grants with expiration times, and group users for assignment.

**Before-Request Hooks** add a dynamic policy layer on top of static RBAC. A Before-Request Hook is a sandboxed script that runs before a Connector request executes. The hook receives the full request context — caller identity, target connector, operation type, request parameters — and can enforce policy that is impossible to express in static roles. Examples: blocking write operations during a maintenance window, requiring additional approval for specific production connectors, enforcing data residency constraints, or logging requests that match a specific pattern.

Hooks run in an isolated QuickJS-WASM sandbox with a strict CPU budget. They cannot access the network, the file system, or the database. An error or timeout in a hook fails closed: the request is denied. Hook execution is recorded in the audit log.

**Policy evaluation order:** RBAC is evaluated first. If the caller has no permission for the action, the request is denied before the hook is consulted. If RBAC passes, the Before-Request Hook runs. If the hook aborts, the request is denied with the hook's reason. Only if both pass does the request proceed.

---

## The Credential Vault

All integration secrets — API keys, OAuth2 access and refresh tokens, database passwords, connection strings — are stored in the credential vault, encrypted with AES-256-GCM.

Secrets are never logged. They are never included in API responses. They are never visible to the AI during conversations. Connectors reference credentials by identifier; the credential vault resolves the identifier to the actual secret at the moment of use. Outside that moment, the raw value does not exist in memory or in any logged context.

OAuth2 token refresh is automatic. The engine manages the full OAuth2 lifecycle — access token expiry, refresh token rotation, re-authorization when needed. Connectors never deal with expired tokens; the vault handles it transparently.

End-user credential overrides are supported. Individual users can supply their own credentials for a connector without operator involvement — for example, a user connecting sk to their personal GitHub account rather than the organization's shared integration. Overrides are stored in the same vault with the same encryption guarantees.

---

## The Audit Trail

Every state change in sk produces an immutable audit log entry. This is not selective logging — it is comprehensive.

The audit log captures: workflow creation, modification, approval, and deletion; connector operations; credential creation, rotation, and revocation; user provisioning and role changes; execution triggers and final results; approval events; skill promotions; patch candidate reviews; and more — over 100 distinct action types across all platform surfaces.

Each entry captures the full context of the event: what action was taken, who took it (user or service account identity), from which surface (API, CLI, MCP, chat, webhook, or scheduler), what changed (a structured diff where applicable), and precisely when.

The audit log cannot be modified or deleted. It is the compliance and forensics record for the platform. It is designed to answer the question every audit or incident review requires: "Who did what, when, and from where?"

Operators can query the audit log by actor, action type, resource, time range, and request source. The `sk audit-log tail` command provides a real-time stream for operational monitoring. The API exposes the same query surface programmatically.

---

## The Compliance Posture

The following properties hold by construction — they are not optional configurations.

**Encryption at rest.** All credentials are encrypted with AES-256-GCM before being written to the database. The encryption key is managed at the engine configuration layer.

**Encryption in transit.** All engine endpoints are served over TLS. The engine does not serve unencrypted HTTP in production configurations.

**API key storage.** Keys are stored as hashes. The comparison during authentication is always against the hash, never against a stored plaintext value. There is no way to recover a key after issuance.

**Webhook signatures.** All inbound webhooks use the Standard Webhooks signature scheme (HMAC-SHA256). The engine verifies signatures before processing any webhook payload. Requests with missing or invalid signatures are rejected.

**Sandboxing.** Untrusted code — transforms, Before-Request Hooks, and self-healing patch scripts — runs in an isolated QuickJS-WASM sandbox with a strict CPU budget. Sandbox code cannot access the network, the file system, or the database. The sandbox is not a trust boundary that can be configured away; it is where all runtime code execution occurs.

**Egress governance.** Connector requests go through the engine. Clients never call external systems directly. All egress is logged in the audit log with request source, caller identity, and outcome.

**Request source tracking.** Every platform interaction — API call, MCP tool invocation, webhook delivery, chat message, CLI command, scheduled trigger — is tagged with its source. "Who initiated this?" is always answerable from the audit log.

---

## What to Read Next

- [docs/08-operations.md](08-operations.md) — how sk is deployed, how operators monitor it in production, and how it handles failure gracefully.
