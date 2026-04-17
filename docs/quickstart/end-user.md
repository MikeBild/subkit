# Quickstart — End-user

You use subkit through `sk` (conversational CLI), Slack/Teams/Google Chat,
or an MCP-speaking client. Goal: authenticated and holding your first
conversation. 5 minutes.

Your operator has already set up the engine and should have given you
**one** of the following:

- An **engine URL + API key** (you are a direct operator of a tenant).
- A **portal-token link** (you are a scoped end-user — typical for
  customer-facing flows).
- A **Slack/Teams/Google Chat workspace** where the subkit bot is already
  installed.

## Path A — CLI with API key

```bash
curl -fsSL https://raw.githubusercontent.com/mikebild/subkit/main/scripts/install.sh | bash
sk login --engine-url <URL> --api-key <wf_live_…>
sk                         # opens the TUI, picks up your session
```

## Path B — CLI with portal token

Portal tokens are time-limited and pre-scoped. Click the link your
operator sent; it provisions a session for `sk` automatically:

```bash
sk login --portal-token <token>      # one-off; token is single-use
sk
```

## Path C — Chat (Slack / Teams / Google Chat)

Nothing to install. In the workspace your operator set up:

- **Slack.** `@subkit run <workflow>` or just `@subkit …` to start a
  conversation. See [`14-chat-platforms.md`](../14-chat-platforms.md).
- **Teams.** Same pattern — `@subkit …` in a channel or DM.
- **Google Chat.** Invite the bot to a space; mention it.

## Path D — MCP client (Claude Desktop, Cursor, etc.)

Add the engine as a streamable-HTTP MCP server:

```json
{
  "mcpServers": {
    "subkit": {
      "url": "https://<engine-host>/mcp",
      "transport": "streamable-http",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
```

Your client will discover workflows, prompts, and resources automatically.
See [`12-mcp-server.md`](../12-mcp-server.md).

## Troubleshooting

Any failed request prints `{code}: {message} [trace=…]`. Send the
`trace_id` to your operator — they can look it up in the audit log
(`subkit audit-log get <trace_id>`).

Next: [`27-sk-cli.md`](../27-sk-cli.md) for every `sk` command,
[`17-conversations.md`](../17-conversations.md) for what conversations
can do.
