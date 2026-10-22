---
slug: mcp-clients
summary: Connect an AI client via MCP so it can find and run your workflows.
order: 2
section: work
audience: public
---
## Connect AI clients via MCP

Connect an AI client such as Claude, ChatGPT, Cursor or Codex to SubKit over MCP.
The client can then find and run your workflows.
Every call is checked against your permissions and recorded in the audit log.

### What you need

- The MCP address of your engine. Every engine has exactly one:

  ```text
  https://<your-engine>/mcp
  ```

  On SubKit Cloud it is `https://subkit-cloud.mikebild.info/mcp`, always without `/cockpit`.
  Your own engine needs HTTPS. Plain HTTP works only on `localhost`.
- An account in a workspace whose role allows MCP access. Without it, the sign-in ends with `access_denied`.
- An AI client that supports remote MCP servers over HTTP.

### Choose how to sign in

| Way | When | What you do |
| --- | --- | --- |
| **Browser sign-in (OAuth)** | SubKit Cloud and engines with an identity provider | Enter the address. The client opens your browser. In the cloud, select **Sign in with work account** there. |
| **API key** | Clients that use a key, and engines without an identity provider | Enter a key in the client as a bearer token. |

Prefer browser sign-in. You copy no secret, and the access renews itself.
An API key is a long-lived secret on your machine.

### Connect with browser sign-in

1. In your client, add a remote MCP server with the address `https://<your-engine>/mcp` and name it `sk`.
2. In the browser window the client opens, sign in as you do in the Cockpit.
3. On the page **Authorize access**, check which client wants access to which workspace.
4. Check the boxes for what the client may do. **Read** is always on.
5. Select **Approve**. The browser returns to your client.

Where you add the server depends on the client:

- **claude.ai:** the settings for connectors. Add a custom connector with the address.
- **Claude Code:**

  ```bash
  claude mcp add --transport http --scope user sk https://<your-engine>/mcp
  ```

  Then run `/mcp` in Claude Code and choose `sk` to sign in.
- **ChatGPT and Cursor:** the client's MCP or connector settings.

Menu names change between client versions. If a step looks different, follow your client's guide for remote MCP servers.

### Connect with an API key

1. In the Cockpit, open **API access** and create a key. The **Run** preset fits most clients.
2. Store the key in an environment variable, not in a file you share:

   ```bash
   export SK_API_KEY=<your-key>
   ```

3. Register the server in your client with the matching command.

Claude Code:

```bash
claude mcp add --transport http --scope user sk https://<your-engine>/mcp --header "Authorization: Bearer ${SK_API_KEY}"
```

Codex:

```bash
codex mcp add sk --url https://<your-engine>/mcp --bearer-token-env-var SK_API_KEY
```

Other clients send the header `Authorization: Bearer <your-key>` with every request.

A key without an MCP mode marker connects in **Read** mode.
For authoring, add `mcp:authoring` to `--scopes` when you create the key with `sk apikeys create`.

### Check the connection

1. Check that the engine answers:

   ```bash
   curl https://<your-engine>/.well-known/oauth-protected-resource
   ```

   The answer names the MCP address and the scopes it offers:

   ```json
   {
     "resource": "https://<your-engine>/mcp",
     "authorization_servers": ["https://<your-engine>"],
     "scopes_supported": ["mcp:read", "mcp:authoring", "mcp:admin", "metrics:read"]
   }
   ```

2. In your client, ask: "Call the sk tool whoami." The answer names your account, your workspace and your scopes.
3. Ask: "Find a workflow in sk." The client calls `find_workflow` and lists what it finds.

If all three work, the client is connected.

### What the client may do

The scope decides which tools the client sees. It never widens your permissions; your role still limits every call.

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

- **Reads** run right away. Examples: `find_workflow`, `get_execution`, `search_knowledge`.
- **Runs** start a saved workflow, for example with `run_workflow` or a `wf_<slug>` tool.
  A short run answers right away. A long run answers with an `execution_id`, which the client follows with `get_execution`.
- **Writes** change something: send an email, change data, change the workspace.

Writes always need a person. There are two checks:

- **Writes inside a workflow:** A workflow writes for real only after a person approves it in the Cockpit. The approval covers the exact version, its targets and its limits.
  Without approval, the run is a preview: writes are held and nothing is sent.
- **Write tools in the client:** A write tool can pause and return an approval link.
  Open the link, sign in, check what will happen, and select **Approve** or **Decline**.
  Only after your approval can the client finish the call with `confirm_tool_call`.

The AI cannot approve anything itself. The link alone is not an approval either.

### If something does not work

| What you see | What to do |
| --- | --- |
| `401` with `missing_or_invalid_credentials` | Sign in again, or check the key and the `Authorization` header. |
| Sign-in ends with `access_denied` | Your role has no MCP permission. Ask an administrator for a role with MCP access. |
| `403` "Forbidden: invalid Origin header" | The request came from a foreign web page. Connect from the client, not from a web page, and use the engine's own address. |
| `403` `product_caller_forbidden` | The token belongs to an app user and has no MCP access. Use a person's sign-in or key. |
| `400` "Unsupported protocol version" | The client speaks an MCP version the engine does not know. Update the client. |
| `404` "Session not found" | The session expired, for example after an engine restart. Reconnect the server in the client. |
| Authoring tools are missing | The access has no `mcp:authoring`. Sign in again and check **Authoring**, or author with the sk CLI. |
| New tools are missing after an update | claude.ai keeps its old tool list. Remove the connector and add it again. |
