import { randomUUID } from "node:crypto";
import { localConfirmationOf } from "@shared/device/confirmation.ts";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { auditAwait } from "../audit/audit.ts";
import { resolveActor } from "../audit/recorders/types.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  conversationElicitations,
  conversations,
  conversationToolCalls,
} from "../db/schema/index.ts";
import { LocalConfirmationForbiddenError } from "../devices/confirmation-errors.ts";
import { grantsConfirmation, NOTHING_CHANGED } from "../devices/core/local-confirmation.ts";
import { logger } from "../logging/index.ts";
import { APPROVAL_TTL_MS } from "../tools/approval.ts";
import { type ElicitationStatus, elicitationSources } from "./core/elicitation-status.ts";
import { type DecidedBy, decidedByAuditActor } from "./decided-by.ts";
import { applyPlaybookDecision } from "./playbook.ts";
import { humanConfirmationContextFingerprint } from "./playbook-evidence.ts";
import {
  approvalHandleFromElicitationInput,
  isWorkflowInputForm,
} from "./tools/ask-user/commit-intent.ts";
import { interpretConfirmDecision } from "./tools/ask-user/interpret-confirm.ts";
import { redactElicitationOutput } from "./tools/ask-user/redact-answer.ts";

export type { ElicitationStatus };

interface ElicitationTransition {
  tenant_id: string;
  ids: readonly string[];
  to: ElicitationStatus;
  set: Omit<PgUpdateSetSource<typeof conversationElicitations>, "status" | "id" | "tenant_id">;
}

async function transitionElicitations(exec: Executor, transition: ElicitationTransition) {
  const sources = elicitationSources(transition.to);
  if (sources.length === 0 || transition.ids.length === 0) return [];
  return exec
    .update(conversationElicitations)
    .set({ ...transition.set, status: transition.to })
    .where(
      and(
        eq(conversationElicitations.tenant_id, transition.tenant_id),
        inArray(conversationElicitations.id, [...transition.ids]),
        inArray(conversationElicitations.status, sources),
      ),
    )
    .returning();
}

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
  parent_message_id?: string | null;
}

interface NativeDeliveryClaim {
  elicitation: ElicitationRecord;
  lease_id: string;
}

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

interface CreateElicitationParams {
  tenant_id: string;
  conversation_id: string;
  tool_call_id: string | null;
  parent_message_id?: string | null;
  tool_name: string;
  summary: string;
  input: unknown;
  actor_id: string | null;
  actor_type?: import("../audit/types.ts").AuditActorType;
  expires_at?: Date;
}

export const ELICITATION_HUMAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function elicitationExpiry(input: unknown, now: Date): Date {
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

export function createElicitation(
  p: CreateElicitationParams,
  exec: Executor,
): Promise<ElicitationRecord> {
  return insertElicitation(p, false, exec);
}

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
  const input =
    p.input && typeof p.input === "object" && !Array.isArray(p.input)
      ? (p.input as Record<string, unknown>)
      : {};
  let playbookContextFingerprint: string | null = null;
  if (p.tool_name === "ask_user_confirm" && !input.commit_intent) {
    const [conversation] = await exec
      .select({ draft: conversations.draft, playbook: conversations.playbook })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
      .limit(1);
    playbookContextFingerprint = humanConfirmationContextFingerprint(
      conversation?.playbook,
      input.question,
      conversation?.draft,
    );
  }
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
    await transitionElicitations(exec, {
      tenant_id: p.tenant_id,
      ids: staleIds,
      to: "cancelled",
      set: {
        decision_reason: "superseded_by_new_elicitation",
        decided_at: new Date(),
        updated_at: new Date(),
      },
    });
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
      playbook_context_fingerprint: playbookContextFingerprint,
      expires_at: p.expires_at ?? elicitationExpiry(p.input, new Date()),
    })
    .returning();
  assertInsertRow(inserted, "elicitation");
  await exec
    .update(conversations)
    .set({ status: "awaiting_input", updated_at: new Date() })
    .where(eq(conversations.id, p.conversation_id));
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
      ...resolveActor({
        tenant_id: p.tenant_id,
        actor_id: p.actor_id,
        actor_type: p.actor_type ?? (p.actor_id === null ? "system" : "unknown"),
      }),
      action: isWorkflowInputForm(p.tool_name, p.input)
        ? AuditAction.CONVERSATION_UPDATED
        : AuditAction.APPROVAL_REQUESTED,
      ...(isWorkflowInputForm(p.tool_name, p.input) ? { reason: "workflow_input_requested" } : {}),
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
  if (!demoted) return;
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

type StageElicitationAnswerResult =
  | { kind: "not_found" }
  | { kind: "already_resolved"; existing: ElicitationRecord }
  | { kind: "staged" };

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
  const existing = await getElicitation(p.tenant_id, p.id, exec);
  if (!existing || existing.conversation_id !== p.conversation_id) return { kind: "not_found" };
  return { kind: "already_resolved", existing };
}

type ResolveElicitationResult =
  | { kind: "not_found" }
  | { kind: "already_resolved"; existing: ElicitationRecord }
  | { kind: "resolved"; record: ElicitationRecord };

type ElicitationTransportOutcome = "succeeded" | "failed";

type ElicitationSurface = "mcp_elicitation" | "portal";

interface ElicitationResolveAuditMetadata {
  conversation_id: string;
  tool_name: string;
  surface: ElicitationSurface;
  elicitation_transport?: ElicitationTransportOutcome;
  [k: string]: unknown;
}

interface ResolveElicitationInput {
  tenant_id: string;
  id: string;
  output: unknown;
  decided_by: DecidedBy | null;
  reason?: string;
  status?: "resolved" | "cancelled" | "timeout";
  transport?: ElicitationTransportOutcome;
  local_confirmation_checked?: boolean;
}

export async function resolveElicitation(
  p: ResolveElicitationInput,
  exec: Executor,
): Promise<ResolveElicitationResult> {
  return exec.transaction((tx) => resolveElicitationWithin(p, tx));
}

function selectedChoiceLabel(input: unknown, output: unknown): string | null {
  const value =
    output && typeof output === "object" && !Array.isArray(output)
      ? (output as { value?: unknown }).value
      : null;
  const options =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as { options?: unknown }).options
      : null;
  if (typeof value !== "string" || !Array.isArray(options)) return null;
  const option = options.find(
    (item): item is { value: string; label: string } =>
      item !== null &&
      typeof item === "object" &&
      (item as { value?: unknown }).value === value &&
      typeof (item as { label?: unknown }).label === "string",
  );
  return option?.label ?? null;
}

async function resolveElicitationWithin(
  p: ResolveElicitationInput,
  exec: Executor,
): Promise<ResolveElicitationResult> {
  const status: ElicitationStatus = p.status ?? "resolved";
  const [pendingRow] = await exec
    .select({
      tool_name: conversationElicitations.tool_name,
      input: conversationElicitations.input,
      conversation_id: conversationElicitations.conversation_id,
      playbook_context_fingerprint: conversationElicitations.playbook_context_fingerprint,
    })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.id, p.id),
      ),
    )
    .limit(1);
  if (
    !p.local_confirmation_checked &&
    localConfirmationOf(pendingRow?.input) !== null &&
    grantsConfirmation(p.status ?? "resolved", interpretConfirmDecision(p.output))
  ) {
    throw new LocalConfirmationForbiddenError("unchecked");
  }
  const persistedOutput = pendingRow
    ? redactElicitationOutput(pendingRow.tool_name, pendingRow.input, p.output ?? null)
    : (p.output ?? null);
  let playbookContextFingerprint: string | null = null;
  if (
    status === "resolved" &&
    pendingRow?.tool_name === "ask_user_confirm" &&
    p.decided_by?.kind === "user" &&
    interpretConfirmDecision(p.output) === "confirmed"
  ) {
    const input =
      pendingRow.input && typeof pendingRow.input === "object" && !Array.isArray(pendingRow.input)
        ? (pendingRow.input as Record<string, unknown>)
        : {};
    if (!input.commit_intent) {
      const [conversation] = await exec
        .select({ draft: conversations.draft, playbook: conversations.playbook })
        .from(conversations)
        .where(
          and(
            eq(conversations.tenant_id, p.tenant_id),
            eq(conversations.id, pendingRow.conversation_id),
          ),
        )
        .limit(1);
      const currentContextFingerprint = humanConfirmationContextFingerprint(
        conversation?.playbook,
        input.question,
        conversation?.draft,
      );
      playbookContextFingerprint =
        pendingRow.playbook_context_fingerprint !== null &&
        pendingRow.playbook_context_fingerprint === currentContextFingerprint
          ? pendingRow.playbook_context_fingerprint
          : null;
    }
  }
  const [row] = await transitionElicitations(exec, {
    tenant_id: p.tenant_id,
    ids: [p.id],
    to: status,
    set: {
      output: persistedOutput as Record<string, unknown> | null,
      decided_by: p.decided_by?.id ?? null,
      decided_by_kind: p.decided_by?.kind ?? null,
      decided_at: new Date(),
      playbook_context_fingerprint: playbookContextFingerprint,
      decision_reason: p.reason ?? null,
      updated_at: new Date(),
    },
  });
  if (!row) {
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
  if (
    (row.tool_name === "ask_user_confirm" || row.tool_name === "ask_user_choice") &&
    row.tool_call_id
  ) {
    const accepted =
      status === "resolved" &&
      (row.tool_name === "ask_user_choice" || interpretConfirmDecision(p.output) === "confirmed");
    await exec
      .update(conversationToolCalls)
      .set({ outcome: accepted ? "ok" : "denied" })
      .where(
        and(
          eq(conversationToolCalls.tenant_id, p.tenant_id),
          eq(conversationToolCalls.id, row.tool_call_id),
          eq(conversationToolCalls.outcome, "pending"),
        ),
      );
  }
  if (row.tool_name === "ask_user_choice" && status === "resolved") {
    const input =
      row.input && typeof row.input === "object" && !Array.isArray(row.input)
        ? (row.input as { question?: unknown; playbook_step_id?: unknown })
        : {};
    const answerLabel = selectedChoiceLabel(row.input, p.output);
    if (answerLabel && typeof input.question === "string") {
      const revision = await applyPlaybookDecision(
        exec,
        {
          tenant_id: p.tenant_id,
          conversation_id: row.conversation_id,
          actor: decidedByAuditActor(p.decided_by),
          request_source: row.protocol_native ? "mcp" : "ui",
        },
        {
          elicitation_id: row.id,
          step_id: typeof input.playbook_step_id === "string" ? input.playbook_step_id : null,
          question: input.question,
          answer_label: answerLabel,
        },
      );
      if (revision !== null) {
        logger.info({
          module: "conversation",
          action: "playbook.decision_applied",
          msg: "answered choice recorded on its playbook step",
          tenant_id: p.tenant_id,
          conversation_id: row.conversation_id,
          elicitation_id: row.id,
          revision,
        });
      }
    }
  }
  const metadata: ElicitationResolveAuditMetadata = {
    conversation_id: row.conversation_id,
    tool_name: row.tool_name,
    surface: row.protocol_native ? "mcp_elicitation" : "portal",
    ...(status === "timeout" ? { outcome: "expired" } : {}),
    ...(p.transport && row.protocol_native ? { elicitation_transport: p.transport } : {}),
  };
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      ...decidedByAuditActor(p.decided_by),
      action:
        status === "timeout"
          ? AuditAction.ELICITATION_EXPIRED
          : isWorkflowInputForm(row.tool_name, row.input)
            ? AuditAction.CONVERSATION_UPDATED
            : status === "resolved" &&
                (row.tool_name !== "ask_user_confirm" ||
                  interpretConfirmDecision(p.output) !== "declined")
              ? AuditAction.APPROVAL_APPROVED
              : AuditAction.APPROVAL_REJECTED,
      resource_type: "conversation_elicitation",
      resource_id: row.id,
      result: "success",
      reason:
        p.reason ??
        (isWorkflowInputForm(row.tool_name, row.input) ? `workflow_input_${status}` : null),
      metadata,
    },
    exec,
  );
  return { kind: "resolved", record: rowToRecord(row) };
}

export async function resolveElicitationAndReactivate(
  p: {
    tenant_id: string;
    conversation_id: string;
    id: string;
    output: unknown;
    decided_by: DecidedBy | null;
    reason?: string;
    status?: "resolved" | "cancelled";
    transport?: ElicitationTransportOutcome;
  },
  db: Db,
): Promise<ResolveElicitationResult> {
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

export type ElicitationExpiryReason =
  | "approval_expired"
  | "approval_abandoned"
  | "credential_setup_expired"
  | "local_confirmation_expired"
  | "prompt_expired";

const EXPIRY_NOTES: Readonly<Record<ElicitationExpiryReason, string>> = {
  approval_expired:
    "the operator did not answer the confirmation within the approval window; nothing ran. Ask the user whether they still want this action, and re-issue the tool call if so.",
  approval_abandoned:
    "the operator DID approve this, but the approval could not be carried out before it expired, so nothing ran. Tell the user their approval was received and arrived too late to execute, and re-issue the tool call if they still want it.",
  credential_setup_expired:
    "the secure credential setup link expired before the operator submitted it; no credential was stored. Ask whether they want a fresh credential prompt and re-issue the tool call if so.",
  local_confirmation_expired: `nobody confirmed this local step before its deadline. ${NOTHING_CHANGED.en} Choose another way or finish with a written result; ask again only if the person still wants it.`,
  prompt_expired:
    "the question went unanswered long enough to expire; nothing ran. Ask it again if the answer is still needed.",
};

export function expiredToolCallUpdate(reason: ElicitationExpiryReason): {
  output: Record<string, unknown>;
  outcome: "expired";
  confirmation_state: "expired";
} {
  return {
    output: {
      ok: false,
      abandoned: true,
      outcome: "expired",
      reason,
      note: EXPIRY_NOTES[reason],
      ...(reason === "local_confirmation_expired" ? { message: NOTHING_CHANGED } : {}),
    },
    outcome: "expired",
    confirmation_state: "expired",
  };
}

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
        .set(expiredToolCallUpdate(reason))
        .where(eq(conversationToolCalls.id, toolCallId));
    }
  });
  return resolution;
}
