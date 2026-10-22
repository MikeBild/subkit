---
slug: subkit-cloud
summary: Use SubKit as a hosted service without running your own engine.
section: start
path_choice: hosting
order: 2
audience: public
---
## Use SubKit Cloud

> Cloud (hosted beta, by invitation)

SubKit Cloud is SubKit run for you, so you do not install or operate an engine.
You sign in from the browser and work in the Cockpit of your workspace.

### What you need

- An invitation from a workspace administrator. There is no public sign-up.
- The address `https://subkit-cloud.mikebild.info`. It takes you straight to the Cockpit.

### Get access

An administrator invites you from **People & access** > **Invite person**.

1. Open the email from "Upraft Auth".
2. Select the link and set a password.
3. Sign in as described in "Sign in".

Use the email address the invitation was sent to. A different address does not work.

### Sign in

1. Open `https://subkit-cloud.mikebild.info`.
2. Select **Sign in with work account**.
3. Sign in at Upraft Auth with your email address and password.

The Cockpit opens in your workspace.
Your session ends after 8 hours of inactivity, or after 24 hours at the latest.

To build your first workflow, follow "Your first workflow".

### Switch accounts

Signing out in the Cockpit also signs you out at Upraft Auth.

1. In the Cockpit, select **Sign out**.
2. Sign in again with the other account.

### Switch workspaces

A workspace holds your workflows, connectors, knowledge, skills and runs.
People in one workspace cannot see another workspace.

1. In the Cockpit, select **Switch workspace**.
2. Select the workspace you want.

Workspaces you own are marked **Own** and show your role as **Owner**.
For the others, the list shows your role, such as Administrator or Member.

### Delete a workspace

> After 7 days, all workspace data is gone and cannot be restored.

Only the owner can delete a workspace.

1. In the Cockpit, open **Settings**.
2. Select **Delete workspace**.
3. Type the workspace name to confirm.
4. Select **Delete**.

What happens next:

- Access is suspended right away. Invited members lose their access.
- Sessions, API keys, invitations and MCP client connections are revoked.
- Your other workspaces are not affected.
- For 7 days you can change your mind. Sign in again and select **Reverse deletion**.

After you reverse a deletion, old keys and connections stay revoked.
Sign in again with the sk CLI and your MCP clients. Create a new key for the Web Clipper.

### Sign in with the sk CLI

The `sk` CLI signs in through the browser, like the Cockpit.

1. Install the CLI:

   ```bash
   curl -fsSL https://subkit-cloud.mikebild.info/install | bash
   ```

2. Sign in. Use the address without `/cockpit`:

   ```bash
   sk login --engine-url https://subkit-cloud.mikebild.info
   ```

3. In the browser that opens, select **Sign in with work account**.

The CLI then stores a personal key. Run `sk` to start.
For everything else, see "Use the sk CLI on your machine".

### Connect an MCP client

AI clients such as ChatGPT, Claude or Cursor can connect to SubKit Cloud over MCP.

1. In your client, add a remote MCP server with the address `https://subkit-cloud.mikebild.info/mcp`.
2. In the browser sign-in that opens, select **Sign in with work account**.
3. On **Authorize access**, select **Approve**.

You do not need to copy an API key. For more, see "Connect AI clients via MCP".

### Collect web pages

The Web Clipper collects web pages into the **Inbox**.
Set it up as described in "Collect web pages with the Web Clipper".
For SubKit Cloud, the engine address is `https://subkit-cloud.mikebild.info`.

### What is different from self-hosting

SubKit Cloud runs the same engine as a self-hosted installation.
Some settings are managed by the operator instead of by you.

- **Models, budgets and limits.** The operator chooses them.
  You cannot add your own AI key or change these settings for your workspace.
- **Text models only.** Images, audio and other non-text input to the model are not supported.
- **No native web search.** The model's built-in web search is not available.
- **Public addresses only.** Connectors reach only services on the public internet.
  Addresses in a private network, such as `localhost` or an internal company server, are blocked.
- **Slack and Google Chat are locked.** Chat workspaces on these platforms stay locked
  until ownership of the workspace is verified. Use the chat in the Cockpit instead.
- **API keys for tools only.** API keys still work for the sk CLI, the Web Clipper, the HTTP API (Bearer)
  and MCP clients that use a key. Signing in to the browser with an API key exists only for
  self-hosted installations without an identity provider.
- **No data export yet.** A workspace data export comes later.

### Limits and their messages

Every workspace has limits. The operator sets their values.
When you reach one, SubKit shows a message.

| What you see | What to do |
| --- | --- |
| "Too many requests. Try again shortly." | You sent too many requests in a short time. Wait a moment and try again. |
| "The monthly request allowance is exhausted." | The month's request allowance is used up. Wait for the next month or contact the operator. |
| "The workspace storage allowance for files and saved content is exhausted. Retained content remains charged until physical cleanup succeeds." | Storage is full. Delete files and saved content you no longer need, or contact the operator. |
| "The workspace resource limit is exhausted. Ask the engine operator to review retained resources." | Too many resources. Delete workflows or connectors you no longer need, or contact the operator. |
| "This installation's monthly AI budget is used up." (in the chat) | Wait for the next month or contact the operator. |

### If something does not work

| What you see | What to do |
| --- | --- |
| The invitation link or sign-in does not work | Use the email address the invitation was sent to. |
| You forgot your password | Upraft Auth sends you an email to reset it. |
| You want to use a different account | Follow "Switch accounts". |
| You are signed out unexpectedly | Your session ended after 8 hours of inactivity or 24 hours. Sign in again. |
| `sk login` or the MCP client cannot connect | Use `https://subkit-cloud.mikebild.info` and `https://subkit-cloud.mikebild.info/mcp`, without `/cockpit`. |
