// `ServiceMetadata` is the identity envelope every engine code path
// carries. It is the single source of truth for *who* is doing *what*
// from *where* on this turn:
//
//   - `trace_id`       — a UUID minted at the entry point, propagated
//                         to every log line, audit row, telemetry event,
//                         outbound HTTP call, and child execution.
//   - `tenant_id`      — the workspace whose data is being read or
//                         written. Mandatory.
//   - `actor_id`       — the principal driving the action. Null for
//                         system-driven turns (scheduler, repair).
//   - `actor_email`    — convenience for audit display. May lag the
//                         real identity briefly after a rename.
//   - `request_source` — surface that triggered the turn. Drives policy
//                         decisions: notification fanout skips
//                         `chat`-sourced runs by default; certain RBAC
//                         checks soften for `cli`; etc.
//
// The shape is enforced via Zod at every entry point. Sub-systems
// (loggers, audit, instrumentation, notifications, execution engine)
// accept the bundle and stamp every record they emit. Existing
// per-field call sites migrate over time; new code should accept
// `ServiceMetadata` rather than reaching for individual fields.

import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../http/openapi.ts";

/** Canonical entry-point label. The same enum drives RBAC softening,
 *  notification routing, and rate-limit selection. */
export const RequestSourceSchema = z.enum([
  "api",
  "cli",
  "mcp",
  "webhook",
  "tool-chain",
  "scheduler",
  "chat",
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

export interface BuildServiceMetadataInput {
  trace_id?: string | null;
  tenant_id: string;
  actor_id?: string | null;
  actor_email?: string | null;
  request_source: RequestSource;
}

/** Build a `ServiceMetadata` for non-HTTP entry points (scheduler,
 *  repair worker, CLI, tests). The trace_id is minted when absent so
 *  downstream code never has to handle null traces. */
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

/** Pull a `ServiceMetadata` from a Hono request context. Prefers the
 *  envelope the auth middleware bound on `service_metadata`; falls
 *  back to assembling one from the principal + raw context fields if
 *  the bound copy is absent (e.g. tests that wire a context manually).
 *  Throws when no tenant is resolvable, because every authenticated
 *  route is expected to have bound a principal by the time downstream
 *  handlers run. */
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

/** Mint a fresh trace id. Uses the host crypto for UUID v4 when
 *  available; falls back to a coarse but unique-enough hex string. */
export function mintTraceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Coarse fallback used only in environments where webcrypto is absent.
  // `crypto.getRandomValues` is preferred when available, but we only
  // reach this branch in pathological setups.
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}
