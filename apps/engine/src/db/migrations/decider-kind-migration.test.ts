import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { builtinRoleId } from "../../rbac/roles.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import type { Db } from "../client.ts";
import { conversationElicitations, mcpTasks } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";

let ctx: TestDb;
let tenantId: string;
let userId: string;
let conversationId: string;
const seeded = { taskByUser: "" };

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

async function seedTask(turnSeq: number, actorId: string): Promise<string> {
  const id = nextUuid();
  await ctx.db.execute(sql`
    INSERT INTO mcp_tasks (id, tenant_id, conversation_id, turn_seq, kind, request_source, actor_id, actor_kind)
    VALUES (${id}, ${tenantId}, ${conversationId}, ${turnSeq}, 'start', 'mcp', ${actorId}, 'user')
  `);
  return id;
}

beforeAll(async () => {
  ctx = await createTestDb("decider_kind");
  const {
    rows: [tenant],
  } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO tenants (slug, display_name)
    VALUES (${"t-decider-kind"}, ${"Decider kind"}) RETURNING id
  `);
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
  const userResult = await ctx.pool.query(
    "INSERT INTO users (tenant_id, email, role_id) VALUES ($1, $2, $3) RETURNING id",
    [tenantId, "decider@test.local", await builtinRoleId(ctx.db, "admin")],
  );
  const user = userResult.rows[0] as { id: string } | undefined;
  if (!user) throw new Error("seed user failed");
  userId = user.id;
  const {
    rows: [conversation],
  } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO conversations (tenant_id, status, draft)
    VALUES (${tenantId}, 'active', '{}'::jsonb)
    RETURNING id
  `);
  if (!conversation) throw new Error("seed conversation failed");
  conversationId = conversation.id;
  seeded.taskByUser = await seedTask(1, userId);
});

afterAll(async () => {
  await ctx?.cleanup();
});

const nextUuid = createDeterministicUuidFactory(89);

describe("decider kind", () => {
  test("decider columns carry no user foreign key and a kind CHECK", async () => {
    const elicitationConstraints = await constraintNames(ctx.db, "conversation_elicitations");
    expect(elicitationConstraints).not.toContain(
      "conversation_elicitations_decided_by_users_id_fk",
    );
    expect(elicitationConstraints).toContain("conversation_elicitations_decided_by_kind_check");
    const taskConstraints = await constraintNames(ctx.db, "mcp_tasks");
    expect(taskConstraints).not.toContain("mcp_tasks_actor_id_users_id_fk");
    expect(taskConstraints).toContain("mcp_tasks_actor_kind_check");
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
