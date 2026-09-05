// MCP conversation tool cluster.
//
// Exposes the authoring-session tools over the MCP transport:
//
//   - conversation_start(connector_id?, workflow_id?, message)
//   - conversation_append(conversation_id, message)
//   - conversation_respond_elicitation(conversation_id, elicitation_id, output, reason?)
//   - conversation_get(conversation_id)            ← fast read-only poll
//   - conversation_commit(conversation_id)
//
// MCP async Tasks (SEP-1686). A conversation turn takes 68-160s — far
// past the ~60s MCP client timeout. So the three turn-driving tools
// NEVER run the model loop inline. Each one:
//   1. inserts/validates the conversation row + persists the user
//      message row,
//   2. inserts an `mcp_tasks` index row + enqueues a
//      `conversation.run-turn` pg-boss job (the worker runs the loop),
//   3. returns immediately.
//
// A Tasks-capable client (the SDK sets `request.params.task`) gets a
// `CreateTaskResult`; it then polls `tasks/get` + `tasks/result`. A
// non-Tasks client gets a plain `CallToolResult` text body telling it
// to poll the `conversation_get` tool. Either way the `tools/call`
// returns in milliseconds.

import { randomUUID } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { principalOrigin } from "../../auth/origin.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { type ElicitationRecord, getElicitation } from "../../conversations/elicitations.ts";
import { findResumableAuthoringConversation } from "../../conversations/resumable-authoring.ts";
import * as svc from "../../conversations/service.ts";
import {
  approvalHandleFromElicitationInput,
  elicitationInputForClient,
} from "../../conversations/tools/ask-user/commit-intent.ts";
import { suggestConversationsByTopic } from "../../conversations/topic-routing.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import { enqueueConversationRunTurn } from "../../queue/handlers/conversation-run-turn.ts";
import { getBoss } from "../../queue/index.ts";
import { MCP_ELICITATION_BLURB } from "../../tools/policy.ts";
import { toMcpErrorText } from "../error-adapter.ts";
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

export const CONVERSATION_TOOL_PREFIX = "conversation_";

// ── Zod input schemas ─────────────────────────────────────────────────────────
// Zod-first: the JSON Schema the MCP client sees is generated from
// these, never hand-rolled.

const StartArgs = z.object({
  connector_id: z.string().optional(),
  workflow_id: z.string().optional(),
  message: z.string(),
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
  return [
    {
      name: "conversation_start",
      title: "Start conversation",
      // IMPORTANT: do NOT name the engine-internal authoring steps here. A
      // strict client (ChatGPT/codex) reads identifiers in a description as
      // callable tool names and tries to invoke a phantom `author_workflow`
      // tool that this surface does not expose — which aborts its turn. State
      // only that THIS tool is the authoring entry point.
      description: `Create or edit a workflow or connector, or set up the domain knowledge and conventions that ground authoring (knowledge sources and skills) — this is the ONLY way to author on this surface, and the entry point for OAuth authorization. There is no separate build, draft, or dry-run tool to call: the engine performs every authoring step inside this conversation and surfaces the results to you here. Opens a new authoring conversation and runs the first turn in the background — returns immediately with a task to poll via conversation_get. ${MCP_ELICITATION_BLURB}.`,
      inputSchema: jsonSchema(StartArgs),
      // Authoring entry point: a write, but non-destructive — it opens a
      // conversation; the real mutations stay confirm-gated inside the turn.
      // Without this hint a strict client (ChatGPT/codex) blocks the call.
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
}

export interface HandleConversationToolParams {
  db: Db;
  principal: ResolvedPrincipal;
  name: string;
  args: Record<string, unknown>;
  /**
   * Permission mode pulled from the tool-call `_meta.sk_permission_mode`.
   * Matches the sk REPL + HTTP surface contract (auto / ask / plan).
   * When undefined, the conversation falls back to the tenant default.
   */
  permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
  /**
   * Playground/sandbox flag pulled from the tool-call `_meta.sk_playground`.
   * Additive and out-of-band — the `conversation_start` INPUT schema
   * (`StartArgs`) is deliberately untouched (no OpenAPI drift), mirroring
   * how `permission_mode` rides on `_meta.sk_permission_mode`. Only honoured
   * by `conversation_start`; ignored for append / respond.
   */
  playground?: boolean;
  /**
   * True when the `tools/call` request carried `params.task` — the SDK
   * gates this on the client's advertised `tasks` capability, so its
   * presence means the client is Tasks-capable. Tasks-capable clients
   * receive a `CreateTaskResult`; everyone else gets a plain
   * `CallToolResult` telling them to poll `conversation_get`.
   */
  taskAugmented?: boolean;
  /** Live MCP request channel used only while servicing conversation_get. */
  nativeElicitation?: NativeElicitationTransport;
}

export interface HandleConversationToolResult {
  isError: boolean;
  content: Array<{ type: "text" } & { text: string }>;
  /**
   * Set ONLY for a Tasks-capable, turn-driving call. When present the
   * tools.ts handler returns it verbatim as the `CreateTaskResult`
   * instead of the `content` envelope.
   */
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

/**
 * Insert the `mcp_tasks` index row, enqueue the `conversation.run-turn`
 * job, and shape the fast response. Shared by all three turn-driving
 * conversation tools.
 *
 * `user_message_id` pins the exact `conversation_messages` user row the
 * worker must run the turn on — without it the worker would pick the
 * most-recent row and a second turn racing in on the same conversation
 * would run on the wrong message. `null` for `respond_elicitation`
 * (no new user message). The `respond_elicitation` answer is staged on
 * the elicitation row by the caller BEFORE this runs, so the job
 * envelope carries no payload body.
 */
async function backgroundTurn(p: {
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
  /**
   * Set when a conversation_start was deduplicated onto an existing
   * conversation — surfaced in the plain response body so the client
   * knows the id it got back is a resumed conversation, not a new one.
   */
  resumed?: boolean;
}): Promise<HandleConversationToolResult> {
  const taskId = p.reuse_task_id
    ? p.reuse_task_id
    : await insertMcpTask(
        {
          tenant_id: p.principal.tenant_id,
          conversation_id: p.conversation_id,
          kind: p.kind,
          actor_id: p.principal.id,
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
        actor_id: p.principal.id,
      },
      p.db,
    );
    if (!rearmed) return errorText("task not found while resuming native elicitation");
  }

  // Enqueue the run-turn job. If `boss.send` throws (queue down) or
  // returns null (pg-boss dedup), the `mcp_tasks` row exists with no
  // job — `deriveTask` would report `working` forever. Mark the row
  // `failed` and return a structured error instead of a fake `working`.
  let jobId: string | null;
  const attemptId = randomUUID();
  try {
    // Bind the attempt BEFORE making it visible to pg-boss. A native
    // elicitation resume reuses the public task id while the pausing worker may
    // still be unwinding; pre-binding makes that older worker's terminal write
    // fail its compare-and-set instead of clobbering this resume.
    await setMcpTaskJobId(p.principal.tenant_id, taskId, attemptId, p.db);
    jobId = await enqueueConversationRunTurn(
      getBoss(),
      {
        tenant_id: p.principal.tenant_id,
        conversation_id: p.conversation_id,
        mcp_task_id: taskId,
        actor_id: p.principal.id,
        // Thread the initiating principal so the queue worker can run
        // RBAC-gated tools (run_workflow) instead of failing
        // principal_required — see ConversationRunTurnJob.principal.
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
    // Tasks-capable client — return a CreateTaskResult. The SDK
    // surfaces `task` and the client polls `tasks/get` + `tasks/result`.
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
  // Non-Tasks client — return a plain text body steering it to the
  // `conversation_get` poll tool.
  return successText({
    conversation_id: p.conversation_id,
    mcp_task_id: taskId,
    ...(p.resumed ? { resumed: true } : {}),
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
        answer_channel: "mcp_native",
        ...(resume.reuse_task_id ? { reuse_task_id: resume.reuse_task_id } : {}),
        ...(resume.reason ? { reason: resume.reason } : {}),
        ...(resume.permission_mode ? { permission_mode: resume.permission_mode } : {}),
      }),
  });
}

/**
 * Refuse a `conversation_respond_elicitation` that would resolve a HUMAN's
 * approval decision, or `null` when the elicitation is an ordinary question the
 * model may answer.
 *
 * `conversation_*` deliberately bypasses `dispatchTool` (these are session RPCs,
 * not palette tools), so `policyDecide` never sees this call. That routing is why
 * the guard lives here, at the surface that owns the door — not because the
 * policy gate is optional.
 *
 * Tenant- and conversation-scoped by `getElicitation` + the id comparison: a
 * foreign row cannot be probed for its approval handle. A row the caller may not
 * see reads as "no handle" and falls through to `stageElicitationAnswer`, whose
 * own `(tenant, conversation, id)` predicate then answers `not_found`.
 */
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
  // The human-reachable channel, when the gate persisted one. Naming it is the
  // difference between a model that can hand the user a working link and one
  // that reports a dead end: the previous copy sent every caller to "the chat UI
  // where it was raised", which for an MCP client is nowhere.
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
      // Idempotency: one re-issued intent ("create workflow <slug>") used
      // to spawn several conversations and fragment the authoring state.
      // If this principal already has a recent, non-terminal conversation
      // authoring the SAME named slug, resume it instead of creating a
      // duplicate. Tightly scoped (same owner, same slug token, short
      // window, non-terminal) so it never attaches to the wrong one.
      // A playground start is always a fresh scratch surface — never
      // resume (and possibly adopt) a normal authoring conversation.
      const resumable = playground
        ? null
        : await findResumableAuthoringConversation(
            principal.tenant_id,
            principal.id,
            parsed.data.message,
            db,
            {
              ...(parsed.data.workflow_id ? { workflow_id: parsed.data.workflow_id } : {}),
              ...(parsed.data.connector_id ? { connector_id: parsed.data.connector_id } : {}),
            },
          );
      if (resumable) {
        // A resumed start is an APPEND, not a no-op: the incoming message
        // must land in the resumed conversation and run a turn. The old
        // behaviour — returning `working` without persisting the message
        // or enqueueing anything — silently dropped the user's intent and
        // left the client polling a conversation that was never going to
        // move (observed live: every start funnelled into one stuck
        // conversation and every new message vanished).
        const appended = await svc.appendUserMessage(
          {
            tenant_id: principal.tenant_id,
            conversation_id: resumable.conversation_id,
            actor_id: principal.id,
            message: parsed.data.message,
            ...(permission_mode ? { permission_mode } : {}),
          },
          db,
        );
        return backgroundTurn({
          db,
          principal,
          conversation_id: resumable.conversation_id,
          kind: "append",
          user_message_id: appended.message_id,
          resumed: true,
          ...(permission_mode ? { permission_mode } : {}),
          ...(taskAugmented ? { taskAugmented } : {}),
        });
      }
      const created = await svc.createConversation(
        {
          tenant_id: principal.tenant_id,
          actor_id: principal.id,
          ...(parsed.data.connector_id ? { connector_id: parsed.data.connector_id } : {}),
          ...(parsed.data.workflow_id ? { workflow_id: parsed.data.workflow_id } : {}),
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
        // The first user-message row id — pins the worker to THIS
        // message even if a concurrent append lands first.
        user_message_id: created.initial_message_id,
        ...(permission_mode ? { permission_mode } : {}),
        ...(taskAugmented ? { taskAugmented } : {}),
      });
    }

    if (name === "conversation_append") {
      const parsed = AppendArgs.safeParse(args);
      if (!parsed.success) return errorText("conversation_id and message are required");
      // appendUserMessage validates the conversation, refuses with
      // PendingElicitationBlockedError when an ask_user_* is open, and
      // persists the user message row — all fast, no model loop. It
      // returns the persisted row id so the worker runs THIS turn's
      // message under concurrent appends.
      const appended = await svc.appendUserMessage(
        {
          tenant_id: principal.tenant_id,
          conversation_id: parsed.data.conversation_id,
          actor_id: principal.id,
          message: parsed.data.message,
          ...(permission_mode ? { permission_mode } : {}),
        },
        db,
      );
      return backgroundTurn({
        db,
        principal,
        conversation_id: parsed.data.conversation_id,
        kind: "append",
        user_message_id: appended.message_id,
        ...(permission_mode ? { permission_mode } : {}),
        ...(taskAugmented ? { taskAugmented } : {}),
      });
    }

    if (name === "conversation_respond_elicitation") {
      const parsed = RespondElicitationArgs.safeParse(args);
      if (!parsed.success) {
        return errorText("conversation_id and elicitation_id are required");
      }
      // An elicitation whose commit_intent names an approval_id is not a
      // question — it IS the approval. Resolving it makes the harness claim a
      // single-use capability over args the engine encrypted, and this tool is
      // called by the MODEL. Letting it answer `{confirmed:true}` here would let
      // the model grant the very approval the policy gate raised, through a door
      // that never passes `policyDecide`.
      //
      // Every other elicitation kind (form, choice, text, multi) stays
      // model-resolvable: relaying the user's typed answer is what they are for.
      const refusal = await refuseApprovalElicitation(db, principal, parsed.data);
      if (refusal) return refusal;
      // Stage the answer onto the `conversation_elicitations.output`
      // column BEFORE enqueue. An `ask_user_form` answer can exceed
      // pg-boss' 8 KB envelope cap; staging it here keeps the job
      // envelope to ids only. The row stays `pending` so the worker's
      // `respondElicitation` still drives the real resolve + resume.
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
        principal,
        conversation_id: parsed.data.conversation_id,
        kind: "respond_elicitation",
        user_message_id: null,
        elicitation_id: parsed.data.elicitation_id,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        ...(permission_mode ? { permission_mode } : {}),
        ...(taskAugmented ? { taskAugmented } : {}),
      });
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
    return errorText(toMcpErrorText(err));
  }
}

/**
 * Fast read-only poll. Joins the conversation to its most recent
 * `mcp_tasks` row and reports the derived task status, the terminal
 * envelope when finished, and the pending elicitation form when input
 * is required.
 */
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

  // No task yet (or a conversation created outside the MCP async path)
  // — report the conversation's own status so the client is never stuck.
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

  // The turn finished but the conversation paused at `awaiting_input`
  // (a backgrounded turn uses the DB-pause elicitation path — it has no
  // live MCP session). Report `input_required` with the pending form so
  // the client resolves it via `conversation_respond_elicitation`.
  //
  // BUT: a `respond_elicitation` task that has not finished yet is
  // actively resolving the pending elicitation — the conversation still
  // reads `awaiting_input` until the worker resolves it. Treat that as
  // `working`, not `input_required`, so the client keeps polling
  // instead of re-submitting the same answer.
  //
  // "Actively resolving" must key on a DURABLE marker, not merely
  // `!result`. If a respond-turn CRASHED before its job was enqueued
  // (the `mcp_tasks` row is inserted BEFORE `setMcpTaskJobId` — see
  // backgroundTurn), the row has no `job_id`, no `result`, no
  // `failure_reason` and no `cancelled_at`. Keying only on `!result`
  // would then read `working` forever and permanently suppress the
  // still-pending elicitation, so the user could never re-answer it.
  // Requiring `job_id` means: no enqueued job ⇒ not in flight ⇒ surface
  // the pending elicitation so the client can resolve it. The
  // failure/cancel checks are redundant with the early returns above but
  // stated here so the predicate is correct on its own terms.
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
    // Lean projection: drop the live-streaming replay frames and truncate
    // oversized payloads so a poll client gets status + final message + tool
    // outcomes, not the token-by-token replay (thesis T1). Shape preserved.
    const leanResult = projectTurnEnvelopeForClient(latest.result, {
      pending_elicitation_id: pending?.id ?? null,
    });
    if (pending) {
      return successText({
        status: "input_required",
        conversation_id,
        pending_elicitation_id: pending.id,
        // `pending` is the raw `conversation_elicitations` row. This reply is a
        // model-facing tool result, so it carries the prompt the operator's
        // client renders and not the approval handle the harness reads.
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

  // Still running — `input_required` when the turn paused mid-flight,
  // otherwise a `working` heartbeat so the client can tell an actively
  // building turn from a hung one and keeps polling.
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

/**
 * Shape the `working` heartbeat for a still-running turn. `elapsed_ms`
 * is measured from `since_ms` (the active turn's start), and
 * phase/last_action/step come from the newest `conversation_tool_calls`
 * row — read-side only, no schema migration. Before any tool has run
 * (`progress` null) it reports `phase: "starting"` with a null
 * last_action, which is the honest "just began" state.
 */
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

  // A parked turn is NOT "working". It hit a provider usage limit and was
  // re-enqueued for a named future instant. Reporting it as `working` with
  // `phase: "starting"` is what turned a 21-hour provider-quota wait into a
  // hunt for a hung worker: the honest reason existed only in the engine log.
  // Say it plainly, and say when it resumes.
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
