import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../http/openapi.ts";

export const RequestSourceSchema = z.enum([
  "api",
  "cli",
  "scheduler",
  "mcp",
  "webhook",
  "tool-chain",
  "ui",
  "chat",
  "queue",
]);
export type RequestSource = z.infer<typeof RequestSourceSchema>;

export const ServiceMetadataSchema = z.object({
  trace_id: z.string().min(1),
  tenant_id: z.string().min(1),
  actor_id: z.string().nullable(),
  actor_email: z.string().nullable(),
  request_source: RequestSourceSchema,
});
export type ServiceMetadata = z.infer<typeof ServiceMetadataSchema>;

interface BuildServiceMetadataInput {
  trace_id?: string | null;
  tenant_id: string;
  actor_id?: string | null;
  actor_email?: string | null;
  request_source: RequestSource;
}

export function buildServiceMetadata(input: BuildServiceMetadataInput): ServiceMetadata {
  const trace_id = input.trace_id ?? mintTraceId();
  return ServiceMetadataSchema.parse({
    trace_id,
    tenant_id: input.tenant_id,
    actor_id: input.actor_id ?? null,
    actor_email: input.actor_email ?? null,
    request_source: input.request_source,
  });
}

export function serviceMetadataFromHono(c: Context<AppEnv>): ServiceMetadata {
  const bound = c.get("service_metadata");
  if (bound) return bound;
  const principal = c.get("principal");
  if (!principal) {
    throw new Error("serviceMetadataFromHono: principal is not bound on the context");
  }
  const trace_id = c.get("trace_id") ?? mintTraceId();
  const requestSource = c.get("request_source") ?? "api";
  return buildServiceMetadata({
    trace_id,
    tenant_id: principal.tenant_id,
    actor_id: principal.id,
    actor_email: principal.email ?? null,
    request_source: requestSource,
  });
}

export function mintTraceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}
