import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  type ElicitationResult,
  type ElicitFormParams,
  type ElicitOobParams,
  FORM_FAST_CANCEL_MS,
} from "../../conversations/elicitation-bridge.ts";
import {
  acknowledgeNativeUrlElicitation,
  claimNativeElicitationDelivery,
  type ElicitationRecord,
  releaseNativeElicitationDelivery,
  stageElicitationAnswer,
} from "../../conversations/elicitations.ts";
import {
  type FormBridgeToolName,
  mapAskUserToPrimitiveSchema,
  mapElicitResultToAskUserOutput,
} from "../../conversations/tools/ask-user/elicit-bridge.ts";
import { validateElicitationAnswer } from "../../conversations/tools/ask-user/validate-answer.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";

export interface NativeElicitationTransport {
  elicitForm?: (params: ElicitFormParams) => Promise<ElicitationResult>;
  elicitUrl?: (params: ElicitOobParams & { mode: "url" }) => Promise<ElicitationResult>;
}

export const ELICITATION_FORM_TIMEOUT_MS = 5 * 60_000;

export const ELICITATION_DELIVERY_LEASE_MS = ELICITATION_FORM_TIMEOUT_MS + 15_000;

export const ELICITATION_DELIVERY_GRACE_MS = 1_000;

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
  reason?: string;
  reuse_task_id?: string;
  permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
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
  permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
  reuse_task_id?: string;
}): Promise<NativeDeliveryResult | null> {
  if (!FORM_TOOL_NAMES.has(p.pending.tool_name as FormBridgeToolName)) return null;
  const toolName = p.pending.tool_name as FormBridgeToolName;
  const elicitForm = p.nativeElicitation.elicitForm;
  const elicitUrl = p.nativeElicitation.elicitUrl;
  const urlCandidate = pendingUrlElicitation(p.pending);
  const urlAlreadyResolved =
    p.pending.delivery_last_error === "url_completed" ||
    p.pending.delivery_last_error === "url_failed" ||
    p.pending.delivery_last_error === "url_accepted";
  const urlElicitation =
    urlCandidate && (urlCandidate.kind === "credential" || urlAlreadyResolved || !elicitForm)
      ? urlCandidate
      : null;
  const mapped = urlElicitation ? null : mapAskUserToPrimitiveSchema(toolName, p.pending.input);
  const formMapping = mapped && !mapped.degrade ? mapped : null;
  if (urlElicitation && !elicitUrl && !urlAlreadyResolved) return null;
  if (!urlElicitation && (!formMapping || !elicitForm)) return null;
  if (urlElicitation && p.pending.delivery_last_error === "url_accepted") {
    return successText({
      status: "input_required",
      conversation_id: p.pending.conversation_id,
      phase: "external_interaction_pending",
      pending_elicitation_id: p.pending.id,
    });
  }

  const claim = await claimNativeElicitationDelivery(
    {
      tenant_id: p.principal.tenant_id,
      conversation_id: p.pending.conversation_id,
      id: p.pending.id,
      lease_ms: ELICITATION_DELIVERY_LEASE_MS,
    },
    p.db,
  );
  if (!claim) {
    return successText({
      status: "working",
      conversation_id: p.pending.conversation_id,
      phase: "awaiting_human_input",
      pending_elicitation_id: p.pending.id,
    });
  }

  const stageAnswerAndResume = async (
    result: ElicitationResult,
    output: unknown,
  ): Promise<NativeDeliveryResult> => {
    const staged = await stageElicitationAnswer(
      {
        tenant_id: p.principal.tenant_id,
        conversation_id: p.pending.conversation_id,
        id: p.pending.id,
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
      urlElicitation && p.pending.delivery_last_error === "url_failed"
        ? "external_interaction_failed"
        : result.action === "decline"
          ? "user_declined"
          : result.action === "cancel"
            ? "user_cancelled"
            : output === null
              ? "invalid_elicit_response"
              : undefined;
    const resumed = await p.resume({
      ...(p.reuse_task_id ? { reuse_task_id: p.reuse_task_id } : {}),
      ...(reason ? { reason } : {}),
      ...(p.permission_mode ? { permission_mode: p.permission_mode } : {}),
    });
    if (resumed.isError) {
      await releaseNativeElicitationDelivery(
        {
          tenant_id: p.principal.tenant_id,
          id: p.pending.id,
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
      conversation_id: p.pending.conversation_id,
      elicitation_id: p.pending.id,
      elicitation_action: result.action,
    });
    return resumed;
  };

  if (
    urlElicitation &&
    (p.pending.delivery_last_error === "url_completed" ||
      p.pending.delivery_last_error === "url_failed")
  ) {
    const result: ElicitationResult = {
      action: p.pending.delivery_last_error === "url_completed" ? "accept" : "cancel",
    };
    return await stageAnswerAndResume(
      result,
      result.action === "accept" ? { confirmed: true } : null,
    );
  }

  const sentAt = Date.now();
  const delivery = (async () => {
    try {
      let result: ElicitationResult;
      let output: unknown;
      if (urlElicitation) {
        if (!elicitUrl) return;
        result = await elicitUrl({
          mode: "url",
          message: urlElicitation.message,
          url: urlElicitation.url,
          elicitationId: p.pending.id,
        });
        if (result.action === "accept") {
          await acknowledgeNativeUrlElicitation(
            {
              tenant_id: p.principal.tenant_id,
              id: p.pending.id,
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
              id: p.pending.id,
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
            conversation_id: p.pending.conversation_id,
            elicitation_id: p.pending.id,
            elapsed_ms: Date.now() - sentAt,
          });
          return;
        }
        output =
          result.action === "accept"
            ? mapElicitResultToAskUserOutput(toolName, p.pending.input, result.content)
            : null;
        if (result.action === "accept" && output !== null) {
          const verdict = validateElicitationAnswer(toolName, p.pending.input, output);
          if (!verdict.ok) {
            const detail = verdict.field_errors.map((e) => `${e.name}: ${e.message}`).join("; ");
            result = await elicitForm({
              message: `${formMapping.message}\n\nThe previous answer was invalid — ${detail}. Please correct and resubmit.`,
              requestedSchema: formMapping.requestedSchema,
            });
            output =
              result.action === "accept"
                ? mapElicitResultToAskUserOutput(toolName, p.pending.input, result.content)
                : null;
          }
        }
      }
      await stageAnswerAndResume(result, output);
    } catch (err) {
      await releaseNativeElicitationDelivery(
        {
          tenant_id: p.principal.tenant_id,
          id: p.pending.id,
          lease_id: claim.lease_id,
          error_code: "transport_failed",
        },
        p.db,
      );
      logger.warn({
        module: "mcp",
        action: "mcp.elicitation.native_transport_failed",
        msg: "native MCP elicitation failed; pending row remains retryable",
        tenant_id: p.principal.tenant_id,
        conversation_id: p.pending.conversation_id,
        elicitation_id: p.pending.id,
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
    conversation_id: p.pending.conversation_id,
    phase: "awaiting_human_input",
    pending_elicitation_id: p.pending.id,
  });
}

function successText(obj: unknown): NativeDeliveryResult {
  return { isError: false, content: [{ type: "text", text: JSON.stringify(obj) }] };
}

function errorText(message: string): NativeDeliveryResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
