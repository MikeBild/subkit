// Live-mode authoring eval runner (Fix E, live mode). NOT part of any
// CI gate — run manually pre-release against a target engine:
//
//   bun run apps/engine/eval/live-authoring.ts \
//     --engine-url https://engine.example.com \
//     --api-key sk_live_xxx \
//     [--scenario droplet-specs-email[,gh-org-top-repos-table,…]] \
//     [--out apps/engine/eval/out/live-authoring-report.json]
//
// Credentials come ONLY from argv (or the SK_ENGINE_URL / SK_API_KEY
// environment variables as a fallback) — this runner never reads .env
// files. It drives the engine's real conversation surface
// (POST /v1/conversations, permission_mode=auto) with the
// estate-derived goals in `live-report.ts#LIVE_SCENARIOS`, scores each
// run (conversation tool calls, internal pipeline passes from the
// `author_workflow` envelope, judge verdict, wall-clock, content
// assertions on the FIRST preview, tokens when reported), evaluates
// the code-derived benchmark targets (≤3 pipeline LLM calls, exactly
// 1 preview, ≤15 tool calls, content-correct first preview), and
// writes the JSON report into `eval/out/`.
//
// Exit codes: 0 — every scenario met every target; 1 — at least one
// target FAILED or a run errored; 2 — usage error.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compareLiveAuthoringReports } from "./live-benchmark.ts";
import {
  buildLiveReport,
  LIVE_SCENARIOS,
  type LiveAuthoringReport,
  type LiveScenarioSpec,
  type ObservedToolCall,
  type ScenarioObservation,
  scenarioPassed,
  scoreScenario,
} from "./live-report.ts";

/** Hard per-scenario wall-clock cap — a wedged conversation must not
 *  stall the whole report. */
const SCENARIO_TIMEOUT_MS = 10 * 60_000;

const DEFAULT_OUT = join(process.cwd(), "apps/engine/eval/out/live-authoring-report.json");

interface CliArgs {
  engine_url: string;
  api_key: string;
  scenarios: string[] | null;
  out: string;
  baseline: string | null;
}

function usage(): never {
  console.error(
    [
      "Usage: bun run apps/engine/eval/live-authoring.ts --engine-url <url> --api-key <key>",
      "         [--scenario <slug>[,<slug>…]] [--out <report.json>] [--baseline <report.json>]",
      "",
      `Scenarios: ${LIVE_SCENARIOS.map((s) => s.slug).join(", ")}`,
      "",
      "Env fallbacks: SK_ENGINE_URL, SK_API_KEY. No .env file is ever read.",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): CliArgs {
  let engine_url = process.env.SK_ENGINE_URL ?? "";
  let api_key = process.env.SK_API_KEY ?? "";
  let scenarios: string[] | null = null;
  let out = DEFAULT_OUT;
  let baseline: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) usage();
      i += 1;
      return v;
    };
    if (arg === "--engine-url") engine_url = next();
    else if (arg === "--api-key") api_key = next();
    else if (arg === "--scenario")
      scenarios = next()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (arg === "--out") out = next();
    else if (arg === "--baseline") baseline = next();
    else if (arg === "--help" || arg === "-h") usage();
    else usage();
  }
  if (!engine_url || !api_key) usage();
  return { engine_url: engine_url.replace(/\/+$/, ""), api_key, scenarios, out, baseline };
}

interface TurnEventLike {
  type?: string;
  tool?: string;
  output?: unknown;
  usage?: { turn_tokens?: number };
}

/** Project the engine's run-outcome events (or the conversation-detail
 *  fallback) into the scorer's observation shape. */
function projectEvents(events: TurnEventLike[]): {
  tool_calls: number;
  results: ObservedToolCall[];
  tokens?: number;
} {
  let tool_calls = 0;
  let tokens: number | undefined;
  const results: ObservedToolCall[] = [];
  for (const ev of events) {
    if (ev.type === "tool_call_end") tool_calls += 1;
    if (ev.type === "tool_result" && typeof ev.tool === "string") {
      results.push({ tool: ev.tool, output: ev.output });
    }
    if (ev.type === "completed" && typeof ev.usage?.turn_tokens === "number") {
      tokens = (tokens ?? 0) + ev.usage.turn_tokens;
    }
  }
  return { tool_calls, results, ...(tokens !== undefined ? { tokens } : {}) };
}

async function engineFetch(args: CliArgs, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${args.engine_url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${args.api_key}`,
      "content-type": "application/json",
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(SCENARIO_TIMEOUT_MS),
  });
}

async function runScenario(args: CliArgs, spec: LiveScenarioSpec): Promise<ScenarioObservation> {
  const started = Date.now();
  try {
    const res = await engineFetch(args, "/v1/conversations", {
      method: "POST",
      body: JSON.stringify({
        initial_message: spec.goal,
        permission_mode: "auto",
        title: `eval-live · ${spec.slug}`,
      }),
    });
    const wall_ms = Date.now() - started;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        scenario: spec.slug,
        tool_calls: 0,
        results: [],
        status: "error",
        wall_ms,
        error: `POST /v1/conversations → ${res.status}: ${body.slice(0, 300)}`,
      };
    }
    const outcome = (await res.json()) as {
      conversation?: { id?: string };
      events?: TurnEventLike[];
      status?: string;
    };
    let projected = projectEvents(outcome.events ?? []);

    // Fallback: some surfaces omit tool frames from the outcome events —
    // re-read the persisted conversation detail (messages + tool_calls).
    if (projected.tool_calls === 0 && outcome.conversation?.id) {
      const detailRes = await engineFetch(args, `/v1/conversations/${outcome.conversation.id}`);
      if (detailRes.ok) {
        const detail = (await detailRes.json()) as {
          tool_calls?: Array<{ tool?: string; output?: unknown }>;
        };
        const calls = detail.tool_calls ?? [];
        projected = {
          tool_calls: calls.length,
          results: calls
            .filter((c): c is { tool: string; output: unknown } => typeof c.tool === "string")
            .map((c) => ({ tool: c.tool, output: c.output })),
          ...(projected.tokens !== undefined ? { tokens: projected.tokens } : {}),
        };
      }
    }

    return {
      scenario: spec.slug,
      tool_calls: projected.tool_calls,
      results: projected.results,
      status: outcome.status ?? "unknown",
      wall_ms,
      ...(projected.tokens !== undefined ? { tokens: projected.tokens } : {}),
    };
  } catch (err) {
    return {
      scenario: spec.slug,
      tool_calls: 0,
      results: [],
      status: "error",
      wall_ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const specs = args.scenarios
    ? LIVE_SCENARIOS.filter((s) => args.scenarios?.includes(s.slug))
    : LIVE_SCENARIOS;
  if (args.scenarios && specs.length !== args.scenarios.length) {
    const known = new Set(LIVE_SCENARIOS.map((s) => s.slug));
    console.error(`unknown scenario(s): ${args.scenarios.filter((s) => !known.has(s)).join(", ")}`);
    usage();
  }

  const started_at = new Date().toISOString();
  console.log(`live-authoring eval → ${args.engine_url} (${specs.length} scenario(s))\n`);

  const scores = [];
  // Raw per-scenario observations (the actual tool outputs the model
  // produced), dumped alongside the report. This is the ground truth for the
  // evidence process: the scored row tells you PASS/FAIL, this file tells you
  // WHY — e.g. whether the rendered output really is a markdown table, or
  // whether a content-check failure is a measurement artifact vs a real defect.
  const observations: ScenarioObservation[] = [];
  for (const spec of specs) {
    console.log(`▶ ${spec.slug}`);
    const obs = await runScenario(args, spec);
    observations.push(obs);
    const score = scoreScenario(spec, obs);
    scores.push(score);
    const targetLine = Object.entries(score.targets)
      .map(([k, v]) => `${k}=${v}`)
      .join("  ");
    console.log(
      `  tool_calls=${score.tool_calls}  llm_passes=${score.llm_passes ?? "-"}  previews=${score.previews}  ` +
        `judge=${score.judge ?? "-"}  wall_ms=${score.wall_ms}  content_pass=${score.content_pass}` +
        (score.tokens !== undefined ? `  tokens=${score.tokens}` : ""),
    );
    console.log(`  ${targetLine}`);
    for (const note of score.notes) console.log(`  note: ${note}`);
    console.log("");
  }

  const report = buildLiveReport({
    scores,
    engine_host: new URL(args.engine_url).host,
    started_at,
    finished_at: new Date().toISOString(),
  });

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  // Sibling raw-observations dump (`<out>.results.json`) — the unscored tool
  // outputs, for evidence inspection. Same basename so it pairs with the report.
  const resultsOut = args.out.replace(/\.json$/, "") + ".results.json";
  writeFileSync(resultsOut, `${JSON.stringify(observations, null, 2)}\n`, "utf8");
  console.log(`Report: ${args.out}`);
  console.log(`Raw observations: ${resultsOut}`);
  console.log(`Scenarios: ${report.total}   PASS: ${report.passed}   FAIL: ${report.failed}`);

  let passed = report.scenarios.every((s) => scenarioPassed(s));
  if (args.baseline) {
    const baseline = JSON.parse(readFileSync(args.baseline, "utf8")) as LiveAuthoringReport;
    const comparison = compareLiveAuthoringReports(baseline, report);
    console.log(
      `Benchmark: ${comparison.common_scenarios} common, ` +
        `${comparison.regressions.length} regression(s), ${comparison.changes.length} change(s)`,
    );
    for (const change of comparison.changes) {
      const prefix = change.severity === "regression" ? "REGRESSION" : change.severity;
      console.log(`  ${prefix} ${change.scenario} ${change.metric}: ${change.message}`);
    }
    passed &&= comparison.passed;
  }

  process.exit(passed ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
