import type { FilePart, ImagePart, ModelMessage, TextPart } from "ai";
import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { assertInsertRow } from "../../db/assert-insert.ts";
import type { Db, Executor } from "../../db/client.ts";
import { fileLinks } from "../../db/schema/files.ts";
import {
  conversationElicitations,
  conversationMessages,
  conversationToolCalls,
} from "../../db/schema/index.ts";
import { extractFileSentinels, replaceFileSentinels } from "../../files/sentinel.ts";
import { countModelMessagesTokens } from "../../llm/accounting/index.ts";
import { getStaticCapabilities } from "../../llm/runtime/capabilities.ts";
import { buildFileContentBlocks, type FileContentBlock } from "../../llm/runtime/file-context.ts";
import type { ProviderKind } from "../../llm/runtime/model-init.ts";
import { logger } from "../../logging/index.ts";
import { scrubString } from "../../logging/scrub-secrets.ts";
import {
  recordFileLlmCapDowngrade,
  recordFileLlmInlineBytes,
} from "../../observability/instrumentation.ts";
import { rememberRaw, truncateForLlm } from "../../tools/truncate.ts";
import { isProseQuestionElicitation, proseQuestionAnswer } from "../prose-question-answer.ts";
import { scrubReferenceLabels } from "../references.ts";
import { dropAssistantTail } from "../replay-tail.ts";
import { ensureConversationTitle } from "../title.ts";
import {
  approxValueSize,
  buildCriticalToolOutputStub,
  buildElidedToolOutputStub,
  isReplayCriticalToolOutput,
  TOOL_OUTPUT_ELIDE_THRESHOLD_CHARS,
  TOOL_OUTPUT_VERBATIM_TURNS,
} from "../tool-output-elision.ts";
import type { ToolCallOutcome } from "../tools/result-payload.ts";

const MAX_REPLAY_MESSAGES = 24;
const MAX_REPLAY_TOKENS = 12_000;
const REPLAY_TAIL_MESSAGES = 16;

const ELIDED_SQL_MARKER = "__sk_elided_in_sql";

export async function buildUserContentParts(
  db: Db,
  tenant_id: string,
  conversation_id: string,
  text: string,
  provider: ProviderKind = "anthropic",
): Promise<string | Array<TextPart | ImagePart | FilePart>> {
  const fids = extractFileSentinels(text);

  if (fids.length === 0) return text;

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
      sample: deniedFids.slice(0, 3),
    });
  }

  if (allowedFids.length === 0) {
    const stripped = (await replaceFileSentinels(text, () => "[file]")) as string;
    return stripped.replace(/\s+/g, " ").trim();
  }

  const caps = getStaticCapabilities(provider);
  const assembled = await buildFileContentBlocks({
    db,
    tenant_id,
    capabilities: caps,
    fids: allowedFids,
  });

  if (assembled.inline_bytes > 0) {
    recordFileLlmInlineBytes({ tenant_id, bytes: assembled.inline_bytes });
  }
  if (assembled.inline_cap_downgrades > 0) {
    recordFileLlmCapDowngrade({ tenant_id, count: assembled.inline_cap_downgrades });
  }

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

export function toAiSdkParts(block: FileContentBlock): Array<TextPart | ImagePart | FilePart> {
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
  options: { model?: string | null } = {},
): Promise<string> {
  if (role === "user" && content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") content = { ...c, text: scrubString(c.text) };
    content = scrubReferenceLabels(content);
  }
  const [row] = await db
    .insert(conversationMessages)
    .values({
      tenant_id,
      conversation_id,
      role,
      content: content as Record<string, unknown>,
      model: role === "assistant" ? (options.model ?? null) : null,
    })
    .returning({ id: conversationMessages.id });
  assertInsertRow(row, "conversation_messages");
  if (role === "user") await ensureConversationTitle(db, tenant_id, conversation_id, content);
  return row.id;
}

export async function updateMessageContent(
  db: Executor,
  message_id: string,
  content: unknown,
  options: { model?: string | null } = {},
): Promise<void> {
  await db
    .update(conversationMessages)
    .set({
      content: content as Record<string, unknown>,
      ...(options.model !== undefined ? { model: options.model } : {}),
    })
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
    confirmation_data?: Record<string, unknown>;
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
      ...(params.confirmation_data ? { confirmation_data: params.confirmation_data } : {}),
    })
    .returning({ id: conversationToolCalls.id });
  assertInsertRow(row, "conversation_tool_calls");
  return row.id;
}

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
  outcome: ToolCallOutcome,
): Promise<void> {
  await db
    .update(conversationToolCalls)
    .set({ output: output as Record<string, unknown>, outcome })
    .where(eq(conversationToolCalls.id, tool_call_id));
}

interface BuildModelMessagesOpts {
  currentUserMessage?: string | null;
  conversationEnvelope?: boolean;
  conversation_id?: string;
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

function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "text" in content) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
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
  if (isProseQuestionElicitation(elicitation)) return null;
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
  while (splitIndex < messages.length && messages[splitIndex]?.role === "tool") {
    splitIndex++;
  }
  const prefix = messages.slice(0, splitIndex);
  const tail = messages.slice(splitIndex);
  if (prefix.length === 0) return messages;
  const instructions = prefix.filter((message) => message.role === "user");
  return [{ role: "system", content: summarizeReplayPrefix(prefix) }, ...instructions, ...tail];
}

export async function buildModelMessages(
  db: Executor,
  tenant_id: string,
  conversation_id: string,
  opts: BuildModelMessagesOpts = {},
): Promise<ModelMessage[]> {
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
  const verbatimWindowStartAt =
    recentUserRows.length > TOOL_OUTPUT_VERBATIM_TURNS
      ? (recentUserRows[recentUserRows.length - 2]?.created_at ?? null)
      : null;

  const lowerBoundClauseMessages = replayStartAt
    ? gte(conversationMessages.created_at, replayStartAt)
    : undefined;
  const lowerBoundClauseCalls = replayStartAt
    ? gte(conversationToolCalls.created_at, replayStartAt)
    : undefined;

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

  const summaryOutputProjection = sql<unknown>`CASE
    WHEN ${conversationToolCalls.output} IS NULL THEN NULL
    WHEN octet_length(${conversationToolCalls.output}::text) > ${TOOL_OUTPUT_ELIDE_THRESHOLD_CHARS}
      THEN jsonb_build_object(
        ${sql.raw(`'${ELIDED_SQL_MARKER}'`)}, true,
        '_raw_ref', ${conversationToolCalls.output}->>'_raw_ref',
        '_orig_bytes', octet_length(${conversationToolCalls.output}::text),
        '_critical', (
          COALESCE(${conversationToolCalls.output}->>'ok', 'true') = 'false'
          OR COALESCE(${conversationToolCalls.output}->>'writes_held', 'false') = 'true'
          OR ${conversationToolCalls.output}->>'error_code' IS NOT NULL
          OR COALESCE(${conversationToolCalls.output}->>'status', '') = 'failed'
        ),
        'ok', ${conversationToolCalls.output}->'ok',
        'error_code', COALESCE(
          ${conversationToolCalls.output}->'error_code',
          ${conversationToolCalls.output}->'data'->'error_code'
        ),
        'message', COALESCE(
          ${conversationToolCalls.output}->'message',
          ${conversationToolCalls.output}->'data'->'message'
        ),
        'writes_held', COALESCE(
          ${conversationToolCalls.output}->'writes_held',
          ${conversationToolCalls.output}->'data'->'writes_held'
        ),
        'held_step_ids', COALESCE(
          ${conversationToolCalls.output}->'held_step_ids',
          ${conversationToolCalls.output}->'data'->'held_step_ids'
        ),
        'status', COALESCE(
          ${conversationToolCalls.output}->'status',
          ${conversationToolCalls.output}->'data'->'status'
        ),
        'execution_id', COALESCE(
          ${conversationToolCalls.output}->'execution_id',
          ${conversationToolCalls.output}->'data'->'execution_id'
        ),
        'workflow_id', COALESCE(
          ${conversationToolCalls.output}->'workflow_id',
          ${conversationToolCalls.output}->'data'->'workflow_id'
        ),
        'workflow_version_id', COALESCE(
          ${conversationToolCalls.output}->'workflow_version_id',
          ${conversationToolCalls.output}->'data'->'workflow_version_id'
        ),
        'resource_id', COALESCE(
          ${conversationToolCalls.output}->'resource_id',
          ${conversationToolCalls.output}->'data'->'resource_id'
        ),
        'resource_ids', COALESCE(
          ${conversationToolCalls.output}->'resource_ids',
          ${conversationToolCalls.output}->'data'->'resource_ids'
        )
      )
    ELSE ${conversationToolCalls.output}
  END`;

  const messageContentProjection = sql<unknown>`CASE
    WHEN ${conversationMessages.role} = 'tool' AND ${conversationMessages.content}->>'decision' IS NULL
      THEN '{}'::jsonb
    WHEN ${conversationMessages.role} = 'tool'
      THEN jsonb_build_object(
        'decision', ${conversationMessages.content}->'decision',
        'tool', ${conversationMessages.content}->'tool',
        'reason', ${conversationMessages.content}->'reason'
      )
    ELSE ${conversationMessages.content}
  END`;

  const [msgs, callsVerbatim, callsSummary, elicitations] = await Promise.all([
    db
      .select({
        id: conversationMessages.id,
        tenant_id: conversationMessages.tenant_id,
        conversation_id: conversationMessages.conversation_id,
        role: conversationMessages.role,
        content: messageContentProjection,
        tokens_in: conversationMessages.tokens_in,
        tokens_out: conversationMessages.tokens_out,
        created_at: conversationMessages.created_at,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.tenant_id, tenant_id),
          eq(conversationMessages.conversation_id, conversation_id),
          ...(lowerBoundClauseMessages
            ? [or(eq(conversationMessages.role, "user"), lowerBoundClauseMessages)]
            : []),
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
            outcome: conversationToolCalls.outcome,
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
        ),
      )
      .orderBy(asc(conversationElicitations.created_at)),
  ]);
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
  const resolvedElicitationByCallId = new Map(
    replayableElicitations.map((entry) => [entry.tool_call_id, entry] as const),
  );

  interface Item {
    kind: "msg" | "call" | "prose-answer";
    created_at: Date;
    msg?: (typeof msgs)[number];
    call?: (typeof calls)[number];
    answer?: string;
  }
  const items: Item[] = [
    ...msgs.map((m): Item => ({ kind: "msg", created_at: m.created_at, msg: m })),
    ...calls.map((c): Item => ({ kind: "call", created_at: c.created_at, call: c })),
    ...elicitations.flatMap((row): Item[] => {
      const answer = proseQuestionAnswer(row);
      return answer === null
        ? []
        : [{ kind: "prose-answer", created_at: row.decided_at ?? row.updated_at, answer }];
    }),
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
    if (item.kind === "prose-answer" && item.answer !== undefined) {
      out.push({ role: "user", content: item.answer });
      continue;
    }
    if (item.kind === "msg" && item.msg) {
      const role = item.msg.role;
      const content = item.msg.content;
      if (role === "system") continue;
      if (role === "user") {
        const text = messageText(content);
        const userPartsProvider = opts.provider ?? "anthropic";
        if (db && tenant_id && extractFileSentinels(text).length > 0) {
          const dbForRouter = db as unknown as Db;
          const parts = await buildUserContentParts(
            dbForRouter,
            tenant_id,
            conversation_id,
            text,
            userPartsProvider,
          );
          if (typeof parts === "string") {
            out.push({ role: "user", content: parts });
          } else {
            out.push({ role: "user", content: parts });
          }
        } else {
          out.push({ role: "user", content: text });
        }
      } else if (role === "assistant") {
        const text = assistantText(content);
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
        const confirmationState = call.confirmation_state;
        const interactionLog = Array.isArray(call.interaction_log)
          ? (call.interaction_log as Array<Record<string, unknown>>)
          : [];
        const rawOutput = call.output as Record<string, unknown>;
        if (rawOutput[ELIDED_SQL_MARKER] === true) {
          const existingRef = typeof rawOutput._raw_ref === "string" ? rawOutput._raw_ref : null;
          const origBytes = typeof rawOutput._orig_bytes === "number" ? rawOutput._orig_bytes : 0;
          const ref = existingRef ?? rememberRaw(undefined);
          resultValue =
            rawOutput._critical === true || isReplayCriticalToolOutput(rawOutput)
              ? buildCriticalToolOutputStub({
                  tool: call.tool,
                  ref,
                  original_size: origBytes,
                  size_unit: "bytes",
                  output: rawOutput,
                })
              : buildElidedToolOutputStub({
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
        const augmentedSize = isOutsideVerbatimWindow ? approxValueSize(augmented) : 0;
        if (isOutsideVerbatimWindow && augmentedSize > TOOL_OUTPUT_ELIDE_THRESHOLD_CHARS) {
          const existingRef = typeof rawOutput._raw_ref === "string" ? rawOutput._raw_ref : null;
          const ref = existingRef ?? rememberRaw(augmented);
          resultValue = isReplayCriticalToolOutput(augmented)
            ? buildCriticalToolOutputStub({
                tool: call.tool,
                ref,
                original_size: augmentedSize,
                size_unit: "chars",
                output: augmented,
              })
            : buildElidedToolOutputStub({
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
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i];
      if (m && m.role === "user" && typeof m.content === "string") {
        out[i] = { role: "user", content: `[conv:${opts.conversation_id}] ${m.content}` };
        break;
      }
    }
  }

  return dropAssistantTail(maybeCompactReplay(out));
}
