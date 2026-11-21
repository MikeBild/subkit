---
slug: mcp-clients
summary: Let an AI client such as Claude Code find and run your workflows.
order: 2
section: work
audience: public
---
## Connect AI clients via MCP

This chapter is for anyone who wants to use SubKit from an AI client such as Claude, ChatGPT, Cursor or Codex.
You register your engine there once as a server and sign in.
Afterwards the client finds and runs your workflows, with your permissions and with an entry in the history.

For Claude Code, Codex, Cursor and other AI clients, SubKit is an MCP server: every approved workflow is a tool there, plus connectors, knowledge and skills – with the permissions of the access, nothing beyond. Anything that writes waits for a person to choose "Allow once". The other way round, an MCP server you already use becomes a connector in SubKit; the operator decides per tool which of its tools run without asking.

### What you need

- The MCP address of your engine. Every engine has exactly one:

  ```text
  https://<your-engine>/mcp
  ```

  On SubKit Cloud it is `https://subkit-cloud.mikebild.dev/mcp`, always without `/cockpit`.
  Your own engine needs HTTPS. Plain HTTP works only on `localhost`.
- An account whose role allows MCP access. Without it, the sign-in ends with `access_denied`.
- An AI client that supports remote MCP servers over HTTP. If it can only start local servers, see "Connect with an API key".

### Choose how to sign in

| Way | When | What you do |
| --- | --- | --- |
| **Browser sign-in (OAuth)** | SubKit Cloud and engines with an identity provider | Enter the address. The client opens your browser, where you sign in and consent. In the cloud, select **Sign in with work account**. |
| **API key** | Clients that use a key, and engines without an identity provider | Enter a key in the client as a bearer token. |

Use the browser sign-in when you can. You copy no key, a consent page shows what the client may do, and the access renews itself.
An API key, by contrast, is long-lived access that sits on your machine.

### Connect with browser sign-in

1. In your client, add a remote MCP server with the address `https://<your-engine>/mcp` and name it `sk`.
2. In the browser window the client opens, sign in the same way as in the Cockpit.
3. On the page **Allow access**, check which client wants access to which workspace.
4. Check the boxes for what the client may do. **Read** is always on.
5. Select **Allow**. The browser returns to your client.

Where you add the server depends on the client:

- **claude.ai:** the settings for connectors. Add a custom connector with the address.
- **Claude Code:**

  ```bash
  claude mcp add --transport http --scope user sk https://<your-engine>/mcp
  ```

  Then run `/mcp` in Claude Code and select `sk` to sign in.
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

If your client can only start local MCP servers, there is the command `sk mcp`. It uses your signed-in `sk` profile but offers only five tools: a connection check and four tools for conversations with SubKit. Your client reaches workflows, connectors and knowledge only through your engine's `/mcp` address.

A key without an MCP scope connects in **Read** mode.
If the client should also build, add `mcp:authoring` to `--scopes` when you create the key with `sk apikeys create`.

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

2. In your client, ask: "Call the SubKit tool whoami." The answer names your account, your workspace and your scopes.
3. Ask: "Find a workflow in SubKit." The client calls `find_workflow` and lists what it finds.

If all three work, the client is connected.

### What the client may do

A scope is the level you give the client when it connects. It decides which tools the client sees at all.
Your role still limits every single call. A scope never gives the client more than you may do yourself.

| On the access page | Scope | The client can |
| --- | --- | --- |
| **Read** | `mcp:read` | Read workflows, runs, connectors, knowledge and tasks, run saved workflows, and start and stop tasks. |
| **Authoring** | `mcp:authoring` | Additionally build workflows and connectors in a guided conversation, and create and change tasks. |
| **Administration** | `mcp:admin` | Additionally create, change and delete things in the workspace. |
| **Operational counters** | `metrics:read` | Read the operational counters, nothing else. |

- The access page only offers what your role allows.
- A key with `*` does not include authoring. That takes a deliberate `mcp:authoring`.
- An engine with `mcp.read_only` hides every write tool, even with `mcp:admin`.

### Read, run, write

- **Reads** run right away. Examples: `find_workflow`, `get_execution`, `search_knowledge`.
- **Runs** start a saved workflow, for example with `run_workflow` or a `wf_<slug>` tool.
  A short run answers right away. A long run answers with an `execution_id` that the client follows with `get_execution`.
- **Writes** change something: send an email, change data, change the workspace.
- **Packages** move your workspace's own resources to another engine with `export_tenant_package`, `preview_package_import` and `apply_package_import`.
  They ask for confirmation first. An import only creates drafts and proposals.

Writing always needs a person, in two places:

- **Writes inside a workflow:** A workflow writes for real only after a person approves it in the Cockpit. Without approval the run is a dry run: writes are held back and nothing is sent.
  A new version needs no new approval as long as it touches no more systems, addresses or write permissions than the approved one. If it reaches further, SubKit asks again and names the difference.
  In chat with **Always ask first** on, SubKit asks before every write unless there is an approval that covers exactly this run: the same version, the same environment, still valid and with unchanged effects. A run that passes on data from an earlier run always asks, and so does a conversation you told to confirm every start.
- **Write tools in the client:** A write tool pauses and returns a link.
  Open it, sign in, check what will happen, and select **Allow once** or **Decline**.
  Only then can the client finish the call with `confirm_tool_call`.

The AI cannot approve or allow anything itself. The link alone allows nothing either.

### Tasks from an AI client

A task is a goal with limits that SubKit works towards on its own. The chapter “Hand over a goal as a task” explains it. From an AI client you reach tasks with these tools:

| Tool | What it does | Level |
| --- | --- | --- |
| `list_tasks`, `find_task`, `get_task` | List, search and read the tasks you may see. | **Read** |
| `get_task_run` | Read the state of one run. | **Read** |
| `run_task` | Start a run now, as you. The call returns the run and does not wait for the result. | **Read** |
| `abort_task_run` | Stop a run that is running, waiting or sleeping. | **Read** |
| `save_task` | Create a task or change one. It only stores the task and starts nothing. | **Authoring** |

You see your own tasks. With the Admin role you see all of them. `get_attention` also lists tasks that wait for you.

What a client cannot do:

- **Give the standing permission.** A task that should start on its own needs a person signed in to the Cockpit in the browser.
- **Answer the questions of a run.** A run works in its own conversation in the Cockpit. Every task result carries `cockpit_path`, the address of the task there.
- **Confirm a result or send it back.** Only a person does that, signed in to the Cockpit in the browser.
- **Create or change tasks without Authoring.** Without `mcp:authoring`, `save_task` answers `authoring_scope_required`.

A run that a client starts has the same limits as every run: it uses only what is bound to the task, and anything that writes asks a person first, unless a valid approval of a bound workflow covers it.

### Use an MCP server as a connector

The other direction: an MCP server your team already uses becomes a connector in SubKit. Workflows and the chat then call its tools.
Each tool asks before it runs, unless the operator has enabled it individually. Only someone allowed to change the connector can do that; a normal edit of the connector does not change this list.
`sk connectors mcp-inspect <id>` shows which tools the server actually offers. If the server needs OAuth client credentials, follow "External MCP OAuth credentials".

### If something does not work

The engine returns these messages in English; they are quoted verbatim here.

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
