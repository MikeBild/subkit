import { randomUUID } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actorOf } from "../../audit/actor.ts";
import { principalOrigin } from "../../auth/origin.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { type ElicitationRecord, getElicitation } from "../../conversations/elicitations.ts";
import * as svc from "../../conversations/service.ts";
import {
  approvalHandleFromElicitationInput,
  elicitationInputForClient,
} from "../../conversations/tools/ask-user/commit-intent.ts";
import { resolvePublicBaseUrl } from "../../conversations/tools/usage-guidance.ts";
import { suggestConversationsByTopic } from "../../conversations/topic-routing.ts";
import { withReservedConversationTurn } from "../../conversations/turns.ts";
import type { Db } from "../../db/client.ts";
import * as intake from "../../knowledge/index.ts";
import { logger } from "../../logging/logger.ts";
import { enqueueConversationRunTurn } from "../../queue/handlers/conversation-run-turn.ts";
import { getBoss } from "../../queue/index.ts";
import { can } from "../../rbac/evaluator.ts";
import { MCP_ELICITATION_BLURB } from "../../tools/policy.ts";
import { mcpErrorCodeOf, toMcpErrorText } from "../error-adapter.ts";
import { zodToJsonSchema7 } from "../json-schema.ts";
import {
  insertMcpTask,
  rearmMcpTaskForNativeElicitation,
  setMcpTaskFailure,
  setMcpTaskJobId,
} from "../tasks/store.ts";
import {
  CONVERSATION_TASK_POLL_INTERVAL_MS,
  CONVERSATION_TASK_TTL_MS,
} from "../tasks/task-store.ts";
import { readConversationCommit } from "./conversation-commit.ts";
import {
  deliverPendingNativeElicitationCore,
  type NativeElicitationTransport,
} from "./conversation-native-elicitation.ts";
import { buildToolAnnotations } from "./tool-meta.ts";
import { projectTurnEnvelopeForClient } from "./turn-projection.ts";

const CONVERSATION_TOOL_PREFIX = "conversation_";

const conversationToolNames = new Set<string>();

export function isConversationToolName(name: string): boolean {
  if (name.startsWith(CONVERSATION_TOOL_PREFIX)) return true;
  if (!conversationToolNames.has(name)) listConversationTools();
  return conversationToolNames.has(name);
}

const StartArgs = z.object({
  connector_id: z.string().optional(),
  workflow_id: z.string().optional(),
  message: z.string(),
  intake_item_ids: z.array(z.string().uuid()).min(1).max(100).optional(),
});
const AppendArgs = z.object({
  conversation_id: z.string(),
  message: z.string(),
});
const RespondElicitationArgs = z.object({
  conversation_id: z.string(),
  elicitation_id: z.string(),
  output: z.unknown(),
  reason: z.string().optional(),
});
const GetArgs = z.object({
  conversation_id: z.string(),
});
const CommitArgs = z.object({
  conversation_id: z.string(),
});
const SuggestRelatedArgs = z.object({
  message: z.string().min(1),
});

function jsonSchema(schema: z.ZodTypeAny): Tool["inputSchema"] {
  return zodToJsonSchema7(schema) as Tool["inputSchema"];
}

export function listConversationTools(): Tool[] {
  const tools: Tool[] = [
    {
      name: "conversation_start",
      title: "Start conversation",
      description: `Create or edit a workflow or connector, or set up the domain knowledge and conventions that ground authoring (knowledge sources and skills) — this is the ONLY way to author on this surface, and the entry point for OAuth authorization. There is no separate build, draft, or dry-run tool to call: the engine performs every authoring step inside this conversation and surfaces the results to you here. Pass intake_item_ids to begin a persisted, selected clip review; inspect and prepare the clips in the conversation, then use its authenticated Cockpit conversation link for a person's final knowledge confirmation. Opens a new authoring conversation and runs the first turn in the background — returns immediately with a task to poll via conversation_get. ${MCP_ELICITATION_BLURB}.`,
      inputSchema: jsonSchema(StartArgs),
      annotations: buildToolAnnotations("tenant_write", "conversation_start"),
      execution: { taskSupport: "optional" },
    },
    {
      name: "conversation_append",
      title: "Append to conversation",
      description: `Continue an authoring conversation — append a user message and run another turn in the background. Returns immediately with a task to poll; use this to answer the engine's questions or steer connector/workflow authoring. ${MCP_ELICITATION_BLURB}.`,
      inputSchema: jsonSchema(AppendArgs),
      annotations: buildToolAnnotations("tenant_write", "conversation_append"),
      execution: { taskSupport: "optional" },
    },
    {
      name: "conversation_respond_elicitation",
      title: "Respond to elicitation",
      description:
        "Resolve a pending ask_user_* elicitation with the user's answer and resume the loop in the background. Returns immediately with a task to poll.",
      inputSchema: jsonSchema(RespondElicitationArgs),
      annotations: buildToolAnnotations("tenant_write", "conversation_respond_elicitation"),
      execution: { taskSupport: "optional" },
    },
    {
      name: "conversation_get",
      title: "Get conversation",
      description:
        "Poll the state of a backgrounded conversation turn. Returns status (working | completed | failed | input_required), the turn events when finished, the pending elicitation form when input is required, and the committed workflow id when committed. While status is working it also carries a heartbeat — phase, elapsed_ms, and last_action (the newest authoring step) — so you can tell an in-progress turn from a hung one; keep polling until status is no longer working.",
      inputSchema: jsonSchema(GetArgs),
      annotations: buildToolAnnotations("tenant_read", "conversation_get"),
      execution: { taskSupport: "forbidden" },
    },
    {
      name: "conversation_commit",
      title: "Get committed workflow",
      description:
        "Report the persisted commit state of a conversation's workflow — the version written, its id, and the steps present, read from the persisted rows. Read-only: it never persists anything; a draft with unpersisted edits returns a NOT COMMITTED error instead of success.",
      inputSchema: jsonSchema(CommitArgs),
      annotations: buildToolAnnotations("tenant_read", "conversation_commit"),
      execution: { taskSupport: "forbidden" },
    },
    {
      name: "suggest_related_conversations",
      title: "Suggest related conversations",
      description:
        "Before starting a NEW conversation, check whether this prompt continues a prior one. Returns your prior conversations whose topic is semantically related (ranked, the caller's own only), so you can resume with conversation_append(conversation_id) instead of losing the earlier context — or start fresh if none is returned. Suggestion only: it never resumes anything itself.",
      inputSchema: jsonSchema(SuggestRelatedArgs),
      annotations: buildToolAnnotations("tenant_read", "suggest_related_conversations"),
      execution: { taskSupport: "forbidden" },
    },
  ];
  for (const tool of tools) conversationToolNames.add(tool.name);
  return tools;
}

interface HandleConversationToolParams {
  db: Db;
  principal: ResolvedPrincipal;
  name: string;
  args: Record<string, unknown>;
  permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
  playground?: boolean;
  taskAugmented?: boolean;
  nativeElicitation?: NativeElicitationTransport;
}

export interface HandleConversationToolResult {
  isError: boolean;
  content: Array<{ type: "text" } & { text: string }>;
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

function cockpitConversationHandoff(conversationId: string): {
  conversation_url?: string;
  conversation_path: string;
  conversation_next_action: string;
} {
  const conversation_path = `/cockpit/chat/${encodeURIComponent(conversationId)}`;
  const base = resolvePublicBaseUrl();
  if (base) {
    return {
      conversation_url: `${base}${conversation_path}`,
      conversation_path,
      conversation_next_action:
        "Open the authenticated Cockpit conversation to continue review and preparation. A person must confirm any intake proposal before it becomes knowledge or a skill.",
    };
  }
  return {
    conversation_path,
    conversation_next_action:
      "Open this path in the authenticated Cockpit to continue review and preparation. A person must confirm any intake proposal before it becomes knowledge or a skill.",
  };
}

type BackgroundTurnParams = {
  turn_id?: string;
  db: Db;
  principal: ResolvedPrincipal;
  conversation_id: string;
  kind: "start" | "append" | "respond_elicitation";
  user_message_id: string | null;
  permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
  elicitation_id?: string;
  reason?: string;
  taskAugmented?: boolean;
  answer_channel?: "model_relay" | "mcp_native";
  reuse_task_id?: string;
  resumed?: boolean;
  conversation_url?: string;
  conversation_path?: string;
  conversation_next_action?: string;
};

async function backgroundTurn(p: BackgroundTurnParams): Promise<HandleConversationToolResult> {
  return p.turn_id
    ? backgroundTurnReserved({ ...p, turn_id: p.turn_id })
    : withReservedConversationTurn(p.db, p.principal.tenant_id, p.conversation_id, (turn_id) =>
        backgroundTurnReserved({ ...p, turn_id }),
      );
}

async function backgroundTurnReserved(
  p: BackgroundTurnParams & { turn_id: string },
): Promise<HandleConversationToolResult> {
  const taskId = p.reuse_task_id
    ? p.reuse_task_id
    : await insertMcpTask(
        {
          tenant_id: p.principal.tenant_id,
          conversation_id: p.conversation_id,
          kind: p.kind,
          actor: actorOf(p.principal),
          request_source: "mcp",
          user_message_id: p.user_message_id,
        },
        p.db,
      );
  if (p.reuse_task_id) {
    const rearmed = await rearmMcpTaskForNativeElicitation(
      {
        tenant_id: p.principal.tenant_id,
        task_id: taskId,
        actor: actorOf(p.principal),
      },
      p.db,
    );
    if (!rearmed) return errorText("task not found while resuming native elicitation");
  }

  let jobId: string | null;
  const attemptId = randomUUID();
  try {
    await setMcpTaskJobId(p.principal.tenant_id, taskId, attemptId, p.db);
    jobId = await enqueueConversationRunTurn(
      getBoss(),
      p.db,
      {
        tenant_id: p.principal.tenant_id,
        conversation_id: p.conversation_id,
        mcp_task_id: taskId,
        turn_id: p.turn_id,
        actor_id: p.principal.id,
        principal: p.principal,
        kind: p.kind,
        ...(p.permission_mode ? { permission_mode: p.permission_mode } : {}),
        ...(p.elicitation_id ? { elicitation_id: p.elicitation_id } : {}),
        ...(p.answer_channel ? { answer_channel: p.answer_channel } : {}),
        ...(p.reason ? { reason: p.reason } : {}),
      },
      { id: attemptId },
    );
  } catch (err) {
    await setMcpTaskFailure(p.principal.tenant_id, taskId, "enqueue_failed", p.db);
    return errorText(
      `failed to enqueue conversation turn: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!jobId) {
    await setMcpTaskFailure(p.principal.tenant_id, taskId, "enqueue_failed", p.db);
    return errorText("failed to enqueue conversation turn: queue rejected the job");
  }
  if (jobId !== attemptId) {
    await setMcpTaskFailure(p.principal.tenant_id, taskId, "enqueue_id_mismatch", p.db);
    return errorText("failed to enqueue conversation turn: queue returned an unexpected job id");
  }

  const now = new Date().toISOString();
  if (p.taskAugmented) {
    return {
      isError: false,
      content: [],
      createTaskResult: {
        task: {
          taskId,
          status: "working",
          ttl: CONVERSATION_TASK_TTL_MS,
          createdAt: now,
          lastUpdatedAt: now,
          pollInterval: CONVERSATION_TASK_POLL_INTERVAL_MS,
        },
      },
    };
  }
  return successText({
    conversation_id: p.conversation_id,
    mcp_task_id: taskId,
    turn_id: p.turn_id,
    ...(p.resumed ? { resumed: true } : {}),
    ...(p.conversation_url ? { conversation_url: p.conversation_url } : {}),
    ...(p.conversation_path ? { conversation_path: p.conversation_path } : {}),
    ...(p.conversation_next_action ? { conversation_next_action: p.conversation_next_action } : {}),
    status: "working",
    poll_with: "conversation_get",
    poll_arg: { conversation_id: p.conversation_id },
  });
}

export async function deliverPendingNativeElicitation(p: {
  db: Db;
  principal: ResolvedPrincipal;
  pending: ElicitationRecord;
  nativeElicitation: NativeElicitationTransport;
  permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
  reuse_task_id?: string;
}): Promise<HandleConversationToolResult | null> {
  return deliverPendingNativeElicitationCore({
    ...p,
    resume: async (resume) =>
      await backgroundTurn({
        db: p.db,
        principal: p.principal,
        conversation_id: p.pending.conversation_id,
        kind: "respond_elicitation",
        user_message_id: null,
        elicitation_id: p.pending.id,
        ...(resume.turn_id ? { turn_id: resume.turn_id } : {}),
        answer_channel: "mcp_native",
        ...(resume.reuse_task_id ? { reuse_task_id: resume.reuse_task_id } : {}),
        ...(resume.reason ? { reason: resume.reason } : {}),
        ...(resume.permission_mode ? { permission_mode: resume.permission_mode } : {}),
      }),
  });
}

async function refuseApprovalElicitation(
  db: Db,
  principal: ResolvedPrincipal,
  args: { conversation_id: string; elicitation_id: string },
): Promise<HandleConversationToolResult | null> {
  const row = await getElicitation(principal.tenant_id, args.elicitation_id, db);
  if (!row || row.conversation_id !== args.conversation_id) return null;
  const approvalId = approvalHandleFromElicitationInput(row.input);
  if (!approvalId) return null;

  logger.warn({
    module: "mcp",
    action: "mcp.conversation.approval_elicitation_refused",
    msg: "conversation_respond_elicitation named an elicitation that carries an approval handle; a model cannot grant a human's approval",
    tool: "conversation_respond_elicitation",
    conversation_id: args.conversation_id,
    elicitation_id: args.elicitation_id,
    approval_id: approvalId,
    elicitation_tool: row.tool_name,
    principal_id: principal.id,
    tenant_id: principal.tenant_id,
  });
  const approvalUrl =
    row.input && typeof row.input === "object" && !Array.isArray(row.input)
      ? (row.input as { approval_url?: unknown }).approval_url
      : undefined;
  const hasUrl = typeof approvalUrl === "string" && approvalUrl.length > 0;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "cannot_help",
          error_code: "approval_requires_human",
          elicitation_id: args.elicitation_id,
          approval_id: approvalId,
          ...(hasUrl ? { approval_url: approvalUrl } : {}),
          message:
            `Elicitation ${args.elicitation_id} is a person's approval decision for approval ${approvalId}, not a question you may answer. ` +
            "Resolving it would perform a write the engine is holding, so this tool refuses it — nothing was written and nothing was resolved. " +
            (hasUrl
              ? "Give the user the approval_url below and let them decide in their browser after signing in; the link selects the pending request but is not an identity or an approval by itself. " +
                "Once they decide, the engine resolves this pause and carries out the held call on its own — you do not need to do anything else, and you must not relay their answer back through this tool. "
              : "The user grants or declines it themselves on the surface where it was raised. "),
          approval_window:
            "Approvals expire 24 hours after they are raised. If nobody decides in time the engine cancels the pause, reactivates the conversation, and the held call never runs.",
          next_best_actions: ["conversation_get"],
        }),
      },
    ],
  };
}

export async function handleConversationTool(
  p: HandleConversationToolParams,
): Promise<HandleConversationToolResult> {
  const {
    db,
    principal,
    name,
    args,
    permission_mode,
    playground,
    taskAugmented,
    nativeElicitation,
  } = p;
  try {
    if (name === "conversation_start") {
      const parsed = StartArgs.safeParse(args);
      if (!parsed.success) return errorText("message is required");
      if (parsed.data.intake_item_ids?.length) {
        const decision = await can(db, {
          tenant_id: principal.tenant_id,
          principal,
          permission: "intake:read",
        });
        if (!decision.allow) return errorText("not authorized to review collected clips");
        const selected = await Promise.all(
          parsed.data.intake_item_ids.map((id) =>
            intake.getIntakeItem(principal.tenant_id, id, db),
          ),
        );
        if (selected.some((item) => item === null))
          return errorText("selected intake item not found");
      }
      const created = await svc.createConversation(
        {
          tenant_id: principal.tenant_id,
          actor_id: principal.id,
          principal,
          ...(parsed.data.connector_id ? { connector_id: parsed.data.connector_id } : {}),
          ...(parsed.data.workflow_id ? { workflow_id: parsed.data.workflow_id } : {}),
          ...(parsed.data.intake_item_ids?.length
            ? { intake_item_ids: parsed.data.intake_item_ids }
            : {}),
          initial_message: parsed.data.message,
          ...(permission_mode ? { permission_mode } : {}),
          ...(playground ? { playground } : {}),
          origin_client: principalOrigin(principal),
          surface: "mcp",
        },
        db,
      );
      return backgroundTurn({
        db,
        principal,
        conversation_id: created.conversation.id,
        kind: "start",
        user_message_id: created.initial_message_id,
        ...(permission_mode ? { permission_mode } : {}),
        ...(taskAugmented ? { taskAugmented } : {}),
        ...cockpitConversationHandoff(created.conversation.id),
      });
    }

    if (name === "conversation_append") {
      const parsed = AppendArgs.safeParse(args);
      if (!parsed.success) return errorText("conversation_id and message are required");
      return await withReservedConversationTurn(
        db,
        principal.tenant_id,
        parsed.data.conversation_id,
        async (turn_id) => {
          const appended = await svc.appendUserMessage(
            {
              tenant_id: principal.tenant_id,
              conversation_id: parsed.data.conversation_id,
              actor_id: principal.id,
              principal,
              message: parsed.data.message,
              turn_id,
              ...(permission_mode ? { permission_mode } : {}),
            },
            db,
          );
          return backgroundTurn({
            db,
            turn_id,
            principal,
            conversation_id: parsed.data.conversation_id,
            kind: "append",
            user_message_id: appended.message_id,
            ...(permission_mode ? { permission_mode } : {}),
            ...(taskAugmented ? { taskAugmented } : {}),
          });
        },
      );
    }

    if (name === "conversation_respond_elicitation") {
      const parsed = RespondElicitationArgs.safeParse(args);
      if (!parsed.success) {
        return errorText("conversation_id and elicitation_id are required");
      }
      const refusal = await refuseApprovalElicitation(db, principal, parsed.data);
      if (refusal) return refusal;
      return await withReservedConversationTurn(
        db,
        principal.tenant_id,
        parsed.data.conversation_id,
        async (turn_id) => {
          const { stageElicitationAnswer } = await import("../../conversations/elicitations.ts");
          const staged = await stageElicitationAnswer(
            {
              tenant_id: principal.tenant_id,
              conversation_id: parsed.data.conversation_id,
              id: parsed.data.elicitation_id,
              output: parsed.data.output,
            },
            db,
          );
          if (staged.kind === "not_found") return errorText("elicitation not found");
          if (staged.kind === "already_resolved") {
            return errorText(`elicitation already ${staged.existing.status}`);
          }
          return backgroundTurn({
            db,
            turn_id,
            principal,
            conversation_id: parsed.data.conversation_id,
            kind: "respond_elicitation",
            user_message_id: null,
            elicitation_id: parsed.data.elicitation_id,
            ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
            ...(permission_mode ? { permission_mode } : {}),
            ...(taskAugmented ? { taskAugmented } : {}),
          });
        },
      );
    }

    if (name === "conversation_get") {
      const parsed = GetArgs.safeParse(args);
      if (!parsed.success) return errorText("conversation_id is required");
      return conversationGet(db, principal, parsed.data.conversation_id, {
        ...(nativeElicitation ? { nativeElicitation } : {}),
        ...(permission_mode ? { permission_mode } : {}),
      });
    }

    if (name === "suggest_related_conversations") {
      const parsed = SuggestRelatedArgs.safeParse(args);
      if (!parsed.success) return errorText("message is required");
      const suggestions = await suggestConversationsByTopic(
        { tenant_id: principal.tenant_id, owner_id: principal.id, message: parsed.data.message },
        db,
      );
      return successText({ suggestions });
    }

    if (name === "conversation_commit") {
      const parsed = CommitArgs.safeParse(args);
      if (!parsed.success) return errorText("conversation_id is required");
      return readConversationCommit(db, principal, parsed.data.conversation_id);
    }

    return errorText(`unknown conversation tool: ${name}`);
  } catch (err) {
    const conversationId =
      typeof args.conversation_id === "string" ? args.conversation_id : undefined;
    logger.warn({
      module: "mcp",
      action: "mcp.conversation_tool.failed",
      msg: "conversation tool call failed",
      tool: name,
      ...(conversationId ? { conversation_id: conversationId } : {}),
      tenant_id: principal.tenant_id,
      principal_id: principal.id,
      error_name: err instanceof Error ? err.name : typeof err,
      error_code: mcpErrorCodeOf(err),
      error: err instanceof Error ? err.message : String(err),
    });
    return errorText(toMcpErrorText(err));
  }
}

async function conversationGet(
  db: Db,
  principal: ResolvedPrincipal,
  conversation_id: string,
  opts: {
    nativeElicitation?: NonNullable<HandleConversationToolParams["nativeElicitation"]>;
    permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
  } = {},
): Promise<HandleConversationToolResult> {
  const detail = await svc.getConversation(principal.tenant_id, conversation_id, db);
  if (!detail) return errorText("conversation not found");

  const { latestMcpTaskForConversation } = await import("../tasks/store.ts");
  const latest = await latestMcpTaskForConversation(principal.tenant_id, conversation_id, db);

  if (!latest) {
    if (detail.conversation.status === "awaiting_input") {
      return successText({ status: "input_required", conversation_id });
    }
    return workingHeartbeat(
      db,
      principal.tenant_id,
      conversation_id,
      Date.parse(detail.conversation.updated_at),
    );
  }

  if (latest.failure_reason) {
    return successText({
      status: "failed",
      conversation_id,
      failure_reason: latest.failure_reason,
    });
  }
  if (latest.cancelled_at) {
    return successText({ status: "cancelled", conversation_id });
  }

  const respondInFlight =
    latest.kind === "respond_elicitation" &&
    latest.job_id != null &&
    !latest.result &&
    !latest.failure_reason &&
    !latest.cancelled_at;
  const pending =
    detail.conversation.status === "awaiting_input" && !respondInFlight
      ? await (async () => {
          const { listElicitationsForConversation } = await import(
            "../../conversations/elicitations.ts"
          );
          return (await listElicitationsForConversation(principal.tenant_id, conversation_id, db))
            .filter((e) => e.status === "pending")
            .at(0);
        })()
      : undefined;

  if (pending && opts.nativeElicitation) {
    const delivered = await deliverPendingNativeElicitation({
      db,
      principal,
      pending,
      nativeElicitation: opts.nativeElicitation,
      reuse_task_id: latest.id,
      ...(opts.permission_mode ? { permission_mode: opts.permission_mode } : {}),
    });
    if (delivered) return delivered;
  }

  if (latest.result) {
    const leanResult = projectTurnEnvelopeForClient(latest.result, {
      pending_elicitation_id: pending?.id ?? null,
    });
    if (pending) {
      return successText({
        status: "input_required",
        conversation_id,
        pending_elicitation_id: pending.id,
        input: elicitationInputForClient(pending.input),
        result: leanResult,
      });
    }
    return successText({
      status: "completed",
      conversation_id,
      ...(leanResult.committed_workflow_id
        ? { committed_workflow_id: leanResult.committed_workflow_id }
        : {}),
      result: leanResult,
    });
  }

  if (pending) {
    return successText({
      status: "input_required",
      conversation_id,
      pending_elicitation_id: pending.id,
      input: elicitationInputForClient(pending.input),
    });
  }
  return workingHeartbeat(db, principal.tenant_id, conversation_id, latest.created_at.getTime());
}

async function workingHeartbeat(
  db: Db,
  tenant_id: string,
  conversation_id: string,
  since_ms: number,
): Promise<HandleConversationToolResult> {
  const { latestProgressForConversation, parkedStateForConversation } = await import(
    "../tasks/store.ts"
  );
  const anchor = Number.isFinite(since_ms) ? since_ms : Date.now();

  const parked = await parkedStateForConversation(tenant_id, conversation_id, db);
  if (parked) {
    return successText({
      status: "working",
      conversation_id,
      phase: "parked",
      elapsed_ms: Math.max(0, Date.now() - anchor),
      last_action: null,
      parked_until: parked.parked_until.toISOString(),
      parked_reason: parked.parked_reason ?? "provider_usage_limit",
      resumes_in_ms: Math.max(0, parked.parked_until.getTime() - Date.now()),
      note: "The turn is not running: the LLM provider reported a usage limit and named a reset time. It resumes on its own at `parked_until` — nothing is stuck, and restarting or opening a new conversation does not help, because a new turn parks the same way. Raise the provider quota to resume sooner.",
    });
  }

  const progress = await latestProgressForConversation(tenant_id, conversation_id, db);
  return successText({
    status: "working",
    conversation_id,
    phase: progress?.phase ?? "starting",
    elapsed_ms: Math.max(0, Date.now() - anchor),
    last_action: progress?.last_action ?? null,
    ...(progress?.step ? { step: progress.step } : {}),
  });
}

function successText(obj: unknown): HandleConversationToolResult {
  return { isError: false, content: [{ type: "text", text: JSON.stringify(obj) }] };
}

function errorText(msg: string): HandleConversationToolResult {
  return { isError: true, content: [{ type: "text", text: msg }] };
}
