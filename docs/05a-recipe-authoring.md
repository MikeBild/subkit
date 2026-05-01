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
apps/engine/src/connectors/templates.json   # 95 templates, 190 recipes
```

The schema is defined at:

```
apps/engine/src/connectors/templates.ts:171  # ConnectorRecipeSchema
```

Recipes are read-only at runtime. Tenant-scoped per-recipe overrides
will land via `connector_recipes` (planned, see Workstream E in the
roadmap); today, every operator sees the same shipped catalog.

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
        "headers": { "content-type": "application/x-www-form-urlencoded" },
        "form": {
          "email": "${input.email}",
          "metadata": "${input.metadata}"
        },
        "idempotency_key": "${input.email}"
      }
    ]
  }
}
```

## Walkthrough — multi-connector recipe (Stripe → Slack notify)

```json
{
  "slug": "stripe-charge-failed-notify-slack",
  "title": "Notify Slack on Stripe charge failure",
  "description": "Listens for Stripe `charge.failed` events; posts a redacted summary to a Slack channel.",
  "intent_keywords": ["failed charge", "charge failed slack", "billing alert"],
  "category": "payments",
  "tags": ["webhook", "notification"],
  "difficulty": "intermediate",
  "required_connectors": [
    { "placeholder": "00000000-0000-0000-0000-000000000001", "template": "stripe" },
    { "placeholder": "00000000-0000-0000-0000-000000000002", "template": "slack" }
  ],
  "workflow": {
    "name": "stripe-charge-failed-notify-slack",
    "trigger": {
      "kind": "webhook",
      "source": "stripe",
      "events": ["charge.failed"],
      "verify": "stripe-signature"
    },
    "steps": [
      {
        "kind": "transform",
        "id": "shape",
        "expression": "{ \"text\": \"Charge failed: \" & event.data.object.id & \" — $\" & (event.data.object.amount / 100) }"
      },
      {
        "kind": "request",
        "id": "post",
        "connector_id": "00000000-0000-0000-0000-000000000002",
        "method": "POST",
        "url": "${connector.slack.base_url}/chat.postMessage",
        "headers": { "content-type": "application/json" },
        "body": { "channel": "#billing-alerts", "text": "${shape.text}" }
      }
    ]
  }
}
```

(Webhook trigger schema lands via Workstream A1; the JSON above
illustrates the target shape.)

## Quality gate

Every recipe-touching PR runs:

```sh
bun run lint:recipes        # F4 lint
bun run check:terminology   # banned: automation, automations, superglue
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
7. PR description names the operator pain the recipe solves and the
   competitor's equivalent (n8n / Zapier / Pipedream slug if any).
   Per the "winner-at-all" rule, if a competitor ships the same
   recipe, ours must beat it on validation, prerequisites clarity,
   or step efficiency — not just match.

## Related

- `docs/05-connectors.md` — connector templates (parent surface).
- `apps/engine/src/connectors/AGENTS.md` — connector subsystem rules.
- `scripts/lint-recipes.ts` — quality lint source.
- `scripts/migrate-recipe-schema-v2.ts` — F1 migration script
  (archival, runs once).
