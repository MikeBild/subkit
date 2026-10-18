---
slug: sk-ref-coding-agents
name: sk Platform Reference — Coding Agents
description: How a person connects Claude Code, Codex, Hermes or another MCP client to sk, what the session briefing is and how knowledge reaches it, how an agent runs workflows and looks things up under the person's own rights, how learnings flow back, and what to check when a briefing does not arrive.
tags: [sk-platform-reference, coding-agents, claude-code, codex, hermes, mcp, hooks, briefing, onboarding]
scope: global
version: 2
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

- merges the requested domains into `.sk/agent.json`, preserving its other settings and existing domains; `--budget` sets the budget when given; commit the file so every checkout is briefed;
- wires Claude Code in `~/.claude/settings.json`: SessionStart (startup, resume, clear, compact, fork) and UserPromptSubmit run `sk agent briefing --hook`, SessionEnd runs `sk agent capture --hook`;
- wires Codex in `~/.codex/hooks.json`: SessionStart and UserPromptSubmit run `sk agent briefing --hook` with `additionalContextLimit: 0`, so Codex hands the whole briefing to the model instead of spilling it to a file; SessionEnd queues transcript capture through a detached process within Codex's three-second hook limit;
- prints what stays manual: Codex needs `[features] hooks = true` in `~/.codex/config.toml` and the hooks must be trusted once under `/hooks` inside `codex`; Hermes has no hooks and gets the briefing by running `sk agent briefing` in the repository.

`--skip-claude` and `--skip-codex` leave the respective file untouched. Running `init` again reconciles SubKit's hook settings while preserving other tools' hooks, and adds the requested domains without deleting existing domains or settings from `.sk/agent.json`. To remove a domain, edit the file directly. Invalid local or global JSON is checked before any setup file is changed. When no `.sk/agent.json` exists, the hook matches the normalized current-folder name exactly against readable project categories. A unique match creates `.sk/agent.json` with that project domain and shared SubKit context when available. With no unique project match, it creates a shared-only declaration when shared SubKit context is available, then asks which project area, knowledge sources, and workflows belong there when setup is relevant. If neither is available, it asks before guessing or creating a declaration. Hook-created declarations stay marked as inferred, so later sessions keep checking the folder name as readable catalog categories change. Treat `inferred` and `inferred_folder_domain` as hook-managed fields; remove both to maintain `domains` explicitly. Legacy inferred declarations use their first non-`subkit` domain as the inferred folder domain during migration. This works with or without Git metadata. The briefing tells the agent which declaration it created. A successful hook gives the model the project domain context and shared platform context when available, and shows the person a short, language-neutral ready status. Hooks and the sk REPL use the same 1,800-token briefing budget and enforce a 9,500-character output limit so Claude Code receives useful context instead of an unread hook-output file. The model can offer relevant reviews in the language of the conversation. A failed fetch or invalid configuration shows a warning and lets the session continue.

# What a briefing is

`sk agent briefing` prints one markdown block per set of domains, built from the tenant catalog, no model involved:

- a grounding rule: look facts up with `search_knowledge` and the domain tags instead of guessing, and say when nothing is found;
- **Conventions**: the full text of every active skill in the domain;
- **Knowledge index**: name, slug and description of every knowledge source in the domain (content stays searchable, never inlined);
- **Workflows** to run with `run_workflow` instead of rebuilding them, and **Connectors** of the domain;
- **Working with sk**: pointers to the guides for finding and running workflows, finding and maintaining knowledge, and what to do when something is stuck;
- a reminder when learnings wait for review.

The default budget is 4,000 tokens (500 to 16,000). When the budget is tight the briefing trims connectors first, then file metadata, workflows, the knowledge index, and skill bodies; header, grounding rule and guides are never trimmed. On UserPromptSubmit, the hook keeps the folder's project and shared SubKit context in scope and adds any newly named matching domains; it avoids sending domains already loaded in that session again.

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

At the end of a Claude Code or Codex session the transcript goes to the engine; the engine keeps only practices and facts a person explicitly taught or confirmed, drops events, status updates and anything credential-related, and collects the rest in Intake with origin `session`, in the domain's shared category. Collected learnings are not knowledge and not skills: search, briefings and authoring ignore them, and the briefing only counts them. `sk intake list` shows them and `sk intake review` opens a review conversation; a person confirms each proposal in the Cockpit. A confirmed fact goes to the domain's knowledge bundle (tag `domain:<domain>`); a confirmed practice becomes an active skill that joins the briefing, and the skills it replaces are archived. Inside a chat, `save_learning` collects the same kind of item.

# When a briefing is missing or a warning appears

- No `.sk/agent.json`: a unique folder match creates an inferred declaration; otherwise shared SubKit context can still be loaded while the agent asks which project area belongs here. Use `sk agent init --domains <category>` when you want to declare project domains explicitly.
- Start the client in the relevant folder so the hook can match its name to a known domain. Git metadata is not required. If the hook creates `.sk/agent.json`, review and commit it with the project.
- Run `sk status`, then `sk agent briefing --json` in the repository to check credentials and the engine response. If the profile has no API key, use `sk login --api-key` or set `SK_API_KEY`.
- `sk` is not on the PATH of a client started from the desktop: put the absolute path into the hook commands.
- In either client, inspect `/hooks` to confirm briefing hooks are enabled and see hook errors. Codex also skips edited hooks until trusted and runs no hooks without `[features] hooks = true`.
- If a Codex briefing is missing its middle, check that the hook has `additionalContextLimit: 0`; `sk agent init` sets it. The shared hook output also stays below the clients' context limits.
- Nothing listed under Knowledge index or Conventions: the sources and skills are in another category and carry no `domain:` tag.
- Every hook request gives up after four seconds, displays a non-blocking warning, and logs detail to `~/.sk/debug.log` as `agent.briefing_hook_failed` or `agent.capture_hook_failed`.
