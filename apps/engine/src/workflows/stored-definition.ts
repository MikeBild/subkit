import { retiredLoopNotices } from "./core/loop-rewrite.ts";
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

export function retiredLoopIssues(dag: unknown): VersionIssue[] {
  const steps = (dag as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return [];
  return retiredLoopNotices(dag).map((notice) => ({
    path: `steps.${steps.findIndex((step) => (step as { id?: unknown } | null)?.id === notice.loop_step_id)}`,
    step_id: notice.loop_step_id,
    message: notice.message,
  }));
}

export function readStoredDefinition(dag: unknown): StoredDefinition {
  const parsed = WorkflowDefSchema.safeParse(dag);
  if (parsed.success) return { invalid: false, definition: parsed.data };
  const retired = retiredLoopIssues(dag);
  const retiredPaths = new Set(retired.map((issue) => issue.path));
  return {
    invalid: true,
    issues: [
      ...retired,
      ...parsed.error.issues
        .filter((issue) => !retiredPaths.has(issue.path.slice(0, 2).map(String).join(".")))
        .map((issue) => ({
          path: issue.path.map(String).join("."),
          step_id: stepIdAt(dag, issue.path),
          message: issue.message,
        })),
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
