-- Anchor every tool call and elicitation to its parent assistant message
-- so the read path can produce a single chronologically-ordered timeline
-- (MessagePart[]) without resorting to fragile created_at time-windows.
--
-- Both columns are nullable: legacy rows stay valid, the parts.ts read
-- path falls back to time-window grouping when parent_message_id is null.
-- The conversation loop populates the column for all new writes.

ALTER TABLE "conversation_tool_calls"
  ADD COLUMN "parent_message_id" uuid REFERENCES "conversation_messages"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX "conversation_tool_calls_parent_msg_idx"
  ON "conversation_tool_calls" ("parent_message_id");
--> statement-breakpoint

ALTER TABLE "conversation_elicitations"
  ADD COLUMN "parent_message_id" uuid REFERENCES "conversation_messages"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX "conversation_elicitations_parent_msg_idx"
  ON "conversation_elicitations" ("parent_message_id");
