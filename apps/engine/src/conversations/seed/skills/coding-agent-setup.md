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

Explain in one sentence what it did: `.sk/agent.json` (commit it), Claude Code hooks in `~/.claude/settings.json`, Codex briefing hooks in `~/.codex/hooks.json`. The command adds the requested domains without removing existing domains or settings, reconciles SubKit's hooks, and preserves other tools' hooks. Claude Code and Codex show a short ready status; the model receives the bounded project briefing and can offer relevant reviews in the language of the conversation. A failed fetch gives a non-blocking warning. Then the two Codex steps that stay manual: `[features] hooks = true` in `~/.codex/config.toml`, and trusting the hooks once under `/hooks`. Hermes: run `sk agent briefing` in the repo and hand the output to the session. In a folder without `.sk/agent.json`, the hook tries an exact folder-name match to a readable project category; if it finds one, it creates an inferred declaration and includes shared SubKit context when available. If there is no unique project match, it may create a shared-only declaration and ask which project area belongs here when setup is relevant. Review and commit a hook-created declaration. Use `sk agent init --domains <category>` when you want to declare domains explicitly.

The domain is a catalog category. Use `list_knowledge_sources` or `find_workflow` to name the category the person's work already lives in; do not make one up.

## 4. Say what the briefing carries

Conventions (active skills of the domain), the knowledge index, the domain's workflows and connectors, the three working guides, and the grounding rule to search before guessing. To get something briefed: put it in the category or tag it `domain:<slug>`. Verify with `sk status` and `sk agent briefing --json`. Empty `knowledge_sources` or `skills_full` means the briefing works, but those materials are not assigned to its domain.

## 5. When no briefing arrives, check in this order

1. Start the client in the project folder. If `.sk/agent.json` is missing, the hook tries to match the folder name to one readable project category and creates an inferred declaration when it finds a match; review and commit it. Otherwise use `sk agent init --domains <category>` to declare the project area explicitly.
2. Run `sk status`, then `sk agent briefing --json` from that repository to separate configuration, credentials, and server problems.
3. In Claude Code or Codex, open `/hooks` to check whether hooks ran and inspect errors. Codex also needs its feature flag enabled, trusted hooks, and `additionalContextLimit: 0`.
4. Confirm `sk` is on the client’s PATH (desktop-launched clients may need an absolute command path).
5. Read `~/.sk/debug.log` for `agent.briefing_hook_failed`; hook failures show a warning and never block the session.

## Collected pages and ideas

The intake reminder contains tenant-wide counts, not page contents or accepted
facts. It appears only with intake read permission. Offer one useful next step:
review the new entries in the person's named category. Use a persisted SubKit
conversation; MCP `conversation_start` accepts `intake_item_ids` for a fixed
selection. Direct item/proposal MCP calls cannot provide that saved review state.
Return the authenticated Cockpit review link, explain what is useful and why,
and show sources, proposed text and destination. The person confirms there.

Confirmed knowledge appears in a repository briefing only when its destination
has the corresponding category or domain tag. Preserve an existing destination's
assignment or include it in a new destination's reviewable proposal. Verify with
`sk agent briefing --json` and knowledge search after confirmation. Never load
unconfirmed clip text as briefing instructions or use a key label as source author.

## Pitfalls

- Never paste a key into a prompt or a config the person did not ask for; keys go into env variables.
- SessionEnd capture is installed for both Claude Code and Codex; Codex queues it asynchronously because its hook has a three-second deadline.
- Authoring is not done from the agent; point to the `sk` CLI or the cockpit for changes.
