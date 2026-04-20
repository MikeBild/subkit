---
slug: mcp-codex-integration
scope: global
title: MCP Integration For Codex And Claude Desktop
description: Connect subkit as an MCP server for Codex, Claude Code, or Claude Desktop. Emits paste-ready config using the real engine_url and a freshly-minted API key.
gates_tools: [create_api_key]
version: 1
auto_load: true
trigger_keywords: [mcp, codex, claude code, claude desktop, model context protocol, mcp server, mcp client, sk mcp, subkit mcp]
---

# Connecting Subkit as an MCP Server

Goal: produce a config the user can paste into their MCP client (Codex, Claude Code, Claude Desktop, Cursor, Continue) and have `tools/list` succeed on the first try. **No placeholders. No TODOs. Real `engine_url`, real key.**

## Two paths

| Path | When | What the user pastes |
|---|---|---|
| **A. Streamable HTTP** | Default. Works for any MCP client that supports the modern HTTP transport (Codex, Claude Desktop ≥ 0.10, Cursor, Continue). | A `mcpServers.subkit` block pointing at `${engine_url}/mcp` with a Bearer header. |
| **B. stdio proxy via `sk mcp`** | Only when the client cannot do Streamable HTTP. The proxy reads credentials from the local sk profile so the user does not paste the key into the client config. | A `mcpServers.subkit` block invoking `sk mcp`. |

## Required runtime context

Before producing any config, confirm you have:

1. `engine_url` from RUNTIME CONTEXT. If missing, call `cannot_help(reason: "engine_url is not exposed in this turn", missing_capability: "manifest.runtime_context.engine_url")`.
2. A verified vendor recipe for the user's client (D8 — `VendorRecipeManifest`). When the user names a client we have not authored a recipe for (Cursor, Continue, etc.), say so plainly and emit only the SDK-shape fallback with a `verify with the client's docs` caveat.

## Six-step flow

1. **Identify the client.** Ask "which MCP client are you using?" if the user did not say. Common: Codex, Claude Code, Claude Desktop, Cursor, Continue.
2. **Pick the path** (A or B) based on what the client supports. Default to A.
3. **Mint a key with the smallest scope that works.** For most MCP integrations this is `["workflow:read", "workflow:invoke"]`. Call `create_api_key({ name, scopes })` — this returns the plaintext key exactly once. **NEVER suggest the user run `sk apikeys create` themselves; you have the tool.**
4. **Emit the config block** using the real `engine_url` and the real key. Pretty-print JSON. Wrap in a fenced ` ```json ` block.
5. **Tell the user where the file lives** for their client (e.g. `~/.claude.json` for Claude Code, the Codex settings UI, the Cursor `.cursor/mcp.json` workspace file).
6. **Offer a one-line verification command** the user can run after pasting (`sk mcp` for stdio, or the client's "List MCP servers" UI for HTTP).

## Output template (Path A — Streamable HTTP)

```json
{
  "mcpServers": {
    "subkit": {
      "url": "${engine_url}/mcp",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer ${plaintext_key}"
      }
    }
  }
}
```

Substitute `${engine_url}` from RUNTIME CONTEXT and `${plaintext_key}` from the `create_api_key` result. Both are real values — do not leave brackets, angles, or `your-…` placeholders in the emitted block.

## Output template (Path B — stdio proxy)

```json
{
  "mcpServers": {
    "subkit": {
      "command": "sk",
      "args": ["mcp"]
    }
  }
}
```

The `sk mcp` proxy reads `SUBKIT_API_KEY`, `SUBKIT_ENGINE_URL`, and the active sk profile (`~/.sk/config.json`), so the client config carries no secrets. Tell the user to run `sk login` first if they have not already.

## Things to refuse

- **Do not** invent a vendor-specific config shape. If the user names a client whose recipe you do not have in `VendorRecipeManifest`, emit the generic Streamable-HTTP shape and say "I do not have a verified ${client} recipe yet — please double-check this against ${client}'s MCP docs before deploying."
- **Do not** emit `your-subkit-instance.com`, `<YOUR_API_KEY>`, `[rest-of-your-key]`, or any other placeholder. The output guard will reject these in CI; the user will hate them in production.
- **Do not** suggest CLI alternatives ("you could also run `sk apikeys create…`") when the in-conversation `create_api_key` tool exists. The CLI is for operators who are already in a terminal; the chat user is here.

## Recovery

If `create_api_key` returns `{ ok: false, error: "permission_denied" }`, the calling actor lacks `api_key:write`. Tell the user plainly and call `cannot_help(reason: "current role cannot mint api keys", missing_capability: "rbac.api_key_write", suggest_alternative: "ask an admin to mint the key, or login as an admin and retry")`. Do NOT retry the same call.
