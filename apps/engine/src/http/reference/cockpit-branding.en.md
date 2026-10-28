---
slug: cockpit-branding
summary: Give the Cockpit your company's name, logo and colors.
section: operate
order: 1
audience: operator
---
## Cockpit branding

Branding makes the signed-in Cockpit show your name, your logo and a matching color palette instead of the SubKit look. You need it when your team should recognize the Cockpit as its own tool. Afterwards everyone signed in to your workspace sees the same look; login, email and other clients stay with SubKit.

### Change it in the Cockpit

A workspace is your tenant in the engine: its own data, its own users, its own permissions. To make changes you need `settings:write` and `identity:write` there. Under Settings → Workspace branding you set:

- the wordmark, meaning the displayed name, and an optional subtitle,
- one logo each for the light and the dark theme,
- one of three reviewed palette pairs.

The preview stays in your browser until you save. Reset restores the SubKit look. An accessible “powered by SubKit” attribution remains even with your own branding.

### What happens to uploaded logos

PNG, JPEG and WebP up to 2 MiB and 4 megapixels are accepted. SubKit decodes every image and stores it again as a still PNG of at most 512 pixels per edge; source metadata is dropped. SubKit refuses animation, SVG, external image addresses, scripts and custom CSS. The palette leaves the status colors unchanged, for example those that show errors or success.

Branding lives in your workspace's PostgreSQL schema. In hosted operation it counts against the storage quota.

### Through HTTP, CLI and MCP

Cockpit, HTTP API, `sk` and MCP follow the same rules: the same image checks, the same permissions, the same revisions. Every saved version has a revision. If someone else has saved in the meantime, your save fails with a conflict and the saved version stays. Reload and try again.

Authenticated callers read with `GET /v1/tenant/branding`, save with `PUT` and reset with `DELETE`. Writing needs both permissions, `settings:write` and `identity:write`. A scoped API key stays limited to its permissions; browser writes additionally check the CSRF token. Logo reads are bound to the workspace and revision. If only one logo is stored, every client applies the same fallback.

The CLI offers these commands:

```bash
sk branding get
sk branding update <json-file|->
sk branding reset <revision>
sk branding logo <light|dark> --output <file>
```

MCP provides `get_tenant_branding`, `update_tenant_branding`, `reset_tenant_branding` and `get_tenant_branding_logo`. Changes through MCP need the usual approval by a signed-in person. SubKit checks both write permissions before it requests that approval. Ordinary reads return metadata; only `get_tenant_branding_logo` returns the normalized PNG bytes. The OpenAPI and MCP input schemas are generated from the same request definition.
