---
slug: sk-ref-coding-agents
name: sk Platform Reference — Coding Agents
description: How a person connects Claude Code, Codex, Hermes or another MCP client to sk, what the session briefing is and how knowledge reaches it, how an agent runs workflows and looks things up under the person's own rights, how learnings flow back, and what to check when a briefing does not arrive.
tags: [sk-platform-reference, coding-agents, claude-code, codex, hermes, mcp, hooks, briefing, onboarding]
scope: global
version: 1
---

# Coding agents and sk

A coding agent (Claude Code, Codex, Hermes, Cursor, a browser AI client) uses sk in two ways: as an **MCP server**, so every approved workflow, connector, knowledge source and skill is a tool the agent can call, and through **session hooks**, so each session starts with a short briefing of the domains a repository works in. Both are set up once per machine and once per repository. The agent never gets more rights than the person whose key it uses.

# One-time setup on a machine

1. Install the CLI the engine serves and sign in. The CLI needs an engine URL and either a browser sign-in or an API key.
   ```bash
   curl -fsSL https://<engine-host>/install | bash
   sk login --engine-url https://<engine-host>            # browser sign-in
   sk login --engine-url https://<engine-host> --api-key <key>
   ```
2. Create a key for the agent. A key is its own identity with its own rights; a key that may only read and run cannot author or change anything from inside an agent. The key is shown once.
   ```bash
   sk apikeys create
   export SK_API_KEY=<key>
   ```
3. Register sk as an MCP server in the client (once per machine). Local clients start `sk mcp`, which forwards calls to the engine; browser clients connect to `https://<engine-host>/mcp` directly and sign in with SSO or the key.
   ```bash
   claude mcp add --transport http --scope user sk https://<engine-host>/mcp --header "Authorization: Bearer ${SK_API_KEY}"
   codex mcp add sk --url https://<engine-host>/mcp --bearer-token-env-var SK_API_KEY
   ```
   Other clients take the stdio form: command `sk`, args `["mcp"]`, env `SK_ENGINE_URL` and `SK_API_KEY`.

# Once per repository: declare the domains

A **domain** is a catalog category (the same vocabulary workflows, connectors, knowledge sources, skills and files share) or a `domain:<slug>` tag. Declaring a domain in a repository tells the hooks what to brief.

```bash
cd <repository>
sk agent init --domains <category>[,<category>]   # e.g. rechnungswesen or blog-de
```

What `init` does:

- writes `.sk/agent.json` (`{"domains":[...],"budget_tokens":4000}` when `--budget` is given); commit it so every checkout is briefed;
- wires Claude Code in `~/.claude/settings.json`: SessionStart (startup, resume, clear, compact) and UserPromptSubmit run `sk agent briefing --hook`, SessionEnd runs `sk agent capture --hook`;
- wires Codex in `~/.codex/hooks.json`: SessionStart and UserPromptSubmit run `sk agent briefing --hook` with `additionalContextLimit: 0`, so Codex hands the whole briefing to the model instead of spilling it to a file; no capture, because Codex's Stop hook fires after every turn;
- prints what stays manual: Codex needs `[features] hooks = true` in `~/.codex/config.toml` and the hooks must be trusted once under `/hooks` inside `codex`; Hermes has no hooks and gets the briefing by running `sk agent briefing` in the repository.

`--skip-claude` and `--skip-codex` leave the respective file untouched. Running `init` again changes nothing that is already wired. Outside a repository with `.sk/agent.json` the hooks stay silent and never fail a session.

# What a briefing is

`sk agent briefing` prints one markdown block per set of domains, built from the tenant catalog, no model involved:

- a grounding rule: look facts up with `search_knowledge` and the domain tags instead of guessing, and say when nothing is found;
- **Conventions**: the full text of every active skill in the domain;
- **Knowledge index**: name, slug and description of every knowledge source in the domain (content stays searchable, never inlined);
- **Workflows** to run with `run_workflow` instead of rebuilding them, and **Connectors** of the domain;
- **Working with sk**: pointers to the guides for finding and running workflows, finding and maintaining knowledge, and what to do when something is stuck;
- a reminder when learnings wait for review.

The default budget is 4,000 tokens (500 to 16,000). When the budget is tight the briefing trims connectors first, then workflows, then the knowledge index, then skill bodies; header, grounding rule and guides are never trimmed. On UserPromptSubmit the hook briefs only domains the prompt names that the session has not seen yet; a prompt names a domain when every part of its slug appears as a word.

# Getting knowledge into a briefing

Put the knowledge source or skill into the domain's category, or tag it `domain:<slug>`. Skills whose body belongs in every coding session of that domain are its conventions; chat-only skills stay out of the briefing by keeping another category and no domain tag.

```bash
sk knowledge-sources create --file rules.md --name "House rules" --category <category>
sk skills create --file skill.json                          # category <category> or tags ["domain:<category>"]
sk agent briefing --domains <category> --json | jq '{used_tokens, knowledge_sources, skills_full}'
```

# Daily use inside the agent

- Find and run: `find_workflow`, `run_workflow`, then `get_execution` or `inspect_execution_step` for a run that outlives the call. Anything that writes outward still asks for confirmation.
- Look up: `search_knowledge` with `tags: ["domain:<slug>"]`; `find_skill` and `get_skill` for the house rules.
- Connectors: `list_connectors`, `probe_connector`, `call_connector` under the key's rights.
- Authoring stays in the `sk` CLI or the cockpit, where a change is a file and a version a person can read before it runs.

# Learning loop

At the end of a Claude Code session the transcript goes to the engine; the engine keeps only rules a person explicitly taught or confirmed and files them as candidates. `sk learnings list` shows them, `sk learnings review` decides them one by one, `sk skill-candidates approve|reject <id>` scripts the decision. A fact becomes part of the domain's knowledge source `learnings-<domain>` (needs `knowledge:write`); a practice becomes a draft skill that joins briefings once activated. Inside a chat, `save_learning` files the same candidates.

# When no briefing arrives

- No `.sk/agent.json` up the directory tree: hooks are silent by design. Run `sk agent init`.
- The profile has no API key: hooks make no request. `sk status` shows the profile; `sk login --api-key` or `SK_API_KEY` fixes it.
- `sk` is not on the PATH of a client started from the desktop: put the absolute path into the hook commands.
- Codex skips edited hooks until they are trusted under `/hooks`, and runs no hooks at all without `[features] hooks = true`.
- Codex shows only a head-and-tail preview: the hook lacks `additionalContextLimit: 0`; `sk agent init` sets it.
- Nothing listed under Knowledge index or Conventions: the sources and skills are in another category and carry no `domain:` tag.
- Every hook request gives up after four seconds and logs to `~/.sk/debug.log` as `agent.briefing_hook_failed` or `agent.capture_hook_failed`.
