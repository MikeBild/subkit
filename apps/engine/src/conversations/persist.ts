// Conversation DB persistence + SDK message-history assembly.
//
// All writes from the loop go through here. `buildModelMessages` walks
// `conversation_messages` and `conversation_tool_calls` in created_at
// order and emits an AI SDK `ModelMessage[]` with stable tool-call ids
// copied from `conversation_tool_calls.id`. Real providers (Anthropic)
// need this shape; the mock model only reads the final user content to
// parse the `[conv:<id>]` envelope that keys its plan cursor.

import type { FilePart, ImagePart, ModelMessage, TextPart } from "ai";
import { asc, eq } from "drizzle-orm";
import { assertInsertRow } from "../db/assert-insert.ts";
import type { Db } from "../db/client.ts";
import {
  conversationAttachments,
  conversationElicitations,
  conversationMessages,
  conversationToolCalls,
} from "../db/schema/index.ts";
import type { ModelCapabilities } from "../llm/core/capabilities.ts";
import { getStaticCapabilities } from "../llm/core/capabilities.ts";
import type { ProviderKind } from "../llm/core/model-init.ts";
import { countModelMessagesTokens } from "../llm/tokens.ts";
import { truncateForLlm } from "./tools/truncate.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
const MAX_REPLAY_MESSAGES = 24;
const MAX_REPLAY_TOKENS = 12_000;
const REPLAY_TAIL_MESSAGES = 16;

/**
 * Build multimodal UserContent for a conversation turn that may reference
 * file attachments. For image/PDF attachments with a capable provider the
 * content part carries actual binary data; otherwise the file is inlined
 * as text (the existing behaviour).
 *
 * Returns `string` when no attachments are relevant (fast path, preserves
 * existing behaviour for all-text turns).
 */
export async function buildUserContentParts(
  db: Db,
  conversation_id: string,
  text: string,
  provider: ProviderKind = "anthropic",
): Promise<string | Array<TextPart | ImagePart | FilePart>> {
  const caps: ModelCapabilities = getStaticCapabilities(provider);

  // Quick exit: no attachment references → plain string (unchanged behaviour)
  const ATTACHMENT_RE = /@attachment:([a-z0-9][a-z0-9_-]{0,62})\b/g;
  const slugs: string[] = [];
  for (let m = ATTACHMENT_RE.exec(text); m !== null; m = ATTACHMENT_RE.exec(text)) {
    const slug = m[1];
    if (slug) slugs.push(slug);
  }
  ATTACHMENT_RE.lastIndex = 0;

  if (slugs.length === 0) return text;

  const rows = await db
    .select()
    .from(conversationAttachments)
    .where(eq(conversationAttachments.conversation_id, conversation_id));

  const rowMap = new Map(rows.map((r) => [r.slug, r]));
  const parts: Array<TextPart | ImagePart | FilePart> = [];

  // Build a text part for non-attachment text surrounding the refs
  const textWithoutRefs = text.replace(/@attachment:[a-z0-9][a-z0-9_-]{0,62}\b/g, "").trim();
  if (textWithoutRefs) parts.push({ type: "text", text: textWithoutRefs });

  for (const slug of slugs) {
    const row = rowMap.get(slug);
    if (!row) continue;

    const mime = row.content_type ?? "application/octet-stream";
    const isImage = mime.startsWith("image/");
    const isPdf = mime === "application/pdf" || row.original_filename.endsWith(".pdf");

    if (isImage && caps.supportsImage && row.storage_uri.startsWith("file://")) {
      try {
        const imgData = await Bun.file(row.storage_uri.slice("file://".length)).bytes();
        parts.push({ type: "image", image: imgData, mediaType: mime });
        continue;
      } catch {
        // fallback to text preview
      }
    }

    if (isPdf && caps.supportsFile && row.storage_uri.startsWith("file://")) {
      try {
        const pdfData = await Bun.file(row.storage_uri.slice("file://".length)).bytes();
        parts.push({ type: "file", data: pdfData, mediaType: "application/pdf" });
        continue;
      } catch {
        // fallback to text preview
      }
    }

    // Fallback: include preview text
    if (row.preview) parts.push({ type: "text", text: `[${slug}]:\n${row.preview}` });
  }

  return parts.length === 1 && parts[0]?.type === "text" ? (parts[0] as TextPart).text : parts;
}

export async function appendMessage(
  db: Executor,
  tenant_id: string,
  conversation_id: string,
  role: "user" | "assistant" | "tool" | "system",
  content: unknown,
): Promise<string> {
  const [row] = await db
    .insert(conversationMessages)
    .values({ tenant_id, conversation_id, role, content: content as Record<string, unknown> })
    .returning({ id: conversationMessages.id });
  assertInsertRow(row, "conversation_messages");
  return row.id;
}

export async function updateMessageContent(
  db: Executor,
  message_id: string,
  content: unknown,
): Promise<void> {
  await db
    .update(conversationMessages)
    .set({ content: content as Record<string, unknown> })
    .where(eq(conversationMessages.id, message_id));
}

export async function insertToolCall(
  db: Executor,
  params: {
    tenant_id: string;
    conversation_id: string;
    parent_message_id?: string | null;
    tool: string;
    input: unknown;
    approval_required: boolean;
  },
): Promise<string> {
  const [row] = await db
    .insert(conversationToolCalls)
    .values({
      tenant_id: params.tenant_id,
      conversation_id: params.conversation_id,
      ...(params.parent_message_id ? { parent_message_id: params.parent_message_id } : {}),
      tool: params.tool,
      input: params.input as Record<string, unknown>,
      approval_required: params.approval_required,
    })
    .returning({ id: conversationToolCalls.id });
  assertInsertRow(row, "conversation_tool_calls");
  return row.id;
}

/**
 * Back-fill `parent_message_id` on tool-call rows that were inserted
 * during a step before the step's assistant message existed. Called
 * from the loop's `onStepFinish` so child rows can anchor causally to
 * the assistant turn that produced them.
 */
export async function setToolCallParentMessage(
  db: Executor,
  ids: string[],
  parent_message_id: string,
): Promise<void> {
  if (ids.length === 0) return;
  const { inArray } = await import("drizzle-orm");
  await db
    .update(conversationToolCalls)
    .set({ parent_message_id })
    .where(inArray(conversationToolCalls.id, ids));
}

export async function updateToolCallOutput(
  db: Executor,
  tool_call_id: string,
  output: unknown,
): Promise<void> {
  await db
    .update(conversationToolCalls)
    .set({ output: output as Record<string, unknown> })
    .where(eq(conversationToolCalls.id, tool_call_id));
}

interface BuildModelMessagesOpts {
  /**
   * Extra user turn to append at the very end (the current turn's
   * message). Pass `null` on approval-resume where no new message is
   * available.
   */
  currentUserMessage?: string | null;
  /**
   * When true, prepend the `[conv:<id>]` envelope to the very last
   * user turn's content. The mock model parses this envelope to look
   * up the plan cursor.
   */
  conversationEnvelope?: boolean;
  /** Conversation id — required when `conversationEnvelope` is true. */
  conversation_id?: string;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "text" in content) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return JSON.stringify(content ?? "");
}

function truncateExcerpt(text: string, max = 140): string {
  const squashed = text.replace(/\s+/g, " ").trim();
  if (squashed.length <= max) return squashed;
  return `${squashed.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function compactedSummary(content: unknown): string | null {
  if (!content || typeof content !== "object") return null;
  const obj = content as { kind?: unknown; summary?: unknown };
  if (obj.kind !== "compacted" || typeof obj.summary !== "string") return null;
  const summary = obj.summary.trim();
  return summary.length > 0 ? summary : null;
}

function isAskUserToolName(value: string | null | undefined): boolean {
  return (
    value === "ask_user_choice" ||
    value === "ask_user_multi" ||
    value === "ask_user_text" ||
    value === "ask_user_form" ||
    value === "ask_user_confirm"
  );
}

function resolveElicitationToolCallId(
  elicitation: typeof conversationElicitations.$inferSelect,
  calls: Array<typeof conversationToolCalls.$inferSelect>,
): string | null {
  if (typeof elicitation.tool_call_id === "string" && elicitation.tool_call_id.length > 0) {
    return elicitation.tool_call_id;
  }
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (!call || call.tool !== elicitation.tool_name) continue;
    if (call.created_at.getTime() <= elicitation.created_at.getTime()) {
      return call.id;
    }
  }
  return null;
}

function messageExcerpt(message: ModelMessage): string | null {
  if (typeof message.content !== "string") return null;
  const text = message.content.trim();
  return text.length > 0 ? truncateExcerpt(text) : null;
}

function summarizeReplayPrefix(messages: ModelMessage[]): string {
  const userCount = messages.filter((message) => message.role === "user").length;
  const assistantCount = messages.filter((message) => message.role === "assistant").length;
  const toolCount = messages.filter((message) => message.role === "tool").length;
  const firstUser = messages.find((message) => message.role === "user");
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const parts = [
    `Conversation summary: collapsed ${messages.length} earlier message(s)`,
    `(${userCount} user, ${assistantCount} assistant, ${toolCount} tool result).`,
  ];
  const firstUserExcerpt = firstUser ? messageExcerpt(firstUser) : null;
  if (firstUserExcerpt) parts.push(`Initial user goal: ${firstUserExcerpt}.`);
  const lastUserExcerpt = lastUser ? messageExcerpt(lastUser) : null;
  if (lastUserExcerpt && lastUserExcerpt !== firstUserExcerpt) {
    parts.push(`Most recent collapsed user request: ${lastUserExcerpt}.`);
  }
  const lastAssistantExcerpt = lastAssistant ? messageExcerpt(lastAssistant) : null;
  if (lastAssistantExcerpt) {
    parts.push(`Most recent collapsed assistant summary: ${lastAssistantExcerpt}.`);
  }
  return parts.join(" ");
}

function maybeCompactReplay(messages: ModelMessage[]): ModelMessage[] {
  if (
    messages.length <= MAX_REPLAY_MESSAGES &&
    countModelMessagesTokens(messages) <= MAX_REPLAY_TOKENS
  ) {
    return messages;
  }
  let splitIndex = Math.max(1, messages.length - REPLAY_TAIL_MESSAGES);
  // Never slice between an assistant `tool-call` and its following `tool`
  // `tool-result`. Advance past leading `tool` rows so the tail never starts
  // with an unpaired tool-result (Anthropic rejects with
  // "unexpected tool_use_id ... in tool_result blocks").
  while (splitIndex < messages.length && messages[splitIndex]?.role === "tool") {
    splitIndex++;
  }
  const prefix = messages.slice(0, splitIndex);
  const tail = messages.slice(splitIndex);
  if (prefix.length === 0) return messages;
  return [{ role: "system", content: summarizeReplayPrefix(prefix) }, ...tail];
}

/**
 * Merge `conversation_messages` + `conversation_tool_calls` into a
 * single AI SDK `ModelMessage[]`, ordered by created_at.
 *
 * Mapping rules:
 *   - user row → `{ role: "user", content: text }`
 *   - assistant text row → `{ role: "assistant", content: text }`
 *   - tool_calls row (unexecuted, output null) → assistant(tool-call only)
 *   - tool_calls row (executed, output set) → assistant(tool-call) + tool(tool-result)
 *   - resolved ask_user_* elicitation → tool(tool-result with the user's answer)
 *   - tool row with `{ decision }` (the approval-decision note injected
 *     by `decideApproval`) → user turn `"approval <id>: <decision>..."`
 *     so the model sees the resolution without leaking into the
 *     tool-result stream.
 */
export async function buildModelMessages(
  db: Executor,
  tenant_id: string,
  conversation_id: string,
  opts: BuildModelMessagesOpts = {},
): Promise<ModelMessage[]> {
  const [msgs, calls, elicitations] = await Promise.all([
    db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversation_id, conversation_id))
      .orderBy(asc(conversationMessages.created_at)),
    db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversation_id))
      .orderBy(asc(conversationToolCalls.created_at)),
    db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.conversation_id, conversation_id))
      .orderBy(asc(conversationElicitations.created_at)),
  ]);
  void tenant_id;
  const callsById = new Map(calls.map((call) => [call.id, call]));
  const replayableElicitations = elicitations
    .map((elicitation) => {
      const toolCallId = resolveElicitationToolCallId(elicitation, calls);
      const call = toolCallId ? (callsById.get(toolCallId) ?? null) : null;
      if (!call || !isAskUserToolName(call.tool) || elicitation.status !== "resolved") {
        return null;
      }
      return {
        elicitation,
        tool_call_id: toolCallId,
        tool_name: call.tool,
        replay_at: elicitation.decided_at ?? elicitation.updated_at ?? elicitation.created_at,
      };
    })
    .filter(
      (
        value,
      ): value is {
        elicitation: typeof conversationElicitations.$inferSelect;
        tool_call_id: string;
        tool_name: string;
        replay_at: Date;
      } => value !== null,
    );
  // Index resolved elicitations by tool_call_id so the `call` emission
  // branch can splice the user's answer in *immediately* after the
  // matching `assistant[tool-call]` block, instead of relying on
  // chronological ordering across other items. Out-of-order elicitation
  // resolution was the root cause of the "unexpected `tool_use_id` found
  // in `tool_result` blocks" 503 — the tool_use and its tool_result were
  // separated by intervening assistant text or other tool calls, which
  // Anthropic rejects.
  const resolvedElicitationByCallId = new Map(
    replayableElicitations.map((entry) => [entry.tool_call_id, entry] as const),
  );
  const latestCompaction = [...msgs]
    .reverse()
    .find((message) => message.role === "system" && compactedSummary(message.content) !== null);
  const replayStartAt = latestCompaction?.created_at ?? null;

  interface Item {
    kind: "msg" | "call";
    created_at: Date;
    msg?: (typeof msgs)[number];
    call?: (typeof calls)[number];
  }
  // Resolved elicitations are no longer separate items — their
  // tool-result is emitted inline next to the matching tool-call so the
  // assistant→tool adjacency Anthropic requires is preserved.
  const items: Item[] = [
    ...msgs.map((m): Item => ({ kind: "msg", created_at: m.created_at, msg: m })),
    ...calls.map((c): Item => ({ kind: "call", created_at: c.created_at, call: c })),
  ];
  items.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

  const out: ModelMessage[] = [];
  const latestCompactionSummary = latestCompaction
    ? compactedSummary(latestCompaction.content)
    : null;
  if (latestCompactionSummary) {
    out.push({ role: "system", content: latestCompactionSummary });
  }
  for (const item of items) {
    if (replayStartAt && item.created_at < replayStartAt) continue;
    if (item.kind === "msg" && item.msg) {
      const role = item.msg.role;
      const content = item.msg.content;
      if (role === "system") continue;
      if (role === "user") {
        out.push({ role: "user", content: messageText(content) });
      } else if (role === "assistant") {
        const text = messageText(content);
        if (text.length > 0) out.push({ role: "assistant", content: text });
      } else if (role === "tool") {
        const obj = (content ?? {}) as Record<string, unknown>;
        const decision = typeof obj.decision === "string" ? obj.decision : null;
        if (decision) {
          const tool = typeof obj.tool === "string" ? obj.tool : "tool";
          const reason =
            typeof obj.reason === "string" && obj.reason.length > 0
              ? ` (reason: ${obj.reason})`
              : "";
          out.push({
            role: "user",
            content: `${tool}: decision=${decision}${reason}. Continue.`,
          });
        }
        // Skip bare tool rows that are not decision notes — real
        // tool-results are already emitted via the call branch below
        // from conversation_tool_calls.
      }
    } else if (item.kind === "call" && item.call) {
      const call = item.call;
      out.push({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.tool,
            input: call.input as unknown,
          },
        ],
      });
      // Hard rule: every emitted `tool-call` MUST be followed by a
      // `tool-result` for the same toolCallId in the very next message.
      // Anthropic rejects any gap with a 4xx that the SDK surfaces as
      // 503 llm_provider_unavailable ("unexpected `tool_use_id` found in
      // `tool_result` blocks: …"). We pick the result payload in
      // priority order:
      //   1. resolved ask-user elicitation answer (overrides the
      //      pending "awaiting_input" output the tool wrote when it
      //      paused — that placeholder is never replayed),
      //   2. real call output (any other tool that produced a result),
      //   3. synthetic abandoned-result (orphaned / superseded).
      const resolvedElicitation = resolvedElicitationByCallId.get(call.id) ?? null;
      let resultValue: Record<string, unknown>;
      if (isAskUserToolName(call.tool) && resolvedElicitation) {
        resultValue = {
          status: "resolved",
          elicitation_id: resolvedElicitation.elicitation.id,
          response: resolvedElicitation.elicitation.output,
          reason: resolvedElicitation.elicitation.decision_reason ?? null,
        };
      } else if (call.output !== null && call.output !== undefined) {
        // Splice confirmation state + interaction_log into the
        // tool-result payload the model sees on the next turn. This
        // lets the model distinguish "user tested" from "user
        // confirmed" and re-issue the tool with `__policy_confirmed`
        // when appropriate — faithful replay of
        // `conversation_tool_calls.interaction_log` append-only rows.
        const confirmationState = call.confirmation_state;
        const interactionLog = Array.isArray(call.interaction_log)
          ? (call.interaction_log as Array<Record<string, unknown>>)
          : [];
        const rawOutput = call.output as Record<string, unknown>;
        const augmented: Record<string, unknown> = { ...rawOutput };
        if (confirmationState) augmented.confirmationState = confirmationState;
        if (interactionLog.length > 0) augmented.interactionLog = interactionLog;
        const truncated = truncateForLlm(augmented);
        resultValue = truncated.truncated
          ? {
              ...(truncated.data as Record<string, unknown>),
              _truncated: true,
              _raw_ref: truncated.raw_ref,
              _note: truncated.note,
            }
          : augmented;
      } else if (resolvedElicitation) {
        resultValue = {
          status: "resolved",
          elicitation_id: resolvedElicitation.elicitation.id,
          response: resolvedElicitation.elicitation.output,
          reason: resolvedElicitation.elicitation.decision_reason ?? null,
        };
      } else {
        // Orphaned tool-call — the run was interrupted before the tool
        // could produce a result, or the elicitation was superseded by
        // a newer one. Emit a synthetic abandoned-result so the
        // tool_use/tool_result pair stays balanced. The model sees this
        // as "the previous request was abandoned" and continues from
        // the latest user message.
        resultValue = {
          ok: false,
          abandoned: true,
          reason: "elicitation_superseded",
        };
      }
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: call.id,
            toolName: call.tool,
            output: {
              type: "json",
              value: resultValue as Parameters<typeof JSON.stringify>[0],
            },
          },
        ],
      });
    }
  }

  if (opts.currentUserMessage) {
    out.push({ role: "user", content: opts.currentUserMessage });
  }

  if (opts.conversationEnvelope && opts.conversation_id) {
    // Prepend the [conv:<id>] envelope to the last user turn's content
    // so the mock model can key its plan cursor off it. Real providers
    // (Anthropic) treat it as a harmless opaque prefix.
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i];
      if (m && m.role === "user" && typeof m.content === "string") {
        out[i] = { role: "user", content: `[conv:${opts.conversation_id}] ${m.content}` };
        break;
      }
    }
  }

  return maybeCompactReplay(out);
}
