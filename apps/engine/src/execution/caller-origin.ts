import type { AuditActorType } from "../audit/index.ts";
import { CallerContextSchema, callerAuditActorId } from "./caller-context.ts";

export type CallerOrigin = "principal" | "trusted_system" | "unknown";

export function resolveExecutionCallerOrigin(
  tenantId: string,
  caller: unknown,
  origin: unknown,
): CallerOrigin {
  if (origin === "trusted_system" && caller === null) return "trusted_system";
  if (origin !== "principal") return "unknown";
  const parsed = CallerContextSchema.safeParse(caller);
  return parsed.success && parsed.data.tenantId === tenantId ? "principal" : "unknown";
}

export function resolveExecutionCallerActor(
  tenantId: string,
  caller: unknown,
  origin: unknown,
): { actor_type: AuditActorType; actor_id: string | null } {
  const verifiedOrigin = resolveExecutionCallerOrigin(tenantId, caller, origin);
  if (verifiedOrigin === "trusted_system") return { actor_type: "system", actor_id: null };
  if (verifiedOrigin === "principal") {
    const parsed = CallerContextSchema.parse(caller);
    return { actor_type: parsed.principalKind, actor_id: callerAuditActorId(parsed) };
  }
  return { actor_type: "unknown", actor_id: null };
}
