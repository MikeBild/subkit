import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { _resetConfigForTests, loadConfig } from "../../config/loader.ts";
import { conversations, llmUsage, tenants, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { recordRepairUsage } from "./repair-tool-call.ts";

const MODEL = { modelId: "claude-haiku-4-5" } as unknown as LanguageModel;
const TENANT = "5d0c9b2a-1e3f-4a6b-8c7d-9e0f1a2b3c4d";
const CONVO = "7b6a5c4d-3e2f-4109-8a7b-6c5d4e3f2a1b";
const USER = "1a2b3c4d-5e6f-4718-8293-a4b5c6d7e8f9";
const RESULT = { usage: { inputTokens: 812, outputTokens: 47 }, providerMetadata: undefined };
let ctx: TestDb;
let directory: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "sk-cfg-repair-acct-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/unit-test", NODE_ENV: "test" },
    configPathOverride: join(directory, "subkit.config.json"),
  });
  ctx = await createTestDb("repair-accounting");
  await ctx.db
    .insert(tenants)
    .values({ id: TENANT, slug: "repair-accounting", display_name: "Repair Accounting" });
  await ctx.db.insert(users).values({
    id: USER,
    tenant_id: TENANT,
    email: "repair@example.test",
    role_id: await builtinRoleId(ctx.db, "member"),
  });
  await ctx.db.insert(conversations).values({ id: CONVO, tenant_id: TENANT, status: "active" });
});

beforeEach(async () => {
  await ctx.db.delete(llmUsage);
});
afterAll(async () => {
  await ctx?.cleanup();
  _resetConfigForTests();
  rmSync(directory, { recursive: true, force: true });
});

describe("recordRepairUsage", () => {
  it("writes a row under its own repair flow", async () => {
    await recordRepairUsage(
      { tenant_id: TENANT, conversation_id: CONVO, user_id: null, db: ctx.db },
      MODEL,
      RESULT,
      1234,
    );
    const rows = await ctx.db.select().from(llmUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.flow).toBe("tool_repair");
    expect(rows[0]?.tenant_id).toBe(TENANT);
    expect(rows[0]?.model).toBe("claude-haiku-4-5");
    expect(rows[0]?.prompt_tokens).toBe(812);
    expect(rows[0]?.completion_tokens).toBe(47);
    expect(rows[0]?.conversation_id).toBe(CONVO);
  });

  it("carries the actor through", async () => {
    await recordRepairUsage(
      { tenant_id: TENANT, user_id: USER, actor_type: "user", db: ctx.db },
      MODEL,
      RESULT,
      10,
    );
    const rows = await ctx.db.select().from(llmUsage);
    expect(rows[0]?.user_id).toBe(USER);
    expect(rows[0]?.actor_type).toBe("user");
  });

  it("writes nothing when there is no tenant to bill", async () => {
    await recordRepairUsage(undefined, MODEL, RESULT, 10);
    expect(await ctx.db.select().from(llmUsage)).toHaveLength(0);
  });

  it("a bookkeeping failure preserves a recovered tool call", async () => {
    const insert = spyOn(ctx.db, "insert").mockImplementation(() => {
      throw new Error("connection reset");
    });
    try {
      await expect(
        recordRepairUsage({ tenant_id: TENANT, db: ctx.db }, MODEL, RESULT, 10),
      ).resolves.toBeUndefined();
      expect(insert).toHaveBeenCalledTimes(1);
    } finally {
      insert.mockRestore();
    }
  });
});
