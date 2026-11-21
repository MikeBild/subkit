import { type WorkflowDef, WorkflowDefSchema } from "./types.ts";

export interface VersionIssue {
  path: string;
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

type StoredDefinition =
  | { invalid: false; definition: WorkflowDef }
  | { invalid: true; issues: VersionIssue[] };

const ITEM_VAR_RETIRED_MESSAGE =
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

export function hasNoSteps(dag: unknown): boolean {
  const steps = (dag as { steps?: unknown } | null)?.steps;
  return Array.isArray(steps) && steps.length === 0;
}

export function describeVersionIssues(issues: VersionIssue[]): string {
  const first = issues[0];
  const where = first
    ? `${first.step_id ? `step "${first.step_id}", ` : ""}${first.path || "definition"}: ${first.message}`
    : "the stored definition is not a valid workflow";
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";
  return `${where}${more}`;
}

class WorkflowVersionInvalidError extends Error {
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

export function executableDefinition(dag: unknown): WorkflowDef {
  const stored = readStoredDefinition(dag);
  if (stored.invalid) throw new WorkflowVersionInvalidError(stored.issues);
  return stored.definition;
}

export function invalidDefinitionForRead(dag: unknown, name: string): WorkflowDef {
  const steps = (dag as { steps?: unknown } | null)?.steps;
  if (typeof dag === "object" && dag !== null && Array.isArray(steps)) return dag as WorkflowDef;
  return { name, steps: [] } as WorkflowDef;
}
