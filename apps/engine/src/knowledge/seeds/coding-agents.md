---
slug: sk-ref-coding-agents
name: sk Platform Reference — Coding Agents
description: How a person connects Claude Code, Codex, Hermes or another MCP client to sk, what the session briefing is and how knowledge reaches it, how an agent runs workflows and looks things up under the person's own rights, how learnings flow back, and what to check when a briefing does not arrive.
tags: [sk-platform-reference, coding-agents, claude-code, codex, hermes, mcp, hooks, briefing, onboarding]
scope: global
version: 3
generated: true
---

# Use SubKit from a coding agent

This chapter is for developers who work with Claude Code, Codex or Hermes.
You give your agent the SubKit tools and, for each repository, a briefing from your team's shared knowledge.
Afterwards the agent runs approved workflows, knows the project's house rules and puts what it learned into your inbox for review.

### Why a coding agent plus SubKit

Your coding agent stays the tool for software: reading, changing and testing code.
Recurring business work needs more than a script: permissions, approvals, history, schedules and safely stored credentials. SubKit carries that.
To the agent, SubKit is a tool: it calls an approved workflow instead of holding credentials itself.
Every call goes through the same permission check as in the Cockpit and appears in the history.

Collected material always follows one path: **collect → review with your agent → confirm in the Cockpit → knowledge**.

### What you need

- The sk CLI, signed in to your engine. In the cloud, use `sk login --engine-url https://subkit-cloud.mikebild.dev` and **Sign in with work account**. The briefing uses this signed-in profile.
- The MCP address of your engine, `https://<your-engine>/mcp`. On SubKit Cloud it is `https://subkit-cloud.mikebild.dev/mcp`.
- Claude Code, Codex or Hermes.
- A repository where the briefings should appear.

### Set up the SubKit tools once per machine

1. In the Cockpit, open **API access** and create a key.
2. Store the key in `SK_API_KEY`.
3. Register SubKit in your client with the matching command.

Claude Code:

```bash
claude mcp add --transport http --scope user sk https://<your-engine>/mcp --header "Authorization: Bearer ${SK_API_KEY}"
```

Codex:

```bash
codex mcp add sk --url https://<your-engine>/mcp --bearer-token-env-var SK_API_KEY
```

A key without `mcp:authoring` lets the agent read and run workflows but build nothing. If it should draft workflows and connectors, create the key with `sk apikeys create --scopes …,mcp:authoring`.
To sign in without a key, see "Connect AI clients via MCP".

### Set up briefings in a repository

1. In the repository, declare the domains:

   ```bash
   sk agent init --domains <category>
   ```

   For several domains, separate them with commas: `--domains <category>[,<category>]`.
   The command writes `.sk/agent.json` and adds the SubKit hooks to `~/.claude/settings.json` and `~/.codex/hooks.json`. Other tools' hooks stay in place.
2. Commit `.sk/agent.json` so every checkout uses the same domains.
3. In Claude Code or Codex, run `/hooks` and check that the SubKit hooks are active.
4. Trust new or changed SubKit hooks.

### Set up Hermes by hand

For Hermes, `sk agent init` sets up no hooks. The command's output shows what you need under "Hermes (manual)".

1. In Hermes, register an MCP server over streamable HTTP with the address `https://<your-engine>/mcp`.
2. Pass the header `Authorization: Bearer ${SK_API_KEY}`.
3. At the start of a session, run `sk agent briefing` in the repository and hand the output to Hermes as context.

### Check the briefing

1. In the repository, run `sk status`.
2. Run `sk agent briefing --json`.
3. Check the fields `domains`, `knowledge_sources`, `skills_full` and `used_tokens`.

### Review collected material with your coding agent

Your agent can start a review of collected entries. You confirm the result in the Cockpit.

1. Ask your agent: "Review the new entries in Research. Which are useful? Propose what we should keep as knowledge."
2. Open the Cockpit link the agent returns. It leads to the item's **Review** tab.
3. Check the proposal's sources, exact text and knowledge destination.
4. Select **Confirm as source**.
5. Run `sk agent briefing --json` and check `knowledge_sources`.

A new session loads the updated briefing.

Good to know:

- Only a signed-in person with `intake:confirm` and `knowledge:write` confirms a proposal. An API key, an MCP client or the Web Clipper never does.
- The item's original stays linked to the knowledge it became.
- Moving, editing or discarding an entry never admits it as knowledge.

### Review collected material in the terminal

| Command | What it does |
| --- | --- |
| `sk intake list` | Shows collected items in your default category. |
| `sk intake list --category research` | Shows collected items of one category. |
| `sk intake review --category research` | Starts the review and prints the Cockpit link. |
| `sk intake review --items <comma-separated-ids>` | Reviews only particular entries. |
| `sk intake default --category research` | Changes your personal default category. |
| `sk intake move --item <id> --category research` | Moves an entry to a category. |
| `sk intake discard --item <id>` | Discards an entry. |
| `sk intake restore --item <id>` | Restores a discarded entry. |

- Without a selection, `review` uses your default category.
- `--json` returns machine-readable results.
- These actions preserve the item's original and never admit knowledge.

### How briefings work

**Domains.** A domain is a catalog category or a `domain:<slug>` tag.

- `sk agent init` adds the requested domains and removes nothing that exists.
- Without `.sk/agent.json`, the hooks match the folder name against your project categories. On a unique match they create `.sk/agent.json` for you. Otherwise they ask instead of guessing.
- To fix the domains yourself, edit `domains` in `.sk/agent.json` and remove `inferred` and `inferred_folder_domain`.
- A prompt can add other matching domains as the task changes.

**Hooks.** `init` sets up the SessionStart, UserPromptSubmit and SessionEnd hooks for Claude Code and Codex. `--skip-claude` and `--skip-codex` leave that client's settings untouched.

**Size.** A briefing has at most 1,800 tokens and 9,500 characters, shared by both clients and the interactive sk session.
Whatever does not fit is shortened, and you see a warning.

A briefing contains:

- Domain context and a short status, with blocked work and deadlines first.
- Up to three specific next steps in your language.
- Matching sources and workflows of the folder's domain, named when they help with a task.
- The number of collected pages and session learnings, never their content. With `intake:read`, also the workspace-wide number of collected entries and pending proposals.

**Session learnings.** At session end, Claude Code and Codex send the transcript to the engine.

- The engine keeps only practices and facts a person taught or confirmed.
- It drops events, status updates and anything credential-related.
- The rest lands in the Inbox with origin `session`, in the project's shared category or your default category. A repeated learning adds evidence to the existing entry.
- Learnings are not knowledge and not skills until a person confirms them in the Cockpit. `sk intake list` shows what is waiting.

**Reviews with an agent.** The review runs in a saved SubKit conversation.

- MCP clients start it with `conversation_start`. `intake_item_ids` selects particular items and keeps that selection fixed.
- Tools that read entries or prepare proposals work only inside this conversation.
- For a new destination, include the topic category or `domain:<slug>` tag in the proposal. A changed proposal must be reviewed again.

### If something does not work

| What you see | What to do |
| --- | --- |
| `sk agent briefing: no domains …` | There is no declaration. Pass `--domains` or run `sk agent init --domains <category>`. |
| `knowledge_sources` or `skills_full` are empty | The briefing works but nothing is assigned to the domain. Put knowledge and skills in the domain's category or use the `domain:<slug>` tag. |
| The client shows a briefing warning | The engine cannot be reached. The session continues. Check sign-in and connection with `sk status`. |
| No briefings in Claude Code or Codex | Open `/hooks`, check that the SubKit hooks are active, and trust new or changed hooks. |
| `/hooks` in Codex shows the SubKit hooks as disabled | Codex hooks are on by default, so no `config.toml` edit is normally needed. Check the effective feature setting and your administrator policy first, then follow the [Codex hooks guide](https://learn.chatgpt.com/docs/hooks). |
| The agent cannot draft anything | Its key has no `mcp:authoring`. Create a new key with that scope. |
| The reminder about collected entries is missing | You lack the `intake:read` permission. Ask an administrator for it. |
| A proposal cannot be confirmed | Only a signed-in person with `intake:confirm` and `knowledge:write` can confirm, not an API key. Open the Cockpit link. |
