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
docker compose exec engine sk init \
  --token "$(docker compose logs engine 2>&1 | grep -oE 'sk init --token [a-f0-9]{64}' | tail -1 | cut -d' ' -f4)" \
  --admin-email you@example.com \
  --tenant-name "My Org" \
  --llm-provider anthropic \
  --llm-api-key <your-provider-key>
```

Replace the email address, the name and the key with your own values.
`sk init` checks the key with one small test call before it saves anything.
If the provider refuses it, the setup stops and nothing is stored. The same token works for the next try.

Open `http://localhost:3000` in your browser. The address takes you straight to the Cockpit at `/cockpit`.
The engine index, with every address for tools and AI clients, is at `/engine`.
If no sign-in provider is configured, sign in with an API key.
Then build your first workflow with "Your first workflow".

