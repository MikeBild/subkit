// Correlation bridge across the pg-boss queue boundary.
//
// A job is enqueued inside one request's async context (which carries the
// originating `trace_id` + `tenant_id`), but the worker dequeues it on a
// fresh tick with an EMPTY `LogContext` — so every `execution.*` /
// `conversation.*` log the handler emits downstream would otherwise lose the
// enqueuing trace and tenant. `withJobContext` re-establishes that context
// from the job envelope the enqueuer stamped, so a single `trace_id` stitches
// the HTTP request, the queued job, and the execution together.
//
// Defensive: the envelope is `unknown` because each queue carries its own
// payload type; only the optional correlation fields are read, and a missing
// field simply isn't set on the context.

import { z } from "zod";

import { type LogContext, withContext } from "../logging/context.ts";

/** Correlation fields a job envelope may carry — the single source of truth
 *  for what `withJobContext` bridges. `.partial()` + `.catch({})` so a
 *  malformed or unrelated envelope degrades to "no correlation", never throws
 *  (the worker must run regardless). Add a field here when a new one needs to
 *  cross the queue boundary. */
const JobCorrelationSchema = z
  .object({
    trace_id: z.string().nullish(),
    tenant_id: z.string(),
    execution_id: z.string(),
    workflow_id: z.string(),
  })
  .partial()
  .catch({});

/**
 * Run `fn` inside a `LogContext` derived from the job envelope `data`, with
 * `request_source: "queue"` so log readers can tell a worker-driven line from
 * the request that enqueued it. Only correlation fields actually present on
 * the envelope are set — a job without a `trace_id` (most non-execution
 * queues) inherits the rest and leaves trace unset.
 */
export function withJobContext<T>(data: unknown, fn: () => T): T {
  const job = JobCorrelationSchema.parse(data);
  const ctx: LogContext = { request_source: "queue" };
  if (typeof job.trace_id === "string") ctx.trace_id = job.trace_id;
  if (typeof job.tenant_id === "string") ctx.tenant_id = job.tenant_id;
  if (typeof job.execution_id === "string") ctx.execution_id = job.execution_id;
  if (typeof job.workflow_id === "string") ctx.workflow_id = job.workflow_id;
  return withContext(ctx, fn);
}
