---
slug: first-run-setup
summary: Create the admin account, workspace and AI provider after the first start.
section: start
order: 4
audience: operator
---
## First-run setup

After this step your engine has an admin account, a first workspace and a verified AI provider, and you can sign in to the Cockpit.
The engine writes the one-time setup token to its log on first start; the command reads it from there.

```bash
docker compose exec engine subkit init \
  --token "$(docker compose logs engine 2>&1 | grep -oE 'subkit init --token [a-f0-9]{64}' | tail -1 | cut -d' ' -f4)" \
  --admin-email you@example.com \
  --tenant-name "My Org" \
  --llm-provider anthropic \
  --llm-api-key <your-provider-key>
```

Replace the email address, the name and the key with your own values.
`subkit init` checks the key with one small test call before it saves anything.
If the provider refuses it, the setup stops and nothing is stored. The same token works for the next try.

Open `http://localhost:3000` in your browser. The address takes you straight to the Cockpit at `/cockpit`.
The engine index, with every address for tools and AI clients, is at `/engine`.
If no sign-in provider is configured, sign in with a personal API key.
The key `subkit init` prints belongs to a system account. It works for the API and the CLI, but not for Cockpit sign-in.
Issue a personal admin key instead:

```bash
docker compose exec engine engine --issue-admin-key --tenant my-org
```

The tenant slug is your workspace name in lowercase with hyphens, so "My Org" becomes `my-org`.
Paste the printed `wf_live_…` key into the API-key sign-in of the Cockpit.
Then build your first workflow with "Your first workflow".

