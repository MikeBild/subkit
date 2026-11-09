import type { DomainWorkflowSpec } from "./domain-types.ts";
import { WorkflowSpecSchema } from "./draft-schemas.ts";

export function readStoredSpec(value: unknown): DomainWorkflowSpec | null {
  const parsed = WorkflowSpecSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
