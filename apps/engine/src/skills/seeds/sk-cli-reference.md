---
slug: sk-cli-reference
scope: global
title: sk CLI Reference
description: Mental model for the sk command-line client — interactive REPL vs. headless, profiles and auth, the noun/verb resource commands, `sk mcp` as the stdio proxy that serves sk to MCP clients, and `sk connectors` as the place external MCP servers are managed. Consult the sk-ref-cli knowledge source for exhaustive command, flag, and subcommand detail.
activates_when: [{"kind":"intent_keyword","word":"sk cli"},{"kind":"intent_keyword","word":"command"},{"kind":"intent_keyword","word":"headless"},{"kind":"intent_keyword","word":"sk mcp"},{"kind":"intent_keyword","word":"sk settings"},{"kind":"intent_keyword","word":"sk doctor"},{"kind":"intent_keyword","word":"sk health"},{"kind":"intent_keyword","word":"sk extract"},{"kind":"intent_keyword","word":"sk init"},{"kind":"intent_keyword","word":"sk join"},{"kind":"intent_keyword","word":"sk agent"},{"kind":"intent_keyword","word":"sk intake"},{"kind":"intent_keyword","word":"skills sync"},{"kind":"intent_keyword","word":"coding agent"}]
side_effects: read
idempotency: none
maturity: stable
tags: [sk-platform-reference, cli]
version: 4
---

# sk CLI reference

`sk` is the command-line client for the subkit engine. It has two run modes over one resolved profile:

- **Interactive REPL** — bare `sk` opens a conversational session against the active profile.
- **Headless** — `sk -p "..."` runs a single prompt and prints the result. `--output text|json|stream-json` (default `text`) selects the machine-readable shape for scripts and CI.

## Key facts

1. **Profiles + auth.** Profiles live in `~/.sk/config.json`. `sk login` authenticates through a configured direct OIDC device flow, scripted `--api-key`, or `--portal-token`; `sk status` prints the active profile and engine reachability; `sk logout` drops it; `sk tenants [use <id>]` lists or switches the active tenant. `sk init` bootstraps an engine + tenant + profile; `sk join` accepts an invite.
2. **Resource commands are noun → verb.** Kebab-case nouns each carry their own subcommands: `sk workflows`, `sk connectors`, `sk connector-templates`, `sk vault`, `sk executions`, `sk schedules`, `sk knowledge-sources`, `sk skills`, `sk skill-candidates`, `sk patch-candidates`, `sk discovery`, `sk self-healing`, `sk hooks`, `sk subscriptions`, `sk rbac`, `sk audit`, `sk apikeys`, `sk portal-tokens`, `sk users`, `sk invites`, `sk system-accounts`, and more.
3. **Diagnostics.** `sk doctor` checks connectivity/setup (profile, reachability, authn, schema drift, version match); `sk health` reports runtime posture (liveness, AI budget, failing runs, risk signals, drift); `sk logs` tails engine logs; `sk settings` (`list|get|set|configure`) reads and writes engine config with secrets masked.
4. **`sk extract`** pulls structured data from a file (LLM for text, native parsers for binary). In the interactive REPL, pasted or dropped local paths are handled directly; `sk files` manages uploaded files.
5. **`sk mcp` is the MCP stdio proxy.** It runs a stdio MCP server proxied to the engine — this is how you wire sk into MCP clients (Claude Desktop, Codex, Cursor). MCP tool names use **underscores, never dots**: `wf_<slug>`, `conversation_start`, `conversation_append`, `conversation_get`, `conversation_commit`, `conversation_respond_elicitation`, `run_workflow`, `search_knowledge`, `list_knowledge_sources`, `get_engine_status`, `whoami`, `get_ai_budget`, `get_llm_usage`, `list_inbound_hooks`, `get_inbound_hook`.
6. **The other MCP direction is `sk connectors`.** `sk mcp` serves sk TO a client. An MCP server sk CALLS is a connector with `driver: "mcp"`, managed with the ordinary connector verbs — `create --file`, `patch --file`, `enable`, `disable`, `test`, `delete` — plus two driver-specific ones: `sk connectors mcp-inspect <id>` forces a handshake and lists the tools, capabilities and instructions the remote serves, and `sk connectors mcp-authorize <id>` prints the OAuth 2.1 URL for the operator's browser. `sk mcp-servers` does not exist; if a user reaches for it, point at `sk connectors`.
7. **Coding-agent integration.** `sk agent init --domains <slugs>` declares a repo's domains (`.sk/agent.json`) and wires Claude Code session hooks; `sk agent briefing` prints the domain grounding block (hooks inject it at session start); `sk agent capture` posts a session transcript for learning distillation; captured learnings are collected in Intake (`sk intake list|review`), and only a person confirming the proposal in the Cockpit turns one into domain knowledge or an active domain skill; `sk skills sync` materializes those skills as SKILL.md files for Claude Code (`.claude/skills/`) and Codex (`.agents/skills/`).
8. **Debug forensics.** Headless and REPL turns write `~/.sk/debug.log` plus `~/.sk/history.jsonl`; grep these to trace dropped fields or failing turns.

## Full reference

This skill is intentionally thin. For the exhaustive command set — every subcommand, flag, required scope, and output shape — call:

```
search_knowledge({ query: "<your command or topic>", tags: ["sk-platform-reference"] })
```

The complete sk CLI reference lives in the knowledge source slug `sk-ref-cli`.
