export const BENCHMARK_TARGETS = {
  pipeline_llm_calls_max: 3,
  previews_expected: 1,
  tool_calls_max: 15,
} as const;

export interface ContentCheck {
  name: string;
  pattern: string;
  flags?: string;
}

export interface LiveScenarioSpec {
  slug: string;
  goal: string;
  follow_up_turns?: string[];
  connectors: string[];
  expect_judge_block: boolean;
  content_checks: ContentCheck[];
  content_source?: "envelope" | "final_output";
}

export interface ObservedToolCall {
  tool: string;
  output: unknown;
}

export interface ScenarioObservation {
  scenario: string;
  tool_calls: number;
  results: ObservedToolCall[];
  status: string;
  wall_ms: number;
  tokens?: number;
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
  llm_passes: number | null;
  judge: string | null;
  wall_ms: number;
  content_pass: boolean;
  tokens?: number;
  previews: number;
  first_preview_content_pass: boolean;
  converged: boolean;
  previews_to_pass: number | null;
  probe_before_author: boolean | null;
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

function envelopeOf(output: unknown): Record<string, unknown> | null {
  const rec = asRecord(output);
  if (!rec) return null;
  const inner = asRecord(rec.data);
  return inner ?? rec;
}

export function extractLlmPasses(results: ObservedToolCall[]): number | null {
  for (const r of results) {
    if (r.tool !== "author_workflow") continue;
    const env = envelopeOf(r.output);
    if (env && typeof env.attempts === "number") return env.attempts;
  }
  return null;
}

export function extractPreviews(results: ObservedToolCall[]): Array<Record<string, unknown>> {
  return results
    .filter((r) => r.tool === "dry_run_workflow")
    .map((r) => envelopeOf(r.output))
    .filter((e): e is Record<string, unknown> => e !== null);
}

export function extractJudgeVerdict(preview: Record<string, unknown> | undefined): string | null {
  const judge = asRecord(preview?.judge);
  return judge && typeof judge.verdict === "string" ? judge.verdict : null;
}

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
    ? isBlockingVerdict(score.judge)
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

export function scoreScenario(spec: LiveScenarioSpec, obs: ScenarioObservation): LiveScenarioScore {
  const notes: string[] = [];
  if (obs.error) notes.push(`run error: ${obs.error}`);

  const llm_passes = extractLlmPasses(obs.results);
  if (llm_passes === null) notes.push("author_workflow result envelope not observed");

  const previews = extractPreviews(obs.results);
  if (previews.length === 0) notes.push("no dry_run_workflow preview observed");

  const firstPreview = previews[0];
  let firstCorpus = "";
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

  let previews_to_pass: number | null = null;
  if (!spec.expect_judge_block) {
    const idx = previews.findIndex(
      (pv) => runContentChecks(corpusOf(pv), spec.content_checks).pass,
    );
    previews_to_pass = idx >= 0 ? idx + 1 : null;
  }
  const converged = previews_to_pass !== null;

  const firstPreviewIdx = obs.results.findIndex((r) => r.tool === "dry_run_workflow");
  const editedBeforePreview = obs.results
    .slice(0, firstPreviewIdx < 0 ? obs.results.length : firstPreviewIdx)
    .some((r) => ["edit_workflow_patch"].includes(r.tool));
  if (editedBeforePreview) {
    notes.push("NON-ISOLATED: edit tool fired before first preview — exclude trial");
  }

  const AUTHOR_TOOLS = ["author_workflow"];
  const authorIdx = obs.results.findIndex((r) => AUTHOR_TOOLS.includes(r.tool));
  const probe_before_author =
    authorIdx < 0
      ? null
      : obs.results
          .slice(0, authorIdx)
          .some((r) => r.tool === "probe_connector" || r.tool === "call_connector");
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

export function scenarioPassed(score: LiveScenarioScore): boolean {
  return score.content_pass && Object.values(score.targets).every((t) => t === "PASS");
}

export interface TrialAggregate {
  scenario: string;
  n_trials: number;
  excluded_non_isolated: number;
  content_pass_rate: number;
  converged_rate: number;
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
    content_checks: [
      { name: "spread_c numeric", pattern: '"spread_c"\\s*:\\s*-?\\d+(\\.\\d+)?' },
      { name: "highest_max_c numeric", pattern: '"highest_max_c"\\s*:\\s*-?\\d+(\\.\\d+)?' },
      { name: "lowest_min_c numeric", pattern: '"lowest_min_c"\\s*:\\s*-?\\d+(\\.\\d+)?' },
    ],
  },
  {
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
