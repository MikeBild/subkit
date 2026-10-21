---
slug: engine-operator
summary: Which workspace operates the engine and what only it may do.
section: operate
order: 3
audience: operator
---
## Engine operator

One workspace is the engine operator: the workspace that completed first-run setup (on a
local development seed, `default`). Only its admins can change or read the whole engine:
engine-wide settings and their revisions, runtime secrets and prepared secret approvals,
engine restarts, engine diagnostics and logs, `/metrics`, and disabling an MCP OAuth client
for every workspace. These permissions are marked `operator: true` in
`GET /v1/rbac/permissions` (`settings:read:global`, `settings:write:global`, `system:restart`,
`metrics:read`, `mcp_oauth_client:disable`). No role, grant or key scope outside the operator
workspace can unlock them; such a request answers `403` with `details.cause: "operator_only"`.
`GET /v1/identity/whoami` reports `engine_operator`.

Every other workspace keeps its own settings. `GET /v1/settings` returns the tenant view: only
settings that support a tenant overlay, with their effective value. A change applies to your
workspace only when you name it:

```bash
sk settings set llm.model '"<model>"' --tenant <your-tenant-id>
```

In the Cockpit, workspaces outside the engine operator currently view settings read-only.
Use the CLI command above to change your own workspace settings.

Without `--tenant` the engine refuses the change instead of applying it to everyone. While the
operator has saved engine-wide settings that are not active yet, a workspace change answers
`409 operator_change_pending` and is not saved. Revoking an MCP OAuth client outside the
operator workspace removes its access in your workspace only.

The operator workspace is chosen once and moved only on the host:

```bash
engine --set-operator-tenant <slug>
```

API keys and invites carry scopes from the permission catalog, `*`, or the MCP mode markers
`mcp:read`, `mcp:authoring` and `mcp:admin`. Each scope must be held by the credential that
issues it; only a credential without scope limits can issue `*`, and a key that leaves scopes
out inherits the issuer's own limits. Rotating a key applies the same check to the scopes it
already carries. Unknown scopes answer `422 unknown_scope`, scopes beyond the issuer answer
`403 scope_exceeds_issuer`.

