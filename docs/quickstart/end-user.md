# Quickstart — End-user

You use sk through `sk` (conversational CLI), Slack/Teams/Google Chat, or an MCP-speaking client. Goal: authenticated and holding your first conversation. 5 minutes.

> **Want to run your own engine first?** The [zero-to-running quickstart](./zero-to-running.md) takes a complete beginner from the Docker image to a first connector, workflow, and knowledge article.

Your operator has already set up the engine and should have given you **one** of the following:

- An **engine URL + API key** (you are a direct operator of a tenant).
- A **portal-token link** (you are a scoped end-user — typical for customer-facing flows).
- A **Slack/Teams/Google Chat workspace** where the sk bot is already installed.

## Path A — CLI with API key

```bash
curl -fsSL https://raw.githubusercontent.com/mikebild/subkit/main/scripts/install.sh | bash
sk login --engine-url <URL> --api-key <wf_live_…>
sk                         # opens the TUI, picks up your session
```

## Path B — CLI with portal token

Portal tokens are time-limited and pre-scoped. Click the link your operator sent; it provisions a session for `sk` automatically:

```bash
sk login --portal-token <token>      # one-off; token is single-use
sk
```

## Path C — Chat (Slack / Teams / Google Chat)

Nothing to install. In the workspace your operator set up:

- **Slack.** `@sk run <workflow>` or just `@sk …` to start a conversation.
- **Teams.** Same pattern — `@sk …` in a channel or DM.
- **Google Chat.** Invite the bot to a space; mention it.

See [docs/input-surfaces.md](../input-surfaces.md) for how chat adapters work and what the platform can do through each surface.

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

Your client will discover workflows, prompts, and resources automatically. See [docs/input-surfaces.md](../input-surfaces.md) for the MCP surface details.

## Troubleshooting

Any failed request prints `{code}: {message} [trace=…]`. Send the `trace_id` to your operator — they can correlate it with `sk diagnostics errors --trace-id <trace_id>`.

## Next steps

- [docs/input-surfaces.md](../input-surfaces.md) — detailed explanations of every surface: CLI, REST, MCP, chat, webhooks, schedules.
- [docs/authoring.md](../authoring.md) — what Conversations can do: proposing workflows, Skills, Knowledge Sources, Discovery, and the approval gate.
