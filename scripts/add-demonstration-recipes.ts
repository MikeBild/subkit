// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${connector.<slug>.base_url}` and `${input.x}` placeholder tokens are consumed by the executor's substitution parser at run time.
//
// Workstream D — author demonstration recipes for the
// `WorkflowDefSchema` primitives that today's 190 recipes do not
// exercise (per the Round-2 audit at
// `/Users/mikebild/.claude/plans/make-a-deep-internet-flickering-sutherland.md`).
//
// Scope of THIS script: only the primitives whose executor wiring
// already exists (BranchStep, ParallelStep, RequestStep
// idempotency_key, RequestStep retry_on_status, RequestStep
// expected_row_count, RequestStep sql.also, RequestStep sql.cursor,
// WorkflowDef validation_function, WorkflowDef output_transform).
// The remaining primitives (`call`, `wait`, `tool`, `wait_for_event`,
// `fan_out`) wait on executor work in subsequent PRs.
//
// Each recipe lives on the most-natural existing template (Stripe for
// idempotency / branch, Postgres for sql.also / sql.cursor /
// expected_row_count, GitHub for parallel + retry, etc.).
//
// Idempotent — re-running on already-amended templates skips existing
// recipe slugs.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TEMPLATES_PATH = resolve(import.meta.dir, "..", "apps/engine/src/connectors/templates.json");

type Recipe = Record<string, unknown>;
type Template = { slug: string; recipes?: Recipe[]; category?: string };

interface RecipeDef {
  template_slug: string;
  recipe: Recipe;
}

const STRIPE_BASE = "${connector.stripe.base_url}";
const GITHUB_BASE = "${connector.github.base_url}";
const POSTGRES_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

const DEMOS: RecipeDef[] = [
  // BranchStep demonstration — Stripe charge OR refund based on amount.
  {
    template_slug: "stripe",
    recipe: {
      slug: "charge-or-refund-by-amount",
      title: "Charge or refund a Stripe customer by amount",
      description:
        "Demonstrates BranchStep — when amount > 0, capture a charge against the customer; when amount < 0, issue a refund of the absolute value against the most recent charge. Single workflow, two branches, deterministic routing on the input.",
      intent_keywords: ["charge or refund", "branch by amount", "stripe conditional"],
      derived_from_skill: null,
      category: "payments",
      tags: ["branch", "demonstration"],
      difficulty: "advanced",
      estimated_setup_minutes: 7,
      prerequisites: ["Stripe API key with `write` scope"],
      sample_input: { customer_id: "cus_123", amount: 5000 },
      expected_output_preview: { id: "ch_***", amount: 5000, kind: "charge" },
      required_connectors: [],
      version: "1.0.0",
      author: "subkit-builtin",
      last_validated_at: null,
      deprecated: null,
      workflow: {
        name: "stripe-charge-or-refund-by-amount",
        description: "Branch on input.amount sign — charge when positive, refund when negative.",
        input_schema: {
          type: "object",
          required: ["customer_id", "amount"],
          properties: {
            customer_id: { type: "string" },
            amount: { type: "number" },
          },
        },
        steps: [
          {
            kind: "branch",
            id: "route",
            when: "$.input.amount > 0",
            then_steps: ["create_charge"],
            else_steps: ["list_for_refund", "refund_charge"],
          },
          {
            kind: "request",
            id: "create_charge",
            method: "POST",
            url: `${STRIPE_BASE}/charges`,
            headers: { "content-type": "application/x-www-form-urlencoded" },
            form: {
              customer: "${input.customer_id}",
              amount: "${input.amount}",
              currency: "usd",
            },
            idempotency_key: "${input.customer_id}-${input.amount}",
          },
          {
            kind: "request",
            id: "list_for_refund",
            method: "GET",
            url: `${STRIPE_BASE}/charges`,
            query: {
              customer: "${input.customer_id}",
              limit: 1,
            },
          },
          {
            kind: "request",
            id: "refund_charge",
            method: "POST",
            url: `${STRIPE_BASE}/refunds`,
            headers: { "content-type": "application/x-www-form-urlencoded" },
            form: {
              charge: "${list_for_refund.body.data[0].id}",
              amount: "${input.amount}",
            },
            idempotency_key: "${input.customer_id}-${input.amount}",
          },
        ],
      },
    },
  },
  // RequestStep idempotency_key — Stripe create-customer with idempotent header.
  {
    template_slug: "stripe",
    recipe: {
      slug: "create-customer-idempotent",
      title: "Create a Stripe customer (idempotent)",
      description:
        "Demonstrates RequestStep.idempotency_key — the workflow can re-run with the same email and Stripe will return the original customer instead of creating a duplicate. The executor injects `Idempotency-Key` per attempt anyway; this shows the per-step opt-in.",
      intent_keywords: [
        "create customer idempotent",
        "stripe new customer safe",
        "duplicate-safe customer",
      ],
      derived_from_skill: null,
      category: "payments",
      tags: ["idempotency", "demonstration"],
      difficulty: "beginner",
      estimated_setup_minutes: 3,
      prerequisites: ["Stripe API key with `write` scope"],
      sample_input: { email: "billing@acme.test" },
      expected_output_preview: { id: "cus_***", email: "billing@acme.test" },
      required_connectors: [],
      version: "1.0.0",
      author: "subkit-builtin",
      last_validated_at: null,
      deprecated: null,
      workflow: {
        name: "stripe-create-customer-idempotent",
        description: "Idempotent customer creation keyed by email.",
        input_schema: {
          type: "object",
          required: ["email"],
          properties: { email: { type: "string" } },
        },
        steps: [
          {
            kind: "request",
            id: "create",
            method: "POST",
            url: `${STRIPE_BASE}/customers`,
            headers: { "content-type": "application/x-www-form-urlencoded" },
            form: { email: "${input.email}" },
            idempotency_key: "create-customer:${input.email}",
          },
        ],
      },
    },
  },
  // RequestStep retry_on_status — flaky third-party with 503 backoff.
  {
    template_slug: "github",
    recipe: {
      slug: "list-repos-retry-on-secondary-rate-limit",
      title: "List GitHub repos with retry on secondary rate-limit (5xx + 403)",
      description:
        "Demonstrates RequestStep.retry_on_status + retry_backoff_ms. GitHub's secondary rate-limit returns 403 with `X-RateLimit-Remaining: 0`; we retry on 403 alongside the standard 5xx + 429 set, with bounded backoff.",
      intent_keywords: ["retry rate limit", "github backoff", "list repos resilient"],
      derived_from_skill: null,
      category: "devops",
      tags: ["retry", "demonstration"],
      difficulty: "intermediate",
      estimated_setup_minutes: 4,
      prerequisites: ["GitHub PAT with `repo` scope"],
      sample_input: null,
      expected_output_preview: null,
      required_connectors: [],
      version: "1.0.0",
      author: "subkit-builtin",
      last_validated_at: null,
      deprecated: null,
      workflow: {
        name: "github-list-repos-retry-on-secondary-rate-limit",
        description: "List authenticated user's repos with secondary-rate-limit retry.",
        steps: [
          {
            kind: "request",
            id: "list",
            method: "GET",
            url: `${GITHUB_BASE}/user/repos`,
            query: { per_page: 100, sort: "updated" },
            max_retries: 3,
            retry_backoff_ms: 2000,
            retry_on_status: [403],
            pagination: {
              strategy: "page",
              page_size: 100,
              page_param: "page",
              limit_param: "per_page",
            },
          },
        ],
      },
    },
  },
  // ParallelStep — fan three GitHub queries then merge.
  {
    template_slug: "github",
    recipe: {
      slug: "fan-out-issues-prs-releases",
      title: "Fan out issues + PRs + releases for a repo (parallel)",
      description:
        "Demonstrates ParallelStep — three independent GET requests run concurrently against the same repo (issues, pulls, releases) and the workflow surfaces the merged shape. Cuts wall-clock vs. serial.",
      intent_keywords: ["parallel github", "issues prs releases", "fan out repo"],
      derived_from_skill: null,
      category: "devops",
      tags: ["parallel", "demonstration"],
      difficulty: "intermediate",
      estimated_setup_minutes: 4,
      prerequisites: ["GitHub PAT with `repo` scope"],
      sample_input: { owner: "acme", repo: "widget" },
      expected_output_preview: { issues: [], pulls: [], releases: [] },
      required_connectors: [],
      version: "1.0.0",
      author: "subkit-builtin",
      last_validated_at: null,
      deprecated: null,
      workflow: {
        name: "github-fan-out-issues-prs-releases",
        description: "Fan three GET requests in parallel.",
        input_schema: {
          type: "object",
          required: ["owner", "repo"],
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
          },
        },
        steps: [
          {
            kind: "parallel",
            id: "fan",
            branches: [["fetch_issues"], ["fetch_pulls"], ["fetch_releases"]],
          },
          {
            kind: "request",
            id: "fetch_issues",
            method: "GET",
            url: `${GITHUB_BASE}/repos/\${input.owner}/\${input.repo}/issues`,
            query: { state: "open", per_page: 30 },
          },
          {
            kind: "request",
            id: "fetch_pulls",
            method: "GET",
            url: `${GITHUB_BASE}/repos/\${input.owner}/\${input.repo}/pulls`,
            query: { state: "open", per_page: 30 },
          },
          {
            kind: "request",
            id: "fetch_releases",
            method: "GET",
            url: `${GITHUB_BASE}/repos/\${input.owner}/\${input.repo}/releases`,
            query: { per_page: 10 },
          },
          {
            kind: "transform",
            id: "merge",
            expression:
              '{ "issues": $.fetch_issues.body, "pulls": $.fetch_pulls.body, "releases": $.fetch_releases.body }',
          },
        ],
      },
    },
  },
  // RequestStep.expected_row_count — Postgres single-row guard.
  {
    template_slug: "postgres",
    recipe: {
      slug: "update-must-affect-exactly-one-row",
      title: "Update a row with exactly-one guard",
      description:
        "Demonstrates RequestStep.expected_row_count — UPDATE that affects more or fewer than one row triggers `expected_row_count_mismatch` and rolls back. Use for primary-key UPDATEs where multiple matches indicate a data bug.",
      intent_keywords: ["update single row", "row count guard", "exactly one update"],
      derived_from_skill: null,
      category: "database",
      tags: ["expected-row-count", "demonstration"],
      difficulty: "intermediate",
      estimated_setup_minutes: 4,
      prerequisites: ["Postgres connector with write access"],
      sample_input: { id: 42, status: "active" },
      expected_output_preview: { rowCount: 1 },
      required_connectors: [],
      version: "1.0.0",
      author: "subkit-builtin",
      last_validated_at: null,
      deprecated: null,
      workflow: {
        name: "postgres-update-exactly-one",
        description: "UPDATE guarded by expected_row_count = 1.",
        input_schema: {
          type: "object",
          required: ["id", "status"],
          properties: {
            id: { type: "number" },
            status: { type: "string" },
          },
        },
        steps: [
          {
            kind: "request",
            id: "update",
            connector_id: POSTGRES_PLACEHOLDER,
            method: "UPDATE",
            sql: {
              query: "UPDATE accounts SET status = $1 WHERE id = $2",
              params: ["${input.status}", "${input.id}"],
            },
            expected_row_count: 1,
          },
        ],
      },
    },
  },
  // RequestStep.sql.also — atomic double-entry transaction.
  {
    template_slug: "postgres",
    recipe: {
      slug: "atomic-debit-credit-double-entry",
      title: "Atomic debit + credit (double-entry, single transaction)",
      description:
        "Demonstrates RequestStep.sql.also — both the debit and credit run inside one transaction; either both commit or both roll back. Each leg carries its own expected_row_count guard so a missing account fails the whole transfer.",
      intent_keywords: ["double entry", "atomic transfer", "debit credit", "ledger transaction"],
      derived_from_skill: null,
      category: "database",
      tags: ["sql-also", "transaction", "demonstration"],
      difficulty: "advanced",
      estimated_setup_minutes: 5,
      prerequisites: ["Postgres connector with write access to ledger schema"],
      sample_input: { from_id: 1, to_id: 2, amount_cents: 5000 },
      expected_output_preview: null,
      required_connectors: [],
      version: "1.0.0",
      author: "subkit-builtin",
      last_validated_at: null,
      deprecated: null,
      workflow: {
        name: "postgres-debit-credit",
        description: "Debit one account + credit another atomically.",
        input_schema: {
          type: "object",
          required: ["from_id", "to_id", "amount_cents"],
          properties: {
            from_id: { type: "number" },
            to_id: { type: "number" },
            amount_cents: { type: "number" },
          },
        },
        steps: [
          {
            kind: "request",
            id: "tx",
            connector_id: POSTGRES_PLACEHOLDER,
            method: "UPDATE",
            sql: {
              query: "UPDATE accounts SET balance_cents = balance_cents - $1 WHERE id = $2",
              params: ["${input.amount_cents}", "${input.from_id}"],
              expected_row_count: 1,
              also: [
                {
                  query: "UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2",
                  params: ["${input.amount_cents}", "${input.to_id}"],
                  expected_row_count: 1,
                },
              ],
            },
          },
        ],
      },
    },
  },
  // RequestStep.sql.cursor — server-side cursor for large export.
  {
    template_slug: "postgres",
    recipe: {
      slug: "export-large-table-stream",
      title: "Export a large table via server-side cursor",
      description:
        "Demonstrates RequestStep.sql.cursor — instead of buffering the full result set in memory, the driver streams rows in batches of 1000 via a server-side cursor. The step output is still a single concatenated array (caller-visible scope is unchanged).",
      intent_keywords: ["export large table", "stream rows", "server side cursor", "bulk read"],
      derived_from_skill: null,
      category: "database",
      tags: ["sql-cursor", "demonstration"],
      difficulty: "intermediate",
      estimated_setup_minutes: 4,
      prerequisites: ["Postgres connector with read access"],
      sample_input: { table_name: "events", since: "2026-01-01" },
      expected_output_preview: null,
      required_connectors: [],
      version: "1.0.0",
      author: "subkit-builtin",
      last_validated_at: null,
      deprecated: null,
      workflow: {
        name: "postgres-export-large-table-stream",
        description: "Cursor-streamed SELECT for large result sets.",
        input_schema: {
          type: "object",
          required: ["table_name", "since"],
          properties: {
            table_name: { type: "string" },
            since: { type: "string" },
          },
        },
        steps: [
          {
            kind: "request",
            id: "read",
            connector_id: POSTGRES_PLACEHOLDER,
            method: "SELECT",
            sql: {
              query: "SELECT * FROM events WHERE created_at >= $1 ORDER BY created_at",
              params: ["${input.since}"],
              cursor: { fetch_size: 1000 },
            },
          },
        ],
      },
    },
  },
  // WorkflowDef.validation_function — QuickJS invariant check.
  {
    template_slug: "stripe",
    recipe: {
      slug: "list-charges-validate-no-zero-amount",
      title: "List Stripe charges with `no zero-amount` invariant",
      description:
        "Demonstrates WorkflowDef.validation_function — a QuickJS expression evaluated against the final output. If any returned charge has amount === 0 the run fails with `validation_failed`, surfacing the invariant violation to the operator instead of silently leaking corrupt data downstream.",
      intent_keywords: ["validate charges", "no zero amount", "invariant check"],
      derived_from_skill: null,
      category: "payments",
      tags: ["validation", "demonstration"],
      difficulty: "intermediate",
      estimated_setup_minutes: 4,
      prerequisites: ["Stripe API key with `read` scope"],
      sample_input: null,
      expected_output_preview: null,
      required_connectors: [],
      version: "1.0.0",
      author: "subkit-builtin",
      last_validated_at: null,
      deprecated: null,
      workflow: {
        name: "stripe-list-charges-validated",
        description: "List + validate that no charge has amount === 0.",
        steps: [
          {
            kind: "request",
            id: "list",
            method: "GET",
            url: `${STRIPE_BASE}/charges`,
            query: { limit: 100 },
          },
        ],
        validation_function:
          "input.list && Array.isArray(input.list.body && input.list.body.data) && input.list.body.data.every(function(c){ return c && c.amount !== 0; })",
      },
    },
  },
];

function main() {
  const raw = readFileSync(TEMPLATES_PATH, "utf8");
  const templates = JSON.parse(raw) as Template[];
  let added = 0;
  let skipped = 0;
  for (const def of DEMOS) {
    const tpl = templates.find((t) => t.slug === def.template_slug);
    if (!tpl) {
      console.warn(`skip: template \`${def.template_slug}\` not found`);
      skipped += 1;
      continue;
    }
    const existing = tpl.recipes ?? [];
    if (existing.some((r) => r.slug === def.recipe.slug)) {
      console.log(`skip: ${def.template_slug}/${def.recipe.slug} already exists`);
      skipped += 1;
      continue;
    }
    tpl.recipes = [...existing, def.recipe];
    added += 1;
    console.log(`added: ${def.template_slug}/${def.recipe.slug}`);
  }
  writeFileSync(TEMPLATES_PATH, `${JSON.stringify(templates, null, 2)}\n`, "utf8");
  console.log(
    `done: added ${added}, skipped ${skipped}; catalog now has ${templates.reduce((s, t) => s + (t.recipes?.length ?? 0), 0)} recipes`,
  );
}

main();
