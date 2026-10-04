import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, gt } from "drizzle-orm";
import { writeEvent } from "../events.ts";
import { events, tenants } from "../schema/index.ts";
import { createTestDb, type TestDb } from "./setup.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("outbox");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("outbox writer", () => {
  test("writeEvent inserts rows in tx and catch-up query sees them", async () => {
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({ slug: "outbox-co", display_name: "Outbox Co" })
      .returning();

    const ids: number[] = [];
    await ctx.db.transaction(async (tx) => {
      const id1 = await writeEvent(tx, {
        tenant_id: tenant!.id,
        channel: "execution.status",
        type: "execution.started",
        payload: { execution_id: "exec-1" },
      });
      const id2 = await writeEvent(tx, {
        tenant_id: tenant!.id,
        channel: "execution.status",
        type: "execution.succeeded",
        payload: { execution_id: "exec-1" },
      });
      ids.push(id1, id2);
    });

    expect(ids).toHaveLength(2);
    expect(ids[1]).toBeGreaterThan(ids[0]!);

    const caughtUp = await ctx.db
      .select()
      .from(events)
      .where(and(eq(events.channel, "execution.status"), gt(events.id, 0)));
    expect(caughtUp).toHaveLength(2);
    expect(caughtUp.map((r) => r.type).sort()).toEqual([
      "execution.started",
      "execution.succeeded",
    ]);

    await ctx.db.transaction(async (tx) => {
      await writeEvent(tx, {
        tenant_id: tenant!.id,
        channel: "execution.status",
        type: "execution.aborted",
        payload: { execution_id: "exec-2" },
      });
    });

    const last = ids[1]!;
    const newRows = await ctx.db
      .select()
      .from(events)
      .where(and(eq(events.channel, "execution.status"), gt(events.id, last)));
    expect(newRows).toHaveLength(1);
    expect(newRows[0]?.type).toBe("execution.aborted");
  });

  test("transaction rollback rolls back outbox inserts", async () => {
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({ slug: "rollback-co", display_name: "Rollback Co" })
      .returning();

    try {
      await ctx.db.transaction(async (tx) => {
        await writeEvent(tx, {
          tenant_id: tenant!.id,
          channel: "workflow.chain",
          type: "workflow.chained",
          payload: { from: "a", to: "b" },
        });
        throw new Error("boom");
      });
    } catch {}

    const rows = await ctx.db.select().from(events).where(eq(events.channel, "workflow.chain"));
    expect(rows).toHaveLength(0);
  });
});
