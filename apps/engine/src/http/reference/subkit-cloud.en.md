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

SubKit Cloud is SubKit run for you, so you do not install or operate an engine yourself.
It lives at `https://subkit-cloud.mikebild.info`. The Cockpit is at
`https://subkit-cloud.mikebild.info/cockpit`.

The cloud is a beta. You can only join by invitation. There is no public sign-up.

### Get access

An administrator of a workspace invites you. You need nothing beforehand.

1. The administrator opens **People & access** in the Cockpit and chooses **Invite person**.
2. You receive an email from "Upraft Auth".
3. Open the link in that email and set a password.
4. Open the Cockpit at `https://subkit-cloud.mikebild.info/cockpit`.

Sign in with the same email address the invitation was sent to.
A different address does not accept the invitation.

### Sign in

SubKit Cloud signs you in through Upraft Auth.

1. Open `https://subkit-cloud.mikebild.info/cockpit`.
2. Sign in with your password, or ask for a sign-in link by email.
3. You land in your workspace in the Cockpit.

Forgot your password? Upraft Auth can send you an email to reset it.

Signing in with an API key is only for self-hosted installations without an identity provider.

### Workspaces

A workspace holds your workflows, connectors, knowledge, skills and runs.
People in one workspace cannot see another workspace.

- You can be a member of more than one workspace.
- Use **Switch workspace** to move between them.
- Workspaces you own are marked **Own** and show your role as **Owner**.
  For the others, the list shows your role, such as Administrator or Member.
- Only the owner can delete a workspace.

### First steps in the Cockpit

1. Open **Chat** and describe what SubKit should do, in plain words.
   Example: "Every Monday, collect last week's new GitHub issues and send me a summary."
2. Connect the services you need under **Connectors**.
3. Review and run the workflow the chat prepares for you.
4. Invite colleagues from **People & access**.

### What is different from self-hosted

SubKit Cloud runs the same engine as a self-hosted installation.
Some settings are managed by the operator instead of by you.

- **Models, budgets and limits.** The operator chooses the AI models, the budgets and the limits.
  You cannot add your own AI key or change these settings for your workspace.
- **Text models only.** The cloud uses text models. Images, audio and other
  non-text input to the model are not supported.
- **No native web search.** The model's built-in web search is not available.
- **Public addresses only.** Connectors can only reach services on the public internet.
  Addresses in a private network, such as `localhost` or an internal company server, are blocked.
- **Slack and Google Chat are locked.** Chat workspaces on these platforms stay locked
  until ownership of the workspace is verified. Use the chat in the Cockpit in your browser instead.

### Use the sk CLI

The cloud serves the sk CLI, just like a self-hosted engine.

1. Install the CLI:

   ```bash
   curl -fsSL https://subkit-cloud.mikebild.info/install | bash
   ```

2. Sign in:

   ```bash
   sk login --engine-url https://subkit-cloud.mikebild.info
   ```

3. Your browser opens. Sign in as you do in the Cockpit.
   The CLI then receives a personal key and stores it for you.
4. Run `sk` to start, or `sk --help` to see every command.

Give the address without a path. `https://subkit-cloud.mikebild.info/cockpit` does not work here.

### Connect an MCP client

AI clients such as ChatGPT, Claude or Cursor can connect to SubKit Cloud over MCP.

1. In your client, add a remote MCP server with this address:
   `https://subkit-cloud.mikebild.info/mcp`
2. The client opens a browser sign-in.
3. Sign in with your SubKit Cloud account and allow access.

You do not need to copy an API key for this.

### Use the web clipper

The web clipper collects web pages into **Intake**. To use it with the cloud:

1. Sign in with the sk CLI first, as shown above.
2. Run `sk clipper install`. It fills in the cloud address from your sk profile.
3. Load the extension in Chrome, as described in the chapter "Web Clipper".
4. In the Cockpit, open **API access**, choose **Create key** and give the key `intake:read` and `intake:write`.
5. Enter that key in the extension settings and allow access to `subkit-cloud.mikebild.info`.

If the clipper shows another address, change it to `https://subkit-cloud.mikebild.info` in its settings.

### Limits and the messages you see

Every workspace has limits. The operator sets their values.
When you reach one, SubKit tells you with a message.

| Limit | Message |
| --- | --- |
| Too many requests in a short time | "Too many requests. Try again shortly." |
| Monthly request allowance | "The monthly request allowance is exhausted." |
| Storage for files and saved content | "The workspace storage allowance for files and saved content is exhausted. Retained content remains charged until physical cleanup succeeds." |
| Number of resources | "The workspace resource limit is exhausted. Ask the engine operator to review retained resources." |
| Monthly AI budget (shown in chat) | "This installation's monthly AI budget is used up." |

What to do:

- For "Too many requests", wait a moment and try again.
- For the monthly limits and the AI budget, wait for the next month or contact the operator.
- For storage and resources, delete what you no longer need, or contact the operator.

### Delete a workspace

Only the owner can delete a workspace.

1. Open **Settings** in the Cockpit.
2. Choose **Delete workspace**.
3. Type the workspace name to confirm.

What happens next:

- Access is suspended right away. Invited members lose their access.
- Sessions, API keys, invitations and MCP client connections are revoked.
- Your other workspaces are not affected.
- You have 7 days to change your mind. Sign in again and choose **Reverse deletion**.
- After 7 days, all data is permanently removed. It cannot be restored.

After you reverse a deletion, old keys and connections stay revoked.
Sign in again with the sk CLI and your MCP clients. Create a new key for the clipper.

### Export your data

A workspace data export is coming later. It is not available yet.
