-- Surface terminal knowledge.ingest failures on the source row.
--
-- Why: a failed scheduled ingest only logged + rethrew — the
-- knowledge_sources row stayed in its prior status with no error text,
-- so the operator had no way to see that a refresh broke. The queue
-- handler now flips the row to status='error' with the failure message
-- in last_error (cleared again on the next successful ingest), and the
-- list/get surfaces render it.

ALTER TABLE "knowledge_sources" ADD COLUMN "last_error" text;
