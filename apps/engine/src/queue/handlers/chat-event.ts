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
//   4. Hand off to `handleChatEvent`. `/subkit run …` is routed through
//      the conversation turn inside the dispatcher (same RBAC + confirm
//      + input contract as every other run path).
//
// pg-boss retries the job on throw per the `chat.event` queue config
// (retryLimit: 3, retryBackoff: true). Terminal failures land in
// `chat.event.dlq`.

import { and, eq } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction, SYSTEM_TENANT_ID } from "../../audit/types.ts";
import { ChatEventJobSchema } from "../../chat/api.ts";
import { markChatEventSeen } from "../../chat/dedup.ts";
import { handleChatEvent } from "../../chat/dispatcher.ts";
import { ensureChatRegistryHydrated } from "../../chat/hydrate.ts";
import type { ChatAdapterRegistry } from "../../chat/registry.ts";
import type { Db } from "../../db/client.ts";
import { chatWorkspaces } from "../../db/schema/index.ts";
import { log, logger } from "../../logging/logger.ts";
import { CHAT_EVENT_QUEUE, type ChatEventJob } from "../queues.ts";

export interface RegisterChatEventOptions {
  boss: PgBoss;
  db: Db;
  chatRegistry: ChatAdapterRegistry;
}

async function handleOne(job: Job<ChatEventJob>, opts: RegisterChatEventOptions): Promise<void> {
  const { db, chatRegistry } = opts;
  // Zod-validate the rehydrated job payload at the worker boundary.
  // pg-boss persists jobs in Postgres and rehydrates after restart; a
  // schema drift in `ChatEvent` mid-deploy would otherwise silently
  // dispatch malformed events. A failed parse logs + ACKs the job
  // (returning normally without throw — re-queueing a malformed
  // payload would just retry indefinitely). We only use the parse
  // result for the validation guard; downstream code consumes the
  // original `job.data.event` so the established `ChatEvent` type
  // (which uses exactOptionalPropertyTypes-friendly optionals) keeps
  // narrowing cleanly.
  const validation = ChatEventJobSchema.safeParse(job.data);
  if (!validation.success) {
    logger.warn({
      module: "queue",
      action: "chat_event.invalid_job",
      msg: "chat.event job failed schema validation — dropping",
      job_id: job.id,
      issues: validation.error.issues.map((i) => i.message),
    });
    return;
  }
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
    // Tenant-visible audit row for the drop. Without this a flood of
    // Slack retries against a removed workspace would be invisible to
    // every tenant (the structured log only reaches SIEM). We don't
    // know the owning tenant — the workspace row has been removed or
    // was never installed — so record under the platform-system
    // tenant; the platform `workspace_id_native` in metadata is
    // enough for forensic correlation.
    await auditAwait(
      {
        tenant_id: SYSTEM_TENANT_ID,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.CHAT_MESSAGE_DENIED,
        resource_type: "chat_message",
        resource_id: null,
        result: "denied",
        reason: "workspace_not_installed",
        metadata: {
          platform: event.platform,
          workspace_id_native: event.workspace_id,
          event_key: event.event_key ?? null,
          kind: event.kind,
        },
      },
      db,
    );
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
      // Tenant-visible audit row for the replay drop. Slack retries
      // up to 3× per event; flooding can't go unnoticed in the audit
      // log just because the structured log routes elsewhere.
      await auditAwait(
        {
          tenant_id: workspace.tenant_id,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.CHAT_MESSAGE_DENIED,
          resource_type: "chat_message",
          resource_id: null,
          result: "denied",
          reason: "replay",
          metadata: {
            platform: event.platform,
            workspace_id: event.workspace_id,
            event_key: event.event_key,
            kind: event.kind,
          },
        },
        db,
      );
      return;
    }
  }

  // Resolve the workspace-specific adapter for outbound posting. All
  // Slack adapters share one signing secret (one subkit app), so the
  // fallback used for verify works for any request — but `send` needs
  // the correct workspace's bot token, hence the keyed lookup.
  const key = {
    tenant_id: workspace.tenant_id,
    platform: event.platform,
    workspace_id: event.workspace_id,
  };
  let adapter = chatRegistry.get(key);
  if (!adapter) {
    // Cold-registry / boot-race miss: lazily rehydrate (idempotent,
    // cooldown-guarded) and retry once before failing the job.
    await ensureChatRegistryHydrated(db, chatRegistry);
    adapter = chatRegistry.get(key);
  }
  if (!adapter) {
    throw new Error(
      `chat.event: no adapter registered for tenant=${workspace.tenant_id} platform=${event.platform} workspace=${event.workspace_id}`,
    );
  }

  try {
    const outcome = await handleChatEvent({ db, adapter }, event);
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
