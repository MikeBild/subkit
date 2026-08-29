-- The queue library stores schema-qualified references in generated function
-- bodies. Keep its canonical schema name while retaining ownership by SubKit's
-- dedicated database role.
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'pgboss')
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'subkit_queue') THEN
    RAISE EXCEPTION 'both queue schemas exist; refusing to discard or merge queue state';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'subkit_queue') THEN
    ALTER SCHEMA subkit_queue RENAME TO pgboss;
  END IF;
END
$migration$;
