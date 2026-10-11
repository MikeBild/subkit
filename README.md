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

## Supabase-backed product workflows

Use Supabase through the `supabase` connector and ordinary workflow authoring; workflows do not need direct PostgreSQL access or SQL steps. Store required gateway headers as encrypted connector credentials. `apikey` is the public project key; `Authorization` carries the JWT for the intended database role. A tenant-wide connector credential cannot represent separate mobile users; never pass an app user's JWT as workflow input. Use an owner-binding RPC that maps immutable `$caller` when a workflow needs user-owned data. A protected server-to-server RPC may additionally require `x-subkit-token`, stored only on the connector. It authenticates SubKit to the product backend; it is not the end user's identity and never replaces the workflow's immutable `$caller`. Never put credentials in app code, workflow inputs or steps, client context, generated workflow source, or logs. Do not use `service_role` for caller-scoped access because it bypasses RLS. Bind product workflows to their product and required caller kind, derive owner identifiers from `$caller`, and fail closed when an atomic authorization or quota reservation does not explicitly permit the next step.

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

Hooks first read `.sk/agent.json` when present. Otherwise, they match the current folder's normalized name exactly against readable project categories. A unique match creates `.sk/agent.json` with that project area and shared SubKit context when available. When no unique project area matches but shared SubKit context is available, the hook creates a shared-only declaration and asks which project knowledge sources and workflows belong there when setup is relevant. If neither is available, it asks before guessing or creating a declaration. Hook-created declarations stay marked as inferred, so later sessions continue checking the folder name as the readable catalog changes. Treat `inferred` and `inferred_folder_domain` as hook-managed fields. To make an inferred declaration explicit and maintain it yourself, remove both fields and edit `domains`; legacy inferred declarations are migrated by treating the first non-`subkit` domain as the inferred folder domain. A prompt can add other matching domains as the task changes. This works with or without Git metadata. The briefing tells the agent which declaration it created. Each successful briefing gives the model bounded domain context and shows a short, language-neutral status; oversized context is shortened with a visible warning. The model can offer relevant reviews in the language of your conversation; suggestions remain pending until a person reviews them. If the briefing is unavailable, the client shows a simple warning and continues the session. Use `/hooks` in Claude Code or Codex to see whether hooks are active. Codex also requires `[features] hooks = true` in `~/.codex/config.toml` and one-time trust in its `/hooks` UI. Both clients send a transcript for candidate learning at SessionEnd. Codex capture runs in a detached process because its hook deadline is three seconds. Captured learnings remain candidates until a person reviews them.

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
