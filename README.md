# sk

sk is a self-hosted engine for governed workflows: describe the work in plain language, approve what it may touch, and every run is recorded.

## Run the engine

Requires Docker with Compose, OpenSSL and a POSIX shell. Use `docker-compose.yml`
from the same published release as the engine image, in a dedicated directory.
Development checkouts may reference an image that has not been published yet;
a failed image pull is not a working installation. Do not silently substitute an
older image with a newer Compose file.

Create the installation secrets once, before the first start. This command refuses
to overwrite an existing `.env` and restricts access to its owner:

```bash
(
  set -eu
  umask 077
  set -C
  install_master_key=$(openssl rand -hex 32)
  install_database_password=$(openssl rand -hex 32)
  printf 'MASTER_KEY=%s\nSUBKIT_DB_PASSWORD=%s\n' \
    "$install_master_key" "$install_database_password" > .env
)
```

After the command succeeds, start the installation:

```bash
docker compose pull && docker compose up -d --wait
curl -fsS http://localhost:3000/health
```

Keep an encrypted backup of `.env` outside this directory. `MASTER_KEY` encrypts
stored secrets; losing it makes those secrets unreadable. Never regenerate it for
an existing database. Keep the database password unchanged when reusing its volume;
changing `.env` does not change the password inside an initialized PostgreSQL database.
Never commit `.env` or share `docker compose config` output, which contains secrets.

For subsequent starts, run `docker compose up -d --wait` from the same directory.
`docker compose stop` stops services without deleting data. The database and object
store use named volumes; `docker compose down -v` deletes them. Keep the same Compose
project name when resuming an installation. A recovery backup needs the database,
object-store data, `.env`, and the matching Compose file and image identity together.
Test restoration in a separate installation before relying on a backup or upgrading.

The default API and database bindings are loopback-only. Complete first-run setup
locally before exposing the API. Remote access requires HTTPS and access controls;
do not expose the database or object store publicly.

From a checkout, `bun run start:local` starts the stack and completes first-run setup with the `mock` LLM provider.

Connector discovery in the supplied container supports HTTP-based documentation
sources. Optional Playwright crawling is not available out of the box. For documentation
that requires JavaScript rendering, provide an accessible OpenAPI specification or
configure the connector endpoints explicitly. A bundled browser executable alone does
not establish that the discovery integration is available.

### Backup and recovery

Use a maintenance window for a consistent backup. These steps apply to the bundled
PostgreSQL and object store; external services need their own recovery procedure.
Run commands from the installation directory with its original Compose project name.
Use a new owner-only backup directory outside the checkout, set `umask 077`, and keep
it encrypted at rest. The dump, object archive and `.env` contain sensitive data.

1. Record the running engine image identity with `docker inspect --format '{{.Image}}' "$(docker compose ps -q engine)"`.
   Preserve that image in an accessible registry or with `docker image save`, together
   with `docker-compose.yml` and `.env`. Do not rely on a mutable tag for recovery.
2. Stop writers with `docker compose stop engine`. Back up PostgreSQL with
   `docker compose exec -T postgres pg_dump -U subkit -d subkit -Fc > /path/to/backup/postgres.dump`.
   Check the exit status before proceeding. Keep the engine stopped until both data stores are backed up.
3. Stop the object store with `docker compose stop object-store`. Find its exact volume
   using `docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$(docker compose ps -aq object-store)"`.
   Archive it read-only with `docker run --rm --network none -v <object-volume>:/data:ro --entrypoint tar oven/bun:1.4.0-debian -C /data -cf - . > /path/to/backup/objects.tar`.
   Replace `<object-volume>` with that inspected name, not a guessed volume name.
4. Check each command succeeded, restrict all backup files to mode `0600`, and record
   their SHA-256 checksums. Restart the original installation with `docker compose up -d --wait`.
   If a backup command fails, retain the original volumes and investigate; an incomplete backup is not a recovery point.

Test recovery in a separate directory using `docker compose -p subkit-recovery` for
**every** Compose command below. First confirm that this project name has no existing
containers or volumes; choose another unused name otherwise. Copy the saved Compose
file and `.env`, preserve `MASTER_KEY` and the database password, select the saved
engine image with `SUBKIT_IMAGE`, and set unused loopback ports through
`SUBKIT_HOST_PORT` and `SUBKIT_DB_PORT`. Do not connect the recovery installation to
external writers. Before starting services, add `docker-compose.override.yml` in
the recovery directory with the following network isolation. Keep it in effect until
restored schedules, triggers and connector permissions have been reviewed; starting
the engine also starts its scheduler. Do not use this recovery project to perform
real external effects.

```yaml
networks:
  default:
    internal: true
```

1. Create fresh storage with `docker compose -p subkit-recovery create postgres object-store`.
   Inspect the new object-store container's `/data` volume as above, using the recovery
   project. Restore only into that new volume:
   `docker run --rm -i --network none -v <new-object-volume>:/data --entrypoint tar oven/bun:1.4.0-debian -C /data -xf - < /path/to/backup/objects.tar`.
2. Start the new database with `docker compose -p subkit-recovery up -d --wait postgres`.
   Restore it with `docker compose -p subkit-recovery exec -T postgres pg_restore --exit-on-error --clean --if-exists --no-owner -U subkit -d subkit < /path/to/backup/postgres.dump`.
   This command replaces database contents: use it only against the new recovery project.
3. Start the recovered services with `docker compose -p subkit-recovery up -d --wait`.
   Check `/health` and `/ready` on the selected port, sign in with an existing account,
   compare workflow records and downloaded file checksums, and verify an encrypted
   credential through a controlled test. A successful HTTP health check alone does
   not prove that the database, object files and encryption key match.

This restores the same application image and a consistent backup. It does not
establish an upgrade or schema-downgrade path. Data written after the backup is not
included. Retain the original installation until recovery has been accepted.

### Local installation for manual Cockpit testing

Run `bun run demo:local`. This builds changed application sources when needed, starts an isolated installation at `http://localhost:3000/cockpit`, runs migrations and first-run setup, seeds the synthetic dataset, configures the real AI providers and checks API-key browser login. Docker must be running. Put your Anthropic key in `claude-key.txt` and/or your OpenAI key in `openai-key.txt`; these files are excluded from Git and Docker build contexts. The default primary route is Anthropic `claude-sonnet-4-6`, with OpenAI `gpt-5.6-sol` as fallback when both keys exist. Setup itself makes no paid model probe. For an explicitly offline installation, use `bun run demo:local -- --mock`.

Startup measures free space inside Docker, requiring 12 GiB before an image build and 1 GiB before services and fixture setup. It checks again after building and aborts clearly when storage is low. Increase Docker Desktop's disk image limit or reclaim enough Docker-managed space; inspect `docker system df` first because build cache may be empty. The startup check never deletes data or volumes. Free space on the host alone is not sufficient.


The command prints the current local user API key and stores it with owner-only permissions in `.artifacts/cockpit-demo/api-key.txt`. Open the Cockpit and choose API-key sign-in. Real provider settings are stored encrypted through the engine's settings API. You can change models and settings in the Cockpit; ordinary starts preserve those changes. Replacing a provider key file updates the provider configuration on the next start.

| Command | Result |
| --- | --- |
| `bun run demo:local` | Start or resume; build only when application sources changed; retain manual edits. |
| `bun run demo:local:stop` | Stop the demo and preserve its named database/object volumes and API key; requires a marker created by a successful demo start. |
| `bun run demo:local:restart` | Restart only the marked demo instance and check readiness; requires a marker created by a successful demo start. |
| `bun run demo:local:rebuild` | Rebuild the current checkout and resume the same data. |
| `bun run demo:local:reset` | Delete only the marked demo project's database and object-storage volumes, then run migrations/setup, restore the synthetic baseline and issue a new API key; requires a marker created by a successful demo start. |
| `bun run demo:local:status` | Show local service health and authenticated readiness. |
| `bun run demo:local:key` | Print the current local login key. |
| `bun run demo:local:lifecycle` | Start, stop, restart, reset and reseed a disposable isolated demo instance; verify its fixtures and cleanup without touching the default demo. |
| `bun run demo:local:verify` | Run local API and browser journeys, including one provider chat response and workflow approval/execution; no screenshots. |
| `bun run demo:local:verify -- --mock` | Run the same journeys and verify chat through the mock provider without an external model call. |

The fixtures cover all main Cockpit areas: six connectors, twelve demo workflows plus three installation starters, twenty-four recorded runs with successful/failed/cancelled outcomes and usage, seven conversations including a pending question and hidden chat, six knowledge sources with twelve sections, eight skills, six learning proposals, five downloadable files, and four people with roles/groups. Long names, Unicode, categories and multiple statuses support manual review. Historical runs and costs are clearly synthetic; recorded fixtures are not claims of real execution. A local API service provides contacts, orders, reports, echo writes and a deliberate failure endpoint for new real workflow runs. Workflows retain normal approval gates. External OAuth/MCP accounts and external delivery services require their own credentials; the three installation starter workflows use public demo endpoints when run.

The fixed Compose project is `subkit-cockpit-demo`; PostgreSQL and object storage have dedicated named volumes. The existing development/production installations are independent. The demo publishes its database on loopback port `55439` by default so it can run beside the regular local database; `SUBKIT_DEMO_DB_PORT` changes that port. `SUBKIT_TEST_PORT` changes the Cockpit loopback host port; use the same values for subsequent commands. The local receipt is `.artifacts/cockpit-demo/receipt.json`.

Run `bun run demo:local:verify` after a provider-backed setup when you want to verify the running installation before manual review. It uses disposable resources and the real local services, checks API-key login, catalog navigation, file/source/skill changes, workflow permission boundaries and browser approval/execution, and requests one real AI response. For a provider-free journey, first run `bun run demo:local -- --mock`, then `bun run demo:local:verify -- --mock`; the verifier confirms the configured provider is `mock` before sending chat and checks the deterministic mock response, with no external model call. Verification does not reset your data. Evidence is saved under `.artifacts/cockpit-demo/`; failed checks exit nonzero. `verify:cockpit-local` runs only the API portion; `verify:cockpit-local-browser -- --read-only` checks browser login/navigation without chat or workflow changes. `SUBKIT_DEMO_URL` may override only the selected instance's `127.0.0.1` API port. The wrapper checks the checkout fingerprint and running container image before starting the journeys. These live installation journeys are separate from the isolated functional fixtures in the normal release gate.

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

For a published public GitHub release, `bash scripts/install.sh` from a reviewed
checkout installs the matching CLI for Linux or macOS and creates the local
`subkit` compatibility link. It requires Bash, curl, and OpenSSL with Ed25519 support
(for example OpenSSL 3 on your PATH). It verifies the signed checksum manifest
against the pinned release public key, then verifies the selected binary and both
license assets before replacing an existing installation. It installs `subkit.LICENSE`
and `subkit.THIRD_PARTY_NOTICES.txt` beside the CLI. Missing license assets, missing signatures or unsupported cryptography
stop installation. This path requires publicly downloadable release assets; a local
build or a private repository is not sufficient. The engine-served installer above
is a separate download path from your own installation. It requires the binary,
`LICENSE`, and `THIRD_PARTY_NOTICES.txt` from the same engine bundle or explicit
mirror and verifies each against that source's checksum manifest. Its trust boundary
is your selected engine/mirror; it does not imply GitHub release-signature verification.

The GitHub updater also requires both signed license assets. It updates the notices
beside the binary and retains existing notices with their checksums for rollback.
Older retained versions without notice metadata cannot reconstruct missing historical
license files; their existing rollback behavior remains available.

## Collect ideas and turn them into knowledge

Collect pages and ideas now; decide later what becomes knowledge. Use the shared categories to organize clips, with Inbox as your personal starting default.
You can choose another default category at any time.
The process stays the same: **collect → review in chat → confirm → knowledge**.

Run `sk clipper install` to unpack the Chrome extension shipped inside the CLI.
In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
and select the folder printed by the command. The installer prefills the engine URL
from your active profile. In the extension settings, enter a separate API key with
`intake:read` and `intake:write` access and allow access to your engine host.
The clipper needs no permission to admit knowledge. You can change the engine URL
in its settings; no server address is built into the extension.

Use the toolbar, page context menu, or a shortcut configured at `chrome://extensions/shortcuts`
to collect an article or selected text. The source address is captured automatically.
Review the preview, optionally add why it matters, and press **Collect**. Your default
category is selected, initially Inbox. You can choose an existing category or enter
a new one. Categories are shared with the rest of SubKit; processing status stays separate.
The default belongs to the authenticated identity; a shared API key shares that identity.
Intake visibility follows your tenant's permissions, rather than making categories private.

In the Cockpit, open **Intake** to review and organize collected items using the same
table and category controls as Knowledge Sources. Open an item to see its content
and original source, edit its title, content or category, or start a review chat.
Edits preserve the captured original and require reviewing any affected proposal again.
The chat links
to the item's proposal for confirmation; completed decisions remain in its history.
In a new chat, the category-aware review suggestion helps you review new entries
together. An item's chat action instead reviews only that selected item, using a visible
`@` reference. Chat actions for existing workflows, connectors, runs, sources and skills
also carry a reference to the selected record. You can also ask:
"Look through my new Research entries. Which are
useful to us? Suggest what we should retain as knowledge." The chat prepares a proposal
with the exact content, original sources, and destination. You review it and explicitly
confirm **Admit as knowledge**. Only then can ordinary knowledge retrieval use the result.
You can discard an unneeded clip during review and restore it later; discarding
preserves its original source and never turns it into knowledge.
Changing the proposal or its sources requires another review. The original clip remains
linked to the resulting knowledge. Moving clips or renaming a category never admits its clips. Category changes affecting
a proposal require reviewing it again.

The clipper keeps separate local drafts for each page and engine, including unsent notes.
Opening another page captures that page; use the draft selector to resume unsent edits.
An open clipper follows URL changes and tab switches in its source window. If Chrome
requires access to a new site, open the clipper from that site's toolbar icon. Failed
captures remain local for retry; a repeated request does not create another item.
Original source author and publication time stay separate from who collected the page
and when. Unavailable source metadata remains unknown.

On YouTube, the clipper extracts video metadata, description, and an available original
transcript. Description and transcript can be included separately under Details.
Availability depends on the video and access to captions. Extraction removes navigation
and recommendations without summarizing the content. If no main content can be identified,
the clipper reports that instead of collecting the entire page. Markdown is editable;
the original captured text remains preserved. Image links are retained; image files
are not uploaded.

Run `sk clipper install` after updating the CLI, then reload the extension in Chrome.
Use `sk clipper install --dir <directory> --no-open` to choose a directory and skip
opening Chrome. Updating an existing installation preserves its connection settings.
For a new installation, `--engine-url <url>` overrides the active profile's address.
The engine serves the same embedded archive at `/install/clipper.zip`, with its SHA-256
in the `x-subkit-sha256` response header. HTTPS engines and local HTTP engines on
`localhost`, `127.0.0.1`, or `[::1]` are supported, including an optional URL path prefix.
Changing the engine address requires entering the key for that engine; an existing
draft stays associated with its original engine. Older engines require an update to
support intake; the clipper never falls back to writing directly into knowledge.
Existing knowledge sources remain unchanged, and old local drafts can be explicitly
collected into intake without claiming that edited drafts are original page captures.

## Execution identity and permission

Chat keeps local workflow edits when a saved draft changes concurrently. Saving,
activating and running are separate outcomes. After you activate a prepared change
in DEV, its recorded test inputs can be used for one live test under the existing
execution permission. A request not to run live prevents this continuation. PROD
requires an explicit live-run request. The recorded run shows what actually happened.

The chat's model cost is an approximate calculation from reported provider usage
and configured prices, not an invoice. Its token count includes repeated context
across model calls. Open **Changes** in the lower-left account menu for short release
notes; unpublished changes are listed separately.

`$caller` answers who authenticated this execution. Connector credentials authenticate an outbound request to another service. RBAC decides which workflows and resources that principal may use. Human approval permits a reviewed effect boundary for an environment. These four concepts are independent: a credential or approval does not create caller identity or replace authorization, and the approver need not be the execution caller.

HTTP and MCP runs derive caller identity from their authenticated principal. Trusted callerless webhook and scheduled runs receive `null`; the person who configured or approved them is not automatically their caller. Child workflows retain the parent's caller. Use `required_caller_kind` and `product_id` when a workflow requires a particular authenticated identity, and never infer one from input fields or `request_source`.

Run inspection exposes source, status, workflow version, execution authority, step evidence and a safe `caller` summary through HTTP and MCP. The summary names the stored principal, product, authentication method, channel and origin run without exposing credentials or session identifiers. Missing stored identity is `kind: unknown`; a channel alone cannot identify a caller. HTTP audit queries and MCP `list_audit` can filter by actor and trace. These records provide partial correlation, not a complete caller timeline. See the built-in Core Concepts, Auth Flows and REST API guidance for the contract and its limits.

## Product identity binding

For an OIDC provider configured with `product_id`, an operator first provisions an active tenant user, assigns a minimal custom role and grants only the intended saved workflows. Built-in member roles allow broader workflow execution.

Bind its verified issuer subject with `POST /v1/identity/users/{id}/provider-identities` and JSON `{"provider_id":"<provider-id>","subject":"<verified-subject>"}`. This requires administrator policy and `identity:write`. Tenant, issuer and product come from provider configuration. Exact retries are idempotent; owner, subject, issuer or product conflicts are refused. The endpoint changes neither roles nor grants.

Product providers require this binding and disable account creation and email linking even when signup is globally enabled. Older product bindings need an operator to pin the same owner and subject before login. Unbound providers retain email linking by default; set `link_by_email: false` to disable it. Older unbound bindings pin the configured issuer at their first verified login; this cannot establish historical issuer provenance.

Pins are checked for new logins. Changing provider configuration does not revoke existing browser sessions; revoke those separately or let their configured lifetime expire.

## Product bearer tokens and caller budgets

A native app can call SubKit with its own sign-in instead of a SubKit key. Add an `oidc_bearer` provider and a `products` entry through runtime configuration. Hosts below are placeholders. `audience` and `required_claims` have no defaults; the operator states both for the issuer in use (see "Onboard an app" for the complete checklist). `reject_anonymous` refuses tokens whose `is_anonymous` claim is true.

```json
{
  "auth": {
    "providers": [
      { "protocol": "api_key", "id": "api-key", "label": "SubKit API key" },
      {
        "protocol": "oidc_bearer",
        "id": "app-accounts",
        "label": "App account",
        "issuer_url": "https://idp.example.test",
        "audience": "app-audience",
        "algorithms": ["ES256"],
        "product_id": "app",
        "tenant_slug": "default",
        "required_claims": [
          { "path": "idp", "equals": "primary" },
          { "path": "claims.tier", "equals": "member" }
        ],
        "reject_anonymous": true,
        "clock_tolerance_s": 30
      }
    ]
  },
  "products": {
    "app": {
      "execution_environment": "prod",
      "assistant_workflow_id": "00000000-0000-4000-8000-000000000001",
      "budget_bucket": "assistant"
    }
  }
}
```

The app sends `Authorization: Bearer <access token>`. SubKit reads only that header, never a `token` query parameter. A token is claimed only when it is a compact JWS whose `iss` equals a configured `issuer_url`; SubKit keys, portal tokens, MCP tokens and exchanged tokens are never claimed. SubKit verifies the signature against the issuer's JWKS (from `jwks_uri` or the issuer's OIDC discovery, cached per provider and refetched once for an unknown key), the audience, the algorithm list, `exp`, `iat`, a UUID `sub` and every `required_claims` entry (`path` is a dot path into the verified payload). Anonymous subjects are refused when `reject_anonymous` is true. A claimed token that fails any check answers `401 {"code":"unauthorized","error":"unauthorized","message":"invalid bearer token"}`; no other provider, cookie or key is tried for that request.

The first verified token of a subject provisions a product user with the built-in member role, a placeholder address and an identity binding to the provider, issuer and product; addresses are never linked. The product ceiling then limits the principal to `workflow:run`, `execution:read` and `execution:abort` on saved workflows with the same `product_id` and on its own executions. Product principals have no MCP surface: `/mcp` answers `403 product_caller_forbidden`, and the tool dispatcher refuses every tool outside those three permissions with `policy_denied`. `oidc_bearer` providers never issue API keys or browser sessions and are not listed for browser login. Runs of a product principal always use the product's `execution_environment`; an `x-subkit-environment` header is ignored for them. A run of a product principal verified by an `oidc_bearer` provider is always live: without a live execution authority, an active version or a usable prepared credential it answers 403 with the refusal code instead of running as a held preparation, and `hold_writes: true` answers `403 product_preparation_forbidden`.

A sensitive product workflow with `required_caller_kind: "user"` may declare `execution_guards.caller_daily_limit` (`bucket`, `limit`, IANA `tz`, `$input` path `unit`, `lease_ms`, `billable_steps`, optional JSONata `meter`, `max_metered`, JSONata `commit_when` over the run output, `attach_usage_as`) and `execution_guards.input_bytes` (maximum UTF-8 bytes per `$input` path; a string counts itself, other values their JSON text). Admission checks the sizes and then reserves one unit per caller and local day in the same transaction that creates the execution, after the idempotency replay check; a replay never charges. Later calls of a reserved or committed unit are free until `max_metered` calls were used. A unit runs one call at a time; a call whose cancel was requested no longer counts as running. Refusals carry no execution:

- `429 {"error":"rate-limited","code":"rate_limited","message":"…","usage":{"usedToday":50,"dailyLimit":50}}` when the day is used up,
- `409 {"error":"turn-busy","code":"turn_busy"}` while another run of the unit is queued or running; that run continues, and the same request with the same `idempotency_key` replays it (`idempotent_replay: true`, 202 while it runs) instead of reserving again,
- `429 {"error":"turn-limit","code":"turn_limit"}` once `max_metered` calls were used (every request a billable step sends counts when it is sent),
- `400 {"error":"invalid","code":"invalid"}` for an input part above its byte limit.

When a run ends, a success commits the unit if `commit_when` is true and otherwise keeps it reserved for the next call; a billable step's request marks the unit billable as soon as it is sent, after the execution authority check, so a failure, abort or timeout after that point stays charged; a failed, aborted or timed-out run refunds the unit only when no billable request was sent, no billable step succeeded and no other run of the unit is active. Reservations whose lease expires settle on the next read: billable units commit, others are refunded. A successful run's sensitive result carries `usage: {usedToday, dailyLimit}`. `GET /v1/budget` answers `{usedToday, dailyLimit, day, resetsAt}` for the product's assistant workflow, and `GET /v1/health` answers `{ok, version, model, key}`, where `ok` needs the active workflow, a live execution authority for the product environment and a usable credential on every connector it uses; no secret is read. Both answer 404 to principals without a product. `POST /v1/executions` with a `workflow_id` and no `source` runs that saved workflow, so a product client sends only `{workflow_id, idempotency_key, async, input}`. `GET /v1/executions/{id}` also returns `execution_id` and `error: {code}` for failed or timed-out runs.

`caller_erasure: "on_success"` on such a workflow erases the caller when the run succeeds: budget rows and identity bindings are deleted, sessions and keys revoked, the user disabled and anonymised, the subject removed from its executions' caller context, and a tombstone with only the subject's SHA-256 refuses tokens issued before the erasure. Request steps can address the caller's own record with `${caller.subject}` and the boundary rule `{caller_bound: true}`, which is also accepted on a DELETE. An admin may create a workflow under a fixed `id` so an app can address it without configuration; the id must be unused.

A request step of a saved workflow that runs under a live execution authority, and is not a held preparation, can read its own connector's credential as `${cred.<own-slug>.<field>}` without `connector:read`; the reference must stay inside the approved authority. Draft and step runs, held preparations and saved runs without an authority still need `connector:read` on that connector. The credential is sent only to that connector's origin and never with a redirect. That is the boundary. SubKit also redacts the raw, URL-encoded, form-encoded and JSON-escaped forms of the value from step outputs, errors, audit and logs, but this redaction is a best-effort aid: an upstream that reflects the value in another encoding, or stores it and returns it later, is not covered.

## Onboard an app

This checklist applies to any app that signs its users in at an identity provider and calls SubKit with that provider's access token. Hosts and ids below are placeholders (`example.test`, `<...>`). Work through it in order; the app only needs the product id and the workflow ids at the end.

### 1. Decide

- `product_id`: a lowercase name (`^[a-z][a-z0-9-]{0,62}$`), one per app. It ties provider, workflows, budget rows and the identity binding together.
- `issuer_url`: the provider's issuer, exactly as it appears in the token's `iss` claim. HTTPS outside localhost.
- `audience`: the value the token's `aud` claim carries. Read it from a real token of the app; the issuer defines it, SubKit has no default.
- `required_claims`: who may sign in. Every entry is a dot path into the verified payload with an exact value, for example `{ "path": "idp", "equals": "primary" }`. The key is required. An empty list `[]` admits every token of that issuer and audience and should be a deliberate choice.
- Sign-up by first token: the first verified token of a subject provisions a product user with the built-in member role (see above). If every holder of a valid token may become a user, nothing more is needed. If not, narrow `required_claims` so only the intended accounts qualify.

### 2. Runtime configuration

`auth.providers` is replaced as a whole array. Read the current value first and send it back with the new provider added; otherwise the other providers are removed.

```bash
sk settings get auth.providers --json
sk settings set auth.providers '[
  {"protocol":"api_key","id":"api-key","label":"SubKit API key"},
  {"protocol":"oidc_bearer","id":"<provider-id>","label":"<app> account",
   "issuer_url":"https://idp.example.test","audience":"<audience>","algorithms":["ES256"],
   "product_id":"<product-id>","tenant_slug":"default",
   "required_claims":[{"path":"idp","equals":"primary"}],
   "reject_anonymous":true,"clock_tolerance_s":30}
]'
sk settings get products --json
sk settings set products '{"<product-id>":{"execution_environment":"prod",
  "assistant_workflow_id":"<assistant-workflow-id>","budget_bucket":"<bucket>"}}'
```

`products` is also replaced as a whole object. `assistant_workflow_id` must be the id you choose for the guarded workflow in step 4.

`sk apps show <product-id>` shows what these values add up to once steps 3 to 5 are done; see "Inspect an app" below.

### 3. Connectors

Create one connector per upstream the workflows call: the model API, and the identity provider's admin API if the app deletes accounts. Write each definition as a JSON file without any secret, then:

```bash
sk connectors create --file connector-model.json --skip-checks
sk credentials set <model-connector-id> --mode bearer --token "$MODEL_API_KEY"
sk credentials set <idp-admin-connector-id> --mode header --header "Authorization=Bearer $IDP_ADMIN_KEY,apikey=$IDP_ADMIN_KEY"
```

`--skip-checks` is needed because a definition is probed before it is saved and the credential does not exist yet; `credentials set` probes afterwards. `bearer` sends `Authorization: Bearer <token>`; `header` sends the named headers (comma-separated `Name=Value`). Secrets come from your shell or secret store, never from a file, the app or this repository. A workflow reads its own connector's credential only as `${cred.<own-slug>.<field>}` under an approved authority.

SubKit probes every connector in the background and flags it as signed out when its configured probe answers 401 or 403; workflows that use a flagged connector are blocked until it is signed in again. Without a configured probe, SubKit sends `GET /` to the connector's base URL. Many admin APIs answer 401 or 403 there even with a valid credential, so that answer does not flag the connector: the probe reports `credential_unverified` with the warning `PROBE_AUTH_UNVERIFIED`, `sk connectors test <id>` prints the warning and exits non-zero, and the Cockpit shows "Verbunden · Anmeldung nicht geprüft" with a hint to set a probe path. To verify the credential, give the connector a cheap authenticated read as its probe, for example `"config": {"probe_endpoint": {"method": "GET", "path": "/admin/users?per_page=1", "expected_status": [200, 200]}}`, and check it with `sk connectors test <id>`.

To replace a stored credential, edit the connector in the Cockpit. A header credential with several headers, such as `Authorization` and `apikey` above, shows one field per header name: fill all of them to replace them together, or leave all empty to keep them. Filling only some is refused, so no header is dropped.

### 4. Workflows

Keep the definitions in the app's own repository and create them with operator-chosen ids so the app can hard-code them. A workflow definition accepts `id` (a UUID that must be unused; only an administrator may choose it).

```bash
sk workflows create --file workflows/assistant.json
sk workflows create --file workflows/delete-account.json
```

Each product workflow sets:

- `"id": "<fixed-uuid>"` and `"product_id": "<product-id>"`.
- `"required_caller_kind": "user"` and `"execution_privacy": "sensitive"`.
- On the metered workflow, `execution_guards.caller_daily_limit` (bucket equal to `budget_bucket`, limit, `tz`, unit path) and `execution_guards.input_bytes`.
- On the deletion workflow, `"caller_erasure": "on_success"`.

Division of responsibility. The identity provider owns the account: credentials, e-mail, sign-in methods and the account's existence. SubKit owns only its shadow records of the caller: the identity binding, budget rows, sessions and keys, the user row, the caller context stored on its executions, and the tombstone. The deletion workflow therefore runs in this order:

1. Delete the account at the identity provider with the admin connector, using `${caller.subject}` (bound with `{caller_bound: true}`). A 404 means the account is already gone and counts as success, so a retry is safe.
2. Best-effort revokes at other upstreams, for example a sign-in provider token. A failure here must not block step 3.
3. SubKit erases its own caller data last, through `caller_erasure: "on_success"` when the run succeeds. After it, tokens issued earlier are refused by the tombstone.

If step 1 fails, the run fails, nothing is erased and the app retries with the same `idempotency_key`.

### 5. Approve the execution authority

Without a live execution authority a product run answers 403. A person with write access approves each product workflow once per environment:

1. Open the workflow in Cockpit. A workflow that nothing starts but the app's HTTP calls (no schedule, no webhook) is checked in the environment its connectors live in, so for a production-only workflow the status line reads "Nicht freigegeben" (English: "Not approved") without a repair banner. If a step resolves to a connector in another environment, or a connector is missing, the repair state stays; fix that first.
2. Select "Freigeben…" in the status line, or on the "Freigaben" tab, which shows the same button while no approval is live. The dialog "Freigabe prüfen" opens with that environment already selected in the "Umgebung" field ("Produktion" or "Entwicklung"). Change it only if the product's `execution_environment` is a different one.
3. Review the effect boundary (connectors, addresses, read or write), choose open-ended or limit it by runs and time, and confirm.

The approval follows a newly activated version whose boundary does not grow and is asked for again when it grows. Revoke it on the "Freigaben" tab.

### 6. Verify

Check readiness first. Every check of `sk apps show <product-id>` should read `ok`; a failing check prints its next action.

```bash
sk apps show <product-id>
```

Use a real access token `$TOKEN` of a test account and the workflow ids from step 4. `$BAD_TOKEN` is `$TOKEN` with the last characters of its signature changed. `$BASE` is the engine URL.

```bash
curl -s -w '\n%{http_code}\n' -H "Authorization: Bearer $BAD_TOKEN" $BASE/v1/budget
curl -s -H "Authorization: Bearer $TOKEN" $BASE/v1/health
curl -s -H "Authorization: Bearer $TOKEN" $BASE/v1/budget
curl -s -X POST $BASE/v1/executions -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"workflow_id":"<workflow-id>","idempotency_key":"check-1","async":true,"input":{}}'
```

Expected:

- `$BAD_TOKEN`, a wrong audience, a missing required claim or an expired token answers `401 invalid bearer token`.
- `GET /v1/health` with `ok: false` and a run answering `403` mean the authority from step 5 or a connector credential is missing.
- Using up the daily limit answers `429 rate_limited`; a second call while a unit runs answers `409 turn_busy`; the same `idempotency_key` replays instead.
- `sk executions` and the execution record show the caller summary and the authority used.

Secrets held in connectors can expire: provider client secrets often have a limited lifetime, and admin keys may be rotated. Record each secret's name, connector, owner and expiry date in the app's own repository (not the value), and renew it before expiry: attach the new value with `sk credentials set`, check it, then remove the old one with `sk credentials delete <credential-id>`. A probe with `sk connectors test <connector-id>` shows whether a credential still works. Cockpit and `GET /v1/health` show failing connectors.

Rollback: revoke the execution authority of the workflow (the app then receives 403 and nothing runs), restore the previous `auth.providers` and `products` values you read in step 2, and use `sk workflows history <id>` and `sk workflows restore <id>` for a workflow version. Removing the provider makes the app's tokens unclaimed; existing shadow records stay until the deletion workflow erases them.

### Inspect an app

An app is a read-only view assembled at read time from the `products` entry, the sign-in providers carrying its `product_id`, the workflows whose definition carries it, the users who signed in through it and today's caller budget. It has no storage of its own: changes go through `auth.providers`, `products` and the workflows, as in steps 2 to 5.

```bash
sk apps list                      # app, environment, users, budget today, readiness
sk apps show <product-id>         # settings, sign-in, workflows, users, budget today, readiness
sk apps show <product-id> --json
sk users list --app <product-id>  # users who signed in to that app
```

In Cockpit the same view is the "Apps" tab under "People & access" (German: "Personen & Rechte"); selecting an app opens its details. It is also available as `GET /v1/apps` and `GET /v1/apps/{id}`, and in admin-mode MCP as the read-only tools `list_apps` and `get_app`. All of them need `settings:read`; product principals are always refused with 403. A workspace sees an app when one of its sign-in providers (`tenant_slug`), workflows or signed-in users carries the `product_id`, or when the app's assistant workflow belongs to it; any other id answers 404. An id without a `products` entry is still listed, with `configured: false`.

Readiness consists of six checks, each with a message and, when it fails, a next action: `product_configured`, `sign_in_provider`, `assistant_workflow` (exists in the workspace, carries the `product_id`, is active and valid), `execution_authority` (live for the product's environment), `credentials` (usable on every connector the assistant uses) and `budget_guard` (a `caller_daily_limit` whose bucket equals `budget_bucket`). Budget today shows the units consumed and reserved in the guard's bucket for the current local day, the audited refusals of the app's workflows since local midnight (`rate_limited`, `turn_limit`, `turn_busy`) and when the day resets. Each entry in a user record's `identities` lists provider, `product_id` and last sign-in, without the subject; the placeholder `email` of a product principal still contains it.

### Erase an app user

Erasing removes SubKit's own data about one person for one app: their sign-in bindings, budget counters, sessions and API keys, and the subject in the caller context of past runs. The user record is anonymised and a tombstone makes tokens issued before the erasure be refused; a new sign-in at the provider creates a new, empty app user. A person who also has sign-in links to another app or to SubKit itself is not erased (409), because that would remove that access too. The account at the sign-in provider is not touched; deleting it stays with the app and its identity provider. Erasing is irreversible and needs an explicit confirmation by a person. It needs `identity:write` and an admin role; product principals are refused. The audit entry names the operator as actor with `source: operator_erasure`.

```bash
sk apps show <product-id>                          # lists the user ids of the app
sk apps erase-user <product-id> <user-id>          # asks for confirmation
sk apps erase-user <product-id> <user-id> --yes    # non-interactive; --json prints the result
```

In Cockpit the same action is on the user in the app's details, behind a confirmation dialog. Over HTTP it is `DELETE /v1/apps/{id}/users/{user_id}`, which answers `{ "user_id", "app_id", "erased": true }`, or 404 for an unknown, foreign or already erased user. Apps in MCP stay read-only. `DELETE /v1/identity/users/{id}` is unchanged and only deactivates a user.

Activating a settings revision that adds, removes, reorders or changes a sign-in provider, or adds, removes or changes a `products` entry, writes an audit entry (`auth_provider.*`, `product.*`) that names the provider or product and the changed fields; the changed values are not recorded.

### Generic or per app

| Concern | Where it lives |
| --- | --- |
| Token verification, binding, budgets, erasure, authority checks | Engine code, identical for every app |
| Provider entry, `products` entry, connectors and their credentials | Runtime configuration per deployment, set with `sk` |
| Workflow definitions and their fixed ids | The app's own repository, created with `sk workflows create` |
| Execution authority approvals | A person, per workflow and environment, in Cockpit |
| Secret expiry records | The app's own repository (metadata only) |

## Supabase-backed product workflows

This section covers the `supabase` connector only; it does not depend on which identity provider signs the app's users in. Use Supabase through the `supabase` connector and ordinary workflow authoring; workflows do not need direct PostgreSQL access or SQL steps. Store required gateway headers as encrypted connector credentials. `apikey` is the public project key; `Authorization` carries the JWT for the intended database role. A tenant-wide connector credential cannot represent separate mobile users; never pass an app user's JWT as workflow input. Use an owner-binding RPC that maps immutable `$caller` when a workflow needs user-owned data. A protected server-to-server RPC may additionally require `x-subkit-token`, stored only on the connector. It authenticates SubKit to the product backend; it is not the end user's identity and never replaces the workflow's immutable `$caller`. Never put credentials in app code, workflow inputs or steps, client context, generated workflow source, or logs. Do not use `service_role` for caller-scoped access because it bypasses RLS. Bind product workflows to their product and required caller kind, derive owner identifiers from `$caller`, and fail closed when an atomic authorization or quota reservation does not explicitly permit the next step.

## External MCP OAuth credentials

For external MCP connectors using `oauth2_client_credentials` or
`oauth2_private_key_jwt`, configure the trusted authorization server URL as
`config.mcp.auth.issuer` before connecting. SubKit refuses to use these credentials
without that binding. Discovery cannot redirect a client secret or signed assertion
to another authorization server.

Interactive MCP OAuth stores the authorization-server issuer with the encrypted
client information and tokens. Older saved credentials without an issuer are not
reused. Providers with dynamic client registration can start a new sign-in through
the connector's OAuth setup. Recovery of older confidential clients at providers
without dynamic registration is not yet verified through the public setup APIs;
do not assume that entering an issuer restores those saved credentials. Keep such
connections out of the rollout until their recovery has been verified. Do not edit
stored credentials to bypass this check. Changing discovery metadata does not
migrate existing credentials, and a new sign-in never inherits a refresh token
issued by a different server. Review provider changes before authorizing them;
the binding does not establish that a newly selected provider is trustworthy.

## Use sk from a coding agent

```bash
claude mcp add --transport http --scope user sk http://localhost:3000/mcp --header "Authorization: Bearer ${SK_API_KEY}"
codex mcp add sk --url http://localhost:3000/mcp --bearer-token-env-var SK_API_KEY
sk agent init --domains <category>   # in a repository: briefs each Claude Code and Codex session on that domain
```

Use MCP for approved sk tools; run `sk agent init` to declare repository domains and install the Claude Code and Codex hooks that supply shared-memory briefings. Hooks can resolve a current folder name to known domains when no explicit declaration exists. Both use the same authenticated sk profile as the CLI.

### Set up and verify briefings

MCP registration is a one-time machine setup. In each repository, run `sk agent init --domains <category>[,<category>]` and commit `.sk/agent.json` so every checkout uses the same domains. A domain can be a catalog category or a `domain:<slug>` tag. `init` merges requested domains without removing existing domains or settings, and wires Claude Code and Codex SessionStart, UserPromptSubmit and SessionEnd hooks. Codex transcript capture runs asynchronously to fit its three-second hook limit. Both clients and the sk REPL share an 1,800-token briefing budget and 9,500-character hard limit. `--skip-claude` and `--skip-codex` leave that client's settings untouched.

Run `sk status`, then `sk agent briefing --json` from the repository to verify the declaration, credentials, engine connection and returned briefing. Use the JSON fields `domains`, `knowledge_sources`, `skills_full` and `used_tokens` to inspect the result. Empty `knowledge_sources` or `skills_full` means the briefing works but those items are not assigned to the declared domain. Put knowledge and skills in the domain's catalog category or tag them `domain:<slug>`.

Hooks first read `.sk/agent.json` when present. Otherwise, they match the current folder's normalized name exactly against readable project categories. A unique match creates `.sk/agent.json` with that project area and shared SubKit context when available. When no unique project area matches but shared SubKit context is available, the hook creates a shared-only declaration and asks which project knowledge sources and workflows belong there when setup is relevant. If neither is available, it asks before guessing or creating a declaration. Hook-created declarations stay marked as inferred, so later sessions continue checking the folder name as the readable catalog changes. Treat `inferred` and `inferred_folder_domain` as hook-managed fields. To make an inferred declaration explicit and maintain it yourself, remove both fields and edit `domains`; legacy inferred declarations are migrated by treating the first non-`subkit` domain as the inferred folder domain. A prompt can add other matching domains as the task changes. This works with or without Git metadata. The briefing tells the agent which declaration it created. Each successful briefing gives the model bounded domain context and shows a short, language-neutral status; oversized context is shortened with a visible warning. The model can offer relevant reviews in the language of your conversation; suggestions remain pending until a person reviews them. If the briefing is unavailable, the client shows a simple warning and continues the session. Use `/hooks` in Claude Code or Codex to see whether hooks are active. Codex hooks are enabled by default; no `config.toml` edit is normally needed. Review and trust new or changed SubKit hooks in `/hooks`. If hooks are disabled, inspect the effective feature setting and administrator policy before changing settings; see the [official Codex hook guide](https://learn.chatgpt.com/docs/hooks). Both clients send a transcript for candidate learning at SessionEnd. Codex capture runs in a detached process because its hook deadline is three seconds. Captured learnings remain candidates until a person reviews them.

For open-ended check-ins, the briefing uses the current project's matched domain together with shared SubKit context, plus connected sources that best answer the question. It distinguishes live service state from repository changes and static knowledge, prioritizes blocked or failing work and imminent deadlines, and gives up to three specific next steps in the user's language. Maintenance suggestions must be grounded in repository instructions, explicit plans or TODOs, and observed issues such as failing checks or generated-file drift. Relevant knowledge sources and workflows from the folder's domain are recommended by name when they help with a concrete task. It reports when a relevant source is unavailable.

### Review collected material with your coding agent

Collected pages remain material to review. With `intake:read`, the briefing adds
a short tenant-wide count of collected entries and pending knowledge proposals.
It does not load their text, treat them as instructions, or claim they belong to
the repository's domain. Without that permission the reminder is omitted.

Ask: "Review the new entries in Research. Which are useful? Propose what we should
keep as knowledge." Review uses a saved SubKit conversation. MCP clients start
it through `conversation_start`; `intake_item_ids` selects particular clips and
keeps that selection fixed. The returned Cockpit link continues the same review.
Item-reading and proposal tools need this saved conversation and cannot run as
standalone MCP calls. The clipper's API key needs only intake read/write;
the person confirming a proposal needs `intake:confirm` and `knowledge:write`.

From the terminal, `sk intake list` shows collected items in your default category. Use
`sk intake list --category research` to see collected items and
`sk intake review --category research` to start their review. Without a
selection, review uses your default category. `--items <comma-separated-ids>`
selects particular entries; `--json` returns machine-readable results. The command
prints the Cockpit link for continuing the conversation and reviewing proposals.
Use `sk intake default --category research` to change your personal default,
`sk intake move --item <id> --category research` to organize an entry, and
`sk intake discard --item <id>` or `sk intake restore --item <id>` to change its
review state. These actions preserve the original clip and never admit knowledge.

The proposal shows its sources, exact text and knowledge destination. An existing
destination keeps its topic assignment. For a new destination, include the topic
category or `domain:<slug>` tag in the reviewed proposal so the resulting knowledge
can appear in the intended repository briefing. Changing that assignment requires
reviewing the changed proposal. After confirmation, run `sk agent briefing --json`
to check `knowledge_sources`, then search for the accepted material. The original
clip remains linked. A new session loads the updated briefing.

### Verify an installed intake API

During intake development, `bun run verify:intake` runs the focused type,
domain, HTTP, briefing, MCP, CLI and browser checks, including a real local
PostgreSQL/API smoke flow. It avoids the repository-wide test suite. Visual acceptance is performed manually;
automated verification retains functional browser checks without a visual matrix.

`bun run verify:intake-live` checks a selected server through its public API.
Set `SK_ENGINE_URL` and `SK_INTAKE_TEST_KEY` outside the repository. The default
run is read-only and reports compatibility, readiness and the delivered archive.
It is separate from the local `bun run verify` gate.

For a synthetic write check, use a dedicated test tenant and its user key:
add `--allow-writes --test-tenant-id <uuid> --run-id <unique-run-name>
--json <report-path>`. The tenant must match the authenticated identity. The
check collects in its own category, tests exclusion before confirmation,
exact confirmation and retry, provenance, search and the domain briefing.
It reports timings and retained resource IDs. Intake has no deletion API, so
test records remain for inspection. This API check does not measure model
judgment or replace a real browser/chat verification. It never deploys code.

## License

MIT

## Build asset verification

Engine builds fetch the embedding model from the immutable revision in
`vendor/embedding-assets.json`. Every model and ONNX runtime asset must match its
recorded byte length and SHA-256 checksum, including files already cached locally.
Downloads replace an existing file only after verification; unexpected runtime
package contents fail the build. Valid cached assets do not require a network fetch.

When intentionally updating the model or runtime dependency, verify the upstream
revision, license and asset provenance before updating this manifest. Do not accept
a newly downloaded checksum merely to clear a failed build. Asset-manifest changes
also invalidate the local demo build receipt.

## Sandbox data tools

JavaScript workflow transforms can use bounded, synchronous `sk` helpers. They
perform no network, filesystem or credential access. Namespaces are immutable.
Promises and unseeded randomness are unsupported; use the execution clock and
`sk.uuid()` for repeatable values.

| Task | Helpers | Contract |
| --- | --- | --- |
| Decimal amounts | `sk.money.add/sub/mul/div/round/compare` | Decimal strings; `div` and `round` require scale and `down`, `halfUp`, `halfEven` or `up`. No currency conversion. |
| CSV | `sk.csv.parse/stringify` | Explicit delimiter/header options; export escapes spreadsheet formulas by default. Up to 10,000 rows. |
| Dates | `sk.date.parse/format/add/startOf/convertZone` | Date-only values stay dates. Local datetimes require an IANA zone; ambiguous or missing DST times require explicit `earlier`/`later`. |
| Validation | `sk.schema.validate/assert`, `sk.assert` | Local schema references only; no remote resolution or asynchronous validators. |
| URLs | `sk.url.parse/build/query/encode/decode` | WHATWG parsing, repeated query entries, UTF-8 percent encoding. No requests. |
| XML | `sk.xml.parse/build` | Ordered `{name, attributes, children}` trees retain mixed text; no DTD or custom entities. |
| Text and records | `sk.template.render`, `sk.diff.records` | Escaped HTML by default, explicit text mode; bounded list sections. Record diff requires a unique key. |

```javascript
return {
  total: sk.money.add("19.90", "4.95"),
  csv: sk.csv.stringify([{ name: "Ada", amount: "24.85" }]),
  tomorrow: sk.date.add("2024-02-28", 1, "days"),
  greeting: sk.template.render("Hello {{name}}", { name: "Ada" })
};
```

Text inputs and outputs are limited to 1 MiB, structures to 100,000 nodes and
64 levels. Existing sandbox memory, execution and output budgets still apply.
Each helper is embedded and loaded on first access in each sandbox;
regenerate it with `bun run gen:sandbox-tools` and check it with
`bun run check:sandbox-tools-drift`. Package versions and timezone data are pinned
in the lockfile. These tools do not add document rendering, OCR or a browser.
JavaScript transforms, JSONata and binary parsing use bounded worker processes.
The default lane can run two workers in parallel; hooks have a separate lane.
Per-engine-process global and per-tenant queue limits apply across default and
hook workers.
The RSS watchdog is available on Linux; it is a polling limit rather than a
kernel-enforced memory ceiling.

## Runtime measurements

`bun run benchmark:runtime:smoke` records local correctness, latency, throughput,
fault recovery and sampled process-family memory. Use
`bun scripts/runtime-benchmark.ts compare --baseline <baseline.json> --candidate <candidate.json> --output <directory>`
to produce JSON, HTML and SVG evidence. Retain the original source, lockfile and
runtime with each baseline; do not compare measurements from different machines.

`bun run benchmark:runtime:full` uses five repetitions, a 60-second warmup and
180-second measurement windows at concurrency 1, 4, 16 and 64. Reference performance
acceptance requires Linux x64, four CPUs and at least 8 GiB RAM. Local smoke
results do not establish that acceptance. Tail percentiles require adequate
samples; errors and timeouts remain in the report. Read each report's coverage
and environment limitations before interpreting a pass.

`bun run benchmark:runtime:release` captures a candidate only; it does not issue a
release verdict. It focuses on the eight release-gated JavaScript
and JSONata measurements, with five repeats, a two-second warmup and a 30-second
measurement window per run. Run paired baseline and candidate captures with
`bun scripts/runtime-benchmark.ts paired --profile release --baseline-source <baseline-checkout> --candidate-source <candidate-checkout> --output <directory>`
on the same reference machine. Capacity acceptance requires p95 no higher than
100 ms at concurrency one and four, at least 100 successful operations per second
at concurrency four, no errors, timeouts or rejections, 10,000 sampled successful observations and five paired repetitions for each
gated measurement, on both baseline and candidate. This is an explicit fixed
capacity budget, not a measurement of production load. The report separately
preserves the historical relative latency and throughput comparison:
per-call process isolation has an unavoidable transport cost, so that comparison
remains evidence of a tradeoff rather than the release-capacity decision. The
reference-machine requirement and every correctness check still apply. Latency
samples use a bounded deterministic reservoir; event counts and throughput use
all observations. A paired or compare command exits unsuccessfully on failed or
inconclusive acceptance; the short smoke in `bun run verify` checks correctness
and transport recovery but does not establish release capacity.
Before `bun run release:tag`, set `SUBKIT_RUNTIME_BASELINE_MANIFEST` and
`SUBKIT_RUNTIME_CANDIDATE_MANIFEST` to the retained paired reference manifests.
The tag command requires a passing capacity comparison and verifies that the
candidate runtime-source subset and lockfile hashes match the checkout being released.
