import type { AuthoringSummary, DraftDocument } from "../types.ts";

const CONTINUATION_RE =
  /^(yes|no|y|n|ok(ay)?|approve|reject|confirm|cancel|sure|please|thanks?)\b/i;

export function isContinuationTurn(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length < 8 || CONTINUATION_RE.test(trimmed);
}

export function attachmentMimeTypesOf(rows: ReadonlyArray<{ content_type: unknown }>): string[] {
  return rows
    .map((r) => r.content_type)
    .filter((m): m is string => typeof m === "string" && m.length > 0);
}

export function hasBoundSavedWorkflow(workflowId: string | null, draft: DraftDocument): boolean {
  return (
    workflowId !== null ||
    draft.summary?.active_target.kind === "workflow" ||
    draft.summary?.persisted_resources.some((resource) => resource.kind === "workflow") === true
  );
}

export function hasBoundSavedWorkflowTarget(
  workflowId: string | null,
  draft: DraftDocument,
): boolean {
  return (
    workflowId !== null ||
    (draft.summary?.active_target.kind === "workflow" &&
      draft.summary.active_target.lifecycle_state === "persisted")
  );
}

export function hasPersistedWorkflow(
  workflowId: string | null,
  exposeExecution: boolean,
  draft: DraftDocument,
): boolean {
  return (
    hasBoundSavedWorkflowTarget(workflowId, draft) ||
    exposeExecution ||
    draft.summary?.persisted_resources.some((resource) => resource.kind === "workflow") === true
  );
}

export function activeWorkflowId(workflowId: string | null, draft: DraftDocument): string | null {
  if (workflowId !== null) return workflowId;
  return draft.summary?.active_target.kind === "workflow" ? draft.summary.active_target.id : null;
}

export interface EndpointRow {
  method: string;
  path: string;
  description: string | null;
  source: string;
  confidence: number;
}

export interface DocumentAnalysisSummary {
  source: string;
  confidence: number;
  endpoint_count: number;
  sample_endpoints: Array<{ method: string; path: string; description?: string }>;
}

export function documentAnalysisSummary(
  rows: readonly EndpointRow[],
): DocumentAnalysisSummary | null {
  const head = rows[0];
  if (!head) return null;
  return {
    source: head.source,
    confidence: head.confidence,
    endpoint_count: rows.length,
    sample_endpoints: rows.map((r) => ({
      method: r.method,
      path: r.path,
      ...(r.description ? { description: r.description } : {}),
    })),
  };
}

export function authoringConnectorIds(
  activeConnectorId: string | null,
  draft: DraftDocument,
): string[] {
  const savedConnectorId = draft.connector?.saved_connector_id;
  return [
    ...new Set(
      [
        activeConnectorId,
        savedConnectorId,
        ...draft.workflow.steps.map((step) => step.connector_id),
      ].filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
}

export function authoringHint<P, L>(
  summary: AuthoringSummary | undefined,
  input: { runVerb: boolean; ask_before_writing: P; locked_tools: L },
) {
  if (!summary) return undefined;
  return {
    mode: input.runVerb && summary.mode === "workflow" ? ("execution" as const) : summary.mode,
    stage: summary.stage,
    lifecycle_state: summary.lifecycle_state,
    active_target: {
      kind: summary.active_target.kind,
      lifecycle_state: summary.active_target.lifecycle_state,
    },
    blocked_by: [...summary.blocked_by],
    next_required_action: summary.next_required_action,
    next_suggested_tool: summary.next_suggested_tool,
    ask_before_writing: input.ask_before_writing,
    locked_tools: input.locked_tools,
    checkpoints: [...summary.checkpoints],
    latest_execution: summary.latest_execution
      ? { diagnosis_available: summary.latest_execution.diagnosis_available }
      : null,
    latest_diagnosis: summary.latest_diagnosis ? { reason: summary.latest_diagnosis.reason } : null,
  };
}

export function priorFailuresFromPreview(
  warnings: ReadonlyArray<{
    step_key?: string | null;
    code?: string | null;
    message?: string | null;
  }>,
): Array<{ step_id: string; error: string }> {
  return warnings.slice(0, 10).map((w) => ({
    step_id: w.step_key ?? "preview",
    error: `dry-run warning ${w.code ?? "unknown"}: ${w.message ?? ""}`,
  }));
}

export interface RuntimeContextInput {
  engine_url?: string | undefined;
  tenant_slug?: string | undefined;
  actor_email?: string | undefined;
  actor_role?: string | undefined;
  surface?: string | undefined;
  ask_before_writing?: boolean | undefined;
}

export function promptRuntimeContext(input: RuntimeContextInput) {
  const rc = {
    ...(input.engine_url ? { engine_url: input.engine_url } : {}),
    ...(input.tenant_slug ? { tenant_slug: input.tenant_slug } : {}),
    ...(input.actor_email ? { actor_email: input.actor_email } : {}),
    ...(input.actor_role ? { actor_role: input.actor_role } : {}),
    ...(input.surface ? { surface: input.surface } : {}),
    ...(input.ask_before_writing ? { ask_before_writing: true } : {}),
  };
  return Object.keys(rc).length > 0 ? { runtime_context: rc } : {};
}

export function outputGuardContext(engineUrl: string | undefined, tenantSlug: string | undefined) {
  return {
    ...(engineUrl ? { engine_url: engineUrl } : {}),
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
  };
}

export function turnTokenEstimate(promptTotal: number, messageTokens: number, budget: number) {
  const estimatedPromptTokens = promptTotal + messageTokens;
  return { estimatedPromptTokens, estimated: estimatedPromptTokens + budget * 1024 };
}

export function turnBudgetMs(budget: number): number {
  return Math.min(10 * 60_000, 30_000 * budget);
}

const LATE_STAGES: ReadonlySet<string | undefined> = new Set([
  "connector_validated",
  "connector_persisted",
  "workflow_validated",
  "workflow_persisted",
  "repairing",
]);

export function isLateStage(stage: string | undefined): boolean {
  return LATE_STAGES.has(stage);
}

export type StreamTimeoutPhase = "total" | "first_chunk" | "step" | "chunk";

export function abortTimeout(input: {
  reportedPhase: StreamTimeoutPhase | null;
  elapsedMs: number;
  turnBudgetMs: number;
  firstChunkMs: number;
}): { phase: StreamTimeoutPhase; timeoutMs: number } {
  const phase =
    input.reportedPhase ?? (input.elapsedMs >= input.turnBudgetMs ? "total" : "first_chunk");
  return { phase, timeoutMs: phase === "first_chunk" ? input.firstChunkMs : input.turnBudgetMs };
}

export function streamErrorTimeoutBudget(input: {
  phase: StreamTimeoutPhase;
  reportedBudget: number | null;
  turnBudgetMs: number;
  firstChunkMs: number;
}): number | null {
  if (input.reportedBudget !== null) return input.reportedBudget;
  if (input.phase === "total") return input.turnBudgetMs;
  return input.phase === "first_chunk" ? input.firstChunkMs : null;
}

export function fallsBack(input: {
  fallbackModel: string | null | undefined;
  seedModel: string;
  eligible: () => boolean;
}): boolean {
  return input.fallbackModel !== input.seedModel && input.eligible();
}

export function repairAttribution(tool: string, error: unknown) {
  const errKind =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name)
      : undefined;
  return { tool, ...(errKind ? { error_kind: errKind } : {}) };
}

export function toMegabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

export function composingLabel(elapsedMs: number): string {
  return `composing reply · ${Math.round(elapsedMs / 1000)}s`;
}

export const PROSE_TAIL_WINDOW = 4096;
const PARAGRAPH_BREAK_RE = /\n\s*\n/g;

export interface ProseScan {
  tail: string;
  scanFrom: number;
  paragraphs: number;
}

export function scanProseChunk(
  scan: ProseScan,
  chunk: string,
): { scan: ProseScan; progressLabel: string | null; paragraph: string | null } {
  const tail = (scan.tail + chunk).slice(-PROSE_TAIL_WINDOW);
  const trimmed = scan.tail.length + chunk.length - tail.length;
  const scanFrom = Math.max(0, scan.scanFrom - trimmed);
  PARAGRAPH_BREAK_RE.lastIndex = scanFrom;
  const match = PARAGRAPH_BREAK_RE.exec(tail);
  if (!match)
    return {
      scan: { tail, scanFrom, paragraphs: scan.paragraphs },
      progressLabel: null,
      paragraph: null,
    };
  const paragraphs = scan.paragraphs + 1;
  const paragraph = tail.slice(0, match.index);
  return {
    scan: { tail, scanFrom: match.index + match[0].length, paragraphs },
    progressLabel: paragraphs >= 2 ? `composing reply · ${paragraphs} paragraphs so far` : null,
    paragraph: paragraph || null,
  };
}

export function cacheReadUsage(inputTokens: number, cacheReadTokens: number) {
  const total = inputTokens + cacheReadTokens;
  if (total <= 0) return {};
  return {
    cache_read_tokens: cacheReadTokens,
    cache_read_pct: Math.round((cacheReadTokens / total) * 1000) / 10,
  };
}

export interface PromptTokenCounts {
  system: number;
  skills: number;
  knowledge: number;
  docs: number;
  failures: number;
  messages: number;
  recipe_bodies: number;
  conventions: number;
  prior_workflows: number;
  references: number;
  total: number;
}

export function tokenBreakdown(
  counts: PromptTokenCounts | undefined,
): PromptTokenCounts | undefined {
  if (!counts) return undefined;
  return {
    system: counts.system,
    skills: counts.skills,
    knowledge: counts.knowledge,
    docs: counts.docs,
    failures: counts.failures,
    messages: counts.messages,
    recipe_bodies: counts.recipe_bodies,
    conventions: counts.conventions,
    prior_workflows: counts.prior_workflows,
    references: counts.references,
    total: counts.total,
  };
}

export function breakdownLogFields(breakdown: PromptTokenCounts | undefined) {
  if (!breakdown) return {};
  return {
    breakdown_system: breakdown.system,
    breakdown_skills: breakdown.skills,
    breakdown_knowledge: breakdown.knowledge,
    breakdown_docs: breakdown.docs,
    breakdown_failures: breakdown.failures,
    breakdown_messages: breakdown.messages,
    breakdown_recipe_bodies: breakdown.recipe_bodies,
    breakdown_conventions: breakdown.conventions,
    breakdown_references: breakdown.references,
    breakdown_total: breakdown.total,
  };
}

export interface WeighableSkill {
  id: string;
  slug?: string | null;
  title?: string | null;
}

export function topSkillsByTokens<S extends WeighableSkill>(
  skills: readonly S[],
  skillTokens: number | undefined,
  weigh: (skill: S) => number,
): Array<{ slug: string; tokens: number } | { id: string; tokens: number }> | null {
  if (skills.length === 0) return null;
  const share = skillTokens !== undefined ? Math.round(skillTokens / skills.length) : 0;
  const weighed = skills.map((s) => ({ id: s.id, slug: s.slug ?? null, tokens: share }));
  try {
    for (const w of weighed) {
      w.tokens = weigh(skills.find((s) => s.id === w.id) as S);
    }
  } catch {}
  return weighed
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5)
    .map((w) => ({ ...(w.slug ? { slug: w.slug } : { id: w.id }), tokens: w.tokens }));
}

export function validatedStepCount(
  checkpoints: Readonly<Record<string, { ok?: boolean | null } | undefined>> | undefined,
): number {
  let n = 0;
  for (const [key, cp] of Object.entries(checkpoints ?? {})) {
    if (key.endsWith("_validated") && cp?.ok === true) n += 1;
  }
  return n;
}

export function workflowTriggerKind(draft: DraftDocument): string | null {
  const first = draft.workflow?.steps?.[0] as { kind?: unknown } | undefined;
  return typeof first?.kind === "string" ? first.kind : null;
}

export type ReviewArtifact =
  | {
      kind: "save_workflow_draft";
      payload: {
        resource_kind: "connector" | "workflow";
        resource_id: string;
        connector_auth_mode: string | null;
        workflow_trigger_kind: string | null;
        validated_step_count: number;
        committed_text: string;
        referenced_credentials: string[];
      };
    }
  | { kind: "chat"; payload: string };

export function reviewArtifact(input: {
  draft: DraftDocument;
  committedWorkflowId: string | null;
  assistantText: string;
}): ReviewArtifact | null {
  if (input.committedWorkflowId === null) return { kind: "chat", payload: input.assistantText };
  const activeKind = input.draft.summary?.active_target.kind;
  if (activeKind !== "connector" && activeKind !== "workflow") return null;
  return {
    kind: "save_workflow_draft",
    payload: {
      resource_kind: activeKind,
      resource_id: input.committedWorkflowId,
      connector_auth_mode:
        activeKind === "connector" ? (input.draft.connector?.auth_type ?? null) : null,
      workflow_trigger_kind: activeKind === "workflow" ? workflowTriggerKind(input.draft) : null,
      validated_step_count: validatedStepCount(input.draft.state?.checkpoints),
      committed_text: input.assistantText,
      referenced_credentials: [],
    },
  };
}

export function failedChecks(checks: Readonly<Record<string, unknown>> | undefined): string[] {
  return Object.entries(checks ?? {})
    .filter(([, v]) => v === false)
    .map(([k]) => k);
}

export function commitAbstains(
  verdict: { verdict: string; confidence: number },
  committed: boolean,
): boolean {
  return verdict.verdict === "fail" && verdict.confidence < 0.6 && committed;
}

export interface AbstentionRequest {
  source: "source_faithful.abstention" | "critic.abstention";
  summary: string;
  question: string;
  confidence: number;
  checks: string[];
}

export function abstentionRequest(input: {
  faithfulness: {
    reason: string;
    detail?: string | null;
    confidence: number;
    checks?: Record<string, unknown>;
  } | null;
  critic: { reason: string; hint?: string | null; confidence: number };
  criticFailedChecks: string[];
}): AbstentionRequest {
  const f = input.faithfulness;
  if (f) {
    return {
      source: "source_faithful.abstention",
      summary: `source drift: ${f.reason}`,
      question:
        "The answer may not be faithful to the sources it cited. " +
        `Reason: ${f.reason}. ` +
        `${f.detail ? `Detail: ${f.detail}. ` : ""}` +
        "Confirm the answer is correct, or describe what should change.",
      confidence: f.confidence,
      checks: failedChecks(f.checks),
    };
  }
  const c = input.critic;
  return {
    source: "critic.abstention",
    summary: `low-confidence commit: ${c.reason}`,
    question:
      "The critic flagged this commit with low confidence. " +
      `Reason: ${c.reason}. ` +
      `${c.hint ? `Suggested fix: ${c.hint}. ` : ""}` +
      "Confirm the commit, or describe what should change.",
    confidence: c.confidence,
    checks: input.criticFailedChecks,
  };
}

export function elicitationActorType<K extends string>(
  principalKind: K | undefined,
  actorId: string | null,
): K | "system" | "unknown" {
  return principalKind ?? (actorId === null ? "system" : "unknown");
}

export function savedInertDraft(draft: DraftDocument, workflowId: string): boolean {
  return (
    draft.state?.persisted_resources.some(
      (resource) =>
        resource.kind === "workflow" &&
        resource.id === workflowId &&
        resource.persistence_kind === "draft",
    ) === true
  );
}

export interface TurnOutcome {
  status: "abandoned" | "committed" | "awaiting_input" | "active";
  committed_workflow_id?: string;
  pending_elicitation_id?: string | undefined;
  parkable: boolean;
}

export function turnOutcome(input: {
  cancelled: boolean;
  persistedStatus: string | null;
  cancelledByConversation: boolean;
  committedWorkflowId: string | null;
  savedInertDraft: boolean;
  pendingElicitationId: string | undefined;
  hasPendingElicitation: boolean;
}): TurnOutcome {
  if (input.cancelled || input.persistedStatus === "abandoned" || input.cancelledByConversation) {
    return { status: "abandoned", parkable: false };
  }
  if (input.committedWorkflowId !== null) {
    return {
      status: input.savedInertDraft ? "active" : "committed",
      committed_workflow_id: input.committedWorkflowId,
      parkable: false,
    };
  }
  if (input.hasPendingElicitation || input.persistedStatus === "awaiting_input") {
    return {
      status: "awaiting_input",
      pending_elicitation_id: input.pendingElicitationId,
      parkable: false,
    };
  }
  return { status: "active", parkable: true };
}

export function budgetExhausted(input: {
  status: string;
  step: number;
  budget: number;
  hasPendingElicitation: boolean;
}): boolean {
  return input.status === "active" && input.step >= input.budget && !input.hasPendingElicitation;
}

export function budgetExhaustedQuestion(budget: number) {
  return {
    question:
      `I stopped because I reached this turn's step limit (${budget} steps) before finishing — ` +
      "the work kept failing when I tested it, and re-running the same approach won't help. " +
      'Tell me how you\'d like to proceed: describe the outcome you want, or reply "diagnose" ' +
      "to look at the last failure in detail.",
    placeholder: "describe the outcome | diagnose | change approach",
    metadata: { source: "loop.budget_exhausted", step_budget: budget },
  };
}
