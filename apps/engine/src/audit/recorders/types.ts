// Shared types for the typed audit recorders.
//
// Recorders are thin, type-safe wrappers around `auditAwait`. They exist
// so every Wave-1..3 state-changing path lands a row with a non-null
// `reason` and a properly shaped `metadata` object — the compiler
// catches missing fields at the call site instead of at runtime when
// an operator runs a forensic SELECT and finds half the rows blank.
//
// Each recorder takes:
//   - `tenant_id` (mandatory, tenant-scoped audit trail)
//   - `actor_id`  (the user / system_account / null for system)
//   - `actor_type` (defaults inferred from actor_id when omitted)
//   - `executor` (optional drizzle Db / transaction)
//   - resource-specific typed fields
//
// They never accept a raw `metadata: unknown` — the recorder owns the
// shape and embeds whatever the call site passes via narrow typed
// helpers. The shape is locked at compile time.

import type { Executor } from "../../db/client.ts";
import type { AuditActorType, AuditEntry, AuditResult } from "../types.ts";

export type { Executor };

/** Shared base fields every recorder accepts. */
export interface RecorderBase {
  tenant_id: string;
  actor_id: string | null;
  /**
   * When omitted, the recorder defaults to "user" if `actor_id` is
   * non-null, otherwise "system". Pass an explicit type when the actor
   * is a `system_account`.
   */
  actor_type?: AuditActorType;
  /** Drizzle executor — bind audit insert to a domain transaction. */
  executor?: Executor;
}

/**
 * Resolve the `actor_type` shorthand. Explicit value wins; otherwise
 * we infer "user" when there's an actor_id, and "system" when the
 * caller is fire-and-forget background work.
 */
export function resolveActorType(p: RecorderBase): AuditActorType {
  if (p.actor_type) return p.actor_type;
  return p.actor_id ? "user" : "system";
}

export type RecordedEntry = AuditEntry;

/** Public alias so call sites do not need to import the union directly. */
export type AuditOutcome = AuditResult;
