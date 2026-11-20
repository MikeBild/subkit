import { and, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { resolveActor } from "../../audit/recorders/types.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { conversationMessages, conversations } from "../../db/schema/index.ts";
import { runSummarizeFlow } from "../../llm/flows/summarize.ts";
import { errorFields, log, logger } from "../../logging/logger.ts";
import { scrubString } from "../../logging/scrub-secrets.ts";
import {
  type ConversationCompactionMode,
  recordConversationCompaction,
} from "../../observability/instrumentation.ts";
import { undoLastSnapshot } from "../draft.ts";
import type {
  ConversationDetail,
  ConversationMessageRecord,
  ConversationRecord,
  ConversationToolCallRecord,
  DraftDocument,
} from "../types.ts";
import { getConversation } from "./get.ts";
import { rowToRecord } from "./shared.ts";
import { assertTaskRunWriter, type TaskRunWriter } from "./task-run-access.ts";

export interface CompactConversationParams {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  actor_type?: import("../../audit/types.ts").AuditActorType;
  principal?: ResolvedPrincipal | null;
  keep_last?: number;
}

export interface CompactConversationResult {
  conversation: ConversationRecord;
  summary: string;
  messages_collapsed: number;
}

export const COMPACTION_INPUT_MAX_CHARS = 48_000;
export const COMPACTION_MESSAGE_MAX_CHARS = 2_000;
const COMPACTION_SCRUB_WINDOW_CHARS = COMPACTION_MESSAGE_MAX_CHARS * 8;
const COMPACTION_OMISSION_RESERVE_CHARS = 48;

const COMPACTION_INSTRUCTIONS = [
  "Summarize the earlier part of this conversation between a user and the sk assistant so the assistant can continue without the original messages.",
  "Keep every identifier verbatim: ids, slugs, names, URLs.",
  "Cover, in this order:",
  "1. Decisions taken.",
  "2. Open approvals and pending confirmations, each with its tool_call id and approval id and what it waits for.",
  "3. The last valid tool results with their ids and slugs and the values the assistant still needs.",
  "4. The current draft state: what is being built, what it already contains, what is still missing.",
  "Plain prose, no headings, no bullet lists, no JSON. State only what the transcript contains.",
].join("\n");

const TRANSCRIPT_HEADING = "Transcript, oldest first:";

function isCompactedContent(content: unknown): content is { kind: "compacted"; summary: string } {
  if (!content || typeof content !== "object") return false;
  const rec = content as { kind?: unknown; summary?: unknown };
  return rec.kind === "compacted" && typeof rec.summary === "string";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return JSON.stringify(content ?? "");
}

function jsonExcerpt(value: unknown): string {
  if (value === undefined || value === null) return "null";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderToolEntry(m: ConversationMessageRecord): string | null {
  if (!m.content || typeof m.content !== "object") return null;
  const rec = m.content as Record<string, unknown>;
  if (rec.kind === "tool_call") {
    const state =
      typeof rec.confirmation_state === "string"
        ? rec.confirmation_state
        : typeof rec.outcome === "string"
          ? rec.outcome
          : "pending";
    return `tool_call ${m.id} ${String(rec.tool)} [${state}] input=${jsonExcerpt(rec.input)} output=${jsonExcerpt(rec.output)}`;
  }
  if (typeof rec.decision === "string") {
    const tool = typeof rec.tool === "string" ? rec.tool : "tool";
    const reason =
      typeof rec.reason === "string" && rec.reason.length > 0 ? ` (${rec.reason})` : "";
    return `decision: ${tool} ${rec.decision}${reason}`;
  }
  return null;
}

function renderEntry(m: ConversationMessageRecord): string | null {
  switch (m.role) {
    case "user":
      return `user: ${textOf(m.content)}`;
    case "assistant":
      return `assistant: ${textOf(m.content)}`;
    case "tool":
      return renderToolEntry(m);
    case "system":
      return isCompactedContent(m.content) ? `earlier summary: ${m.content.summary}` : null;
  }
}

function clampEntry(entry: string): string {
  const scrubbed = scrubString(entry.slice(0, COMPACTION_SCRUB_WINDOW_CHARS));
  if (scrubbed.length <= COMPACTION_MESSAGE_MAX_CHARS) return scrubbed;
  return `${scrubbed.slice(0, COMPACTION_MESSAGE_MAX_CHARS - 1)}…`;
}

export function buildCompactionPrompt(messages: ReadonlyArray<ConversationMessageRecord>): string {
  const header = `${COMPACTION_INSTRUCTIONS}\n\n${TRANSCRIPT_HEADING}\n`;
  const entries = messages
    .map(renderEntry)
    .filter((entry): entry is string => entry !== null)
    .map(clampEntry);
  const budget = COMPACTION_INPUT_MAX_CHARS - header.length - COMPACTION_OMISSION_RESERVE_CHARS;
  const kept: string[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as string;
    const cost = entry.length + 1;
    if (used + cost > budget) break;
    kept.push(entry);
    used += cost;
  }
  kept.reverse();
  const dropped = entries.length - kept.length;
  const body = dropped > 0 ? [`(${dropped} older entries omitted)`, ...kept] : kept;
  return `${header}${body.join("\n")}`;
}

function toolCallAsMessage(call: ConversationToolCallRecord): ConversationMessageRecord {
  return {
    id: call.id,
    conversation_id: call.conversation_id,
    role: "tool",
    content: {
      kind: "tool_call",
      tool: call.tool,
      input: call.input,
      output: call.output,
      confirmation_state: call.confirmation_state,
      outcome: call.outcome,
    },
    model: null,
    created_at: call.created_at,
  };
}

function compactionWindow(conv: ConversationDetail): ConversationMessageRecord[] {
  const messages = conv.messages;
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === "system" && isCompactedContent(m.content)) {
      start = i;
      break;
    }
  }
  const window = messages.slice(start);
  const since = window[0]?.created_at ?? null;
  const calls = conv.tool_calls
    .filter((call) => since === null || call.created_at >= since)
    .map(toolCallAsMessage);
  return [...window, ...calls].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function summarizeWindow(
  tenant_id: string,
  conversation_id: string,
  window: ReadonlyArray<ConversationMessageRecord>,
  exec: Db,
): Promise<string | null> {
  try {
    const result = await runSummarizeFlow(
      { tenant_id, prompt: buildCompactionPrompt(window) },
      exec,
    );
    if (result.summary.length === 0) throw new Error("summarize flow returned an empty summary");
    return result.summary;
  } catch (err) {
    logger.warn({
      module: "conversation",
      action: "compaction.summarize_failed",
      msg: "semantic compaction failed; the lexical stub stands in",
      tenant_id,
      conversation_id,
      ...errorFields(err),
    });
    return null;
  }
}

function stubTail(messages: ReadonlyArray<ConversationMessageRecord>): string {
  const firstUser = messages.find((m) => m.role === "user");
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const firstText =
    firstUser && typeof firstUser.content === "object" && firstUser.content !== null
      ? JSON.stringify((firstUser.content as { text?: string }).text ?? firstUser.content).slice(
          0,
          200,
        )
      : "";
  const lastText =
    lastAssistant && typeof lastAssistant.content === "object" && lastAssistant.content !== null
      ? JSON.stringify(
          (lastAssistant.content as { text?: string }).text ?? lastAssistant.content,
        ).slice(0, 200)
      : "";
  return (
    (firstText ? `Opened with: ${firstText}. ` : "") +
    (lastText ? `Most recent assistant turn: ${lastText}` : "")
  );
}

export async function compactConversation(
  p: CompactConversationParams,
  exec: Db,
): Promise<CompactConversationResult> {
  await assertTaskRunWriter(exec, p);
  const keepLast = Math.max(0, Math.min(p.keep_last ?? 4, 50));
  const conv = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!conv) throw new Error("conversation not found");

  const total = conv.messages.length;
  const collapseCount = Math.max(0, total - keepLast);

  let summary = "";
  let mode: ConversationCompactionMode | null = null;
  if (collapseCount > 0) {
    const semantic = await summarizeWindow(
      p.tenant_id,
      p.conversation_id,
      compactionWindow(conv),
      exec,
    );
    mode = semantic === null ? "stub" : "semantic";
    summary = `Compacted ${collapseCount} earlier message(s). ${semantic ?? stubTail(conv.messages)}`;
    recordConversationCompaction({ mode });

    await exec.insert(conversationMessages).values({
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      role: "system",
      content: { kind: "compacted", summary, text: summary, collapsed: collapseCount, mode },
    });
  }

  const [updated] = await exec
    .update(conversations)
    .set({ updated_at: new Date() })
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .returning();
  if (!updated) throw new Error("conversation disappeared");

  await auditAwait(
    {
      tenant_id: p.tenant_id,
      ...resolveActor({
        tenant_id: p.tenant_id,
        actor_id: p.principal?.id ?? p.actor_id,
        actor_type:
          p.principal?.kind ?? p.actor_type ?? (p.actor_id === null ? "system" : "unknown"),
      }),
      action: AuditAction.CONVERSATION_COMPACTED,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "success",
      metadata: { collapsed: collapseCount, kept: Math.min(keepLast, total), mode },
    },
    exec,
  );

  log.conversation.compacted({
    conversation_id: p.conversation_id,
    collapsed: collapseCount,
    kept: Math.min(keepLast, total),
    total,
    mode,
  });

  return {
    conversation: rowToRecord(updated),
    summary,
    messages_collapsed: collapseCount,
  };
}

export async function undoLastDraftMutation(
  tenant_id: string,
  conversation_id: string,
  exec: Db,
  writer: Pick<TaskRunWriter, "actor_id" | "principal"> = { actor_id: null },
): Promise<DraftDocument> {
  await assertTaskRunWriter(exec, { tenant_id, conversation_id, ...writer });
  return undoLastSnapshot(tenant_id, conversation_id, exec);
}
