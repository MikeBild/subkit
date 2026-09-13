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

import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
    // ── Worker-stamped progress heartbeat (Option-B) ──────────────────
    // The `conversation.run-turn` worker stamps these as each authoring
    // tool executes, so `conversation_get` reports accurate, monotonic
    // progress DERIVED FROM THE WORKER rather than re-guessed from the
    // newest `conversation_tool_calls` row at read time. Nullable: a row
    // that has not yet run its first tool (or a legacy in-flight row
    // created before this column existed) carries null and the read side
    // falls back to the tool-call derivation.
    //   - `phase`         — coarse authoring phase (building / editing /
    //                       validating / committing / running / …).
    //   - `last_action`   — the tool name that drove the latest stamp.
    //   - `progress_step` — the workflow step the last action targeted,
    //                       when its input carried one.
    //   - `heartbeat_at`  — when the last stamp landed; a moving value is
    //                       the honest "still working" signal.
    phase: text("phase"),
    last_action: text("last_action"),
    progress_step: text("progress_step"),
    heartbeat_at: timestamp("heartbeat_at", { withTimezone: true }),
    // ── Parked, not working ───────────────────────────────────────────
    // A turn that hit a provider usage limit is re-enqueued with a future
    // `startAfter` instead of failing. That is the right call — but the task
    // row stayed non-terminal with no other trace, so every client saw
    // `working / phase: "starting"` and nothing else. In production that
    // silence lasted 21 hours and led a competent reader to the wrong
    // conclusion (a "hung worker"), because the honest reason — the provider
    // reported its monthly quota exhausted and named a reset date — existed
    // only in the engine log.
    //
    // These two columns make the wait legible: WHEN it can resume, and WHY it
    // is not running now. A waiting client must never have to guess.
    parked_until: timestamp("parked_until", { withTimezone: true }),
    parked_reason: text("parked_reason"),
    ...timestamps,
  },
  (t) => [
    index("mcp_tasks_conv_turn_idx").on(t.tenant_id, t.conversation_id, t.turn_seq),
    index("mcp_tasks_tenant_created_idx").on(t.tenant_id, t.created_at),
    check("mcp_tasks_kind_check", sql`${t.kind} IN ('start','append','respond_elicitation')`),
  ],
);
