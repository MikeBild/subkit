// Prior workflows — 5th authoring context source.
//
// Returns up to `k` active workflows most similar to the current
// authoring intent, projected to a compressed reference-case shape the
// LLM context assembler embeds verbatim. Stage-1 ranking is in-process
// over the most recent active workflows; stage-2 will swap the keyword
// path for a pgvector lookup once workflow definitions carry
// embeddings.
//
// Kept out of `service.ts` so the workflow CRUD module stays under the
// 1000-LOC ceiling enforced by `audit-invariants.ts` — the
// `.size-allowlist.txt` comment explicitly forbids new entries.

import type { Executor } from "../db/client.ts";
import { type ListWorkflowsOptions, listWorkflows, type WorkflowView } from "./service.ts";
import type { WorkflowDef } from "./types.ts";

/** Compressed reference-case shape for an active workflow. Travels in
 *  the authoring prompt as "look how the team already solved this" —
 *  never as a template to clone. */
export interface PriorWorkflowRef {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  /** Single-line summary derived from `definition.trigger`. */
  trigger_summary: string;
  /** Ordered step kinds + the connector / action they touch. Never
   *  carries step params / JSONata bodies — keeps the token budget
   *  bounded. */
  step_topology: Array<{ kind: string; connector_id?: string; action?: string }>;
  /** Up to 10 top-level keys derived from the workflow's
   *  `output_schema` (reading `.properties` when JSON-schema-shaped).
   *  Empty when no schema was declared. */
  output_keys: string[];
}

export interface FindSimilarActiveIntent {
  /** Free-text intent built from the current user turn + the
   *  structured authoring hint. Tokenised in-process for keyword
   *  ranking. */
  query: string;
  /** Connectors the current authoring run is scoped to. Workflows
   *  touching one of these get the strongest score boost. */
  connector_ids: string[];
  /** Optional desired step count for the affinity tiebreak. Omit to
   *  use the candidate's own step count (affinity = 1). */
  target_step_count?: number;
  /** Workflow id currently being edited — excluded so a workflow
   *  never appears as its own reference. */
  exclude_workflow_id?: string;
}

// Pool size keeps the per-turn cost bounded for stage 1 (in-process
// ranking over `listWorkflows`, which is N+1). Newest-first ordering
// means the recent authoring history dominates. Stage 2 will swap the
// keyword path for a pgvector lookup.
const PRIOR_WORKFLOWS_CANDIDATE_POOL = 50;

// Score weights for `scorePriorWorkflow`. The precedence is locked by
// these constants AND pinned by the ranker unit tests (connector
// overlap beats name/description, which beats step overlap, which beats
// step-count affinity). Tune here when stage-2 swaps the keyword path
// for embeddings.
const SCORE_W_CONNECTOR = 4;
const SCORE_W_NAME = 2;
const SCORE_W_STEP = 1;
const SCORE_W_AFFINITY = 0.5;

function normalisePriorWorkflowToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokenisePriorWorkflowText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map(normalisePriorWorkflowToken)
    .filter((t) => t.length > 0);
}

function summariseTrigger(trigger: WorkflowDef["trigger"]): string {
  if (!trigger) return "manual";
  switch (trigger.kind) {
    case "webhook":
      return `webhook (${trigger.source})`;
    case "schedule":
      return `schedule (${trigger.cron} ${trigger.tz})`;
    default:
      return "manual";
  }
}

function summariseStepAction(step: Record<string, unknown>): string | undefined {
  if (step.kind === "request") {
    const method = typeof step.method === "string" ? step.method : null;
    const path =
      typeof step.path === "string" ? step.path : typeof step.url === "string" ? step.url : null;
    if (method && path) return `${method} ${path}`;
    if (method) return method;
    if (path) return path;
  }
  if (step.kind === "call" && typeof step.workflow_id === "string") {
    return step.workflow_id;
  }
  return undefined;
}

function buildStepTopology(def: WorkflowDef): PriorWorkflowRef["step_topology"] {
  return def.steps.map((rawStep) => {
    const step = rawStep as unknown as Record<string, unknown>;
    const kind = typeof step.kind === "string" ? step.kind : "unknown";
    const connector_id = typeof step.connector_id === "string" ? step.connector_id : undefined;
    const action = summariseStepAction(step);
    return {
      kind,
      ...(connector_id ? { connector_id } : {}),
      ...(action ? { action } : {}),
    };
  });
}

function deriveOutputKeys(def: WorkflowDef): string[] {
  const schema = def.output_schema;
  if (!schema || typeof schema !== "object") return [];
  const properties = (schema as { properties?: unknown }).properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    return Object.keys(properties as Record<string, unknown>).slice(0, 10);
  }
  // JSON-schema-shaped object without `.properties` (or a non-object
  // schema entirely): return `[]` rather than leaking JSON-schema
  // reserved keywords (`type`, `required`, `additionalProperties`, …)
  // as if they were workflow output keys. The fallback to top-level
  // keys is reserved for the loose-property-map shape — where there's
  // no `type` AND no `properties` discriminator that says "this is
  // JSON-schema, not a property map".
  const looksLikeJsonSchema =
    typeof (schema as { type?: unknown }).type === "string" ||
    "properties" in (schema as Record<string, unknown>);
  if (looksLikeJsonSchema) return [];
  return Object.keys(schema as Record<string, unknown>).slice(0, 10);
}

function projectPriorWorkflowRef(view: WorkflowView): PriorWorkflowRef {
  return {
    id: view.id,
    slug: view.slug,
    name: view.name,
    description: view.definition.description ?? null,
    trigger_summary: summariseTrigger(view.definition.trigger),
    step_topology: buildStepTopology(view.definition),
    output_keys: deriveOutputKeys(view.definition),
  };
}

function scorePriorWorkflow(
  ref: PriorWorkflowRef,
  queryTokens: Set<string>,
  intentConnectorIds: Set<string>,
  targetStepCount: number | undefined,
): number {
  const refConnectorIds = new Set(
    ref.step_topology
      .map((s) => s.connector_id)
      .filter((id): id is string => typeof id === "string"),
  );
  let connectorOverlap = 0;
  for (const id of refConnectorIds) {
    if (intentConnectorIds.has(id)) connectorOverlap += 1;
  }

  const nameDescTokens = new Set(tokenisePriorWorkflowText(`${ref.name} ${ref.description ?? ""}`));
  let nameDescOverlap = 0;
  for (const token of nameDescTokens) {
    if (queryTokens.has(token)) nameDescOverlap += 1;
  }

  const stepTokenSet = new Set<string>();
  for (const step of ref.step_topology) {
    stepTokenSet.add(normalisePriorWorkflowToken(step.kind));
    if (step.connector_id) stepTokenSet.add(normalisePriorWorkflowToken(step.connector_id));
    if (step.action) {
      for (const t of tokenisePriorWorkflowText(step.action)) stepTokenSet.add(t);
    }
  }
  let stepOverlap = 0;
  for (const token of stepTokenSet) {
    if (queryTokens.has(token)) stepOverlap += 1;
  }

  const targetCount = targetStepCount ?? ref.step_topology.length;
  const stepCountAffinity = 1 / (1 + Math.abs(ref.step_topology.length - targetCount));

  return (
    SCORE_W_CONNECTOR * connectorOverlap +
    SCORE_W_NAME * nameDescOverlap +
    SCORE_W_STEP * stepOverlap +
    SCORE_W_AFFINITY * stepCountAffinity
  );
}

/**
 * Surface up to `k` active workflows most similar to the current
 * authoring intent. Stage-1 ranking: in-process over the most recent
 * active workflows, with connector overlap dominating, then keyword
 * overlap against name/description, then step-kind/action overlap,
 * then a small step-count affinity term. Deterministic — same inputs
 * return the same ordering with a slug-ascending tiebreak.
 *
 * Read-only. Returns `[]` when no candidates qualify. The candidate
 * pool is capped at `PRIOR_WORKFLOWS_CANDIDATE_POOL` (newest active
 * first) to keep the per-turn cost bounded — stage-2 swaps this for a
 * pgvector lookup once workflow definitions are embedding-indexed.
 */
export async function findSimilarActive(
  tenant_id: string,
  intent: FindSimilarActiveIntent,
  k = 3,
  exec?: Executor,
): Promise<PriorWorkflowRef[]> {
  const opts: ListWorkflowsOptions = { status: "active", limit: PRIOR_WORKFLOWS_CANDIDATE_POOL };
  const { rows: candidates } = await listWorkflows(tenant_id, opts, exec);
  if (candidates.length === 0) return [];

  const queryTokens = new Set(tokenisePriorWorkflowText(intent.query));
  const intentConnectorIds = new Set(intent.connector_ids);

  interface Scored {
    score: number;
    ref: PriorWorkflowRef;
  }
  const scored: Scored[] = [];
  for (const view of candidates) {
    if (intent.exclude_workflow_id && view.id === intent.exclude_workflow_id) continue;
    const ref = projectPriorWorkflowRef(view);
    const score = scorePriorWorkflow(
      ref,
      queryTokens,
      intentConnectorIds,
      intent.target_step_count,
    );
    scored.push({ score, ref });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.ref.slug.localeCompare(b.ref.slug);
  });

  // `Math.max(0, k)` honours `k=0` as "do not surface any refs" — useful
  // for an A/B flag that disables the section without unwiring it.
  // Negative `k` clamps to 0 rather than throwing; .slice(0, 0) returns
  // []. Tested in find-similar-active.test.ts.
  return scored.slice(0, Math.max(0, k)).map((s) => s.ref);
}
