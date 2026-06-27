# Quickstart — Authors

Turn a plain-language request into a governed, audited, runnable workflow — in about 5 minutes, no code. You describe the outcome; sk builds the connector, drafts the workflow, and holds the writes until you approve.

![sk REPL](../_tapes/out/repl-author.gif)

## Your first conversation

```mermaid
sequenceDiagram
    actor You
    participant sk
    You->>sk: Describe the outcome in plain language
    sk-->>You: Proposes a workflow (connector + steps)
    You->>sk: /preview
    sk-->>You: Dry-run result, no writes
    You->>sk: /approve
    sk-->>You: Commits a versioned workflow
    You->>sk: Run it
    sk-->>You: Audited execution + result
```

Every step is permission-checked and recorded. Nothing writes to a real system until you approve.

## Connect

Your operator has given you **one** of the following. Pick the matching path.

- **Engine URL + API key** — you operate a tenant directly → Path A.
- **Portal-token link** — you are a scoped end-user → Path B.
- **Slack / Teams / Google Chat** where the sk bot is installed → Path C.
- **An MCP client** (Claude Desktop, Cursor, …) → Path D.

> **Want to run your own engine first?** [Self-host quickstart](../developers/self-host.md) takes you from the Docker image to a first connector and workflow.

## Path A — CLI with API key

```bash
curl -fsSL https://raw.githubusercontent.com/mikebild/subkit/main/scripts/install.sh | bash
sk login --engine-url <URL> --api-key <wf_live_…>
sk                         # opens the TUI, picks up your session
```

## Path B — CLI with portal token

Portal tokens are time-limited and pre-scoped. Click the link your operator sent; it provisions a session for `sk` automatically.

```bash
sk login --portal-token <token>      # token is time-limited and pre-scoped; reusable until it expires or is revoked
sk
```

## Path C — Chat (Slack / Teams / Google Chat)

Nothing to install. In the workspace your operator set up:

- **Slack.** `@sk run <workflow>` or just `@sk …` to start a conversation.
- **Teams.** Same pattern — `@sk …` in a channel or DM.
- **Google Chat.** Invite the bot to a space; mention it.

See [input surfaces](../developers/input-surfaces.md) for how each chat adapter works.

## Path D — MCP client (Claude Desktop, Cursor, etc.)

Add the engine as a streamable-HTTP MCP server:

```json
{
  "mcpServers": {
    "sk": {
      "url": "https://<engine-host>/mcp",
      "transport": "streamable-http",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
```

Your client discovers workflows, prompts, and resources automatically. See [input surfaces](../developers/input-surfaces.md) for MCP details.

## Troubleshooting

Any failed request prints `{code}: {message} [trace=…]`. Send the `trace_id` to your operator — they correlate it with `sk diagnostics errors --trace-id <trace_id>`.

## Next steps

- [input surfaces](../developers/input-surfaces.md) — every surface: CLI, REST, MCP, chat, webhooks, schedules.
- [authoring workflows](./authoring-workflows.md) — what Conversations can do: proposing workflows, Skills, Knowledge Sources, Discovery, and the approval gate.
- [REPL tour](./repl-tour.md) — the authoring state machine and slash commands end to end.
