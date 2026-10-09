import { sql } from "drizzle-orm";
import { z } from "zod";
import { logger } from "../logging/logger.ts";
import type { Executor } from "./client.ts";

const ConstraintSchema = z.object({
  name: z.string(),
  kind: z.string(),
  target_schema: z.string().nullable(),
  target_table: z.string().nullable(),
  source_columns: z.array(z.string()),
  target_columns: z.array(z.string()),
  delete_action: z.string(),
  update_action: z.string(),
  match_type: z.string(),
  deferrable: z.boolean(),
  deferred: z.boolean(),
  validated: z.boolean(),
});

export async function normalizeMcpTaskActorConstraint(db: Executor): Promise<void> {
  await db.execute(sql`LOCK TABLE "subkit"."mcp_tasks" IN ACCESS EXCLUSIVE MODE`);
  const result = await db.execute(sql`
    SELECT c.conname AS name, c.contype AS kind,
           target_namespace.nspname AS target_schema, target.relname AS target_table,
           ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, position)
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
                 ORDER BY k.position) AS source_columns,
           ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, position)
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num
                 ORDER BY k.position) AS target_columns,
           c.confdeltype AS delete_action, c.confupdtype AS update_action,
           c.confmatchtype AS match_type, c.condeferrable AS deferrable,
           c.condeferred AS deferred, c.convalidated AS validated
      FROM pg_catalog.pg_constraint c
      LEFT JOIN pg_catalog.pg_class target ON target.oid = c.confrelid
      LEFT JOIN pg_catalog.pg_namespace target_namespace ON target_namespace.oid = target.relnamespace
     WHERE c.conrelid = 'subkit.mcp_tasks'::regclass
       AND (c.conname IN ('mcp_tasks_actor_id_fkey', 'mcp_tasks_actor_id_users_id_fk')
            OR (c.contype = 'f' AND EXISTS (
              SELECT 1 FROM pg_catalog.pg_attribute a
               WHERE a.attrelid = c.conrelid AND a.attname = 'actor_id'
                 AND a.attnum = ANY(c.conkey))))
  `);
  const constraints = z.array(ConstraintSchema).parse(result.rows);
  const constraint = constraints[0];
  if (
    constraints.length !== 1 ||
    !constraint ||
    !["mcp_tasks_actor_id_fkey", "mcp_tasks_actor_id_users_id_fk"].includes(constraint.name) ||
    constraint.kind !== "f" ||
    constraint.target_schema !== "subkit" ||
    constraint.target_table !== "users" ||
    constraint.source_columns.length !== 1 ||
    constraint.source_columns[0] !== "actor_id" ||
    constraint.target_columns.length !== 1 ||
    constraint.target_columns[0] !== "id" ||
    constraint.delete_action !== "n" ||
    constraint.update_action !== "a" ||
    constraint.match_type !== "s" ||
    constraint.deferrable ||
    constraint.deferred ||
    !constraint.validated
  ) {
    throw new Error("migration-mcp-task-actor-constraint-invalid");
  }
  if (constraint.name === "mcp_tasks_actor_id_users_id_fk") return;
  await db.execute(sql`
    ALTER TABLE "subkit"."mcp_tasks"
    RENAME CONSTRAINT "mcp_tasks_actor_id_fkey" TO "mcp_tasks_actor_id_users_id_fk"
  `);
  logger.info({
    module: "db",
    action: "migrate.constraint_normalized",
    msg: "normalized the validated MCP task user foreign key name",
  });
}
