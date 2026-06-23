// Live-authoring eval — pure scoring + report writer (Fix E, live mode).
//
// Everything that can be computed without a network lives here so the
// unit tests (`eval/tests/live-report.test.ts`) cover the scoring and
// the benchmark-target evaluation deterministically. The thin CLI
// (`live-authoring.ts`) only drives the HTTP conversation surface and
// feeds the outcomes through these functions.
//
// Report shape per scenario (stable contract — release artifacts diff
// these across runs):
//
//   { scenario, tool_calls, llm_passes, judge, wall_ms, content_pass,
//     tokens?, targets: { <target>: "PASS" | "FAIL" } }
//
// Benchmark targets (code-derived anchors from the authoring-loop
// reshape plan; meeting them means meeting the documented loop shape):
//
//   - pipeline_llm_calls_le_3       — ≤3 internal generation passes
//   - single_preview                — exactly ONE dry_run_workflow
//   - tool_calls_le_15              — ≤15 conversation tool calls
//   - content_correct_first_preview — the FIRST preview already
//     satisfies the scenario's content assertions (for the
//     deliberately under-specified scenario this flips: the judge
//     must BLOCK the first preview).

export const BENCHMARK_TARGETS = {
  /** Max internal LLM generation passes inside `author_workflow`. */
  pipeline_llm_calls_max: 3,
  /** Expected number of `dry_run_workflow` previews on the happy path. */
  previews_expected: 1,
  /** Max conversation tool calls end-to-end. */
  tool_calls_max: 15,
} as const;

/** One content assertion: a regex the first preview's artifact corpus
 *  must match. Serialized as source+flags so scenario specs stay data. */
export interface ContentCheck {
  name: string;
  pattern: string;
  flags?: string;
}

export interface LiveScenarioSpec {
  slug: string;
  /** The goal sent verbatim as the conversation's initial message. */
  goal: string;
  /** Connector slugs the goal references — documentation only; the
   *  conversation model names them via `author_workflow`. */
  connectors: string[];
  /** True for the deliberately under-specified scenario: success means
   *  the preview judge BLOCKS instead of content passing. */
  expect_judge_block: boolean;
  content_checks: ContentCheck[];
  /**
   * Which corpus the content_checks run against:
   *  - "envelope" (default): the whole first-preview envelope (step traces,
   *    held requests, final_output). Correct for SEND/hold-writes workflows
   *    whose reviewable content is the held request, not a returned value.
   *  - "final_output": ONLY the resolved final output (post output_transform).
   *    Strict — a broken transform yields null/absent → corpus is "null"/""
   *    → discriminating checks fail. Required for data-returning scenarios so
   *    a check cannot pass off the definition echo or a request trace.
   */
  content_source?: "envelope" | "final_output";
}

/** Minimal projection of the engine's turn events / conversation
 *  detail the scorer reads. Tolerant of both the SSE/JSON `events`
 *  array and the `GET /v1/conversations/{id}` `tool_calls` fallback. */
export interface ObservedToolCall {
  tool: string;
  output: unknown;
}

export interface ScenarioObservation {
  scenario: string;
  /** Total conversation tool calls (tool_call_end count). */
  tool_calls: number;
  /** Every tool result in order, for envelope extraction. */
  results: ObservedToolCall[];
  /** Conversation final status (`active` / `awaiting_input` / `committed`). */
  status: string;
  wall_ms: number;
  /** Sum of `completed`-frame turn tokens when the engine reported them. */
  tokens?: number;
  /** Transport/setup error — scenario scored as failed. */
  error?: string;
}

export type TargetVerdict = "PASS" | "FAIL";

export interface ScenarioTargets {
  pipeline_llm_calls_le_3: TargetVerdict;
  single_preview: TargetVerdict;
  tool_calls_le_15: TargetVerdict;
  content_correct_first_preview: TargetVerdict;
}

export interface LiveScenarioScore {
  scenario: string;
  tool_calls: number;
  /** Internal generation passes from the `author_workflow` result
   *  envelope (`attempts`); null when the tool never ran. */
  llm_passes: number | null;
  /** Final preview-judge verdict (`passes`/`partial`/`failed`/`skipped`);
   *  null when no preview carried one. */
  judge: string | null;
  wall_ms: number;
  content_pass: boolean;
  tokens?: number;
  /** Number of dry_run_workflow previews observed. */
  previews: number;
  /** Whether the FIRST preview's artifacts passed the content checks. */
  first_preview_content_pass: boolean;
  /** Whether ANY preview reached a passing output (repair convergence).
   *  Null-equivalent (false) for judge-block scenarios. */
  converged: boolean;
  /** 1-based index of the first passing preview, or null if none passed.
   *  `previews_to_pass === 1` means it was right first shot; `> 1` means it
   *  took that many repair iterations. */
  previews_to_pass: number | null;
  /** Trajectory: did a probe_connector/call_connector precede the first
   *  author step? null when nothing was authored. */
  probe_before_author: boolean | null;
  /** Trajectory: did a dry_run_workflow precede the first explicit
   *  save_workflow_draft? true when there was no explicit save. */
  dry_run_before_save: boolean;
  expect_judge_block: boolean;
  status: string;
  targets: ScenarioTargets;
  notes: string[];
}

export interface LiveAuthoringReport {
  started_at: string;
  finished_at: string;
  engine_host: string;
  total: number;
  passed: number;
  failed: number;
  scenarios: LiveScenarioScore[];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Tool outputs arrive either as the bare tool `data` envelope or as
 *  the `{ ok, data }` wrapper depending on the surface — read both. */
function envelopeOf(output: unknown): Record<string, unknown> | null {
  const rec = asRecord(output);
  if (!rec) return null;
  const inner = asRecord(rec.data);
  return inner ?? rec;
}

/** `author_workflow` internal pass count from the result envelope. */
export function extractLlmPasses(results: ObservedToolCall[]): number | null {
  for (const r of results) {
    if (r.tool !== "author_workflow") continue;
    const env = envelopeOf(r.output);
    if (env && typeof env.attempts === "number") return env.attempts;
  }
  return null;
}

/** All dry_run_workflow result envelopes, in call order. */
export function extractPreviews(results: ObservedToolCall[]): Array<Record<string, unknown>> {
  return results
    .filter((r) => r.tool === "dry_run_workflow")
    .map((r) => envelopeOf(r.output))
    .filter((e): e is Record<string, unknown> => e !== null);
}

/** Judge verdict off a dry-run envelope (`judge: { verdict }`). */
export function extractJudgeVerdict(preview: Record<string, unknown> | undefined): string | null {
  const judge = asRecord(preview?.judge);
  return judge && typeof judge.verdict === "string" ? judge.verdict : null;
}

/** Run the scenario's content checks over a preview's serialized
 *  artifacts (step traces, held requests, summaries). */
export function runContentChecks(
  corpus: string,
  checks: ContentCheck[],
): { pass: boolean; failed: string[] } {
  const failed: string[] = [];
  for (const check of checks) {
    const re = new RegExp(check.pattern, check.flags ?? "");
    if (!re.test(corpus)) failed.push(check.name);
  }
  return { pass: failed.length === 0, failed };
}

function isBlockingVerdict(verdict: string | null): boolean {
  return verdict === "partial" || verdict === "failed";
}

export function evaluateBenchmarkTargets(
  score: Pick<
    LiveScenarioScore,
    | "llm_passes"
    | "previews"
    | "tool_calls"
    | "first_preview_content_pass"
    | "expect_judge_block"
    | "judge"
  >,
): ScenarioTargets {
  const contentTarget = score.expect_judge_block
    ? // Under-specified scenario: the FIRST preview must be BLOCKED by
      // the judge — silently green-and-wrong is the failure mode.
      isBlockingVerdict(score.judge)
    : score.first_preview_content_pass;
  return {
    pipeline_llm_calls_le_3:
      score.llm_passes !== null &&
      score.llm_passes >= 1 &&
      score.llm_passes <= BENCHMARK_TARGETS.pipeline_llm_calls_max
        ? "PASS"
        : "FAIL",
    single_preview: score.previews === BENCHMARK_TARGETS.previews_expected ? "PASS" : "FAIL",
    tool_calls_le_15:
      score.tool_calls > 0 && score.tool_calls <= BENCHMARK_TARGETS.tool_calls_max
        ? "PASS"
        : "FAIL",
    content_correct_first_preview: contentTarget ? "PASS" : "FAIL",
  };
}

/**
 * Score one observed scenario run. Pure: feed it the observation
 * (events already projected) + the spec, get the stable report row.
 */
export function scoreScenario(spec: LiveScenarioSpec, obs: ScenarioObservation): LiveScenarioScore {
  const notes: string[] = [];
  if (obs.error) notes.push(`run error: ${obs.error}`);

  const llm_passes = extractLlmPasses(obs.results);
  if (llm_passes === null) notes.push("author_workflow result envelope not observed");

  const previews = extractPreviews(obs.results);
  if (previews.length === 0) notes.push("no dry_run_workflow preview observed");

  const firstPreview = previews[0];
  // Corpus selection (evidence discipline): "final_output" scenarios score the
  // resolved final output ONLY — never the whole envelope, which also carries
  // step traces, the definition echo, and per-step output_preview that regexes
  // leak onto (request coords, field names in the transform source) and pass
  // even when the produced output is null. "envelope" (default) keeps the
  // whole-preview corpus for SEND/hold-writes scenarios whose reviewable
  // content is the held request, not a returned value.
  let firstCorpus = "";
  // Corpus for one preview, honoring content_source (final_output-only vs the
  // whole envelope). Shared by the first-preview check and the convergence scan.
  const corpusOf = (pv: Record<string, unknown>): string => {
    if (spec.content_source === "final_output") {
      const fo = pv.final_output;
      return fo === undefined ? "" : (JSON.stringify(fo) ?? "");
    }
    return JSON.stringify(pv) ?? "";
  };
  if (firstPreview) firstCorpus = corpusOf(firstPreview);
  const firstContent = runContentChecks(firstCorpus, spec.content_checks);
  if (!firstContent.pass && firstPreview) {
    notes.push(`first preview failed content checks: ${firstContent.failed.join(", ")}`);
  }
  const first_preview_content_pass = previews.length > 0 && firstContent.pass;

  // Convergence (T-B metric): the FIRST preview (1-based) whose output passes
  // the content checks — captures repair convergence across iterations, not
  // just the first shot. `converged` is whether ANY preview reached a passing
  // output. Meaningless for judge-block scenarios (no content target).
  let previews_to_pass: number | null = null;
  if (!spec.expect_judge_block) {
    const idx = previews.findIndex(
      (pv) => runContentChecks(corpusOf(pv), spec.content_checks).pass,
    );
    previews_to_pass = idx >= 0 ? idx + 1 : null;
  }
  const converged = previews_to_pass !== null;

  // Isolation guard (T-A): if a draft-mutating tool fired BEFORE the first
  // dry_run_workflow, the first preview reflects a repair-proposal edit
  // (path 3), not raw GENERATE (path 2). Flag the trial so analysis can drop
  // it — a content win must be attributable to generation, not repair.
  const firstPreviewIdx = obs.results.findIndex((r) => r.tool === "dry_run_workflow");
  const editedBeforePreview = obs.results
    .slice(0, firstPreviewIdx < 0 ? obs.results.length : firstPreviewIdx)
    .some((r) => ["edit_workflow_patch", "update_param", "connect_steps"].includes(r.tool));
  if (editedBeforePreview) {
    notes.push("NON-ISOLATED: edit tool fired before first preview — exclude trial");
  }

  // Trajectory metrics (orchestration eval): score the tool-call SEQUENCE, not
  // just the final output — the harness for the T-C question (do loop skills
  // steer better tool choice?). Pure ordering reads of the existing tool stream.
  const AUTHOR_TOOLS = ["author_workflow", "build_workflow"];
  const authorIdx = obs.results.findIndex((r) => AUTHOR_TOOLS.includes(r.tool));
  // probe_before_author: did a probe_connector/call_connector precede the FIRST
  // author step? Authoring against real recorded shapes (vs guesses) is the
  // single biggest authoring-failure lever. Null when nothing was authored.
  const probe_before_author =
    authorIdx < 0
      ? null
      : obs.results
          .slice(0, authorIdx)
          .some((r) => r.tool === "probe_connector" || r.tool === "call_connector");
  // dry_run_before_save: did a dry_run_workflow precede the first explicit
  // save_workflow_draft (verify-before-persist)? True when there is no explicit
  // save (a green, judged dry-run auto-commits — the verified path).
  const saveIdx = obs.results.findIndex((r) => r.tool === "save_workflow_draft");
  const dry_run_before_save =
    saveIdx < 0 ? true : obs.results.slice(0, saveIdx).some((r) => r.tool === "dry_run_workflow");

  const firstVerdict = extractJudgeVerdict(firstPreview);
  const lastVerdict = extractJudgeVerdict(previews[previews.length - 1]);
  const judge = spec.expect_judge_block ? firstVerdict : (lastVerdict ?? firstVerdict);

  const content_pass = spec.expect_judge_block
    ? isBlockingVerdict(firstVerdict)
    : first_preview_content_pass;

  const partial = {
    llm_passes,
    previews: previews.length,
    tool_calls: obs.tool_calls,
    first_preview_content_pass,
    expect_judge_block: spec.expect_judge_block,
    judge,
  };

  return {
    scenario: spec.slug,
    tool_calls: obs.tool_calls,
    llm_passes,
    judge,
    wall_ms: obs.wall_ms,
    content_pass,
    ...(obs.tokens !== undefined ? { tokens: obs.tokens } : {}),
    previews: previews.length,
    first_preview_content_pass,
    converged,
    previews_to_pass,
    probe_before_author,
    dry_run_before_save,
    expect_judge_block: spec.expect_judge_block,
    status: obs.status,
    targets: evaluateBenchmarkTargets(partial),
    notes,
  };
}

/** A scenario passes when every benchmark target is PASS and its
 *  content expectation held. */
export function scenarioPassed(score: LiveScenarioScore): boolean {
  return score.content_pass && Object.values(score.targets).every((t) => t === "PASS");
}

/** Per-scenario aggregate across N trials — the "report a RATE, not a single
 *  run" practice (LLM output is stochastic; a 1-few-trial verdict is
 *  underpowered). NON-ISOLATED trials (a draft-mutating tool fired before the
 *  first preview) are EXCLUDED from the rates. Pure — the run.sh delta loop and
 *  a future `sk eval` feed it the per-trial scores for one scenario. */
export interface TrialAggregate {
  scenario: string;
  /** Isolated trials counted (excludes NON-ISOLATED). */
  n_trials: number;
  excluded_non_isolated: number;
  content_pass_rate: number;
  converged_rate: number;
  /** Over trials where probe_before_author is non-null (something authored). */
  probe_before_author_rate: number;
  dry_run_before_save_rate: number;
  median_previews_to_pass: number | null;
  median_tool_calls: number | null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] ?? null) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

export function aggregateTrials(scores: LiveScenarioScore[]): TrialAggregate {
  const scenario = scores[0]?.scenario ?? "(none)";
  const isolated = scores.filter((s) => !s.notes.some((n) => n.includes("NON-ISOLATED")));
  const n = isolated.length;
  const rate = (pred: (s: LiveScenarioScore) => boolean): number =>
    n === 0 ? 0 : isolated.filter(pred).length / n;
  const probeEligible = isolated.filter((s) => s.probe_before_author !== null);
  return {
    scenario,
    n_trials: n,
    excluded_non_isolated: scores.length - n,
    content_pass_rate: rate((s) => s.content_pass),
    converged_rate: rate((s) => s.converged),
    probe_before_author_rate:
      probeEligible.length === 0
        ? 0
        : probeEligible.filter((s) => s.probe_before_author === true).length / probeEligible.length,
    dry_run_before_save_rate: rate((s) => s.dry_run_before_save),
    median_previews_to_pass: median(
      isolated.map((s) => s.previews_to_pass).filter((p): p is number => p !== null),
    ),
    median_tool_calls: median(isolated.map((s) => s.tool_calls)),
  };
}

export function buildLiveReport(args: {
  scores: LiveScenarioScore[];
  engine_host: string;
  started_at: string;
  finished_at: string;
}): LiveAuthoringReport {
  const passed = args.scores.filter(scenarioPassed).length;
  return {
    started_at: args.started_at,
    finished_at: args.finished_at,
    engine_host: args.engine_host,
    total: args.scores.length,
    passed,
    failed: args.scores.length - passed,
    scenarios: args.scores,
  };
}

// ── Estate-derived live scenarios ──────────────────────────────────────
//
// Seeded from the production estate's known-good workflows (the
// "authoring gold standard"): the DO droplet-specs email (the incident
// class), the GitHub org top-repos table, the Berlin weather summary —
// plus one deliberately under-specified goal the judge must block.

export const LIVE_SCENARIOS: LiveScenarioSpec[] = [
  {
    slug: "droplet-specs-email",
    goal:
      "Author a workflow that emails user@example.com a report of my DigitalOcean projects: " +
      "for every project list its name and the specs of every droplet in it (vCPUs, memory, disk). " +
      "Use the digitalocean and gmail connectors, preview it, and save it when the preview is correct.",
    connectors: ["digitalocean", "gmail"],
    expect_judge_block: false,
    content_checks: [
      { name: "recipient present", pattern: "user@example\\.com" },
      { name: "project names non-empty", pattern: '"name"\\s*:\\s*"[^"]+"' },
      { name: "cpu spec present", pattern: "vcpu|cpu", flags: "i" },
      { name: "memory spec present", pattern: "memory|ram|_gb|gb\\b", flags: "i" },
      { name: "disk spec present", pattern: "disk", flags: "i" },
    ],
  },
  {
    slug: "gh-org-top-repos-table",
    goal:
      "Author a workflow that returns a markdown table of the top 5 repositories of my GitHub " +
      "organization ranked by stars, with columns rank, repository and stars. " +
      "Use the github connector, preview it, and save it when the preview is correct.",
    connectors: ["github"],
    expect_judge_block: false,
    content_checks: [
      { name: "markdown table row", pattern: "\\|[^|\\n]+\\|" },
      { name: "markdown table separator", pattern: "\\|\\s*:?-{3,}" },
      { name: "stars column", pattern: "stars", flags: "i" },
    ],
  },
  {
    slug: "berlin-weather-summary",
    goal:
      "Author a workflow that returns tomorrow's weather for Berlin as a short summary with the " +
      "minimum and maximum temperature in degrees Celsius. Preview it and save it when the preview is correct.",
    connectors: ["open-meteo"],
    expect_judge_block: false,
    content_checks: [
      { name: "temperature digits", pattern: "-?\\d+(\\.\\d+)?" },
      { name: "min/max present", pattern: "min|max|tmin|tmax", flags: "i" },
    ],
  },
  {
    slug: "underspecified-judge-block",
    goal: "Author a workflow that emails the report. Preview it and save it.",
    connectors: [],
    expect_judge_block: true,
    content_checks: [],
  },
  {
    // Multi-step build: 2 fetches → per-city max-of-array transform →
    // cross-city ranking transform → markdown table. Exercises the
    // transform-authoring path (transforms reference fetched data the first
    // preview has not yet recorded) in a single shot. Kept to TWO cities so
    // the one-shot generation stays within the 90s per-call LLM timeout — a
    // three-city version sat on that ceiling and timed out intermittently.
    // Keyless (open-meteo), so it runs with no connector credentials.
    slug: "weather-ranking-table",
    goal:
      "Author a workflow that compares the 7-day maximum-temperature forecast for two cities — " +
      "Berlin (latitude 52.52, longitude 13.41) and Hamburg (latitude 53.55, longitude 9.99). " +
      "For each city call the open-meteo connector's /v1/forecast endpoint with " +
      "daily=temperature_2m_max and forecast_days=7, find that city's warmest day (its date and the " +
      "maximum temperature in degrees Celsius), then return a markdown table that ranks the two " +
      "cities by their warmest day hottest-first, with columns rank, city, warmest_day and " +
      "max_temp_c. Preview it and save it when the preview is correct.",
    connectors: ["open-meteo"],
    expect_judge_block: false,
    content_checks: [
      { name: "berlin present", pattern: "Berlin", flags: "i" },
      { name: "hamburg present", pattern: "Hamburg", flags: "i" },
      { name: "markdown table row", pattern: "\\|[^|\\n]+\\|" },
      { name: "markdown separator", pattern: "\\|\\s*:?-{3,}" },
      { name: "warmest_day date", pattern: "20\\d\\d-\\d\\d-\\d\\d" },
      { name: "temperature value", pattern: "\\d+(\\.\\d+)?" },
    ],
  },
  {
    // T-A scenario A — JS-transform scope addressing (a data-handling body gap).
    // Without the data-handling rules the model writes `$scope.<id>.data`
    // (JSONata) inside a JS transform; `$scope` is undefined in QuickJS → the
    // transform returns undefined → the final output has no real spread_c.
    // Scored against final_output ONLY (content_source) with VALUE checks: the
    // fields must hold real decimals, and a serialized `"spread_c": null` must
    // be ABSENT. These cannot pass off the definition echo or a request trace.
    slug: "ta-js-transform-input-scope",
    goal:
      "Author a workflow that fetches the 7-day forecast for Berlin (latitude 52.52, longitude 13.41) " +
      "from the open-meteo connector's /v1/forecast endpoint using daily=temperature_2m_max,temperature_2m_min " +
      "and forecast_days=7. Add a JavaScript transform step (language: javascript) that reads the fetched " +
      "arrays from scope, finds the single highest value in temperature_2m_max and the single lowest value " +
      "in temperature_2m_min across all 7 days, and computes the weekly temperature spread " +
      "(highest_max minus lowest_min). Shape the final output using output_transform_function so the " +
      "workflow returns a JSON object with fields highest_max_c, lowest_min_c, and spread_c " +
      "(all numbers rounded to one decimal place). Preview it and save it when the preview is correct.",
    connectors: ["open-meteo"],
    expect_judge_block: false,
    content_source: "final_output",
    // Numeric checks are self-discriminating: a broken transform serializes
    // `"spread_c": null`, which does NOT match `-?\d+` → the check fails. (No
    // negative "must-not-contain-null" check — runContentChecks treats a regex
    // MATCH as PASS, so a negation would invert; the numeric match covers it.)
    content_checks: [
      { name: "spread_c numeric", pattern: '"spread_c"\\s*:\\s*-?\\d+(\\.\\d+)?' },
      { name: "highest_max_c numeric", pattern: '"highest_max_c"\\s*:\\s*-?\\d+(\\.\\d+)?' },
      { name: "lowest_min_c numeric", pattern: '"lowest_min_c"\\s*:\\s*-?\\d+(\\.\\d+)?' },
    ],
  },
  {
    // T-A scenario B — JSONata variable-block in output_transform (a
    // workflow-authoring/data-handling JSONata-syntax gap). A bare `:=` in an
    // object constructor is a compile error → output_transform fails → final
    // output is null/absent. Scored against final_output ONLY with VALUE checks.
    slug: "ta-jsonata-variable-block",
    goal:
      "Author a workflow that fetches the 7-day forecast for Berlin (latitude 52.52, longitude 13.41) " +
      "from the open-meteo connector's /v1/forecast endpoint using daily=temperature_2m_max,temperature_2m_min,time " +
      "and forecast_days=7. Use a single request step and no separate transform step. Shape the final output " +
      "with a JSONata output_transform expression (not output_transform_function) that produces a JSON object " +
      "with two fields: hottest_day (the date string from daily.time at the index of the maximum value in " +
      "daily.temperature_2m_max) and hottest_temp_c (the maximum value in daily.temperature_2m_max). " +
      "Preview it and save it when the preview is correct.",
    connectors: ["open-meteo"],
    expect_judge_block: false,
    content_source: "final_output",
    content_checks: [
      { name: "hottest_temp_c numeric", pattern: '"hottest_temp_c"\\s*:\\s*-?\\d+(\\.\\d+)?' },
      { name: "hottest_day iso date", pattern: '"hottest_day"\\s*:\\s*"20\\d\\d-\\d\\d-\\d\\d"' },
    ],
  },
];
