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
//        - "/subkit run <slug>" → createExecution + enqueueRun
//        - anything else → ephemeral help text via adapter.send
//   5. On `awaiting_input`, render the elicitation natively when the
//      adapter declares `capabilities.interactive.includes(kind)`,
//      otherwise fall back to the legacy sendApproval card.
//   6. On completion, post the assistant's reply (extracted from
//      `RunLoopResult.events`) back into the originating thread.
//
// The dispatcher is intentionally free of adapter-specific types —
// it takes a ChatAdapter at runtime so tests can plug in a fake.

import { and, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { registerConversationAbort, unregisterConversationAbort } from "../conversations/abort.ts";
import type { RunLoopResult } from "../conversations/loop.ts";
import {
  appendUserMessage,
  createConversation,
  respondElicitation,
  runConversationTurn,
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
import { mapToolNameToKind } from "./api.ts";
import {
  type ApprovalCard,
  CHAT_RATES,
  type ChatElicitation,
  type ChatEvent,
  type ChatPlatform,
} from "./types.ts";

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

/** Parse a Block Kit action `value` JSON envelope produced by the
 *  native elicitation renderers. The envelope shape `{c, o}` carries
 *  the `conversation_id` (`c`) and the typed elicitation output (`o`);
 *  invalid / non-JSON values return null so the dispatcher can ignore.
 *  Parse failures emit a warn so a renderer regression surfaces in
 *  diagnostics rather than as an opaque `ignored` status. */
function parseEnvelope(raw: string): { c: string; o?: unknown } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.c === "string") {
      return parsed as { c: string; o?: unknown };
    }
    logger.warn({
      module: "chat",
      action: "interaction.envelope_malformed",
      msg: "interaction value JSON-parsed but did not match the {c,o} envelope shape",
    });
  } catch (err) {
    logger.warn({
      module: "chat",
      action: "interaction.envelope_parse_failed",
      msg: "interaction value is not valid JSON — Block-Kit renderer regression?",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

/** Parse the Slack modal `private_metadata` JSON `{c, e, k}` carrying
 *  conversation_id, elicitation_id, and the elicitation kind. */
function parseViewMetadata(raw: string): { c: string; e: string; k: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.c === "string" &&
      typeof parsed.e === "string" &&
      typeof parsed.k === "string"
    ) {
      return parsed as { c: string; e: string; k: string };
    }
    logger.warn({
      module: "chat",
      action: "interaction.view_metadata_malformed",
      msg: "view.private_metadata JSON-parsed but did not match the {c,e,k} shape",
    });
  } catch (err) {
    logger.warn({
      module: "chat",
      action: "interaction.view_metadata_parse_failed",
      msg: "view.private_metadata is not valid JSON — modal-view builder regression?",
      error: err instanceof Error ? err.message : String(err),
    });
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
function extractAssistantText(outcome: RunLoopResult): string | null {
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

  // Interactions short-circuit to elicitation resolution. We accept
  // four action_id families:
  //
  //   approve:<elic_id> / reject:<elic_id>
  //       Legacy ApprovalCard path (kept; the existing block-kit
  //       Approve/Reject card is still a valid render).
  //   elicit:<elic_id>:confirm | :choice | :multi:select | :multi:submit
  //       Native elicitation rendering produced by
  //       `adapter.renderElicitation`. Value carries a JSON envelope
  //       `{c: conversation_id, o: <typed output>}`; `multi:select` is
  //       the per-checkbox change event and is ignored — the dispatcher
  //       acts on `multi:submit` only.
  //   view_submission
  //       Slack modal submission. `value` is the modal's
  //       `private_metadata` JSON `{c, e, k}`; `form_values` is the
  //       flat `{field_name: primitive}` dict the adapter assembled.
  //       The dispatcher maps `form_values` to the right
  //       `respondElicitation` output shape based on the kind in
  //       private_metadata.
  //   open_elicit:<elic_id>
  //       Handled synchronously by the route's `handleSyncInteraction`
  //       fast path before enqueue; should never reach the dispatcher.
  //       Ignored defensively if it does.
  if (ev.kind === "interaction" && ev.interaction) {
    const action_id = ev.interaction.action_id;
    const actionValue = ev.interaction.value ?? "";

    // No-op: per-checkbox change. We resolve on the submit click.
    if (/^elicit:[^:]+:multi:select$/.test(action_id)) {
      return { status: "ignored" };
    }
    // No-op: opener click handled by the sync fast path.
    if (/^open_elicit:/.test(action_id)) {
      return { status: "ignored" };
    }

    let conversation_id = "";
    let elicitation_id = "";
    let output: unknown = null;

    const legacy = /^(approve|reject):(.+)$/.exec(action_id);
    if (legacy) {
      // Legacy ApprovalCard: value is the bare conversation_id (raw
      // string, NOT JSON). A JSON-shaped value here means a renderer
      // emitted the new `{c,o}` envelope under a legacy action_id —
      // fail-closed log so the renderer regression surfaces before
      // we feed a JSON string into `respondElicitation` as the
      // conversation_id.
      if (actionValue.startsWith("{")) {
        logger.warn({
          module: "chat",
          action: "interaction.legacy_value_shape_mismatch",
          msg: "approve/reject action carries an envelope-shaped value — renderer regression?",
          action_id,
        });
        return { status: "ignored" };
      }
      elicitation_id = legacy[2] ?? "";
      conversation_id = actionValue;
      output = { confirmed: legacy[1] === "approve" };
    } else {
      const elicit = /^elicit:([^:]+):(confirm|choice|multi:submit)$/.exec(action_id);
      if (elicit) {
        elicitation_id = elicit[1] ?? "";
        const envelope = parseEnvelope(actionValue);
        conversation_id = envelope?.c ?? "";
        // For `multi:submit` the typed selections come from form_values
        // (the adapter re-encoded the checkbox state); for confirm /
        // choice the typed output rides in the envelope's `o`.
        if (elicit[2] === "multi:submit") {
          output = ev.interaction.form_values ?? { values: [] };
        } else {
          output = envelope?.o ?? null;
        }
      } else if (action_id === "view_submission") {
        const meta = parseViewMetadata(actionValue);
        if (!meta) return { status: "ignored" };
        conversation_id = meta.c;
        elicitation_id = meta.e;
        // form_values is the flat dict the adapter assembled from
        // view.state.values; map it to the right output shape per
        // elicitation kind.
        const fv = ev.interaction.form_values ?? {};
        if (meta.k === "text") {
          // ask_user_text expects `{ text }`. The single-field modal
          // stores the answer under the field name `answer` (see
          // `buildElicitationModal`).
          output = { text: typeof fv.answer === "string" ? fv.answer : "" };
        } else {
          // ask_user_form passes the whole field dict through.
          output = fv;
        }
      } else {
        return { status: "ignored" };
      }
    }

    if (!conversation_id || !elicitation_id) {
      return { status: "ignored" };
    }

    // #148 — every respondElicitation caller threads a controller.
    const turnAbortCtrl = registerConversationAbort(tenant_id, conversation_id);
    try {
      await respondElicitation(
        {
          tenant_id,
          conversation_id,
          elicitation_id,
          actor_id: user_id,
          output: (output ?? {}) as Record<string, unknown>,
          turn_abort_ctrl: turnAbortCtrl,
        },
        db,
      );
    } finally {
      unregisterConversationAbort(tenant_id, conversation_id, turnAbortCtrl);
    }
    const isApprove =
      legacy?.[1] === "approve" ||
      (typeof output === "object" &&
        output !== null &&
        (output as { confirmed?: boolean }).confirmed === true);
    return {
      status: isApprove ? "approved" : "rejected",
      conversation_id,
    };
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
    // role/group/grant ladder. Preload the linked user's enum role so
    // the evaluator's admin short-circuit fires when applicable.
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
    // #148 — every turn caller threads a controller. Chat dispatch is
    // the same shape as the HTTP messages route: we know the
    // conversation_id from the lookup above, register synchronously,
    // unregister in `finally`. The append + turn split: `appendUserMessage`
    // persists the message row, `runConversationTurn` drives the loop.
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
          user_message: appended.message,
          user_memory: appended.user_memory,
          turn_abort_ctrl: turnAbortCtrl,
        },
        db,
      );
      outcome = turn.result;
    } finally {
      unregisterConversationAbort(tenant_id, conversation_id, turnAbortCtrl);
    }
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
    const turnAbortCtrl = registerConversationAbort(tenant_id, conversation_id);
    try {
      const turn = await runConversationTurn(
        {
          tenant_id,
          conversation_id,
          actor_id: user_id,
          user_message: created.initial_message ?? "",
          user_memory: created.user_memory,
          turn_abort_ctrl: turnAbortCtrl,
        },
        db,
      );
      outcome = turn.result;
    } finally {
      unregisterConversationAbort(tenant_id, conversation_id, turnAbortCtrl);
    }
  }

  let approval_sent = false;
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
    // *something* the user can act on.
    const supportsNative =
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
        msg: "turn produced no assistant text and no `text_delta` events — loop regression?",
        tenant_id,
        conversation_id,
        outcome_status: outcome.status,
        event_count: outcome.events.length,
      });
    }
    const replyText = extracted ?? (outcome.status === "committed" ? "Committed." : "(no reply)");
    await sendTracked(adapter, ev.platform, {
      tenant_id,
      workspace_id: ev.workspace_id,
      channel_id: ev.channel_id,
      ...(ev.thread_id ? { thread_id: ev.thread_id } : {}),
      kind: "message",
      text: replyText,
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
