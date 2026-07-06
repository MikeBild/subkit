// Chat dispatcher — normalized ChatEvent → conversation action.
//
// Responsibilities:
//   1. Look up the chat_workspaces row by (platform, workspace_id)
//      to find the tenant.
//   2. Resolve a chat_identities row → subkit user_id. An *explicit*
//      link is required — no auto-link-to-admin. The installer's
//      platform user is bound at install time via
//      `POST /v1/chat/workspaces.installer_platform_user_id`; further
//      users are linked via the admin `POST /v1/chat/identities`
//      route. Unknown platform users receive an ephemeral "not linked"
//      reply and run no turn; a `chat.message.denied` audit row records
//      the rejection.
//   3. Resolve (or create) a chat_sessions row → conversation_id.
//   4. Route the event to the conversation layer:
//        - mention / slash "chat <prompt>" → createConversation /
//          appendUserMessage
//        - "/new" / "reset" → drop the chat_sessions binding so the
//          next message starts a fresh conversation
//        - interaction (Block-Kit click / view_submission) →
//          respondElicitation with the typed output the adapter
//          extracted
//        - "/subkit run <slug>" → rewritten to a "run <slug>" prompt
//          and routed through the SAME conversation turn as any other
//          run, so RBAC + confirm gate + input contracts hold uniformly
//        - anything else → ephemeral help text via adapter.send
//   5. On `awaiting_input`, render the elicitation natively when the
//      adapter declares `capabilities.interactive.includes(kind)`,
//      otherwise fall back to the legacy sendApproval card.
//   6. On completion, post the assistant's reply (extracted from
//      `RunLoopResult.events`) back into the originating thread.
//
// The dispatcher is intentionally free of adapter-specific types —
// it takes a ChatAdapter at runtime so tests can plug in a fake.

import { and, eq, like } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { registerConversationAbort, unregisterConversationAbort } from "../conversations/abort.ts";
import type { RunLoopResult } from "../conversations/loop.ts";
import {
  appendUserMessage,
  createConversation,
  PendingElicitationBlockedError,
  respondElicitation,
  runConversationTurn,
} from "../conversations/service.ts";
import type { Db } from "../db/client.ts";
import { chatIdentities, chatSessions, chatWorkspaces, conversations } from "../db/schema/index.ts";
import { errorFields, log, logger } from "../logging/logger.ts";
import { tryAcquire } from "../notifications/rate-limit.ts";
import { recordChatDelivery } from "../observability/instrumentation.ts";
import { instrument } from "../observability/runtime-telemetry.ts";
import type { ChatAdapter } from "./adapter.ts";
import { mapToolNameToKind } from "./api.ts";
import { formatChatText } from "./format/outbound-format.ts";
import { resolveChatPrincipal } from "./principal.ts";

// Backward-compat re-export: `DispatchOutcome` moved to
// `./dispatcher-types.ts` (extracted to break a circular dep with
// `elicit-routing.ts`), but the chat/index.ts barrel, the queue
// handler, and existing tests all import the name from
// `./dispatcher.ts`. Re-exporting keeps those call sites working
// without churn. The duplicate local import below is the value-side
// of the re-export — TypeScript requires both shapes when the name
// is used in this file's own type annotations.
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
/**
 * Consume one token from the per-(tenant, workspace, channel) outbound
 * bucket for a LOAD-BEARING interactive message (elicitation render /
 * approval card). Unlike `sendTracked`, exhaustion does NOT drop the
 * message: an unsent card leaves the conversation stuck in
 * awaiting_input with nothing for the user to answer, which is worse
 * than briefly exceeding the platform cap by the handful of cards a
 * turn can produce. The consumption keeps the shared bucket honest —
 * ordinary replies and notifications behind the same bucket back off
 * sooner when cards are flowing.
 */
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
      // Static sentinel — the recordChatDelivery success branch is the
      // only consumer and doesn't need a unique id. Date.now() here
      // would break tests that pin returned ids under a frozen clock
      // and adds no operator value.
      return { platform_message_id: "rate_limited" };
    }
  }
  // Convert the assistant's CommonMark to the platform's native text
  // dialect (single choke point — every conversational reply funnels
  // through here). Slack/Google Chat get real bold/bullets instead of
  // literal `**`/bullet chars; teams/sk_cli pass through. Applied only
  // here, never inside an adapter, to avoid double-conversion.
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

/**
 * Send a conversation reply through the full `sendTracked` pipeline
 * (rate-limit + `formatChatText` + metrics). Used by the sync Google-Chat
 * path's DETACHED branch (timeout → route acks → this delivers on turn
 * completion). NOT `deliver`: that skips the rate-limit, wrong for a
 * per-channel reply that must share the outbound token bucket.
 */
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
  // "/new" / "/reset" / "new" / "reset" resets the thread→conversation
  // binding so the next message starts a fresh turn. Useful for long
  // DMs that have collected a lot of context.
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

/**
 * Extract the final assistant reply text from a completed turn so the
 * chat adapter can post it back into the originating thread. The loop
 * emits an assistant `message` TurnEvent at the end of every turn with
 * `content: { text: string }`; if for some reason the event sink is
 * empty (e.g. a path that bypassed `events.push`), fall back to the
 * concatenated `text_delta` stream which the loop always emits live.
 *
 * Single forward pass — keeps both candidates (last assistant message,
 * concatenated deltas) and picks the assistant message first.
 */
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

export async function handleChatEvent(
  deps: DispatcherDeps,
  ev: ChatEvent,
  opts: HandleChatEventOpts = {},
): Promise<DispatchOutcome> {
  return instrument({
    module: "chat",
    action: "inbound.dispatch",
    fields: { platform: ev.platform, workspace_id: ev.workspace_id },
    fn: () => handleChatEventImpl(deps, ev, opts),
  });
}

/**
 * A chat user TYPED a plain answer while an ask_user_* dialog is still
 * pending (`appendUserMessage` throws PendingElicitationBlockedError —
 * without this salvage the chat.event job died, dedup swallowed the
 * pg-boss retries, and the conversation hung until `/new`). Salvage:
 *
 *   text kind          → resolve with { text: <typed message> }
 *   single-field form  → resolve with { [field.name]: <typed message> }
 *   everything else    → a free-text line can't answer it (buttons /
 *                        checkboxes / multi-field dialog); post one
 *                        line of guidance, leave the dialog pending.
 *
 * Returns the resumed turn's RunLoopResult (the caller's shared
 * post-turn block renders it — awaiting_input and plain replies both)
 * or null when this helper already replied and the caller must
 * early-return. MUST run OUTSIDE the caller's turn lock: the chain is
 * non-reentrant, and `respondElicitation` below takes a FRESH lock.
 */
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
    // Best-effort like every other notify in this helper: a transient
    // send failure must not escape (the job would die and dedup would
    // swallow the retry); the widget is still rendered and answerable.
    await notify(
      "There's a prompt waiting for your answer just above — please use the " +
        "buttons or menu to respond, or type `/new` to start over.",
    ).catch(() => {});
    return null;
  }

  const turnAbortCtrl = registerConversationAbort(tenant_id, conversation_id);
  try {
    const resolved = await withConversationTurnLock(tenant_id, conversation_id, () =>
      respondElicitation(
        {
          tenant_id,
          conversation_id,
          elicitation_id: pending.id,
          actor_id: user_id,
          principal,
          output,
          turn_abort_ctrl: turnAbortCtrl,
          // Shared-space contract: only the initiator may answer.
          require_same_actor: true,
          // The resumed turn must keep the read-only chat palette.
          surface: "chat",
        },
        deps.db,
      ),
    );
    return resolved.result;
  } catch (err) {
    const classified = classifyChatElicitError(err);
    if (classified.kind === "rethrow") throw err;
    if (classified.kind === "validation") {
      await notify(classified.user_text).catch(() => {});
      return null;
    }
    if (classified.kind === "already_resolved") {
      // Raced against a button click / retry — the winner posts the
      // reply; drop the loser silently.
      return null;
    }
    // actor_mismatch / not_found: audit the denial, tell the typist
    // (best-effort) on mismatch, leave the dialog pending.
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
    unregisterConversationAbort(tenant_id, conversation_id, turnAbortCtrl);
  }
}

async function handleChatEventImpl(
  deps: DispatcherDeps,
  ev: ChatEvent,
  opts: HandleChatEventOpts = {},
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
  // Unreachable in production: the chat.event worker resolves the
  // workspace FIRST and owns both DM auto-registration and the
  // rate-limited "not connected" fallback reply for unknown spaces
  // (queue/handlers/chat-event.ts). Kept for direct callers/tests.
  if (!workspace) return { status: "workspace_not_found" };
  const tenant_id = workspace.tenant_id;

  // Non-conversational platform events never run a turn and never need
  // a linked identity. `removed_from_space` drops the space's session
  // bindings — the app can no longer post there, so keeping a live
  // thread→conversation binding would only produce dead-letter outbound
  // sends when the notification path targets the stale channel.
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
        // Include the native space id so "copy the space name from the
        // log" operator guidance works for an already-registered space
        // (the sibling removed_from_space branch already logs it).
        channel_id: ev.channel_id,
        system_event: ev.system_event ?? "unknown",
      });
    }
    return { status: "ignored" };
  }

  // Resolve identity → subkit user. The previous auto-link-to-admin
  // shortcut is gone: it silently elevated any chat user who could
  // message the bot to tenant admin (every conversation tool, including
  // credential access and workflow commits). Now we require an
  // *explicit* link — created at install for the operator via
  // `POST /v1/chat/workspaces.installer_platform_user_id`, and for
  // everyone else via the `POST /v1/chat/identities` admin route. An
  // unknown sender is rejected politely; the dispatcher does no further
  // work for that event.
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
  // Two reject paths share the same outbound + audit shape: unknown
  // identity, and an identity row whose tenant_id doesn't match the
  // workspace's tenant_id. The latter is defense-in-depth — even with
  // the link route's workspace-tenant check (chat-identities.ts), a
  // pre-existing mismatched row (seeded before the fix, hand-inserted)
  // would otherwise bridge tenants because the chat_identities lookup
  // above is keyed only on the global identity tuple.
  const denyReason =
    identity === undefined
      ? "identity_not_linked"
      : identity.tenant_id !== tenant_id
        ? "identity_tenant_mismatch"
        : null;
  if (denyReason !== null) {
    // Surface the rejection so the unknown user knows what's wrong;
    // ephemeral so it doesn't pollute a channel.
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
    } catch {
      // Don't let a rate-limit / outbound failure mask the rejection
      // in audit; we still record the deny below.
    }
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
  // `identity` is defined here because `denyReason === null` requires
  // identity !== undefined; TS's narrowing across the intermediate
  // local variable would otherwise lose this fact.
  if (!identity) throw new Error("dispatcher: identity is unexpectedly undefined after deny check");
  const user_id = identity.user_id;

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

  // Interactions short-circuit to elicitation resolution. The parsing
  // + per-kind validation + `respondElicitation` plumbing lives in
  // `elicit-routing.ts` — it's self-contained (no closure over the
  // rest of this turn's state) and large enough to merit its own
  // module under the audit-invariant size cap.
  if (ev.kind === "interaction" && ev.interaction) {
    return await routeChatInteraction({
      ev,
      tenant_id,
      user_id,
      db,
      // Lets elicit-routing surface a validation re-prompt in-channel
      // (the elicitation row stays pending, so the user just answers
      // again) without pulling the dispatcher's module graph into it.
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

  // Parse command for mention + slash events.
  const rawText = ev.text ?? "";
  const parsed = parseSlashCommand(rawText);

  // `/new` (or `reset`) — drop the thread→conversation binding so the
  // very next message starts a fresh `createConversation` turn. The
  // existing conversation row is left untouched (audit trail) — only
  // the `chat_sessions` mapping is removed.
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
    // Bare mention with no verb — treat the text (minus any bot id)
    // as the chat prompt.
    prompt = rawText.replace(/^<@[A-Za-z0-9]+>\s*/, "").trim();
  } else if (parsed && parsed.verb === "run") {
    // /subkit run <workflow> k=v ... — routed through the SAME
    // conversation turn every other run takes. The previous inline
    // implementation duplicated a weaker copy of the run contract:
    // it checked `workflow:run` RBAC but skipped the confirm gate
    // (`gateTenantToolCall`) and the input-contract deferral the
    // fast-path / `run_workflow` tool enforce — an execute_writes
    // workflow ran unconfirmed from chat. Handing the verb to the
    // conversation flow gives one run contract everywhere: RBAC +
    // confirm (rendered as the chat approval card via the
    // awaiting_input handling below) + auto-generated input forms.
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

  // Synthetic chat principal threaded into the turn so the fast-path
  // matcher and run_workflow gate on the linked user's RBAC instead of
  // failing `principal_required`.
  const chatPrincipal = await resolveChatPrincipal(db, tenant_id, user_id);

  let conversation_id: string;
  let outcome: RunLoopResult;
  if (existing) {
    conversation_id = existing.conversation_id;
    // Every turn caller threads a controller. Chat dispatch is
    // the same shape as the HTTP messages route: we know the
    // conversation_id from the lookup above, register synchronously,
    // unregister in `finally`. The append + turn split: `appendUserMessage`
    // persists the message row, `runConversationTurn` drives the loop.
    //
    // The turn lock serializes concurrent turns on the shared space
    // conversation: two members mentioning the bot at once would
    // otherwise interleave two runLoop turns over the same timeline.
    try {
      outcome = await withConversationTurnLock(tenant_id, conversation_id, async () => {
        const turnAbortCtrl = registerConversationAbort(tenant_id, conversation_id);
        try {
          const appended = await appendUserMessage(
            { tenant_id, conversation_id, actor_id: user_id, message: prompt },
            db,
          );
          const turn = await runConversationTurn(
            {
              tenant_id,
              conversation_id,
              actor_id: user_id,
              principal: chatPrincipal,
              user_message: appended.message,
              user_memory: appended.user_memory,
              turn_abort_ctrl: turnAbortCtrl,
              // Channel-scoped read-only contract: the chat surface selects
              // the CHAT_READONLY_TOOLS palette + chat persona in the loop.
              surface: "chat",
            },
            db,
          );
          return turn.result;
        } finally {
          unregisterConversationAbort(tenant_id, conversation_id, turnAbortCtrl);
        }
      });
    } catch (err) {
      // The user typed a message while an ask_user_* dialog is pending.
      // The catch sits OUTSIDE the turn lock (non-reentrant chain — the
      // blocked append already released it; the salvage takes a fresh
      // one). Only the existing-conversation branch can hit this: a
      // fresh conversation has no pending elicitation.
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
      // Fall through: the resumed turn may itself pause on a follow-up
      // elicitation or produce a normal reply — the shared post-turn
      // block below renders both exactly once.
      outcome = resumed;
    }
  } else {
    const created = await createConversation(
      { tenant_id, actor_id: user_id, initial_message: prompt },
      db,
    );
    conversation_id = created.conversation.id;
    // A same-space create race is bounded by the DB: the
    // chat_sessions_workspace_thread_key unique index makes the loser
    // throw, pg-boss retries it, and the retry finds the winner's
    // session. The turn lock below then covers the turn itself.
    await db.insert(chatSessions).values({
      tenant_id,
      workspace_id: workspace.id,
      thread_id: threadKey,
      conversation_id,
    });
    outcome = await withConversationTurnLock(tenant_id, conversation_id, async () => {
      const turnAbortCtrl = registerConversationAbort(tenant_id, conversation_id);
      try {
        const turn = await runConversationTurn(
          {
            tenant_id,
            conversation_id,
            actor_id: user_id,
            principal: chatPrincipal,
            user_message: created.initial_message ?? "",
            user_memory: created.user_memory,
            turn_abort_ctrl: turnAbortCtrl,
            // Same channel-scoped read-only contract as the resume path.
            surface: "chat",
          },
          db,
        );
        return turn.result;
      } finally {
        unregisterConversationAbort(tenant_id, conversation_id, turnAbortCtrl);
      }
    });
  }

  let approval_sent = false;
  // Capture mode: the dispatcher computes the terminal reply but does not
  // send it (the sync Google-Chat helper owns delivery). Stays null on
  // every non-terminal branch (awaiting_input/ignored/help) so the caller
  // distinguishes "card already sent inline" from "reply text to post".
  let captured_reply_text: string | null = null;
  if (outcome.status === "awaiting_input" && outcome.pending_elicitation_id) {
    const elicitEvent = outcome.events.find(
      (e): e is Extract<typeof e, { type: "elicit_request" }> => e.type === "elicit_request",
    );
    const summary = elicitEvent?.summary ?? "Input required";
    const toolName = elicitEvent?.tool_name ?? "ask_user_confirm";
    const kind = mapToolNameToKind(toolName);

    // Prefer native rendering when the adapter declares the kind in
    // its `capabilities`. Falls back to the legacy `sendApproval`
    // Approve/Reject card so adapters that haven't shipped native
    // rendering (Teams, Google in this phase) still surface
    // *something* the user can act on. An unknown `tool_name`
    // (`kind === null`) also routes through the fallback path —
    // mis-rendering a future ask_user_* tool as confirm would
    // mis-shape the user's typed answer.
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
    // Post the actual assistant reply into the thread. Falls back to a
    // status line if the turn somehow produced no text (commit-only
    // turn, or an event-sink path we don't recognise) so the user
    // always sees *something* from the bot.
    const extracted = extractAssistantText(outcome);
    if (extracted === null && outcome.status !== "committed") {
      // No assistant text AND not a normal commit-only turn — this
      // is a systematic loop regression the operator wants to see,
      // not a silent "(no reply)" the user just stares at.
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
    // Soft fallback for the loop-regression branch (extracted === null
    // AND status !== committed): the operator-facing warn above gets
    // the alert; the user gets a neutral status instead of a literal
    // "(no reply)" that trains them to ignore the bot.
    const replyText =
      extracted ?? (outcome.status === "committed" ? "Committed." : "Still thinking on this…");
    if (opts.replyDelivery === "capture") {
      // Capture-only: the sync helper delivers this exactly once (HTTP
      // body, or a detached send on timeout). Sending here double-posts.
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
    reply_text: captured_reply_text,
  };
}
