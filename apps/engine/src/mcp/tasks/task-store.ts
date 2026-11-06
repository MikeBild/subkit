import type {
  CreateTaskOptions,
  TaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/index.js";
import type { Request, RequestId, Result, Task } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import { stopConversationTaskTurn } from "../../conversations/turns.ts";
import type { Db } from "../../db/client.ts";
import {
  conversationElicitations,
  conversations,
  conversationTurns,
} from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { recordUsageEvent } from "../../stats/usage-events.ts";
import { projectTurnEnvelopeForClient } from "../capabilities/turn-projection.ts";
import {
  getMcpTask,
  listMcpTasks,
  type McpTaskRow,
  maxTurnSeqForConversation,
  setMcpTaskCancelled,
} from "./store.ts";

export const CONVERSATION_TASK_TTL_MS = 600_000;

export const CONVERSATION_TASK_POLL_INTERVAL_MS = 2_000;

interface ConversationTaskStoreParams {
  db: Db;
  tenant_id: string;
}

export class ConversationTaskStore implements TaskStore {
  private readonly db: Db;
  private readonly tenantId: string;
  private inputRequiredHandler?: (row: McpTaskRow) => Promise<boolean>;

  constructor(p: ConversationTaskStoreParams) {
    this.db = p.db;
    this.tenantId = p.tenant_id;
  }

  setInputRequiredHandler(handler: (row: McpTaskRow) => Promise<boolean>): void {
    this.inputRequiredHandler = handler;
  }

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
    let row = await getMcpTask(this.tenantId, taskId, this.db);
    if (!row) return null;
    if ((await this.deriveTask(row)).status === "input_required" && this.inputRequiredHandler) {
      const attempted = await this.inputRequiredHandler(row);
      if (attempted) {
        row = await getMcpTask(this.tenantId, taskId, this.db);
        if (!row) return null;
      }
    }
    return this.deriveTask(row);
  }

  async getTaskResult(taskId: string): Promise<Result> {
    const row = await getMcpTask(this.tenantId, taskId, this.db);
    if (!row) throw new Error(`task not found: ${taskId}`);
    if (row.result) {
      if (await this.derivesInputRequired(row)) {
        throw new Error(`task ${taskId} is awaiting input — not terminal`);
      }
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
      const leanResult = projectTurnEnvelopeForClient(row.result, {
        pending_elicitation_id: pending?.id ?? null,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(leanResult) }],
        isError: false,
        _meta: { "io.modelcontextprotocol/related-task": { taskId } },
      } as Result;
    }
    if (row.failure_reason) {
      return {
        content: [{ type: "text", text: row.failure_reason }],
        isError: true,
        _meta: { "io.modelcontextprotocol/related-task": { taskId } },
      } as Result;
    }
    throw new Error(`task ${taskId} has no result yet`);
  }

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
      const firstCancellation = await setMcpTaskCancelled(this.tenantId, taskId, this.db);
      if (row.job_id) {
        const [turn] = await this.db
          .select({ id: conversationTurns.id })
          .from(conversationTurns)
          .where(
            and(
              eq(conversationTurns.tenant_id, this.tenantId),
              eq(conversationTurns.conversation_id, row.conversation_id),
              eq(conversationTurns.task_id, taskId),
              eq(conversationTurns.attempt_id, row.job_id),
            ),
          )
          .limit(1);
        if (turn)
          await stopConversationTaskTurn(
            this.db,
            this.tenantId,
            row.conversation_id,
            turn.id,
            taskId,
            row.job_id,
            "cancelled",
          );
      }
      if (firstCancellation) {
        recordUsageEvent(this.db, {
          tenantId: this.tenantId,
          surface: "conversations",
          operation: "mcp/task/cancel",
          method: "POST",
          outcome: "cancelled",
          requestSource: row.request_source,
          actorId: row.actor_id,
          sessionId: row.conversation_id,
          platform: "http",
          responseMode: "async",
          taskPhase: "cancelled",
        });
      }
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
    if (row.result) {
      return { ...base, status: "completed", lastUpdatedAt: new Date().toISOString() };
    }
    return { ...base, status: "working", lastUpdatedAt: new Date().toISOString() };
  }

  private async derivesInputRequired(row: McpTaskRow): Promise<boolean> {
    const respondInFlight = row.kind === "respond_elicitation" && !row.result;
    if (respondInFlight) return false;

    const maxTurnSeq = await maxTurnSeqForConversation(this.tenantId, row.conversation_id, this.db);
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
