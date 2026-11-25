import { LOCAL_CONFIRMATION_KIND, type LocalConfirmation } from "@shared/device/confirmation.ts";
import { and, eq, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db, Executor } from "../db/client.ts";
import { conversations, conversationToolCalls, taskRuns } from "../db/schema/index.ts";
import {
  LocalConfirmationExpiredError,
  LocalConfirmationForbiddenError,
} from "../devices/confirmation-errors.ts";
import type { LocalConfirmationPort } from "../devices/confirmation-port.ts";
import {
  confirmerRefusal,
  grantsConfirmation,
  localConfirmationDeadline,
  localConfirmationStep,
  NOTHING_CHANGED,
  toolCallStateOf,
} from "../devices/core/local-confirmation.ts";
import { emitResourceChange } from "../pubsub/resource-changes.ts";
import { principalHolds } from "../rbac/evaluator.ts";
import type { CONVERSATION_ABANDONED } from "./core/conversation-status.ts";
import { createElicitation } from "./elicitations.ts";

async function taskRunOf(
  exec: Executor,
  tenant_id: string,
  conversation_id: string,
): Promise<{ id: string; deadline_at: Date } | null> {
  const [run] = await exec
    .select({ id: taskRuns.id, deadline_at: taskRuns.deadline_at })
    .from(taskRuns)
    .where(and(eq(taskRuns.tenant_id, tenant_id), eq(taskRuns.conversation_id, conversation_id)))
    .limit(1);
  return run ?? null;
}

export interface LocalConfirmationRequest {
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly tool_call_id: string;
  readonly parent_message_id: string | null;
  readonly actor_id: string | null;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly question: string;
  readonly device: Omit<LocalConfirmation, "deadline_at">;
  readonly requested_at: Date;
  readonly limits: readonly (Date | null)[];
}

export type RequestedLocalConfirmation =
  | { readonly ok: true; readonly elicitation_id: string; readonly confirmation: LocalConfirmation }
  | { readonly ok: false; readonly reason: typeof CONVERSATION_ABANDONED };

export async function requestLocalConfirmation(
  db: Db,
  request: LocalConfirmationRequest,
): Promise<RequestedLocalConfirmation> {
  return await db.transaction(async (tx) => {
    const run = await taskRunOf(tx, request.tenant_id, request.conversation_id);
    const deadline = localConfirmationDeadline(request.requested_at, [
      ...request.limits,
      run?.deadline_at ?? null,
    ]);
    const confirmation: LocalConfirmation = {
      ...request.device,
      deadline_at: deadline.toISOString(),
    };
    const opening = await createElicitation(
      {
        tenant_id: request.tenant_id,
        conversation_id: request.conversation_id,
        tool_call_id: request.tool_call_id,
        parent_message_id: request.parent_message_id,
        tool_name: "ask_user_confirm",
        summary: request.question,
        input: {
          kind: LOCAL_CONFIRMATION_KIND,
          question: request.question,
          target: { tool: request.tool, args: request.args },
          device: confirmation,
          expires_at: confirmation.deadline_at,
        },
        actor_id: request.actor_id,
        expires_at: deadline,
      },
      tx,
    );
    if (!opening.ok) return opening;
    const elicitation = opening.elicitation;
    await tx
      .update(conversationToolCalls)
      .set({
        confirmation_state: toolCallStateOf("requested"),
        confirmation_data: sql`COALESCE(${conversationToolCalls.confirmation_data}, '{}'::jsonb) || ${JSON.stringify(
          { device: confirmation, elicitation_id: elicitation.id },
        )}::jsonb`,
        output: {
          pending: true,
          status: "awaiting_confirmation",
          elicitation_id: elicitation.id,
          deadline_at: confirmation.deadline_at,
        },
        outcome: "pending",
      })
      .where(
        and(
          eq(conversationToolCalls.tenant_id, request.tenant_id),
          eq(conversationToolCalls.id, request.tool_call_id),
        ),
      );
    await emitResourceChange(tx, {
      tenant_id: request.tenant_id,
      type: "local.confirmation_requested",
      ids: {
        task_run_id: run?.id ?? null,
        device_id: confirmation.device_id,
        command_id: confirmation.command_id,
        confirmation_id: request.tool_call_id,
        conversation_id: request.conversation_id,
      },
    });
    return { ok: true, elicitation_id: elicitation.id, confirmation };
  });
}

export interface LocalDecisionInput {
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly principal: ResolvedPrincipal | null | undefined;
  readonly confirmation: LocalConfirmation;
  readonly status: "resolved" | "cancelled";
  readonly decision: "confirmed" | "declined" | "ambiguous";
  readonly now: Date;
}

export async function checkLocalDecision(
  exec: Executor,
  input: LocalDecisionInput,
): Promise<"granted" | "declined"> {
  const [conversation] = await exec
    .select({ owner_id: conversations.owner_id })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenant_id, input.tenant_id),
        eq(conversations.id, input.conversation_id),
      ),
    )
    .limit(1);
  const principal = input.principal ?? null;
  const refusal = confirmerRefusal({
    principal_kind: principal?.kind ?? null,
    auth_source: principal?.auth_source?.kind ?? null,
    delegated:
      principal?.api_key_id !== undefined ||
      principal?.via !== undefined ||
      (principal?.credential_origin ?? null) !== null,
    actor_id: principal?.id ?? null,
    owner_id: conversation?.owner_id ?? null,
    holds_local_confirm:
      principal !== null && (await principalHolds(exec, principal, "local:confirm")),
  });
  if (refusal !== null) throw new LocalConfirmationForbiddenError(refusal);
  const step = localConfirmationStep(
    "requested",
    grantsConfirmation(input.status, input.decision) ? "grant" : "decline",
    new Date(input.confirmation.deadline_at),
    input.now,
  );
  if (!step.ok) throw new LocalConfirmationExpiredError();
  return step.state === "granted" ? "granted" : "declined";
}

export async function recordLocalDecision(
  exec: Executor,
  p: {
    readonly tenant_id: string;
    readonly conversation_id: string;
    readonly tool_call_id: string;
    readonly actor_id: string;
    readonly confirmation: LocalConfirmation;
    readonly state: "granted" | "declined";
    readonly port: LocalConfirmationPort;
  },
): Promise<void> {
  const run = await taskRunOf(exec, p.tenant_id, p.conversation_id);
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: "user",
      actor_id: p.actor_id,
      action:
        p.state === "granted"
          ? AuditAction.LOCAL_CONFIRMATION_GRANTED
          : AuditAction.LOCAL_CONFIRMATION_DECLINED,
      resource_type: "local_confirmation",
      resource_id: p.tool_call_id,
      result: "success",
      metadata: {
        confirmation_id: p.tool_call_id,
        device_id: p.confirmation.device_id,
        capability: p.confirmation.capability,
        conversation_id: p.conversation_id,
        ...(p.confirmation.command_id ? { command_id: p.confirmation.command_id } : {}),
        ...(p.confirmation.binding_hash ? { binding_hash: p.confirmation.binding_hash } : {}),
        ...(run ? { task_run_id: run.id } : {}),
      },
    },
    exec,
  );
  if (p.state === "declined") {
    await exec
      .update(conversationToolCalls)
      .set({ output: declinedStepOutput(), outcome: "denied" })
      .where(
        and(
          eq(conversationToolCalls.tenant_id, p.tenant_id),
          eq(conversationToolCalls.id, p.tool_call_id),
        ),
      );
  }
  await p.port.settled({
    tenant_id: p.tenant_id,
    confirmation_id: p.tool_call_id,
    confirmation: p.confirmation,
    state: p.state,
  });
}

export function declinedStepOutput(): Record<string, unknown> {
  return {
    ok: false,
    outcome: "declined",
    reason: "local_confirmation_declined",
    note: `the person declined this local step. ${NOTHING_CHANGED.en} Choose another way or finish with a written result.`,
    message: NOTHING_CHANGED,
  };
}

export type ContinueAfterLocalStep = (p: {
  readonly tenant_id: string;
  readonly conversation_id: string;
}) => Promise<void>;
