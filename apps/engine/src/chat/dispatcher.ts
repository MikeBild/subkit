import { and, eq, like } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { principalOrigin } from "../auth/origin.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import {
  appendUserMessage,
  createConversation,
  describeTurnFailure,
  humanChatAnswer,
  runConversationTurn,
  type TurnFailure,
} from "../conversations/public/authoring.ts";
import {
  PendingElicitationBlockedError,
  respondElicitation,
} from "../conversations/public/elicitation.ts";
import {
  conversationTurnId,
  registerConversationAbort,
  unregisterConversationAbort,
} from "../conversations/public/lifecycle.ts";
import type { RunLoopResult } from "../conversations/types.ts";
import type { Db } from "../db/client.ts";
import { chatIdentities, chatSessions, chatWorkspaces } from "../db/schema/index.ts";
import { errorFields, log, logger } from "../logging/logger.ts";
import { tryAcquire } from "../notifications/rate-limit.ts";
import { recordChatDelivery } from "../observability/instrumentation.ts";
import { instrument } from "../observability/runtime-telemetry.ts";
import { recordUsageEvent } from "../stats/usage-events.ts";
import { now } from "../utils/clock.ts";
import type { ChatAdapter } from "./adapter.ts";
import { mapToolNameToKind } from "./api.ts";
import { formatChatText } from "./format/outbound-format.ts";
import { HostedChatOwnershipRequired, requiresHostedChatOwnership } from "./hosted-ownership.ts";
import { intakeReviewHandoff } from "./intake-handoff.ts";
import { resolveChatPrincipal } from "./principal.ts";

export type { DispatchOutcome, HandleChatEventOpts } from "./dispatcher-types.ts";

import type { DispatchOutcome, HandleChatEventOpts } from "./dispatcher-types.ts";
import { classifyChatElicitError, routeChatInteraction } from "./elicit-routing.ts";
import { withConversationTurnLock } from "./turn-lock.ts";
import {
  type ApprovalCard,
  CHAT_RATES,
  type ChatElicitation,
  type ChatEvent,
  type ChatPlatform,
} from "./types.ts";

export interface DispatcherDeps {
  db: Db;
  adapter: ChatAdapter;
}

interface ChatUsageContext {
  tenantId: string | null;
  actorId: string | null;
  sessionId: string | null;
}

interface SendOptions {
  skipRateLimit?: boolean;
}

function consumeInteractiveSlot(
  platform: string,
  key: { tenant_id: string; workspace_id: string; channel_id: string },
): void {
  const platformRate = CHAT_RATES[platform as ChatPlatform]?.per_minute;
  if (!platformRate || platformRate <= 0) return;
  const gate = tryAcquire(key, platformRate, 1);
  if (!gate.ok) {
    recordChatDelivery({ platform, status: "rate_limited" });
    logger.warn({
      module: "chat",
      action: "outbound.interactive_over_budget",
      msg: "interactive card sent past the token bucket — load-bearing message, not dropped",
      platform,
      tenant_id: key.tenant_id,
      workspace_id: key.workspace_id,
      channel: key.channel_id,
      per_minute: platformRate,
      retry_after_ms: gate.retryAfterMs,
    });
  }
}

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
      return { platform_message_id: "rate_limited" };
    }
  }
  const outgoing =
    delivery.text != null && delivery.text !== ""
      ? { ...delivery, text: formatChatText(platform as ChatPlatform, delivery.text) }
      : delivery;
  try {
    const out = await instrument({
      module: "chat",
      action: "outbound.send",
      fields: { platform, channel: outgoing.channel_id, tenant_id: outgoing.tenant_id },
      fn: () => adapter.send(outgoing),
    });
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
      ...errorFields(err),
    });
    throw err;
  }
}

export async function deliver(
  adapter: ChatAdapter,
  delivery: Parameters<ChatAdapter["send"]>[0],
): Promise<{ platform_message_id: string }> {
  return await sendTracked(adapter, adapter.platform, delivery, { skipRateLimit: true });
}

export async function deliverChatReply(
  adapter: ChatAdapter,
  platform: string,
  delivery: Parameters<ChatAdapter["send"]>[0],
): Promise<{ platform_message_id: string }> {
  return await sendTracked(adapter, platform, delivery);
}

function parseSlashCommand(
  text: string,
):
  | { verb: "chat"; prompt: string }
  | { verb: "run"; workflow: string; args: Record<string, string> }
  | { verb: "help"; topic?: string }
  | { verb: "new" }
  | null {
  const trimmed = text.trim();
  const stripped = trimmed.replace(/^<@[A-Za-z0-9]+>\s*/, "");
  const parts = stripped.split(/\s+/);
  let head = parts[0];
  if (head === "/subkit" || head === "subkit") {
    parts.shift();
    head = parts[0];
  }
  if (head === "/new" || head === "/reset" || head === "new" || head === "reset") {
    return { verb: "new" };
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

export function extractAssistantText(outcome: RunLoopResult): string | null {
  let lastAssistant: string | null = null;
  let deltas: string[] | null = null;
  for (const e of outcome.events) {
    if (e.type === "message" && e.role === "assistant") {
      const content = e.content as { text?: unknown } | string | null | undefined;
      if (typeof content === "string") {
        lastAssistant = content.trim() || null;
      } else if (content && typeof content === "object" && typeof content.text === "string") {
        lastAssistant = (content.text as string).trim() || null;
      }
    } else if (e.type === "text_delta" && typeof e.text === "string") {
      if (deltas === null) deltas = [];
      deltas.push(e.text);
    }
  }
  if (lastAssistant !== null) return lastAssistant;
  if (deltas !== null) {
    const joined = deltas.join("").trim();
    return joined || null;
  }
  return null;
}

type ChannelTurn = { outcome: RunLoopResult } | { failure: TurnFailure };

async function runTurnForChannel(run: () => Promise<RunLoopResult>): Promise<ChannelTurn> {
  try {
    return { outcome: await run() };
  } catch (err) {
    if (err instanceof PendingElicitationBlockedError) throw err;
    const failure = describeTurnFailure(err);
    if (failure.code === "internal") throw err;
    return { failure };
  }
}

export async function handleChatEvent(
  deps: DispatcherDeps,
  ev: ChatEvent,
  opts: HandleChatEventOpts = {},
): Promise<DispatchOutcome> {
  const startedAt = now();
  const usage: ChatUsageContext = { tenantId: null, actorId: null, sessionId: null };
  try {
    const outcome = await instrument({
      module: "chat",
      action: "inbound.dispatch",
      fields: { platform: ev.platform, workspace_id: ev.workspace_id },
      fn: () => handleChatEventImpl(deps, ev, opts, usage),
    });
    if (usage.tenantId) {
      const durationMs = now() - startedAt;
      recordUsageEvent(deps.db, {
        tenantId: usage.tenantId,
        surface: "chat",
        operation: `event/${ev.kind}`,
        method: "EVENT",
        outcome:
          outcome.status === "ignored"
            ? "ignored"
            : outcome.status === "workspace_not_found"
              ? "not_found"
              : outcome.status === "rejected"
                ? "denied"
                : "success",
        trafficClass: ev.traffic_class ?? "organic",
        requestSource: "chat",
        actorId: usage.actorId,
        sessionId: usage.sessionId,
        durationMs,
        platform: ev.platform,
        responseMode: opts.replyDelivery === "capture" ? "sync" : "async",
      });
      if (outcome.conversation_id) {
        recordUsageEvent(deps.db, {
          tenantId: usage.tenantId,
          surface: "conversations",
          operation: "chat/turn",
          method: "EVENT",
          outcome: outcome.status === "rejected" ? "denied" : "success",
          trafficClass: ev.traffic_class ?? "organic",
          requestSource: "chat",
          actorId: usage.actorId,
          sessionId: outcome.conversation_id,
          durationMs,
          platform: ev.platform,
          responseMode: opts.replyDelivery === "capture" ? "sync" : "async",
          taskPhase: outcome.loop?.status === "awaiting_input" ? "input_required" : "completed",
        });
      }
    }
    return outcome;
  } catch (err) {
    if (usage.tenantId) {
      recordUsageEvent(deps.db, {
        tenantId: usage.tenantId,
        surface: "chat",
        operation: `event/${ev.kind}`,
        method: "EVENT",
        outcome: "server_error",
        trafficClass: ev.traffic_class ?? "organic",
        requestSource: "chat",
        actorId: usage.actorId,
        sessionId: usage.sessionId,
        durationMs: now() - startedAt,
        platform: ev.platform,
        responseMode: opts.replyDelivery === "capture" ? "sync" : "async",
      });
    }
    throw err;
  }
}

async function salvageTypedReplyToPendingElicitation(args: {
  deps: DispatcherDeps;
  ev: ChatEvent;
  tenant_id: string;
  user_id: string;
  conversation_id: string;
  prompt: string;
  pending: { id: string; tool_name: string; summary: string; input?: unknown };
  principal: ResolvedPrincipal | null;
}): Promise<RunLoopResult | null> {
  const { deps, ev, tenant_id, user_id, conversation_id, prompt, pending, principal } = args;
  const notify = (text: string) =>
    sendTracked(deps.adapter, ev.platform, {
      tenant_id,
      workspace_id: ev.workspace_id,
      channel_id: ev.channel_id,
      ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
      kind: "message",
      text,
    });

  const kind = mapToolNameToKind(pending.tool_name);
  let output: unknown = null;
  if (kind === "text") {
    output = { text: prompt };
  } else if (kind === "form") {
    const fields =
      pending.input &&
      typeof pending.input === "object" &&
      Array.isArray((pending.input as { fields?: unknown }).fields)
        ? (pending.input as { fields: Array<{ name?: unknown }> }).fields
        : [];
    if (fields.length === 1 && typeof fields[0]?.name === "string") {
      output = { [fields[0].name]: prompt };
    }
  }

  if (output === null) {
    await notify(
      "There's a prompt waiting for your answer just above — please use the " +
        "buttons or menu to respond, or type `/new` to start over.",
    ).catch(() => {});
    return null;
  }

  const turnAbortCtrl = await registerConversationAbort(tenant_id, conversation_id, deps.db);
  try {
    const resolved = await withConversationTurnLock(tenant_id, conversation_id, () =>
      respondElicitation(
        {
          tenant_id,
          conversation_id,
          elicitation_id: pending.id,
          actor_id: user_id,
          principal,
          answer_actor: humanChatAnswer(principal),
          output,
          turn_abort_ctrl: turnAbortCtrl,
          require_same_actor: true,
          surface: "chat",
        },
        deps.db,
      ),
    );
    return resolved.result;
  } catch (err) {
    const classified = classifyChatElicitError(err);
    if (classified.kind === "rethrow") throw err;
    if (classified.kind === "validation" || classified.kind === "surface_unsupported") {
      await notify(classified.user_text).catch(() => {});
      return null;
    }
    if (classified.kind === "already_resolved") {
      return null;
    }
    if (classified.kind === "actor_mismatch") {
      await notify(`${classified.user_text} Type \`/new\` to start your own.`).catch(() => {});
    }
    await auditAwait(
      {
        tenant_id,
        actor_type: "user",
        actor_id: user_id,
        action: AuditAction.CHAT_MESSAGE_DENIED,
        resource_type: "conversation_elicitation",
        resource_id: pending.id,
        result: "denied",
        reason: classified.audit_reason,
        metadata: { conversation_id, kind },
      },
      deps.db,
    );
    return null;
  } finally {
    await unregisterConversationAbort(tenant_id, conversation_id, turnAbortCtrl);
  }
}

async function handleChatEventImpl(
  deps: DispatcherDeps,
  ev: ChatEvent,
  opts: HandleChatEventOpts = {},
  usage?: ChatUsageContext,
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
  if (await requiresHostedChatOwnership(db, tenant_id)) {
    await auditAwait(
      {
        tenant_id,
        actor_type: "system",
        action: AuditAction.CHAT_MESSAGE_DENIED,
        resource_type: "chat_workspace",
        resource_id: workspace.id,
        result: "denied",
        reason: "hosted_ownership_proof_required",
      },
      db,
    );
    return { status: "rejected", reply_text: new HostedChatOwnershipRequired().message };
  }
  if (usage) {
    usage.tenantId = tenant_id;
    usage.sessionId = `${workspace.id}:${ev.thread_id ?? ev.channel_id}`;
  }

  if (ev.kind === "system") {
    if (ev.system_event === "removed_from_space") {
      const dropped = await db
        .delete(chatSessions)
        .where(
          and(
            eq(chatSessions.tenant_id, tenant_id),
            eq(chatSessions.workspace_id, workspace.id),
            like(chatSessions.thread_id, `${ev.channel_id}%`),
          ),
        )
        .returning({ id: chatSessions.id });
      logger.info({
        module: "chat",
        action: "system_event.removed_from_space",
        msg: "app removed from space — dropped its session bindings",
        tenant_id,
        platform: ev.platform,
        channel_id: ev.channel_id,
        dropped_sessions: dropped.length,
      });
    } else {
      logger.debug({
        module: "chat",
        action: "system_event.ignored",
        msg: "non-conversational platform event acked and ignored",
        tenant_id,
        platform: ev.platform,
        channel_id: ev.channel_id,
        system_event: ev.system_event ?? "unknown",
      });
    }
    return { status: "ignored" };
  }

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
  const denyReason =
    identity === undefined
      ? "identity_not_linked"
      : identity.tenant_id !== tenant_id
        ? "identity_tenant_mismatch"
        : null;
  if (denyReason !== null) {
    try {
      await sendTracked(adapter, ev.platform, {
        tenant_id,
        workspace_id: ev.workspace_id,
        channel_id: ev.channel_id,
        ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
        kind: "ephemeral",
        text:
          "Your chat account isn't linked to a subkit user. Ask a tenant admin " +
          "to link it via `POST /v1/chat/identities`.",
      });
    } catch {}
    await auditAwait(
      {
        tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.CHAT_MESSAGE_DENIED,
        resource_type: "chat_message",
        resource_id: null,
        result: "denied",
        reason: denyReason,
        metadata: {
          platform: ev.platform,
          workspace_id: ev.workspace_id,
          platform_user_id: ev.user_id,
          kind: ev.kind,
        },
      },
      db,
    );
    return { status: "ignored" };
  }
  if (!identity) throw new Error("dispatcher: identity is unexpectedly undefined after deny check");
  const user_id = identity.user_id;
  if (usage) usage.actorId = user_id;

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

  if (ev.kind === "interaction" && ev.interaction) {
    return await routeChatInteraction({
      ev,
      tenant_id,
      user_id,
      db,
      notify: async (text) => {
        await sendTracked(deps.adapter, ev.platform, {
          tenant_id,
          workspace_id: ev.workspace_id,
          channel_id: ev.channel_id,
          ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
          kind: "message",
          text,
        });
      },
    });
  }

  const rawText = ev.text ?? "";
  const parsed = parseSlashCommand(rawText);

  if (parsed && parsed.verb === "new") {
    const threadKey = ev.thread_id ?? `${ev.channel_id}:root`;
    await db
      .delete(chatSessions)
      .where(
        and(
          eq(chatSessions.tenant_id, tenant_id),
          eq(chatSessions.workspace_id, workspace.id),
          eq(chatSessions.thread_id, threadKey),
        ),
      );
    await sendTracked(adapter, ev.platform, {
      tenant_id,
      workspace_id: ev.workspace_id,
      channel_id: ev.channel_id,
      ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
      kind: "ephemeral",
      text: "Conversation reset — the next message starts a fresh turn.",
    });
    return { status: "ok" };
  }

  let prompt: string | null = null;
  if (parsed && parsed.verb === "chat") {
    prompt = parsed.prompt;
  } else if (ev.kind === "mention") {
    prompt = rawText.replace(/^<@[A-Za-z0-9]+>\s*/, "").trim();
  } else if (parsed && parsed.verb === "run") {
    if (!parsed.workflow) {
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
    const argText = Object.entries(parsed.args)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    prompt = `run ${parsed.workflow}${argText ? ` with ${argText}` : ""}`;
  }

  if (!prompt) {
    await sendTracked(adapter, ev.platform, {
      tenant_id,
      workspace_id: ev.workspace_id,
      channel_id: ev.channel_id,
      ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
      kind: "ephemeral",
      text: "Hi — I can run a saved workflow, look up executions, connectors, or knowledge, and answer questions about your sk setup. Just tell me what you need.",
    });
    return { status: "help" };
  }

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

  const chatPrincipal = await resolveChatPrincipal(db, tenant_id, user_id);

  let conversation_id: string;
  let turn: ChannelTurn;
  if (existing) {
    conversation_id = existing.conversation_id;
    try {
      turn = await runTurnForChannel(() =>
        withConversationTurnLock(tenant_id, conversation_id, async () => {
          const turnAbortCtrl = await registerConversationAbort(tenant_id, conversation_id, db);
          try {
            const appended = await appendUserMessage(
              {
                tenant_id,
                conversation_id,
                actor_id: user_id,
                principal: chatPrincipal,
                message: prompt,
                turn_id: conversationTurnId(turnAbortCtrl),
              },
              db,
            );
            const result = await runConversationTurn(
              {
                tenant_id,
                conversation_id,
                actor_id: user_id,
                principal: chatPrincipal,
                user_message: appended.message,
                answer_actor: humanChatAnswer(chatPrincipal),
                user_memory: appended.user_memory,
                turn_abort_ctrl: turnAbortCtrl,
                surface: "chat",
              },
              db,
            );
            return result.result;
          } finally {
            await unregisterConversationAbort(tenant_id, conversation_id, turnAbortCtrl);
          }
        }),
      );
    } catch (err) {
      if (!(err instanceof PendingElicitationBlockedError)) throw err;
      const resumed = await salvageTypedReplyToPendingElicitation({
        deps,
        ev,
        tenant_id,
        user_id,
        conversation_id,
        prompt,
        pending: err.pending_elicitation,
        principal: chatPrincipal,
      });
      if (resumed === null) return { status: "ok", conversation_id };
      turn = { outcome: resumed };
    }
  } else {
    const created = await createConversation(
      {
        tenant_id,
        actor_id: user_id,
        principal: chatPrincipal,
        initial_message: prompt,
        origin_client: principalOrigin(chatPrincipal) ?? `chat:${ev.platform}`,
        surface: "chat",
      },
      db,
    );
    conversation_id = created.conversation.id;
    await db.insert(chatSessions).values({
      tenant_id,
      workspace_id: workspace.id,
      thread_id: threadKey,
      conversation_id,
    });
    turn = await runTurnForChannel(() =>
      withConversationTurnLock(tenant_id, conversation_id, async () => {
        const turnAbortCtrl = await registerConversationAbort(tenant_id, conversation_id, db);
        try {
          const result = await runConversationTurn(
            {
              tenant_id,
              conversation_id,
              actor_id: user_id,
              principal: chatPrincipal,
              user_message: created.initial_message ?? "",
              answer_actor: humanChatAnswer(chatPrincipal),
              user_memory: created.user_memory,
              turn_abort_ctrl: turnAbortCtrl,
              surface: "chat",
            },
            db,
          );
          return result.result;
        } finally {
          await unregisterConversationAbort(tenant_id, conversation_id, turnAbortCtrl);
        }
      }),
    );
  }

  if ("failure" in turn) {
    logger.warn({
      module: "chat",
      action: "dispatcher.turn_failed_reply",
      msg: "turn failed before an answer; the failure text is the channel reply",
      tenant_id,
      conversation_id,
      failure_code: turn.failure.code,
      ...(turn.failure.timeout ? { timeout_phase: turn.failure.timeout.phase } : {}),
    });
    if (opts.replyDelivery === "capture") {
      return {
        status: "ok",
        conversation_id,
        approval_sent: false,
        reply_text: turn.failure.message,
      };
    }
    await sendTracked(adapter, ev.platform, {
      tenant_id,
      workspace_id: ev.workspace_id,
      channel_id: ev.channel_id,
      ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
      kind: "message",
      text: turn.failure.message,
    });
    return { status: "ok", conversation_id, approval_sent: false, reply_text: null };
  }
  const outcome = turn.outcome;

  let approval_sent = false;
  let captured_reply_text: string | null = null;
  if (outcome.status === "awaiting_input" && outcome.pending_elicitation_id) {
    const elicitEvent = outcome.events.find(
      (e): e is Extract<typeof e, { type: "elicit_request" }> => e.type === "elicit_request",
    );
    const summary = elicitEvent?.summary ?? "Input required";
    const toolName = elicitEvent?.tool_name ?? "ask_user_confirm";
    const kind = mapToolNameToKind(toolName);

    const supportsNative =
      kind !== null &&
      adapter.capabilities?.interactive?.includes(kind) === true &&
      typeof adapter.renderElicitation === "function";

    if (supportsNative) {
      const input = (elicitEvent?.input as Record<string, unknown> | undefined) ?? {};
      const elicitation: ChatElicitation = {
        id: outcome.pending_elicitation_id,
        conversation_id,
        kind,
        summary,
      };
      if (typeof input.body === "string") elicitation.body = input.body;
      if (Array.isArray(input.options))
        elicitation.options = input.options as NonNullable<ChatElicitation["options"]>;
      if (Array.isArray(input.fields))
        elicitation.fields = input.fields as NonNullable<ChatElicitation["fields"]>;
      const renderElicitation = adapter.renderElicitation;
      if (!renderElicitation)
        throw new Error("dispatcher: renderElicitation gone after capability check");
      consumeInteractiveSlot(ev.platform, {
        tenant_id,
        workspace_id: ev.workspace_id,
        channel_id: ev.channel_id,
      });
      try {
        await renderElicitation.call(adapter, elicitation, {
          tenant_id,
          workspace_id: ev.workspace_id,
          channel_id: ev.channel_id,
          ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
        });
        recordChatDelivery({ platform: ev.platform, status: "delivered" });
      } catch (err) {
        recordChatDelivery({ platform: ev.platform, status: "failed" });
        throw err;
      }
    } else {
      const card: ApprovalCard = {
        tenant_id,
        workspace_id: ev.workspace_id,
        channel_id: ev.channel_id,
        ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
        conversation_id,
        approval_id: outcome.pending_elicitation_id,
        summary,
      };
      consumeInteractiveSlot(ev.platform, {
        tenant_id,
        workspace_id: ev.workspace_id,
        channel_id: ev.channel_id,
      });
      try {
        await adapter.sendApproval(card);
        recordChatDelivery({ platform: ev.platform, status: "delivered" });
      } catch (err) {
        recordChatDelivery({ platform: ev.platform, status: "failed" });
        throw err;
      }
    }
    approval_sent = true;
  } else {
    const extracted = extractAssistantText(outcome);
    if (extracted === null && outcome.status !== "committed") {
      logger.warn({
        module: "chat",
        action: "dispatcher.no_reply_text",
        msg: "turn produced no assistant text and no `text_delta` events — likely loop regression",
        tenant_id,
        conversation_id,
        outcome_status: outcome.status,
        event_count: outcome.events.length,
      });
    }
    const baseReply =
      extracted ?? (outcome.status === "committed" ? "Committed." : "Still thinking on this…");
    const handoff = intakeReviewHandoff(outcome, conversation_id);
    const replyText = handoff ? `${baseReply}\n\n${handoff}` : baseReply;
    if (opts.replyDelivery === "capture") {
      captured_reply_text = replyText;
    } else {
      await sendTracked(adapter, ev.platform, {
        tenant_id,
        workspace_id: ev.workspace_id,
        channel_id: ev.channel_id,
        ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
        kind: "message",
        text: replyText,
      });
    }
  }

  return {
    status: "ok",
    conversation_id,
    approval_sent,
    loop: outcome,
    reply_text: captured_reply_text,
  };
}
