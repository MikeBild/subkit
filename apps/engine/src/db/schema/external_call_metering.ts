// External-provider call metering — cost tracking for non-LLM providers
// invoked by opt-in, connector-shaped writers under a per-tenant budget.
// The engine's own runtime hot paths (discovery, ranking, scraping) stay
// local by policy and never write to this ledger.
//
// Mirrors the `llm_usage` ledger: append-only, per-tenant, month-bucketed
// for cheap `sum(...)` budget queries. Unlike `llm_usage` we do not weight
// units; providers bill in their own units (search queries, crawl pages,
// rerank documents) so `units` + `provider` is the canonical pair, and
// `cost_usd` is the resolved monetary cost at call time.
//
// Audit-correlation convention: this ledger deliberately mirrors
// `llm_usage` and does NOT carry an `audit_id` pointer. Operators
// correlate metering rows with the audit_log via `(tenant_id,
// created_at)`. If a future change introduces audit pointers, add the
// column to BOTH `llm_usage` and `external_call_metering` in the same
// migration so the two ledgers stay structurally aligned.

import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const externalCallMetering = pgTable(
  "external_call_metering",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    // Provider slug — opaque, set by the writer (e.g. the operator's chosen
    // managed scraping or reranking service when wired via an opt-in
    // connector template). Constrained server-side to the slug grammar
    // `^[a-z][a-z0-9_]*$` via migration 0016 so operator-facing
    // per-provider roll-ups join on a consistent value.
    provider: text("provider").notNull(),
    // Optional operation name — e.g. "rerank", "crawl", "search", "scrape".
    operation: text("operation"),
    // Provider-specific unit count (rerank documents, crawled pages, ...).
    units: integer("units").notNull().default(0),
    // Resolved cost at call time in USD, stored as numeric(12,6) for sub-cent
    // precision. NULL when the cost is not known at call time and is
    // back-filled later.
    cost_usd: numeric("cost_usd", { precision: 12, scale: 6 }),
    // Latency in milliseconds — mirrors llm_usage shape.
    latency_ms: integer("latency_ms").notNull().default(0),
    // "ok" | "error" — same convention as llm_usage.result; enforced
    // server-side by the CHECK constraint below, mirrored on the TS
    // surface so insert call-sites can't drift.
    result: text("result").$type<"ok" | "error">().notNull(),
    error: text("error"),
    created_at: timestamps.created_at,
    // YYYYMM bucket for cheap budget rollups. Use the shared helper
    // `currentMonthBucket()` from `apps/engine/src/llm/accounting/budget.ts`
    // (UTC) to compute this value — do not roll your own, otherwise the
    // metering and llm_usage ledgers will not agree on month boundaries.
    month_bucket: bigint("month_bucket", { mode: "number" }).notNull(),
  },
  (t) => [
    index("external_call_metering_tenant_created_idx").on(t.tenant_id, t.created_at),
    index("external_call_metering_tenant_provider_month_idx").on(
      t.tenant_id,
      t.provider,
      t.month_bucket,
    ),
    check("external_call_metering_result_check", sql`${t.result} IN ('ok','error')`),
    // Pin `provider` to a slug grammar (#178 review S4, migration 0016).
    // Operator-facing roll-ups join on this column; an unconstrained
    // free-string field would drift into typo soup before any writer
    // ships.
    check("external_call_metering_provider_slug_check", sql`${t.provider} ~ '^[a-z][a-z0-9_]*$'`),
  ],
);
