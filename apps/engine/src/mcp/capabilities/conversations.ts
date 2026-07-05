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

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { persistedWorkflowResource } from "../../conversations/authoring-state/summary.ts";
import { loadDraft } from "../../conversations/draft.ts";
import { classifyDraftVsPersisted } from "../../conversations/persistence/draft-diff.ts";
import { findResumableAuthoringConversation } from "../../conversations/resumable-authoring.ts";
import * as svc from "../../conversations/service.ts";
import { buildWorkflowUsage } from "../../conversations/tools/usage-guidance.ts";
import { suggestConversationsByTopic } from "../../conversations/topic-routing.ts";
import type { Db } from "../../db/client.ts";
import { enqueueConversationRunTurn } from "../../queue/handlers/conversation-run-turn.ts";
import { getBoss } from "../../queue/index.ts";
import { MCP_ELICITATION_BLURB } from "../../tools/policy.ts";
import { getWorkflow, getWorkflowBySlug } from "../../workflows/service.ts";
import { toMcpErrorText } from "../error-adapter.ts";
import { zodToJsonSchema7 } from "../json-schema.ts";
import { insertMcpTask, setMcpTaskFailure, setMcpTaskJobId } from "../tasks/store.ts";
import {
  CONVERSATION_TASK_POLL_INTERVAL_MS,
  CONVERSATION_TASK_TTL_MS,
} from "../tasks/task-store.ts";
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
// conversation_commit reply — every field under `committed` is read from the
// persisted rows (workflows + workflowVersions), never from the draft, so the
// tool result can only claim what is actually on disk.
const CommitResult = z.object({
  conversation_id: z.string(),
  workflow_id: z.string(),
  status: z.string(),
  committed: z.object({
    workflow_version_id: z.string(),
    version: z.number().int(),
    steps_present: z.number().int(),
    slug: z.string(),
    name: z.string(),
    updated_at: z.string(),
  }),
  draft_state: z.enum(["clean", "empty_draft"]),
  verified_against_draft: z.boolean(),
  note: z.string().optional(),
  usage: z.unknown().optional(),
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
      description: `Create or edit a workflow or connector — this is the ONLY way to author on this surface, and the entry point for OAuth authorization. There is no separate build, draft, or dry-run tool to call: the engine performs every authoring step inside this conversation and surfaces the results to you here. Opens a new authoring conversation and runs the first turn in the background — returns immediately with a task to poll via conversation_get. ${MCP_ELICITATION_BLURB}.`,
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
}): Promise<HandleConversationToolResult> {
  const taskId = await insertMcpTask(
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

  // Enqueue the run-turn job. If `boss.send` throws (queue down) or
  // returns null (pg-boss dedup), the `mcp_tasks` row exists with no
  // job — `deriveTask` would report `working` forever. Mark the row
  // `failed` and return a structured error instead of a fake `working`.
  let jobId: string | null;
  try {
    jobId = await enqueueConversationRunTurn(getBoss(), {
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
      ...(p.reason ? { reason: p.reason } : {}),
    });
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
  await setMcpTaskJobId(p.principal.tenant_id, taskId, jobId, p.db);

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
    status: "working",
    poll_with: "conversation_get",
    poll_arg: { conversation_id: p.conversation_id },
  });
}

export async function handleConversationTool(
  p: HandleConversationToolParams,
): Promise<HandleConversationToolResult> {
  const { db, principal, name, args, permission_mode, playground, taskAugmented } = p;
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
          );
      if (resumable) {
        return successText({
          conversation_id: resumable.conversation_id,
          resumed: true,
          status: "working",
          poll_with: "conversation_get",
          poll_arg: { conversation_id: resumable.conversation_id },
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
      return conversationGet(db, principal, parsed.data.conversation_id);
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
      const detail = await svc.getConversation(
        principal.tenant_id,
        parsed.data.conversation_id,
        db,
      );
      if (!detail) return errorText("conversation not found");

      const draft = await loadDraft(principal.tenant_id, detail.conversation.id, db);

      // Resolve the committed workflow. The conversation row's
      // target_workflow_id is the primary source, but an inline
      // auto-commit (a green dry_run_workflow persists the draft
      // immediately) can leave it null — a later turn-finalization write
      // races the commit's conversation-row update. The draft's bound
      // resource still points at the persisted workflow, so fall back to
      // it and report the commit idempotently instead of a false
      // "no committed workflow" (the poll and the commit must agree).
      let workflowId = detail.conversation.target_workflow_id;
      if (!workflowId) {
        const bound = draft.state ? persistedWorkflowResource(draft.state) : null;
        const resolved = bound?.id
          ? await getWorkflow(principal.tenant_id, bound.id, db)
          : bound?.slug
            ? await getWorkflowBySlug(principal.tenant_id, bound.slug, db)
            : null;
        if (resolved) workflowId = resolved.id;
      }
      if (!workflowId) {
        return errorText("conversation has no committed workflow");
      }
      // Honest reporting (RC2): conversation_commit is a read-only status tool —
      // it does NOT persist the draft. If the working draft still holds workflow
      // STEP edits that are not in the live version, echoing "committed" + usage
      // is a "reported ≠ written" lie (the model narrates success the user never
      // got). Detect that and return a directive error instead. Everything the
      // success reply claims is then read from the persisted rows (workflows +
      // workflowVersions) — never from the draft — so a partial or no-op commit
      // cannot read as success.
      const draftState = await classifyDraftVsPersisted(db, principal.tenant_id, draft, workflowId);
      if (draftState.state === "structural") {
        return errorText(
          "NOT COMMITTED: this conversation's working draft has uncommitted workflow edits — its steps differ from the live version. conversation_commit only reports status; it does not persist. To persist step edits, call save_workflow_draft (after a successful dry_run_workflow). For a metadata-only change (name/description/lifecycle), call update_workflow. Do not tell the user it is committed until a save tool returns ok.",
        );
      }
      if (draftState.state === "no_target" && draftState.reason === "no_persisted_version") {
        return errorText(
          "NOT COMMITTED: the resolved workflow has no persisted version — nothing was written. conversation_commit only reports status; to persist the draft call save_workflow_draft (after a successful dry_run_workflow). Do not tell the user it is committed.",
        );
      }
      if (draftState.state === "no_target" && draftState.reason === "unreadable_dag") {
        return errorText(
          "COMMIT UNVERIFIED: a persisted version exists but its stored definition could not be read, so the commit cannot be confirmed against it. Do not report success; inspect the workflow with get_workflow.",
        );
      }
      // Read the persisted view (checked AFTER the unreadable_dag branch —
      // getWorkflow parses the stored dag and would throw an opaque schema
      // error on a corrupt one).
      const committedWorkflow = await getWorkflow(principal.tenant_id, workflowId, db);
      if (!committedWorkflow) {
        return errorText(
          "NOT COMMITTED: the resolved workflow no longer exists (it may have been deleted). Nothing is committed for this conversation.",
        );
      }
      if (!committedWorkflow.current_version_id || committedWorkflow.current_version == null) {
        // The classifier can skip the version check (empty draft returns
        // early), and a delete/rotate can race it — same persisted truth
        // either way: no version row means nothing was written.
        return errorText(
          "NOT COMMITTED: the resolved workflow has no persisted version — nothing was written. conversation_commit only reports status; to persist the draft call save_workflow_draft (after a successful dry_run_workflow). Do not tell the user it is committed.",
        );
      }
      const verified = draftState.state === "clean";
      // Attach the usage block so external MCP clients (claude.ai) can
      // tell the user what was committed and every real way to run it.
      return successText(
        CommitResult.parse({
          conversation_id: detail.conversation.id,
          workflow_id: workflowId,
          status: detail.conversation.status,
          committed: {
            workflow_version_id: committedWorkflow.current_version_id,
            version: committedWorkflow.current_version,
            steps_present: committedWorkflow.steps.length,
            slug: committedWorkflow.slug,
            name: committedWorkflow.name,
            updated_at: committedWorkflow.updated_at.toISOString(),
          },
          draft_state: verified ? "clean" : "empty_draft",
          verified_against_draft: verified,
          ...(verified
            ? {}
            : {
                note: "no draft content was compared against the persisted version — this reply reflects the persisted rows only, not a confirmation that this conversation's edits were written",
              }),
          usage: await buildWorkflowUsage(db, principal.tenant_id, {
            id: committedWorkflow.id,
            slug: committedWorkflow.slug,
            name: committedWorkflow.name,
            definition: committedWorkflow.definition,
          }),
        }),
      );
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

  if (latest.result) {
    // Lean projection: drop the live-streaming replay frames and truncate
    // oversized payloads so a poll client gets status + final message + tool
    // outcomes, not the token-by-token replay (thesis T1). Shape preserved.
    const leanResult = projectTurnEnvelopeForClient(latest.result);
    if (pending) {
      return successText({
        status: "input_required",
        conversation_id,
        pending_elicitation_id: pending.id,
        input: pending.input,
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
      input: pending.input,
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
  const { latestProgressForConversation } = await import("../tasks/store.ts");
  const progress = await latestProgressForConversation(tenant_id, conversation_id, db);
  const anchor = Number.isFinite(since_ms) ? since_ms : Date.now();
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
