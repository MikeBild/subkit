---
slug: engine-operator
summary: Decide which workspace administers the whole engine.
section: operate
order: 3
audience: operator
---
## Engine operator

An engine can hold several workspaces; one of them is the engine operator and administers the engine as a whole. You need this chapter when you change settings, maintain secrets or issue API keys. Afterwards you know which change applies to everyone and which only to your workspace.

### What only the operator may do

Technically, every workspace is its own tenant with separate data, users and permissions. The operator is the workspace that completed first-run setup (on a local development seed, `default`). Only its admins can read or change the whole engine:

- engine-wide settings and their revisions,
- runtime secrets and prepared secret approvals,
- engine restarts,
- engine diagnostics and logs, and `/metrics`,
- disabling an MCP OAuth client for every workspace.

In `GET /v1/rbac/permissions` these permissions carry `operator: true`: `settings:read:global`, `settings:write:global`, `system:restart`, `metrics:read` and `mcp_oauth_client:disable`. Outside the operator workspace, no role, grant or key scope can unlock them. Such a request answers `403` with `details.cause: "operator_only"`. `GET /v1/identity/whoami` reports `engine_operator` for this.

The operator workspace is chosen once. You can move it only on the host:

```bash
engine --set-operator-tenant <slug>
```

### Your workspace's settings

Every other workspace keeps its own settings. `GET /v1/settings` returns your tenant's view: only settings that support a per-tenant overlay, each with its effective value. A change applies to your workspace only when you name it explicitly:

```bash
sk settings set llm.model '"<model>"' --tenant <your-tenant-id>
```

In the Cockpit, workspaces outside the operator currently see settings read-only. Use the CLI command above to make changes.

Without `--tenant` the engine refuses the change instead of applying it to everyone. While the operator has saved engine-wide settings that are not active yet, a workspace change answers `409 operator_change_pending` and is not saved. If you revoke an MCP OAuth client outside the operator, it loses access in your workspace only.

### Scopes for API keys and invites

A scope limits what an API key or invite may do. Allowed are scopes from the permission catalog, `*`, or the MCP modes `mcp:read`, `mcp:authoring` and `mcp:admin`. These rules apply:

- The issuing credential must hold every scope itself.
- Only a credential without scope limits can issue `*`.
- A key without scopes inherits the limits of whoever issues it.
- Rotating a key applies the same check to the scopes it already carries.

Unknown scopes answer `422 unknown_scope`, scopes beyond the issuer's permissions answer `403 scope_exceeds_issuer`.
