# RBAC, identities & permission transparency

This note records how authorization works in subkit today, what an external
reference implementation does differently, and — most importantly — *why the
remaining work is transparency, not new enforcement machinery*. It is written to
stay true over time: it describes contracts and mechanisms, not a point-in-time
backlog.

## The model today

subkit ships a complete, centralized, multi-tenant RBAC. Every authorization
question funnels through one evaluator, `can(db, check)` in
`apps/engine/src/rbac/evaluator.ts`, which returns a `Decision { allow, reason,
source }`. Decision order, first match wins:

1. built-in `admin` role → allow (`builtin_admin`)
2. direct `resource_grants` row for `(subject, resource, permission)` → `resource_grant`
3. group membership → `group_role_assignments` → `role_permissions` → `group`
4. principal `role_id` → `role_permissions` → `role`
5. portal-token allowlist (`allowed_workflows`) for `workflow:run`/`read` and the
   conversation surfaces → `portal_token_allowlist`
6. otherwise deny

Every outcome increments `rbac_checks_total{result,permission,source}` and every
genuine deny writes a `POLICY_DENIED` audit row.

### Identities

- **tenants** — every row in every table is tenant-scoped; the tenant is a
  mandatory field on the resolved principal. There is no single-tenant mode, and
  none is needed: "corporate/local" simply means a self-hosted instance whose
  users and roles are managed locally through the CLI/REST/TUI.
- **users** — human principals (OIDC / session), carry a `role_id`.
- **system accounts** — machine principals (API key), carry a `role_id`.
- **api keys** — issued to a user or system account; carry `scopes`,
  `allowed_workflows`, `allowed_connectors`.
- **portal tokens** — end-user credentials, hard-isolated to an
  `allowed_workflows` allowlist.

### Authorization primitives

- **permissions** — a flat `resource:action` catalog
  (`apps/engine/src/rbac/permissions.json`): `workflow:read`, `connector:write`,
  `knowledge:delete`, `mcp:authoring`, … Permissions are global; roles are
  built-in (global, immutable) or custom (tenant-scoped, created at runtime).
- **roles** + **role_permissions** — the primary grant path.
- **groups** + **group_members** + **group_role_assignments** — a user inherits
  every role of every group it belongs to (tenant-scoped).
- **resource_grants** — fine-grained `(subject → resource_type:id → permission)`
  with optional `expires_at`. The subject may be a user, a system account, or a
  group.

### Surfaces and how each is gated

A single permission decision is shared across every surface, but *which actions
even exist on a surface* is shaped before the permission check:

- **HTTP / REST** (`apps/engine/src/http/middleware/require-permission.ts`) — each
  route declares a permission; `requirePermission()` calls `can()`. sk-cli is an
  HTTP client and inherits this path exactly.
- **MCP & Chat tools** flow through one dispatcher
  (`apps/engine/src/tools/dispatcher.ts`). Step 3 evaluates
  `descriptor.rbac.permission` via `can()`. Before that:
  - `resolveMcpMode()` (`apps/engine/src/mcp/mode-resolver.ts`) narrows the MCP
    catalog by scope: `product` (saved workflows + authenticate), `authoring`
    (`mcp:authoring` → `conversation.*`), `admin` (`mcp:admin` → tenant writes).
  - per-surface visibility flags (`visibleOnChat`, and the per-`surface`+`mcpMode`
    registry in `apps/engine/src/tools/registry.ts`) decide which tools list.
  - `policyDecide()` (`apps/engine/src/tools/policy.ts`) can return
    `not_available_on_surface` with an actionable reason (e.g. `draft_write` on
    MCP points the caller at `conversation_start`).
- **Webhooks** carry an execution token scoped to `execution:signal`.

The practical consequence: "who may author over MCP vs. chat vs. CLI" is already
expressible — through the `mcp:authoring`/`mcp:admin` scopes, per-surface tool
visibility, and the policy gate. A separate per-channel permission dimension would
be a fourth, overlapping mechanism for a question the first three already answer.

### Management surfaces

- Full REST (`/v1/rbac/*`, `/v1/identity/*`).
- Full `sk` CLI (`sk rbac roles|grants|groups|can`, `sk apikeys`,
  `sk system-accounts`, `sk portal-tokens`, `sk users`).
- An Ink/React terminal admin (`sk admin`,
  `apps/sk/src/settings-ui/tabs/AdminTab.tsx`).
- MCP exposes identity/RBAC as **read-only** tools by design.

## Comparison with the reference implementation

| Axis | subkit | reference impl | takeaway |
|---|---|---|---|
| Role model | relational `resource:action` catalog | JSONB `access_rules` `{tools, systems}` | subkit's is cleaner and auditable — keep |
| Per-resource | `resource_grants` table | embedded JSONB rules | parity (relational vs. embedded) |
| Per-connector level | `connector:read/write/delete` | none/read-only/read-write per system | adopt the *UX framing* over existing grants |
| API-key scopes | fields present, not enforced by the evaluator | inherit role, enforced via hooks | enforce, so the displayed scope is true |
| Channel scoping | already covered three ways | not really per-channel either | no new mechanism warranted |
| Admin UI | terminal TUI | web dashboard | extend the TUI |
| Audit | dedicated `audit_log` | denormalized `created_by` | subkit's is stronger — keep |

The one genuinely adoptable idea is the reference impl's **per-connector
access-level framing** (none / read-only / read-write). subkit can express it with
existing `resource_grants` — read-only is a `connector:read` grant, read-write adds
`connector:write` — without a parallel rules engine.

## The real gap: transparency, not enforcement

Two facts make the point:

- `principal.scopes` is read only by `resolveMcpMode` (for the `mcp:*` family); the
  evaluator never consults it. A key minted with `scopes:["workflow:read"]` can
  still delete a connector over REST. Yet `whoami`
  (`apps/engine/src/http/routes/identity/whoami.ts`) reports those scopes back to
  the caller — so the displayed scope is not the enforced scope.
- `hasResourceGrant()` matches only `subject_type === principal.kind`, so
  group-subject grants never resolve, and it does not filter `expires_at`, so
  expired grants still allow. A grant can therefore be shown as active or scoped
  while behaving differently.

A connector or an API key is typically configured once, with its OAuth / API-key
permissions fixed at that moment. The person who later *builds a workflow on top of
it* is the one who needs to know — or be notified — what that connector or key
actually permits, and to get an actionable message when an operation is refused.

That yields a single guiding principle:

> **Displayed permissions must equal enforced permissions.** Transparency is only
> useful if it is honest, so the minimal enforcement needed to make the surfaced
> rights *true* is a prerequisite for the transparency work — not a separate
> lock-down feature.

### What follows

1. **Truthful substrate** — make the already-present fields real: enforce key
   scopes/allowlists in `can()` as a pre-filter that runs *before* the admin
   short-circuit (a deliberately narrow credential must narrow even an admin, or
   the narrowing is a lie), and fix the two `hasResourceGrant` bugs. Positive
   per-connector grants stay positive-only and do not constrain admin.
2. **Actionable denials** — turn `permission_denied:connector:write` into "you hold
   `connector:read` but lack `connector:write` on `<id>`; request a grant or a key
   with that scope", surfaced consistently on REST, MCP/chat, and CLI.
3. **Capability introspection** — let a builder ask "what may I do with connector
   X?" and get effective rights (role ⊕ groups ⊕ grants, intersected with
   scopes/allowlists) ∩ what the connector's credential supports.
4. **Build-time notification** — warn at authoring/dry-run when a workflow step
   needs an operation the author's grant/key does not cover, instead of failing at
   run time.

Channel-scoped permissions are intentionally *not* added: the surface model above
already covers the question, and a fourth mechanism would cost clarity for no new
capability.
