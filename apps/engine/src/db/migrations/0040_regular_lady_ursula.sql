-- Clear the references that were never executions, THEN constrain the column.
--
-- `llm_usage.execution_id` had no foreign key, so any uuid-shaped value was
-- accepted. The proactive self-healing caller had no execution to name and a
-- required `string` field to fill, so it passed a `self_healing_scans.id`
-- instead. Those ids are well-formed uuids: no error, no log line, and a join
-- that returns nothing while the column goes on claiming a relationship.
--
-- Measured on this installation before the fix: 163 such rows, 2026-06-26
-- through 2026-08-19, all on flow='repair'.
--
-- Only the attribution is cleared. The rows stay: the tokens were spent and
-- the provider billed them, so removing them would trade a wrong answer about
-- WHO spent the money for a wrong answer about HOW MUCH. That is the same
-- reasoning that keeps `user_id` unconstrained on this table — the ledger is
-- append-only — which is also why the constraint below is SET NULL and never
-- CASCADE.
--
-- The lock closes the window between the cleanup and the constraint. Each
-- migration runs in one transaction, but without this an INSERT from the
-- still-draining previous engine could land a fresh violating row after the
-- UPDATE and before ADD CONSTRAINT validates — which would fail the migration,
-- fail the boot, and roll the deployment back over a race that lasts
-- milliseconds. ADD CONSTRAINT takes this lock anyway; taking it first only
-- moves it earlier. ~163 rows to rewrite, so it is held for no meaningful time.
LOCK TABLE "llm_usage" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
UPDATE "llm_usage" u
   SET "execution_id" = NULL
 WHERE u."execution_id" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "executions" e WHERE e."id" = u."execution_id");
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;
