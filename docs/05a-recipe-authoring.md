# Recipe authoring

Recipes are pre-authored workflows attached to connector templates. The
LLM clones a recipe via `start_workflow_from_recipe(template_slug,
recipe_slug)` instead of synthesizing a workflow from scratch — the
difference between a 30-second authoring loop and a multi-turn debugging
spiral.

This guide is the authoring contract: the schema, the conventions, the
quality gate, and the promotion checklist.

## Where recipes live

Every recipe ships inline on its connector template at:

```
apps/engine/src/connectors/templates.json   # 105 templates, 248 recipes
```

The schema is defined at:

```
apps/engine/src/connectors/templates.ts:222  # ConnectorRecipeSchema
```

Recipes are read-only at runtime. Tenant-scoped per-recipe overrides
are planned via a `connector_recipes` table; today, every operator
sees the same shipped catalog.

## Schema

| Field | Required | Default | Purpose |
|---|---|---|---|
| `slug` | yes | — | unique within the template; lowercase-kebab |
| `title` | yes | — | human-readable; verb-led when there is an action |
| `description` | yes | — | one-paragraph summary; the LLM reads this in `inspect_recipe` |
| `intent_keywords[]` | yes | `[]` | 3-7 phrases the LLM ranks user prompts against |
| `derived_from_skill` | no | `null` | pointer to `template-skills.json` slug for skill-schema gating |
| `category` | yes | `"other"` | mirrors the connector category enum (`crm`, `payments`, `database`, etc.) |
| `tags[]` | no | `[]` | shape labels (`"webhook"`, `"daily-digest"`, `"notification"`) |
| `difficulty` | no | `"intermediate"` | `beginner` / `intermediate` / `advanced` |
| `estimated_setup_minutes` | no | `5` | time-to-first-save after cloning |
| `prerequisites[]` | no | `[]` | external setup the operator must have ready |
| `sample_input` | no | `null` | canonical JSON satisfying `workflow.input_schema` |
| `expected_output_preview` | no | `null` | redacted output example for `inspect_recipe` |
| `required_connectors[]` | no | `[]` | multi-connector binding (see below) |
| `version` | no | `"1.0.0"` | semver; bump on shape changes |
| `author` | no | `"subkit-builtin"` | provenance |
| `last_validated_at` | no | `null` | ISO date when last dry-run against vendor sandbox |
| `deprecated` | no | `null` | `{ since, replacement_slug }` when superseded |
| `workflow` | yes | — | full workflow validated through `WorkflowDefSchema` |

## Conventions

### `intent_keywords`

The lint script (`scripts/lint-recipes.ts`) enforces:

- **Length 3-7.** Fewer than 3 means the LLM has nothing to rank
  against; more than 7 inflates per-turn tokens for marginal lift.
- **Lowercased.** Matched lowercase against the user prompt.
- **No single-word duplicate of a title word.** "List GitHub issues" +
  keyword `"issues"` adds zero ranking signal — replace with `"list
  issues"` or `"open issues"`.

Good keywords describe the operator's *phrasing*, not the recipe's
mechanics: `"recent customers"`, `"who paid me last month"`. Bad
keywords describe the workflow shape: `"GET /v1/customers"`.

### `tags`

Free-form labels for ranking and pack assembly. Common tags:

- Trigger shape: `"webhook"`, `"schedule"`, `"request"`.
- Pattern: `"daily-digest"`, `"approval"`, `"sync"`, `"backfill"`,
  `"reverse-etl"`.
- Vertical: `"revops"`, `"customer-success"`, `"finance"`, `"devops"`,
  `"security"`.

Tags ARE matched by the recipe-pack endpoints (`GET
/v1/recipe-packs/{vertical}`); be deliberate.

### `sample_input`

When the recipe has an `input_schema` with required fields, lint enforces
that `sample_input` covers every required key. Keep the values realistic
(don't use `"foo"` / `"bar"`) — the LLM uses `sample_input` to populate
the cloned draft's first dry-run.

### `expected_output_preview`

Redact PII / secrets. Operators see this in `inspect_recipe` to confirm
a recipe matches intent before paying for `start_workflow_from_recipe`.

### Multi-connector recipes (`required_connectors`)

Recipes that span more than one connector declare each placeholder up
front:

```json
"required_connectors": [
  { "placeholder": "00000000-0000-0000-0000-000000000001", "template": "stripe" },
  { "placeholder": "00000000-0000-0000-0000-000000000002", "template": "slack" }
]
```

Inside `workflow.steps[*].connector_id`, use the placeholder UUID
matching the template the step targets.
`start_workflow_from_recipe` walks `required_connectors`, asks the
operator for one connector binding per placeholder, then deep-clones
the workflow with each placeholder rebound to a saved connector id.

Lint enforces that every declared placeholder appears at least once in
the workflow's steps.

### Single-connector recipes (the legacy path)

The legacy `00000000-0000-0000-0000-000000000000` placeholder still
works when `required_connectors` is empty — the clone tool's single
`connector_id` arg rebinds it. Use this for SQL / Postgres recipes
that cannot express the connector via a `base_url` placeholder.

## Walkthrough — request/response recipe (Stripe `create-customer`)

```json
{
  "slug": "create-customer",
  "title": "Create a Stripe customer",
  "description": "Create a customer with email + optional metadata. Returns the new customer id.",
  "intent_keywords": ["create customer", "new customer", "add stripe customer"],
  "derived_from_skill": "stripe-basics",
  "category": "payments",
  "tags": ["create"],
  "difficulty": "beginner",
  "estimated_setup_minutes": 3,
  "prerequisites": ["Stripe API key with `write` scope"],
  "sample_input": { "email": "billing@acme.test", "metadata": { "tier": "pro" } },
  "expected_output_preview": { "id": "cus_***", "email": "billing@acme.test" },
  "required_connectors": [],
  "version": "1.0.0",
  "author": "subkit-builtin",
  "last_validated_at": null,
  "deprecated": null,
  "workflow": {
    "name": "stripe-create-customer",
    "input_schema": {
      "type": "object",
      "required": ["email"],
      "properties": {
        "email": { "type": "string" },
        "metadata": { "type": "object" }
      }
    },
    "steps": [
      {
        "kind": "request",
        "id": "create",
        "method": "POST",
        "url": "${connector.stripe.base_url}/customers",
        "headers": { "content-type": "application/json" },
        "body": {
          "email": "${input.email}",
          "metadata": "${input.metadata}"
        },
        "idempotency_key": "${input.email}"
      }
    ]
  }
}
```

## The `trigger` block

`workflow.trigger` is a discriminated union over `kind` — `request`,
`webhook`, or `schedule`. Omitting it is equivalent to
`{ "kind": "request" }`, which is what every recipe shipped before the
trigger field existed assumes. Setting `webhook` or `schedule` reverse-binds
an inbound binding or cron schedule on save and removes it on delete or
version rotate, so the recipe is self-contained — operators do not need
a separate `sk schedule create` or webhook-registration step.

The schema source of truth is
[`apps/engine/src/workflows/types.ts`](../apps/engine/src/workflows/types.ts)
(`RequestTriggerSchema`, `WebhookTriggerSchema`, `ScheduleTriggerSchema`);
runtime semantics are documented in
[`docs/06-execution.md`](06-execution.md#triggers).

When you author a webhook or schedule recipe, tag it with
`"trigger:webhook"` or `"trigger:schedule"` so the recipe-pack endpoints
can group it correctly.

## Walkthrough — webhook-triggered recipe (Stripe `charge.failed` → Slack)

This is the shipped `stripe.on-charge-failed-notify-slack` recipe (from
`apps/engine/src/connectors/templates.json`). It reverse-binds an inbound
binding on save: when Stripe posts `charge.failed` to the workflow's
inbound URL, the engine verifies the Stripe signature, extracts the
failed-charge fields, and posts a redacted alert into the operator's
Slack channel.

```json
{
  "slug": "on-charge-failed-notify-slack",
  "title": "On Stripe charge.failed, post a Slack alert",
  "description": "Webhook-triggered: when Stripe fires `charge.failed` against the workflow's inbound URL, this recipe verifies the Stripe signature, extracts the failed-charge fields (id, amount, currency, decline reason, customer email), and posts a redacted alert into the operator's chosen Slack channel. Demonstrates the workflow `trigger: { kind: 'webhook' }` block end-to-end.",
  "intent_keywords": [
    "charge failed slack",
    "stripe failure alert",
    "notify slack on failed charge",
    "stripe webhook alert"
  ],
  "derived_from_skill": "stripe-basics",
  "category": "payments",
  "tags": ["webhook", "trigger", "alerting", "demonstration"],
  "difficulty": "advanced",
  "estimated_setup_minutes": 12,
  "prerequisites": [
    "Stripe webhook endpoint signing secret (whsec_...) configured on the bound webhook row",
    "Slack bot token connector with chat:write scope",
    "Slack channel id where the alert should land"
  ],
  "required_connectors": [
    { "placeholder": "7d046f2e-9c40-4b8a-aa14-ff3eb87b5046", "template": "slack" }
  ],
  "workflow": {
    "name": "stripe-on-charge-failed-notify-slack",
    "description": "Triggered by an inbound Stripe `charge.failed` webhook; posts a redacted alert into the operator's Slack channel.",
    "trigger": {
      "kind": "webhook",
      "source": "stripe",
      "events": ["charge.failed"],
      "verify": "stripe-signature"
    },
    "input_schema": {
      "type": "object",
      "required": ["body", "alert_channel"],
      "properties": {
        "body": { "type": "object", "required": ["data", "type"] },
        "alert_channel": {
          "type": "string",
          "description": "Slack channel id (e.g. C0123ALERT) where the alert should be posted."
        }
      }
    },
    "steps": [
      {
        "kind": "transform",
        "id": "extract",
        "language": "javascript",
        "expression": "const o = input.input.body.data.object; return { charge_id: o.id, amount: o.amount, currency: o.currency, failure_code: o.failure_code, failure_message: o.failure_message, email: o.billing_details.email };"
      },
      {
        "kind": "request",
        "id": "post",
        "method": "POST",
        "connector_id": "7d046f2e-9c40-4b8a-aa14-ff3eb87b5046",
        "url": "${connector.slack.base_url}/chat.postMessage",
        "headers": { "Content-Type": "application/json; charset=utf-8" },
        "body": {
          "channel": "${input.alert_channel}",
          "text": "[stripe] charge.failed — ${scope.extract.data.currency} ${scope.extract.data.amount} — ${scope.extract.data.failure_code} — ${scope.extract.data.email} — ${scope.extract.data.charge_id}"
        }
      }
    ]
  }
}
```

Notes for authors:

- `verify: "stripe-signature"` requires the inbound binding to carry the
  `whsec_...` signing secret. The driver rejects unsigned or
  signature-mismatched posts before any step runs.
- `events: ["charge.failed"]` filters at the inbound driver, so noisy
  events never reach `runExecution()`. Use `[]` only when the workflow
  legitimately needs every event from `source`.
- The `input_schema` documents what the engine guarantees the workflow
  scope holds at step time — `body` is the verified Stripe payload and
  `alert_channel` is the per-tenant Slack channel id supplied at bind
  time.

## Walkthrough — schedule-triggered recipe (daily charges digest)

This is the shipped `stripe.daily-charges-digest` recipe. Saving it
upserts a `workflows_schedules` row keyed on `(tenant_id, workflow_id)`;
the scheduler reconciler wakes the workflow up at 08:00 Europe/Berlin on
business days and skips the listed German bank holidays for 2026. No
external cron, no `sk run` loop.

```json
{
  "slug": "daily-charges-digest",
  "title": "Daily charges digest (08:00 Europe/Berlin, business days only)",
  "description": "Pull yesterday's charges every business day at 08:00 Europe/Berlin and summarise total volume + count by currency. Skips weekends and the dates listed in `skip_dates` (German bank holidays seeded for 2026). Wired through the schedule trigger so the workflow wakes itself up — no external cron, no `sk run` loop.",
  "intent_keywords": [
    "daily charges digest",
    "scheduled charges report",
    "yesterday charges",
    "daily revenue summary"
  ],
  "derived_from_skill": "stripe-basics",
  "category": "payments",
  "tags": ["scheduled", "trigger:schedule", "digest"],
  "difficulty": "intermediate",
  "estimated_setup_minutes": 8,
  "prerequisites": [
    "Stripe connector with read access to /v1/charges",
    "Schedule trigger requires the engine's scheduler reconciler to be running"
  ],
  "required_connectors": [],
  "workflow": {
    "name": "stripe-daily-charges-digest",
    "description": "Pull yesterday's charges and summarise by currency. Wakes itself up at 08:00 Europe/Berlin every business day.",
    "trigger": {
      "kind": "schedule",
      "cron": "0 8 * * *",
      "tz": "Europe/Berlin",
      "business_days_only": true,
      "skip_dates": [
        "2026-01-01",
        "2026-04-03",
        "2026-04-06",
        "2026-05-01",
        "2026-05-14",
        "2026-05-25",
        "2026-10-03",
        "2026-12-25",
        "2026-12-26"
      ]
    },
    "steps": [
      {
        "kind": "request",
        "id": "list",
        "method": "GET",
        "url": "${connector.stripe.base_url}/charges",
        "query": { "limit": 100 },
        "pagination": {
          "strategy": "cursor",
          "cursor_request_param": "starting_after",
          "cursor_response_path": "data[last].id",
          "page_size": 100
        }
      },
      {
        "kind": "transform",
        "id": "summary",
        "language": "javascript",
        "expression": "const charges = input.scope.list.data.body.data; const byCurrency = {}; for (const c of charges) { const g = (byCurrency[c.currency] ??= { count: 0, amount_total: 0 }); g.count += 1; g.amount_total += c.amount; } return { count: charges.length, by_currency: byCurrency };"
      }
    ]
  }
}
```

Notes for authors:

- `cron` is the standard 5-field expression (`m h dom mon dow`); the
  reconciler also accepts the engine's `every:N` shorthand for sub-minute
  cadences.
- `tz` must be a valid IANA timezone — the reconciler hands it to
  pg-boss so the firing lands at the operator's local wall-clock time
  instead of UTC.
- `business_days_only` skips weekends. Holiday calendars are NOT
  inferred — declare every freeze date explicitly via `skip_dates`. The
  reconciler compares each entry against the trigger's `tz` so a date
  here means "this calendar day in the workflow's timezone".
- A schedule recipe typically has `sample_input: null` because the
  scheduler itself supplies no payload — the workflow reads its inputs
  from the connectors it queries.

## Walkthrough — auth-chain recipe (mint then use)

This is the shipped `firebase.signin-email-password-then-firestore-read`
recipe. It demonstrates the canonical *mint then use* shape for any
non-OAuth2 username/password JWT flow — Firebase Auth REST, Cognito
InitiateAuth (when not handled by the connector's OAuth2 grant),
generic POST `/login` endpoints, etc. Two patterns are load-bearing:
**redacted secret outputs** and **dot-path scope substitution** in
downstream headers.

```json
{
  "slug": "signin-email-password-then-firestore-read",
  "workflow": {
    "name": "firebase-signin-email-password-then-firestore-read",
    "steps": [
      {
        "kind": "request",
        "id": "signin",
        "method": "POST",
        "url": "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword",
        "query": { "key": "${input.api_key}" },
        "body": {
          "email": "${input.email}",
          "password": "${input.password}",
          "returnSecureToken": true
        },
        "outputs": {
          "idToken": { "secret": true },
          "refreshToken": { "secret": true }
        }
      },
      {
        "kind": "request",
        "id": "read_document",
        "method": "GET",
        "url": "https://firestore.googleapis.com/v1/projects/${input.project_id}/databases/(default)/documents/${input.collection}/${input.document_id}",
        "headers": {
          "Authorization": "Bearer ${scope.signin.idToken}"
        }
      }
    ]
  }
}
```

Notes for authors:

- **`outputs.<path>.secret = true`** marks the field for redaction in
  audit log, step preview, and offload — but the raw value stays in the
  in-memory scope so downstream steps can still substitute it. Reach for
  this on every minted token (`idToken`, `access_token`,
  `AuthenticationResult.IdToken`, `AssumeRoleResult.Credentials.SessionToken`).
- **`${scope.<step_id>.<dot.path>}`** is dot-notation, NOT JSON-pointer.
  Nested paths work transparently:
  `${scope.signin.idToken}` (top-level) and
  `${scope.assume.AssumeRoleResult.Credentials.AccessKeyId}` (nested) both
  resolve via repeated property lookup.
- The first step has no `connector_id` substitution because the auth API
  lives at a fixed URL distinct from the protected resource. Use the
  hard-coded URL in step 1 and `${connector.<slug>.base_url}` (or another
  hard-coded URL) in step 2.
- When the protected resource API is reachable via a connector with an
  existing auth mode (`oauth2` Authorization Code, `oauth2` Password
  Grant, `aws_sigv4`, `bearer`, etc.), prefer that mode over a hand-wired
  two-step chain — the connector's `refreshIfStale()` handles minting
  transparently and the workflow stays single-step. Use this two-step
  pattern only when no built-in auth mode fits the provider's flow.

## Quality gate

Every recipe-touching PR runs:

```sh
bun run lint:recipes        # recipe lint
bun run test:unit           # includes recipe-snapshot.test.ts
bun run verify:ai           # includes recipe-discovery validator
```

`lint-recipes` enforces:

- `category` is set and a member of `RecipeCategoryEnum`.
- `intent_keywords` is 3-7, lowercase, no title-word duplicates.
- `sample_input` covers `input_schema.required` when both are set.
- `required_connectors` placeholders all appear in `workflow.steps`.
- Per-primitive coverage of `WorkflowDefSchema` step kinds (catches
  regressions when a previously-demonstrated primitive drops to zero
  recipes).

## Promotion checklist

Before opening a PR:

1. Recipe loads through `loadBuiltinTemplates()` without throwing.
2. `bun run lint:recipes` is green.
3. `intent_keywords` reflects how the operator would phrase the
   request, not the workflow's mechanics.
4. `sample_input` is realistic (no `"foo"` / `"bar"` placeholders).
5. If the recipe was dry-run against a vendor sandbox, set
   `last_validated_at` to today's ISO date.
6. If you are deprecating an existing recipe, set `deprecated` rather
   than deleting the slug — operators may have cloned drafts that
   reference it.
7. PR description names the operator pain the recipe solves. The
   recipe must beat any industry equivalent on validation,
   prerequisites clarity, or step efficiency — not just match.

## Related

- `docs/05-connectors.md` — connector templates (parent surface).
- `apps/engine/src/connectors/AGENTS.md` — connector subsystem rules.
- `scripts/lint-recipes.ts` — quality lint source.
- `scripts/migrate-recipe-schema-v2.ts` — F1 migration script
  (archival, runs once).
