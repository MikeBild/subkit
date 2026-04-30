---
slug: mcp-server-setup
scope: global
title: MCP Server Setup
description: Protocol-level facts for connecting any MCP client (Codex, Claude Desktop, Cursor, Continue, Zed, Goose, …) to subkit as an MCP server. Vendor-specific config shapes live in the VendorRecipeManifest and must be fetched via `get_vendor_recipe`, not reproduced in prose.
gates_tools: []
version: 2
auto_load: true
trigger_keywords: [mcp, mcp server, mcp client, model context protocol, codex, claude code, claude desktop, cursor, continue, zed, goose, sk mcp, subkit mcp]
---

# Connecting a client to subkit as an MCP server

Subkit exposes MCP at two transports:

- **Streamable HTTP** — `${engine_url}/mcp`, `Authorization: Bearer <api_key>`. Default for any modern MCP client.
- **stdio proxy** — `sk mcp` on the user's machine. Reads `SUBKIT_API_KEY`, `SUBKIT_ENGINE_URL`, and the active profile from `~/.sk/config.json`. Use only when the client cannot speak Streamable HTTP.

## How to answer "how do I connect X?"

1. Identify the client (Codex, Claude Desktop, Cursor, Continue, Zed, Goose, …). If the user did not name one, ask once.
2. Call `get_vendor_recipe({ client: <name> })` to fetch the verified config template and the config-file location. **Do NOT invent a JSON shape. Do NOT quote from memory.** The manifest is the only source of truth.
3. If the tool returns `{ ok: false, error: "not_found" }`, call `cannot_help(reason: "no verified recipe for <client> yet", missing_capability: "vendor_recipe.<client>", suggest_alternative: "Streamable HTTP at ${engine_url}/mcp with a Bearer header is the generic shape — double-check against the client's own docs before deploying.")`. Do not guess.
4. Emit the returned `config_template_streamable_http` (or `config_template_stdio` when the user's client requires it) verbatim. The assembler has already substituted `${engine_url}`; leave `${plaintext_key}` as a labelled placeholder until the user confirms they want one minted.
5. Report the recipe's `freshness.status`: `fresh` = ship it, `warn` = flag "this recipe was last verified <N> days ago — double-check", `stale` = refuse and call `cannot_help(missing_capability: "vendor_recipe.<client>.refresh")`.
6. Tell the user where the config file lives (the recipe's `config_path_hints`).

## Key minting is a separate turn

The base-prompt TURN-ONE DISCIPLINE rule applies in full: do not call `create_api_key` in the same turn you first answer the user's "how do I connect?" question. Emit the config with `${plaintext_key}` as a placeholder, end with a plain-language offer ("Reply `yes` to mint a key with scopes `workflow:read, workflow:invoke`"), and only call `create_api_key` after explicit confirmation.

## Refusals

- Do not substitute this tool lookup with an inline JSON shape, even for well-known clients.
- Do not emit `your-subkit-instance.com`, `<YOUR_API_KEY>`, `[rest-of-your-key]`, or any other placeholder host / key. The output guard will rewrite these; the user will reject them.
- Do not recommend a transport the recipe does not declare in its `transports` array.

## Example: get_vendor_recipe response (engine-side only)

This is the engine response shape `get_vendor_recipe` returns, NOT a client
config. The `config_template_streamable_http` / `config_template_stdio`
fields ship verbatim — never paraphrase. The freshness `status` decides
whether to use, warn, or refuse.

```json
{
  "ok": true,
  "client": "claude-desktop",
  "transports": ["streamable-http", "stdio"],
  "freshness": {
    "status": "fresh",
    "verified_at": "2026-04-01T00:00:00Z",
    "days_since": 28
  },
  "config_path_hints": [
    "~/Library/Application Support/Claude/claude_desktop_config.json"
  ]
}
```

Use the response's `config_template_*` field (omitted from this example
because the assembler-substituted body is vendor-specific) verbatim in
your reply.
