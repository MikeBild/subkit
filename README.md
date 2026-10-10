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

### Local installation for manual Cockpit testing

Run `bun run demo:local`. This builds changed application sources when needed, starts an isolated installation at `http://localhost:3000/cockpit`, runs migrations and first-run setup, seeds the synthetic dataset, configures the real AI providers and checks API-key browser login. Docker must be running. Put your Anthropic key in `claude-key.txt` and/or your OpenAI key in `openai-key.txt`; these files are excluded from Git and Docker build contexts. The default primary route is Anthropic `claude-sonnet-4-6`, with OpenAI `gpt-5.6-sol` as fallback when both keys exist. Setup itself makes no paid model probe. For an explicitly offline installation, use `bun run demo:local -- --mock`.

Startup measures free space inside Docker, requiring 12 GiB before an image build and 1 GiB before services and fixture setup. It checks again after building and aborts clearly when storage is low. Increase Docker Desktop's disk image limit or explicitly reclaim unused build cache with `docker builder prune`; the startup check never deletes data or volumes. Free space on the host alone is not sufficient.


The command prints the current local user API key and stores it with owner-only permissions in `.artifacts/cockpit-demo/api-key.txt`. Open the Cockpit and choose API-key sign-in. Real provider settings are stored encrypted through the engine's settings API. You can change models and settings in the Cockpit; ordinary starts preserve those changes. Replacing a provider key file updates the provider configuration on the next start.

| Command | Result |
| --- | --- |
| `bun run demo:local` | Start or resume; build only when application sources changed; retain manual edits. |
| `bun run demo:local:stop` | Stop the demo and preserve its named database/object volumes and API key. |
| `bun run demo:local:restart` | Restart the demo services and check readiness. |
| `bun run demo:local:rebuild` | Rebuild the current checkout and resume the same data. |
| `bun run demo:local:reset` | Delete only this demo project's data, run migrations/setup again, restore fixtures and issue a new API key. |
| `bun run demo:local:status` | Show local service health and authenticated readiness. |
| `bun run demo:local:key` | Print the current local login key. |
| `bun run demo:local:verify` | Run real local API and browser journeys, including one paid chat response and workflow approval/execution; no screenshots. |

The fixtures cover all main Cockpit areas: six connectors, twelve demo workflows plus three installation starters, twenty-four recorded runs with successful/failed/cancelled outcomes and usage, seven conversations including a pending question and hidden chat, six knowledge sources with twelve sections, eight skills, six learning proposals, five downloadable files, and four people with roles/groups. Long names, Unicode, categories and multiple statuses support manual review. Historical runs and costs are clearly synthetic; recorded fixtures are not claims of real execution. A local API service provides contacts, orders, reports, echo writes and a deliberate failure endpoint for new real workflow runs. Workflows retain normal approval gates. External OAuth/MCP accounts and external delivery services require their own credentials; the three installation starter workflows use public demo endpoints when run.

The fixed Compose project is `subkit-cockpit-demo`; PostgreSQL and object storage have dedicated named volumes. The existing development/production installations are independent. `SUBKIT_TEST_PORT` changes the loopback host port; use the same value for subsequent commands. The local receipt is `.artifacts/cockpit-demo/receipt.json`.

Run `bun run demo:local:verify` after setup when you want to verify the running installation before manual review. It uses disposable resources and the real local services, checks API-key login, catalog navigation, file/source/skill changes, workflow permission boundaries and browser approval/execution, and requests one real AI response. It does not reset your data. Evidence is saved under `.artifacts/cockpit-demo/`; failed checks exit nonzero. `verify:cockpit-local` runs only the API portion; `verify:cockpit-local-browser -- --read-only` checks browser login/navigation without chat or workflow changes. `SUBKIT_DEMO_URL` selects a loopback test address. These live installation journeys are separate from the isolated functional fixtures in the normal release gate.

Catalog categories share a name, purpose and alternate search words across workflows, connectors, sources, skills and files. The category editor searches all three fields. Saving a displayed AI purpose makes it human-owned; leaving it blank requests a new suggestion. Merging keeps the target purpose and combines alternate words. Concurrent edits require reloading before saving. The local fixtures include three categories with human-written purposes and alternate words; normal starts preserve later edits.

Visual acceptance is manual. Automated functional browser journeys, API/security tests, migrations, builds, type checks and release checks remain enabled; automated screenshot matrices and visual layout sweeps are removed from the verification pipeline.

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

## Save web pages to SubKit knowledge

Run `sk clipper install` to unpack the Chrome extension shipped inside the CLI.
In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
and select the folder printed by the command. The installer prefills the engine URL
from your active profile. In the extension settings, enter a separate API key with
`knowledge:read` and `knowledge:write` access and allow access to your engine host.
You can change the engine URL in those settings; no server address is built into the extension.

Use the toolbar, page context menu, or a shortcut configured at `chrome://extensions/shortcuts`
to capture an article or selected text. Review the Markdown, choose a global or
workflow knowledge collection, then save. A new collection is created with its first clip.
If a page is already in the collection, choose replacement or a separate copy.
Image links are retained; image files are not uploaded. Failed saves remain local
until you retry or discard them.

Run `sk clipper install` after updating the CLI, then reload the extension in Chrome.
Use `sk clipper install --dir <directory> --no-open` to choose a directory and skip
opening Chrome. Updating an existing installation preserves its connection settings.
For a new installation, `--engine-url <url>` overrides the active profile's address.
The engine also serves the same embedded archive at `/install/clipper.zip`, with its
SHA-256 in the `x-subkit-sha256` response header. HTTPS engines and local HTTP engines
on `localhost`, `127.0.0.1`, or `[::1]` are supported, including an optional URL path prefix.
Changing the engine address requires entering the key for that engine; an existing
draft stays associated with its original engine. If another person changes the
collection while you save, review the conflict before trying again.

## Execution identity and permission

`$caller` answers who authenticated this execution. Connector credentials authenticate an outbound request to another service. RBAC decides which workflows and resources that principal may use. Human approval permits a reviewed effect boundary for an environment. These four concepts are independent: a credential or approval does not create caller identity or replace authorization, and the approver need not be the execution caller.

HTTP and MCP runs derive caller identity from their authenticated principal. Trusted callerless webhook and scheduled runs receive `null`; the person who configured or approved them is not automatically their caller. Child workflows retain the parent's caller. Use `required_caller_kind` and `product_id` when a workflow requires a particular authenticated identity, and never infer one from input fields or `request_source`.

Run inspection exposes source, status, workflow version, execution authority, step evidence and a safe `caller` summary through HTTP and MCP. The summary names the stored principal, product, authentication method, channel and origin run without exposing credentials or session identifiers. Missing stored identity is `kind: unknown`; a channel alone cannot identify a caller. HTTP audit queries and MCP `list_audit` can filter by actor and trace. These records provide partial correlation, not a complete caller timeline. See the built-in Core Concepts, Auth Flows and REST API guidance for the contract and its limits.

## Product identity binding

For an OIDC provider configured with `product_id`, an operator first provisions an active tenant user, assigns a minimal custom role and grants only the intended saved workflows. Built-in member roles allow broader workflow execution.

Bind its verified issuer subject with `POST /v1/identity/users/{id}/provider-identities` and JSON `{"provider_id":"<provider-id>","subject":"<verified-subject>"}`. This requires administrator policy and `identity:write`. Tenant, issuer and product come from provider configuration. Exact retries are idempotent; owner, subject, issuer or product conflicts are refused. The endpoint changes neither roles nor grants.

Product providers require this binding and disable account creation and email linking even when signup is globally enabled. Older product bindings need an operator to pin the same owner and subject before login. Unbound providers retain email linking by default; set `link_by_email: false` to disable it. Older unbound bindings pin the configured issuer at their first verified login; this cannot establish historical issuer provenance.

Pins are checked for new logins. Changing provider configuration does not revoke existing browser sessions; revoke those separately or let their configured lifetime expire.

## Supabase-backed product workflows

Use Supabase through the `supabase` connector and ordinary workflow authoring; workflows do not need direct PostgreSQL access or SQL steps. Store required gateway headers as encrypted connector credentials. `apikey` is the public project key; `Authorization` carries the JWT for the intended database role. A tenant-wide connector credential cannot represent separate mobile users; never pass an app user's JWT as workflow input. Use an owner-binding RPC that maps immutable `$caller` when a workflow needs user-owned data. A protected server-to-server RPC may additionally require `x-subkit-token`, stored only on the connector. It authenticates SubKit to the product backend; it is not the end user's identity and never replaces the workflow's immutable `$caller`. Never put credentials in app code, workflow inputs or steps, client context, generated workflow source, or logs. Do not use `service_role` for caller-scoped access because it bypasses RLS. Bind product workflows to their product and required caller kind, derive owner identifiers from `$caller`, and fail closed when an atomic authorization or quota reservation does not explicitly permit the next step.

## Use sk from a coding agent

```bash
claude mcp add --transport http --scope user sk http://localhost:3000/mcp --header "Authorization: Bearer ${SK_API_KEY}"
codex mcp add sk --url http://localhost:3000/mcp --bearer-token-env-var SK_API_KEY
sk agent init --domains <category>   # in a repository: briefs each Claude Code and Codex session on that domain
```

Use MCP for approved sk tools; run `sk agent init` to declare repository domains and install the Claude Code and Codex hooks that supply shared-memory briefings. Hooks do not infer the repository's domains on their own. Both use the same authenticated sk profile as the CLI.

### Set up and verify briefings

MCP registration is a one-time machine setup. In each repository, run `sk agent init --domains <category>[,<category>]` and commit the generated `.sk/agent.json` so every checkout uses the same domains. A domain can be a catalog category or a `domain:<slug>` tag. `init` wires Claude Code SessionStart, UserPromptSubmit and SessionEnd hooks, and Codex SessionStart and UserPromptSubmit hooks. It is safe to rerun; `--skip-claude` and `--skip-codex` leave that client's settings untouched.

Run `sk status`, then `sk agent briefing --json` from the repository to verify the declaration, credentials, engine connection and returned briefing. Use the JSON fields `domains`, `knowledge_sources`, `skills_full` and `used_tokens` to inspect the result. Empty `knowledge_sources` or `skills_full` means the briefing works but those items are not assigned to the declared domain. Put knowledge and skills in the domain's catalog category or tag them `domain:<slug>`.

Hooks walk up from the working directory for `.sk/agent.json`; without it they stay silent. Run `sk agent init --domains <category>[,<category>]` once in each repository and commit that file. Each successful briefing gives the model the full domain context and shows you a concise status with loaded materials and any skill proposals awaiting review. If the engine is unreachable, the key is missing, or the declaration is invalid, the client shows a warning and continues the session. Use `/hooks` in Claude Code or Codex to see whether hooks are active. Codex also requires `[features] hooks = true` in `~/.codex/config.toml` and one-time trust in its `/hooks` UI. Claude Code sends a transcript for candidate learning at SessionEnd; Codex has no capture hook because its Stop hook runs after every turn. Captured learnings remain candidates until a person reviews them.

For open-ended check-ins, the briefing tells the agent to interpret the question using the domain declared by the current repository and the connected sources that best answer it. It distinguishes live service state from repository changes and static knowledge, and reports when a relevant source is unavailable. A repository without `.sk/agent.json` does not inherit another folder's briefing.

## License

MIT
