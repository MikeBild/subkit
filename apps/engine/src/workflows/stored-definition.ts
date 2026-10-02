// A stored workflow definition, read against today's schema.
//
// The definition schema moves on; what is stored does not. A dag written under
// an earlier schema is still the workflow's record, so READING it must never
// fail: a list, a workflow page and "how do I call this" all show what is
// there and mark it `legacy`. ACTING on it is the opposite — a run or an
// activation makes the stored dag the thing that executes, so there the schema
// is enforced and a dag that no longer validates is refused by name.
//
// One reader for both, so "legacy" means the same thing wherever it is asked.

import { type WorkflowDef, WorkflowDefSchema } from "./types.ts";

export interface VersionIssue {
  /** Dotted path into the stored definition, e.g. `steps.0.language`. */
  path: string;
  /** Id of the step the path points into, when it points into one. */
  step_id: string | null;
  message: string;
}

function stepIdAt(dag: unknown, path: ReadonlyArray<PropertyKey>): string | null {
  const index = path[1];
  if (path[0] !== "steps" || typeof index !== "number") return null;
  const steps = (dag as { steps?: unknown } | null)?.steps;
  const step: unknown = Array.isArray(steps) ? steps[index] : undefined;
  const id = (step as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" ? id : null;
}

export type StoredDefinition =
  | { legacy: false; definition: WorkflowDef }
  | { legacy: true; issues: VersionIssue[] };

/** The stored dag as a current definition, or what in it no longer validates. */
export function readStoredDefinition(dag: unknown): StoredDefinition {
  const parsed = WorkflowDefSchema.safeParse(dag);
  if (parsed.success) return { legacy: false, definition: parsed.data };
  return {
    legacy: true,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      step_id: stepIdAt(dag, issue.path),
      message: issue.message,
    })),
  };
}

/** One sentence naming the first thing that no longer validates. */
export function describeVersionIssues(issues: VersionIssue[]): string {
  const first = issues[0];
  const where = first
    ? `${first.step_id ? `step "${first.step_id}", ` : ""}${first.path || "definition"}: ${first.message}`
    : "the stored definition is not a valid workflow";
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";
  return `${where}${more}`;
}

/**
 * The version a run or an activation was asked to execute is stored in an
 * earlier definition format. A refusal of that request, not a fault of the
 * engine: the code carries the `workflow_version_` prefix the run routes
 * answer with `409`, and `details.issues` names the steps to fix.
 */
export class WorkflowVersionLegacyError extends Error {
  readonly code = "workflow_version_legacy";
  readonly details: { issues: VersionIssue[] };

  constructor(issues: VersionIssue[]) {
    super(
      `this workflow version is stored in an earlier definition format and cannot run — ${describeVersionIssues(issues)}. Save the workflow again in the current format.`,
    );
    this.name = "WorkflowVersionLegacyError";
    this.details = { issues };
  }
}

/** The stored dag as the definition to execute, or `WorkflowVersionLegacyError`. */
export function executableDefinition(dag: unknown): WorkflowDef {
  const stored = readStoredDefinition(dag);
  if (stored.legacy) throw new WorkflowVersionLegacyError(stored.issues);
  return stored.definition;
}

/**
 * The definition a READ shows for a legacy dag: the stored object as written,
 * so the page shows what is there. It did not pass the schema, so it carries
 * no parsed defaults — only readers take it, and `legacy` on the view tells
 * every one of them so. A dag that is not even an object with steps shows as
 * an empty definition under the workflow's name.
 */
export function legacyDefinitionForRead(dag: unknown, name: string): WorkflowDef {
  const steps = (dag as { steps?: unknown } | null)?.steps;
  if (typeof dag === "object" && dag !== null && Array.isArray(steps)) return dag as WorkflowDef;
  return { name, steps: [] } as WorkflowDef;
}
