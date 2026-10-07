# sk

sk is a self-hosted engine for governed workflows: describe the work in plain language, approve what it may touch, and every run is recorded.

## Run the engine

Requires Docker with Compose.

```bash
curl -O https://<engine-host>/docker-compose.yml   # or use docker-compose.yml from this repository
MASTER_KEY=$(openssl rand -hex 32) docker compose up -d
curl -s http://localhost:3000/health
```

Keep `MASTER_KEY`. It encrypts stored secrets; losing it loses them.

From a checkout, `bun run start:local` starts the stack and completes first-run setup with the `mock` LLM provider.

## First-run setup

```bash
docker compose exec engine sk init \
  --token "$(docker compose logs engine 2>&1 | grep -oE 'sk init --token [a-f0-9]{64}' | tail -1 | cut -d' ' -f4)" \
  --admin-email you@example.com \
  --tenant-name "My Org" \
  --llm-provider anthropic \
  --llm-api-key <your-provider-key>
```

Use `--llm-provider mock --llm-api-key mock` to try it without an LLM account.
`sk init` checks the key with one minimal call before it saves anything; a refused key stops
the setup, nothing is stored, and the same token works for the next try.

Open the Cockpit at `http://localhost:3000/cockpit`.

## Use the sk CLI on your machine

The engine serves the CLI itself. There is no npm package.

```bash
curl -fsSL http://localhost:3000/install | bash
docker compose exec engine engine --issue-admin-key --tenant my-org   # prints an `sk login` line
sk login --engine-url http://localhost:3000 --api-key <key>
sk
```

`sk --help` lists every command. The engine describes itself at `/openapi.json` and `/llms.txt`.

## Product identity binding

For an OIDC provider configured with `product_id`, an operator first provisions an active tenant user, assigns a minimal custom role and grants only the intended saved workflows. Built-in member roles allow broader workflow execution.

Bind its verified issuer subject with `POST /v1/identity/users/{id}/provider-identities` and JSON `{"provider_id":"<provider-id>","subject":"<verified-subject>"}`. This requires administrator policy and `identity:write`. Tenant, issuer and product come from provider configuration. Exact retries are idempotent; owner, subject, issuer or product conflicts are refused. The endpoint changes neither roles nor grants.

Product providers require this binding and disable account creation and email linking even when signup is globally enabled. Older product bindings need an operator to pin the same owner and subject before login. Unbound providers retain email linking by default; set `link_by_email: false` to disable it. Older unbound bindings pin the configured issuer at their first verified login; this cannot establish historical issuer provenance.

Pins are checked for new logins. Changing provider configuration does not revoke existing browser sessions; revoke those separately or let their configured lifetime expire.

## License

MIT
