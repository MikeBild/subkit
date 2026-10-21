---
slug: sk-ref-coding-agents
name: sk Platform Reference — Coding Agents
description: How a person connects Claude Code, Codex, Hermes or another MCP client to sk, what the session briefing is and how knowledge reaches it, how an agent runs workflows and looks things up under the person's own rights, how learnings flow back, and what to check when a briefing does not arrive.
tags: [sk-platform-reference, coding-agents, claude-code, codex, hermes, mcp, hooks, briefing, onboarding]
scope: global
version: 2
generated: true
---

# Use sk from a coding agent

```bash
claude mcp add --transport http --scope user sk http://localhost:3000/mcp --header "Authorization: Bearer ${SK_API_KEY}"
codex mcp add sk --url http://localhost:3000/mcp --bearer-token-env-var SK_API_KEY
sk agent init --domains <category>   # in a repository: briefs each Claude Code and Codex session on that domain
```

Use MCP for approved sk tools; run `sk agent init` to declare repository domains and install the Claude Code and Codex hooks that supply shared-memory briefings. Hooks can resolve a current folder name to known domains when no explicit declaration exists. Both use the same authenticated sk profile as the CLI.

### Set up and verify briefings

MCP registration is a one-time machine setup. In each repository, run `sk agent init --domains <category>[,<category>]` and commit `.sk/agent.json` so every checkout uses the same domains. A domain can be a catalog category or a `domain:<slug>` tag. `init` merges requested domains without removing existing domains or settings, and wires Claude Code and Codex SessionStart, UserPromptSubmit and SessionEnd hooks. Codex transcript capture runs asynchronously to fit its three-second hook limit. Both clients and the sk REPL share an 1,800-token briefing budget and 9,500-character hard limit. `--skip-claude` and `--skip-codex` leave that client's settings untouched.

Run `sk status`, then `sk agent briefing --json` from the repository to verify the declaration, credentials, engine connection and returned briefing. Use the JSON fields `domains`, `knowledge_sources`, `skills_full` and `used_tokens` to inspect the result. Empty `knowledge_sources` or `skills_full` means the briefing works but those items are not assigned to the declared domain. Put knowledge and skills in the domain's catalog category or tag them `domain:<slug>`.

Hooks first read `.sk/agent.json` when present. Otherwise, they match the current folder's normalized name exactly against readable project categories. A unique match creates `.sk/agent.json` with that project area and shared SubKit context when available. When no unique project area matches but shared SubKit context is available, the hook creates a shared-only declaration and asks which project knowledge sources and workflows belong there when setup is relevant. If neither is available, it asks before guessing or creating a declaration. Hook-created declarations stay marked as inferred, so later sessions continue checking the folder name as the readable catalog changes. Treat `inferred` and `inferred_folder_domain` as hook-managed fields. To make an inferred declaration explicit and maintain it yourself, remove both fields and edit `domains`; legacy inferred declarations are migrated by treating the first non-`subkit` domain as the inferred folder domain. A prompt can add other matching domains as the task changes. This works with or without Git metadata. The briefing tells the agent which declaration it created. Each successful briefing gives the model bounded domain context and shows a short, language-neutral status; oversized context is shortened with a visible warning. The model can offer relevant reviews in the language of your conversation. The briefing only counts collected clips and session learnings in the project's categories and never includes their content. If the briefing is unavailable, the client shows a simple warning and continues the session. Use `/hooks` in Claude Code or Codex to see whether hooks are active. Codex hooks are enabled by default; no `config.toml` edit is normally needed. Review and trust new or changed SubKit hooks in `/hooks`. If hooks are disabled, inspect the effective feature setting and administrator policy before changing settings; see the [official Codex hook guide](https://learn.chatgpt.com/docs/hooks). Both clients send a transcript at SessionEnd. Codex capture runs in a detached process because its hook deadline is three seconds. The engine keeps only practices and facts a person taught or confirmed, drops events, status updates and anything credential-related, and collects the rest in Intake with origin `session`, in the project's shared category or your default category. The same learning from a later session adds evidence to the existing item instead of a duplicate. Collected learnings are not knowledge and not skills until a person confirms a proposal in the Cockpit; `sk intake list` shows what is waiting.

For open-ended check-ins, the briefing uses the current project's matched domain together with shared SubKit context, plus connected sources that best answer the question. It distinguishes live service state from repository changes and static knowledge, prioritizes blocked or failing work and imminent deadlines, and gives up to three specific next steps in the user's language. Maintenance suggestions must be grounded in repository instructions, explicit plans or TODOs, and observed issues such as failing checks or generated-file drift. Relevant knowledge sources and workflows from the folder's domain are recommended by name when they help with a concrete task. It reports when a relevant source is unavailable.

### Review collected material with your coding agent

Collected pages remain material to review. With `intake:read`, the briefing adds
a short tenant-wide count of collected entries and pending knowledge proposals.
It does not load their text, treat them as instructions, or claim they belong to
the repository's domain. Without that permission the reminder is omitted.

Ask: "Review the new entries in Research. Which are useful? Propose what we should
keep as knowledge." Review uses a saved SubKit conversation. MCP clients start
it through `conversation_start`; `intake_item_ids` selects particular clips and
keeps that selection fixed. The returned Cockpit link continues the same review.
Item-reading and proposal tools need this saved conversation and cannot run as
standalone MCP calls. The clipper's API key needs only intake read/write;
the person confirming a proposal needs `intake:confirm` and `knowledge:write`.

From the terminal, `sk intake list` shows collected items in your default category. Use
`sk intake list --category research` to see collected items and
`sk intake review --category research` to start their review. Without a
selection, review uses your default category. `--items <comma-separated-ids>`
selects particular entries; `--json` returns machine-readable results. The command
prints the Cockpit link for continuing the conversation and reviewing proposals.
Use `sk intake default --category research` to change your personal default,
`sk intake move --item <id> --category research` to organize an entry, and
`sk intake discard --item <id>` or `sk intake restore --item <id>` to change its
review state. These actions preserve the original clip and never admit knowledge.

The proposal shows its sources, exact text and knowledge destination. An existing
destination keeps its topic assignment. For a new destination, include the topic
category or `domain:<slug>` tag in the reviewed proposal so the resulting knowledge
can appear in the intended repository briefing. Changing that assignment requires
reviewing the changed proposal. After confirmation, run `sk agent briefing --json`
to check `knowledge_sources`, then search for the accepted material. The original
clip remains linked. A new session loads the updated briefing.

### Verify an installed intake API

During intake development, `bun run verify:intake` runs the focused type,
domain, HTTP, briefing, MCP, and CLI checks, including a real local
PostgreSQL/API smoke flow. It avoids the repository-wide test suite. Use browser-use
with Codex or Claude Code for browser journeys; visual acceptance is performed manually.

`bun run verify:intake-live` checks a selected server through its public API.
Set `SK_ENGINE_URL` and `SK_INTAKE_TEST_KEY` outside the repository. The default
run is read-only and reports compatibility, readiness and the delivered archive.
It is separate from the local `bun run verify` gate.

For a synthetic write check, use a dedicated test tenant and its user key:
add `--allow-writes --test-tenant-id <uuid> --run-id <unique-run-name>
--json <report-path>`. The tenant must match the authenticated identity. The
check collects in its own category, tests exclusion before confirmation and the
exact proposal, and verifies that the API key cannot confirm it. The report's
`handoff.review_url` opens the proposal in the Cockpit, where a person of that
tenant confirms it. Then run the same command with `--after-confirm --proposal-id <id>`
to check the single admission, provenance, search and the domain briefing.
It reports timings and retained resource IDs. Intake has no deletion API, so
test records remain for inspection. This API check does not measure model
judgment or replace a real browser/chat verification. It never deploys code.
