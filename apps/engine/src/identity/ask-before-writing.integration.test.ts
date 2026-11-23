import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { decideToolMode } from "../conversations/tool-policies.ts";
import { tenants, userSetupPreferences, users } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { askBeforeWritingFor } from "./ask-before-writing.ts";

let ctx: TestDb;
let counter = 0;

beforeAll(async () => {
  ctx = await createTestDb("ask_before_writing");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function person(ask: boolean | null) {
  const slug = `ask-before-writing-${++counter}`;
  const [tenant] = await ctx.db.insert(tenants).values({ slug, display_name: slug }).returning();
  if (!tenant) throw new Error("missing tenant fixture");
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: tenant.id,
      email: `${slug}@example.test`,
      role_id: await builtinRoleId(ctx.db, "admin"),
    })
    .returning();
  if (!user) throw new Error("missing user fixture");
  if (ask !== null)
    await ctx.db
      .insert(userSetupPreferences)
      .values({ tenant_id: tenant.id, user_id: user.id, ask_before_writing: ask });
  const principal: ResolvedPrincipal = {
    provider: "test",
    kind: "user",
    id: user.id,
    tenant_id: tenant.id,
    roles: ["admin"],
  };
  return { tenant_id: tenant.id, principal };
}

function inTaskRun(principal: ResolvedPrincipal): ResolvedPrincipal {
  return {
    ...principal,
    auth_source: {
      kind: "task_run",
      task_id: "11111111-2222-4333-8444-555555555555",
      task_run_id: "55555555-6666-4777-8888-999999999999",
      grant_id: null,
    },
  };
}

describe("a person's choice to be asked before every write", () => {
  test("holds in a chat turn", async () => {
    const f = await person(true);
    expect(await askBeforeWritingFor(ctx.db, f)).toBe(true);
  });

  test("holds in a task run that acts for the person, where nobody watches", async () => {
    const f = await person(true);
    const ask = await askBeforeWritingFor(ctx.db, {
      tenant_id: f.tenant_id,
      principal: inTaskRun(f.principal),
    });
    expect(ask).toBe(true);
    expect(
      decideToolMode({
        tool: "call_connector",
        category: "tenant_write",
        input: {},
        overrides: {},
        task_run: true,
        instruction_covered: true,
        ...(ask ? { ask_before_writing: true } : {}),
      }),
    ).toEqual({ mode: "confirm_before_execution", rule: "ask_before_writing" });
  });

  test("a person who did not choose it is not asked more often in a task run", async () => {
    for (const stored of [false, null]) {
      const f = await person(stored);
      expect(
        await askBeforeWritingFor(ctx.db, {
          tenant_id: f.tenant_id,
          principal: inTaskRun(f.principal),
        }),
      ).toBe(false);
    }
  });

  test("an actor that is not a person has no such choice", async () => {
    const f = await person(true);
    expect(
      await askBeforeWritingFor(ctx.db, {
        tenant_id: f.tenant_id,
        principal: { ...f.principal, kind: "system_account" },
      }),
    ).toBe(false);
    expect(await askBeforeWritingFor(ctx.db, { tenant_id: f.tenant_id, principal: null })).toBe(
      false,
    );
  });
});
