#!/usr/bin/env bun
// Read-only self-healing churn report.
//
// Usage:
//   bun run scripts/analyze-self-healing-churn.ts --days 14
//
// Purpose: find patch candidates that can cause repeated proactive repair
// LLM spend, especially endpoint-anchored candidates parked for review.

import { sql } from "drizzle-orm";
import { getDb, getPool } from "../apps/engine/src/db/client.ts";

interface Args {
  days: number;
  limit: number;
  json: boolean;
}

interface CandidateRow {
  tenant_id: string;
  workflow_id: string;
  connector_id: string | null;
  endpoint_key: string | null;
  status: string;
  classification: string;
  candidates: number;
  oldest_created_at: string;
  newest_updated_at: string;
}

interface RepairRow {
  tenant_id: string;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { days: 14, limit: 50, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") out.days = Number(argv[++i] ?? out.days);
    else if (a === "--limit") out.limit = Number(argv[++i] ?? out.limit);
    else if (a === "--json") out.json = true;
  }
  if (!Number.isFinite(out.days) || out.days <= 0) throw new Error("--days must be > 0");
  if (!Number.isFinite(out.limit) || out.limit <= 0) throw new Error("--limit must be > 0");
  return out;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();
  const candidates = await db.execute(sql<CandidateRow>`
    select
      tenant_id::text as tenant_id,
      workflow_id::text as workflow_id,
      connector_id::text as connector_id,
      endpoint_key,
      status,
      classification,
      count(*)::int as candidates,
      min(created_at)::text as oldest_created_at,
      max(updated_at)::text as newest_updated_at
    from patch_candidates
    where created_at >= now() - (${args.days}::text || ' days')::interval
    group by tenant_id, workflow_id, connector_id, endpoint_key, status, classification
    order by
      case when status = 'proposed' then 0 when status = 'rejected' then 1 else 2 end,
      count(*) desc,
      max(updated_at) desc
    limit ${args.limit}
  `);
  const repairs = await db.execute(sql<RepairRow>`
    select
      tenant_id::text as tenant_id,
      count(*)::int as calls,
      coalesce(sum(prompt_tokens), 0)::float8 as prompt_tokens,
      coalesce(sum(completion_tokens), 0)::float8 as completion_tokens,
      coalesce(sum(cache_read_tokens), 0)::float8 as cache_read_tokens,
      coalesce(sum(cache_creation_tokens), 0)::float8 as cache_creation_tokens
    from llm_usage
    where created_at >= now() - (${args.days}::text || ' days')::interval
      and flow = 'repair'
    group by tenant_id
    order by count(*) desc
  `);

  if (args.json) {
    console.log(
      JSON.stringify(
        { window_days: args.days, candidates: candidates.rows, repair_usage: repairs.rows },
        null,
        2,
      ),
    );
    await getPool().end();
    return;
  }

  console.log(`Self-healing churn report (${args.days}d)`);
  console.log("\nRepair LLM usage by tenant");
  console.log(["tenant", "calls", "prompt", "out", "cache_read", "cache_create"].join("\t"));
  for (const r of repairs.rows) {
    console.log(
      [
        r.tenant_id.slice(0, 8),
        fmt(r.calls),
        fmt(r.prompt_tokens),
        fmt(r.completion_tokens),
        fmt(r.cache_read_tokens),
        fmt(r.cache_creation_tokens),
      ].join("\t"),
    );
  }

  console.log("\nPatch candidate clusters");
  console.log(
    [
      "tenant",
      "workflow",
      "connector",
      "endpoint",
      "status",
      "class",
      "rows",
      "oldest",
      "newest_update",
    ].join("\t"),
  );
  for (const c of candidates.rows) {
    console.log(
      [
        c.tenant_id.slice(0, 8),
        c.workflow_id.slice(0, 8),
        c.connector_id?.slice(0, 8) ?? "-",
        c.endpoint_key ?? "-",
        c.status,
        c.classification,
        fmt(c.candidates),
        c.oldest_created_at,
        c.newest_updated_at,
      ].join("\t"),
    );
  }
  await getPool().end();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  await getPool()
    .end()
    .catch(() => {});
  process.exitCode = 1;
});
