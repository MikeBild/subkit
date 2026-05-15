// Conversation DB persistence + SDK message-history assembly.
//
// All writes from the loop go through here. `buildModelMessages` walks
// `conversation_messages` and `conversation_tool_calls` in created_at
// order and emits an AI SDK `ModelMessage[]` with stable tool-call ids
// copied from `conversation_tool_calls.id`. Real providers (Anthropic)
// need this shape; the mock model only reads the final user content to
// parse the `[conv:<id>]` envelope that keys its plan cursor.

import type { FilePart, ImagePart, ModelMessage, TextPart } from "ai";
import { and, asc, eq } from "drizzle-orm";
import { assertInsertRow } from "../db/assert-insert.ts";
import type { Db } from "../db/client.ts";
import {
  conversationElicitations,
  conversationMessages,
  conversationToolCalls,
} from "../db/schema/index.ts";
import { FILE_SENTINEL_RE } from "../files/sentinel.ts";
import { countModelMessagesTokens } from "../llm/accounting/index.ts";
import { getStaticCapabilities } from "../llm/core/capabilities.ts";
import { buildFileContentBlocks, type FileContentBlock } from "../llm/core/file-context.ts";
import type { ProviderKind } from "../llm/core/model-init.ts";
import { rememberRaw, truncateForLlm } from "./tools/truncate.ts";

function approxValueSize(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function rememberRawForElision(value: unknown): string {
  return rememberRaw(value);
}

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
const MAX_REPLAY_MESSAGES = 24;
const MAX_REPLAY_TOKENS = 12_000;
const REPLAY_TAIL_MESSAGES = 16;

// Sliding window over replayed tool-call outputs. Tool calls executed in
// the most recent N user-turn segments keep their output verbatim; older
// large outputs are replaced with a one-line stub that retains the
// existing `_raw_ref` so the model can fetch the full payload via
// `get_raw_result(ref)` if it really needs it.
//
// The bug this guards against: a single `inspect_workflow_draft` call
// returning a 480k-char payload was being re-sent on every subsequent
// turn (≈120k tokens × every turn) until the prompt overflowed at >200k.
// Once the model has summarized a tool result into prose, the raw payload
// contributes nothing to the next turn — but we kept it forever.
const TOOL_OUTPUT_VERBATIM_TURNS = 3;
const TOOL_OUTPUT_ELIDE_THRESHOLD_CHARS = 4000;

/**
 * Build multimodal UserContent for a conversation turn that may
 * reference file attachments. Routes every `[file:fid_...]` sentinel
 * through the canonical `buildFileContentBlocks` strategy router
 * (file_api / file_part / text_extract — see `llm/core/file-context.ts`).
 *
 * Returns a plain string when the turn has no file refs (fast path,
 * preserves existing behaviour for all-text turns).
 */
export async function buildUserContentParts(
  db: Db,
  tenant_id: string,
  _conversation_id: string,
  text: string,
  provider: ProviderKind = "anthropic",
): Promise<string | Array<TextPart | ImagePart | FilePart>> {
  // Quick exit: no file sentinels → plain string (unchanged behaviour).
  // Use a fresh regex per scan so concurrent buildUserContentParts calls
  // don't collide on the shared `lastIndex`.
  const scanRe = new RegExp(FILE_SENTINEL_RE.source, "g");
  const fids: string[] = [];
  for (let m = scanRe.exec(text); m !== null; m = scanRe.exec(text)) {
    const fid = m[1];
    if (fid && !fids.includes(fid)) fids.push(fid);
  }

  if (fids.length === 0) return text;

  const caps = getStaticCapabilities(provider);
  const assembled = await buildFileContentBlocks({
    db,
    tenant_id,
    provider,
    capabilities: caps,
    fids,
  });

  // Strip the sentinels from the surrounding prose so the LLM sees the
  // human-readable text plus the assembled content blocks separately.
  const stripRe = new RegExp(FILE_SENTINEL_RE.source, "g");
  const textWithoutRefs = text.replace(stripRe, "").replace(/\s+/g, " ").trim();

  const parts: Array<TextPart | ImagePart | FilePart> = [];
  if (textWithoutRefs) parts.push({ type: "text", text: textWithoutRefs });
  for (const block of assembled.blocks) {
    parts.push(...toAiSdkParts(block));
  }
  if (parts.length === 0) return text;
  return parts.length === 1 && parts[0]?.type === "text" ? (parts[0] as TextPart).text : parts;
}

/** Translate one assembler block into AI SDK content parts. `file_api`
 *  carries the provider-native id through `providerOptions` so the
 *  upstream provider adapter can splice the native reference shape into
 *  the request without re-uploading. `file_part` becomes a FilePart for
 *  PDFs / generic binaries or an ImagePart for image media types
 *  (depending on capabilities). `text_extract` becomes a TextPart. */
function toAiSdkParts(block: FileContentBlock): Array<TextPart | ImagePart | FilePart> {
  if (block.strategy === "file_api") {
    // Round-trip the provider-native shape through JSON so it satisfies
    // the AI SDK's `JSONValue` constraint on `providerOptions` (typed
    // unions don't widen automatically).
    const native = JSON.parse(JSON.stringify(block.native));
    return [
      {
        type: "file",
        data: new Uint8Array(0),
        mediaType: block.content_type,
        filename: block.filename,
        providerOptions: {
          [block.provider]: { file_id: block.file_id, native },
        },
      },
    ];
  }
  if (block.strategy === "file_part") {
    if (block.mediaType.startsWith("image/")) {
      return [{ type: "image", image: block.data, mediaType: block.mediaType }];
    }
    return [
      {
        type: "file",
        data: block.data,
        mediaType: block.mediaType,
        filename: block.filename,
      },
    ];
  }
  return [{ type: "text", text: block.text }];
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
  /**
   * Provider routing for the per-turn file-strategy assembler. Every
   * replayed user-role message that carries a `[file:fid_...]` sentinel
   * is routed through `buildUserContentParts(provider)` so prior turns
   * reuse the same file_api / file_part / text_extract decision as the
   * current turn — and reuse the cached provider-native file id where
   * applicable. Defaults to `"anthropic"` to match the production loop.
   */
  provider?: ProviderKind;
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
      .where(
        and(
          eq(conversationMessages.tenant_id, tenant_id),
          eq(conversationMessages.conversation_id, conversation_id),
        ),
      )
      .orderBy(asc(conversationMessages.created_at)),
    db
      .select()
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, tenant_id),
          eq(conversationToolCalls.conversation_id, conversation_id),
        ),
      )
      .orderBy(asc(conversationToolCalls.created_at)),
    db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, tenant_id),
          eq(conversationElicitations.conversation_id, conversation_id),
        ),
      )
      .orderBy(asc(conversationElicitations.created_at)),
  ]);
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

  // Tool-output sliding window. Keep verbatim only the tool calls
  // produced after the Nth-from-last user message; older bulky outputs
  // collapse to a one-line stub. Ask-user elicitations are never elided
  // (they carry the user's answer, not raw payload).
  const userMessageTimestamps = msgs
    .filter((m) => m.role === "user")
    .map((m) => m.created_at)
    .sort((a, b) => a.getTime() - b.getTime());
  const verbatimWindowStartAt =
    userMessageTimestamps.length > TOOL_OUTPUT_VERBATIM_TURNS
      ? (userMessageTimestamps[userMessageTimestamps.length - TOOL_OUTPUT_VERBATIM_TURNS] ?? null)
      : null;

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
        // Route every replayed user-role message through the same
        // strategy assembler the current turn uses. Without this, prior
        // turns that referenced a file would ship the literal sentinel
        // `[file:fid_<uuid>]` to the LLM as raw text — no file_api /
        // file_part / text_extract assembly, no provider-id reuse on
        // prior turns. See FIX block 1 in checkpoint C: turn 2 must
        // see turn 1's user message ALSO as a content block, not as
        // raw sentinel text. The strategy router's per-turn 250 KiB
        // cap continues to apply per-message — a multi-turn
        // conversation with several files degrades to text_extract
        // faster, which is correct.
        const text = messageText(content);
        const userPartsProvider = opts.provider ?? "anthropic";
        if (db && tenant_id && /\[file:fid_/.test(text)) {
          // We need a Db (not just Executor) for the strategy router;
          // the production loop always passes one. Fall through to the
          // plain string when only an Executor is available — the only
          // call site without a Db is direct-tx replay, which doesn't
          // ship file refs.
          const dbForRouter = db as unknown as Db;
          const parts = await buildUserContentParts(
            dbForRouter,
            tenant_id,
            conversation_id,
            text,
            userPartsProvider,
          );
          // `buildUserContentParts` returns `string | Array<TextPart |
          // ImagePart | FilePart>`, which is exactly the AI SDK
          // `UserContent` shape — push as a typed user message.
          if (typeof parts === "string") {
            out.push({ role: "user", content: parts });
          } else {
            out.push({ role: "user", content: parts });
          }
        } else {
          out.push({ role: "user", content: text });
        }
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
        const isOutsideVerbatimWindow =
          verbatimWindowStartAt !== null && call.created_at < verbatimWindowStartAt;
        const augmentedSize = approxValueSize(augmented);
        if (isOutsideVerbatimWindow && augmentedSize > TOOL_OUTPUT_ELIDE_THRESHOLD_CHARS) {
          // Older, bulky tool result — elide. Reuse the existing
          // `_raw_ref` if persist already truncated this output on the
          // way in; otherwise mint a fresh ref so the model can still
          // fetch the full payload via `get_raw_result`.
          const existingRef = typeof rawOutput._raw_ref === "string" ? rawOutput._raw_ref : null;
          const ref = existingRef ?? rememberRawForElision(augmented);
          resultValue = {
            _elided: true,
            _tool: call.tool,
            _raw_ref: ref,
            _note: `<elided: tool=${call.tool}, ref=${ref}, original=${augmentedSize} chars; call get_raw_result(ref="${ref}") for the full payload>`,
          };
        } else {
          const truncated = truncateForLlm(augmented);
          resultValue = truncated.truncated
            ? {
                ...(truncated.data as Record<string, unknown>),
                _truncated: true,
                _raw_ref: truncated.raw_ref,
                _note: truncated.note,
              }
            : augmented;
        }
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
