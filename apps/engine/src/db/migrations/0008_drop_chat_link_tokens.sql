-- Drop chat_link_tokens. The mint/consume helpers (`apps/engine/src/chat/link.ts`)
-- were never wired into a route, slash-command, or CLI; the dispatcher's
-- auto-link path is the live implementation. Removing the unused table +
-- its FKs keeps the schema honest about what the engine actually does.
DROP TABLE IF EXISTS "chat_link_tokens" CASCADE;
