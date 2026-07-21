import type { ResolvedPrincipal } from "../../auth/types.ts";
import type {
  ElicitationResult,
  ElicitFormParams,
  ElicitOobParams,
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
): { url: string; message: string } | null {
  if (!pending.input || typeof pending.input !== "object" || Array.isArray(pending.input)) {
    return null;
  }
  const input = pending.input as Record<string, unknown>;
  const candidate = input.authorization_url ?? input.setup_url;
  if (typeof candidate !== "string" || !/^https?:\/\//i.test(candidate)) return null;
  const message =
    typeof input.summary === "string" && input.summary.length > 0 ? input.summary : pending.summary;
  return { url: candidate, message };
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
  const urlElicitation = pendingUrlElicitation(p.pending);
  const mapped = urlElicitation ? null : mapAskUserToPrimitiveSchema(toolName, p.pending.input);
  const formMapping = mapped && !mapped.degrade ? mapped : null;
  const elicitForm = p.nativeElicitation.elicitForm;
  const elicitUrl = p.nativeElicitation.elicitUrl;
  if (urlElicitation && !elicitUrl) return null;
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

  try {
    let result: ElicitationResult;
    let output: unknown;
    if (
      urlElicitation &&
      (p.pending.delivery_last_error === "url_completed" ||
        p.pending.delivery_last_error === "url_failed")
    ) {
      result = {
        action: p.pending.delivery_last_error === "url_completed" ? "accept" : "cancel",
      };
      output = result.action === "accept" ? { confirmed: true } : null;
    } else if (urlElicitation) {
      if (!elicitUrl) return null;
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
        return successText({
          status: "input_required",
          conversation_id: p.pending.conversation_id,
          phase: "external_interaction_pending",
          pending_elicitation_id: p.pending.id,
        });
      }
      output = null;
    } else {
      if (!formMapping || !elicitForm) return null;
      result = await elicitForm({
        message: formMapping.message,
        requestedSchema: formMapping.requestedSchema,
      });
      output =
        result.action === "accept"
          ? mapElicitResultToAskUserOutput(toolName, p.pending.input, result.content)
          : null;
    }

    if (
      !urlElicitation &&
      formMapping &&
      elicitForm &&
      result.action === "accept" &&
      output !== null
    ) {
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
    return successText({
      status: "input_required",
      conversation_id: p.pending.conversation_id,
      pending_elicitation_id: p.pending.id,
      error_code: "elicitation_transport_failed",
    });
  }
}

function successText(obj: unknown): NativeDeliveryResult {
  return { isError: false, content: [{ type: "text", text: JSON.stringify(obj) }] };
}

function errorText(message: string): NativeDeliveryResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
