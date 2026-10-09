import { findPlaceholderDestinations } from "../src/workflows/destination-placeholders.ts";

export const BENCHMARK_TARGETS = {
  pipeline_llm_calls_max: 3,
  previews_expected: 1,
  tool_calls_max: 15,
  clarification_tool_calls_max: 4,
} as const;

export const EVAL_LIVE_TITLE_PREFIX = "eval-live · ";

export const RECIPIENT_TEMPLATE = "{recipient}";

export const ASK_TOOLS: ReadonlySet<string> = new Set([
  "ask_user_text",
  "ask_user_form",
  "ask_user_choice",
  "ask_user_multi",
]);

export const AUTHORING_TOOLS: ReadonlySet<string> = new Set([
  "author_workflow",
  "edit_workflow_patch",
  "dry_run_workflow",
  "save_workflow_draft",
]);

export const PLACEHOLDER_GATE_ERROR_CODES: ReadonlySet<string> = new Set([
  "workflow_placeholder_destination",
  "authoring_definition_invalid",
]);

export const AUTO_REPAIRED_WARNING_CODE = "preview.auto_repaired";

export type ScenarioKind = "authoring" | "clarification";

export interface ContentCheck {
  name: string;
  pattern: string;
  flags?: string;
}

export interface LiveScenarioSpec {
  slug: string;
  kind: ScenarioKind;
  goal: string;
  follow_up_turns?: string[];
  answer_turns?: string[];
  connectors: string[];
  content_checks: ContentCheck[];
  content_source?: "envelope" | "final_output";
}

export interface ObservedToolCall {
  tool: string;
  input: unknown;
  output: unknown;
  call_id: string;
}

export interface ObservedTurn {
  tool_calls: ObservedToolCall[];
  assistant_text: string;
  status: string;
  pending_elicitation_id: string | null;
  delivered_ask?: { tool_name: string | null; input: unknown } | null;
}

export interface CreatedArtifact {
  kind: "workflow" | "knowledge_source" | "connector" | "conversation";
  id: string;
  slug?: string;
}

export interface ScenarioObservation {
  scenario: string;
  tool_calls: number;
  results: ObservedToolCall[];
  turns: ObservedTurn[];
  committed_workflow_id: string | null;
  created_artifacts: CreatedArtifact[];
  status: string;
  wall_ms: number;
  tokens?: number;
  error?: string;
}

export type TargetVerdict = "PASS" | "FAIL";

export interface AuthoringTargets {
  pipeline_llm_calls_le_3: TargetVerdict;
  single_preview: TargetVerdict;
  tool_calls_le_15: TargetVerdict;
  content_correct_first_preview: TargetVerdict;
}

export interface ClarificationTargets {
  single_clarifying_question: TargetVerdict;
  no_authoring_before_answer: TargetVerdict;
  question_names_missing_inputs: TargetVerdict;
  no_placeholder_in_reply: TargetVerdict;
  placeholder_rejected_after_answer?: TargetVerdict;
}

export type ScenarioTargets = AuthoringTargets | ClarificationTargets;

export interface LiveScenarioScore {
  scenario: string;
  kind: ScenarioKind;
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
  guard_fired: boolean | null;
  auto_repaired_first_preview: boolean;
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
  trials?: TrialAggregate[];
  cleanup?: { deleted: number; failures: string[] };
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

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bindText(text: string, recipient: string): string {
  return text.split(RECIPIENT_TEMPLATE).join(recipient);
}

export function bindScenarioInputs(
  spec: LiveScenarioSpec,
  inputs: { recipient: string },
): LiveScenarioSpec {
  const recipient = inputs.recipient;
  return {
    ...spec,
    goal: bindText(spec.goal, recipient),
    ...(spec.follow_up_turns
      ? { follow_up_turns: spec.follow_up_turns.map((t) => bindText(t, recipient)) }
      : {}),
    ...(spec.answer_turns
      ? { answer_turns: spec.answer_turns.map((t) => bindText(t, recipient)) }
      : {}),
    content_checks: spec.content_checks.map((c) => ({
      ...c,
      pattern: bindText(c.pattern, escapeRegExp(recipient)),
    })),
  };
}

export function specNeedsRecipient(spec: LiveScenarioSpec): boolean {
  return [
    spec.goal,
    ...(spec.follow_up_turns ?? []),
    ...(spec.answer_turns ?? []),
    ...spec.content_checks.map((c) => c.pattern),
  ].some((t) => t.includes(RECIPIENT_TEMPLATE));
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

export function previewWasAutoRepaired(preview: Record<string, unknown> | undefined): boolean {
  if (!preview) return false;
  if (asRecord(preview.auto_repair)) return true;
  const warnings = Array.isArray(preview.warnings) ? preview.warnings : [];
  return warnings.some((w) => asRecord(w)?.code === AUTO_REPAIRED_WARNING_CODE);
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

export function evaluateBenchmarkTargets(
  score: Pick<
    LiveScenarioScore,
    "llm_passes" | "previews" | "tool_calls" | "first_preview_content_pass"
  >,
): AuthoringTargets {
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
    content_correct_first_preview: score.first_preview_content_pass ? "PASS" : "FAIL",
  };
}

function askCorpus(calls: ObservedToolCall[]): string {
  return calls
    .filter((c) => ASK_TOOLS.has(c.tool))
    .map((c) => JSON.stringify(c.input) ?? "")
    .join("\n");
}

function askTexts(calls: ObservedToolCall[]): string[] {
  const texts: string[] = [];
  for (const call of calls) {
    if (!ASK_TOOLS.has(call.tool)) continue;
    const input = asRecord(call.input);
    if (!input) continue;
    if (typeof input.question === "string") texts.push(input.question);
    if (typeof input.placeholder === "string") texts.push(input.placeholder);
    if (typeof input.default === "string") texts.push(input.default);
    const fields = Array.isArray(input.fields) ? input.fields : [];
    for (const f of fields) {
      const field = asRecord(f);
      if (!field) continue;
      if (typeof field.label === "string") texts.push(field.label);
      if (typeof field.placeholder === "string") texts.push(field.placeholder);
      if (typeof field.default === "string") texts.push(field.default);
    }
    const options = Array.isArray(input.options) ? input.options : [];
    for (const o of options) {
      if (typeof o === "string") texts.push(o);
      const opt = asRecord(o);
      if (opt && typeof opt.label === "string") texts.push(opt.label);
      if (opt && typeof opt.value === "string") texts.push(opt.value);
    }
  }
  return texts;
}

export function findReplyPlaceholders(turn: ObservedTurn): string[] {
  const asks = turn.delivered_ask
    ? askTexts([
        {
          tool: turn.delivered_ask.tool_name ?? "ask_user_form",
          input: turn.delivered_ask.input,
          output: null,
          call_id: "delivered",
        },
      ])
    : askTexts(turn.tool_calls);
  const corpus = [turn.assistant_text, ...asks].join("\n");
  return findPlaceholderDestinations(corpus, "all").map((h) => h.match);
}

function errorCodeOf(output: unknown): string | null {
  const rec = asRecord(output);
  if (!rec) return null;
  if (typeof rec.error_code === "string") return rec.error_code;
  const data = asRecord(rec.data);
  return data && typeof data.error_code === "string" ? data.error_code : null;
}

function hasPlaceholderDestinations(output: unknown): boolean {
  const rec = asRecord(output);
  if (!rec) return false;
  const direct = rec.placeholder_destinations;
  const nested = asRecord(rec.data)?.placeholder_destinations;
  return (
    (Array.isArray(direct) && direct.length > 0) || (Array.isArray(nested) && nested.length > 0)
  );
}

export function placeholderGuardFired(calls: ObservedToolCall[]): boolean {
  return calls.some((c) => {
    const code = errorCodeOf(c.output);
    if (code === "workflow_placeholder_destination") return true;
    if (code === "authoring_definition_invalid") return hasPlaceholderDestinations(c.output);
    return false;
  });
}

function isProseQuestion(turn: ObservedTurn): boolean {
  return turn.status !== "awaiting_input" && /\?/.test(turn.assistant_text);
}

export function evaluateClarificationTargets(
  spec: LiveScenarioSpec,
  obs: ScenarioObservation,
): { targets: ClarificationTargets; guard_fired: boolean | null; notes: string[] } {
  const notes: string[] = [];
  const first: ObservedTurn = obs.turns[0] ?? {
    tool_calls: [],
    assistant_text: "",
    status: obs.status,
    pending_elicitation_id: null,
  };
  const asks = first.tool_calls.filter((c) => ASK_TOOLS.has(c.tool));
  const authoredFirst = first.tool_calls.filter((c) => AUTHORING_TOOLS.has(c.tool));
  const proseAsk = asks.length === 0 && authoredFirst.length === 0 && isProseQuestion(first);
  const structuredAsk = asks.length === 1 && first.status === "awaiting_input";
  const bounded = first.tool_calls.length <= BENCHMARK_TARGETS.clarification_tool_calls_max;
  if (proseAsk) notes.push("asked in prose (answered through the composer)");
  if (!structuredAsk && !proseAsk) {
    notes.push(
      `first turn asked ${asks.length} structured question(s) with status ${first.status} and no prose question`,
    );
  }
  if (!bounded) {
    notes.push(
      `first turn made ${first.tool_calls.length} tool calls, max ${BENCHMARK_TARGETS.clarification_tool_calls_max}`,
    );
  }
  if (authoredFirst.length > 0) {
    notes.push(`authoring before the answer: ${authoredFirst.map((c) => c.tool).join(", ")}`);
  }
  const questionCorpus = proseAsk ? first.assistant_text : askCorpus(asks);
  const questionChecks = runContentChecks(questionCorpus, spec.content_checks);
  if ((asks.length > 0 || proseAsk) && !questionChecks.pass) {
    notes.push(`question does not name missing inputs: ${questionChecks.failed.join(", ")}`);
  }
  const placeholders = findReplyPlaceholders(first);
  if (placeholders.length > 0) notes.push(`placeholder in reply: ${placeholders.join(", ")}`);

  const targets: ClarificationTargets = {
    single_clarifying_question: (structuredAsk || proseAsk) && bounded ? "PASS" : "FAIL",
    no_authoring_before_answer: authoredFirst.length === 0 ? "PASS" : "FAIL",
    question_names_missing_inputs:
      (asks.length > 0 || proseAsk) && questionChecks.pass ? "PASS" : "FAIL",
    no_placeholder_in_reply: placeholders.length === 0 ? "PASS" : "FAIL",
  };

  const answers = spec.answer_turns ?? [];
  if (answers.length === 0) return { targets, guard_fired: null, notes };

  const later = obs.turns.slice(1);
  const laterCalls = later.flatMap((t) => t.tool_calls);
  const guard_fired = placeholderGuardFired(laterCalls);
  const answerPlaceholders = answers.flatMap((a) =>
    findPlaceholderDestinations(a, "all").map((h) => h.match),
  );
  const refusalNamesPlaceholder = later.some((t) =>
    findReplyPlaceholders(t).some((m) => answerPlaceholders.includes(m)),
  );
  const stoppedWithoutAuthoring =
    laterCalls.every((c) => !AUTHORING_TOOLS.has(c.tool)) &&
    later.some((t) => t.status === "awaiting_input" || isProseQuestion(t));
  const refused = stoppedWithoutAuthoring && refusalNamesPlaceholder;
  const reAsked =
    laterCalls.some((c) => ASK_TOOLS.has(c.tool)) ||
    later.some(
      (t) => t.tool_calls.every((c) => !AUTHORING_TOOLS.has(c.tool)) && isProseQuestion(t),
    );
  const saved =
    obs.results.some((c) => c.tool === "save_workflow_draft") || obs.committed_workflow_id !== null;
  const artifacts = obs.created_artifacts.filter((a) => a.kind !== "conversation");
  if (later.length === 0) notes.push("no turn observed after the answer");
  if (!guard_fired && !refused) {
    notes.push(
      stoppedWithoutAuthoring
        ? `renewed question does not address the placeholder ${answerPlaceholders.join(", ")}`
        : "placeholder answer was neither gated nor refused",
    );
  }
  if (!reAsked) notes.push("no renewed clarifying question after the placeholder answer");
  if (saved) notes.push("workflow saved after a placeholder answer");
  if (artifacts.length > 0) {
    notes.push(`artifacts created: ${artifacts.map((a) => `${a.kind}:${a.id}`).join(", ")}`);
  }
  notes.push(`guard_fired=${guard_fired}`);
  targets.placeholder_rejected_after_answer =
    later.length > 0 && (guard_fired || refused) && reAsked && !saved && artifacts.length === 0
      ? "PASS"
      : "FAIL";
  return { targets, guard_fired, notes };
}

export function scoreScenario(spec: LiveScenarioSpec, obs: ScenarioObservation): LiveScenarioScore {
  const notes: string[] = [];
  if (obs.error) notes.push(`run error: ${obs.error}`);

  const llm_passes = extractLlmPasses(obs.results);
  const previews = extractPreviews(obs.results);
  const firstPreview = previews[0];
  const corpusOf = (pv: Record<string, unknown>): string => {
    if (spec.content_source === "final_output") {
      const fo = pv.final_output;
      return fo === undefined ? "" : (JSON.stringify(fo) ?? "");
    }
    return JSON.stringify(pv) ?? "";
  };
  const firstContent = runContentChecks(
    firstPreview ? corpusOf(firstPreview) : "",
    spec.content_checks,
  );
  const first_preview_content_pass = previews.length > 0 && firstContent.pass;
  const passIdx = previews.findIndex(
    (pv) => runContentChecks(corpusOf(pv), spec.content_checks).pass,
  );
  const previews_to_pass = passIdx >= 0 ? passIdx + 1 : null;
  const auto_repaired_first_preview = previewWasAutoRepaired(firstPreview);
  if (auto_repaired_first_preview) notes.push("AUTO-REPAIRED: first preview output site");

  const firstPreviewIdx = obs.results.findIndex((r) => r.tool === "dry_run_workflow");
  const editedBeforePreview = obs.results
    .slice(0, firstPreviewIdx < 0 ? obs.results.length : firstPreviewIdx)
    .some((r) => r.tool === "edit_workflow_patch");
  const authorIdx = obs.results.findIndex((r) => r.tool === "author_workflow");
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
  const judge = extractJudgeVerdict(previews[previews.length - 1]) ?? firstVerdict;

  const base = {
    scenario: spec.slug,
    kind: spec.kind,
    tool_calls: obs.tool_calls,
    llm_passes,
    judge,
    wall_ms: obs.wall_ms,
    ...(obs.tokens !== undefined ? { tokens: obs.tokens } : {}),
    previews: previews.length,
    first_preview_content_pass,
    converged: previews_to_pass !== null,
    previews_to_pass,
    probe_before_author,
    dry_run_before_save,
    auto_repaired_first_preview,
    status: obs.status,
  };

  if (spec.kind === "clarification") {
    const clarification = evaluateClarificationTargets(spec, obs);
    notes.push(...clarification.notes);
    return {
      ...base,
      content_pass: clarification.targets.question_names_missing_inputs === "PASS",
      guard_fired: clarification.guard_fired,
      targets: clarification.targets,
      notes,
    };
  }

  if (llm_passes === null) notes.push("author_workflow result envelope not observed");
  if (previews.length === 0) notes.push("no dry_run_workflow preview observed");
  if (!firstContent.pass && firstPreview) {
    notes.push(`first preview failed content checks: ${firstContent.failed.join(", ")}`);
  }
  if (editedBeforePreview) {
    notes.push("NON-ISOLATED: edit tool fired before first preview — exclude trial");
  }
  return {
    ...base,
    content_pass: first_preview_content_pass,
    guard_fired: null,
    targets: evaluateBenchmarkTargets({
      llm_passes,
      previews: previews.length,
      tool_calls: obs.tool_calls,
      first_preview_content_pass,
    }),
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
  pass_rate: number;
  content_pass_rate: number;
  converged_rate: number;
  probe_before_author_rate: number;
  dry_run_before_save_rate: number;
  guard_fired_rate: number | null;
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
  const guardEligible = isolated.filter((s) => s.guard_fired !== null);
  return {
    scenario,
    n_trials: n,
    excluded_non_isolated: scores.length - n,
    pass_rate: rate(scenarioPassed),
    content_pass_rate: rate((s) => s.content_pass),
    converged_rate: rate((s) => s.converged),
    probe_before_author_rate:
      probeEligible.length === 0
        ? 0
        : probeEligible.filter((s) => s.probe_before_author === true).length / probeEligible.length,
    dry_run_before_save_rate: rate((s) => s.dry_run_before_save),
    guard_fired_rate:
      guardEligible.length === 0
        ? null
        : guardEligible.filter((s) => s.guard_fired === true).length / guardEligible.length,
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
  trials?: TrialAggregate[];
  cleanup?: { deleted: number; failures: string[] };
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
    ...(args.trials ? { trials: args.trials } : {}),
    ...(args.cleanup ? { cleanup: args.cleanup } : {}),
  };
}

function artifactKey(a: CreatedArtifact): string {
  return `${a.kind}:${a.id}`;
}

function stringAt(rec: Record<string, unknown> | null, key: string): string | undefined {
  const v = rec?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function artifactsFromToolResult(call: ObservedToolCall): CreatedArtifact[] {
  const out: CreatedArtifact[] = [];
  const outer = asRecord(call.output);
  const env = envelopeOf(call.output);
  if (call.tool === "save_workflow_draft") {
    const target = asRecord(env?.draft_target);
    const id =
      stringAt(outer, "committed_workflow_id") ??
      stringAt(env, "workflow_id") ??
      stringAt(target, "id");
    if (id) {
      const slug = stringAt(env, "slug") ?? stringAt(target, "slug");
      out.push({ kind: "workflow", id, ...(slug ? { slug } : {}) });
    }
  }
  if (call.tool === "create_knowledge_source") {
    const ks = asRecord(env?.knowledge_source);
    const id = stringAt(ks, "id");
    if (id) {
      const slug = stringAt(ks, "slug");
      out.push({ kind: "knowledge_source", id, ...(slug ? { slug } : {}) });
    }
  }
  if (call.tool === "save_connector_draft") {
    const connector = asRecord(env?.connector);
    const id = stringAt(connector, "id") ?? stringAt(env, "connector_id");
    if (id) {
      const slug = stringAt(connector, "slug") ?? stringAt(env, "slug");
      out.push({ kind: "connector", id, ...(slug ? { slug } : {}) });
    }
  }
  return out;
}

export function collectCreatedArtifacts(obs: ScenarioObservation): CreatedArtifact[] {
  const found = new Map<string, CreatedArtifact>();
  const add = (a: CreatedArtifact) => {
    const key = artifactKey(a);
    const prev = found.get(key);
    if (!prev) found.set(key, a);
    else if (!prev.slug && a.slug) found.set(key, { ...prev, slug: a.slug });
  };
  for (const a of obs.created_artifacts) add(a);
  if (obs.committed_workflow_id) add({ kind: "workflow", id: obs.committed_workflow_id });
  for (const call of obs.results) for (const a of artifactsFromToolResult(call)) add(a);
  return deletionOrder([...found.values()]);
}

const DELETION_RANK: Record<CreatedArtifact["kind"], number> = {
  workflow: 0,
  knowledge_source: 1,
  connector: 2,
  conversation: 3,
};

export function deletionOrder(artifacts: CreatedArtifact[]): CreatedArtifact[] {
  return artifacts
    .map((a, i) => ({ a, i }))
    .sort((x, y) => DELETION_RANK[x.a.kind] - DELETION_RANK[y.a.kind] || x.i - y.i)
    .map(({ a }) => a);
}

export const LIVE_SCENARIOS: LiveScenarioSpec[] = [
  {
    slug: "droplet-specs-email",
    kind: "authoring",
    goal:
      "Author a workflow that emails {recipient} a report of my DigitalOcean projects: " +
      "for every project list its name and the specs of every droplet in it (vCPUs, memory, disk). " +
      "Use the digitalocean and gmail connectors, preview it, and save it when the preview is correct.",
    connectors: ["digitalocean", "gmail"],
    content_checks: [
      { name: "recipient present", pattern: "{recipient}" },
      { name: "project names non-empty", pattern: '"name"\\s*:\\s*"[^"]+"' },
      { name: "cpu spec present", pattern: "vcpu|cpu", flags: "i" },
      { name: "memory spec present", pattern: "memory|ram|_gb|gb\\b", flags: "i" },
      { name: "disk spec present", pattern: "disk", flags: "i" },
    ],
  },
  {
    slug: "gh-org-top-repos-table",
    kind: "authoring",
    goal:
      "Author a workflow that returns a markdown table of the top 5 repositories of my GitHub " +
      "organization ranked by stars, with columns rank, repository and stars. " +
      "Use the github connector, preview it, and save it when the preview is correct.",
    connectors: ["github"],
    content_checks: [
      { name: "markdown table row", pattern: "\\|[^|\\n]+\\|" },
      { name: "markdown table separator", pattern: "\\|\\s*:?-{3,}" },
      { name: "stars column", pattern: "stars", flags: "i" },
    ],
  },
  {
    slug: "berlin-weather-summary",
    kind: "authoring",
    goal:
      "Author a workflow that returns tomorrow's weather for Berlin as a short summary with the " +
      "minimum and maximum temperature in degrees Celsius. Preview it and save it when the preview is correct.",
    connectors: ["open-meteo"],
    content_checks: [
      { name: "temperature digits", pattern: "-?\\d+(\\.\\d+)?" },
      { name: "min/max present", pattern: "min|max|tmin|tmax", flags: "i" },
    ],
  },
  {
    slug: "underspecified-asks-first",
    kind: "clarification",
    goal: "Author a workflow that emails the report. Preview it and save it.",
    connectors: [],
    content_checks: [
      {
        name: "asks for the recipient",
        pattern: "recipient|address|e-?mail|to whom|empf",
        flags: "i",
      },
      {
        name: "asks for the source",
        pattern: "source|data|which report|from|contain|content|inhalt|quelle|woher",
        flags: "i",
      },
    ],
  },
  {
    slug: "underspecified-placeholder-rejected",
    kind: "clarification",
    goal: "Author a workflow that emails the report. Preview it and save it.",
    answer_turns: [
      "Send it to test@example.com by a plain HTTP POST to https://hooks.example.com/report with a JSON body {to, subject, rows}. The data is the first 5 posts from https://jsonplaceholder.typicode.com/posts (id and title). Subject: Post report. No schedule, I run it on demand. That is everything, build and preview it now.",
    ],
    connectors: [],
    content_checks: [
      {
        name: "asks for the recipient",
        pattern: "recipient|address|e-?mail|to whom|empf",
        flags: "i",
      },
      {
        name: "asks for the source",
        pattern: "source|data|which report|from|contain|content|inhalt|quelle|woher",
        flags: "i",
      },
    ],
  },
  {
    slug: "weather-ranking-table",
    kind: "authoring",
    goal:
      "Author a workflow that compares the 7-day maximum-temperature forecast for two cities — " +
      "Berlin (latitude 52.52, longitude 13.41) and Hamburg (latitude 53.55, longitude 9.99). " +
      "For each city call the open-meteo connector's /v1/forecast endpoint with " +
      "daily=temperature_2m_max and forecast_days=7, find that city's warmest day (its date and the " +
      "maximum temperature in degrees Celsius), then return a markdown table that ranks the two " +
      "cities by their warmest day hottest-first, with columns rank, city, warmest_day and " +
      "max_temp_c. Preview it and save it when the preview is correct.",
    connectors: ["open-meteo"],
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
    kind: "authoring",
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
    content_source: "final_output",
    content_checks: [
      { name: "spread_c numeric", pattern: '"spread_c"\\s*:\\s*-?\\d+(\\.\\d+)?' },
      { name: "highest_max_c numeric", pattern: '"highest_max_c"\\s*:\\s*-?\\d+(\\.\\d+)?' },
      { name: "lowest_min_c numeric", pattern: '"lowest_min_c"\\s*:\\s*-?\\d+(\\.\\d+)?' },
    ],
  },
  {
    slug: "ta-jsonata-variable-block",
    kind: "authoring",
    goal:
      "Author a workflow that fetches the 7-day forecast for Berlin (latitude 52.52, longitude 13.41) " +
      "from the open-meteo connector's /v1/forecast endpoint using daily=temperature_2m_max,temperature_2m_min " +
      "and forecast_days=7. Use a single request step and no separate transform step. Shape the final output " +
      "with a JSONata output_transform expression (not output_transform_function) that produces a JSON object " +
      "with two fields: hottest_day (the date string from daily.time at the index of the maximum value in " +
      "daily.temperature_2m_max) and hottest_temp_c (the maximum value in daily.temperature_2m_max). " +
      "Preview it and save it when the preview is correct.",
    connectors: ["open-meteo"],
    content_source: "final_output",
    content_checks: [
      { name: "hottest_temp_c numeric", pattern: '"hottest_temp_c"\\s*:\\s*-?\\d+(\\.\\d+)?' },
      { name: "hottest_day iso date", pattern: '"hottest_day"\\s*:\\s*"20\\d\\d-\\d\\d-\\d\\d"' },
    ],
  },
];
