---
slug: subkit-cloud
summary: Use SubKit in the browser without running your own server.
section: start
path_choice: hosting
order: 2
audience: public
---
## Use SubKit Cloud

> Cloud (Preview, open sign-up)

With SubKit Cloud, SubKit runs for you. You install nothing and operate no engine of your own.
You sign in from the browser and work in the Cockpit of your workspace.

### In short

1. Open `https://subkit-cloud.mikebild.dev` and select **Sign in with work account**.
2. At Upraft Auth, select **Create an account**, enter your email address and a password, and confirm your address with the link in the email.
3. Sign in with your new account.
4. Enter your name, a name for your workspace and your time zone.
5. Choose your AI provider, enter your API key and select **Get started**.
6. Build your first workflow with “Your first workflow”.

Invited to an existing workspace? Open the invitation link instead, as described in “Join a workspace”.

### What you need

- An account at Upraft Auth, the sign-in service of the platform SubKit Cloud runs on. You create it yourself when you first sign in.
- An invitation link to an existing workspace, or an API key from your AI provider to start a workspace of your own.
- The address `https://subkit-cloud.mikebild.dev`. It takes you straight to the Cockpit.

### Get access

There are two ways into SubKit Cloud: you join a workspace someone invited you to, or you start your own.

#### Join a workspace

An administrator invites you from **People & access** > **Invite person** and passes the invitation link on to you.
SubKit does not send an email.

1. Open the invitation link.
2. Select **Sign in and join**.
3. Sign in at Upraft Auth with the email address the invitation is for.
4. Check your name and select **Join**.

The link works only once, only for this address and until the date shown on the page.
If it no longer works, ask the person who invited you for a new one.

#### Start your own workspace

If you have no account yet, create one at Upraft Auth. After your first sign-in, SubKit shows a welcome page.

1. Open `https://subkit-cloud.mikebild.dev` and select **Sign in with work account**.
2. Select **Create an account**, enter your name, email address and a password with at least 12 characters, and select **Create account**.
3. Open the link in the email to confirm your address, then sign in.
4. On the welcome page, enter your name, a name for your workspace and your time zone.
5. Choose your AI provider and enter your API key, as described in “Your AI access”.
6. Select **Get started**.

### Sign in

1. Open `https://subkit-cloud.mikebild.dev`.
2. Select **Sign in with work account**.
3. Sign in at Upraft Auth with your email address and password.

The Cockpit opens in your workspace.
Your session ends after 8 hours of inactivity, or after 24 hours at the latest.

To build your first workflow, follow “Your first workflow”.

### Your AI access

SubKit works with the AI service you choose. The provider bills you directly for what you use.

When you create a workspace, you choose the provider and enter your API key:

1. Select **Anthropic**, **OpenAI** or **Google**.
2. Enter the API key from your account with that provider.
3. Select the button that creates the workspace.

SubKit checks the key once with the provider and stores it encrypted. It is never shown again.
If the provider refuses the key, nothing is created. Check the key and submit the form again.

People you invite never enter a key. They work with the key of the workspace.

To change the provider, the model or the key later:

1. In the Cockpit, open **Settings** > **AI assistant**.
2. Choose the provider and model, or enter a new key.
3. Select **Save**. SubKit checks the new key first. If the provider refuses it, the stored key stays active.

Only the owner or an administrator of the workspace can change the AI access.

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
Sign in again with the subkit CLI and your MCP clients. Create a new key for the Web Clipper.

### Sign in with the subkit CLI

The `subkit` CLI signs in through the browser, like the Cockpit.

1. Install the CLI:

   ```bash
   curl -fsSL https://subkit-cloud.mikebild.dev/install | bash
   ```

2. Sign in. Use the address without `/cockpit`:

   ```bash
   subkit login --engine-url https://subkit-cloud.mikebild.dev
   ```

3. In the browser that opens, select **Sign in with work account**.

The CLI then stores a personal key. Run `subkit` to start.
For everything else, see “Use the subkit CLI on your machine”.

### Connect an MCP client

AI clients such as ChatGPT, Claude or Cursor can connect to SubKit Cloud over MCP.

1. In your client, add a remote MCP server with the address `https://subkit-cloud.mikebild.dev/mcp`.
2. In the browser sign-in that opens, select **Sign in with work account**.
3. On **Allow access**, select **Allow**.

You do not need to copy an API key. For more, see “Connect AI clients via MCP”.

### Collect web pages

The Web Clipper collects web pages into the **Inbox**.
Set it up as described in “Collect web pages with the Web Clipper”.
For SubKit Cloud, the engine address is `https://subkit-cloud.mikebild.dev`.

### What is different from self-hosting

SubKit Cloud runs the same engine as a self-hosted installation.
Some settings are managed by the operator instead of by you.

- **Your own AI access.** Every workspace brings its own AI provider and API key. See “Your AI access”.
  The key is the only setting you change for your workspace; the operator sets all limits.
- **No AI without your own key.** A workspace that has no API key of its own cannot use the chat or run AI steps.
  The operator's AI access is never used for your workspace.
- **Built-in web search runs on your key.** With an Anthropic model, the assistant can use the model's built-in web search.
  Anthropic bills each search to your account. The operator can turn this off for all workspaces.
- **Public addresses only.** Connectors reach only services on the public internet.
  Addresses in a private network, such as `localhost` or an internal company server, are blocked.
- **Slack and Google Chat are locked.** Chat workspaces on these platforms stay locked
  until ownership of the workspace is verified. Use the chat in the Cockpit instead.
- **API keys for tools only.** API keys still work for the subkit CLI, the Web Clipper, the HTTP API (Bearer)
  and MCP clients that use a key. Signing in to the browser with an API key exists only for
  self-hosted installations without an identity provider.
- **Export as a package.** You can export your own workflows, connectors, skills, schedules, knowledge sources and files as a package and import it into another engine.
  Credentials, approvals and run history are not included. See “Use the subkit CLI on your machine”.

### Limits and their messages

Every workspace has limits. The operator sets their values.
When you reach one, SubKit shows a message. Most of these messages appear in English; the table quotes them verbatim.

| What you see | What to do |
| --- | --- |
| “Too many requests. Try again shortly.” | You sent too many requests in a short time. Wait a moment and try again. |
| “The monthly request allowance is exhausted.” | The month's request allowance is used up. Wait for the next month or contact the operator. |
| “The workspace storage allowance for files and saved content is exhausted. Retained content remains charged until physical cleanup succeeds.” | Storage is full. Delete files and saved content you no longer need, or contact the operator. |
| “The workspace resource limit is exhausted. Ask the engine operator to review retained resources.” | Too many resources. Delete workflows or connectors you no longer need, or contact the operator. |
| “This workspace has no AI access yet. Enter your provider and API key under Settings → AI assistant.” (in the chat) | Your workspace has no API key of its own. Enter your provider and key under **Settings** > **AI assistant**. |

### If something does not work

| What you see | What to do |
| --- | --- |
| The invitation link or sign-in does not work | Sign in with the email address the invitation is for. If the link has expired, ask for a new one. If it was already used, your account exists: sign in. |
| You forgot your password | Upraft Auth sends you an email to reset it. |
| You want to use a different account | Follow “Switch accounts”. |
| You are signed out unexpectedly | Your session ended after 8 hours of inactivity or 24 hours. Sign in again. |
| `subkit login` or the MCP client cannot connect | Use `https://subkit-cloud.mikebild.dev` and `https://subkit-cloud.mikebild.dev/mcp`, without `/cockpit`. |
