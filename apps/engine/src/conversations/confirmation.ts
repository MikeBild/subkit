import { and, eq, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { recordToolPolicyConfirmationRequired } from "../audit/recorders/index.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { currentDeploymentMode } from "../config/deployment-mode.ts";
import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { conversationMessages, conversationToolCalls } from "../db/schema/index.ts";
import { logger } from "../logging/index.ts";
import {
  recordConfirmationTransition,
  recordToolPolicyDecision,
} from "../observability/instrumentation.ts";
import { enrichActiveSpan, toolSpanAttributes } from "../observability/tracing.ts";
import {
  type ApprovalExecutionMode,
  type ApprovalVia,
  requestApproval,
} from "../tools/approval.ts";
import { type PolicyDecideInput, type PolicyDecision, policyDecide } from "../tools/policy.ts";
import type { ConfirmReason, ToolCategory, ToolModeRule, ToolPolicyMode } from "../tools/types.ts";
import type { ConversationSurface } from "./lifecycle-view.ts";
import { writesModelChecked } from "./model-trust.ts";
import type { ToolEffect, ToolPrecheck, ToolResult } from "./tools/index.ts";

export type ConfirmationState =
  | "proposed"
  | "tested"
  | "confirmed"
  | "partial"
  | "declined"
  | "auto_declined"
  | "expired"
  | "oauth_success"
  | "oauth_failure";

export interface InteractionLogEntry {
  type: string;
  ts: string;
  meta?: Record<string, unknown>;
}

function transcriptMarkerFor(state: ConfirmationState, tool: string | undefined): string | null {
  const label = tool ?? "action";
  switch (state) {
    case "confirmed":
      return `✓ Approved: ${label}`;
    case "declined":
      return `✗ Declined: ${label}`;
    case "partial":
      return `◐ Partially approved: ${label}`;
    case "auto_declined":
      return `✗ Auto-declined: ${label} (superseded by a later message)`;
    case "oauth_success":
      return `✓ OAuth completed: ${label}`;
    case "oauth_failure":
      return `✗ OAuth failed: ${label}`;
    default:
      return null;
  }
}

function keepingPolicyRecord(data: Record<string, unknown>) {
  const kept = (key: string) =>
    sql`CASE WHEN jsonb_exists(${conversationToolCalls.confirmation_data}, ${key}) THEN jsonb_build_object(${key}::text, ${conversationToolCalls.confirmation_data} -> ${key}) ELSE '{}'::jsonb END`;
  return sql`${JSON.stringify(data)}::jsonb || ${kept("policy")} || ${kept("rule_offer")} || ${kept("device")} || ${kept("device_step")} || ${kept("device_pending")}`;
}

export async function recordTransition(
  db: Db,
  params: {
    tool_call_id: string;
    tenant_id: string;
    to_state: ConfirmationState;
    data?: Record<string, unknown>;
    actor_id?: string | null;
    tool?: string;
    conversation_id?: string;
  },
): Promise<void> {
  const entry: InteractionLogEntry = {
    type: `user_${params.to_state}`,
    ts: new Date().toISOString(),
    ...(params.actor_id || params.data
      ? {
          meta: {
            ...(params.actor_id ? { actor_id: params.actor_id } : {}),
            ...(params.data ?? {}),
          },
        }
      : {}),
  };
  await db
    .update(conversationToolCalls)
    .set({
      confirmation_state: params.to_state,
      ...(params.data !== undefined ? { confirmation_data: keepingPolicyRecord(params.data) } : {}),
      interaction_log: sql`COALESCE(${conversationToolCalls.interaction_log}, '[]'::jsonb) || ${JSON.stringify(
        [entry],
      )}::jsonb`,
    })
    .where(
      and(
        eq(conversationToolCalls.id, params.tool_call_id),
        eq(conversationToolCalls.tenant_id, params.tenant_id),
      ),
    );

  if (params.conversation_id) {
    const marker = transcriptMarkerFor(params.to_state, params.tool);
    if (marker) {
      await db.insert(conversationMessages).values({
        tenant_id: params.tenant_id,
        conversation_id: params.conversation_id,
        role: "user",
        content: {
          kind: "confirmation_decision",
          text: marker,
          tool: params.tool ?? null,
          to_state: params.to_state,
          tool_call_id: params.tool_call_id,
        } as Record<string, unknown>,
      });
    }
  }

  recordConfirmationTransition({ to_state: params.to_state, tool: params.tool ?? "unknown" });
}

export function isTerminalState(s: ConfirmationState): boolean {
  return (
    s === "confirmed" ||
    s === "partial" ||
    s === "declined" ||
    s === "auto_declined" ||
    s === "expired" ||
    s === "oauth_success" ||
    s === "oauth_failure"
  );
}

export type GateOutcome =
  | "proceed"
  | "confirm"
  | "refused"
  | "unavailable"
  | "duplicate_pending"
  | "approval_failed";

export interface GateRecord {
  readonly tool: string;
  readonly category: ToolCategory;
  readonly rule: ConfirmReason;
  readonly mode: ToolPolicyMode;
  readonly outcome: GateOutcome;
  readonly surface: ConversationSurface;
  readonly tenant_id: string;
  readonly conversation_id: string | null;
}

export interface ConfirmGateInput extends PolicyDecideInput {
  readonly db: Db;
  readonly tenant_id: string;
  readonly principal: ResolvedPrincipal | null;
  readonly approval_tool: string;
  readonly via: ApprovalVia;
  readonly record_surface: ConversationSurface;
  readonly conversation_id: string | null;
  readonly actor_id: string | null;
  readonly execution_mode: ApprovalExecutionMode | null;
  readonly precheck: (() => Promise<ToolPrecheck>) | null;
  readonly pause_blocked: boolean;
  readonly confirmation_kind: string | null;
  readonly environment?: string;
}

type ConfirmGateResult =
  | { kind: "proceed"; decision: Extract<PolicyDecision, { kind: "proceed" }>; record: GateRecord }
  | { kind: "unavailable"; reason: string; record: GateRecord }
  | { kind: "refused"; result: ToolResult; record: GateRecord }
  | { kind: "duplicate_pending"; record: GateRecord }
  | {
      kind: "needs_confirm";
      approval_id: string | null;
      approval_url: string | null;
      effect: ToolEffect | null;
      rule: ToolModeRule;
      record: GateRecord;
    }
  | { kind: "approval_failed"; error: unknown; record: GateRecord };

export type GateRecordInput = Pick<
  ConfirmGateInput,
  "approval_tool" | "category" | "record_surface" | "tenant_id" | "conversation_id"
>;

export function gateRecordFor(
  input: GateRecordInput,
  decision: PolicyDecision,
  outcome: GateOutcome,
  rule: ConfirmReason = decision.rule,
): GateRecord {
  return {
    tool: input.approval_tool,
    category: input.category,
    rule,
    mode: decision.mode,
    outcome,
    surface: input.record_surface,
    tenant_id: input.tenant_id,
    conversation_id: input.conversation_id,
  };
}

export function logGateDecision(record: GateRecord): void {
  logger.debug({
    module: "conversation_loop",
    action: "tool_policy.resolved",
    msg: "resolved tool execution mode",
    tenant_id: record.tenant_id,
    ...(record.conversation_id ? { conversation_id: record.conversation_id } : {}),
    tool: record.tool,
    category: record.category,
    mode: record.mode,
    rule: record.rule,
    outcome: record.outcome,
    surface: record.surface,
  });
  recordToolPolicyDecision(record);
  enrichActiveSpan(toolSpanAttributes({ rule: record.rule, mode: record.mode }));
}

function emitted<T extends ConfirmGateResult>(result: T): T {
  logGateDecision(result.record);
  return result;
}

async function recordConfirmationRequired(p: {
  db: Db;
  tenant_id: string;
  actor_id: string | null;
  actor_type: "user" | "system_account" | "system" | "unknown";
  conversation_id: string;
  tool: string;
  mode: ToolPolicyMode;
  confirmation_kind: string | null;
  resolver_reason: ConfirmReason;
  environment: string | undefined;
}): Promise<void> {
  await recordToolPolicyConfirmationRequired({
    tenant_id: p.tenant_id,
    actor_id: p.actor_id,
    actor_type: p.actor_type,
    executor: p.db,
    conversation_id: p.conversation_id,
    tool: p.tool,
    mode: p.mode,
    confirmation_kind: p.confirmation_kind,
    resolver_reason: p.resolver_reason,
    ...(p.environment !== undefined ? { environment: p.environment } : {}),
  }).catch((err: unknown) => {
    logger.warn({
      module: "conversation_loop",
      action: "tool_policy.audit_failed",
      msg: "failed to record tool_policy.confirmation_required audit",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      tool: p.tool,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export interface ConfirmationSkipped {
  readonly tool: string;
  readonly conversation_id: string;
  readonly environment: string;
  readonly covering_authority_id: string;
}

export function confirmationSkippedMetadata(p: ConfirmationSkipped): Record<string, string> {
  return {
    tool: p.tool,
    conversation_id: p.conversation_id,
    environment: p.environment,
    resolver_reason: "authority_covered",
    covering_authority_id: p.covering_authority_id,
  };
}

async function claimSkippedRecord(
  p: { readonly db: Db; readonly tenant_id: string },
  tool_call_id: string,
  metadata: Record<string, string>,
): Promise<boolean> {
  const entry: InteractionLogEntry = {
    type: "confirmation_skipped",
    ts: new Date().toISOString(),
    meta: metadata,
  };
  const recorded = JSON.stringify({ resolver_reason: metadata.resolver_reason });
  const claimed = await p.db
    .update(conversationToolCalls)
    .set({
      confirmation_data: sql`COALESCE(${conversationToolCalls.confirmation_data}, '{}'::jsonb) || ${JSON.stringify(
        metadata,
      )}::jsonb`,
      interaction_log: sql`COALESCE(${conversationToolCalls.interaction_log}, '[]'::jsonb) || ${JSON.stringify(
        [entry],
      )}::jsonb`,
    })
    .where(
      and(
        eq(conversationToolCalls.id, tool_call_id),
        eq(conversationToolCalls.tenant_id, p.tenant_id),
        sql`NOT (COALESCE(${conversationToolCalls.confirmation_data}, '{}'::jsonb) @> ${recorded}::jsonb)`,
      ),
    )
    .returning({ id: conversationToolCalls.id });
  if (claimed.length > 0) return true;
  const [known] = await p.db
    .select({ id: conversationToolCalls.id })
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.id, tool_call_id),
        eq(conversationToolCalls.tenant_id, p.tenant_id),
      ),
    )
    .limit(1);
  return known === undefined;
}

export async function recordConfirmationSkipped(
  p: ConfirmationSkipped & {
    readonly db: Db;
    readonly tenant_id: string;
    readonly tool_call_id: string | null;
    readonly actor_id: string | null;
    readonly actor_type: "user" | "system_account" | "system" | "unknown";
  },
): Promise<void> {
  const metadata = confirmationSkippedMetadata(p);
  try {
    if (p.tool_call_id !== null && !(await claimSkippedRecord(p, p.tool_call_id, metadata))) return;
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_type,
        actor_id: p.actor_id,
        action: AuditAction.TOOL_POLICY_CONFIRMATION_SKIPPED,
        resource_type: "conversation",
        resource_id: p.conversation_id,
        result: "success",
        reason: "authority_covered",
        metadata,
      },
      p.db,
    );
  } catch (err: unknown) {
    logger.warn({
      module: "conversation_loop",
      action: "tool_policy.audit_failed",
      msg: "failed to record tool_policy.confirmation_skipped",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      tool: p.tool,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function writesModelUnchecked(tenantId: string, askBeforeWriting: boolean): boolean {
  if (askBeforeWriting) return false;
  const mode = currentDeploymentMode();
  if (mode !== "local_workspace") return false;
  try {
    return !writesModelChecked(mode, getConfig(tenantId).llm);
  } catch {
    return true;
  }
}

export async function runConfirmGate(input: ConfirmGateInput): Promise<ConfirmGateResult> {
  const decision = policyDecide(
    writesModelUnchecked(input.tenant_id, input.ask_before_writing === true)
      ? { ...input, model_checked: false }
      : input,
  );
  const recordInput: GateRecordInput = {
    approval_tool: input.approval_tool,
    category: input.category,
    record_surface: input.record_surface,
    tenant_id: input.tenant_id,
    conversation_id: input.conversation_id,
  };
  const record = (outcome: GateOutcome): GateRecord =>
    gateRecordFor(recordInput, decision, outcome);

  if (decision.kind === "not_available_on_surface") {
    return emitted({ kind: "unavailable", reason: decision.reason, record: record("unavailable") });
  }
  if (decision.kind === "proceed") {
    return emitted({ kind: "proceed", decision, record: record("proceed") });
  }

  let effect: ToolEffect | null = null;
  if (input.precheck) {
    const checked = await input.precheck();
    if (!checked.ok) {
      return emitted({ kind: "refused", result: checked.result, record: record("refused") });
    }
    effect = checked.effect ?? null;
  }

  if (input.pause_blocked) {
    return emitted({ kind: "duplicate_pending", record: record("duplicate_pending") });
  }

  if (input.conversation_id !== null) {
    await recordConfirmationRequired({
      db: input.db,
      tenant_id: input.tenant_id,
      actor_id: input.actor_id,
      actor_type: input.principal?.kind ?? (input.actor_id === null ? "system" : "unknown"),
      conversation_id: input.conversation_id,
      tool: input.approval_tool,
      mode: decision.mode,
      confirmation_kind: input.confirmation_kind,
      resolver_reason: decision.rule,
      environment: input.environment,
    });
  }

  if (!input.principal) {
    logger.warn({
      module: "conversation_tool",
      action: "policy.gate_no_principal",
      msg: "policy gate paused a tool with no resolvable principal — no approval could be minted, so the operator's confirmation cannot release it",
      tenant_id: input.tenant_id,
      ...(input.conversation_id ? { conversation_id: input.conversation_id } : {}),
      tool: input.approval_tool,
    });
    return emitted({
      kind: "needs_confirm",
      approval_id: null,
      approval_url: null,
      effect,
      rule: decision.rule,
      record: record("confirm"),
    });
  }

  const approval_id = crypto.randomUUID();
  try {
    const requested = await requestApproval({
      db: input.db,
      principal: input.principal,
      approval_id,
      tool: input.approval_tool,
      surface: input.surface,
      via: input.via,
      reason: decision.rule,
      execution_mode: input.execution_mode,
      args: input.args,
    });
    return emitted({
      kind: "needs_confirm",
      approval_id,
      approval_url: requested.approval_url,
      effect,
      rule: decision.rule,
      record: record("confirm"),
    });
  } catch (error) {
    logger.error({
      module: "conversation_tool",
      action: "policy.gate_approval_failed",
      msg: "could not persist the approval for a policy-gated tool call; nothing ran",
      tenant_id: input.tenant_id,
      ...(input.conversation_id ? { conversation_id: input.conversation_id } : {}),
      tool: input.approval_tool,
      error: error instanceof Error ? error.message : String(error),
    });
    return emitted({ kind: "approval_failed", error, record: record("approval_failed") });
  }
}

export async function openHeldWritesApproval(p: {
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly environment: ApprovalExecutionMode;
  readonly prepared_execution_id: string;
  readonly preview: { readonly would_write?: unknown } | undefined;
  readonly conversation_id: string;
  readonly actor_id: string | null;
  readonly record_surface: ConversationSurface;
  readonly decision: PolicyDecision;
}): Promise<{ approval_id: string; approval_url: string | null; record: GateRecord }> {
  const recordInput: GateRecordInput = {
    approval_tool: p.tool,
    category: "tenant_write",
    record_surface: p.record_surface,
    tenant_id: p.principal.tenant_id,
    conversation_id: p.conversation_id,
  };
  await recordConfirmationRequired({
    db: p.db,
    tenant_id: p.principal.tenant_id,
    actor_id: p.actor_id,
    actor_type: p.principal.kind,
    conversation_id: p.conversation_id,
    tool: p.tool,
    mode: p.decision.mode,
    confirmation_kind: "external_write",
    resolver_reason: "held_writes",
    environment: p.environment,
  });
  const approval_id = crypto.randomUUID();
  try {
    const requested = await requestApproval({
      db: p.db,
      principal: p.principal,
      approval_id,
      tool: p.tool,
      surface: "chat",
      via: "chat",
      reason: "held_writes",
      execution_mode: p.environment,
      args: p.args,
      prepared_execution_id: p.prepared_execution_id,
      preview: p.preview,
    });
    const record = gateRecordFor(recordInput, p.decision, "confirm", "held_writes");
    logGateDecision(record);
    return { approval_id, approval_url: requested.approval_url ?? null, record };
  } catch (error) {
    logGateDecision(gateRecordFor(recordInput, p.decision, "approval_failed", "held_writes"));
    throw error;
  }
}
