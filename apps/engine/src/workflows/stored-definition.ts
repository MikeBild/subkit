// A stored workflow definition, read against today's schema.
//
// The definition schema moves on; what is stored does not. A dag written under
// an earlier schema is still the workflow's record, so READING it must never
// fail: a list, a workflow page and "how do I call this" all show what is
// there and mark it `invalid`. ACTING on it is the opposite — a run or an
// activation makes the stored dag the thing that executes, so there the schema
// is enforced and a dag that no longer validates is refused by name.
//
// One reader for both, so "invalid" means the same thing wherever it is asked.

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
  | { invalid: false; definition: WorkflowDef }
  | { invalid: true; issues: VersionIssue[] };

export const ITEM_VAR_RETIRED_MESSAGE =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: operator-facing message names the literal `${item.…}` placeholder grammar.
  "`item_var` is retired — remove it. Address the loop item as `$item` in JSONata expressions and `${item.<field>}` in URL/header/query/body strings (`$loop_index` is the iteration counter).";

export function retiredItemVarIssues(dag: unknown): VersionIssue[] {
  const steps = (dag as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return [];
  const issues: VersionIssue[] = [];
  steps.forEach((step: unknown, index) => {
    if (typeof step !== "object" || step === null) return;
    const s = step as { kind?: unknown; id?: unknown };
    if (s.kind !== "loop" || !Object.hasOwn(step, "item_var")) return;
    issues.push({
      path: `steps.${index}.item_var`,
      step_id: typeof s.id === "string" ? s.id : null,
      message: ITEM_VAR_RETIRED_MESSAGE,
    });
  });
  return issues;
}

/** The stored dag as a current definition, or what in it no longer validates. */
export function readStoredDefinition(dag: unknown): StoredDefinition {
  const parsed = WorkflowDefSchema.safeParse(dag);
  const retired = retiredItemVarIssues(dag);
  if (parsed.success && retired.length === 0) return { invalid: false, definition: parsed.data };
  return {
    invalid: true,
    issues: [
      ...retired,
      ...(parsed.success
        ? []
        : parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join("."),
            step_id: stepIdAt(dag, issue.path),
            message: issue.message,
          }))),
    ],
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
export class WorkflowVersionInvalidError extends Error {
  readonly code = "workflow_version_invalid";
  readonly details: { issues: VersionIssue[] };

  constructor(issues: VersionIssue[]) {
    super(
      `this workflow version is stored in an earlier definition format and cannot run — ${describeVersionIssues(issues)}. Save the workflow again in the current format.`,
    );
    this.name = "WorkflowVersionInvalidError";
    this.details = { issues };
  }
}

/** The stored dag as the definition to execute, or `WorkflowVersionInvalidError`. */
export function executableDefinition(dag: unknown): WorkflowDef {
  const stored = readStoredDefinition(dag);
  if (stored.invalid) throw new WorkflowVersionInvalidError(stored.issues);
  return stored.definition;
}

/**
 * The definition a READ shows for an invalid dag: the stored object as written,
 * so the page shows what is there. It did not pass the schema, so it carries
 * no parsed defaults — only readers take it, and `invalid` on the view tells
 * every one of them so. A dag that is not even an object with steps shows as
 * an empty definition under the workflow's name.
 */
export function invalidDefinitionForRead(dag: unknown, name: string): WorkflowDef {
  const steps = (dag as { steps?: unknown } | null)?.steps;
  if (typeof dag === "object" && dag !== null && Array.isArray(steps)) return dag as WorkflowDef;
  return { name, steps: [] } as WorkflowDef;
}
