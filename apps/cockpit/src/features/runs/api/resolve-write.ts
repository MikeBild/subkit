import type { components } from "@cli-core/engine-api/openapi";
import { apiCall } from "@/api/call";

export type ResolveWriteBody = components["schemas"]["ExecutionResolveWriteBody"];
export type ResolveWriteResponse = components["schemas"]["ExecutionResolveWriteResponse"];
export type WriteOutcome = ResolveWriteBody["outcome"];

export function resolveWrite(
  executionId: string,
  body: ResolveWriteBody,
): Promise<ResolveWriteResponse> {
  return apiCall("post", "/v1/executions/{id}/resolve-write", {
    path: { id: executionId },
    body,
  });
}
