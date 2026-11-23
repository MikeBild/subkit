import { z } from "zod";
import { apiRequest } from "@/api/client";

export const WRITE_OUTCOMES = ["arrived", "not_arrived"] as const;
export type WriteOutcome = (typeof WRITE_OUTCOMES)[number];

export const ResolveWriteBodySchema = z
  .object({
    step_key: z.string().min(1).max(300),
    outcome: z.enum(WRITE_OUTCOMES),
  })
  .strict();
export type ResolveWriteBody = z.infer<typeof ResolveWriteBodySchema>;

export const ResolveWriteResponseSchema = z
  .object({
    execution_id: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();
export type ResolveWriteResponse = z.infer<typeof ResolveWriteResponseSchema>;

export async function resolveWrite(
  executionId: string,
  body: ResolveWriteBody,
): Promise<ResolveWriteResponse> {
  return ResolveWriteResponseSchema.parse(
    await apiRequest<unknown>(`/v1/executions/${encodeURIComponent(executionId)}/resolve-write`, {
      method: "POST",
      body: JSON.stringify(ResolveWriteBodySchema.parse(body)),
    }),
  );
}
