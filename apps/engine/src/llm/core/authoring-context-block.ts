// Authoring context block — rendered into the volatile cache segment of
// the system prompt. Gives the model a structured, up-to-date view of the
// current conversation's draft state so it can decide next actions without
// replaying every prior tool result. Secrets are masked by an allowlist of
// renderable fields — credential payloads, tokens, DSNs, and arbitrary
// config blobs never reach the rendered text.

import { normalizeDraftDocument } from "../../conversations/authoring-state.ts";
import {
  nextQuestion as computeNextQuestion,
  type ExpertiseHint,
  nextRecommendedAction,
} from "../../conversations/onboarding-policy.ts";
import { planTurnRouting } from "../../conversations/turn-routing.ts";
import type {
  AuthoringCheckpointKey,
  AuthoringSummary,
  ConversationResumeSummary,
  DraftDocument,
  WorkflowDraftStepPreview,
} from "../../conversations/types.ts";
import { extractStepIdReferences } from "../../workflows/levenshtein.ts";
import { validateWorkflowDef } from "../../workflows/validator.ts";

export interface AuthoringContextInput {
  draft: DraftDocument | null | undefined;
  user_message?: string | null;
  resume_summary?: ConversationResumeSummary | null;
  pending_approval?: {
    tool_name: string;
    summary: string | null;
  } | null;
  /**
   * Summary of the latest document analysis pass for the connector
   * being authored. Sourced from `connector_endpoint_schemas` rows.
   * When null/empty, the section is omitted.
   */
  document_analysis?: {
    source: string;
    confidence: number;
    endpoint_count: number;
    sample_endpoints?: Array<{ method: string; path: string }>;
  } | null;
  /**
   * Caller's read on the user's expertise. The renderer uses it to pick
   * one of three concise "tone" hints — `novice` asks for more scaffolding,
   * `expert` suppresses hand-holding so the assistant stays out of the way.
   * Missing hint → no tone line is emitted (same behaviour as before).
   */
  expertise?: ExpertiseHint;
}

const EXPERTISE_TONE_HINT: Record<ExpertiseHint, string> = {
  novice:
    "User is new — prefer step-by-step explanations, spell out trade-offs, and offer a concrete next action after every tool call.",
  intermediate:
    "User is comfortable with the engine — keep answers tight, skip restatements, and only explain non-obvious trade-offs.",
  expert:
    "User is an expert — skip introductions, avoid restating the obvious, and default to dense diffs / commands over prose.",
};

export function renderAuthoringContextBlock(input: AuthoringContextInput): string | null {
  const normalizedDraft = input.draft ? normalizeDraftDocument(input.draft) : null;
  if (!normalizedDraft && !input.resume_summary && !input.user_message) return null;

  const lines: string[] = [];
  if (input.expertise) {
    lines.push(`## Tone hint (${input.expertise})`);
    lines.push(`- ${EXPERTISE_TONE_HINT[input.expertise]}`);
    lines.push("");
  }
  const routing = input.user_message
    ? planTurnRouting({
        draft: normalizedDraft ?? null,
        user_message: input.user_message,
      })
    : null;

  if (routing) {
    lines.push("## Turn routing");
    lines.push(`- Intent: ${routing.intent} (${routing.confidence} confidence)`);
    lines.push(`- Action: ${routing.action}`);
    if (routing.question) {
      lines.push(`- Suggested question: ${routing.question}`);
    }
    if (routing.required_grounding.length > 0) {
      lines.push(`- Ground on: ${routing.required_grounding.join(", ")}`);
    }
    for (const note of routing.notes) {
      lines.push(`- Note: ${note}`);
    }
    lines.push(`- Forbidden fallbacks: ${routing.forbidden_fallbacks.join(", ")}`);
  }

  if (normalizedDraft) {
    if (lines.length > 0) lines.push("");
    lines.push("## Current authoring state");
    const mode = normalizedDraft.mode ?? "onboarding";
    lines.push(...renderModeEnvelope(mode, normalizedDraft));
  }

  if (input.document_analysis && input.document_analysis.endpoint_count > 0) {
    if (lines.length > 0) lines.push("");
    const da = input.document_analysis;
    lines.push("## Document Analysis");
    lines.push(
      `- Completed: source=${da.source}, confidence=${da.confidence}%, endpoints=${da.endpoint_count}`,
    );
    if (da.sample_endpoints && da.sample_endpoints.length > 0) {
      const preview = da.sample_endpoints.slice(0, 6).map((e) => `${e.method} ${e.path}`);
      lines.push(`- Endpoints: ${preview.join(", ")}`);
      if (da.sample_endpoints.length > 6) {
        lines.push(`  - …and ${da.sample_endpoints.length - 6} more`);
      }
    }
  }

  if (input.pending_approval) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `- Pending approval: ${input.pending_approval.tool_name}${
        input.pending_approval.summary ? ` — ${input.pending_approval.summary}` : ""
      }`,
    );
  }

  if (input.resume_summary) {
    lines.push("");
    lines.push("## Resume");
    lines.push(`- ${input.resume_summary.one_sentence}`);
    if (input.resume_summary.last_successful_probe) {
      lines.push(`- Last successful probe: ${input.resume_summary.last_successful_probe}`);
    }
    if (input.resume_summary.last_successful_preview) {
      lines.push(`- Last successful preview: ${input.resume_summary.last_successful_preview}`);
    }
    lines.push(`- Next best step: ${input.resume_summary.next_action}`);
  }

  const shouldRenderAuthoringNextStep =
    !routing || routing.intent === "author_connector" || routing.intent === "author_workflow";
  if (shouldRenderAuthoringNextStep) {
    const action = nextRecommendedAction({
      draft: normalizedDraft ?? null,
      ...(input.pending_approval ? { pending_approval: input.pending_approval } : {}),
    });
    lines.push("");
    lines.push("## Guided next step");
    lines.push(`- Action: ${action.summary}`);
    lines.push(`- Why: ${action.rationale}`);
    const question = computeNextQuestion({
      draft: normalizedDraft ?? null,
      ...(input.pending_approval ? { pending_approval: input.pending_approval } : {}),
    });
    if (question) {
      lines.push(`- Suggested question (${question.kind}): ${question.prompt}`);
      if (question.options && question.options.length > 0) {
        for (const opt of question.options) {
          lines.push(`  - ${opt.label}${opt.detail ? ` — ${opt.detail}` : ""}`);
        }
      }
    }
  }

  return lines.join("\n");
}

function renderModeEnvelope(
  mode: NonNullable<DraftDocument["mode"]> | "onboarding",
  draft: DraftDocument,
): string[] {
  const lines: string[] = [`- Mode: ${mode}`];
  if (draft.summary) {
    lines.push(...renderSummaryEnvelope(draft.summary));
  }

  if (mode === "connector_authoring") {
    lines.push(...renderConnectorLines(draft));
    return lines;
  }
  if (mode === "workflow_authoring") {
    lines.push(...renderWorkflowLines(draft));
    return lines;
  }
  if (mode === "resume_review") {
    lines.push(...renderConnectorLines(draft));
    lines.push(...renderWorkflowLines(draft));
    return lines;
  }
  lines.push(...renderConnectorLines(draft));
  lines.push(...renderWorkflowLines(draft));
  return lines;
}

function renderSummaryEnvelope(summary: AuthoringSummary): string[] {
  const lines = [
    `- Surface mode: ${summary.mode}`,
    `- Stage: ${summary.stage}`,
    `- Lifecycle: ${summary.lifecycle_state}`,
    `- Readiness: ${summary.readiness}`,
  ];
  const activeTarget = renderActiveTarget(summary);
  if (activeTarget) lines.push(activeTarget);
  if (summary.next_action) {
    lines.push(`- Next recommended action: ${summary.next_action}`);
  }
  if (summary.next_required_action && summary.next_required_action !== summary.next_action) {
    lines.push(`- Next required action: ${summary.next_required_action}`);
  }
  if (summary.next_suggested_tool) {
    lines.push(`- Next suggested tool: ${summary.next_suggested_tool}`);
  }
  if (summary.missing_fields.length > 0) {
    lines.push(`- Missing: ${summary.missing_fields.join(", ")}`);
  }
  if (summary.blocked_by.length > 0) {
    lines.push(`- Blocked by: ${summary.blocked_by.join(", ")}`);
  }
  const checkpointLine = renderCheckpointLine(summary);
  if (checkpointLine) lines.push(checkpointLine);
  const persistedLine = renderPersistedResources(summary);
  if (persistedLine) lines.push(persistedLine);
  lines.push(...renderExecutionSummary(summary));
  return lines;
}

function renderActiveTarget(summary: AuthoringSummary): string | null {
  if (summary.active_target.kind === "none") return null;
  const parts = [`kind=${summary.active_target.kind}`];
  if (summary.active_target.name) parts.push(`name="${summary.active_target.name}"`);
  if (summary.active_target.slug) parts.push(`slug=${summary.active_target.slug}`);
  if (summary.active_target.id) parts.push(`id=${summary.active_target.id}`);
  if (summary.active_target.environment) parts.push(`env=${summary.active_target.environment}`);
  parts.push(`state=${summary.active_target.lifecycle_state}`);
  return `- Active target: ${parts.join(" ")}`;
}

function checkpointKeysFor(summary: AuthoringSummary): AuthoringCheckpointKey[] {
  if (summary.mode === "connector") {
    return [
      "connector_inspected",
      "connector_validated",
      "connector_authenticated",
      "connector_probed",
      "connector_persisted",
    ];
  }
  return [
    "connector_persisted",
    "workflow_inspected",
    "workflow_validated",
    "workflow_previewed",
    "workflow_persisted",
    "workflow_executed",
    "workflow_diagnosed",
  ];
}

function renderCheckpointLine(summary: AuthoringSummary): string | null {
  const parts = checkpointKeysFor(summary).map((key) => {
    const checkpoint = summary.checkpoints.find((item) => item.key === key);
    return `${key}=${checkpoint?.status ?? "missing"}`;
  });
  return parts.length > 0 ? `- Checkpoints: ${parts.join(", ")}` : null;
}

function renderPersistedResources(summary: AuthoringSummary): string | null {
  if (summary.persisted_resources.length === 0) return null;
  const parts = summary.persisted_resources.map((resource) => {
    const tokens = [`${resource.kind}:${resource.id}`];
    if (resource.version !== null) tokens.push(`v${resource.version}`);
    if (resource.environment) tokens.push(resource.environment);
    return tokens.join("@");
  });
  return `- Persisted resources: ${parts.join(", ")}`;
}

function renderExecutionSummary(summary: AuthoringSummary): string[] {
  const lines: string[] = [];
  if (summary.latest_execution) {
    const execution = summary.latest_execution;
    lines.push(
      `- Latest execution: status=${execution.status} env=${execution.environment} warnings=${execution.warnings_count} diagnosis_available=${execution.diagnosis_available}`,
    );
  }
  if (summary.latest_diagnosis) {
    lines.push(`- Latest diagnosis: ${summary.latest_diagnosis.reason}`);
  }
  return lines;
}

function renderConnectorLines(draft: DraftDocument): string[] {
  const connector = draft.connector;
  if (!connector) return ["- Connector draft: (none)"];
  const bits: string[] = [];
  if (connector.name) bits.push(`name="${connector.name}"`);
  if (connector.slug) bits.push(`slug=${connector.slug}`);
  if (connector.driver) bits.push(`driver=${connector.driver}`);
  if (connector.environment) bits.push(`env=${connector.environment}`);
  if (connector.auth_type) bits.push(`auth=${connector.auth_type}`);
  if (connector.base_url) bits.push(`base_url=${connector.base_url}`);
  if (typeof connector.saved_connector_id === "string") {
    bits.push(`saved_id=${connector.saved_connector_id}`);
  }
  const lines = [`- Connector draft: ${bits.length > 0 ? bits.join(" ") : "(empty)"}`];
  if (
    connector.validation &&
    !connector.validation.ok &&
    connector.validation.missing_fields.length > 0
  ) {
    lines.push(`  - Missing connector fields: ${connector.validation.missing_fields.join(", ")}`);
  }
  if (connector.latest_probe) {
    const probe = connector.latest_probe;
    lines.push(
      `  - Latest probe: ${probe.ok ? "ok" : "failed"}${
        probe.status_code !== undefined ? ` (HTTP ${probe.status_code})` : ""
      } — ${probe.summary}`,
    );
  }
  return lines;
}

/**
 * Two URL shapes are valid in a request step. The LLM picks one without
 * guessing because both are listed up-front:
 *   • absolute http(s)://...
 *   • ${connector.<slug>.base_url}/<path> (resolved at execution time;
 *     also accepted by the workflow validator)
 * Or use `connector_id` + `path` — the driver merges base_url + path.
 */
const REQUEST_STEP_URL_HINT_LINES = [
  "- Request step URL shapes (pick one, do not invent others):",
  "  - `connector_id` + `path` (relative path, base_url merged from the connector)",
  "  - `url: https://...` (absolute)",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder syntax must reach the model — it is what the substitution parser consumes at execution time.
  "  - `url: ${connector.<slug>.base_url}/<path>` (resolved at execute time)",
];

function renderWorkflowLines(draft: DraftDocument): string[] {
  const workflow = draft.workflow;
  const workflowSteps = workflow.steps.length;
  if (workflowSteps === 0) {
    return ['- Workflow draft: "(empty)" with 0 steps', ...REQUEST_STEP_URL_HINT_LINES];
  }
  const lines = [
    `- Workflow draft: "${workflow.name}"${workflow.slug ? ` (${workflow.slug})` : ""} with ${workflowSteps} step${
      workflowSteps === 1 ? "" : "s"
    }`,
  ];
  for (const raw of workflow.steps.slice(0, 6)) {
    if (!raw || typeof raw !== "object") continue;
    const step = raw as Record<string, unknown>;
    const id = typeof step.id === "string" ? step.id : "(no id)";
    const kind = typeof step.kind === "string" ? step.kind : "(no kind)";
    lines.push(`  - ${id}: ${kind}`);
  }
  if (workflowSteps > 6) {
    lines.push(`  - …and ${workflowSteps - 6} more`);
  }
  if (draft.latest_preview) {
    const preview = draft.latest_preview;
    lines.push(
      `- Latest preview: ${preview.ok ? "ok" : "failed"}${preview.step_id ? ` (step=${preview.step_id})` : ""} — ${preview.summary}`,
    );
  }
  // Inline validation state: re-run the in-memory validator on every
  // authoring turn so the LLM never has to call `validate_draft` to see
  // current errors. The validator is pure-CPU (Zod parse + ref checks);
  // running it per turn beats the round-trip cost of a dedicated
  // tool call.
  const validationLines = renderValidationStateLines(workflow);
  if (validationLines.length > 0) {
    lines.push(...validationLines);
  }
  lines.push(...REQUEST_STEP_URL_HINT_LINES);
  // P4: append a typed scope manifest so the LLM can cite real JSONata
  // paths instead of guessing them. Without this the assistant cycles
  // through `.data.resources`-style invented paths until the dry-run
  // surfaces unresolved_identifier warnings — the session-79bf2cca
  // failure mode.
  const stepTraces = draft.latest_preview?.step_traces ?? [];
  const manifest = renderScopeManifestLines(workflow.steps, stepTraces);
  if (manifest.length > 0) {
    lines.push("");
    lines.push(
      "### Scope manifest (paths the LLM may cite in JSONata — each step's recorded output is addressable as `$scope.<id>.data…`)",
    );
    lines.push(...manifest);
  }
  return lines;
}

/** Walk the draft's step DAG and produce a path-by-path manifest of what
 *  is reachable from a JSONata expression at any point in the workflow.
 *  Output is per-step:
 *    - `<step_id>` and `<step_id>.data` for plain steps
 *    - `<loop_id>.data` (array of iterations) plus the per-iteration
 *      body shape and the post-loop flat access form.
 *  When a `latest_preview.step_traces` entry exists for the loop's
 *  source step, the per-iteration item shape (top-level keys) is
 *  surfaced too — so `$item.<field>` is grounded in real data, not
 *  guessed. Skips steps with no `id` or unknown kinds. Truncates to a
 *  small number of steps to keep the prompt-token cost bounded; the
 *  active authoring focus is on the few most recent steps. */
function renderScopeManifestLines(
  rawSteps: unknown[],
  stepTraces: WorkflowDraftStepPreview[],
): string[] {
  const lines: string[] = [];
  const stepsById = new Map<string, Record<string, unknown>>();
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== "object") continue;
    const step = raw as Record<string, unknown>;
    const id = typeof step.id === "string" ? step.id : null;
    if (id) stepsById.set(id, step);
  }
  const tracesById = new Map<string, WorkflowDraftStepPreview>();
  for (const t of stepTraces) {
    if (t && typeof t.step_id === "string") tracesById.set(t.step_id, t);
  }
  for (const raw of rawSteps.slice(0, 12)) {
    if (!raw || typeof raw !== "object") continue;
    const step = raw as Record<string, unknown>;
    const id = typeof step.id === "string" ? step.id : null;
    const kind = typeof step.kind === "string" ? step.kind : null;
    if (!id || !kind) continue;
    if (kind === "loop") {
      const itemVar = typeof step.item_var === "string" ? step.item_var : "item";
      const body = Array.isArray(step.body) ? (step.body as unknown[]) : [];
      const bodyIds = body.filter((b): b is string => typeof b === "string");
      const firstBodyId = bodyIds[0] ?? null;
      lines.push(
        `  - $scope.${id}.data: array — one entry per iteration; each entry is { ${bodyIds.join(", ") || "<no body steps>"} } where each body key is a ScopeEnvelope { data, error, duration_ms }`,
      );
      lines.push(`    - inside the loop body, $${itemVar} is the current item (no envelope)`);
      const itemShape = describeLoopItemShape(step, tracesById);
      if (itemShape.keys.length > 0) {
        const shown = itemShape.keys.slice(0, 12);
        const more = itemShape.keys.length > 12 ? `, … +${itemShape.keys.length - 12} more` : "";
        lines.push(
          `    - $${itemVar}.{ ${shown.join(", ")}${more} } (sampled from preview of \`${itemShape.source}\`)`,
        );
      } else if (itemShape.primitive) {
        lines.push(
          `    - $${itemVar} is ${itemShape.primitive} (sampled from preview of \`${itemShape.source}\`)`,
        );
      } else if (itemShape.source && !itemShape.previewed) {
        lines.push(
          `    - $${itemVar} shape unknown — run \`dry_run_workflow\` to record a sample of \`${itemShape.source}\``,
        );
      }
      if (firstBodyId) {
        // The "flat access" form: jsonata implicitly maps over arrays,
        // so $scope.<loop>.data.<body>.data flattens iterations into a
        // single array. This is what users typically want — telling
        // them up-front saves a guess.
        lines.push(
          `    - flat access across all iterations: $scope.${id}.data.${firstBodyId}.data`,
        );
        lines.push(`    - one iteration: $scope.${id}.data[0].${firstBodyId}.data`);
      }
    } else {
      lines.push(
        `  - $scope.${id}.data: ${describeStepDataType(kind, step)} (envelope at $scope.${id})`,
      );
      // Closed authoring loop: when a dry-run recorded this step's real
      // output, surface the concrete reachable JSONata paths so the LLM
      // cites them verbatim instead of guessing `.data.<field>` from
      // documentation. This is the same data `suggest_jsonata_paths`
      // returns, delivered inline on every turn after a preview — the
      // fix for the path-guessing spiral. Concrete array indices and
      // the `[*]` marker are dropped: the LLM should project with
      // JSONata fanout (`edges.node`), not a literal index.
      const trace = tracesById.get(id);
      const rawPaths = trace?.scope_at_step?.available_paths ?? [];
      const concretePaths = rawPaths.filter((rel) => !/\[\d+\]|\[\*\]/.test(rel));
      if (concretePaths.length > 0) {
        const shown = concretePaths
          .slice(0, 14)
          .map((rel) => (rel ? `$scope.${id}.data.${rel}` : `$scope.${id}.data`));
        const more =
          concretePaths.length > shown.length
            ? `, … +${concretePaths.length - shown.length} more`
            : "";
        lines.push(
          `    - real paths from last preview — copy verbatim: ${shown.join(", ")}${more}`,
        );
      }
    }
  }
  return lines;
}

interface LoopItemShape {
  /** The source step id the loop iterates over, if extractable. */
  source: string | null;
  /** Top-level keys of the first iteration item (truncated). */
  keys: string[];
  /** Non-null when the item is a primitive (e.g. "string", "number"). */
  primitive: string | null;
  /** True when a step_traces entry exists for the source step. */
  previewed: boolean;
}

/** Find the source step's recorded `output_preview`, navigate into the
 *  array the loop iterates, and return the top-level keys of element 0.
 *  Returns empty `keys` and `primitive: null` when the source can't be
 *  identified or no preview is recorded yet. */
function describeLoopItemShape(
  loop: Record<string, unknown>,
  tracesById: Map<string, WorkflowDraftStepPreview>,
): LoopItemShape {
  const over = typeof loop.over === "string" ? loop.over : null;
  const dataSelector = typeof loop.data_selector === "string" ? loop.data_selector : null;
  const sourceExpr = over ?? dataSelector ?? "";
  const refs = extractStepIdReferences(sourceExpr);
  let sourceStep = refs[0] ?? null;
  if (!sourceStep && dataSelector) {
    // data_selector uses bare `sourceData.<step>.…` form rather than
    // $scope-prefixed paths, so the regex above won't catch it. Pull
    // the first identifier after `sourceData.` instead.
    const m = /sourceData\.([a-zA-Z_][\w-]*)/.exec(dataSelector);
    sourceStep = m?.[1] ?? null;
  }
  if (!sourceStep) {
    return { source: null, keys: [], primitive: null, previewed: false };
  }
  const trace = tracesById.get(sourceStep);
  if (!trace || trace.output_preview === undefined || trace.output_preview === null) {
    return { source: sourceStep, keys: [], primitive: null, previewed: false };
  }
  const sample = resolveLoopItemSample(trace.output_preview, sourceExpr, sourceStep);
  if (sample === undefined) {
    return { source: sourceStep, keys: [], primitive: null, previewed: true };
  }
  if (sample === null) {
    return { source: sourceStep, keys: [], primitive: "null", previewed: true };
  }
  if (Array.isArray(sample)) {
    const first = sample[0];
    return shapeOfItem(first, sourceStep, true);
  }
  if (typeof sample === "object") {
    return shapeOfItem(sample, sourceStep, true);
  }
  return { source: sourceStep, keys: [], primitive: typeof sample, previewed: true };
}

function shapeOfItem(item: unknown, source: string, previewed: boolean): LoopItemShape {
  if (item === null) return { source, keys: [], primitive: "null", previewed };
  if (Array.isArray(item)) return { source, keys: [], primitive: "array", previewed };
  if (typeof item !== "object") {
    return { source, keys: [], primitive: typeof item, previewed };
  }
  return {
    source,
    keys: Object.keys(item as Record<string, unknown>),
    primitive: null,
    previewed,
  };
}

/** Best-effort walk into an `output_preview` to find the array (or
 *  array-ish object) the loop iterates over. Honors path segments after
 *  the source step id in either `$scope.<step>.data.x.y` or
 *  `sourceData.<step>.x.y` form. Returns the located value, or the
 *  whole output_preview when no further path is given. */
function resolveLoopItemSample(output: unknown, sourceExpr: string, sourceStep: string): unknown {
  // Strip the $scope.<step> / sourceData.<step> prefix and walk the
  // remaining dot-path. JSONata `data` segments fold into the preview's
  // root (the preview IS the step's `data`), so a path of
  // `$scope.list_projects.data.projects` becomes `.projects` against
  // the preview body.
  const escaped = sourceStep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripRe = new RegExp(
    `(?:\\$scope|\\$steps|sourceData|\\$\\{\\s*scope)\\.${escaped}(?:\\.data)?`,
  );
  const m = stripRe.exec(sourceExpr);
  if (!m) return output;
  const rest = sourceExpr.slice(m.index + m[0].length);
  // Take only the dotted-identifier suffix; stop at the first non-path
  // char (operator, paren, bracket) so JSONata expressions like
  // `$scope.list.data.items[*]` collapse to `.items`.
  const pathMatch = /^((?:\.[a-zA-Z_][\w-]*)+)/.exec(rest);
  const captured = pathMatch?.[1];
  if (!captured) return output;
  const segments = captured.slice(1).split(".");
  let cur: unknown = output;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) return undefined; // ambiguous mid-path
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Re-run the workflow validator in-process and emit a compact
 *  "Current validation state" section. Eliminates the per-turn round
 *  trip the LLM used to spend on `validate_draft`. Errors are capped
 *  at 8 entries to bound the prompt budget — the validator returns the
 *  full list to the LLM via `validate_draft` if it ever needs it. */
function renderValidationStateLines(workflow: unknown): string[] {
  const result = validateWorkflowDef(workflow, { allowForwardRefs: true });
  if (result.ok && result.errors.length === 0) {
    return ["- Validation: ok (0 errors)"];
  }
  const errors = result.errors.slice(0, 8);
  const remaining = result.errors.length - errors.length;
  const lines: string[] = [
    `- Validation: ${result.errors.length} error${result.errors.length === 1 ? "" : "s"}`,
  ];
  for (const e of errors) {
    const path = e.path && e.path.length > 0 ? e.path : "(root)";
    lines.push(`  - ${path}: ${e.message}`);
  }
  if (remaining > 0) {
    lines.push(`  - …and ${remaining} more — call \`validate_draft\` once for the full list`);
  }
  return lines;
}

/** Best-effort label for `<step_id>.data`'s runtime type, derived from
 *  the step kind and its declared shape. The labels match the wording
 *  the data-handling skill uses so the LLM can correlate. */
function describeStepDataType(kind: string, step: Record<string, unknown>): string {
  switch (kind) {
    case "request":
    case "graphql":
      return "response body (object or array depending on the endpoint)";
    case "transform": {
      const expr = typeof step.expression === "string" ? step.expression.trim() : "";
      if (expr.startsWith("[") || expr.startsWith("$map")) return "array (transform)";
      if (expr.startsWith("{")) return "object (transform)";
      return "transform output";
    }
    case "branch":
      return "{ arm: 'then' | 'else' } (branch decision)";
    case "parallel":
      return "object keyed by branch index, each holding the branch's last step envelope";
    default:
      return `${kind} output`;
  }
}
