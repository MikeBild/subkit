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
  const firstCorpus = firstPreview ? (JSON.stringify(firstPreview) ?? "") : "";
  const firstContent = runContentChecks(firstCorpus, spec.content_checks);
  if (!firstContent.pass && firstPreview) {
    notes.push(`first preview failed content checks: ${firstContent.failed.join(", ")}`);
  }
  const first_preview_content_pass = previews.length > 0 && firstContent.pass;

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
];
