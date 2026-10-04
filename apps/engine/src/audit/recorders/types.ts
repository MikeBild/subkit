import type { Executor } from "../../db/client.ts";
import type { AuditActorType, AuditEntry, AuditResult } from "../types.ts";

export interface RecorderBase {
  tenant_id: string;
  actor_id: string | null;
  actor_type?: AuditActorType;
  executor?: Executor;
}

export function resolveActorType(p: RecorderBase): AuditActorType {
  if (p.actor_type) return p.actor_type;
  return p.actor_id ? "user" : "system";
}

export type RecordedEntry = AuditEntry;

export type AuditOutcome = AuditResult;
