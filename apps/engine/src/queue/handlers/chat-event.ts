// Worker for the `chat.event` queue.
//
// Receives a verified inbound chat event (Slack `app_mention`, `message.im`,
// a Block Kit interaction, slash command, …) that the HTTP route enqueued
// and runs the dispatcher out-of-band. Slack requires a <3 s ack on Events
// API posts; the route returns 200 immediately after `boss.send`, so an
// agentic turn (which can take minutes) lives in this worker.
//
// Per-job flow:
//   1. Resolve the `chat_workspaces` row from the platform-native
//      workspace id (pre-tenant lookup, mirrors the dispatcher).
//   2. Dedup via `chat/dedup.ts`. Slack retries each event up to 3× with
//      the same `event_id`; the unique index drops the duplicate before
//      any conversation work runs.
//   3. Resolve the workspace-specific adapter from `chatRegistry` for
//      outbound posting.
//   4. Hand off to `handleChatEvent` with a real `enqueueRun` that
//      forwards `/subkit run …` jobs onto `EXECUTION_RUN_QUEUE`.
//
// pg-boss retries the job on throw per the `chat.event` queue config
// (retryLimit: 3, retryBackoff: true). Terminal failures land in
// `chat.event.dlq`.

import { and, eq } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { markChatEventSeen } from "../../chat/dedup.ts";
import { type DispatchRunEnqueue, handleChatEvent } from "../../chat/dispatcher.ts";
import type { ChatAdapterRegistry } from "../../chat/registry.ts";
import type { Db } from "../../db/client.ts";
import { chatWorkspaces } from "../../db/schema/index.ts";
import { log } from "../../logging/logger.ts";
import {
  CHAT_EVENT_QUEUE,
  type ChatEventJob,
  EXECUTION_RUN_QUEUE,
  type ExecutionRunJob,
} from "../queues.ts";

export interface RegisterChatEventOptions {
  boss: PgBoss;
  db: Db;
  chatRegistry: ChatAdapterRegistry;
}

async function handleOne(job: Job<ChatEventJob>, opts: RegisterChatEventOptions): Promise<void> {
  const { boss, db, chatRegistry } = opts;
  const event = job.data.event;
  const started = Date.now();
  log.queue.job.dequeued({
    msg: "chat.event job dequeued",
    queue: CHAT_EVENT_QUEUE,
    job_id: job.id,
    platform: event.platform,
    workspace_id_native: event.workspace_id,
    kind: event.kind,
  });

  // Resolve workspace row → tenant + UUID. tenant-filter:exempt —
  // platform/workspace_id lookup pre-tenant; the dispatcher repeats
  // this lookup, which is harmless and keeps the dispatcher portable.
  const [workspace] = await db
    .select()
    .from(chatWorkspaces)
    .where(
      and(
        eq(chatWorkspaces.platform, event.platform),
        eq(chatWorkspaces.workspace_id, event.workspace_id),
      ),
    )
    .limit(1);
  if (!workspace) {
    log.queue.job.completed({
      msg: "chat.event dropped — unknown workspace",
      queue: CHAT_EVENT_QUEUE,
      job_id: job.id,
      platform: event.platform,
      workspace_id_native: event.workspace_id,
      duration_ms: Date.now() - started,
    });
    return;
  }

  // Dedup BEFORE dispatch. A Slack retry that arrives while the first
  // turn is still running would otherwise double-fire — the row must
  // commit at the start of *this* job, not after the turn completes.
  if (event.event_key) {
    const fresh = await markChatEventSeen(db, {
      tenant_id: workspace.tenant_id,
      workspace_id: workspace.id,
      platform_event_id: event.event_key,
    });
    if (!fresh) {
      log.queue.job.completed({
        msg: "chat.event dropped — duplicate (replay)",
        queue: CHAT_EVENT_QUEUE,
        job_id: job.id,
        platform: event.platform,
        event_key: event.event_key,
        duration_ms: Date.now() - started,
      });
      return;
    }
  }

  // Resolve the workspace-specific adapter for outbound posting. All
  // Slack adapters share one signing secret (one subkit app), so the
  // fallback used for verify works for any request — but `send` needs
  // the correct workspace's bot token, hence the keyed lookup.
  const adapter = chatRegistry.get({
    tenant_id: workspace.tenant_id,
    platform: event.platform,
    workspace_id: event.workspace_id,
  });
  if (!adapter) {
    throw new Error(
      `chat.event: no adapter registered for tenant=${workspace.tenant_id} platform=${event.platform} workspace=${event.workspace_id}`,
    );
  }

  const enqueueRun = async (run: DispatchRunEnqueue): Promise<void> => {
    const payload: ExecutionRunJob = {
      tenant_id: run.tenant_id,
      workflow_id: run.workflow_id,
      execution_id: run.execution_id,
      input: run.input,
      request_source: run.request_source,
      trace_id: run.trace_id ?? null,
    };
    await boss.send(EXECUTION_RUN_QUEUE, payload);
  };

  try {
    const outcome = await handleChatEvent({ db, adapter, enqueueRun }, event);
    log.queue.job.completed({
      msg: "chat.event job completed",
      queue: CHAT_EVENT_QUEUE,
      job_id: job.id,
      platform: event.platform,
      status: outcome.status,
      conversation_id: outcome.conversation_id ?? null,
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.queue.job.failed({
      msg: "chat.event job failed",
      queue: CHAT_EVENT_QUEUE,
      job_id: job.id,
      platform: event.platform,
      error: message,
      duration_ms: Date.now() - started,
    });
    throw err;
  }
}

export async function registerChatEventHandler(opts: RegisterChatEventOptions): Promise<string> {
  const { boss } = opts;
  const workerId = await boss.work<ChatEventJob>(
    CHAT_EVENT_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async (jobs: Job<ChatEventJob>[]) => {
      for (const job of jobs) {
        await handleOne(job, opts);
      }
    },
  );
  log.queue.worker.registered({
    msg: "chat.event worker registered",
    worker_id: workerId,
  });
  return workerId;
}
