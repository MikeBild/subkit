// Workflow-capability Skill Candidate proposed on every successful commit.
//
// Extracted from commit-workflow.ts to keep that orchestrator under the
// file-size ceiling. The candidate is always status `proposed` — never an
// active skill. It is advisory (not reviewable): authoring reads it as
// context for the same workflow; no person is asked to decide it.

import { createHash } from "node:crypto";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import { upsertFromSignal } from "../../skill-candidates/service.ts";
import type { PatternSignal } from "../../skill-candidates/types.ts";
import type { ScopeIndex, WorkflowDefFromDraft } from "./commit-workflow.ts";

/** Sorted-key JSON serialization so a fingerprint derived from a `jsonb`
 *  schema (where Postgres does not preserve key order) is stable across
 *  re-commits of the same declared shape. */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/** One-line prose summary of a declared `input_schema` (name: type
 *  (required) — description), used in the candidate body. */
function describeInputSchema(input_schema: unknown): string {
  if (!input_schema || typeof input_schema !== "object") return "none declared";
  const schema = input_schema as Record<string, unknown>;
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const names = Object.keys(props);
  if (names.length === 0) return "none declared";
  return names
    .map((name) => {
      const p = (props[name] ?? {}) as Record<string, unknown>;
      const type = typeof p.type === "string" ? p.type : "any";
      const req = required.includes(name) ? " (required)" : "";
      const desc = typeof p.description === "string" ? ` — ${p.description}` : "";
      return `${name}: ${type}${req}${desc}`;
    })
    .join("; ");
}

/**
 * Build the workflow-capability PatternSignal proposed on every commit.
 * Identity is the declared interface: fingerprint = sha256 over the
 * workflow id plus the canonical input/output schemas, so a re-commit of
 * the same shape updates the same candidate (no flood) while a schema
 * change supersedes the prior one (workflow-keyed, endpoint_key null) —
 * exactly one live candidate per workflow.
 */
function buildAuthoringCapabilitySignal(args: {
  workflow_id: string;
  slug: string;
  name: string;
  def: WorkflowDefFromDraft;
  scope_index: ScopeIndex;
  draft_version_id?: string;
}): PatternSignal {
  const { workflow_id, slug, name, def, scope_index } = args;

  const connectorIds = Array.from(
    new Set(
      def.steps
        .map((s) => (typeof s.connector_id === "string" ? s.connector_id : null))
        .filter((id): id is string => id !== null),
    ),
  );
  // Workflow-level candidate: attribute to a connector only when the DAG
  // is single-connector; multi/zero-connector → null (the supersede pass
  // then keys purely on workflow_id).
  const connectorId = connectorIds.length === 1 ? connectorIds[0]! : null;

  const stepIds = def.steps
    .map((s) => (typeof s.id === "string" ? s.id : null))
    .filter((id): id is string => id !== null);
  const stepKinds = def.steps.map((s) => (typeof s.kind === "string" ? s.kind : "?"));
  const lastStepId = stepIds.length > 0 ? stepIds[stepIds.length - 1]! : null;
  const lastScope = lastStepId ? scope_index[lastStepId] : undefined;

  const inputSummary = describeInputSchema(def.input_schema);
  const outputShape = def.output_schema
    ? "declared output_schema"
    : (lastScope?.shape_summary ?? "unknown");
  const keyPaths = lastScope?.available_paths?.slice(0, 12) ?? [];
  const exampleInvocation = args.draft_version_id
    ? `GET /v1/workflows/${workflow_id}/draft — inspect only; activation and execution authority are required before a live run`
    : `POST /v1/workflows/${slug}/runs  body: { "input": { … } }`;

  const body = [
    `Workflow '${name}' (slug ${slug}) — what it does and how to invoke it.`,
    ...(args.draft_version_id
      ? [
          `Saved draft version ${args.draft_version_id}. This candidate describes preparation, not an active capability. Approving this skill does not activate the workflow or authorize execution.`,
        ]
      : []),
    `Inputs: ${inputSummary}.`,
    `Output shape: ${outputShape}.`,
    connectorIds.length > 0
      ? `Connectors: ${connectorIds.join(", ")}.`
      : "Connectors: none (transform/inline only).",
    `Steps: ${stepKinds.join(" → ")}.`,
    ...(keyPaths.length > 0 ? [`Key output paths: ${keyPaths.join(", ")}.`] : []),
    `Example invocation: ${exampleInvocation}`,
  ].join("\n");

  const fingerprint = createHash("sha256")
    .update(
      `authoring_capability:${workflow_id}:${canonicalJson(def.input_schema ?? null)}:${canonicalJson(
        def.output_schema ?? null,
      )}`,
    )
    .digest("hex")
    .slice(0, 32);

  return {
    pattern_kind: "authoring_capability",
    scope: "workflow",
    workflow_id,
    ...(connectorId ? { connector_id: connectorId } : {}),
    // endpoint_key intentionally omitted (stored null) — capability is
    // workflow-scoped, so the supersede pass treats it as workflow-keyed.
    title: `Workflow '${slug}' capabilities`,
    body,
    examples: [exampleInvocation],
    best_practices: [],
    pitfalls: [],
    doc_refs: [],
    fingerprint,
    confidence: "high",
    evidence: [
      {
        evidence_type: args.draft_version_id ? "workflow_draft_saved" : "workflow_committed",
        summary: `${args.draft_version_id ? "Saved draft of" : "Committed"} workflow '${slug}' (${def.steps.length} step(s)${
          connectorIds.length > 0 ? `, connectors: ${connectorIds.join(", ")}` : ""
        }).`,
      },
    ],
  };
}

/**
 * Propose (or update) the workflow-capability candidate on commit. It is
 * advisory (`reviewable: false`): drafting context, never a decision a person
 * is asked to take, so nothing announces it. Best-effort: a candidate failure
 * must never break a successful commit, so all errors are caught and logged.
 */
export async function proposeAuthoringCapabilityCandidate(args: {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  workflow: { id: string; slug: string; name: string };
  def: WorkflowDefFromDraft;
  scope_index: ScopeIndex;
  draft_version_id?: string;
}): Promise<void> {
  const { db, tenant_id, conversation_id, workflow, def, scope_index } = args;
  try {
    const signal = buildAuthoringCapabilitySignal({
      workflow_id: workflow.id,
      slug: workflow.slug,
      name: workflow.name,
      def,
      scope_index,
      ...(args.draft_version_id ? { draft_version_id: args.draft_version_id } : {}),
    });
    await upsertFromSignal(tenant_id, signal, db);
  } catch (err) {
    logger.warn({
      module: "conversation_persistence",
      action: "commit.skill_candidate_failed",
      msg: "capability skill-candidate proposal failed — commit is unaffected",
      tenant_id,
      conversation_id,
      workflow_id: workflow.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
