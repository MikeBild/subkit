---
slug: mcp-clients
summary: Connect an AI client via MCP so it can find and run your workflows.
order: 2
section: work
audience: public
---
## Connect AI clients via MCP

After this chapter, your AI client can find and run your SubKit workflows. Claude, ChatGPT,
Cursor and Codex talk to SubKit over the Model Context Protocol (MCP). Every call is checked
against your permissions and recorded in the audit log.

Every engine has exactly one MCP address:

```text
https://<your-engine>/mcp
```

On SubKit Cloud it is `https://subkit-cloud.mikebild.info/mcp`.

### What you need

- **An engine address.** SubKit Cloud, or your own engine with HTTPS.
  Plain HTTP works only on `localhost`.
- **An account in a workspace** whose role allows MCP access.
  Without it, the sign-in ends with `access_denied`.
- **An AI client** that supports remote MCP servers over HTTP.

### Choose how to sign in

There are two ways. Pick one.

| Way | When | What you do |
| --- | --- | --- |
| **Browser sign-in (OAuth)** | SubKit Cloud and engines with a sign-in provider | Enter the address. The client opens your browser. |
| **API key** | Self-hosted engines without an identity provider | Copy a key into the client as a bearer token. |

Prefer browser sign-in. You copy no secret, and the access renews itself.
An API key is a long-lived secret on your machine.

### Connect with browser sign-in

1. In your client, add a remote MCP server with the address `https://<your-engine>/mcp`.
   Name it `sk`.
2. The client opens your browser. Sign in as you do in the Cockpit.
3. The page **Authorize access** shows which client wants access to which workspace.
4. Check the boxes for what the client may do (see "What the client may do" below).
   **Read** is always on.
5. Click **Approve**. The browser returns to your client.

Where you add the server depends on the client:

- **claude.ai:** the settings for connectors. Add a custom connector with the address.
- **Claude Code:**

  ```bash
  claude mcp add --transport http --scope user sk https://<your-engine>/mcp
  ```

  Then run `/mcp` in Claude Code and choose `sk` to sign in.
- **ChatGPT and Cursor:** the client's MCP or connector settings.

Menu names change between client versions. They are not verified here.
If a step looks different, follow your client's guide for remote MCP servers.

### Connect with an API key

Use this only on a self-hosted engine without an identity provider.

1. In the Cockpit, open **API access** and create a key.
   The **Run** preset fits most clients.
2. Store the key in an environment variable. Do not paste it into a file you share.

   ```bash
   export SK_API_KEY=<your-key>
   ```

3. Register the server.

   Claude Code:

   ```bash
   claude mcp add --transport http --scope user sk https://<your-engine>/mcp --header "Authorization: Bearer ${SK_API_KEY}"
   ```

   Codex:

   ```bash
   codex mcp add sk --url https://<your-engine>/mcp --bearer-token-env-var SK_API_KEY
   ```

   Other clients: send the header `Authorization: Bearer <your-key>` with every request.

A key without an MCP mode marker connects in **Read** mode.
How keys carry `mcp:authoring` or `mcp:admin` is described in the chapter "Engine operator".

### Check

1. Check that the engine answers. It names its MCP address and the scopes it offers:

   ```bash
   curl https://<your-engine>/.well-known/oauth-protected-resource
   ```

   ```json
   {
     "resource": "https://<your-engine>/mcp",
     "authorization_servers": ["https://<your-engine>"],
     "scopes_supported": ["mcp:read", "mcp:authoring", "mcp:admin", "metrics:read"]
   }
   ```

2. In your client, ask: "Call the sk tool whoami."
   The answer names your account, your workspace and your scopes.
3. Ask: "Find a workflow in sk." The client calls `find_workflow` and lists what it finds.

If all three work, the client is connected.

### What the client may do

The scope decides which tools the client sees. It never widens your permissions.
Your role still limits every call.

| On the consent page | Scope | The client can |
| --- | --- | --- |
| **Read** | `mcp:read` | Read workflows, runs, connectors and knowledge, and run saved workflows. |
| **Authoring** | `mcp:authoring` | Additionally build workflows and connectors in a guided conversation. |
| **Administration** | `mcp:admin` | Additionally create, change and delete things in the workspace. |
| **Operational counters** | `metrics:read` | Read the operational counters, nothing else. |

- The consent page offers only what your role allows.
- A key with `*` does not include authoring. Authoring needs `mcp:authoring` on purpose.
- An engine set to `mcp.read_only` hides all write tools, even with `mcp:admin`.

### Reads, runs and writes

SubKit separates three kinds of effects.

- **Reads** run right away. Example: `find_workflow`, `get_execution`, `search_knowledge`.
- **Runs** start a saved workflow, for example with `run_workflow` or a `wf_<slug>` tool.
  A short run answers right away. A long run answers with an `execution_id`.
  The client follows it with `get_execution`.
- **Writes** change something: send an email, change data, change the workspace.

Writes always need a person. There are two checks:

1. **Writes inside a workflow.** A workflow only writes for real after a person approved it
   in the Cockpit: the exact version, its targets and its limits. Without that approval,
   the run is a preview. Writes are held, and nothing is sent.
2. **Write tools in the client.** A write tool can pause and return an approval link.
   Open the link, sign in and check what will happen. Then choose **approve** or **decline**.
   Only after your approval can the client finish the call with `confirm_tool_call`.

The AI cannot approve anything itself. The link alone is not an approval either.

### Troubleshooting

| What you see | Cause | What to do |
| --- | --- | --- |
| `401` with `missing_or_invalid_credentials` | No or invalid sign-in. | Sign in again, or check the key and the `Authorization` header. |
| Sign-in ends with `access_denied` | Your role has no MCP permission. | Ask an administrator for a role with MCP access. |
| `403` "Forbidden: invalid Origin header" | The request came from a foreign web page. | Use the engine's own address. Connect from the client, not from a web page. |
| `403` `product_caller_forbidden` | The token belongs to an app user. | App tokens have no MCP access. Use a person's sign-in or key. |
| `400` "Unsupported protocol version" | The client speaks an MCP version the engine does not know. | Update the client. |
| `404` "Session not found" | The session expired, for example after an engine restart. | Reconnect the server in the client. |
| Authoring tools are missing | The access has no `mcp:authoring`. | Sign in again and check **Authoring**, or author with the sk CLI. |
| New tools are missing after an update | claude.ai keeps its old tool list. | Remove the connector and add it again. |

### Next

- "Use sk from a coding agent": brief Claude Code and Codex on your repository.
- "Use the sk CLI on your machine": author workflows as files you can review.
