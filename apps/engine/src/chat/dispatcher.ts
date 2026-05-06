// Chat dispatcher — normalized ChatEvent → conversation action.
//
// Responsibilities:
//   1. Look up the chat_workspaces row by (platform, workspace_id)
//      to find the tenant.
//   2. Resolve a chat_identities row → subkit user_id. If none, auto-
//      bind the platform user to the tenant's seeded admin user and
//      audit it as kind: "auto_link". The chat surface treats every
//      first message from an unknown platform user as implicit consent
//      to act under the tenant's primary admin until an explicit
//      identity-linking flow is added; the audit row is the forensic
//      record of which platform identity got bound when.
//   3. Resolve (or create) a chat_sessions row → conversation_id.
//   4. Route the event to the conversation layer:
//        - mention / slash "chat <prompt>" → createConversation /
//          appendUserMessage (aka runTurn)
//        - interaction with action_id approve:* or reject:* →
//          decideApproval
//        - anything else → ephemeral help text via adapter.send
//   5. On an approval_request frame, send an approval card via the
//      adapter so users can click Approve/Reject inline.
//
// The dispatcher is intentionally free of adapter-specific types —
// it takes a ChatAdapter at runtime so tests can plug in a fake.

import { and, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { RunLoopResult } from "../conversations/loop.ts";
import {
  appendUserMessage,
  createConversation,
  respondElicitation,
} from "../conversations/service.ts";
import type { Db } from "../db/client.ts";
import {
  chatIdentities,
  chatSessions,
  chatWorkspaces,
  conversations,
  users,
  workflows as workflowsTable,
} from "../db/schema/index.ts";
import { createExecution } from "../execution/state.ts";
import { log, logger } from "../logging/logger.ts";
import { tryAcquire } from "../notifications/rate-limit.ts";
import { recordChatDelivery } from "../observability/instrumentation.ts";
import { can } from "../rbac/evaluator.ts";
import { getWorkflow, getWorkflowBySlug } from "../workflows/service.ts";
import type { ChatAdapter } from "./adapter.ts";
import { type ApprovalCard, CHAT_RATES, type ChatEvent, type ChatPlatform } from "./types.ts";

/** Envelope handed to the injected enqueue callback when a slash-run
 * fires. Mirrors the shape of `ExecutionRunJob` so callers can forward
 * it straight into pg-boss. Kept inline so the chat module doesn't
 * import from the queue layer. */
export interface DispatchRunEnqueue {
  tenant_id: string;
  workflow_id: string;
  execution_id: string;
  input: Record<string, string>;
  request_source: "chat";
  trace_id: string | null;
}

export interface DispatcherDeps {
  db: Db;
  adapter: ChatAdapter;
  /** Called for `/subkit run <wf>` events. Tests inject a fake; the
   * production wiring forwards into pg-boss. If omitted the dispatcher
   * still creates the execution row but skips enqueue (and notes that
   * in the ack message). */
  enqueueRun?: (job: DispatchRunEnqueue) => Promise<void>;
}

export interface DispatchOutcome {
  status: "ok" | "workspace_not_found" | "ignored" | "help" | "approved" | "rejected";
  conversation_id?: string;
  approval_sent?: boolean;
  loop?: RunLoopResult;
  /** Set when the dispatcher routed a `/subkit run` slash command. */
  execution_id?: string;
  workflow_id?: string;
}

interface SendOptions {
  /**
   * When true, skip the platform-cap token-bucket gate inside this
   * helper. The notifications dispatch path passes `true` because
   * `notifications/service.ts` already runs its own `tryAcquire`
   * against the same bucket; gating twice would double-consume
   * tokens and break the notifications rate-limit semantics.
   */
  skipRateLimit?: boolean;
}

/**
 * Gate outbound chat sends through the same token bucket the
 * notifications flow uses. Key is `(tenant_id, workspace_id, channel_id)`
 * so conversation replies and notification dispatches share the bucket
 * for a given channel — platform caps in `CHAT_RATES` are honored
 * regardless of which path got there first. On rate-limit trip we do
 * NOT throw (conversation paths would fail noisily); instead we record
 * `dropped_rate_limited` in metrics and return a synthetic
 * `platform_message_id` so the caller's state machine still advances.
 */
async function sendTracked(
  adapter: ChatAdapter,
  platform: string,
  delivery: Parameters<ChatAdapter["send"]>[0],
  opts: SendOptions = {},
): Promise<{ platform_message_id: string }> {
  const platformRate = CHAT_RATES[platform as ChatPlatform]?.per_minute;
  if (!opts.skipRateLimit && platformRate && platformRate > 0) {
    const gate = tryAcquire(
      {
        tenant_id: delivery.tenant_id,
        workspace_id: delivery.workspace_id,
        channel_id: delivery.channel_id,
      },
      platformRate,
      1,
    );
    if (!gate.ok) {
      recordChatDelivery({ platform, status: "rate_limited" });
      logger.warn({
        module: "chat",
        action: "outbound.rate_limited",
        msg: "chat adapter send rate-limited by token bucket",
        platform,
        tenant_id: delivery.tenant_id,
        workspace_id: delivery.workspace_id,
        channel: delivery.channel_id,
        per_minute: platformRate,
        retry_after_ms: gate.retryAfterMs,
      });
      return { platform_message_id: `rate_limited_${Date.now()}` };
    }
  }
  try {
    const out = await adapter.send(delivery);
    recordChatDelivery({ platform, status: "delivered" });
    log.chat.outbound.delivered({
      platform,
      channel: delivery.channel_id,
      platform_message_id: out.platform_message_id,
    });
    return out;
  } catch (err) {
    recordChatDelivery({ platform, status: "failed" });
    logger.error({
      module: "chat",
      action: "outbound.failed",
      msg: "chat adapter send failed",
      platform,
      channel: delivery.channel_id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Public delivery helper for non-conversational chat paths (e.g.
 * P-GC5 notifications). Wraps `adapter.send` with the same metric
 * tracking `sendTracked` uses internally, so notification
 * dispatches get counted alongside conversation replies. The
 * notification service runs its own token-bucket + circuit-breaker
 * gate before calling `deliver`, so the internal rate-limit is
 * skipped here to avoid double-consuming tokens.
 */
export async function deliver(
  adapter: ChatAdapter,
  delivery: Parameters<ChatAdapter["send"]>[0],
): Promise<{ platform_message_id: string }> {
  return await sendTracked(adapter, adapter.platform, delivery, { skipRateLimit: true });
}

function parseSlashCommand(
  text: string,
):
  | { verb: "chat"; prompt: string }
  | { verb: "run"; workflow: string; args: Record<string, string> }
  | { verb: "help"; topic?: string }
  | null {
  const trimmed = text.trim();
  // Accept: "/subkit chat ...", "/subkit run ...", "@bot chat ..." etc.
  // Also strip a leading "<@BOTID>" mention on app_mention text.
  const stripped = trimmed.replace(/^<@[A-Za-z0-9]+>\s*/, "");
  const parts = stripped.split(/\s+/);
  // Drop a leading "/subkit" token if present.
  let head = parts[0];
  if (head === "/subkit" || head === "subkit") {
    parts.shift();
    head = parts[0];
  }
  if (head === "chat") {
    parts.shift();
    return { verb: "chat", prompt: parts.join(" ").trim() };
  }
  if (head === "run") {
    parts.shift();
    const workflow = parts.shift() ?? "";
    const args: Record<string, string> = {};
    for (const p of parts) {
      const eq2 = p.indexOf("=");
      if (eq2 > 0) args[p.slice(0, eq2)] = p.slice(eq2 + 1);
    }
    return { verb: "run", workflow, args };
  }
  if (head === "help") {
    parts.shift();
    return { verb: "help", ...(parts[0] ? { topic: parts[0] } : {}) };
  }
  return null;
}

export async function handleChatEvent(
  deps: DispatcherDeps,
  ev: ChatEvent,
): Promise<DispatchOutcome> {
  const { db, adapter } = deps;

  // tenant-filter:exempt — platform/workspace_id lookup pre-tenant
  const [workspace] = await db
    .select()
    .from(chatWorkspaces)
    .where(
      and(
        eq(chatWorkspaces.platform, ev.platform),
        eq(chatWorkspaces.workspace_id, ev.workspace_id),
      ),
    )
    .limit(1);
  if (!workspace) return { status: "workspace_not_found" };
  const tenant_id = workspace.tenant_id;

  // Resolve identity → subkit user.
  // tenant-filter:exempt — platform user-identity lookup pre-tenant
  const [identity] = await db
    .select()
    .from(chatIdentities)
    .where(
      and(
        eq(chatIdentities.platform, ev.platform),
        eq(chatIdentities.workspace_id, ev.workspace_id),
        eq(chatIdentities.platform_user_id, ev.user_id),
      ),
    )
    .limit(1);
  let user_id: string;
  if (identity) {
    user_id = identity.user_id;
  } else {
    const [fallbackUser] = await db
      .select()
      .from(users)
      .where(and(eq(users.tenant_id, tenant_id), eq(users.role, "admin")))
      .limit(1);
    if (!fallbackUser) throw new Error("dispatcher: no seeded admin user to auto-bind");
    user_id = fallbackUser.id;
    await db.insert(chatIdentities).values({
      tenant_id,
      user_id,
      platform: ev.platform,
      workspace_id: ev.workspace_id,
      platform_user_id: ev.user_id,
    });
    await auditAwait(
      {
        tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.CHAT_IDENTITY_LINKED,
        resource_type: "chat_identity",
        resource_id: user_id,
        result: "success",
        metadata: {
          kind: "auto_link",
          platform: ev.platform,
          platform_user_id: ev.user_id,
        },
      },
      db,
    );
  }

  await auditAwait(
    {
      tenant_id,
      actor_type: "user",
      actor_id: user_id,
      action: AuditAction.CHAT_MESSAGE_RECEIVED,
      resource_type: "chat_message",
      resource_id: null,
      result: "success",
      metadata: {
        platform: ev.platform,
        workspace_id: ev.workspace_id,
        kind: ev.kind,
      },
    },
    db,
  );

  // Interactions short-circuit to elicitation resolution.
  if (ev.kind === "interaction" && ev.interaction) {
    const { action_id, value: actionValue } = ev.interaction;
    const m = /^(approve|reject):(.+)$/.exec(action_id);
    if (!m) return { status: "ignored" };
    const confirmed = m[1] === "approve";
    const elicitation_id = m[2] ?? "";
    const conversation_id = actionValue ?? "";
    await respondElicitation(
      {
        tenant_id,
        conversation_id,
        elicitation_id,
        actor_id: user_id,
        output: { confirmed },
      },
      db,
    );
    return {
      status: confirmed ? "approved" : "rejected",
      conversation_id,
    };
  }

  // Parse command for mention + slash events.
  const rawText = ev.text ?? "";
  const parsed = parseSlashCommand(rawText);
  let prompt: string | null = null;
  if (parsed && parsed.verb === "chat") {
    prompt = parsed.prompt;
  } else if (ev.kind === "mention") {
    // Bare mention with no verb — treat the text (minus any bot id)
    // as the chat prompt.
    prompt = rawText.replace(/^<@[A-Za-z0-9]+>\s*/, "").trim();
  } else if (parsed && parsed.verb === "run") {
    // /subkit run <workflow> k=v ... — resolve workflow by slug or
    // UUID, materialize an execution row, then hand off to whatever
    // the caller wired into `enqueueRun` (in production: pg-boss).
    const slugOrId = parsed.workflow;
    if (!slugOrId) {
      await sendTracked(adapter, ev.platform, {
        tenant_id,
        workspace_id: ev.workspace_id,
        channel_id: ev.channel_id,
        ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
        kind: "ephemeral",
        text: "Usage: `/subkit run <workflow-slug-or-id> [k=v ...]`",
      });
      return { status: "help" };
    }

    // Try UUID first, then slug. getWorkflow expects a UUID and will
    // throw on malformed input, so guard with a regex.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrId);
    let wf = null;
    if (isUuid) {
      wf = await getWorkflow(tenant_id, slugOrId, db);
    }
    if (!wf) {
      wf = await getWorkflowBySlug(tenant_id, slugOrId, db);
    }
    if (!wf) {
      await sendTracked(adapter, ev.platform, {
        tenant_id,
        workspace_id: ev.workspace_id,
        channel_id: ev.channel_id,
        ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
        kind: "ephemeral",
        text: `Workflow \`${slugOrId}\` not found in this tenant.`,
      });
      return { status: "help" };
    }
    if (!wf.current_version_id) {
      await sendTracked(adapter, ev.platform, {
        tenant_id,
        workspace_id: ev.workspace_id,
        channel_id: ev.channel_id,
        ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
        kind: "ephemeral",
        text: `Workflow \`${slugOrId}\` has no active version.`,
      });
      return { status: "help" };
    }

    // Pull the workflow_version_id directly from the table — the view
    // exposes only the version number.
    const versionRows = await db
      .select({ current_version_id: workflowsTable.current_version_id })
      .from(workflowsTable)
      .where(and(eq(workflowsTable.tenant_id, tenant_id), eq(workflowsTable.id, wf.id)))
      .limit(1);
    const workflow_version_id = versionRows[0]?.current_version_id;
    if (!workflow_version_id) {
      await sendTracked(adapter, ev.platform, {
        tenant_id,
        workspace_id: ev.workspace_id,
        channel_id: ev.channel_id,
        ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
        kind: "ephemeral",
        text: `Workflow \`${slugOrId}\` has no active version.`,
      });
      return { status: "help" };
    }

    // Pass-2 C6: chat slash `/run` gates on `workflow:run`. The
    // dispatcher assembles a synthetic user principal out of the
    // resolved chat identity so the evaluator can walk the
    // role/group/grant ladder. We preload the user's legacy enum role
    // so the built-in admin short-circuit still fires for the seeded
    // chat admin user that auto-linked on first message.
    const userRows = await db
      .select({ role: users.role })
      .from(users)
      .where(and(eq(users.tenant_id, tenant_id), eq(users.id, user_id)))
      .limit(1);
    const syntheticRoles = userRows[0] ? [userRows[0].role] : [];
    const runDecision = await can(db, {
      tenant_id,
      principal: {
        provider: "chat",
        kind: "user",
        id: user_id,
        tenant_id,
        roles: syntheticRoles,
      },
      permission: "workflow:run",
      resource: { type: "workflow", id: wf.id },
    });
    if (!runDecision.allow) {
      await auditAwait(
        {
          tenant_id,
          actor_type: "user",
          actor_id: user_id,
          action: AuditAction.POLICY_DENIED,
          resource_type: "workflow",
          resource_id: wf.id,
          result: "denied",
          reason: runDecision.reason ?? "permission_denied:workflow:run",
          metadata: { via: "chat", slug: wf.slug },
        },
        db,
      );
      await sendTracked(adapter, ev.platform, {
        tenant_id,
        workspace_id: ev.workspace_id,
        channel_id: ev.channel_id,
        ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
        kind: "ephemeral",
        text: `Permission denied: ${runDecision.reason ?? "workflow:run"}`,
      });
      return { status: "help" };
    }

    const execution_id = await createExecution(db, {
      tenant_id,
      workflow_id: wf.id,
      workflow_version_id,
      source_kind: "saved",
      source_ref: null,
      request_source: "chat",
      parent_execution_id: null,
    });

    if (deps.enqueueRun) {
      await deps.enqueueRun({
        tenant_id,
        workflow_id: wf.id,
        execution_id,
        input: parsed.args,
        request_source: "chat",
        trace_id: null,
      });
    }

    await auditAwait(
      {
        tenant_id,
        actor_type: "user",
        actor_id: user_id,
        action: AuditAction.EXECUTION_STARTED,
        resource_type: "execution",
        resource_id: execution_id,
        result: "success",
        metadata: {
          workflow_id: wf.id,
          slug: wf.slug,
          via: "chat",
          input_keys: Object.keys(parsed.args),
        },
      },
      db,
    );

    await sendTracked(adapter, ev.platform, {
      tenant_id,
      workspace_id: ev.workspace_id,
      channel_id: ev.channel_id,
      ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
      kind: "ephemeral",
      text: `execution started: ${execution_id}`,
    });
    return { status: "ok", execution_id, workflow_id: wf.id };
  }

  if (!prompt) {
    await sendTracked(adapter, ev.platform, {
      tenant_id,
      workspace_id: ev.workspace_id,
      channel_id: ev.channel_id,
      ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
      kind: "ephemeral",
      text: "Usage: `/subkit chat <prompt>` or mention the bot with your ask.",
    });
    return { status: "help" };
  }

  // Look up or create the conversation bound to this chat thread.
  const threadKey = ev.thread_id ?? `${ev.channel_id}:root`;
  const [existing] = await db
    .select()
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.tenant_id, tenant_id),
        eq(chatSessions.workspace_id, workspace.id),
        eq(chatSessions.thread_id, threadKey),
      ),
    )
    .limit(1);

  let conversation_id: string;
  let outcome: RunLoopResult;
  if (existing) {
    conversation_id = existing.conversation_id;
    const turn = await appendUserMessage(
      { tenant_id, conversation_id, actor_id: user_id, message: prompt },
      db,
    );
    outcome = turn.result;
  } else {
    const created = await createConversation(
      { tenant_id, actor_id: user_id, initial_message: prompt },
      db,
    );
    conversation_id = created.conversation.id;
    await db.insert(chatSessions).values({
      tenant_id,
      workspace_id: workspace.id,
      thread_id: threadKey,
      conversation_id,
    });
    outcome = created.result;
  }

  let approval_sent = false;
  if (outcome.status === "awaiting_input" && outcome.pending_elicitation_id) {
    const summaryEvent = outcome.events.find((e) => e.type === "elicit_request");
    const summary =
      summaryEvent && summaryEvent.type === "elicit_request"
        ? summaryEvent.summary
        : "Input required";
    const card: ApprovalCard = {
      tenant_id,
      workspace_id: ev.workspace_id,
      channel_id: ev.channel_id,
      ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
      conversation_id,
      approval_id: outcome.pending_elicitation_id,
      summary,
    };
    try {
      await adapter.sendApproval(card);
      recordChatDelivery({ platform: ev.platform, status: "delivered" });
    } catch (err) {
      recordChatDelivery({ platform: ev.platform, status: "failed" });
      throw err;
    }
    approval_sent = true;
  } else {
    // Post a short acknowledgement so the user knows we picked it up.
    await sendTracked(adapter, ev.platform, {
      tenant_id,
      workspace_id: ev.workspace_id,
      channel_id: ev.channel_id,
      ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
      kind: "message",
      text: outcome.status === "committed" ? "Committed." : "Working on it...",
    });
  }

  // Double-check the conversation got committed when we expect it
  // (caller tests can read this too).
  if (outcome.status === "committed") {
    await db
      .select({ id: conversations.id, status: conversations.status })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)))
      .limit(1);
  }

  return {
    status: "ok",
    conversation_id,
    approval_sent,
    loop: outcome,
  };
}
