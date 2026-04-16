# 21 — Execution Search

Operators need a fast way to answer questions like "which runs of the invoice workflow failed last night from the scheduler" or "show every Execution this end user triggered through their portal token in the last hour." This file specifies the Execution query model: the supported filter dimensions, the free-text search shape, the pagination contract, the response envelope, and the indexes that keep it fast at production cardinality.

## Endpoint

```
GET /v1/executions
```

All filters live in the query string. The endpoint never accepts a request body. Authorization is the standard Auth Provider chain; the result set is implicitly scoped to the caller's `tenant_id`.

## Filter dimensions

| Filter | Type | Notes |
|---|---|---|
| `workflow_id` | uuid | Restrict to a single Workflow. |
| `status[]` | enum array | Any subset of `queued`, `running`, `succeeded`, `failed`, `aborted`, `timed_out`. Repeatable: `?status=failed&status=timed_out`. |
| `request_source[]` | enum array | Any subset of `api`, `cli`, `scheduler`, `mcp`, `webhook`, `tool-chain`, `ui`. Repeatable. |
| `started_after` | ISO 8601 timestamp | Inclusive lower bound on `started_at`. |
| `started_before` | ISO 8601 timestamp | Exclusive upper bound on `started_at`. |
| `tenant_id` | uuid | Server-enforced; only callable by cross-tenant admin tooling, never accepted from a tenant-scoped Principal. |
| `user_id` | uuid | Triggering User. |
| `system_account_id` | uuid | Triggering System Account. |
| `connector_id` | uuid | Restrict to runs that touched a specific Connector (joined via `execution_steps`). |
| `execution_mode` | enum | `dev` or `prod`. |
| `parent_execution_id` | uuid | The parent in a `call` chain. Useful for walking tool-chain trees. |
| `q` | string | Free-text search across payloads. See below. |

Filters compose with AND. Multi-value filters compose internally with OR — `status=failed&status=timed_out` matches Executions in either state.

## Free-text payload search

The `q` parameter searches across input and output JSON of an Execution. Implementation: a Postgres `tsvector` generated column on the `executions` table that is automatically maintained from a normalized text projection of the relevant JSONB fields (input preview, output preview, error string), built with `to_tsvector('simple', ...)`. The query uses `plainto_tsquery` against this column.

Trade-off: a generated `tsvector` column is dense and indexable with GIN, which keeps free-text queries under tens of milliseconds even on large tenants. The cost is a small write amplification per Execution. The alternative — `LIKE '%term%'` over JSONB — does not scale past a few hundred thousand rows. Vector / semantic search is deliberately out of scope for v1; `tsvector` is good enough for "find that one failed run from yesterday."

## Pagination

Offset pagination only. The contract is small and predictable.

| Parameter | Default | Range |
|---|---|---|
| `limit` | 50 | 1 to 1000 inclusive, server clamps out-of-range values silently. |
| `offset` | 0 | Non-negative integer. |

Server sorts newest-first by `started_at DESC, id DESC` so adjacent pages remain stable across new inserts.

Trade-off: cursor pagination would survive concurrent inserts more cleanly, but offset is what operators expect from a search UI and the workload — humans paging through dozens of pages, occasionally — is comfortably inside what offset can sustain at the indexes below.

## Response envelope

```ts
type ExecutionListResponse = {
  data: ExecutionRow[];
  page: { limit: number; offset: number };
  total: number;     // total matching the filter, not just this page
  has_more: boolean; // true when offset + data.length < total
};
```

`total` is computed by a parallel `COUNT(*)` on the same predicate, which the indexes below keep cheap. Clients that need to hide the total (very large result sets, latency-sensitive UIs) can pass `?count=false` and the server will return `total: null` and skip the count query.

## TypeScript sketch

```ts
import { z } from "zod";

export const executionFilterSchema = z.object({
  workflow_id: z.string().uuid().optional(),
  status: z.array(z.enum([
    "queued", "running", "succeeded", "failed", "aborted", "timed_out",
  ])).optional(),
  request_source: z.array(z.enum([
    "api", "cli", "scheduler", "mcp", "webhook", "tool-chain", "ui",
  ])).optional(),
  started_after: z.string().datetime().optional(),
  started_before: z.string().datetime().optional(),
  user_id: z.string().uuid().optional(),
  system_account_id: z.string().uuid().optional(),
  connector_id: z.string().uuid().optional(),
  execution_mode: z.enum(["dev", "prod"]).optional(),
  parent_execution_id: z.string().uuid().optional(),
  q: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  count: z.coerce.boolean().default(true),
});

export type ExecutionFilter = z.infer<typeof executionFilterSchema>;
```

The same schema feeds `@hono/zod-openapi` (so `openapi.json` documents every filter) and the in-repo `hono/client` (so the CLI gets compile-time-checked filter shapes).

## Indexes

Two compound indexes carry the workload:

| Index | Purpose |
|---|---|
| `(tenant_id, status, started_at DESC)` | "Most recent failures across the tenant" — the most common dashboard query. |
| `(tenant_id, workflow_id, started_at DESC)` | "Most recent runs of this workflow" — the most common drill-down. |

Two secondary indexes keep the long-tail filters cheap:

| Index | Purpose |
|---|---|
| `(tenant_id, request_source, started_at DESC)` | Source-scoped scans (e.g. "all webhook-triggered runs"). |
| GIN on the `tsvector` column | Free-text search. |

Trade-off: four indexes is a deliberately small set. Every additional index is paid on every Execution insert, and Execution writes are on the hot path of every triggered run.

## Performance targets

Under realistic per-tenant cardinality (millions of rows, retention managed by a separate housekeeping job), the targets are:

| Query shape | Target |
|---|---|
| Filter by `workflow_id` + `status` + recency | < 50 ms p99 |
| Free-text search across one tenant | < 200 ms p99 |
| Total-count side query | < 100 ms p99 |

Anything that exceeds these targets in production points either to missing index coverage or to a tenant whose retention window needs trimming — not to a query-model problem.

## Things `/v1/executions` does **not** do

- No aggregation surface (counts by status by hour, etc.). That belongs in the Prometheus metrics endpoint, not in row search.
- No saved queries server-side. The CLI may add a local saved-search file later; the engine stays stateless.
- No cross-tenant queries from a tenant-scoped caller. The `tenant_id` filter is server-enforced.
