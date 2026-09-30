-- A preparation run refused before its first step (a connector that could not
-- serve it) stayed `queued` forever: the caller had pre-created the row and
-- nothing finalized it. The preparation lock reads a queued held row as "one is
-- already in flight", so every later preparation of that version answered
-- `preparation_in_flight`. The engine now fails the row on such a refusal; this
-- fails the rows stranded before it did. Only a held row that has sat queued
-- for over an hour and has no queue job that could still pick it up.
DO $$
BEGIN
  IF to_regclass('pgboss.job') IS NULL THEN
    UPDATE "executions"
       SET "status" = 'failed',
           "finished_at" = now(),
           "failure" = jsonb_build_object(
             'step_id', NULL,
             'error_code', 'orphaned_preparation',
             'error_message', 'The preparation was refused before it started and never ran.'
           )
     WHERE "status" = 'queued'
       AND "hold_writes"
       AND "created_at" < now() - interval '1 hour';
  ELSE
    EXECUTE $sql$
      UPDATE "executions" e
         SET "status" = 'failed',
             "finished_at" = now(),
             "failure" = jsonb_build_object(
               'step_id', NULL,
               'error_code', 'orphaned_preparation',
               'error_message', 'The preparation was refused before it started and never ran.'
             )
       WHERE e."status" = 'queued'
         AND e."hold_writes"
         AND e."created_at" < now() - interval '1 hour'
         AND NOT EXISTS (SELECT 1 FROM pgboss.job j WHERE j.id = e."id")
    $sql$;
  END IF;
END $$;
