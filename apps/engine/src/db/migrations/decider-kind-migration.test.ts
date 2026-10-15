import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { builtinRoleId } from "../../rbac/roles.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import type { Db } from "../client.ts";
import { runMigrations } from "../migrate.ts";
import { conversationElicitations, conversations, mcpTasks, tenants } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

const migration = EMBEDDED_MIGRATIONS.find((m) => m.tag === "0089_decider_kind");

let ctx: TestDb;
let tenantId: string;
let userId: string;
let conversationId: string;
const seeded = {
  decidedByUser: "",
  undecided: "",
  taskByUser: "",
  taskWithoutActor: "",
};

async function failureOf(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    const causeMessage = cause instanceof Error ? cause.message : String(cause ?? "");
    return `${(err as Error).message} ${causeMessage}`;
  }
  return "";
}

async function constraintNames(db: Db, table: string): Promise<string[]> {
  const res = await db.execute<{ conname: string }>(sql`
    SELECT c.conname FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = ${table} AND c.contype IN ('c', 'f')
  `);
  return res.rows.map((r) => r.conname).sort();
}

async function seedElicitation(decidedBy: string | null): Promise<string> {
  const id = nextUuid();
  await ctx.db.execute(sql`
    INSERT INTO conversation_elicitations
      (id, tenant_id, conversation_id, tool_name, summary, input, status, decided_by, decided_at)
    VALUES
      (${id}, ${tenantId}, ${conversationId}, 'ask_user_confirm', 'seeded', '{}'::jsonb,
       ${decidedBy ? "resolved" : "pending"}::elicitation_status, ${decidedBy},
       ${decidedBy ? sql`now()` : sql`NULL`})
  `);
  return id;
}

async function seedTask(turnSeq: number, actorId: string | null): Promise<string> {
  const id = nextUuid();
  await ctx.db.execute(sql`
    INSERT INTO mcp_tasks (id, tenant_id, conversation_id, turn_seq, kind, request_source, actor_id)
    VALUES (${id}, ${tenantId}, ${conversationId}, ${turnSeq}, 'start', 'mcp', ${actorId})
  `);
  return id;
}

beforeAll(async () => {
  if (!migration) throw new Error("migration 0089_decider_kind is not embedded");
  ctx = await createTestDb("decider_kind", { upToIdx: migration.idx - 1 });
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-decider-kind", display_name: "Decider kind" })
    .returning({ id: tenants.id });
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
  const userResult = await ctx.pool.query(
    "INSERT INTO users (tenant_id, email, role_id) VALUES ($1, $2, $3) RETURNING id",
    [tenantId, "decider@test.local", await builtinRoleId(ctx.db, "admin")],
  );
  const user = userResult.rows[0] as { id: string } | undefined;
  if (!user) throw new Error("seed user failed");
  userId = user.id;
  const [conversation] = await ctx.db
    .insert(conversations)
    .values({ tenant_id: tenantId, status: "active", draft: {} })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("seed conversation failed");
  conversationId = conversation.id;
  seeded.decidedByUser = await seedElicitation(userId);
  seeded.undecided = await seedElicitation(null);
  seeded.taskByUser = await seedTask(1, userId);
  seeded.taskWithoutActor = await seedTask(2, null);
});

afterAll(async () => {
  await ctx?.cleanup();
});

const nextUuid = createDeterministicUuidFactory(89);

describe("0089_decider_kind", () => {
  test("before the migration both columns are foreign keys onto users and carry no kind", async () => {
    expect(await constraintNames(ctx.db, "conversation_elicitations")).toContain(
      "conversation_elicitations_decided_by_users_id_fk",
    );
    expect(await constraintNames(ctx.db, "mcp_tasks")).toContain("mcp_tasks_actor_id_users_id_fk");
    expect(
      await failureOf(
        ctx.db.execute(sql`
          INSERT INTO conversation_elicitations
            (tenant_id, conversation_id, tool_name, summary, input, decided_by)
          VALUES (${tenantId}, ${conversationId}, 'ask_user_confirm', 'bot', '{}'::jsonb, ${nextUuid()})
        `),
      ),
    ).toMatch(/conversation_elicitations_decided_by_users_id_fk/);
  });

  test("the migration drops the user FKs, backfills kind='user' and installs the CHECKs", async () => {
    await runMigrations(ctx.db);

    const elicitationConstraints = await constraintNames(ctx.db, "conversation_elicitations");
    expect(elicitationConstraints).not.toContain(
      "conversation_elicitations_decided_by_users_id_fk",
    );
    expect(elicitationConstraints).toContain("conversation_elicitations_decided_by_kind_check");
    const taskConstraints = await constraintNames(ctx.db, "mcp_tasks");
    expect(taskConstraints).not.toContain("mcp_tasks_actor_id_users_id_fk");
    expect(taskConstraints).toContain("mcp_tasks_actor_kind_check");

    const elicitations = await ctx.db
      .select({
        id: conversationElicitations.id,
        decided_by: conversationElicitations.decided_by,
        decided_by_kind: conversationElicitations.decided_by_kind,
      })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.tenant_id, tenantId));
    const byId = new Map(elicitations.map((r) => [r.id, r]));
    expect(byId.get(seeded.decidedByUser)).toEqual({
      id: seeded.decidedByUser,
      decided_by: userId,
      decided_by_kind: "user",
    });
    expect(byId.get(seeded.undecided)).toEqual({
      id: seeded.undecided,
      decided_by: null,
      decided_by_kind: null,
    });

    const tasks = await ctx.db
      .select({ id: mcpTasks.id, actor_id: mcpTasks.actor_id, actor_kind: mcpTasks.actor_kind })
      .from(mcpTasks)
      .where(eq(mcpTasks.tenant_id, tenantId));
    const taskById = new Map(tasks.map((r) => [r.id, r]));
    expect(taskById.get(seeded.taskByUser)).toEqual({
      id: seeded.taskByUser,
      actor_id: userId,
      actor_kind: "user",
    });
    expect(taskById.get(seeded.taskWithoutActor)).toEqual({
      id: seeded.taskWithoutActor,
      actor_id: null,
      actor_kind: null,
    });
  });

  test("a system account that is no user may now decide, and the CHECK keeps id and kind paired", async () => {
    const systemAccountId = nextUuid();
    const [decided] = await ctx.db
      .insert(conversationElicitations)
      .values({
        tenant_id: tenantId,
        conversation_id: conversationId,
        tool_name: "ask_user_confirm",
        summary: "decided by a bot",
        input: {},
        status: "resolved",
        decided_by: systemAccountId,
        decided_by_kind: "system_account",
        decided_at: new Date(FROZEN_NOW),
      })
      .returning({ decided_by_kind: conversationElicitations.decided_by_kind });
    expect(decided?.decided_by_kind).toBe("system_account");
    const [task] = await ctx.db
      .insert(mcpTasks)
      .values({
        tenant_id: tenantId,
        conversation_id: conversationId,
        turn_seq: 3,
        kind: "start",
        request_source: "mcp",
        actor_id: systemAccountId,
        actor_kind: "system_account",
      })
      .returning({ actor_kind: mcpTasks.actor_kind });
    expect(task?.actor_kind).toBe("system_account");

    const [unattributed] = await ctx.db
      .insert(conversationElicitations)
      .values({
        tenant_id: tenantId,
        conversation_id: conversationId,
        tool_name: "ask_user_confirm",
        summary: "historical decision without attribution",
        input: {},
        decided_by: null,
        decided_by_kind: "unknown",
      })
      .returning({
        decided_by: conversationElicitations.decided_by,
        decided_by_kind: conversationElicitations.decided_by_kind,
      });
    expect(unattributed).toEqual({ decided_by: null, decided_by_kind: "unknown" });

    expect(
      await failureOf(
        ctx.db.insert(conversationElicitations).values({
          tenant_id: tenantId,
          conversation_id: conversationId,
          tool_name: "ask_user_confirm",
          summary: "unknown actor cannot retain an identifier",
          input: {},
          decided_by: systemAccountId,
          decided_by_kind: "unknown",
        }),
      ),
    ).toMatch(/conversation_elicitations_decided_by_kind_check/);

    const rejected = [
      { decided_by: systemAccountId, decided_by_kind: null },
      { decided_by: null, decided_by_kind: "user" as const },
      { decided_by: systemAccountId, decided_by_kind: "system" as const },
    ];
    for (const pair of rejected) {
      expect(
        await failureOf(
          ctx.db.insert(conversationElicitations).values({
            tenant_id: tenantId,
            conversation_id: conversationId,
            tool_name: "ask_user_confirm",
            summary: "rejected pair",
            input: {},
            ...pair,
          }),
        ),
      ).toMatch(/conversation_elicitations_decided_by_kind_check/);
      expect(
        await failureOf(
          ctx.db.insert(mcpTasks).values({
            tenant_id: tenantId,
            conversation_id: conversationId,
            turn_seq: 4,
            kind: "start",
            request_source: "mcp",
            actor_id: pair.decided_by,
            actor_kind: pair.decided_by_kind,
          }),
        ),
      ).toMatch(/mcp_tasks_actor_kind_check/);
    }

    const [stillThere] = await ctx.db
      .select({ id: mcpTasks.id })
      .from(mcpTasks)
      .where(and(eq(mcpTasks.tenant_id, tenantId), eq(mcpTasks.id, seeded.taskByUser)));
    expect(stillThere?.id).toBe(seeded.taskByUser);
  });
});
