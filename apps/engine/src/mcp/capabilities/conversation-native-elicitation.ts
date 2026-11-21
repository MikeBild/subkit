import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  acknowledgeNativeUrlElicitation,
  claimNativeElicitationDelivery,
  type ElicitationRecord,
  type ElicitationResult,
  type ElicitFormParams,
  type ElicitOobParams,
  FORM_FAST_CANCEL_MS,
  type FormBridgeToolName,
  mapAskUserToPrimitiveSchema,
  mapElicitResultToAskUserOutput,
  reissueExpiredDraftCredentialSetup,
  releaseNativeElicitationDelivery,
  stageElicitationAnswer,
  validateElicitationAnswer,
} from "../../conversations/public/elicitation.ts";
import {
  assertTaskRunWriter,
  withReservedConversationTurn,
} from "../../conversations/public/lifecycle.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/index.ts";
import { isRequestTimeout } from "../transports/protocol-errors.ts";

export interface NativeElicitationTransport {
  elicitForm?: (params: ElicitFormParams) => Promise<ElicitationResult>;
  elicitUrl?: (params: ElicitOobParams & { mode: "url" }) => Promise<ElicitationResult>;
}

export const ELICITATION_FORM_TIMEOUT_MS = 5 * 60_000;

const ELICITATION_DELIVERY_LEASE_MS = ELICITATION_FORM_TIMEOUT_MS + 15_000;

const ELICITATION_DELIVERY_GRACE_MS = 1_000;

export const NATIVE_DELIVERY_TIMED_OUT = "delivery_timed_out";

export function nativeDeliveryFailureCode(err: unknown): string {
  return isRequestTimeout(err) ? NATIVE_DELIVERY_TIMED_OUT : "transport_failed";
}

export interface NativeDeliveryResult {
  isError: boolean;
  content: Array<{ type: "text"; text: string }>;
  createTaskResult?: {
    task: {
      taskId: string;
      status: "working";
      ttl: number;
      createdAt: string;
      lastUpdatedAt: string;
      pollInterval: number;
    };
  };
}

interface NativeResumeParams {
  turn_id?: string;
  reason?: string;
  reuse_task_id?: string;
}

const FORM_TOOL_NAMES = new Set<FormBridgeToolName>([
  "ask_user_text",
  "ask_user_choice",
  "ask_user_confirm",
  "ask_user_multi",
  "ask_user_form",
]);

function pendingUrlElicitation(
  pending: ElicitationRecord,
): { url: string; message: string; kind: "credential" | "approval" } | null {
  if (!pending.input || typeof pending.input !== "object" || Array.isArray(pending.input)) {
    return null;
  }
  const input = pending.input as Record<string, unknown>;
  const message =
    typeof input.summary === "string" && input.summary.length > 0 ? input.summary : pending.summary;
  const credentialUrl = input.authorization_url ?? input.setup_url;
  if (typeof credentialUrl === "string" && /^https?:\/\//i.test(credentialUrl)) {
    return { url: credentialUrl, message, kind: "credential" };
  }
  const approvalUrl = input.approval_url;
  if (typeof approvalUrl === "string" && /^https?:\/\//i.test(approvalUrl)) {
    return { url: approvalUrl, message, kind: "approval" };
  }
  return null;
}

export async function deliverPendingNativeElicitationCore(p: {
  db: Db;
  principal: ResolvedPrincipal;
  pending: ElicitationRecord;
  nativeElicitation: NativeElicitationTransport;
  resume: (params: NativeResumeParams) => Promise<NativeDeliveryResult>;
  reuse_task_id?: string;
  reissue_credential_link?: typeof reissueExpiredDraftCredentialSetup;
}): Promise<NativeDeliveryResult | null> {
  if (!FORM_TOOL_NAMES.has(p.pending.tool_name as FormBridgeToolName)) return null;
  const pending = p.pending;
  const redelivery: Record<string, unknown> =
    pending.delivery_last_error === NATIVE_DELIVERY_TIMED_OUT
      ? {
          previous_delivery: "timed_out",
          note: "The previous prompt expired unanswered; nothing was lost. It is presented again now.",
        }
      : {};
  const toolName = pending.tool_name as FormBridgeToolName;
  const elicitForm = p.nativeElicitation.elicitForm;
  const elicitUrl = p.nativeElicitation.elicitUrl;
  const urlCandidate = pendingUrlElicitation(pending);
  const urlAlreadyResolved =
    pending.delivery_last_error === "url_completed" ||
    pending.delivery_last_error === "url_failed" ||
    pending.delivery_last_error === "url_accepted";
  const urlElicitation =
    urlCandidate && (urlCandidate.kind === "credential" || urlAlreadyResolved || !elicitForm)
      ? urlCandidate
      : null;
  const mapped = urlElicitation ? null : mapAskUserToPrimitiveSchema(toolName, pending.input);
  const formMapping = mapped && !mapped.degrade ? mapped : null;
  if (urlElicitation && !elicitUrl && !urlAlreadyResolved) return null;
  if (!urlElicitation && (!formMapping || !elicitForm)) return null;
  if (urlElicitation && pending.delivery_last_error === "url_accepted") {
    return successText({
      status: "input_required",
      conversation_id: pending.conversation_id,
      phase: "external_interaction_pending",
      pending_elicitation_id: pending.id,
    });
  }

  const deliverable = await assertTaskRunWriter(p.db, {
    tenant_id: p.principal.tenant_id,
    conversation_id: pending.conversation_id,
    actor_id: p.principal.id,
    principal: p.principal,
  }).then(
    () => true,
    () => false,
  );
  if (!deliverable) return null;

  const claim = await claimNativeElicitationDelivery(
    {
      tenant_id: p.principal.tenant_id,
      conversation_id: pending.conversation_id,
      id: pending.id,
      lease_ms: ELICITATION_DELIVERY_LEASE_MS,
    },
    p.db,
  );
  if (!claim) {
    return successText({
      status: "working",
      conversation_id: pending.conversation_id,
      phase: "awaiting_human_input",
      pending_elicitation_id: pending.id,
    });
  }

  const stageAnswerAndResume = async (
    result: ElicitationResult,
    output: unknown,
  ): Promise<NativeDeliveryResult> =>
    withReservedConversationTurn(
      p.db,
      p.principal.tenant_id,
      pending.conversation_id,
      async (turn_id) => {
        const staged = await stageElicitationAnswer(
          {
            tenant_id: p.principal.tenant_id,
            conversation_id: pending.conversation_id,
            id: pending.id,
            output,
          },
          p.db,
        );
        if (staged.kind !== "staged") {
          return errorText(
            staged.kind === "not_found"
              ? "elicitation not found"
              : `elicitation already ${staged.existing.status}`,
          );
        }
        const reason =
          urlElicitation && pending.delivery_last_error === "url_failed"
            ? "external_interaction_failed"
            : result.action === "decline"
              ? "user_declined"
              : result.action === "cancel"
                ? "user_cancelled"
                : output === null
                  ? "invalid_elicit_response"
                  : undefined;
        const resumed = await p.resume({
          turn_id,
          ...(p.reuse_task_id ? { reuse_task_id: p.reuse_task_id } : {}),
          ...(reason ? { reason } : {}),
        });
        if (resumed.isError) {
          await releaseNativeElicitationDelivery(
            {
              tenant_id: p.principal.tenant_id,
              id: pending.id,
              lease_id: claim.lease_id,
              error_code: "resume_enqueue_failed",
            },
            p.db,
          );
        }
        logger.info({
          module: "mcp",
          action: "mcp.elicitation.native_answer_staged",
          msg: "native MCP elicitation answered and queued for conversation resume",
          tenant_id: p.principal.tenant_id,
          conversation_id: pending.conversation_id,
          elicitation_id: pending.id,
          elicitation_action: result.action,
        });
        return resumed;
      },
    );

  if (
    urlElicitation &&
    (pending.delivery_last_error === "url_completed" ||
      pending.delivery_last_error === "url_failed")
  ) {
    const result: ElicitationResult = {
      action: pending.delivery_last_error === "url_completed" ? "accept" : "cancel",
    };
    return await stageAnswerAndResume(
      result,
      result.action === "accept" ? { confirmed: true } : null,
    );
  }

  let deliveredUrl = urlElicitation;
  if (urlElicitation?.kind === "credential" && elicitUrl) {
    const reissue = await (p.reissue_credential_link ?? reissueExpiredDraftCredentialSetup)(p.db, {
      tenant_id: p.principal.tenant_id,
      conversation_id: pending.conversation_id,
      elicitation_id: pending.id,
      input: pending.input,
      delivery_last_error: pending.delivery_last_error,
      principal: p.principal,
    });
    const fresh = reissue.reissued
      ? pendingUrlElicitation({ ...pending, input: reissue.input })
      : null;
    if (reissue.reissued && fresh) {
      deliveredUrl = fresh;
      redelivery.credential_link_reissued = true;
      redelivery.credential_link_expires_at = reissue.expires_at.toISOString();
      logger.info({
        module: "mcp",
        action: "mcp.elicitation.credential_link_reissued",
        msg: "the secure credential link expired before it was used; a fresh single-use link replaces it on the same pending prompt",
        tenant_id: p.principal.tenant_id,
        conversation_id: pending.conversation_id,
        elicitation_id: pending.id,
        expires_at: reissue.expires_at.toISOString(),
      });
    }
  }

  const sentAt = Date.now();
  const delivery = (async () => {
    try {
      let result: ElicitationResult;
      let output: unknown;
      if (deliveredUrl) {
        if (!elicitUrl) return;
        result = await elicitUrl({
          mode: "url",
          message: deliveredUrl.message,
          url: deliveredUrl.url,
          elicitationId: pending.id,
        });
        if (result.action === "accept") {
          await acknowledgeNativeUrlElicitation(
            {
              tenant_id: p.principal.tenant_id,
              id: pending.id,
              lease_id: claim.lease_id,
            },
            p.db,
          );
          return;
        }
        output = null;
      } else {
        if (!formMapping || !elicitForm) return;
        result = await elicitForm({
          message: formMapping.message,
          requestedSchema: formMapping.requestedSchema,
        });
        if (result.action === "cancel" && Date.now() - sentAt < FORM_FAST_CANCEL_MS) {
          await releaseNativeElicitationDelivery(
            {
              tenant_id: p.principal.tenant_id,
              id: pending.id,
              lease_id: claim.lease_id,
              error_code: "form_fast_cancel",
            },
            p.db,
          );
          logger.warn({
            module: "mcp",
            action: "mcp.elicitation.form_fast_cancel",
            msg: "client cancelled the form faster than a human could render it — treating as undelivered, row remains retryable",
            tenant_id: p.principal.tenant_id,
            conversation_id: pending.conversation_id,
            elicitation_id: pending.id,
            elapsed_ms: Date.now() - sentAt,
          });
          return;
        }
        output =
          result.action === "accept"
            ? mapElicitResultToAskUserOutput(toolName, pending.input, result.content)
            : null;
        if (result.action === "accept" && output !== null) {
          const verdict = validateElicitationAnswer(toolName, pending.input, output);
          if (!verdict.ok) {
            const detail = verdict.field_errors.map((e) => `${e.name}: ${e.message}`).join("; ");
            result = await elicitForm({
              message: `${formMapping.message}\n\nThe previous answer was invalid — ${detail}. Please correct and resubmit.`,
              requestedSchema: formMapping.requestedSchema,
            });
            output =
              result.action === "accept"
                ? mapElicitResultToAskUserOutput(toolName, pending.input, result.content)
                : null;
          }
        }
      }
      await stageAnswerAndResume(result, output);
    } catch (err) {
      await releaseNativeElicitationDelivery(
        {
          tenant_id: p.principal.tenant_id,
          id: pending.id,
          lease_id: claim.lease_id,
          error_code: nativeDeliveryFailureCode(err),
        },
        p.db,
      );
      logger.warn({
        module: "mcp",
        action: "mcp.elicitation.native_transport_failed",
        msg: "native MCP elicitation failed or timed out; the pending prompt stays open and is presented again on the next poll",
        tenant_id: p.principal.tenant_id,
        conversation_id: pending.conversation_id,
        elicitation_id: pending.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  await Promise.race([
    delivery,
    new Promise<void>((resolve) => setTimeout(resolve, ELICITATION_DELIVERY_GRACE_MS)),
  ]);

  return successText({
    status: "input_required",
    conversation_id: pending.conversation_id,
    phase: "awaiting_human_input",
    pending_elicitation_id: pending.id,
    ...redelivery,
  });
}

function successText(obj: unknown): NativeDeliveryResult {
  return { isError: false, content: [{ type: "text", text: JSON.stringify(obj) }] };
}

function errorText(message: string): NativeDeliveryResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
