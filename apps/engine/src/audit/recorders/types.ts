import type { Executor } from "../../db/client.ts";
import type { AuditActorType, AuditEntry, AuditResult } from "../types.ts";

export interface RecorderBase {
  tenant_id: string;
  actor_id: string | null;
  actor_type?: AuditActorType;
  executor?: Executor;
}

export function resolveActor(p: {
  actor_id: string | null;
  actor_type?: AuditActorType | undefined;
  tenant_id?: string;
  executor?: Executor;
}): {
  actor_type: AuditActorType;
  actor_id: string | null;
} {
  if (p.actor_type === "unknown" || (!p.actor_type && p.actor_id)) {
    return { actor_type: "unknown", actor_id: null };
  }
  if (p.actor_type === "system") return { actor_type: "system", actor_id: null };
  if (p.actor_type) {
    return p.actor_id
      ? { actor_type: p.actor_type, actor_id: p.actor_id }
      : { actor_type: "unknown", actor_id: null };
  }
  return { actor_type: "system", actor_id: null };
}

export type RecordedEntry = AuditEntry;

export type AuditOutcome = AuditResult;
