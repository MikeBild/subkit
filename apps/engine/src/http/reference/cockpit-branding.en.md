---
slug: cockpit-branding
summary: Change the Cockpit's name, logos and colors for your workspace.
section: operate
order: 1
audience: operator
---
## Cockpit branding

Workspace administrators with `settings:write` and `identity:write` can change the
signed-in Cockpit's wordmark, optional subtitle, theme-specific logos and one of
three reviewed palette pairs under Settings → Branding. Draft previews stay local
until saved. Reset restores the existing SubKit appearance. Configured branding
retains an accessible “powered by SubKit” attribution; login, email and other
clients keep their existing identity.

Branding is stored in the workspace's PostgreSQL schema and counts against hosted
storage limits. PNG, JPEG and WebP uploads are bounded to 2 MiB and 4 megapixels,
decoded and normalized to a still PNG of at most 512 pixels per edge. Animation,
SVG, external image addresses, scripts and arbitrary CSS are refused. New encoding
removes source metadata. Palette selection preserves semantic status colors.

HTTP, sk CLI, MCP and Cockpit share the same tenant-owned branding contract,
normalization, permissions and optimistic revisions. Authenticated callers read
`GET /v1/tenant/branding`, save with `PUT` and reset with `DELETE`. Writes require
both `settings:write` and `identity:write`; scoped API keys retain their permission
ceiling. Browser writes additionally retain CSRF protection. A conflict preserves
the saved configuration; reload before retrying. Logo reads are bound to the
workspace and revision and apply the same single-logo fallback in every client.

The CLI provides `sk branding get`, `sk branding update <json-file|->`,
`sk branding reset <revision>` and `sk branding logo <light|dark> --output <file>`.
MCP exposes `get_tenant_branding`, `update_tenant_branding`,
`reset_tenant_branding` and `get_tenant_branding_logo`. MCP mutations retain the
normal authenticated human approval path; both write permissions are checked
before requesting approval. Ordinary reads contain metadata, while the explicit
logo operation returns normalized PNG bytes. The generated OpenAPI and MCP input
schemas derive from the shared request contract. Visual branding remains limited
to the signed-in Cockpit.

