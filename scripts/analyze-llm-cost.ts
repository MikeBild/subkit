#!/usr/bin/env bun
// Read-only LLM cost/caching report.
//
// Usage:
//   bun run scripts/analyze-llm-cost.ts --days 7
//   bun run scripts/analyze-llm-cost.ts --days 30 --flow converse
//
// The report intentionally uses weighted token accounting, not raw
// `total_tokens`, so prompt-cache reads/creations are visible rather than
// collapsed into one number.

import { sql } from "drizzle-orm";
import { getDb, getPool } from "../apps/engine/src/db/client.ts";
import { weightedTotalTokens } from "../apps/engine/src/llm/pricing.ts";

interface Args {
  days: number;
  flow?: string;
  limit: number;
  json: boolean;
}

interface FlowRow {
  tenant_id: string;
  flow: string;
  model: string;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  weighted_tokens: number;
  avg_latency_ms: number;
  cold_calls: number;
  cache_read_calls: number;
  cache_creation_calls: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { days: 7, limit: 50, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") out.days = Number(argv[++i] ?? out.days);
    else if (a === "--flow") out.flow = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i] ?? out.limit);
    else if (a === "--json") out.json = true;
  }
  if (!Number.isFinite(out.days) || out.days <= 0) throw new Error("--days must be > 0");
  if (!Number.isFinite(out.limit) || out.limit <= 0) throw new Error("--limit must be > 0");
  return out;
}

function pct(n: number, d: number): string {
  if (d <= 0) return "0.0%";
  return `${((n / d) * 100).toFixed(1)}%`;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();
  const rows = await db.execute(sql<FlowRow>`
    select
      tenant_id::text as tenant_id,
      flow,
      model,
      count(*)::int as calls,
      coalesce(sum(prompt_tokens), 0)::float8 as prompt_tokens,
      coalesce(sum(completion_tokens), 0)::float8 as completion_tokens,
      coalesce(sum(cache_read_tokens), 0)::float8 as cache_read_tokens,
      coalesce(sum(cache_creation_tokens), 0)::float8 as cache_creation_tokens,
      coalesce(avg(latency_ms), 0)::float8 as avg_latency_ms,
      count(*) filter (
        where cache_read_tokens = 0 and cache_creation_tokens = 0
      )::int as cold_calls,
      count(*) filter (where cache_read_tokens > 0)::int as cache_read_calls,
      count(*) filter (where cache_creation_tokens > 0)::int as cache_creation_calls
    from llm_usage
    where created_at >= now() - (${args.days}::text || ' days')::interval
      and (${args.flow ?? null}::text is null or flow = ${args.flow ?? null})
    group by tenant_id, flow, model
    order by (
      coalesce(sum(completion_tokens), 0)
      + greatest(
          0,
          coalesce(sum(prompt_tokens), 0)
          - coalesce(sum(cache_read_tokens), 0)
          - coalesce(sum(cache_creation_tokens), 0)
        )
      + round(coalesce(sum(cache_read_tokens), 0) * 0.1)
      + round(coalesce(sum(cache_creation_tokens), 0) * 1.25)
    ) desc
    limit ${args.limit}
  `);

  const shaped = rows.rows.map((r) => {
    const weighted = weightedTotalTokens({
      prompt_tokens: Number(r.prompt_tokens),
      completion_tokens: Number(r.completion_tokens),
      cache_read_tokens: Number(r.cache_read_tokens),
      cache_creation_tokens: Number(r.cache_creation_tokens),
    });
    return { ...r, weighted_tokens: weighted };
  });

  if (args.json) {
    console.log(JSON.stringify({ window_days: args.days, rows: shaped }, null, 2));
    await getPool().end();
    return;
  }

  console.log(`LLM cost/cache report (${args.days}d${args.flow ? `, flow=${args.flow}` : ""})`);
  console.log(
    [
      "tenant",
      "flow",
      "model",
      "calls",
      "prompt",
      "out",
      "cache_read",
      "cache_create",
      "weighted",
      "read_call%",
      "create_call%",
      "avg_ms",
    ].join("\t"),
  );
  for (const r of shaped) {
    console.log(
      [
        r.tenant_id.slice(0, 8),
        r.flow,
        r.model,
        fmt(r.calls),
        fmt(r.prompt_tokens),
        fmt(r.completion_tokens),
        fmt(r.cache_read_tokens),
        fmt(r.cache_creation_tokens),
        fmt(r.weighted_tokens),
        pct(r.cache_read_calls, r.calls),
        pct(r.cache_creation_calls, r.calls),
        fmt(r.avg_latency_ms),
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
