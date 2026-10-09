---
slug: coding-agent-setup
scope: global
title: Connect a coding agent
description: How to answer "how do I use sk from Claude Code, Codex, Hermes or Cursor": the machine setup (CLI, key, MCP registration), the repository setup (`sk agent init` with the domain), what the briefing carries, and the checks when none arrives. Points at the platform reference instead of inventing config shapes.
activates_when: [{"kind":"intent_keyword","word":"claude code"},{"kind":"intent_keyword","word":"codex"},{"kind":"intent_keyword","word":"hermes"},{"kind":"intent_keyword","word":"cursor"},{"kind":"intent_keyword","word":"coding agent"},{"kind":"intent_keyword","word":"coding-agent"},{"kind":"intent_keyword","word":"agent init"},{"kind":"intent_keyword","word":"session briefing"},{"kind":"intent_keyword","word":"briefing"},{"kind":"intent_keyword","word":"hooks"},{"kind":"intent_keyword","word":"hook"},{"kind":"intent_keyword","word":"mcp add"},{"kind":"intent_keyword","word":"anbinden"},{"kind":"intent_keyword","word":"einrichten"}]
side_effects: read
idempotency: none
maturity: stable
tags: [coding-agents, onboarding, mcp]
version: 1
---

# Connect a coding agent

The person wants sk inside the tool they already use. Give them the shortest working path, in their client's words, and never invent a config shape: the commands below are the contract, and the knowledge source `sk-ref-coding-agents` holds the details.

## 1. Ask which client, then answer for that client only

Claude Code, Codex, Hermes, Cursor, a browser AI client. If unknown, ask once. Do not list every client.

## 2. Machine setup, once

```bash
curl -fsSL https://<engine-host>/install | bash
sk login --engine-url https://<engine-host>
sk apikeys create            # the agent's own identity; read+run keys cannot author
export SK_API_KEY=<key>
claude mcp add --transport http --scope user sk https://<engine-host>/mcp --header "Authorization: Bearer ${SK_API_KEY}"
codex mcp add sk --url https://<engine-host>/mcp --bearer-token-env-var SK_API_KEY
```

Replace `<engine-host>` with this installation's address from `get_engine_status` or `sk status`. Other clients use the stdio form: command `sk`, args `["mcp"]`, env `SK_ENGINE_URL` and `SK_API_KEY`.

## 3. Repository setup, once per repo

```bash
sk agent init --domains <category>
```

Explain in one sentence what it did: `.sk/agent.json` (commit it), Claude Code hooks in `~/.claude/settings.json`, Codex briefing hooks in `~/.codex/hooks.json`. The command reconciles the SubKit hooks and preserves other tools’ hooks. Claude Code and Codex show you the loaded domains, included materials, and pending skill reviews; the model receives the full briefing. A failed fetch gives a non-blocking warning. Then the two Codex steps that stay manual: `[features] hooks = true` in `~/.codex/config.toml`, and trusting the hooks once under `/hooks`. Hermes: run `sk agent briefing` in the repo and hand the output to the session. Repositories without `.sk/agent.json` stay silent; run this once per repository and commit the generated file.

The domain is a catalog category. Use `list_knowledge_sources` or `find_workflow` to name the category the person's work already lives in; do not make one up.

## 4. Say what the briefing carries

Conventions (active skills of the domain), the knowledge index, the domain's workflows and connectors, the three working guides, and the grounding rule to search before guessing. To get something briefed: put it in the category or tag it `domain:<slug>`. Verify with `sk status` and `sk agent briefing --json`. Empty `knowledge_sources` or `skills_full` means the briefing works, but those materials are not assigned to its domain.

## 5. When no briefing arrives, check in this order

1. Start the client in the repository or a subdirectory and confirm `.sk/agent.json` exists up the tree.
2. Run `sk status`, then `sk agent briefing --json` from that repository to separate configuration, credentials, and server problems.
3. In Claude Code or Codex, open `/hooks` to check whether hooks ran and inspect errors. Codex also needs its feature flag enabled, trusted hooks, and `additionalContextLimit: 0`.
4. Confirm `sk` is on the client’s PATH (desktop-launched clients may need an absolute command path).
5. Read `~/.sk/debug.log` for `agent.briefing_hook_failed`; hook failures show a warning and never block the session.

## Pitfalls

- Never paste a key into a prompt or a config the person did not ask for; keys go into env variables.
- Do not promise capture for Codex; Codex's Stop hook fires every turn, so capture is optional and off by default.
- Authoring is not done from the agent; point to the `sk` CLI or the cockpit for changes.
