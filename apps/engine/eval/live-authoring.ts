import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
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

const SCENARIO_TIMEOUT_MS = 10 * 60_000;

const DEFAULT_OUT = join(process.cwd(), "apps/engine/eval/out/live-authoring-report.json");

interface CliArgs {
  engine_url: string;
  api_key: string;
  scenarios: string[] | null;
  scenarios_file: string | null;
  out: string;
  baseline: string | null;
}

function usage(): never {
  console.error(
    [
      "Usage: bun run apps/engine/eval/live-authoring.ts --engine-url <url> --api-key <key>",
      "         [--scenario <slug>[,<slug>…]] [--scenarios-file <scenarios.json>]",
      "         [--out <report.json>] [--baseline <report.json>]",
      "",
      `Scenarios: ${LIVE_SCENARIOS.map((s) => s.slug).join(", ")}`,
      "  (--scenarios-file merges local-only scenarios; same JSON shape as LIVE_SCENARIOS entries)",
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
  let scenarios_file: string | null = null;
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
    else if (arg === "--scenarios-file") scenarios_file = next();
    else if (arg === "--out") out = next();
    else if (arg === "--baseline") baseline = next();
    else if (arg === "--help" || arg === "-h") usage();
    else usage();
  }
  if (!engine_url || !api_key) usage();
  return {
    engine_url: engine_url.replace(/\/+$/, ""),
    api_key,
    scenarios,
    scenarios_file,
    out,
    baseline,
  };
}

const ContentCheckSchema = z.object({
  name: z.string(),
  pattern: z.string(),
  flags: z.string().optional(),
});
const ScenarioFileEntrySchema = z.object({
  slug: z.string().min(1),
  goal: z.string().min(1),
  follow_up_turns: z.array(z.string().min(1)).optional(),
  connectors: z.array(z.string()),
  expect_judge_block: z.boolean(),
  content_checks: z.array(ContentCheckSchema),
  content_source: z.enum(["envelope", "final_output"]).optional(),
});
const ScenarioFileSchema = z.array(ScenarioFileEntrySchema);

function loadScenariosFile(path: string): LiveScenarioSpec[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`--scenarios-file: cannot read/parse ${path}: ${(e as Error).message}`);
    process.exit(2);
  }
  const parsed = ScenarioFileSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`--scenarios-file: invalid scenario file ${path}:\n${parsed.error.message}`);
    process.exit(2);
  }
  return parsed.data;
}

interface TurnEventLike {
  type?: string;
  tool?: string;
  output?: unknown;
  usage?: { turn_tokens?: number };
}

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
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        scenario: spec.slug,
        tool_calls: 0,
        results: [],
        status: "error",
        wall_ms: Date.now() - started,
        error: `POST /v1/conversations → ${res.status}: ${body.slice(0, 300)}`,
      };
    }
    let outcome = (await res.json()) as {
      conversation?: { id?: string };
      events?: TurnEventLike[];
      status?: string;
    };
    const conversationId = outcome.conversation?.id;

    let tokensAcrossTurns = projectEvents(outcome.events ?? []).tokens;
    if (conversationId && spec.follow_up_turns && spec.follow_up_turns.length > 0) {
      for (const turn of spec.follow_up_turns) {
        const turnRes = await engineFetch(args, `/v1/conversations/${conversationId}/messages`, {
          method: "POST",
          body: JSON.stringify({ message: turn, permission_mode: "auto" }),
        });
        if (!turnRes.ok) {
          const body = await turnRes.text().catch(() => "");
          return {
            scenario: spec.slug,
            tool_calls: 0,
            results: [],
            status: "error",
            wall_ms: Date.now() - started,
            error: `POST …/messages → ${turnRes.status}: ${body.slice(0, 300)}`,
          };
        }
        outcome = (await turnRes.json()) as typeof outcome;
        const t = projectEvents(outcome.events ?? []).tokens;
        if (t !== undefined) tokensAcrossTurns = (tokensAcrossTurns ?? 0) + t;
      }
    }

    const wall_ms = Date.now() - started;
    let projected = projectEvents(outcome.events ?? []);

    if (conversationId && (projected.tool_calls === 0 || (spec.follow_up_turns?.length ?? 0) > 0)) {
      const detailRes = await engineFetch(args, `/v1/conversations/${conversationId}`);
      if (detailRes.ok) {
        const detail = (await detailRes.json()) as {
          tool_calls?: Array<{ tool?: string; output?: unknown }>;
        };
        const calls = detail.tool_calls ?? [];
        if (calls.length > 0) {
          projected = {
            tool_calls: calls.length,
            results: calls
              .filter((c): c is { tool: string; output: unknown } => typeof c.tool === "string")
              .map((c) => ({ tool: c.tool, output: c.output })),
          };
        }
      }
    }

    return {
      scenario: spec.slug,
      tool_calls: projected.tool_calls,
      results: projected.results,
      status: outcome.status ?? "unknown",
      wall_ms,
      ...(tokensAcrossTurns !== undefined ? { tokens: tokensAcrossTurns } : {}),
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
  const fileScenarios = args.scenarios_file ? loadScenariosFile(args.scenarios_file) : [];
  const candidates: LiveScenarioSpec[] = [
    ...LIVE_SCENARIOS.filter((s) => !fileScenarios.some((f) => f.slug === s.slug)),
    ...fileScenarios,
  ];
  const specs = args.scenarios
    ? candidates.filter((s) => args.scenarios?.includes(s.slug))
    : candidates;
  if (args.scenarios && specs.length !== args.scenarios.length) {
    const known = new Set(candidates.map((s) => s.slug));
    console.error(`unknown scenario(s): ${args.scenarios.filter((s) => !known.has(s)).join(", ")}`);
    usage();
  }

  const started_at = new Date().toISOString();
  console.log(`live-authoring eval → ${args.engine_url} (${specs.length} scenario(s))\n`);

  const scores = [];
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
  const resultsOut = `${args.out.replace(/\.json$/, "")}.results.json`;
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
