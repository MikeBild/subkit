import { z } from "zod";
import { type LogContext, withContext } from "../logging/context.ts";

const JobCorrelationSchema = z
  .object({
    trace_id: z.string().nullish(),
    tenant_id: z.string(),
    execution_id: z.string(),
    workflow_id: z.string(),
  })
  .partial()
  .catch({});

export function withJobContext<T>(data: unknown, fn: () => T): T {
  const job = JobCorrelationSchema.parse(data);
  const ctx: LogContext = { request_source: "queue" };
  if (typeof job.trace_id === "string") ctx.trace_id = job.trace_id;
  if (typeof job.tenant_id === "string") ctx.tenant_id = job.tenant_id;
  if (typeof job.execution_id === "string") ctx.execution_id = job.execution_id;
  if (typeof job.workflow_id === "string") ctx.workflow_id = job.workflow_id;
  return withContext(ctx, fn);
}
