// `sk health` — one coherent runtime-posture view of the engine + tenant.
//
// Before this command the same operational signals were rendered three
// different ways: a trivial `sk health` liveness probe, the `sk doctor`
// setup preflight, and the REPL's needs-attention panel. This composes
// the steady-state signals into a single view:
//
//   1. Reachability  — GET /health and GET /ready.
//   2. Token budget  — month-to-date spend vs. the monthly budget
//                      (from /v1/status — same figures the REPL footer
//                      shows, so the CLI and the dashboard never disagree).
//   3. Failing runs  — the deterministic operator health-digest, grouped
//                      by root cause + tagged by origin.
//   4. Risk signals  — leading indicators from the same digest.
//   5. Self-healing  — open patch candidates awaiting review.
//   6. Schema drift  — one-line status (embedded vs. DB migration sets);
//                      `sk doctor` owns the detailed resolution guidance.
//   7. Process runtime — uptime, memory, DB-pool saturation, event-loop
//                      lag from the new /v1/diagnostics/runtime route.
//
// `sk doctor` stays the *connectivity / setup* preflight (profile validity,
// authn, drift resolution, version match, integrations) — the "why can't I
// connect / is my install correct" tool. `sk health` is the steady-state
// "is the engine under pressure and is anything failing right now" tool.
// They are complementary, not duplicative.
//
// Auth-graceful: the liveness probe needs no key; every authenticated
// section degrades to a dim "unavailable" note on 401/403 or an older
// engine without the route, so `sk health --engine-url <url>` still works
// as a bare reachability check.

import { exitCodeFor } from "@cli-core/errors";
import { printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import {
  type DiagnosticsRuntime,
  EngineClient,
  type OperatorHealthDigest,
  type StatusSummary,
} from "../engine-client.ts";
import { totalFailureCount } from "../lib/operator-digest.ts";
import { formatTokens, humanMs } from "../render/format.ts";

/** Best-effort fetch wrapper — returns null on any error so a single
 *  unavailable section never aborts the whole view. */
async function tryFetch<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

const RISK_GLYPH = (severity: "warn" | "critical"): string =>
  severity === "critical" ? pc.red("●") : pc.yellow("●");

function uptimeHuman(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.round(seconds)}s`;
}

function renderTokenBudget(status: StatusSummary): void {
  const { tokens_today, tokens_month, monthly_budget_tokens } = status;
  process.stdout.write(`\n${pc.bold("Token budget")}\n`);
  const monthLine =
    monthly_budget_tokens != null && monthly_budget_tokens > 0
      ? `${formatTokens(tokens_month)} / ${formatTokens(monthly_budget_tokens)}`
      : formatTokens(tokens_month);
  const pct =
    monthly_budget_tokens != null && monthly_budget_tokens > 0
      ? Math.min(100, Math.round((tokens_month / monthly_budget_tokens) * 100))
      : null;
  const colorize =
    pct == null ? pc.dim : pct >= 90 ? pc.red : pct >= 60 ? pc.yellow : (s: string) => s;
  process.stdout.write(
    `  month ${colorize(monthLine)}${pct != null ? colorize(` (${pct}%)`) : ""}` +
      ` · today ${formatTokens(tokens_today)}\n`,
  );
}

function renderDigest(digest: OperatorHealthDigest): void {
  const failing = totalFailureCount(digest);
  // Failing runs.
  process.stdout.write(
    `\n${pc.bold("Failing runs")} ${pc.dim(`(last ${digest.window_hours}h)`)}\n`,
  );
  if (digest.failure_groups.length === 0) {
    process.stdout.write(`  ${pc.green("✔")} no failing runs\n`);
  } else {
    process.stdout.write(
      `  ${pc.red(`${failing} failing run(s) across`)} ${digest.failure_groups.length} cause(s):\n`,
    );
    for (const g of digest.failure_groups.slice(0, 6)) {
      const label = g.workflow_name ?? g.workflow_id ?? "(draft)";
      process.stdout.write(
        `    ${pc.red("●")} [${g.origin}] ${label} · ${g.step_key ?? "?"} · ${pc.red(g.error_code ?? "?")} · ${g.count}×\n`,
      );
    }
  }
  // Risk signals.
  if (digest.risk.length > 0) {
    process.stdout.write(`\n${pc.bold("Risk signals")}\n`);
    for (const r of digest.risk.slice(0, 6)) {
      process.stdout.write(
        `  ${RISK_GLYPH(r.severity)} [${r.severity}] ${r.headline} ${pc.dim(`(${r.metric}=${r.value}, threshold ${r.threshold})`)}\n`,
      );
    }
  }
  // Pending self-healing patch candidates.
  if (digest.patch_candidates.open > 0) {
    process.stdout.write(`\n${pc.bold("Self-healing")}\n`);
    process.stdout.write(
      `  ${pc.yellow(`${digest.patch_candidates.open} patch candidate(s) awaiting review`)}\n`,
    );
    for (const p of digest.patch_candidates.items.slice(0, 4)) {
      const label = p.workflow_name ?? p.workflow_id ?? "(workflow)";
      process.stdout.write(
        `    ${pc.dim("·")} ${p.id} · ${label} · [${p.classification}] ${p.summary}\n`,
      );
    }
  }
}

function renderRuntime(rt: DiagnosticsRuntime): void {
  process.stdout.write(`\n${pc.bold("Process runtime")}\n`);
  process.stdout.write(
    `  uptime ${uptimeHuman(rt.uptime_s)} · rss ${rt.memory.rss_mb}MB · heap ${rt.memory.heap_used_mb}/${rt.memory.heap_total_mb}MB · external ${rt.memory.external_mb}MB\n`,
  );
  const waitColor = rt.db_pool.waiting > 0 ? pc.yellow : (s: string) => s;
  const lagColor =
    rt.event_loop_lag_ms >= 200
      ? pc.red
      : rt.event_loop_lag_ms >= 50
        ? pc.yellow
        : (s: string) => s;
  process.stdout.write(
    `  db-pool ${rt.db_pool.total} total · ${rt.db_pool.idle} idle · ${waitColor(`${rt.db_pool.waiting} waiting`)}` +
      ` · event-loop lag ${lagColor(humanMs(rt.event_loop_lag_ms))}\n`,
  );
}

export const healthCommand = defineCommand({
  meta: {
    name: "health",
    description:
      "Runtime posture: liveness, token budget, failing runs, risk signals, schema drift, and process runtime. Use `sk doctor` for connectivity/setup.",
  },
  args: {
    "engine-url": { type: "string", description: "Engine base URL" },
    "window-hours": {
      type: "string",
      description: "Lookback window for failing runs (default 24)",
    },
    json: { type: "boolean", description: "JSON output (composite object)" },
  },
  async run({ args }) {
    const profile = resolveProfile({ engine_url: args["engine-url"] as string | undefined });
    const client = new EngineClient({
      engine_url: profile.engine_url,
      api_key: profile.api_key,
      tenant: profile.active_tenant_id,
    });

    // 1. Reachability — the only required section. A liveness failure is
    // a hard exit; everything else is best-effort chrome.
    let liveness: Awaited<ReturnType<EngineClient["health"]>>;
    let readiness: Awaited<ReturnType<EngineClient["ready"]>> | null = null;
    try {
      liveness = await client.health();
      readiness = await tryFetch(() => client.ready());
    } catch (err) {
      process.stderr.write(`unreachable: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }

    const windowHours = args["window-hours"] ? Number(args["window-hours"]) : undefined;
    const [status, digest, drift, runtime] = await Promise.all([
      tryFetch(() => client.statusSummary()),
      tryFetch(() =>
        client.getOperatorHealthDigest(windowHours != null ? { window_hours: windowHours } : {}),
      ),
      tryFetch(() => client.driftReport()),
      tryFetch(() => client.diagnosticsRuntime()),
    ]);

    if (args.json) {
      printJson({ health: liveness, ready: readiness, budget: status, digest, drift, runtime });
      return;
    }

    // Header.
    process.stdout.write(
      `\n${pc.bold("sk health")} · engine ${pc.dim(profile.engine_url)} · tenant ${pc.cyan(profile.active_tenant_id ?? "(none)")}\n`,
    );
    const liveGlyph = readiness?.status === "ready" ? pc.green("✔") : pc.yellow("⚠");
    process.stdout.write(
      `${liveGlyph} live=${liveness.status} · ready=${readiness?.status ?? "unreachable"} · version ${liveness.version}\n`,
    );

    if (status) renderTokenBudget(status);

    // `all_clear` answers "does anything need a person now". This command is
    // the runtime posture, so it also shows what is merely worth reading — a
    // failed trial run, a warning trend — when nothing needs acting on.
    if (
      digest &&
      (!digest.all_clear || digest.failure_groups.length > 0 || (digest.risk?.length ?? 0) > 0)
    ) {
      // Normalize `risk` at the chokepoint — a version-skewed engine
      // without the field would otherwise crash on `digest.risk.length`.
      renderDigest({ ...digest, risk: digest.risk ?? [] });
    } else {
      // all_clear, or the digest call failed: render a neutral all-clear.
      process.stdout.write(`\n${pc.bold("Failing runs")}\n  ${pc.green("✔")} nothing flagged\n`);
    }

    // Schema drift — one line; `sk doctor` owns resolution guidance.
    if (drift) {
      const unknown = drift.unknown_in_db.length;
      const historical = drift.historical_in_db.length;
      const missing = drift.missing_in_db.length;
      process.stdout.write(`\n${pc.bold("Schema")}\n`);
      if (unknown === 0 && missing === 0) {
        process.stdout.write(
          `  ${pc.green("✔")} embedded=${drift.embedded_migration_count} db=${drift.db_migration_count} ` +
            `(current${historical > 0 ? `; accepted_history=${historical}` : ""})\n`,
        );
      } else {
        process.stdout.write(
          `  ${pc.yellow("⚠")} drift: unknown_in_db=${unknown} accepted_history=${historical} ` +
            `missing_in_db=${missing} — run \`sk doctor\` for resolution\n`,
        );
      }
    }

    if (runtime) renderRuntime(runtime);

    process.stdout.write("\n");
  },
});
