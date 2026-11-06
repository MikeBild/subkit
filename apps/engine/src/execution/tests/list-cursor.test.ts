import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { InvalidKeysetCursorError } from "../../db/keyset-cursor.ts";
import { executions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { listExecutions } from "../list.ts";

let ctx: TestDb;
let tenant = "";
const TIE = new Date("2026-01-01T10:00:00.123Z");

function row(created_at: Date) {
  return {
    tenant_id: tenant,
    status: "succeeded" as const,
    request_source: "api",
    execution_mode: "dev" as const,
    source_kind: "saved",
    created_at,
  };
}

async function walk(limit: number, between?: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await listExecutions(
      tenant,
      cursor === undefined ? { limit } : { limit, cursor },
      ctx.db,
    );
    seen.push(...result.rows.map((r) => r.id));
    if (result.next_cursor === null) return seen;
    cursor = result.next_cursor;
    await between?.();
  }
  throw new Error("walk did not end");
}

beforeAll(async () => {
  ctx = await createTestDb("executions_list_cursor");
  const t = await seedTenant(ctx.db, { slug: "t-exec-cursor", display_name: "Cursor" });
  tenant = t.id;
  await ctx.db
    .insert(executions)
    .values([
      ...Array.from({ length: 7 }, () => row(TIE)),
      ...Array.from({ length: 8 }, (_, i) => row(new Date(TIE.getTime() - (i + 1) * 60_000))),
    ]);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("listExecutions — keyset cursor", () => {
  test("a full walk reaches every row once, through a timestamp tie", async () => {
    const ids = await walk(3);
    expect(ids).toHaveLength(15);
    expect(new Set(ids).size).toBe(15);
  });

  test("the last page carries no cursor", async () => {
    const all = await listExecutions(tenant, { limit: 15 }, ctx.db);
    expect(all.rows).toHaveLength(15);
    expect(all.next_cursor).toBeNull();
  });

  test("runs inserted between pages neither duplicate nor skip the rows behind the cursor", async () => {
    const before = (await listExecutions(tenant, { limit: 200 }, ctx.db)).rows.map((r) => r.id);
    const inserted: string[] = [];
    const ids = await walk(4, async () => {
      const [fresh] = await ctx.db
        .insert(executions)
        .values(row(new Date(TIE.getTime() + (inserted.length + 1) * 60_000)))
        .returning({ id: executions.id });
      inserted.push(fresh!.id);
    });
    expect(ids).toEqual(before);
    for (const id of inserted) expect(ids).not.toContain(id);
    await ctx.db.delete(executions).where(inArray(executions.id, inserted));
  });

  test("a value that is not a cursor is refused, not served as page one", async () => {
    await expect(listExecutions(tenant, { cursor: "abc|def" }, ctx.db)).rejects.toBeInstanceOf(
      InvalidKeysetCursorError,
    );
  });
});
