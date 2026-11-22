---
slug: sk-cli-reference
scope: global
title: subkit CLI Reference
description: Mental model for the subkit command-line client — interactive REPL vs. headless, profiles and auth, the noun/verb resource commands, `subkit mcp` as the stdio proxy that serves subkit to MCP clients, and `subkit connectors` as the place external MCP servers are managed. Consult the sk-ref-cli knowledge source for exhaustive command, flag, and subcommand detail.
activates_when: [{"kind":"intent_keyword","word":"subkit cli"},{"kind":"intent_keyword","word":"command"},{"kind":"intent_keyword","word":"headless"},{"kind":"intent_keyword","word":"subkit mcp"},{"kind":"intent_keyword","word":"subkit settings"},{"kind":"intent_keyword","word":"subkit doctor"},{"kind":"intent_keyword","word":"subkit health"},{"kind":"intent_keyword","word":"subkit extract"},{"kind":"intent_keyword","word":"subkit init"},{"kind":"intent_keyword","word":"subkit join"},{"kind":"intent_keyword","word":"subkit agent"},{"kind":"intent_keyword","word":"subkit intake"},{"kind":"intent_keyword","word":"skills sync"},{"kind":"intent_keyword","word":"coding agent"}]
side_effects: read
idempotency: none
maturity: stable
tags: [sk-platform-reference, cli]
version: 4
---

# subkit CLI reference

`subkit` is the command-line client for the subkit engine. It has two run modes over one resolved profile:

- **Interactive REPL** — bare `subkit` opens a conversational session against the active profile.
- **Headless** — `subkit -p "..."` runs a single prompt and prints the result. `--output text|json|stream-json` (default `text`) selects the machine-readable shape for scripts and CI.

## Key facts

1. **Profiles + auth.** Profiles live in `~/.subkit/config.json`. `subkit login` authenticates through a configured direct OIDC device flow, scripted `--api-key`, or `--portal-token`; `subkit status` prints the active profile and engine reachability; `subkit logout` drops it; `subkit tenants [use <id>]` lists or switches the active tenant. `subkit init` bootstraps an engine + tenant + profile; `subkit join` accepts an invite.
2. **Resource commands are noun → verb.** Kebab-case nouns each carry their own subcommands: `subkit workflows`, `subkit connectors`, `subkit connector-templates`, `subkit vault`, `subkit executions`, `subkit schedules`, `subkit knowledge-sources`, `subkit skills`, `subkit skill-candidates`, `subkit patch-candidates`, `subkit discovery`, `subkit self-healing`, `subkit hooks`, `subkit subscriptions`, `subkit rbac`, `subkit audit`, `subkit apikeys`, `subkit portal-tokens`, `subkit users`, `subkit invites`, `subkit system-accounts`, and more.
3. **Diagnostics.** `subkit doctor` checks connectivity/setup (profile, reachability, authn, schema drift, version match); `subkit health` reports runtime posture (liveness, AI budget, failing runs, risk signals, drift); `subkit logs` tails engine logs; `subkit settings` (`list|get|set|configure`) reads and writes engine config with secrets masked.
4. **`subkit extract`** pulls structured data from a file (LLM for text, native parsers for binary). In the interactive REPL, pasted or dropped local paths are handled directly; `subkit files` manages uploaded files.
5. **`subkit mcp` is the MCP stdio proxy.** It runs a stdio MCP server proxied to the engine — this is how you wire subkit into MCP clients (Claude Desktop, Codex, Cursor). MCP tool names use **underscores, never dots**: `wf_<slug>`, `conversation_start`, `conversation_append`, `conversation_get`, `conversation_commit`, `conversation_respond_elicitation`, `run_workflow`, `search_knowledge`, `list_knowledge_sources`, `get_engine_status`, `whoami`, `get_ai_budget`, `get_llm_usage`, `list_inbound_hooks`, `get_inbound_hook`.
6. **The other MCP direction is `subkit connectors`.** `subkit mcp` serves subkit TO a client. An MCP server subkit CALLS is a connector with `driver: "mcp"`, managed with the ordinary connector verbs — `create --file`, `patch --file`, `enable`, `disable`, `test`, `delete` — plus two driver-specific ones: `subkit connectors mcp-inspect <id>` forces a handshake and lists the tools, capabilities and instructions the remote serves, and `subkit connectors mcp-authorize <id>` prints the OAuth 2.1 URL for the operator's browser. `subkit mcp-servers` does not exist; if a user reaches for it, point at `subkit connectors`.
7. **Coding-agent integration.** `subkit agent init --domains <slugs>` declares a repo's domains (`.subkit/agent.json`) and wires Claude Code session hooks; `subkit agent briefing` prints the domain grounding block (hooks inject it at session start); `subkit agent capture` posts a session transcript for learning distillation; captured learnings are collected in Intake (`subkit intake list|review`), and only a person confirming the proposal in the Cockpit turns one into domain knowledge or an active domain skill; `subkit skills sync` materializes those skills as SKILL.md files for Claude Code (`.claude/skills/`) and Codex (`.agents/skills/`).
8. **Debug forensics.** Headless and REPL turns write `~/.subkit/debug.log` plus `~/.subkit/history.jsonl`; grep these to trace dropped fields or failing turns.

## Full reference

This skill is intentionally thin. For the exhaustive command set — every subcommand, flag, required scope, and output shape — call:

```
search_knowledge({ query: "<your command or topic>", tags: ["sk-platform-reference"] })
```

The complete subkit CLI reference lives in the knowledge source slug `sk-ref-cli`.
