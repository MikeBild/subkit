-- A fast-path turn wrote its answer first and its tool row second. The outcome
-- projection reads a trailing tool row as a turn still running, so every
-- conversation a fast-path answer ended read "in progress" for as long as
-- anyone looked. The fast path now writes the tool row first; this moves each
-- existing tool row to just before the answer it belongs to. Only the order
-- changes: no row's content is touched, and a row is moved only where it still
-- lands after the message that preceded the answer.
WITH ordered AS (
  SELECT "id",
         "role",
         "content",
         "created_at",
         lag("id") OVER w AS "prev_id",
         lag("role") OVER w AS "prev_role",
         lag("content") OVER w AS "prev_content",
         lag("created_at") OVER w AS "prev_at",
         lag("created_at", 2) OVER w AS "before_prev_at"
  FROM "conversation_messages"
  WINDOW w AS (PARTITION BY "conversation_id" ORDER BY "created_at", "id")
)
UPDATE "conversation_messages" m
SET "created_at" = o."prev_at" - interval '1 microsecond'
FROM ordered o
WHERE m."id" = o."id"
  AND o."role" = 'tool'
  AND o."prev_role" = 'assistant'
  AND o."prev_content" ->> 'fast_path' = 'true'
  AND (o."before_prev_at" IS NULL OR o."before_prev_at" < o."prev_at" - interval '1 microsecond');
