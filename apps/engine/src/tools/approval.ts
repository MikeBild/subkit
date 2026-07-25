// Tool approvals — the durable half of the confirm-before-execution gate.
//
// AN APPROVAL IS GRANTED BY A HUMAN, NEVER BY A MODEL. `requestApproval`
// mints the row UNGRANTED. `grantApproval` — reachable only from a human
// channel (the approval portal, or a client that actually fulfilled an in-band
// elicitation prompt) — flips `granted_at`. `consumeApproval` claims only a
// GRANTED, undeclined, unexpired, unconsumed row.
//
// This is not a refinement of the old contract; it replaces its premise.
// Production told us that inline MCP prompts were lost after backgrounding.
// Conversation tasks now persist and reattach them to a live poll session;
// only that fulfilled server→client request is human in-band provenance.
// `confirm_tool_call`, which the MODEL calls, remains a trigger, never a gate.
// It cannot approve anything, so it needs no capability-based refusal — every
// client may call it, and it succeeds only if a human already said yes.
//
// An approval is a CAPABILITY HANDLE, not a re-transmission challenge.
// `requestApproval` persists the exact args the gate paused on (encrypted,
// AAD-bound to `tenant_id:approval_id`) alongside the APPROVAL_REQUESTED
// audit row. `consumeApproval` claims that handle with one atomic CAS and
// hands the decrypted args back so the caller REPLAYS them.
//
// Two properties fall out of that:
//   - The args stop being model-choosable at approve time. A confirmation
//     carries an id and nothing else; there is no payload to swap.
//   - A large payload is approvable. The prior contract demanded the model
//     re-emit the full args byte-exactly, which a ~50 KB markdown body can
//     never satisfy.
//
// WHAT THE HANDLE BINDS: `(tenant_id, principal_id, tool, surface)` in the
// CAS, plus `execution_mode` verified against the stored row. Inside one
// tenant, principal A cannot consume principal B's approval; a chat-minted
// approval is not claimable over MCP; and a preview taken in `dev` cannot be
// confirmed into `prod`.
//
// It does NOT bind an execution target beyond the tool name. Where the tool name
// IS the target (`wf_<slug>`), the caller derives the target from
// `ClaimedApproval.tool` — never from a field its caller supplied alongside the
// id, which would let one approval release a different workflow.
//
// CLAIM ≠ APPROVAL. `consumeApproval` burns the single-use handle, but it does
// NOT write APPROVAL_APPROVED. Authorization is logically prior to "this call
// was approved": the caller runs RBAC + policy on the replayed args first and
// only then calls `recordApprovalApproved`. Otherwise an RBAC grant revoked
// between the human's approval and the claim produces an APPROVAL_APPROVED row
// for a call that never ran.
//
// THE APPROVAL LAYER WRITES AN AUDIT ROW IFF THE CALL CHANGED STATE. A claim
// that burns the handle writes one: APPROVAL_APPROVED once the caller has
// authorized it, or APPROVAL_REJECTED when the burn itself was the denial
// (`confirmation_integrity_failed`, `confirmation_environment_mismatch` — both
// commit the burn deliberately, so a tampered or environment-swapped handle is
// not retryable). A claim that succeeds and then cannot execute — the workflow
// was renamed between preview and approval, the tool is not available on the
// claiming surface — writes `recordApprovalUnfulfilled` or an
// approval-anchored POLICY_DENIED.
//
// A claim that changes NOTHING writes nothing. It lost the CAS: the handle is
// unspent, the row is exactly as it was, and there is no governance event to
// record. Auditing those let a model loop `confirm_tool_call` on one real,
// already-burned id and mint an APPROVAL_REJECTED row per attempt for the ~24h
// the row lives. Those denials are structured log lines at the calling surface
// instead — see `AUDITABLE_DENIAL_CODES` and `logNonMutatingClaim`.
//
// The two rows a HUMAN's decision writes (APPROVAL_GRANTED / APPROVAL_DECLINED)
// do not follow that rule, and must not: they are authenticated, human-paced,
// and not model-loopable, so every outcome against a real approval is recorded
// — including a refused one, which tells an auditor an operator tried to
// approve something that had already expired.
//
// The persisted args may carry secrets an operator typed into a form.
// Ciphertext at rest is neither a log line nor prose, so `SECRET_PATTERNS`
// redaction does NOT apply to it — redacting instead of encrypting would
// make the replay execute a redaction placeholder. Never log it, never
// render it, never place it in LLM context.

import { createHash } from "node:crypto";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { decryptSecret, encryptSecret } from "../crypto/aes-gcm.ts";
import type { Db, Executor } from "../db/client.ts";
import { toolApprovals } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import {
  type ApprovalPreview,
  buildApprovalPreview,
  encryptApprovalPreview,
  mintApprovalGrantUrl,
} from "./approval-portal.ts";
import { ARGS_CONFIRM_ID_KEY, ARGS_CONFIRM_KEY } from "./policy.ts";
import type { ConfirmReason, ToolSurface } from "./types.ts";

/** How long an approval lives, from mint to claim. It must cover the WHOLE
 *  out-of-band round trip now: the human opening the portal link, reading what
 *  will be written, deciding, and the model claiming afterwards. Short enough
 *  that a leaked confirm_id is not a standing capability.
 *
 *  ONE CLOCK: `expires_at` is written as `now() + interval` evaluated by
 *  Postgres, and the CAS compares it against Postgres' `now()`. The app
 *  clock (`utils/clock.now()`) never participates — mixing the two made the
 *  TTL depend on host clock skew between the engine and the database. */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;

/** How long the harness has to CLAIM an approval after a human granted it.
 *
 *  `APPROVAL_TTL_MS` above bounds the human's deliberation, measured from mint.
 *  It used to bound the claim too, which made the claim window whatever the
 *  person happened to leave over — a decision at mint+14:59 left one second, and
 *  `consumeApproval` refuses on `expires_at > now()`. `decideApproval` therefore
 *  re-stamps `expires_at` on grant, and this is that window.
 *
 *  Generous enough to survive a queue backlog or an engine restart between the
 *  grant and the resumed turn, short enough that a granted-but-unclaimed
 *  capability does not linger. */
export const APPROVAL_CLAIM_WINDOW_MS = 10 * 60 * 1000;

/** Which call path opened or claimed the approval. Wider than `ToolSurface`:
 *  the conversation fast-path shares the `chat` surface but is its own
 *  attribution bucket in the audit log. */
export type ApprovalVia = "mcp" | "chat" | "fast_path";

/** Ambient execution environment of the approved call, for the surfaces that
 *  carry one out-of-band. */
export type ApprovalExecutionMode = "dev" | "prod";

/** The human channel a grant travelled through. `portal` is the one every
 *  client can reach; the other two are optimizations for surfaces that put a
 *  human inside the call. */
export type ApprovalGrantVia = "portal" | "in_band_elicitation" | "chat";

/**
 * Who to record as the human on a decision a surface relayed from inside the
 * call. A user principal answered the prompt themselves; a system account only
 * carried an answer across the wire, and naming it as the approver would put a
 * decision in a machine's mouth. `grantApproval` / `declineApproval` write
 * `actor_type: "system"` for the null case.
 */
export function approvalDecidingUserId(principal: ResolvedPrincipal): string | null {
  return principal.kind === "user" ? principal.id : null;
}

/** Rejection reasons `consumeApproval` can return. Every one of them is
 *  terminal for that confirm_id — the caller re-issues the original call to
 *  obtain a fresh one — with ONE exception: `approval_not_granted` says the
 *  handle is still alive and waiting on a human, so the same id is claimable
 *  once they grant it. */
export type ApprovalDenialCode =
  | "confirmation_missing_id"
  | "unknown_confirmation"
  | "confirmation_tool_mismatch"
  | "confirmation_surface_mismatch"
  | "confirmation_environment_mismatch"
  | "confirmation_already_used"
  | "confirmation_expired"
  | "confirmation_integrity_failed"
  | "confirmation_claim_failed"
  | "approval_not_granted"
  | "approval_declined";

export interface ClaimedApproval {
  readonly ok: true;
  readonly approval_id: string;
  readonly args: Record<string, unknown>;
  /** The tool the approval was GRANTED for, read back off the claimed row. Equal
   *  to the `tool` the claim passed — the CAS predicate says so — but callers
   *  that derive an EXECUTION TARGET from the tool name must read it from here.
   *  Deriving it from anything the caller (or a model) supplied would let the
   *  handle release a call the operator never previewed. */
  readonly tool: string;
  /** The surface the approval was GRANTED on — the claim matched it. */
  readonly surface: ToolSurface;
  /** The environment the previewed call ran in, or null when its surface has
   *  no ambient environment. The replay executes in THIS environment. */
  readonly execution_mode: ApprovalExecutionMode | null;
}

export type ApprovalDenial = {
  readonly ok: false;
  readonly code: ApprovalDenialCode;
  readonly message: string;
};

export type ConsumeApprovalResult = ClaimedApproval | ApprovalDenial;

// Deterministic JSON: object keys sorted recursively so an arg fingerprint
// is stable across key ordering and whitespace. Arrays keep their order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Drop the confirm control markers a re-issue injects, leaving the domain
 *  args. Persisted plaintext and fingerprint both use this canonical form so
 *  a replay never re-feeds the markers back into the executor. Exported for
 *  the surfaces that persist a tool-call row before the approval exists (the
 *  synthetic chat palettes) — they must record the domain args, not the
 *  markers. */
export function stripConfirmMarkers(args: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = { ...args };
  delete stripped[ARGS_CONFIRM_KEY];
  delete stripped[ARGS_CONFIRM_ID_KEY];
  return stripped;
}

/**
 * Fingerprint of a tool call's args, invariant to the confirm control markers
 * the model adds on the re-issue. Written to `metadata.args_hash` on the
 * APPROVAL_REQUESTED audit row (operator queries depend on that key) and to
 * `tool_approvals.args_hash`, where it is re-checked after decrypt as an
 * integrity check on the row at rest.
 */
export function hashToolArgs(args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(stableStringify(stripConfirmMarkers(args)))
    .digest("hex");
}

function aadFor(tenant_id: string, approval_id: string): string {
  return `${tenant_id}:${approval_id}`;
}

function actorTypeOf(principal: ResolvedPrincipal): "user" | "system_account" {
  return principal.kind === "user" ? "user" : "system_account";
}

function resourceTypeOf(surface: string): string {
  return surface === "mcp" ? "mcp_tool_call" : "conversation_tool_call";
}

/** The resource coordinates every row in an approval's lifecycle shares, so
 *  APPROVAL_REQUESTED, APPROVAL_APPROVED, and any post-claim POLICY_DENIED
 *  join on `(resource_type, resource_id)`. */
export interface ApprovalAuditResource {
  readonly approval_id: string;
  readonly resource_type: string;
}

export function approvalAuditResource(claim: ClaimedApproval): ApprovalAuditResource {
  return { approval_id: claim.approval_id, resource_type: resourceTypeOf(claim.surface) };
}

// `approval_id` reaches us straight off a model-suppliable field. It is
// compared against a `uuid` column, so a non-uuid string would abort the
// statement instead of resolving to "no such approval".
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lifecycle metadata every approval audit row carries. `tool` and
 *  `canonical_tool` hold the same bare name today; `canonical_tool` is the
 *  stable column operator queries `GROUP BY` regardless of surface, and `via`
 *  is the attribution bucket (`fast_path` is not a `surface`). */
function lifecycleMetadata(p: {
  tool: string;
  via: ApprovalVia;
  surface: ToolSurface;
  execution_mode?: ApprovalExecutionMode | null;
}): Record<string, unknown> {
  return {
    tool: p.tool,
    canonical_tool: p.tool,
    via: p.via,
    request_source: p.surface,
    ...(p.execution_mode ? { execution_mode: p.execution_mode } : {}),
  };
}

export interface RequestApprovalInput {
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
  /** The `tool_call_id` the policy gate minted; becomes `tool_approvals.id`
   *  and the `resource_id` of every audit row in the lifecycle. */
  readonly approval_id: string;
  readonly tool: string;
  readonly surface: ToolSurface;
  readonly via: ApprovalVia;
  /** WHY the call paused — the `ToolModeRule` the confirm gate enforced, or
   *  `held_writes` when the run itself held its writes. Recorded verbatim on
   *  APPROVAL_REQUESTED so the audit trail can never describe a decision that
   *  was not the one enforced. Callers pass the envelope's `reason`; they do
   *  not re-derive it. */
  readonly reason: ConfirmReason;
  /** Ambient execution environment of the call being approved, or null when
   *  the surface has none. */
  readonly execution_mode: ApprovalExecutionMode | null;
  readonly args: Record<string, unknown>;
  /** What the human will be shown. The held-writes warning's `details`, whose
   *  `would_write` list is the exact set of requests the preview resolved and
   *  did not dispatch. Absent for gates that hold no writes. */
  readonly preview?: { readonly would_write?: unknown } | undefined;
}

export interface RequestedApproval {
  /** Where a HUMAN goes to grant or decline. Null when the engine has no
   *  configured `server.public_base_url` — the caller must say so rather than
   *  invent a host the operator cannot open. */
  readonly approval_url: string | null;
}

/**
 * Open an approval, UNGRANTED: persist the args the gate paused on, persist the
 * write preview a human needs to decide, mint the one-shot portal link, and
 * record APPROVAL_REQUESTED. All four land in one transaction — a handle
 * without its audit row, an audit row whose handle cannot be claimed, and a
 * handle no human can reach are each a governance gap.
 *
 * The row is not claimable when this returns. `granted_at` is NULL and only
 * `grantApproval` can set it. Callers hand the id back to the client as
 * `confirm_id` and hand `approval_url` to the human.
 */
export async function requestApproval(input: RequestApprovalInput): Promise<RequestedApproval> {
  const { db, principal, approval_id, tool, surface, via, execution_mode, reason } = input;
  const args = stripConfirmMarkers(input.args);
  const args_hash = hashToolArgs(args);
  const enc = encryptSecret(JSON.stringify(args), aadFor(principal.tenant_id, approval_id));
  const preview: ApprovalPreview | null = buildApprovalPreview(input.preview);
  const encPreview = preview
    ? encryptApprovalPreview(principal.tenant_id, approval_id, preview)
    : null;

  return await db.transaction(async (tx) => {
    await tx.insert(toolApprovals).values({
      id: approval_id,
      tenant_id: principal.tenant_id,
      principal_id: principal.id,
      tool,
      surface,
      execution_mode,
      args_ciphertext: enc.ciphertext,
      args_iv: enc.iv,
      args_auth_tag: enc.auth_tag,
      args_hash,
      ...(encPreview ?? {}),
      // Postgres' clock, because the CAS compares against Postgres' clock.
      expires_at: sql`now() + make_interval(secs => ${APPROVAL_TTL_MS / 1000})`,
    });

    // Same transaction as the insert: an approval that exists without a link no
    // human can open is a gate nobody can pass, and a link to an approval that
    // was rolled back is a live token for a row that does not exist.
    const minted = await mintApprovalGrantUrl({
      db: tx,
      approval: { id: approval_id, tenant_id: principal.tenant_id },
    });
    if (!minted.ok) {
      logger.warn({
        module: "tools",
        action: "approval.portal_link_unavailable",
        msg: "approval opened without a portal link; no human can grant it out of band",
        approval_id,
        tool,
        surface,
        via,
        tenant_id: principal.tenant_id,
        error_code: minted.error,
      });
    }

    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        // Branch on principal.kind so a user-triggered confirm produces
        // actor_type="user" — matches APPROVAL_APPROVED and lets compliance
        // joins on actor_type stay consistent across the lifecycle.
        actor_type: actorTypeOf(principal),
        actor_id: principal.id,
        action: AuditAction.APPROVAL_REQUESTED,
        resource_type: resourceTypeOf(surface),
        resource_id: approval_id,
        result: "success",
        metadata: {
          ...lifecycleMetadata({ tool, via, surface, execution_mode }),
          policy_mode: "confirm_before_execution",
          // Same key the chat-side `tool_policy.confirmation_required` row
          // uses, so one operator query answers "why did this pause?" across
          // both surfaces.
          resolver_reason: reason,
          // Binds the approval to the exact args it was granted for. Other
          // code and operator queries read this key — keep it.
          args_hash,
          // Answers "was a human ever given a way to approve this?". The token
          // itself is never recorded — only that one was issued.
          portal_link_issued: minted.ok,
          // Answers "what was the human shown?". The list itself is ciphertext.
          preview_write_count: preview?.would_write.length ?? 0,
        },
      },
      tx,
    );

    return { approval_url: minted.ok ? minted.url : null };
  });
}

/** Why a human's grant or decline did not land. Each names a real approval the
 *  human could see but no longer decide on — except `approval_not_found`,
 *  which names none. */
export type ApprovalDecisionDenialCode =
  | "approval_not_found"
  | "approval_already_granted"
  | "approval_already_declined"
  | "approval_already_used"
  | "approval_expired";

export interface ApprovalDecisionOk {
  readonly ok: true;
  readonly approval_id: string;
  /** Read off the decided row, never off the request. */
  readonly tool: string;
  readonly surface: ToolSurface;
}

export type ApprovalDecisionResult =
  | ApprovalDecisionOk
  | { readonly ok: false; readonly code: ApprovalDecisionDenialCode; readonly message: string };

export interface ApprovalDecisionInput {
  readonly db: Db;
  readonly approval_id: string;
  /** Scopes every statement. Read from the human's authenticated session, never
   *  from the URL the model handed them. */
  readonly tenant_id: string;
  /** The human who decided. NULL only when the granting principal is not a user
   *  — a system account relaying an in-band elicitation an operator answered. */
  readonly granted_by_user_id: string | null;
  readonly via: ApprovalGrantVia;
}

/** Metadata on the two rows a human's decision writes. `canonical_tool` and
 *  `request_source` are the same keys the rest of the lifecycle uses, so one
 *  `GROUP BY` spans request → decision → claim. `decided_via` names the human
 *  channel; the audit ACTION already says which way they decided. */
function decisionMetadata(p: {
  tool: string | null;
  surface: string | null;
  via: ApprovalGrantVia;
  decided_by_user_id: string | null;
}): Record<string, unknown> {
  return {
    ...(p.tool ? { tool: p.tool, canonical_tool: p.tool } : {}),
    ...(p.surface ? { request_source: p.surface } : {}),
    decided_via: p.via,
    decided_by_user_id: p.decided_by_user_id,
  };
}

/**
 * A HUMAN grants the approval. This is the only way `granted_at` is ever set,
 * and the only reason a claim can succeed.
 *
 * One CAS: `granted_at IS NULL AND declined_at IS NULL AND consumed_at IS NULL
 * AND expires_at > now()`, tenant-scoped. Two portal tabs racing the same
 * approval grant it once; a second grant, a grant after a decline, and a grant
 * after the handle was already spent all lose.
 *
 * Deliberately NOT scoped on `principal_id`: the principal is the machine that
 * requested the write. The approver is a human, and the whole point of the
 * portal is that they are a different party.
 *
 * Audits APPROVAL_GRANTED on every outcome that named a real approval, with
 * `actor_id` = the human. Not the principal that requested it — an audit row
 * that attributed a human's approval to the model asking for it would describe
 * a decision nobody made.
 */
export async function grantApproval(input: ApprovalDecisionInput): Promise<ApprovalDecisionResult> {
  return await decideApproval(input, "grant");
}

/**
 * A HUMAN declines the approval. Terminal: `declined_at` is never cleared, and
 * the row stays un-claimable until the retention sweep removes it. The model
 * re-issues the original call if it wants to ask again — it cannot re-ask this
 * approval.
 *
 * Symmetric CAS to `grantApproval`, so a granted approval cannot be declined
 * out from under a claim in flight. Audits APPROVAL_DECLINED.
 */
export async function declineApproval(
  input: ApprovalDecisionInput,
): Promise<ApprovalDecisionResult> {
  return await decideApproval(input, "decline");
}

async function decideApproval(
  input: ApprovalDecisionInput,
  decision: "grant" | "decline",
): Promise<ApprovalDecisionResult> {
  const { db, approval_id, tenant_id, granted_by_user_id, via } = input;
  const action =
    decision === "grant" ? AuditAction.APPROVAL_GRANTED : AuditAction.APPROVAL_DECLINED;

  // Same reason `consumeApproval` guards it: the value reaches a `uuid` column
  // and a malformed one aborts the statement instead of missing the row.
  if (!UUID_RE.test(approval_id)) {
    logDecisionMiss({
      approval_id,
      tenant_id,
      granted_by_user_id,
      via,
      decision,
      code: "approval_not_found",
    });
    return notFound(approval_id);
  }

  // The decision and its audit row commit together: a granted approval whose
  // APPROVAL_GRANTED row was lost is a claimable capability nobody can attribute.
  return await db.transaction(async (tx) => {
    const decided = await tx
      .update(toolApprovals)
      .set(
        decision === "grant"
          ? {
              granted_at: sql`now()`,
              granted_by_user_id,
              granted_via: via,
              // A grant OPENS the claim window. `expires_at` was set from mint
              // time, so a human who deliberated for 14 of their 15 minutes left
              // the harness a one-second window to claim in — and the claim CAS
              // requires `expires_at > now()`. Production hit exactly that: a
              // decision at mint+10:34 lapsed at mint+15:00 and the paused
              // conversation was then timed out as "the operator did not
              // answer", the opposite of what they did.
              //
              // The pre-decision window bounds how long a PERSON has to answer;
              // this one bounds how long the machine has to act on the answer.
              // Deliberately short, and unreachable by the model — only this CAS
              // writes it, and only in the same statement that records a human's
              // yes.
              expires_at: sql`now() + make_interval(secs => ${APPROVAL_CLAIM_WINDOW_MS / 1000})`,
            }
          : { declined_at: sql`now()` },
      )
      .where(
        and(
          eq(toolApprovals.id, approval_id),
          eq(toolApprovals.tenant_id, tenant_id),
          isNull(toolApprovals.granted_at),
          isNull(toolApprovals.declined_at),
          isNull(toolApprovals.consumed_at),
          gt(toolApprovals.expires_at, sql`now()`),
        ),
      )
      .returning({ tool: toolApprovals.tool, surface: toolApprovals.surface });

    const row = decided[0];
    if (row) {
      await auditAwait(
        {
          tenant_id,
          // The human, or the system account relaying their in-band answer.
          actor_type: granted_by_user_id ? "user" : "system",
          actor_id: granted_by_user_id,
          action,
          resource_type: resourceTypeOf(row.surface),
          resource_id: approval_id,
          result: "success",
          metadata: decisionMetadata({
            tool: row.tool,
            surface: row.surface,
            via,
            decided_by_user_id: granted_by_user_id,
          }),
        },
        tx,
      );
      return {
        ok: true,
        approval_id,
        tool: row.tool,
        surface: row.surface === "mcp" ? "mcp" : "chat",
      } satisfies ApprovalDecisionOk;
    }

    const miss = await classifyDecisionMiss(tx, tenant_id, approval_id);
    if (miss.code === "approval_not_found") {
      // Nothing to key an audit row on. Same rule as `unknown_confirmation`.
      logDecisionMiss({
        approval_id,
        tenant_id,
        granted_by_user_id,
        via,
        decision,
        code: miss.code,
      });
      return miss.denial;
    }
    await auditAwait(
      {
        tenant_id,
        actor_type: granted_by_user_id ? "user" : "system",
        actor_id: granted_by_user_id,
        action,
        resource_type: resourceTypeOf(miss.surface),
        resource_id: approval_id,
        result: "denied",
        reason: miss.code,
        metadata: decisionMetadata({
          tool: miss.tool,
          surface: miss.surface,
          via,
          decided_by_user_id: granted_by_user_id,
        }),
      },
      tx,
    );
    return miss.denial;
  });
}

function notFound(approval_id: string): ApprovalDecisionResult {
  return {
    ok: false,
    code: "approval_not_found",
    message: `No approval ${approval_id} is pending a decision in this tenant.`,
  };
}

type DecisionMiss =
  | { code: "approval_not_found"; tool: null; surface: null; denial: ApprovalDecisionResult }
  | {
      code: Exclude<ApprovalDecisionDenialCode, "approval_not_found">;
      tool: string;
      surface: string;
      denial: ApprovalDecisionResult;
    };

/** Why the decision CAS matched nothing. Tenant-scoped, like every read here. */
async function classifyDecisionMiss(
  executor: Executor,
  tenant_id: string,
  approval_id: string,
): Promise<DecisionMiss> {
  const rows = await executor
    .select({
      tool: toolApprovals.tool,
      surface: toolApprovals.surface,
      granted: sql<boolean>`${toolApprovals.granted_at} IS NOT NULL`,
      declined: sql<boolean>`${toolApprovals.declined_at} IS NOT NULL`,
      consumed: sql<boolean>`${toolApprovals.consumed_at} IS NOT NULL`,
      expired: sql<boolean>`${toolApprovals.expires_at} <= now()`,
    })
    .from(toolApprovals)
    .where(and(eq(toolApprovals.id, approval_id), eq(toolApprovals.tenant_id, tenant_id)));

  const row = rows[0];
  if (!row)
    return { code: "approval_not_found", tool: null, surface: null, denial: notFound(approval_id) };

  const { tool, surface } = row;
  const deny = (
    code: Exclude<ApprovalDecisionDenialCode, "approval_not_found">,
    message: string,
  ): DecisionMiss => ({ code, tool, surface, denial: { ok: false, code, message } });

  // A spent handle is the strongest fact: it was granted AND executed.
  if (row.consumed) {
    return deny(
      "approval_already_used",
      `Approval ${approval_id} was already used and cannot be decided on again.`,
    );
  }
  if (row.declined) {
    return deny(
      "approval_already_declined",
      `Approval ${approval_id} was already declined. Declining is terminal.`,
    );
  }
  if (row.granted) {
    return deny(
      "approval_already_granted",
      `Approval ${approval_id} was already granted and is waiting to be claimed.`,
    );
  }
  return deny(
    "approval_expired",
    `Approval ${approval_id} expired before anyone decided on it. Re-issue the original call to obtain a fresh one.`,
  );
}

/** A human's decision that named no approval this tenant holds. Nothing changed,
 *  so no audit row — but it is worth seeing, because a portal link that 404s is
 *  either a stale bookmark or a probe. */
function logDecisionMiss(p: {
  approval_id: string;
  tenant_id: string;
  granted_by_user_id: string | null;
  via: ApprovalGrantVia;
  decision: "grant" | "decline";
  code: ApprovalDecisionDenialCode;
}): void {
  logger.warn({
    module: "tools",
    action: "approval.decision_miss",
    msg: "a human decision named no approval this tenant holds; nothing changed and no approval row was written",
    approval_id: p.approval_id,
    tenant_id: p.tenant_id,
    user_id: p.granted_by_user_id,
    decided_via: p.via,
    decision: p.decision,
    error_code: p.code,
  });
}

export interface RecordApprovalApprovedInput {
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
  readonly claim: ClaimedApproval;
  readonly tool: string;
  readonly via: ApprovalVia;
}

/**
 * Record APPROVAL_APPROVED — the row that says "this call was authorized and
 * is about to run". Callers emit it AFTER RBAC, policy, and canonicalization
 * have all passed, immediately before handing the replayed args to the
 * executor.
 *
 * Returns false when the audit row could not be persisted. The caller must
 * then NOT execute: an unaudited approved write is exactly the governance gap
 * the audit log exists to close. The handle is already burned, so the honest
 * recovery is for the operator to re-issue the original call.
 */
export async function recordApprovalApproved(p: RecordApprovalApprovedInput): Promise<boolean> {
  const { db, principal, claim, tool, via } = p;
  try {
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: actorTypeOf(principal),
        actor_id: principal.id,
        action: AuditAction.APPROVAL_APPROVED,
        // Same resource_id AND resource_type as the APPROVAL_REQUESTED row —
        // `resource_type` comes off the stored surface, not the claiming call,
        // so compliance tooling can join the two rows into one lifecycle.
        resource_type: resourceTypeOf(claim.surface),
        resource_id: claim.approval_id,
        result: "success",
        metadata: lifecycleMetadata({
          tool,
          via,
          surface: claim.surface,
          execution_mode: claim.execution_mode,
        }),
      },
      db,
    );
    return true;
  } catch (err) {
    logger.error({
      module: "tools",
      action: "approval.approved_audit_failed",
      msg: "could not persist APPROVAL_APPROVED; refusing to execute the approved call",
      approval_id: claim.approval_id,
      tool,
      tenant_id: principal.tenant_id,
      principal_id: principal.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export interface RecordApprovalUnfulfilledInput {
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
  readonly claim: ClaimedApproval;
  readonly tool: string;
  readonly via: ApprovalVia;
  /** WHY the claimed call never reached the executor — `workflow_not_found`,
   *  `not_available_on_surface`, … Lands on `audit_log.reason`. */
  readonly reason: string;
}

/**
 * Close out an approval whose handle was burned but whose call never executed
 * and was never denied by RBAC or policy: the target disappeared between the
 * preview and the approval, or the surface withdrew the tool.
 *
 * The audit trail must describe the OUTCOME, not the intent. Without this row
 * the lifecycle reads "approval requested" and then nothing at all, while the
 * single-use handle is spent — indistinguishable, to an auditor, from an
 * approved write whose APPROVAL_APPROVED row was lost.
 *
 * Best-effort by construction: nothing executed, so there is no write to refuse
 * (which is what `recordApprovalApproved` returning false buys). A failed audit
 * write is logged and the caller still returns its terminal envelope.
 */
export async function recordApprovalUnfulfilled(p: RecordApprovalUnfulfilledInput): Promise<void> {
  const { db, principal, claim, tool, via, reason } = p;
  try {
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: actorTypeOf(principal),
        actor_id: principal.id,
        // The approval terminated without approving anything. Same action the
        // claim-time denials use, so one operator query over
        // `(resource_type, resource_id)` reads the whole lifecycle; `reason`
        // separates "the handle was refused" from "the handle was spent on a
        // call that could not run".
        action: AuditAction.APPROVAL_REJECTED,
        resource_type: resourceTypeOf(claim.surface),
        resource_id: claim.approval_id,
        result: "denied",
        reason,
        metadata: lifecycleMetadata({
          tool,
          via,
          surface: claim.surface,
          execution_mode: claim.execution_mode,
        }),
      },
      db,
    );
  } catch (err) {
    logger.error({
      module: "tools",
      action: "approval.unfulfilled_audit_failed",
      msg: "could not persist the terminal audit row for a burned approval that never executed",
      approval_id: claim.approval_id,
      tool,
      reason,
      tenant_id: principal.tenant_id,
      principal_id: principal.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface ConsumeApprovalInput {
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
  /** The `confirm_id` the caller carried back, or null when it carried none. */
  readonly approval_id: string | null;
  readonly tool: string;
  /** The surface the CLAIM arrives on. Part of the CAS predicate. */
  readonly surface: ToolSurface;
  /** Attribution bucket for the denial audit rows this call may write. */
  readonly via: ApprovalVia;
  /** The ambient execution environment the CLAIMING call carries, when its
   *  surface has one. It never selects the replay environment — the stored
   *  row does — but a value that contradicts the stored one is rejected
   *  rather than silently ignored. */
  readonly execution_mode?: ApprovalExecutionMode | undefined;
}

/**
 * Claim a GRANTED approval and return the args a human approved.
 *
 * The claim is a single CAS on `(id, tenant_id, principal_id, tool, surface)`
 * with `granted_at IS NOT NULL AND declined_at IS NULL AND consumed_at IS NULL
 * AND expires_at > now()`, so two concurrent confirmations of one id can never
 * both execute — and no confirmation of an ungranted one ever executes. A miss
 * is then classified against the row (scoped to the tenant) to produce an
 * honest reason.
 *
 * An ungranted or declined approval is NOT burned by the claim that finds it:
 * `approval_not_granted` means the human has not answered yet, so the same id
 * must still be claimable when they do; `approval_declined` means they answered
 * no, and burning it would replace an auditable refusal with an expired handle.
 *
 * The decrypted args are the REPLAY payload. The caller executes them; it
 * does not compare them against anything the client sent.
 *
 * Burning the handle and auditing the outcome are ONE transaction: an
 * integrity failure or an environment contradiction is tampering-shaped and
 * must leave a row, and a spent handle with no audit row is a governance gap.
 * The only claims that write APPROVAL_REJECTED are the ones that burned the
 * handle without approving anything — see `AUDITABLE_DENIAL_CODES`. Success
 * burns it too, and its APPROVAL_APPROVED row is the caller's to write once the
 * call is authorized (`recordApprovalApproved`).
 */
export async function consumeApproval(input: ConsumeApprovalInput): Promise<ConsumeApprovalResult> {
  const { db, principal, approval_id, tool, surface, via } = input;
  // Argument validation, not an approval outcome: neither branch names a real
  // approval, neither reaches Postgres, and neither can be a governance event
  // about one. Auditing them would let a model-suppliable garbage string mint
  // `audit_log` rows keyed on nothing. The dispatcher's `tool.dispatch.invoke`
  // event already records the rejection.
  if (approval_id === null) {
    return {
      ok: false,
      code: "confirmation_missing_id",
      message:
        "Confirmed call carried no confirm_id. Re-issue the original call, then approve the returned tool_call_id.",
    };
  }
  if (!UUID_RE.test(approval_id)) {
    logNonMutatingClaim({
      principal,
      approval_id,
      tool,
      surface,
      via,
      code: "unknown_confirmation",
    });
    return unknownConfirmation(approval_id);
  }

  // `approval_id` is narrowed above; re-bind it so `denyClaim` sees a string.
  const claimInput = { ...input, approval_id };

  try {
    return await db.transaction(async (tx) => {
      const claimed = await tx
        .update(toolApprovals)
        .set({ consumed_at: sql`now()` })
        .where(
          and(
            eq(toolApprovals.id, approval_id),
            eq(toolApprovals.tenant_id, principal.tenant_id),
            eq(toolApprovals.principal_id, principal.id),
            eq(toolApprovals.tool, tool),
            eq(toolApprovals.surface, surface),
            // A human said yes, and has not since said no. Without these two
            // predicates the claim IS the approval, and `confirm_tool_call` —
            // which the model calls — would be granting its own writes.
            isNotNull(toolApprovals.granted_at),
            isNull(toolApprovals.declined_at),
            isNull(toolApprovals.consumed_at),
            gt(toolApprovals.expires_at, sql`now()`),
          ),
        )
        .returning({
          tool: toolApprovals.tool,
          surface: toolApprovals.surface,
          execution_mode: toolApprovals.execution_mode,
          args_ciphertext: toolApprovals.args_ciphertext,
          args_iv: toolApprovals.args_iv,
          args_auth_tag: toolApprovals.args_auth_tag,
          args_hash: toolApprovals.args_hash,
        });

      const row = claimed[0];
      if (!row) {
        const miss = await classifyClaimMiss(tx, principal, approval_id, tool, surface);
        return await denyClaim(claimInput, tx, miss);
      }

      let args: Record<string, unknown>;
      try {
        const plaintext = decryptSecret(
          { ciphertext: row.args_ciphertext, iv: row.args_iv, auth_tag: row.args_auth_tag },
          aadFor(principal.tenant_id, approval_id),
        );
        args = JSON.parse(plaintext) as Record<string, unknown>;
      } catch {
        return await denyClaim(claimInput, tx, integrityFailed(approval_id));
      }
      // The row was rewritten between grant and claim. Distinct from the
      // client-side arg swap the old gate rejected — nothing the caller sent
      // participates here, so this can only be tampering at rest.
      if (hashToolArgs(args) !== row.args_hash) {
        return await denyClaim(claimInput, tx, integrityFailed(approval_id));
      }

      const stored = normalizeExecutionMode(row.execution_mode);
      // The confirming call does not get to pick the environment: the operator
      // approved a preview of ONE system. A contradicting `_meta.environment`
      // is a confused (or hostile) client, so it burns the handle rather than
      // letting it be retried against the other environment.
      if (input.execution_mode !== undefined && input.execution_mode !== stored) {
        return await denyClaim(claimInput, tx, environmentMismatch(approval_id, stored));
      }

      return {
        ok: true,
        approval_id,
        args,
        tool: row.tool,
        surface: row.surface === "mcp" ? "mcp" : "chat",
        execution_mode: stored,
      } satisfies ClaimedApproval;
    });
  } catch (err) {
    // The transaction rolled back: the handle is unspent and nothing was
    // audited. Fail closed with a terminal denial rather than let a DB or
    // audit-write fault escape `dispatchTool` (whose try/catch wraps only the
    // executor) as an opaque 500.
    logger.error({
      module: "tools",
      action: "approval.claim_failed",
      msg: "approval claim transaction failed; the confirmation was not consumed",
      approval_id,
      tool,
      surface,
      via,
      tenant_id: principal.tenant_id,
      principal_id: principal.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      code: "confirmation_claim_failed",
      message: `Confirmation ${approval_id} could not be claimed durably; nothing was executed. Re-issue the original call to obtain a fresh confirmation.`,
    };
  }
}

function normalizeExecutionMode(value: string | null): ApprovalExecutionMode | null {
  return value === "dev" || value === "prod" ? value : null;
}

/** Did the claim that produced this denial SPEND the single-use handle?
 *
 *  Exhaustive by type, and the source of one rule: the approval layer writes an
 *  audit row IFF this call changed state, so `AUDITABLE_DENIAL_CODES` is exactly
 *  the `true` column. A model looping `confirm_tool_call` with a REAL,
 *  already-burned id used to mint one APPROVAL_REJECTED row per attempt for the
 *  ~24h the row lived; an audit row is a state change, not a rejection counter.
 *
 *  Only the two burning denials are `true`: their CAS MATCHED, set
 *  `consumed_at`, and the transaction commits anyway, on purpose — a tampered
 *  handle and an environment-swapped one must not be retryable. Everything else
 *  lost the CAS and left the row byte-for-byte as it was. */
const DENIAL_BURNS_HANDLE: Record<ApprovalDenialCode, boolean> = {
  confirmation_missing_id: false,
  unknown_confirmation: false,
  confirmation_tool_mismatch: false,
  confirmation_surface_mismatch: false,
  // Burned by an EARLIER call. This one changed nothing.
  confirmation_already_used: false,
  confirmation_expired: false,
  // The transaction rolled back. The handle is unspent and the retry must work.
  confirmation_claim_failed: false,
  // The human has not answered. The same id must stay claimable for when they do.
  approval_not_granted: false,
  // The human said no. An auditable refusal, not a spent handle.
  approval_declined: false,
  confirmation_environment_mismatch: true,
  confirmation_integrity_failed: true,
};

const AUDITABLE_DENIAL_CODES: ReadonlySet<ApprovalDenialCode> = new Set(
  (Object.keys(DENIAL_BURNS_HANDLE) as ApprovalDenialCode[]).filter(
    (code) => DENIAL_BURNS_HANDLE[code],
  ),
);

/** A claim that changed nothing: it named no approval this principal may claim,
 *  or it named one that is not (yet, or ever) claimable. Not auditable — but a
 *  burst of them is a brute-force probe, so it is visible in the structured log
 *  with the surface it arrived on and the reason it lost. */
function logNonMutatingClaim(p: {
  principal: ResolvedPrincipal;
  approval_id: string;
  tool: string;
  surface: ToolSurface;
  via: ApprovalVia;
  code: ApprovalDenialCode;
}): void {
  logger.warn({
    module: "tools",
    action: "approval.claim_denied",
    msg: "confirmation claimed no approval; nothing was consumed and no approval row was written",
    approval_id: p.approval_id,
    tool: p.tool,
    surface: p.surface,
    via: p.via,
    error_code: p.code,
    principal_id: p.principal.id,
    tenant_id: p.principal.tenant_id,
  });
}

/**
 * Write the APPROVAL_REJECTED row for a claim that BURNED the handle without
 * approving anything, and hand the denial back unchanged. Bound to the claim
 * transaction, so a burned handle and its audit row commit together or not at
 * all.
 *
 * A denial that burned nothing writes no row — the audit log records state
 * changes, not failed attempts to make one.
 */
async function denyClaim(
  input: ConsumeApprovalInput & { approval_id: string },
  executor: Executor,
  denial: ApprovalDenial,
): Promise<ApprovalDenial> {
  const { principal, approval_id, tool, surface, via } = input;
  if (!AUDITABLE_DENIAL_CODES.has(denial.code)) {
    logNonMutatingClaim({ principal, approval_id, tool, surface, via, code: denial.code });
    return denial;
  }
  await auditAwait(
    {
      tenant_id: principal.tenant_id,
      actor_type: actorTypeOf(principal),
      actor_id: principal.id,
      action: AuditAction.APPROVAL_REJECTED,
      // The CLAIMING surface. On a match it equals the stored one; on
      // `confirmation_surface_mismatch` it is deliberately the claimant's, so
      // an operator auditing that surface sees the attempt.
      resource_type: resourceTypeOf(surface),
      // Joins the rejection onto the APPROVAL_REQUESTED row.
      resource_id: approval_id,
      result: "denied",
      reason: denial.code,
      metadata: lifecycleMetadata({ tool, via, surface }),
    },
    executor ?? input.db,
  );
  return denial;
}

function unknownConfirmation(approval_id: string): ApprovalDenial {
  return {
    ok: false,
    code: "unknown_confirmation",
    message: `No pending confirmation matches confirm_id ${approval_id} for this tenant. Re-issue the original call to obtain one.`,
  };
}

function integrityFailed(approval_id: string): ApprovalDenial {
  return {
    ok: false,
    code: "confirmation_integrity_failed",
    message: `Confirmation ${approval_id} could not be verified against the arguments it was granted for. Re-issue the original call to obtain a fresh confirmation.`,
  };
}

function environmentMismatch(
  approval_id: string,
  stored: ApprovalExecutionMode | null,
): ApprovalDenial {
  return {
    ok: false,
    code: "confirmation_environment_mismatch",
    message: `Confirmation ${approval_id} was granted for a preview in ${stored ?? "no"} environment and cannot be confirmed against a different one. Re-issue the original call in the environment you intend to write to.`,
  };
}

/** Turn a lost CAS into the reason the caller deserves. An approval held by
 *  a different principal reads as `unknown_confirmation` — its existence is
 *  not this principal's to learn. */
async function classifyClaimMiss(
  executor: Executor,
  principal: ResolvedPrincipal,
  approval_id: string,
  tool: string,
  surface: ToolSurface,
): Promise<ApprovalDenial> {
  const rows = await executor
    .select({
      principal_id: toolApprovals.principal_id,
      tool: toolApprovals.tool,
      surface: toolApprovals.surface,
      granted: sql<boolean>`${toolApprovals.granted_at} IS NOT NULL`,
      declined: sql<boolean>`${toolApprovals.declined_at} IS NOT NULL`,
      consumed: sql<boolean>`${toolApprovals.consumed_at} IS NOT NULL`,
      expired: sql<boolean>`${toolApprovals.expires_at} <= now()`,
    })
    .from(toolApprovals)
    .where(
      and(eq(toolApprovals.id, approval_id), eq(toolApprovals.tenant_id, principal.tenant_id)),
    );

  const row = rows[0];
  if (!row || row.principal_id !== principal.id) return unknownConfirmation(approval_id);
  if (row.tool !== tool) {
    return {
      ok: false,
      code: "confirmation_tool_mismatch",
      message: `Confirmation ${approval_id} was issued for ${row.tool}, not ${tool}.`,
    };
  }
  if (row.surface !== surface) {
    return {
      ok: false,
      code: "confirmation_surface_mismatch",
      message: `Confirmation ${approval_id} was issued on the ${row.surface} surface and cannot be claimed from ${surface}.`,
    };
  }
  if (row.consumed) {
    return {
      ok: false,
      code: "confirmation_already_used",
      message: `Confirmation ${approval_id} was already used. Re-issue the call to obtain a fresh confirmation.`,
    };
  }
  if (row.expired) {
    return {
      ok: false,
      code: "confirmation_expired",
      message: `Confirmation ${approval_id} expired. Re-issue the call to obtain a fresh confirmation.`,
    };
  }
  // Ordered after `expired` on purpose: `approval_not_granted` is the one code
  // that invites the caller to try the SAME id again, and an expired handle can
  // never be granted. Telling a model to wait for a human on a dead approval
  // would be a loop with no exit.
  if (row.declined) {
    return {
      ok: false,
      code: "approval_declined",
      message: `Approval ${approval_id} was declined by a person. Nothing ran, and this approval cannot be revived. Do not retry it; ask them what to change, then re-issue the original call.`,
    };
  }
  if (!row.granted) {
    // No URL here on purpose: the portal link carries a one-shot token that
    // exists only in the `approval_url` this approval was minted with. Re-deriving
    // one at claim time would let a model mint itself a fresh link on every poll.
    return {
      ok: false,
      code: "approval_not_granted",
      message: `Approval ${approval_id} has not been granted. A person must approve it in the approval portal, using the approval_url this call returned when it was first issued. Nothing ran. Once they approve, this same confirm_id becomes claimable — you cannot approve it yourself.`,
    };
  }
  // CAS lost to a concurrent claim that has since been rolled back, or the
  // row changed under us. Terminal either way; re-issue.
  return unknownConfirmation(approval_id);
}
