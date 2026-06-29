// `ConversationTaskStore` — the SDK `TaskStore` implementation backing
// the MCP async-Tasks surface (SEP-1686) for subkit's long-running
// conversation tools.
//
// Constructed PER SESSION and closed over `principal.tenant_id`: every
// query is tenant-scoped, so a foreign tenant cannot read or cancel
// another tenant's task even when it guesses a valid taskId. NEVER a
// process-global.
//
// **Task state is DERIVED, not stored.** `mcp_tasks` is a thin
// correlation index. `getTask` joins the index row to the owning
// `conversations` row + any pending `conversation_elicitations` row
// and computes the SEP-1686 status:
//
//   failure_reason set       → failed
//   cancelled_at set         → cancelled
//   result set               → completed
//   conversation awaiting_input + pending elicitation → input_required
//   otherwise (job still working)                     → working
//
// `updateTaskStatus` only meaningfully handles `cancelled` — it stamps
// `cancelled_at` and aborts the running turn. `completed` / `failed`
// are no-ops: derivation already covers them once the worker writes
// `result` / `failure_reason`.

import type {
  CreateTaskOptions,
  TaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/index.js";
import type { Request, RequestId, Result, Task } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import { cancelConversationAbort } from "../../conversations/abort.ts";
import type { Db } from "../../db/client.ts";
import { conversationElicitations, conversations } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { projectTurnEnvelopeForClient } from "../capabilities/turn-projection.ts";
import {
  getMcpTask,
  listMcpTasks,
  type McpTaskRow,
  maxTurnSeqForConversation,
  setMcpTaskCancelled,
} from "./store.ts";

/** Default task TTL — ~10 minutes, matching the run-turn job's expiry. */
export const CONVERSATION_TASK_TTL_MS = 600_000;

/** Default poll cadence the client should use on `tasks/get`. */
export const CONVERSATION_TASK_POLL_INTERVAL_MS = 2_000;

export interface ConversationTaskStoreParams {
  db: Db;
  tenant_id: string;
}

export class ConversationTaskStore implements TaskStore {
  private readonly db: Db;
  private readonly tenantId: string;

  constructor(p: ConversationTaskStoreParams) {
    this.db = p.db;
    this.tenantId = p.tenant_id;
  }

  /**
   * The SDK interface requires `createTask`, but subkit's conversation
   * tool handlers create the `mcp_tasks` row themselves (so they can
   * enqueue the pg-boss job + persist the user message in one unit of
   * work) and return a `CreateTaskResult` directly. The protocol never
   * invokes this for `tools/call` because the handler short-circuits
   * with its own result. It is implemented defensively so the
   * interface contract holds.
   */
  createTask(
    _taskParams: CreateTaskOptions,
    _requestId: RequestId,
    _request: Request,
  ): Promise<Task> {
    return Promise.reject(
      new Error(
        "ConversationTaskStore.createTask is not used — conversation tool handlers " +
          "insert the mcp_tasks row + enqueue the run-turn job, then return CreateTaskResult directly.",
      ),
    );
  }

  async getTask(taskId: string): Promise<Task | null> {
    const row = await getMcpTask(this.tenantId, taskId, this.db);
    if (!row) return null;
    return this.deriveTask(row);
  }

  async getTaskResult(taskId: string): Promise<Result> {
    const row = await getMcpTask(this.tenantId, taskId, this.db);
    if (!row) throw new Error(`task not found: ${taskId}`);
    if (row.result) {
      // A backgrounded turn finishes (writing `result`) while leaving
      // the conversation `awaiting_input` with a pending elicitation —
      // the task is NOT terminal, it derives `input_required`. Returning
      // the stored envelope with `isError:false` here would tell a Tasks
      // client the turn is done and let it skip the elicitation. Refuse
      // instead, so the client polls `tasks/get`, sees `input_required`,
      // and resolves the elicitation. Mirrors `deriveTask`'s precedence.
      if (await this.derivesInputRequired(row)) {
        throw new Error(`task ${taskId} is awaiting input — not terminal`);
      }
      // The terminal CallToolResult is a text envelope so non-Tasks
      // clients and Tasks clients see the identical body. Lean projection
      // matches `conversation_get`: drop replay frames, truncate oversized
      // payloads (thesis T1) — same shape, no token-by-token replay.
      const leanResult = projectTurnEnvelopeForClient(row.result);
      return {
        content: [{ type: "text", text: JSON.stringify(leanResult) }],
        isError: false,
      } as Result;
    }
    if (row.failure_reason) {
      return {
        content: [{ type: "text", text: row.failure_reason }],
        isError: true,
      } as Result;
    }
    // Not terminal — the protocol only calls this for terminal tasks,
    // but be explicit rather than returning a misleading empty result.
    throw new Error(`task ${taskId} has no result yet`);
  }

  /**
   * Persisting a worker result is the worker's job (it writes
   * `mcp_tasks.result` directly via `setMcpTaskResult`). The protocol
   * may call this on the request-handler side for task-augmented
   * requests it completes synchronously; for conversation tools the
   * handler short-circuits, so this is a defensive no-op.
   */
  storeTaskResult(
    _taskId: string,
    _status: "completed" | "failed",
    _result: Result,
  ): Promise<void> {
    return Promise.resolve();
  }

  async updateTaskStatus(
    taskId: string,
    status: Task["status"],
    statusMessage?: string,
  ): Promise<void> {
    if (status === "cancelled") {
      const row = await getMcpTask(this.tenantId, taskId, this.db);
      if (!row) throw new Error(`task not found: ${taskId}`);
      // Stamp the terminal cancel marker, then abort the running turn
      // so `runLoop` stops promptly. The worker's entry guard catches a
      // cancel that lands before the turn starts.
      await setMcpTaskCancelled(this.tenantId, taskId, this.db);
      cancelConversationAbort(this.tenantId, row.conversation_id);
      logger.info({
        module: "mcp.tasks",
        action: "task.cancelled",
        msg: "mcp task cancelled by client",
        tenant_id: this.tenantId,
        task_id: taskId,
        conversation_id: row.conversation_id,
        ...(statusMessage ? { status_message: statusMessage } : {}),
      });
      return;
    }
    // `completed` / `failed` / `working` / `input_required` are all
    // DERIVED — the worker owns the underlying columns. Nothing to do.
  }

  async listTasks(cursor?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    const limit = 50;
    const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
    const rows = await listMcpTasks(this.tenantId, this.db, { limit: limit + 1, offset });
    const page = rows.slice(0, limit);
    const tasks = await Promise.all(page.map((row) => this.deriveTask(row)));
    const out: { tasks: Task[]; nextCursor?: string } = { tasks };
    if (rows.length > limit) out.nextCursor = String(offset + limit);
    return out;
  }

  /**
   * Compute the SEP-1686 `Task` from the `mcp_tasks` index row + the
   * owning conversation + any pending elicitation. This is the single
   * derivation point — see the file header for the table.
   */
  private async deriveTask(row: McpTaskRow): Promise<Task> {
    const createdAt = row.created_at.toISOString();
    const base = {
      taskId: row.id,
      ttl: CONVERSATION_TASK_TTL_MS,
      createdAt,
      pollInterval: CONVERSATION_TASK_POLL_INTERVAL_MS,
    };

    if (row.failure_reason) {
      return {
        ...base,
        status: "failed",
        lastUpdatedAt: new Date().toISOString(),
        statusMessage: row.failure_reason,
      };
    }
    if (row.cancelled_at) {
      return {
        ...base,
        status: "cancelled",
        lastUpdatedAt: row.cancelled_at.toISOString(),
      };
    }

    if (await this.derivesInputRequired(row)) {
      return { ...base, status: "input_required", lastUpdatedAt: new Date().toISOString() };
    }
    // No pending elicitation governing this row — the turn is
    // `completed` once the worker wrote `result`, otherwise `working`.
    if (row.result) {
      return { ...base, status: "completed", lastUpdatedAt: new Date().toISOString() };
    }
    return { ...base, status: "working", lastUpdatedAt: new Date().toISOString() };
  }

  /**
   * Whether `row` derives `input_required`.
   *
   * `input_required` takes precedence over `completed`: a backgrounded
   * turn uses the DB-pause elicitation path, so the turn FINISHES
   * (writing `result`) while the conversation is left `awaiting_input`
   * with a pending elicitation. The client must resolve it before the
   * task is truly done — surface `input_required` even when `result` is
   * set. The single derivation point for both `deriveTask` and
   * `getTaskResult`.
   *
   * Two carve-outs:
   *
   *  - A `respond_elicitation` task that has not finished yet is ITSELF
   *    the turn resolving that pending elicitation — the conversation
   *    still reads `awaiting_input` with the pending row until the
   *    worker resolves it. Treating that as `input_required` would tell
   *    a Tasks client the task is parked for input when it is really
   *    still `working`. Mirrors the `respondInFlight` carve-out in the
   *    `conversation_get` poll tool — the two surfaces must agree.
   *
   *  - Only the conversation's LATEST-`turn_seq` task may flip on a
   *    paused conversation. A historical (non-latest) task already
   *    completed; a LATER turn pausing must not retroactively re-open
   *    it. An older row derives purely from its own terminal columns.
   */
  private async derivesInputRequired(row: McpTaskRow): Promise<boolean> {
    const respondInFlight = row.kind === "respond_elicitation" && !row.result;
    if (respondInFlight) return false;

    const maxTurnSeq = await maxTurnSeqForConversation(this.tenantId, row.conversation_id, this.db);
    // A historical task — a later turn owns the conversation's current
    // pause; this row stays whatever it terminally was.
    if (maxTurnSeq !== null && row.turn_seq < maxTurnSeq) return false;

    const [conv] = await this.db
      .select({ status: conversations.status })
      .from(conversations)
      .where(
        and(eq(conversations.tenant_id, this.tenantId), eq(conversations.id, row.conversation_id)),
      )
      .limit(1);
    if (conv?.status !== "awaiting_input") return false;

    const [pending] = await this.db
      .select({ id: conversationElicitations.id })
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, this.tenantId),
          eq(conversationElicitations.conversation_id, row.conversation_id),
          eq(conversationElicitations.status, "pending"),
        ),
      )
      .limit(1);
    return Boolean(pending);
  }
}
