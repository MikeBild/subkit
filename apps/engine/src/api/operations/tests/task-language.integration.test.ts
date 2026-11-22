import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { tasks, tenants, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { taskInput } from "../../../queue/handlers/task-run-turn-fixtures.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import { actorOfPrincipal, isRejection, type OperationScope } from "../index.ts";
import { createTaskOperation } from "../tasks.ts";

let tdb: TestDb;
let tenant_id = "";
let principal: ResolvedPrincipal;
let taskNumber = 0;

async function createdLocale(extra: Partial<OperationScope> = {}) {
  const scope: OperationScope = {
    db: tdb.db as OperationScope["db"],
    tenant_id,
    principal,
    actor: actorOfPrincipal(principal),
    ...extra,
  };
  const created = await createTaskOperation.handler(
    scope,
    taskInput({ name: `Language task ${++taskNumber}` }),
  );
  if (isRejection(created)) throw new Error("task creation was rejected");
  const [row] = await tdb.db
    .select({ locale: tasks.locale })
    .from(tasks)
    .where(eq(tasks.id, created.id));
  return row?.locale;
}

beforeAll(async () => {
  tdb = await createTestDb("task-language");
  tenant_id = (await seedTenant(tdb.db, { slug: "task-language" })).id;
  const [row] = await tdb.db
    .insert(users)
    .values({
      tenant_id,
      email: "language@example.test",
      role_id: await builtinRoleId(tdb.db, "admin"),
    })
    .returning({ id: users.id });
  if (!row) throw new Error("user fixture missing");
  principal = { provider: "test", kind: "user", id: row.id, tenant_id, roles: ["admin"] };
}, 120_000);

afterAll(async () => {
  await tdb?.cleanup();
}, 30_000);

test("a task created without a language from the request takes the workspace language", async () => {
  expect(await createdLocale()).toBe("en");
  await tdb.db.update(tenants).set({ language: "de" }).where(eq(tenants.id, tenant_id));
  expect(await createdLocale()).toBe("de");
  expect(
    await createdLocale({
      request: new Request("http://engine.test/v1/tasks", {
        headers: { "accept-language": "en-US" },
      }),
    }),
  ).toBe("en");
  expect(await createdLocale({ locale: "en" })).toBe("en");
});
