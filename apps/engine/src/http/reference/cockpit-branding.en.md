---
slug: cockpit-branding
summary: Give the Cockpit your company's logo and colors.
section: operate
order: 1
audience: operator
---
## Cockpit branding

Branding makes the signed-in Cockpit show your logo and a matching color palette instead of the SubKit look. You need it when your team should recognize the Cockpit as its own tool. Afterwards everyone signed in to your workspace sees the same look; login, email and other clients stay with SubKit.

### Change it in the Cockpit

A workspace is your tenant in the engine: its own data, its own users, its own permissions. To make changes you need `settings:write` and `identity:write` there. Under Settings → Workspace, in the section “How should SubKit look for your team?”, you set:

- an optional subtitle below the name,
- one logo each for the light and the dark theme,
- one of three reviewed palette pairs.

The preview stays in your browser until you save. Reset restores the SubKit look. An accessible “powered by SubKit” attribution remains even with your own branding.

### One workspace, one name

A workspace has exactly one name. With branding, the Cockpit wordmark and the browser title show the workspace name, as does the installed app; branding does not set a second name. To change it, rename the workspace: under Settings → Workspace, answer “What’s your workspace called?” and save. Through HTTP, send `PATCH /v1/identity/workspace` with `{"display_name": "<new name>"}`. Renaming needs the workspace owner or `identity:write`.

The branding field `display_name` is deprecated. HTTP, CLI and MCP still accept it for compatibility and return it, but the Cockpit does not show it.

### What happens to uploaded logos

PNG, JPEG and WebP up to 2 MiB and 4 megapixels are accepted. SubKit decodes every image and stores it again as a still PNG of at most 512 pixels per edge; source metadata is dropped. SubKit refuses animation, SVG, external image addresses, scripts and custom CSS. The palette leaves the status colors unchanged, for example those that show errors or success.

Branding lives in your workspace's PostgreSQL schema. In hosted operation it counts against the storage quota.

### Through HTTP, CLI and MCP

Cockpit, HTTP API, `subkit` and MCP follow the same rules: the same image checks, the same permissions, the same revisions. Every saved version has a revision. If someone else has saved in the meantime, your save fails with a conflict and the saved version stays. Reload and try again.

Authenticated callers read with `GET /v1/tenant/branding`, save with `PUT` and reset with `DELETE`. Writing needs both permissions, `settings:write` and `identity:write`. A scoped API key stays limited to its permissions; browser writes additionally check the CSRF token. Logo reads are bound to the workspace and revision. If only one logo is stored, the Cockpit uses it for both the light and the dark theme; HTTP, CLI and MCP return both logo addresses.

The CLI offers these commands:

```bash
subkit branding get
subkit branding update <json-file|->
subkit branding reset <revision>
subkit branding logo <light|dark> --output <file>
```

`--revision <n>` is optional; without it the CLI downloads the logo of the current revision.

MCP provides `get_tenant_branding`, `update_tenant_branding`, `reset_tenant_branding` and `get_tenant_branding_logo`. Changes through MCP need the usual approval by a signed-in person. SubKit checks both write permissions before it requests that approval. Ordinary reads return metadata; only `get_tenant_branding_logo` returns the normalized PNG bytes. The OpenAPI and MCP input schemas are generated from the same request definition.
