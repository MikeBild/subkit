// Conversation DB persistence + SDK message-history assembly.
//
// All writes from the loop go through here. `buildModelMessages` walks
// `conversation_messages` and `conversation_tool_calls` in created_at
// order and emits an AI SDK `ModelMessage[]` with stable tool-call ids
// copied from `conversation_tool_calls.id`. Real providers (Anthropic)
// need this shape; the mock model only reads the final user content to
// parse the `[conv:<id>]` envelope that keys its plan cursor.

import type { FilePart, ImagePart, ModelMessage, TextPart } from "ai";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { assertInsertRow } from "../db/assert-insert.ts";
import type { Db, Executor } from "../db/client.ts";
import { fileLinks } from "../db/schema/files.ts";
import {
  conversationElicitations,
  conversationMessages,
  conversationToolCalls,
} from "../db/schema/index.ts";
import { extractFileSentinels, replaceFileSentinels } from "../files/sentinel.ts";
import { countModelMessagesTokens } from "../llm/accounting/index.ts";
import { getStaticCapabilities } from "../llm/core/capabilities.ts";
import { buildFileContentBlocks, type FileContentBlock } from "../llm/core/file-context.ts";
import type { ProviderKind } from "../llm/core/model-init.ts";
import { logger } from "../logging/logger.ts";
import { scrubString } from "../logging/scrub-secrets.ts";
import {
  recordFileLlmCapDowngrade,
  recordFileLlmInlineBytes,
} from "../observability/instrumentation.ts";
import {
  approxValueSize,
  buildElidedToolOutputStub,
  TOOL_OUTPUT_ELIDE_THRESHOLD_CHARS,
} from "./tool-output-elision.ts";
import { rememberRaw, truncateForLlm } from "./tools/truncate.ts";

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
// Elide threshold + stub shape are shared with the within-turn path
// (loop.ts prepareStep) via ./tool-output-elision.ts — both replay
// paths emit the identical `_elided` stub convention.

// SQL-side projection marker. The summary-window query (outputs older
// than the verbatim cutoff) replaces any tool output whose serialized
// length exceeds TOOL_OUTPUT_ELIDE_THRESHOLD_CHARS with a tiny object
// carrying this discriminator + size + any pre-existing `_raw_ref`.
// The replay loop detects it and emits the `_elided` stub without ever
// loading the bulky payload into the JS heap. Before this, the loop
// loaded every prior tool output (multi-MB JSONB each) only to discard
// it via the same elision check; on a 50-turn conversation that added
// hundreds of MB of transient garbage per turn.
const ELIDED_SQL_MARKER = "__sk_elided_in_sql";

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
  conversation_id: string,
  text: string,
  provider: ProviderKind = "anthropic",
): Promise<string | Array<TextPart | ImagePart | FilePart>> {
  // Quick exit: no file sentinels → plain string (unchanged behaviour).
  const fids = extractFileSentinels(text);

  if (fids.length === 0) return text;

  // Privilege-boundary check: every fid extracted from raw user prose
  // MUST be linked to THIS conversation via `file_links`. The
  // `@attachment:<slug>` rewriter only produces sentinels for slugs that
  // ARE in `file_links`, so the legitimate authoring path is unchanged.
  // The attack we close: a user types `[file:fid_<real-uuid>]` into the
  // prompt directly, naming a fid that exists in their tenant but is
  // attached to a different conversation. Without this check the
  // resolver would pull bytes from that file into the current turn.
  // Strip un-linked sentinels to a `[file]` placeholder so the model
  // sees a neutral artefact instead of confusing missing-file errors.
  const fidUuids = fids
    .map((fid) => (fid.startsWith("fid_") ? fid.slice("fid_".length) : null))
    .filter((u): u is string => u !== null);
  const linkedRows =
    fidUuids.length > 0
      ? await db
          .select({ file_id: fileLinks.file_id })
          .from(fileLinks)
          .where(
            and(
              eq(fileLinks.tenant_id, tenant_id),
              eq(fileLinks.resource_type, "conversation"),
              eq(fileLinks.resource_id, conversation_id),
              inArray(fileLinks.file_id, fidUuids),
            ),
          )
      : [];
  const linkedSet = new Set(linkedRows.map((r) => r.file_id));
  const allowedFids: string[] = [];
  const deniedFids: string[] = [];
  for (const fid of fids) {
    const uuid = fid.startsWith("fid_") ? fid.slice("fid_".length) : null;
    if (uuid && linkedSet.has(uuid)) allowedFids.push(fid);
    else deniedFids.push(fid);
  }
  if (deniedFids.length > 0) {
    logger.warn({
      module: "conversations.persist",
      action: "user_content.unlinked_sentinel_stripped",
      tenant_id,
      conversation_id,
      denied_count: deniedFids.length,
      // Truncated to keep the log compact; the count alone is the
      // operator signal — repeated stripping would surface in the
      // metric, not the log line.
      sample: deniedFids.slice(0, 3),
    });
  }

  if (allowedFids.length === 0) {
    // Every sentinel was un-linked; collapse them all to placeholders.
    const stripped = (await replaceFileSentinels(text, () => "[file]")) as string;
    return stripped.replace(/\s+/g, " ").trim();
  }

  const caps = getStaticCapabilities(provider);
  const assembled = await buildFileContentBlocks({
    db,
    tenant_id,
    provider,
    capabilities: caps,
    fids: allowedFids,
  });

  // Surface the per-turn inline bytes + cap downgrades so the operator
  // can chart how often the cap is biting per tenant. The assembler
  // already enforces the 250 KiB hard cap;
  // these counters give the operator a per-tenant view of how often
  // the cap is biting (rising downgrades = the model is increasingly
  // seeing parser-extracted text instead of raw bytes for image / PDF
  // input). Both helpers are no-throw.
  if (assembled.inline_bytes > 0) {
    recordFileLlmInlineBytes({ tenant_id, bytes: assembled.inline_bytes });
  }
  if (assembled.inline_cap_downgrades > 0) {
    recordFileLlmCapDowngrade({ tenant_id, count: assembled.inline_cap_downgrades });
  }

  // Strip the sentinels from the surrounding prose so the LLM sees the
  // human-readable text plus the assembled content blocks separately.
  // Un-linked sentinels become a literal `[file]` placeholder so the
  // model never sees the raw fid the user typed.
  const replaced = (await replaceFileSentinels(text, (fid) =>
    allowedFids.includes(fid) ? "" : "[file]",
  )) as string;
  const textWithoutRefs = replaced.replace(/\s+/g, " ").trim();

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
  // Persistence safety net: a user-pasted secret must never land raw in
  // `conversation_messages` (rows are replayed into every later model
  // turn AND rendered in transcripts). Pattern-only scrub on the text
  // leaf at the single insert chokepoint — covers `service/append.ts`,
  // `service/create.ts`, and the loop's user-row inserts.
  // Capture-to-credential-cache happens upstream in `service/append.ts`.
  // This row is the persisted REPLAY source. `scrubString`'s generic
  // high-entropy matcher is code-context-suppressed (it redacts a run on
  // shape by default but leaves a codec alphabet or a non-secret
  // `var/const/let = "..."` literal alone), so a pasted workflow / code
  // definition survives VERBATIM into replay while a bare pasted secret —
  // including the lone-paste shape with no keyword — still scrubs.
  if (role === "user" && content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") content = { ...c, text: scrubString(c.text) };
  }
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
  // Two scoping micro-queries first. Both touch only timestamps + tiny
  // content slices so neither loads bulk row data. They resolve the two
  // cutoffs that the rest of the function operates against:
  //   replayStartAt        — the latest compacted-summary system message;
  //                          everything older is collapsed into that
  //                          summary and never replayed verbatim.
  //   verbatimWindowStartAt — the timestamp of the Nth-from-last user
  //                          message; tool calls older than this lose
  //                          their bulky `output` payload via SQL-side
  //                          projection (see ELIDED_SQL_MARKER above).
  const [latestCompactionRow] = await db
    .select({
      created_at: conversationMessages.created_at,
      content: conversationMessages.content,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, tenant_id),
        eq(conversationMessages.conversation_id, conversation_id),
        eq(conversationMessages.role, "system"),
        sql`${conversationMessages.content}->>'kind' = 'compacted'`,
      ),
    )
    .orderBy(desc(conversationMessages.created_at))
    .limit(1);
  const replayStartAt = latestCompactionRow?.created_at ?? null;

  const recentUserRows = await db
    .select({ created_at: conversationMessages.created_at })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, tenant_id),
        eq(conversationMessages.conversation_id, conversation_id),
        eq(conversationMessages.role, "user"),
      ),
    )
    .orderBy(desc(conversationMessages.created_at))
    .limit(TOOL_OUTPUT_VERBATIM_TURNS + 1);
  // The Nth-from-last user message timestamp = the start of the verbatim
  // window. recentUserRows is descending, so when we have more than
  // TOOL_OUTPUT_VERBATIM_TURNS rows the cutoff is the LAST row in the
  // limited slice (which corresponds to the (N+1)th-from-last user msg).
  const verbatimWindowStartAt =
    recentUserRows.length > TOOL_OUTPUT_VERBATIM_TURNS
      ? (recentUserRows[recentUserRows.length - 2]?.created_at ?? null)
      : null;

  // Lower bound for the bulk queries. When a compaction marker exists,
  // we only replay rows newer than it; older rows are already encoded in
  // the marker's summary.
  const lowerBoundClauseMessages = replayStartAt
    ? gte(conversationMessages.created_at, replayStartAt)
    : undefined;
  const lowerBoundClauseElicitations = replayStartAt
    ? gte(conversationElicitations.created_at, replayStartAt)
    : undefined;
  const lowerBoundClauseCalls = replayStartAt
    ? gte(conversationToolCalls.created_at, replayStartAt)
    : undefined;

  // Tool-calls split: verbatim window keeps full `output`; summary
  // window replaces any output > ELIDE_THRESHOLD bytes with a tiny
  // discriminator object built in SQL (no bulk transfer, no JS heap).
  // `tenant_id` is named in the predicate so the audit-invariants
  // tenant-filter scanner recognises it through the `where(<const>)`
  // indirection.
  const callsVerbatimWhereTenant = and(
    eq(conversationToolCalls.tenant_id, tenant_id),
    eq(conversationToolCalls.conversation_id, conversation_id),
    ...(verbatimWindowStartAt
      ? [gte(conversationToolCalls.created_at, verbatimWindowStartAt)]
      : lowerBoundClauseCalls
        ? [lowerBoundClauseCalls]
        : []),
  );
  const callsSummaryWhereTenant = verbatimWindowStartAt
    ? and(
        eq(conversationToolCalls.tenant_id, tenant_id),
        eq(conversationToolCalls.conversation_id, conversation_id),
        lt(conversationToolCalls.created_at, verbatimWindowStartAt),
        ...(lowerBoundClauseCalls ? [lowerBoundClauseCalls] : []),
      )
    : null;

  // `ELIDED_SQL_MARKER` is a compile-time constant with no quotes, so
  // inlining it via `sql.raw` is safe and avoids Postgres `42P18`
  // ("could not determine data type of parameter") — `jsonb_build_object`
  // is variadic, so a bound `text` parameter has no inferable position-
  // typed signature for the planner to lock onto.
  const summaryOutputProjection = sql<unknown>`CASE
    WHEN ${conversationToolCalls.output} IS NULL THEN NULL
    WHEN octet_length(${conversationToolCalls.output}::text) > ${TOOL_OUTPUT_ELIDE_THRESHOLD_CHARS}
      THEN jsonb_build_object(
        ${sql.raw(`'${ELIDED_SQL_MARKER}'`)}, true,
        '_raw_ref', ${conversationToolCalls.output}->>'_raw_ref',
        '_orig_bytes', octet_length(${conversationToolCalls.output}::text)
      )
    ELSE ${conversationToolCalls.output}
  END`;

  const [msgs, callsVerbatim, callsSummary, elicitations] = await Promise.all([
    db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.tenant_id, tenant_id),
          eq(conversationMessages.conversation_id, conversation_id),
          ...(lowerBoundClauseMessages ? [lowerBoundClauseMessages] : []),
        ),
      )
      .orderBy(asc(conversationMessages.created_at)),
    db
      .select()
      .from(conversationToolCalls)
      .where(callsVerbatimWhereTenant)
      .orderBy(asc(conversationToolCalls.created_at)),
    callsSummaryWhereTenant
      ? db
          .select({
            id: conversationToolCalls.id,
            tenant_id: conversationToolCalls.tenant_id,
            conversation_id: conversationToolCalls.conversation_id,
            parent_message_id: conversationToolCalls.parent_message_id,
            tool: conversationToolCalls.tool,
            input: conversationToolCalls.input,
            output: summaryOutputProjection,
            approval_required: conversationToolCalls.approval_required,
            approved_at: conversationToolCalls.approved_at,
            approved_by_user_id: conversationToolCalls.approved_by_user_id,
            confirmation_state: conversationToolCalls.confirmation_state,
            confirmation_data: conversationToolCalls.confirmation_data,
            interaction_log: conversationToolCalls.interaction_log,
            created_at: conversationToolCalls.created_at,
          })
          .from(conversationToolCalls)
          .where(callsSummaryWhereTenant)
          .orderBy(asc(conversationToolCalls.created_at))
      : Promise.resolve([] as Array<typeof conversationToolCalls.$inferSelect>),
    db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, tenant_id),
          eq(conversationElicitations.conversation_id, conversation_id),
          ...(lowerBoundClauseElicitations ? [lowerBoundClauseElicitations] : []),
        ),
      )
      .orderBy(asc(conversationElicitations.created_at)),
  ]);
  // Unify the two tool-call slices. They share the same shape modulo
  // `output` (summary rows carry the elision marker on bulky outputs).
  // The downstream replay loop is monomorphic over this combined array.
  const calls = [...callsSummary, ...callsVerbatim].sort(
    (a, b) => a.created_at.getTime() - b.created_at.getTime(),
  );
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
  // `replayStartAt` and `verbatimWindowStartAt` were resolved up-front by
  // the two scoping micro-queries; the bulk SELECTs above already clamp
  // by `replayStartAt`, so we don't need to re-derive these from `msgs`
  // or filter again in the items loop.

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
  const latestCompactionSummary = latestCompactionRow
    ? compactedSummary(latestCompactionRow.content)
    : null;
  if (latestCompactionSummary) {
    out.push({ role: "system", content: latestCompactionSummary });
  }
  for (const item of items) {
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
        if (db && tenant_id && extractFileSentinels(text).length > 0) {
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
        // Pre-elided fast path: the summary-window SQL projection
        // already replaced bulky outputs with a tiny discriminator
        // object. Build the `_elided` stub directly from it — no need
        // to load the multi-MB original, no `augmented` clone, no
        // approxValueSize JSON.stringify pass. This is the per-turn
        // allocation that the OOM-on-conversation-16a865f8 trace was
        // burning hundreds of MB on.
        if (rawOutput[ELIDED_SQL_MARKER] === true) {
          const existingRef = typeof rawOutput._raw_ref === "string" ? rawOutput._raw_ref : null;
          const origBytes = typeof rawOutput._orig_bytes === "number" ? rawOutput._orig_bytes : 0;
          const ref = existingRef ?? rememberRaw(undefined);
          resultValue = buildElidedToolOutputStub({
            tool: call.tool,
            ref,
            original_size: origBytes,
            size_unit: "bytes",
          });
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
          continue;
        }
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
          // fetch the full payload via `get_raw_result`. This branch
          // still fires for the small-but-augmented case (output ≤4 KB
          // raw but pushed over threshold once confirmation_state /
          // interaction_log are spliced in).
          const existingRef = typeof rawOutput._raw_ref === "string" ? rawOutput._raw_ref : null;
          const ref = existingRef ?? rememberRaw(augmented);
          resultValue = buildElidedToolOutputStub({
            tool: call.tool,
            ref,
            original_size: augmentedSize,
            size_unit: "chars",
          });
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
