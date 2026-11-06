import type { RunEnvironment } from "@/lib/run-availability";
import type { FormInput } from "@/lib/schema-form";
import { type ApiResponse, apiCall } from "./call";

export type WorkflowRunOutcome = ApiResponse<"/v1/executions", "post">;

export function startWorkflowRun(
  workflowId: string,
  environment: RunEnvironment | null | undefined,
  input: FormInput | undefined,
): Promise<WorkflowRunOutcome> {
  return apiCall("post", "/v1/executions", {
    body: { source: "saved", workflow_id: workflowId, ...(input !== undefined ? { input } : {}) },
    ...(environment ? { headers: { "x-subkit-environment": environment } } : {}),
  });
}
