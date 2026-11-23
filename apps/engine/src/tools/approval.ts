import { createHash } from "node:crypto";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { decryptSecret, encryptSecret } from "../crypto/index.ts";
import type { Db, Executor } from "../db/client.ts";
import { withTenantScope } from "../db/index.ts";
import { toolApprovals } from "../db/schema/index.ts";
import { authorizationContextFromPrincipal } from "../execution/authorization-context.ts";
import { callerFromPrincipal } from "../execution/caller-context.ts";
import { logger } from "../logging/index.ts";
import { approvalOwnerFilter } from "./approval-owner.ts";
import {
  type ApprovalPreview,
  buildApprovalPreview,
  decryptPreview,
  encryptApprovalPreview,
  mintApprovalGrantUrl,
} from "./approval-portal.ts";
import {
  captureDirectConnectorBinding,
  type DirectConnectorBinding,
  isDirectConnectorTool,
} from "./direct-connector-binding.ts";
import { ARGS_CONFIRM_ID_KEY, ARGS_CONFIRM_KEY } from "./policy.ts";
import {
  capturePreparedWorkflowBinding,
  type PreparedWorkflowBinding,
} from "./prepared-workflow-approval.ts";
import type { ConfirmReason, ToolSurface } from "./types.ts";

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export const APPROVAL_CLAIM_WINDOW_MS = 10 * 60 * 1000;

export type ApprovalVia = "mcp" | "chat" | "fast_path";

export type ApprovalExecutionMode = "dev" | "prod";

export type ApprovalGrantVia = "portal" | "in_band_elicitation" | "chat";

type ApprovalDenialCode =
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
  readonly prepared_workflow?: PreparedWorkflowBinding;
  readonly direct_connector?: DirectConnectorBinding;
  readonly tool: string;
  readonly surface: ToolSurface;
  readonly execution_mode: ApprovalExecutionMode | null;
}

type ApprovalDenial = {
  readonly ok: false;
  readonly code: ApprovalDenialCode;
  readonly message: string;
};

type ConsumeApprovalResult = ClaimedApproval | ApprovalDenial;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function stripConfirmMarkers(args: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = { ...args };
  delete stripped[ARGS_CONFIRM_KEY];
  delete stripped[ARGS_CONFIRM_ID_KEY];
  return stripped;
}

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

export interface ApprovalAuditResource {
  readonly approval_id: string;
  readonly resource_type: string;
}

export function approvalAuditResource(claim: ClaimedApproval): ApprovalAuditResource {
  return { approval_id: claim.approval_id, resource_type: resourceTypeOf(claim.surface) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

interface RequestApprovalInput {
  readonly prepared_execution_id?: string;
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
  readonly approval_id: string;
  readonly tool: string;
  readonly surface: ToolSurface;
  readonly via: ApprovalVia;
  readonly reason: ConfirmReason;
  readonly execution_mode: ApprovalExecutionMode | null;
  readonly args: Record<string, unknown>;
  readonly preview?: { readonly would_write?: unknown } | undefined;
}

interface RequestedApproval {
  readonly approval_url: string | null;
}

export async function requestApproval(input: RequestApprovalInput): Promise<RequestedApproval> {
  const { db, principal, approval_id, tool, surface, via, execution_mode, reason } = input;
  const args = stripConfirmMarkers(input.args);
  const args_hash = hashToolArgs(args);
  const enc = encryptSecret(JSON.stringify(args), aadFor(principal.tenant_id, approval_id));
  const prepared = input.prepared_execution_id
    ? await capturePreparedWorkflowBinding({
        db,
        tenant_id: principal.tenant_id,
        execution_id: input.prepared_execution_id,
        tool,
        execution_mode,
        args,
      })
    : undefined;
  const visiblePreview = buildApprovalPreview(input.preview);
  const direct = isDirectConnectorTool(tool)
    ? await captureDirectConnectorBinding({ db, tenant_id: principal.tenant_id, tool, args })
    : null;
  const preview: ApprovalPreview | null =
    prepared || direct
      ? {
          would_write: visiblePreview?.would_write ?? (direct ? [direct.review] : []),
          ...(prepared ? { prepared_workflow: prepared } : {}),
          ...(direct ? { direct_connector: direct } : {}),
        }
      : visiblePreview;
  const encPreview = preview
    ? encryptApprovalPreview(principal.tenant_id, approval_id, preview)
    : null;

  return await withTenantScope(db, principal.tenant_id, async (tx) => {
    await tx.insert(toolApprovals).values({
      id: approval_id,
      tenant_id: principal.tenant_id,
      principal_id: principal.id,
      caller_context: callerFromPrincipal(principal, principal.tenant_id, principal.product_id),
      authorization_context: authorizationContextFromPrincipal(principal),
      tool,
      surface,
      execution_mode,
      args_ciphertext: enc.ciphertext,
      args_iv: enc.iv,
      args_auth_tag: enc.auth_tag,
      args_hash,
      ...(encPreview ?? {}),
      expires_at: sql`now() + make_interval(secs => ${APPROVAL_TTL_MS / 1000})`,
    });

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
        actor_type: actorTypeOf(principal),
        actor_id: principal.id,
        action: AuditAction.APPROVAL_REQUESTED,
        resource_type: resourceTypeOf(surface),
        resource_id: approval_id,
        result: "success",
        metadata: {
          ...lifecycleMetadata({ tool, via, surface, execution_mode }),
          policy_mode: "confirm_before_execution",
          resolver_reason: reason,
          args_hash,
          portal_link_issued: minted.ok,
          preview_write_count: preview?.would_write.length ?? 0,
          ...(prepared
            ? {
                prepared_execution_id: prepared.execution_id,
                prepared_workflow_version_id: prepared.workflow_version_id,
              }
            : {}),
        },
      },
      tx,
    );

    return { approval_url: minted.ok ? minted.url : null };
  });
}

export type ApprovalDecisionDenialCode =
  | "approval_not_found"
  | "approval_already_granted"
  | "approval_already_declined"
  | "approval_already_used"
  | "approval_expired";

interface ApprovalDecisionOk {
  readonly ok: true;
  readonly approval_id: string;
  readonly tool: string;
  readonly surface: ToolSurface;
}

type ApprovalDecisionResult =
  | ApprovalDecisionOk
  | { readonly ok: false; readonly code: ApprovalDecisionDenialCode; readonly message: string };

interface ApprovalDecisionInput {
  readonly db: Db;
  readonly approval_id: string;
  readonly tenant_id: string;
  readonly granted_by_user_id: string | null;
  readonly via: ApprovalGrantVia;
  readonly origin?: Readonly<Record<string, string>>;
}

function decisionMetadata(p: {
  tool: string | null;
  surface: string | null;
  via: ApprovalGrantVia;
  decided_by_user_id: string | null;
  origin?: Readonly<Record<string, string>> | undefined;
}): Record<string, unknown> {
  return {
    ...(p.origin ?? {}),
    ...(p.tool ? { tool: p.tool, canonical_tool: p.tool } : {}),
    ...(p.surface ? { request_source: p.surface } : {}),
    decided_via: p.via,
    decided_by_user_id: p.decided_by_user_id,
  };
}

export async function grantApproval(input: ApprovalDecisionInput): Promise<ApprovalDecisionResult> {
  return await decideApproval(input, "grant");
}

export async function declineApproval(
  input: ApprovalDecisionInput,
): Promise<ApprovalDecisionResult> {
  return await decideApproval(input, "decline");
}

async function decideApproval(
  input: ApprovalDecisionInput,
  decision: "grant" | "decline",
): Promise<ApprovalDecisionResult> {
  const { db, approval_id, tenant_id, granted_by_user_id, via, origin } = input;
  const action =
    decision === "grant" ? AuditAction.APPROVAL_GRANTED : AuditAction.APPROVAL_DECLINED;

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

  return await withTenantScope(db, tenant_id, async (tx) => {
    const decided = await tx
      .update(toolApprovals)
      .set(
        decision === "grant"
          ? {
              granted_at: sql`now()`,
              granted_by_user_id,
              granted_via: via,
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
            origin,
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
          origin,
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

interface RecordApprovalApprovedInput {
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
  readonly claim: ClaimedApproval;
  readonly tool: string;
  readonly via: ApprovalVia;
}

export async function recordApprovalApproved(p: RecordApprovalApprovedInput): Promise<boolean> {
  const { db, principal, claim, tool, via } = p;
  try {
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: actorTypeOf(principal),
        actor_id: principal.id,
        action: AuditAction.APPROVAL_APPROVED,
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

interface RecordApprovalUnfulfilledInput {
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
  readonly claim: ClaimedApproval;
  readonly tool: string;
  readonly via: ApprovalVia;
  readonly reason: string;
}

export async function recordApprovalUnfulfilled(p: RecordApprovalUnfulfilledInput): Promise<void> {
  const { db, principal, claim, tool, via, reason } = p;
  try {
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: actorTypeOf(principal),
        actor_id: principal.id,
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

interface ConsumeApprovalInput {
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
  readonly approval_id: string | null;
  readonly tool: string;
  readonly surface: ToolSurface;
  readonly via: ApprovalVia;
  readonly execution_mode?: ApprovalExecutionMode | undefined;
}

export async function consumeApproval(input: ConsumeApprovalInput): Promise<ConsumeApprovalResult> {
  const { db, principal, approval_id, tool, surface, via } = input;
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

  const claimInput = { ...input, approval_id };

  try {
    return await withTenantScope(db, principal.tenant_id, async (tx) => {
      const claimed = await tx
        .update(toolApprovals)
        .set({ consumed_at: sql`now()` })
        .where(
          and(
            eq(toolApprovals.id, approval_id),
            eq(toolApprovals.tenant_id, principal.tenant_id),
            eq(toolApprovals.principal_id, principal.id),
            approvalOwnerFilter(principal),
            eq(toolApprovals.tool, tool),
            eq(toolApprovals.surface, surface),
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
          preview_ciphertext: toolApprovals.preview_ciphertext,
          preview_iv: toolApprovals.preview_iv,
          preview_auth_tag: toolApprovals.preview_auth_tag,
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
      if (hashToolArgs(args) !== row.args_hash) {
        return await denyClaim(claimInput, tx, integrityFailed(approval_id));
      }

      const stored = normalizeExecutionMode(row.execution_mode);
      if (input.execution_mode !== undefined && input.execution_mode !== stored) {
        return await denyClaim(claimInput, tx, environmentMismatch(approval_id, stored));
      }

      const preview = decryptPreview({
        ...row,
        id: approval_id,
        tenant_id: principal.tenant_id,
      });
      const binding = preview?.prepared_workflow;
      return {
        ok: true,
        approval_id,
        args,
        ...(binding ? { prepared_workflow: binding } : {}),
        ...(preview?.direct_connector ? { direct_connector: preview.direct_connector } : {}),
        tool: row.tool,
        surface: row.surface === "mcp" ? "mcp" : "chat",
        execution_mode: stored,
      } satisfies ClaimedApproval;
    });
  } catch (err) {
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

const DENIAL_BURNS_HANDLE: Record<ApprovalDenialCode, boolean> = {
  confirmation_missing_id: false,
  unknown_confirmation: false,
  confirmation_tool_mismatch: false,
  confirmation_surface_mismatch: false,
  confirmation_already_used: false,
  confirmation_expired: false,
  confirmation_claim_failed: false,
  approval_not_granted: false,
  approval_declined: false,
  confirmation_environment_mismatch: true,
  confirmation_integrity_failed: true,
};

const AUDITABLE_DENIAL_CODES: ReadonlySet<ApprovalDenialCode> = new Set(
  (Object.keys(DENIAL_BURNS_HANDLE) as ApprovalDenialCode[]).filter(
    (code) => DENIAL_BURNS_HANDLE[code],
  ),
);

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
      resource_type: resourceTypeOf(surface),
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
      and(
        eq(toolApprovals.id, approval_id),
        eq(toolApprovals.tenant_id, principal.tenant_id),
        approvalOwnerFilter(principal),
      ),
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
  if (row.declined) {
    return {
      ok: false,
      code: "approval_declined",
      message: `Approval ${approval_id} was declined by a person. Nothing ran, and this approval cannot be revived. Do not retry it; ask them what to change, then re-issue the original call.`,
    };
  }
  if (!row.granted) {
    return {
      ok: false,
      code: "approval_not_granted",
      message: `Approval ${approval_id} has not been granted. A person must approve it in the approval portal, using the approval_url this call returned when it was first issued. Nothing ran. Once they approve, this same confirm_id becomes claimable — you cannot approve it yourself.`,
    };
  }
  return unknownConfirmation(approval_id);
}
