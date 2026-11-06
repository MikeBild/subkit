import type { Executor } from "../db/client.ts";
import { type ListWorkflowsOptions, WORKFLOW_LIST_MAX_LIMIT } from "./catalog-view.ts";
import { listWorkflows, type WorkflowView } from "./service.ts";
import type { WorkflowDef } from "./types.ts";

export interface PriorWorkflowRef {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  trigger_summary: string;
  step_topology: Array<{ kind: string; connector_id?: string; action?: string }>;
  output_keys: string[];
}

interface FindSimilarActiveIntent {
  query: string;
  connector_ids: string[];
  target_step_count?: number;
  exclude_workflow_id?: string;
}

const PRIOR_WORKFLOWS_CANDIDATE_POOL = 50;

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

export function buildStepTopology(def: WorkflowDef): PriorWorkflowRef["step_topology"] {
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
    description: view.description,
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

export async function listActiveWorkflowRefs(
  tenant_id: string,
  db: Executor,
): Promise<PriorWorkflowRef[]> {
  const refs: PriorWorkflowRef[] = [];
  for (let offset = 0; ; offset += WORKFLOW_LIST_MAX_LIMIT) {
    const opts: ListWorkflowsOptions = {
      status: "active",
      sort: "created_at",
      order: "asc",
      limit: WORKFLOW_LIST_MAX_LIMIT,
      offset,
    };
    const { rows, total } = await listWorkflows(tenant_id, opts, db);
    for (const row of rows) refs.push(projectPriorWorkflowRef(row));
    if (rows.length < WORKFLOW_LIST_MAX_LIMIT || refs.length >= total) return refs;
  }
}

export async function findSimilarActive(
  tenant_id: string,
  intent: FindSimilarActiveIntent,
  k = 3,
  db: Executor,
): Promise<PriorWorkflowRef[]> {
  const opts: ListWorkflowsOptions = { status: "active", limit: PRIOR_WORKFLOWS_CANDIDATE_POOL };
  const { rows: candidates } = await listWorkflows(tenant_id, opts, db);
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

  return scored.slice(0, Math.max(0, k)).map((s) => s.ref);
}
