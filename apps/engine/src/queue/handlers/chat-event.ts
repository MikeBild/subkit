import { and, eq } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { auditAwait } from "../../audit/audit.ts";
import {
  AuditAction,
  ChatMessageDeniedMetadataSchema,
  SYSTEM_TENANT_ID,
} from "../../audit/types.ts";
import { ChatEventJobSchema } from "../../chat/api.ts";
import { markChatEventSeen } from "../../chat/dedup.ts";
import { handleChatEvent } from "../../chat/dispatcher.ts";
import { ensureDmAutoRegistration } from "../../chat/dm-autoregister.ts";
import {
  buildGoogleChatAdapterFromConfig,
  ensureChatRegistryHydrated,
} from "../../chat/hydrate.ts";
import type { ChatAdapterRegistry } from "../../chat/registry.ts";
import { PLATFORM_HAS_GLOBAL_USER_IDS } from "../../chat/types.ts";
import { getConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { chatWorkspaces } from "../../db/schema/index.ts";
import { log, logger } from "../../logging/logger.ts";
import { tryAcquire } from "../../notifications/rate-limit.ts";
import { CHAT_EVENT_QUEUE, type ChatEventJob } from "../queues.ts";

export interface RegisterChatEventOptions {
  boss: PgBoss;
  db: Db;
  chatRegistry: ChatAdapterRegistry;
}

async function handleOne(job: Job<ChatEventJob>, opts: RegisterChatEventOptions): Promise<void> {
  const { db, chatRegistry } = opts;
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
  let [workspace] = await db
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
    const auto = await ensureDmAutoRegistration(db, event);
    if ("workspace" in auto) {
      workspace = auto.workspace;
      if (event.platform === "google_chat") {
        const google = getConfig().platform.googlechat;
        if (google.client_email && google.private_key && google.audience) {
          const adapter = buildGoogleChatAdapterFromConfig(google);
          chatRegistry.register(
            {
              tenant_id: workspace.tenant_id,
              platform: "google_chat",
              workspace_id: workspace.workspace_id,
            },
            adapter,
          );
          chatRegistry.registerFallback("google_chat", adapter);
        }
      }
    } else {
      log.queue.job.completed({
        msg: "chat.event dropped — unknown workspace",
        queue: CHAT_EVENT_QUEUE,
        job_id: job.id,
        platform: event.platform,
        workspace_id_native: event.workspace_id,
        duration_ms: Date.now() - started,
      });
      await auditAwait(
        {
          tenant_id: SYSTEM_TENANT_ID,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.CHAT_MESSAGE_DENIED,
          resource_type: "chat_message",
          resource_id: null,
          result: "denied",
          reason:
            auto.denied === "not_dm_autoregistrable" ? "workspace_not_installed" : auto.denied,
          metadata: ChatMessageDeniedMetadataSchema.parse({
            platform: event.platform,
            workspace_id_native: event.workspace_id,
            event_key: event.event_key ?? null,
            kind: event.kind,
            sender_platform_user_id: PLATFORM_HAS_GLOBAL_USER_IDS[event.platform]
              ? event.user_id
              : null,
            space_display_name: event.space_display_name ?? null,
          }),
        },
        db,
      );
      const wantsReply =
        event.channel_id.length > 0 &&
        (event.kind === "mention" ||
          event.kind === "slash_command" ||
          (event.kind === "system" && event.system_event === "added_to_space"));
      if (wantsReply) {
        const fallback = chatRegistry.getFallback(event.platform);
        if (fallback) {
          const gate = tryAcquire(
            {
              tenant_id: "unregistered",
              workspace_id: event.workspace_id,
              channel_id: event.channel_id,
            },
            1,
            1,
          );
          if (gate.ok) {
            try {
              await fallback.send({
                tenant_id: SYSTEM_TENANT_ID,
                workspace_id: event.workspace_id,
                channel_id: event.channel_id,
                ...(event.thread_id ? { thread_id: event.thread_id } : {}),
                kind: "message",
                text: "This space isn't connected to sk yet. Ask an admin to install the sk app here to start using it.",
              });
            } catch (err) {
              logger.debug({
                module: "chat",
                action: "chat_event.fallback_reply_failed",
                msg: "unregistered-space fallback reply failed — expected for workspace-scoped tokens",
                platform: event.platform,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      }
      return;
    }
  }

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

  const key = {
    tenant_id: workspace.tenant_id,
    platform: event.platform,
    workspace_id: event.workspace_id,
  };
  let adapter = chatRegistry.get(key);
  if (!adapter) {
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
