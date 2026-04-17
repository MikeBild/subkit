// Conversation DB persistence + SDK message-history assembly.
//
// All writes from the loop go through here. `buildModelMessages` walks
// `conversation_messages` and `conversation_tool_calls` in created_at
// order and emits an AI SDK `ModelMessage[]` with stable tool-call ids
// copied from `conversation_tool_calls.id`. Real providers (Anthropic)
// need this shape; the mock model only reads the final user content to
// parse the `[conv:<id>]` envelope that keys its plan cursor.

import type { ModelMessage } from "ai";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { conversationMessages, conversationToolCalls } from "../db/schema/index.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function appendMessage(
  db: Executor,
  tenant_id: string,
  conversation_id: string,
  role: "user" | "assistant" | "tool" | "system",
  content: unknown,
): Promise<void> {
  await db
    .insert(conversationMessages)
    .values({ tenant_id, conversation_id, role, content: content as Record<string, unknown> });
}

export async function insertToolCall(
  db: Executor,
  params: {
    tenant_id: string;
    conversation_id: string;
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
      tool: params.tool,
      input: params.input as Record<string, unknown>,
      approval_required: params.approval_required,
    })
    .returning({ id: conversationToolCalls.id });
  if (!row) throw new Error("conversation_tool_calls insert returned no row");
  return row.id;
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

/**
 * Merge `conversation_messages` + `conversation_tool_calls` into a
 * single AI SDK `ModelMessage[]`, ordered by created_at.
 *
 * Mapping rules:
 *   - user row → `{ role: "user", content: text }`
 *   - assistant text row → `{ role: "assistant", content: text }`
 *   - tool_calls row (unexecuted, output null) → assistant(tool-call only)
 *   - tool_calls row (executed, output set) → assistant(tool-call) + tool(tool-result)
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
  const [msgs, calls] = await Promise.all([
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
  ]);
  void tenant_id;

  interface Item {
    kind: "msg" | "call";
    created_at: Date;
    msg?: (typeof msgs)[number];
    call?: (typeof calls)[number];
  }
  const items: Item[] = [
    ...msgs.map((m): Item => ({ kind: "msg", created_at: m.created_at, msg: m })),
    ...calls.map((c): Item => ({ kind: "call", created_at: c.created_at, call: c })),
  ];
  items.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

  const out: ModelMessage[] = [];
  for (const item of items) {
    if (item.kind === "msg" && item.msg) {
      const role = item.msg.role;
      const content = item.msg.content;
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
      if (call.output !== null && call.output !== undefined) {
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.id,
              toolName: call.tool,
              output: { type: "json", value: call.output as Parameters<typeof JSON.stringify>[0] },
            },
          ],
        });
      }
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

  return out;
}
