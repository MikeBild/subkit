---
slug: use-sk-from-a-coding-agent
summary: Give a coding agent SubKit tools and shared-memory briefings for your repository.
section: work
order: 3
audience: public
seed: sk-ref-coding-agents
seed_version: 2
---
## Use SubKit from a coding agent

MCP gives your coding agent the approved SubKit tools.
`sk agent init` gives every Claude Code and Codex session a shared-memory briefing for your repository.
Collected material follows one path: **collect → review with your agent → confirm in the Cockpit → knowledge**.

### What you need

- The sk CLI, signed in to your engine. In the cloud, use `sk login --engine-url https://subkit-cloud.mikebild.info` and **Sign in with work account**. The briefing uses this signed-in profile.
- The MCP address of your engine, `https://<your-engine>/mcp`. On SubKit Cloud it is `https://subkit-cloud.mikebild.info/mcp`.
- Claude Code, Codex or both.
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

To sign in without a key, see "Connect AI clients via MCP".

### Set up briefings in a repository

1. In the repository, declare the domains:

   ```bash
   sk agent init --domains <category>
   ```

   For several domains, separate them with commas: `--domains <category>[,<category>]`.
2. Commit `.sk/agent.json` so every checkout uses the same domains.
3. In Claude Code or Codex, run `/hooks` and check that the SubKit hooks are active.
4. Trust new or changed SubKit hooks.

### Check the briefing

1. In the repository, run `sk status`.
2. Run `sk agent briefing --json`.
3. Check the fields `domains`, `knowledge_sources`, `skills_full` and `used_tokens`.

### Review collected material with your coding agent

Your agent can start a review of collected entries. You confirm the result in the Cockpit.

1. Ask your agent: "Review the new entries in Research. Which are useful? Propose what we should keep as knowledge."
2. Open the Cockpit link the agent returns.
3. Check the proposal's sources, exact text and knowledge destination.
4. Select **Confirm as knowledge**.
5. Run `sk agent briefing --json` and check `knowledge_sources`.

A new session loads the updated briefing.

Good to know:

- Only a signed-in person with `intake:confirm` and `knowledge:write` confirms a proposal. An API key, an MCP client or the Web Clipper never does.
- The Web Clipper key uses the **Web Clipper** preset (`intake:read` and `intake:write`).
- The original clip stays linked to the knowledge it became.
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
- These actions preserve the original clip and never admit knowledge.

### How briefings work

**Domains.** A domain is a catalog category or a `domain:<slug>` tag.

- `sk agent init` adds the requested domains and removes nothing that exists.
- Without `.sk/agent.json`, the hooks match the folder name against your project categories. On a unique match they create `.sk/agent.json` for you. Otherwise they ask before guessing.
- To fix the domains yourself, edit `domains` in `.sk/agent.json` and remove `inferred` and `inferred_folder_domain`.
- A prompt can add other matching domains as the task changes.

**Hooks.** `init` sets up the SessionStart, UserPromptSubmit and SessionEnd hooks for Claude Code and Codex. `--skip-claude` and `--skip-codex` leave that client's settings untouched.

**Contents.** Budget: 1,800 tokens, at most 9,500 characters, shared by both clients and the sk REPL.
Oversized context is shortened with a visible warning.

A briefing contains:

- Domain context and a short status, with blocked work and deadlines first.
- Up to three specific next steps in your language.
- Relevant knowledge sources and workflows of the folder's domain, named when they help with a task.
- A count of collected clips and session learnings, never their content. With `intake:read`, also a workspace-wide count of collected entries and pending proposals.

**Session learnings.** At session end, both clients send the transcript.

- The engine keeps only practices and facts a person taught or confirmed.
- The engine drops events, status updates and anything credential-related.
- The rest lands in the Inbox with origin `session`, in the project's shared category or your default category. A repeated learning adds evidence to the existing entry.
- Learnings are not knowledge and not skills until a person confirms them in the Cockpit. `sk intake list` shows what is waiting.

**Reviews with an agent.** The review runs in a saved SubKit conversation.

- MCP clients start it with `conversation_start`. `intake_item_ids` selects particular clips and keeps that selection fixed.
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
| The reminder about collected entries is missing | You lack the `intake:read` permission. Ask an administrator for it. |
| A proposal cannot be confirmed | Only a signed-in person with `intake:confirm` and `knowledge:write` can confirm, not an API key. Open the Cockpit link. |
