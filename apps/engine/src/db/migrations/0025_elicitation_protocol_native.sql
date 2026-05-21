-- MCP-native elicitation marker.
-- Adds `protocol_native` to conversation_elicitations: true when the
-- elicitation was satisfied via an MCP `elicitation/create` round-trip
-- (the in-process bridge) rather than the DB-pause + respondElicitation
-- path. Defaults false so all existing rows read as DB-pause.
ALTER TABLE "conversation_elicitations" ADD COLUMN "protocol_native" boolean NOT NULL DEFAULT false;
