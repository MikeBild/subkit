---
slug: first-run-setup
summary: Set up providers, admin access and the Cockpit after the first start.
section: start
order: 4
audience: operator
---
## First-run setup

```bash
docker compose exec engine sk init \
  --token "$(docker compose logs engine 2>&1 | grep -oE 'sk init --token [a-f0-9]{64}' | tail -1 | cut -d' ' -f4)" \
  --admin-email you@example.com \
  --tenant-name "My Org" \
  --llm-provider anthropic \
  --llm-api-key <your-provider-key>
```

`sk init` checks the key with one minimal call before it saves anything; a refused key stops
the setup, nothing is stored, and the same token works for the next try.

Open the Cockpit at `http://localhost:3000/cockpit`.
Without a configured sign-in provider, sign in with an API key. This applies only to self-hosted
installations without an identity provider; SubKit Cloud signs you in through Upraft Auth.

