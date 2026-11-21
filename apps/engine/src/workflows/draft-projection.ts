import { workflowJsonDigest } from "./canonical-json.ts";
import type { WorkflowSpec } from "./draft-schemas.ts";
import { readStoredSpec } from "./stored-spec.ts";
import { type WorkflowDraftDef, WorkflowDraftDefSchema } from "./types.ts";

export interface WorkflowDraftView {
  workflow_id: string;
  version_id: string;
  version: number;
  digest: string;
  current_version_id: string | null;
  definition: WorkflowDraftDef;
  spec: WorkflowSpec | null;
}

export function projectWorkflowDraft(
  wf: { id: string; current_version_id: string | null; description: string | null },
  version: { id: string; version: number; dag: unknown; spec: unknown },
): WorkflowDraftView {
  const stored = WorkflowDraftDefSchema.parse(version.dag);
  const definition: WorkflowDraftDef =
    stored.description === undefined && wf.description
      ? { ...stored, description: wf.description }
      : stored;
  return {
    workflow_id: wf.id,
    version_id: version.id,
    version: version.version,
    digest: workflowJsonDigest(version.dag),
    current_version_id: wf.current_version_id,
    definition,
    spec: readStoredSpec(version.spec),
  };
}
