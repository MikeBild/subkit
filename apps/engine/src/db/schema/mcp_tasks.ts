// MCP async Tasks (SEP-1686) — thin correlation index.
//
// One row per backgrounded conversation turn. The MCP `tools/call`
// handler inserts a row + enqueues a `conversation.run-turn` pg-boss
// job, then returns immediately so the client never holds the call
// open for the 68-160s a real turn takes.
//
// IMPORTANT — this table is NOT a parallel lifecycle store. Task state
// (`working` / `input_required` / `completed` / `failed` / `cancelled`)
// is DERIVED at read time from the owning `conversations` row + the
// pg-boss job + any pending `conversation_elicitations` row. The only
// columns this table owns as a source of truth are:
//   - `result`         — the terminal CallToolResult envelope the
//                        worker writes on success
//   - `failure_reason` — the worker writes this on a thrown turn
//   - `cancelled_at`   — `tasks/cancel` writes this
// Everything else here (turn_seq, kind, job_id, user_message_id, …) is
// correlation metadata: `user_message_id` pins the exact user row the
// turn runs on so concurrent turns can't race on MAX(created_at).
// `id` IS the MCP `taskId` surfaced to the client.

import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { conversationMessages, conversations } from "./conversations.ts";
import { tenants, users } from "./identity.ts";

export const mcpTasks = pgTable(
  "mcp_tasks",
  {
    // = the MCP taskId handed back to the client.
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    conversation_id: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    // Monotonic per conversation — `max(turn_seq)+1` computed inside the
    // insert transaction. Lets `listTasks` order a conversation's turns
    // deterministically without leaning on `created_at` ties.
    turn_seq: integer("turn_seq").notNull(),
    // Which conversation tool spawned the turn.
    kind: text("kind").notNull().$type<"start" | "append" | "respond_elicitation">(),
    // The pg-boss job id for the enqueued `conversation.run-turn` job.
    job_id: text("job_id"),
    // Surface that originated the call (e.g. "mcp").
    request_source: text("request_source"),
    // Acting user, when known.
    actor_id: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    // The exact `conversation_messages` user row this turn runs on. The
    // MCP handler captures the id when it persists the message; the
    // worker reads THAT row by id rather than the most-recent one, so
    // two turns racing on one conversation never run on each other's
    // message. Null for `respond_elicitation` turns (no new user row).
    user_message_id: uuid("user_message_id").references(() => conversationMessages.id, {
      onDelete: "set null",
    }),
    // Terminal CallToolResult payload — set by the worker on success.
    // Shape: { conversation_id, status, events, pending_elicitation_id?,
    // committed_workflow_id? }.
    result: jsonb("result"),
    // Machine-readable failure code — set by the worker on a thrown turn.
    failure_reason: text("failure_reason"),
    // Set by `tasks/cancel` (TaskStore.updateTaskStatus('cancelled')).
    cancelled_at: timestamp("cancelled_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("mcp_tasks_conv_turn_idx").on(t.tenant_id, t.conversation_id, t.turn_seq),
    index("mcp_tasks_tenant_created_idx").on(t.tenant_id, t.created_at),
  ],
);
