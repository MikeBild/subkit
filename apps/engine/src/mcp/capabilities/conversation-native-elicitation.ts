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

/**
 * How long a wire `elicitation/create` stays pending, and therefore how
 * long the client-rendered form can still be answered. Agentic clients
 * (Claude Code) render a mid-turn elicitation only AFTER their own agent
 * turn completes — minutes, not seconds — so the SDK's 60s default
 * guarantees a timeout there. Delivery is non-blocking (the poll call
 * returns immediately); this bound only caps the detached round-trip so
 * an abandoned form eventually releases its delivery lease for a fresh
 * re-prompt.
 */
export const ELICITATION_FORM_TIMEOUT_MS = 5 * 60_000;

/**
 * Delivery-lease window for a wire elicitation. Slightly longer than the
 * round-trip timeout so the in-flight request always settles (and
 * releases the lease itself) before a concurrent poll can claim the row
 * and put a SECOND live form in front of the operator.
 */
export const ELICITATION_DELIVERY_LEASE_MS = ELICITATION_FORM_TIMEOUT_MS + 15_000;

/**
 * How long the poll call is held open after firing `elicitation/create`.
 * Clients accept an elicitation only in the context of an active request
 * and auto-cancel "unsolicited" ones (observed: Claude Code cancels in
 * ~16ms when the request lands after the tool result was written, but
 * queues the same request for its end-of-turn form UI when it lands
 * while the call is in flight). The grace keeps the call open just long
 * enough for the elicitation to reach the client inside that window —
 * it never waits for the human answer.
 */
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

  // Replay arm — a URL interaction already finished out-of-band; there is
  // no wire round-trip left, so resolve synchronously.
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

  // Wire arm — NON-BLOCKING. The `elicitation/create` round-trip must not
  // hold this `tools/call` open: agentic clients (Claude Code) render the
  // form only after their own agent turn completes, and their turn cannot
  // complete while this call blocks — a deadlock the old awaiting shape
  // always lost to the request timeout. Fire the round-trip, let a
  // detached continuation stage the answer and resume the conversation
  // when it lands, and hand `input_required` back immediately so the
  // client's turn can end and the human can actually see the form.
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
        // A cancel faster than a human could read the form is the client
        // auto-cancelling without rendering — a transport verdict, not a
        // decision. Release the lease so a later poll re-prompts.
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

  // Hold the poll open for a short grace so the `elicitation/create`
  // reaches the client while this call is still in flight — never for
  // the human's answer. If the round-trip settles inside the grace (an
  // instant auto-cancel, a lightning-fast answer), the continuation has
  // already done its work; either way the poll returns promptly so the
  // client's agent turn can end and the operator can see the form.
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
