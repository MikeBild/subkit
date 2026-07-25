// Elicitation helpers — create / list / resolve rows in the
// `conversation_elicitations` table. Generalized pause-resume for any
// `askUser.*` tool.
//
// Mirrors the shape of `approval.ts` but works with the widened
// `(tool_name, input, output)` columns so a single helper serves
// `askUser.choice`, `askUser.multi`, `askUser.text`, `askUser.form`,
// and `askUser.confirm` without branching per tool.

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  conversationElicitations,
  conversations,
  conversationToolCalls,
} from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { APPROVAL_TTL_MS } from "../tools/approval.ts";
import { approvalHandleFromElicitationInput } from "./tools/ask-user/commit-intent.ts";
import { redactElicitationOutput } from "./tools/ask-user/redact-answer.ts";

export type ElicitationStatus = "pending" | "resolved" | "cancelled" | "timeout";

export interface ElicitationRecord {
  id: string;
  conversation_id: string;
  tool_call_id: string | null;
  tool_name: string;
  summary: string;
  input: unknown;
  output: unknown;
  status: ElicitationStatus;
  decision_reason: string | null;
  delivery_last_error: string | null;
  delivery_attempts: number;
  created_at: string;
  /**
   * Causal anchor to the assistant message that requested this input.
   * Nullable for legacy rows; the SSE replay path falls back to placing
   * orphans after all anchored events.
   */
  parent_message_id?: string | null;
}

export interface NativeDeliveryClaim {
  elicitation: ElicitationRecord;
  lease_id: string;
}

/**
 * Atomically lease a pending elicitation for one native MCP round-trip.
 * Expired leases are reclaimable after a client disconnect or process crash.
 */
export async function claimNativeElicitationDelivery(
  p: { tenant_id: string; conversation_id: string; id: string; lease_ms?: number },
  exec: Executor,
): Promise<NativeDeliveryClaim | null> {
  const lease_id = randomUUID();
  const now = new Date();
  const lease_expires_at = new Date(now.getTime() + (p.lease_ms ?? 90_000));
  const [row] = await exec
    .update(conversationElicitations)
    .set({
      protocol_native: true,
      delivery_lease_id: lease_id,
      delivery_lease_expires_at: lease_expires_at,
      delivery_last_error: null,
      delivery_attempts: sql`${conversationElicitations.delivery_attempts} + 1`,
      updated_at: now,
    })
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.conversation_id, p.conversation_id),
        eq(conversationElicitations.id, p.id),
        eq(conversationElicitations.status, "pending"),
        or(
          isNull(conversationElicitations.delivery_lease_expires_at),
          lt(conversationElicitations.delivery_lease_expires_at, now),
        ),
      ),
    )
    .returning();
  return row ? { elicitation: rowToRecord(row), lease_id } : null;
}

/** Release only the lease owned by this request; a newer claimant is untouched. */
export async function releaseNativeElicitationDelivery(
  p: { tenant_id: string; id: string; lease_id: string; error_code?: string },
  exec: Executor,
): Promise<void> {
  await exec
    .update(conversationElicitations)
    .set({
      delivery_lease_id: null,
      delivery_lease_expires_at: null,
      delivery_last_error: p.error_code ?? null,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.id, p.id),
        eq(conversationElicitations.delivery_lease_id, p.lease_id),
        eq(conversationElicitations.status, "pending"),
      ),
    );
}

/** Record URL navigation consent without overwriting a callback that already completed. */
export async function acknowledgeNativeUrlElicitation(
  p: { tenant_id: string; id: string; lease_id: string },
  exec: Executor,
): Promise<void> {
  await exec
    .update(conversationElicitations)
    .set({
      delivery_lease_id: null,
      delivery_lease_expires_at: null,
      delivery_last_error: sql`case
        when ${conversationElicitations.delivery_last_error} in ('url_completed', 'url_failed')
          then ${conversationElicitations.delivery_last_error}
        else 'url_accepted'
      end`,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.id, p.id),
        eq(conversationElicitations.delivery_lease_id, p.lease_id),
        eq(conversationElicitations.status, "pending"),
      ),
    );
}

type Row = typeof conversationElicitations.$inferSelect;

function rowToRecord(row: Row): ElicitationRecord {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    tool_call_id: row.tool_call_id,
    tool_name: row.tool_name,
    summary: row.summary,
    input: row.input,
    output: row.output,
    status: row.status as ElicitationStatus,
    decision_reason: row.decision_reason,
    delivery_last_error: row.delivery_last_error,
    delivery_attempts: row.delivery_attempts,
    created_at: row.created_at.toISOString(),
    parent_message_id: row.parent_message_id,
  };
}

/** Fields a caller supplies to open an elicitation row. The
 *  `protocol_native` flag is NOT part of this shape — it is fixed by the
 *  entry point (`createElicitation` vs `createNativeElicitation`) so a
 *  caller cannot claim a bridge round-trip it never issued. */
export interface CreateElicitationParams {
  tenant_id: string;
  conversation_id: string;
  tool_call_id: string | null;
  parent_message_id?: string | null;
  tool_name: string;
  summary: string;
  input: unknown;
  actor_id: string | null;
  /** When this prompt stops being answerable. Omit to take the default from
   *  `elicitationExpiry()` — every row gets one, so no prompt is unbounded. */
  expires_at?: Date;
}

/** How long a plain `ask_user_*` prompt stays answerable.
 *
 *  Generous on purpose: a human may legitimately step away from an authoring
 *  session for a day. But it is NOT unbounded, which is what it effectively was
 *  — the column existed and nothing ever wrote it, so the expiry sweep (which
 *  selected only approval-backed and draft-credential rows by JSONB predicate)
 *  could never see an ordinary prompt. Production accumulated 60 conversations
 *  wedged in `awaiting_input`, the oldest for two and a half months, each one
 *  still deriving `input_required` on every MCP Tasks poll. */
export const ELICITATION_HUMAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The expiry to stamp on a new elicitation row.
 *
 * Aligned to whatever capability actually bounds the prompt, so the sweep can
 * select uniformly on one indexed column instead of re-deriving each kind from
 * JSONB:
 *   - approval-backed confirm → the approval window. The sweep still re-reads
 *     `tool_approvals` before expiring, so a grant that extends the window is
 *     honoured rather than timed out.
 *   - draft-credential setup → the grant's own embedded expiry.
 *   - everything else → `ELICITATION_HUMAN_TTL_MS`.
 */
export function elicitationExpiry(input: unknown, now: Date): Date {
  if (approvalHandleFromElicitationInput(input)) {
    return new Date(now.getTime() + APPROVAL_TTL_MS);
  }
  const embedded =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as { expires_at?: unknown }).expires_at
      : undefined;
  if (typeof embedded === "string") {
    const parsed = Date.parse(embedded);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return new Date(now.getTime() + ELICITATION_HUMAN_TTL_MS);
}

/**
 * Open an elicitation row for the DB-pause + `respondElicitation` path.
 * Always writes `protocol_native: false` — the row is satisfied via a
 * portal POST, not an MCP `elicitation/create` round-trip.
 *
 * Bridge-path callers (in-process MCP `elicitation/create`) must use
 * `createNativeElicitation` instead so the `surface` audit metadata
 * stays truthful regardless of what the caller passes.
 */
export function createElicitation(
  p: CreateElicitationParams,
  exec: Executor,
): Promise<ElicitationRecord> {
  return insertElicitation(p, false, exec);
}

/**
 * Open an elicitation row that backs an MCP-native `elicitation/create`
 * round-trip (the in-process bridge). Always writes
 * `protocol_native: true`. Use this ONLY on a path that actually issues
 * the bridge call — the flag drives the `surface` audit metadata.
 */
export function createNativeElicitation(
  p: CreateElicitationParams,
  exec: Executor,
): Promise<ElicitationRecord> {
  return insertElicitation(p, true, exec);
}

async function insertElicitation(
  p: CreateElicitationParams,
  protocolNative: boolean,
  exec: Executor,
): Promise<ElicitationRecord> {
  // Single-pending-elicitation invariant. The LLM must never see two
  // open `ask_user_*` forms in the same conversation — that's how
  // session 64861a59 ended up with an orphan `tool_use_id` and a 503.
  // Any prior pending row is cancelled here and its tool_call output
  // back-filled so the persist-replay layer can pair every tool_use
  // with a tool_result.
  const stale = await exec
    .select()
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.conversation_id, p.conversation_id),
        eq(conversationElicitations.status, "pending"),
      ),
    );
  if (stale.length > 0) {
    const staleIds = stale.map((row) => row.id);
    await exec
      .update(conversationElicitations)
      .set({
        status: "cancelled",
        decision_reason: "superseded_by_new_elicitation",
        decided_at: new Date(),
        updated_at: new Date(),
      })
      .where(inArray(conversationElicitations.id, staleIds));
    const staleToolCallIds = stale
      .map((row) => row.tool_call_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (staleToolCallIds.length > 0) {
      await exec
        .update(conversationToolCalls)
        .set({
          output: {
            ok: false,
            abandoned: true,
            reason: "elicitation_superseded",
          } as Record<string, unknown>,
        })
        .where(inArray(conversationToolCalls.id, staleToolCallIds));
    }
  }
  const [inserted] = await exec
    .insert(conversationElicitations)
    .values({
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      tool_call_id: p.tool_call_id,
      ...(p.parent_message_id ? { parent_message_id: p.parent_message_id } : {}),
      tool_name: p.tool_name,
      summary: p.summary,
      input: (p.input ?? {}) as Record<string, unknown>,
      status: "pending",
      protocol_native: protocolNative,
      // Every row is bounded. See `elicitationExpiry` — an unbounded prompt is
      // a conversation wedged in `awaiting_input` forever.
      expires_at: p.expires_at ?? elicitationExpiry(p.input, new Date()),
    })
    .returning();
  assertInsertRow(inserted, "elicitation");
  await exec
    .update(conversations)
    .set({ status: "awaiting_input", updated_at: new Date() })
    .where(eq(conversations.id, p.conversation_id));
  // Forensic log: elicitation row landed in DB and conversation
  // moved to awaiting_input. Pre-fix the dca36b29 silent failure
  // looked like "policy.gate_paused fired but the user never saw a
  // prompt" — without this row we couldn't tell whether the
  // elicitation actually persisted or whether the SSE emit dropped
  // before the wire. Carries the input.kind so an operator can
  // reason about which approval path the row belongs to without
  // dereferencing the JSONB column.
  const inputKind =
    p.input && typeof p.input === "object" && p.input !== null
      ? ((p.input as { kind?: unknown }).kind ?? null)
      : null;
  const intentKind =
    p.input && typeof p.input === "object" && p.input !== null
      ? (((p.input as { commit_intent?: { kind?: unknown } }).commit_intent?.kind ?? null) as
          | string
          | null)
      : null;
  logger.info({
    module: "conversation",
    action: "elicitation.created",
    msg: "elicitation persisted; conversation transitioned to awaiting_input",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    elicitation_id: inserted.id,
    tool_name: p.tool_name,
    ...(p.tool_call_id ? { tool_call_id: p.tool_call_id } : {}),
    ...(typeof inputKind === "string" ? { input_kind: inputKind } : {}),
    ...(typeof intentKind === "string" ? { commit_intent_kind: intentKind } : {}),
  });
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: "system",
      actor_id: p.actor_id,
      action: AuditAction.APPROVAL_REQUESTED,
      resource_type: "conversation_elicitation",
      resource_id: inserted.id,
      result: "success",
      metadata: {
        tool_name: p.tool_name,
        summary: p.summary,
        conversation_id: p.conversation_id,
      },
    },
    exec,
  );
  return rowToRecord(inserted);
}

/**
 * Demote an elicitation row from protocol-native to portal-backed.
 *
 * Used when a bridge-path elicitation (opened via `createNativeElicitation`,
 * so `protocol_native: true`) degrades mid-call to the DB-pause +
 * `respondElicitation` path because the MCP `elicitation` capability
 * raced away. The row will now be satisfied by a portal POST, so its
 * `protocol_native` flag must flip to `false` — otherwise
 * `resolveElicitation`'s `surface` audit metadata would mislabel a
 * portal resolution as `mcp_elicitation`.
 *
 * Tenant-scoped and pending-scoped: a row already resolved (e.g. a
 * concurrent `respondElicitation` won the race) is left untouched.
 */
export async function demoteElicitationToPortal(
  tenant_id: string,
  id: string,
  exec: Executor,
): Promise<void> {
  const [demoted] = await exec
    .update(conversationElicitations)
    .set({ protocol_native: false, updated_at: new Date() })
    .where(
      and(
        eq(conversationElicitations.tenant_id, tenant_id),
        eq(conversationElicitations.id, id),
        eq(conversationElicitations.status, "pending"),
      ),
    )
    .returning();
  // The pending-scoped UPDATE missed — a concurrent `respondElicitation`
  // already resolved the row. Nothing changed, so nothing to audit.
  if (!demoted) return;
  // Forensic trace: the carrier row was minted as `mcp_elicitation`
  // (`protocol_native: true`) and has now become `portal`. Without this
  // row an audit reader sees only the final `surface: portal` on the
  // resolve row and cannot tell the elicitation ever attempted the MCP
  // bridge.
  await auditAwait(
    {
      tenant_id,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.ELICITATION_DEMOTED_TO_PORTAL,
      resource_type: "conversation_elicitation",
      resource_id: demoted.id,
      result: "success",
      metadata: {
        conversation_id: demoted.conversation_id,
        tool_name: demoted.tool_name,
      },
    },
    exec,
  );
}

export async function getElicitation(
  tenant_id: string,
  id: string,
  exec: Executor,
): Promise<ElicitationRecord | null> {
  const rows = await exec
    .select()
    .from(conversationElicitations)
    .where(
      and(eq(conversationElicitations.tenant_id, tenant_id), eq(conversationElicitations.id, id)),
    )
    .limit(1);
  const row = rows[0];
  return row ? rowToRecord(row) : null;
}

/**
 * Lookup the active (pending) elicitation tied to a tool_call. Keyed by
 * the originating tool_call_id — clients that
 * tracked it can resolve the elicitation
 * without first reading the elicitation_id from the SSE stream.
 *
 * Returns the most recent matching row when multiple elicitations
 * exist for the same tool_call (e.g. policy gate + LLM-emitted prompt
 * during the same turn), preferring `pending` status.
 */
export async function getPendingElicitationByToolCall(
  tenant_id: string,
  conversation_id: string,
  tool_call_id: string,
  exec: Executor,
): Promise<ElicitationRecord | null> {
  const rows = await exec
    .select()
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, tenant_id),
        eq(conversationElicitations.conversation_id, conversation_id),
        eq(conversationElicitations.tool_call_id, tool_call_id),
      ),
    )
    .orderBy(desc(conversationElicitations.created_at));
  if (rows.length === 0) return null;
  const pending = rows.find((r) => r.status === "pending");
  const row = pending ?? rows[0];
  return row ? rowToRecord(row) : null;
}

export async function listElicitationsForConversation(
  tenant_id: string,
  conversation_id: string,
  exec: Executor,
): Promise<ElicitationRecord[]> {
  const rows = await exec
    .select()
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, tenant_id),
        eq(conversationElicitations.conversation_id, conversation_id),
      ),
    )
    .orderBy(desc(conversationElicitations.created_at));
  return rows.map(rowToRecord);
}

/**
 * Back-fill `parent_message_id` on elicitation rows created during a
 * step before the step's assistant message existed. Called by the loop
 * after it inserts the assistant message in `onStepFinish`.
 */
export async function setElicitationParentMessage(
  exec: Executor,
  ids: string[],
  parent_message_id: string,
): Promise<void> {
  if (ids.length === 0) return;
  await exec
    .update(conversationElicitations)
    .set({ parent_message_id })
    .where(inArray(conversationElicitations.id, ids));
}

/** Outcome of staging a `respond_elicitation` answer (see below). */
export type StageElicitationAnswerResult =
  | { kind: "not_found" }
  | { kind: "already_resolved"; existing: ElicitationRecord }
  | { kind: "staged" };

/**
 * Persist a `respond_elicitation` answer onto the elicitation row's
 * `output` column WITHOUT resolving it (status stays `pending`). This
 * is the MCP async-Tasks pre-enqueue step: the answer — an
 * `ask_user_form` payload can exceed pg-boss' 8 KB envelope cap — must
 * land in the DB before the tiny `conversation.run-turn` job is sent,
 * so the worker reads it back by `elicitation_id` and the envelope
 * carries only ids. The row stays `pending` so the worker's
 * `respondElicitation` still drives the real resolve + loop resume.
 *
 * Scoped by (tenant, conversation, id): a foreign tenant or a
 * mismatched conversation can never stage an answer onto another's
 * elicitation.
 */
export async function stageElicitationAnswer(
  p: { tenant_id: string; conversation_id: string; id: string; output: unknown },
  exec: Executor,
): Promise<StageElicitationAnswerResult> {
  const [row] = await exec
    .update(conversationElicitations)
    .set({ output: (p.output ?? null) as Record<string, unknown> | null, updated_at: new Date() })
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.conversation_id, p.conversation_id),
        eq(conversationElicitations.id, p.id),
        eq(conversationElicitations.status, "pending"),
      ),
    )
    .returning();
  if (row) return { kind: "staged" };
  // The conditional update missed — either no such row, or it is no
  // longer pending. Read it back to tell the caller which.
  const existing = await getElicitation(p.tenant_id, p.id, exec);
  if (!existing || existing.conversation_id !== p.conversation_id) return { kind: "not_found" };
  return { kind: "already_resolved", existing };
}

/**
 * Outcome of attempting to resolve an elicitation. The caller distinguishes
 * three cases:
 *   - `not_found`  → no row matches the (tenant, id) pair
 *   - `already_resolved` → the row exists but is no longer pending; carries
 *     the prior record so the route can return its decision details to the
 *     client without a second query
 *   - `resolved` → the transition fired; carries the updated record
 *
 * Without this discrimination a duplicate `/respond` POST silently
 * re-runs the conversation loop, double-charges the LLM, and confuses
 * the UI — see the silent-hang transcript in session 79bf2cca.
 */
export type ResolveElicitationResult =
  | { kind: "not_found" }
  | { kind: "already_resolved"; existing: ElicitationRecord }
  | { kind: "resolved"; record: ElicitationRecord };

/**
 * Outcome of the bridge round-trip that delivered a `protocol_native`
 * elicitation. Recorded on the resolve audit row so an operator can tell
 * a clean MCP `elicitation/create` round-trip apart from one that fell
 * through to a transport-failure resolution. Omitted entirely for
 * non-bridge (portal) resolutions — the key only appears when known.
 */
export type ElicitationTransportOutcome = "succeeded" | "failed";

/**
 * Which channel satisfied an elicitation row — emitted as the `surface`
 * audit metadata on the resolve row. `mcp_elicitation` is an in-process
 * MCP `elicitation/create` round-trip; `portal` is a DB-pause satisfied
 * by a portal POST to `/respond`. Derived from the carrier row's
 * `protocol_native` flag, never from a caller argument. Naming this as a
 * union (rather than a stringified literal) makes a typo in a future
 * emitter a compile error.
 */
export type ElicitationSurface = "mcp_elicitation" | "portal";

/**
 * The `metadata` shape of an `APPROVAL_APPROVED` / `APPROVAL_REJECTED`
 * elicitation-resolve audit row. Pinning it as a named type makes the
 * tri-state discriminators (`surface`, `elicitation_transport`) typed at
 * the producer so a misspelled key is caught at compile time. The
 * `[k: string]: unknown` index signature keeps it assignable to the
 * audit layer's `Record<string, unknown>` `metadata` column without
 * losing the typo-protection on the named keys. The on-the-wire / in-DB
 * JSONB shape is unchanged.
 */
export interface ElicitationResolveAuditMetadata {
  conversation_id: string;
  tool_name: string;
  surface: ElicitationSurface;
  elicitation_transport?: ElicitationTransportOutcome;
  [k: string]: unknown;
}

export async function resolveElicitation(
  p: {
    tenant_id: string;
    id: string;
    output: unknown;
    decided_by: string | null;
    /** Persisted verbatim to `decision_reason`. Carries a machine code —
     *  a stable token, not free prose (e.g. `user_declined`,
     *  `user_cancelled`, `oauth_timeout`,
     *  `oauth_authorization_declined`, `approval_expired`). Consumers may
     *  switch on it. */
    reason?: string;
    status?: "resolved" | "cancelled" | "timeout";
    /** Bridge round-trip outcome. Set ONLY by bridge callers on a
     *  `protocol_native` row; emitted as `elicitation_transport` audit
     *  metadata. Non-bridge callers omit it (no key written). */
    transport?: ElicitationTransportOutcome;
  },
  exec: Executor,
): Promise<ResolveElicitationResult> {
  const status: ElicitationStatus = p.status ?? "resolved";
  // #304: the persisted answer must never carry a secret the operator typed
  // into a masked form field, nor let one re-enter LLM context on replay.
  // Read the pending row's definition (tool_name + input, which declares
  // which fields are password/sensitive) and persist a REDACTED projection
  // of the answer. Callers still hand the RAW `p.output` to the in-memory
  // outcome pipeline (credential cache / auto-persist) — only this column
  // is masked. A single PK-scoped read: the conditional UPDATE below only
  // fires for a still-pending row, so a lost race persists nothing.
  const [pendingRow] = await exec
    .select({
      tool_name: conversationElicitations.tool_name,
      input: conversationElicitations.input,
    })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.id, p.id),
      ),
    )
    .limit(1);
  const persistedOutput = pendingRow
    ? redactElicitationOutput(pendingRow.tool_name, pendingRow.input, p.output ?? null)
    : (p.output ?? null);
  const [row] = await exec
    .update(conversationElicitations)
    .set({
      status,
      output: persistedOutput as Record<string, unknown> | null,
      decided_by: p.decided_by,
      decided_at: new Date(),
      decision_reason: p.reason ?? null,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.id, p.id),
        eq(conversationElicitations.status, "pending"),
      ),
    )
    .returning();
  if (!row) {
    // The conditional update missed: either no such row, or the row is
    // already in a terminal state. Read it back so we can tell the caller
    // which case it is.
    const [existing] = await exec
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, p.tenant_id),
          eq(conversationElicitations.id, p.id),
        ),
      )
      .limit(1);
    if (!existing) return { kind: "not_found" };
    return { kind: "already_resolved", existing: rowToRecord(existing) };
  }
  // Elicitation audit is a TRI-STATE — see docs/developers/tool-palette.md
  // ("Elicitation audit is a tri-state — transport ≠ approval"). Three
  // independent facts land on this row and must not be conflated:
  //   - `action`               = the governance DECISION (APPROVAL_APPROVED
  //                              vs APPROVAL_REJECTED).
  //   - `decision_reason`       = the machine-code token behind a cancel
  //                              (`user_declined`, `oauth_timeout`, …).
  //   - `elicitation_transport`= whether the MCP bridge round-trip
  //                              DELIVERED — `succeeded` can coexist with
  //                              an APPROVAL_REJECTED (a clean round-trip
  //                              whose operator declined).
  const metadata: ElicitationResolveAuditMetadata = {
    conversation_id: row.conversation_id,
    tool_name: row.tool_name,
    // Distinguishes an operator confirming via an MCP
    // `elicitation/create` round-trip from a portal POST to
    // `/respond`. Derived from the carrier row, not the caller.
    surface: row.protocol_native ? "mcp_elicitation" : "portal",
    // Bridge round-trip outcome — emitted only when the caller knows
    // it (a `protocol_native` row resolved by the bridge path). A
    // portal resolution omits the key entirely.
    ...(p.transport && row.protocol_native ? { elicitation_transport: p.transport } : {}),
  };
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.decided_by ? "user" : "system",
      actor_id: p.decided_by,
      // `timeout` is neither an approval nor a rejection — nobody decided.
      // A distinct action keeps SIEM queries over APPROVAL_REJECTED honest.
      action:
        status === "resolved"
          ? AuditAction.APPROVAL_APPROVED
          : status === "timeout"
            ? AuditAction.ELICITATION_EXPIRED
            : AuditAction.APPROVAL_REJECTED,
      resource_type: "conversation_elicitation",
      resource_id: row.id,
      result: "success",
      reason: p.reason ?? null,
      metadata,
    },
    exec,
  );
  return { kind: "resolved", record: rowToRecord(row) };
}

/**
 * Resolve an elicitation row AND flip the owning conversation back to
 * `active`, as ONE atomic unit.
 *
 * `createElicitation` moves the conversation to `awaiting_input`. If the
 * row resolved but the status flip failed (separate writes, no tx), the
 * loop's pending-elicitation guard would wedge the conversation with no
 * pending row left to resume from. Both writes therefore run inside a
 * single `transaction`.
 *
 * The conversation flip fires ONLY when the resolve actually
 * transitioned (`kind === "resolved"`). A lost race — a concurrent
 * `respondElicitation` resolved the row first — returns
 * `already_resolved`; the winning path already flipped the status, so
 * re-flipping here would be wrong.
 */
export async function resolveElicitationAndReactivate(
  p: {
    tenant_id: string;
    conversation_id: string;
    id: string;
    output: unknown;
    decided_by: string | null;
    reason?: string;
    status?: "resolved" | "cancelled";
    /** Bridge round-trip outcome — see `resolveElicitation`. Bridge
     *  callers pass it; non-bridge callers omit it. */
    transport?: ElicitationTransportOutcome;
  },
  db: Db,
): Promise<ResolveElicitationResult> {
  // Definite assignment: `resolveElicitation` returns a value on every
  // path and the tx callback awaits it before the transaction resolves,
  // so `resolution` is always assigned by the time control returns here.
  let resolution!: ResolveElicitationResult;
  await db.transaction(async (tx) => {
    resolution = await resolveElicitation(
      {
        tenant_id: p.tenant_id,
        id: p.id,
        output: p.output,
        decided_by: p.decided_by,
        ...(p.reason ? { reason: p.reason } : {}),
        ...(p.status ? { status: p.status } : {}),
        ...(p.transport ? { transport: p.transport } : {}),
      },
      tx,
    );
    if (resolution.kind === "resolved") {
      await tx
        .update(conversations)
        .set({ status: "active", updated_at: new Date() })
        .where(
          and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)),
        );
    }
  });
  return resolution;
}

/**
 * Expire a time-bounded elicitation whose capability died unanswered, and
 * un-strand its conversation — ONE transaction.
 *
 * Deliberately a SIBLING of `resolveElicitationAndReactivate`, not an
 * option on it: a resume path owns the conversation and flips it back to
 * `active` unconditionally, while an expiry sweep owns nothing — it may
 * only undo the `awaiting_input` the elicitation itself caused, and must
 * never resurrect a conversation that has since committed or been
 * abandoned. Hence the guarded flip below.
 *
 * Three writes:
 *   1. Resolve the elicitation to `timeout` with its machine-code expiry
 *      reason and no decider — nobody answered, so no human is named. The CAS on
 *      `status = 'pending'` inside `resolveElicitation` makes a race with
 *      a concurrent `respondElicitation` safe: the loser observes
 *      `already_resolved` and writes nothing else.
 *   2. GUARDED conversation flip `awaiting_input → active`.
 *   3. Back-fill the paused tool call's `output`. WHY: the CALL is
 *      abandoned, not the session — the user continues via
 *      `conversation_append`, and the persist-replay layer must pair
 *      every tool_use with a tool_result, so the backfill tells the
 *      model exactly what happened and what to do next. Mirrors the
 *      stale-supersede backfill in `insertElicitation`.
 */
export type ElicitationExpiryReason =
  | "approval_expired"
  | "approval_abandoned"
  | "credential_setup_expired"
  | "prompt_expired";

/** What the model is told when its paused call is abandoned. Keyed by reason so
 *  the note names the capability that actually lapsed — and, for
 *  `approval_abandoned`, does not accuse the operator of ignoring a prompt they
 *  actually answered. */
const EXPIRY_NOTES: Readonly<Record<ElicitationExpiryReason, string>> = {
  approval_expired:
    "the operator did not answer the confirmation within the approval window; nothing ran. Ask the user whether they still want this action, and re-issue the tool call if so.",
  approval_abandoned:
    "the operator DID approve this, but the approval could not be carried out before it expired, so nothing ran. Tell the user their approval was received and arrived too late to execute, and re-issue the tool call if they still want it.",
  credential_setup_expired:
    "the secure credential setup link expired before the operator submitted it; no credential was stored. Ask whether they want a fresh credential prompt and re-issue the tool call if so.",
  prompt_expired:
    "the question went unanswered long enough to expire; nothing ran. Ask it again if the answer is still needed.",
};

export async function expireElicitationAndReactivate(
  p: {
    tenant_id: string;
    conversation_id: string;
    id: string;
    reason?: ElicitationExpiryReason;
  },
  db: Db,
): Promise<ResolveElicitationResult> {
  const reason = p.reason ?? "approval_expired";
  // Definite assignment — same reasoning as `resolveElicitationAndReactivate`.
  let resolution!: ResolveElicitationResult;
  await db.transaction(async (tx) => {
    resolution = await resolveElicitation(
      {
        tenant_id: p.tenant_id,
        id: p.id,
        output: null,
        decided_by: null,
        reason,
        status: "timeout",
      },
      tx,
    );
    if (resolution.kind !== "resolved") return;
    await tx
      .update(conversations)
      .set({ status: "active", updated_at: new Date() })
      .where(
        and(
          eq(conversations.tenant_id, p.tenant_id),
          eq(conversations.id, p.conversation_id),
          eq(conversations.status, "awaiting_input"),
        ),
      );
    const toolCallId = resolution.record.tool_call_id;
    if (toolCallId) {
      await tx
        .update(conversationToolCalls)
        .set({
          output: {
            ok: false,
            abandoned: true,
            reason,
            note: EXPIRY_NOTES[reason],
          } as Record<string, unknown>,
        })
        .where(eq(conversationToolCalls.id, toolCallId));
    }
  });
  return resolution;
}
