import { afterAll, beforeAll, beforeEach, describe, expect, it, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig } from "../../config/loader.ts";
import { executions, llmUsage, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import type { SubkitLlmTelemetryMetadata, SubkitLlmUsage } from "../core/base-types.ts";
import { type AccountParams, account, usageAttribution } from "./accountant.ts";

let ctx: TestDb;
let directory: string;
const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
const USAGE: SubkitLlmUsage = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
};

function baseParams(meta: SubkitLlmTelemetryMetadata): AccountParams {
  return {
    tenant_id: meta.tenant_id,
    metadata: meta,
    model: "claude-haiku-4-5",
    usage: USAGE,
    latency_ms: 100,
    result: "success",
  };
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "sk-cfg-account-test-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/unit-test", NODE_ENV: "test" },
    configPathOverride: join(directory, "subkit.config.json"),
  });
  ctx = await createTestDb("accounting-attribution");
  await ctx.db.insert(tenants).values([
    { id: TENANT, slug: "accounting", display_name: "Accounting" },
    { id: OTHER_TENANT, slug: "other-accounting", display_name: "Other Accounting" },
  ]);
  await ctx.db.insert(executions).values([
    {
      id: "0f4c7f4a-1c2b-4d3e-9a8b-7c6d5e4f3a2b",
      tenant_id: TENANT,
      status: "succeeded",
      request_source: "api",
      execution_mode: "dev",
    },
    {
      id: "9c2f1a5e-7b3d-4c8a-9e1f-2d3c4b5a6978",
      tenant_id: TENANT,
      status: "succeeded",
      request_source: "api",
      execution_mode: "dev",
    },
    {
      id: "00000000-0000-4000-8000-000000000003",
      tenant_id: OTHER_TENANT,
      status: "succeeded",
      request_source: "api",
      execution_mode: "dev",
    },
  ]);
});
beforeEach(async () => {
  await ctx.db.delete(llmUsage);
});
afterAll(async () => {
  await ctx?.cleanup();
  _resetConfigForTests();
  rmSync(directory, { recursive: true, force: true });
});

describe("account() execution and conversation attribution", () => {
  it("threads execution_id and conversation_id when both present in metadata", async () => {
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: TENANT,
      flow: "generate",
      execution_id: "0f4c7f4a-1c2b-4d3e-9a8b-7c6d5e4f3a2b",
      conversation_id: "3b1e9c7d-2a4f-4e6b-8c9d-1f2a3b4c5d6e",
    };
    await account(baseParams(meta), ctx.db);
    const rows = await ctx.db.select().from(llmUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.execution_id).toBe("0f4c7f4a-1c2b-4d3e-9a8b-7c6d5e4f3a2b");
    expect(rows[0]?.conversation_id).toBe("3b1e9c7d-2a4f-4e6b-8c9d-1f2a3b4c5d6e");
  });

  it("carries null execution_id when metadata has no execution_id", async () => {
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: TENANT,
      flow: "converse",
      conversation_id: "3b1e9c7d-2a4f-4e6b-8c9d-1f2a3b4c5d6e",
    };
    await account(baseParams(meta), ctx.db);
    const rows = await ctx.db.select().from(llmUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.execution_id === null || rows[0]?.execution_id === undefined).toBe(true);
    expect(rows[0]?.conversation_id).toBe("3b1e9c7d-2a4f-4e6b-8c9d-1f2a3b4c5d6e");
  });

  it("carries null conversation_id when metadata has no conversation_id", async () => {
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: TENANT,
      flow: "extract",
      execution_id: "0f4c7f4a-1c2b-4d3e-9a8b-7c6d5e4f3a2b",
    };
    await account(baseParams(meta), ctx.db);
    const rows = await ctx.db.select().from(llmUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.execution_id).toBe("0f4c7f4a-1c2b-4d3e-9a8b-7c6d5e4f3a2b");
    expect(rows[0]?.conversation_id === null || rows[0]?.conversation_id === undefined).toBe(true);
  });

  it("carries null for both when metadata has neither", async () => {
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: TENANT,
      flow: "repair",
    };
    await account(baseParams(meta), ctx.db);
    const rows = await ctx.db.select().from(llmUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.execution_id === null || rows[0]?.execution_id === undefined).toBe(true);
    expect(rows[0]?.conversation_id === null || rows[0]?.conversation_id === undefined).toBe(true);
  });

  it("still records the correct flow and tenant_id alongside attribution fields", async () => {
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: OTHER_TENANT,
      flow: "judge",
      execution_id: "00000000-0000-4000-8000-000000000003",
    };
    await account(baseParams(meta), ctx.db);
    const rows = await ctx.db.select().from(llmUsage);
    expect(rows[0]?.flow).toBe("judge");
    expect(rows[0]?.tenant_id).toBe(OTHER_TENANT);
  });

  it("drops a non-uuid execution_id and still writes the row", async () => {
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: TENANT,
      flow: "repair",
      execution_id: "proactive",
    };
    await account(baseParams(meta), ctx.db);
    const rows = await ctx.db.select().from(llmUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.execution_id === null || rows[0]?.execution_id === undefined).toBe(true);
    expect(rows[0]?.flow).toBe("repair");
  });

  it("drops a non-uuid conversation_id and still writes the row", async () => {
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: TENANT,
      flow: "converse",
      conversation_id: "not-a-uuid",
    };
    await account(baseParams(meta), ctx.db);
    const rows = await ctx.db.select().from(llmUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.conversation_id === null || rows[0]?.conversation_id === undefined).toBe(true);
    expect(rows[0]?.flow).toBe("converse");
  });

  it("persists an existing execution UUID", async () => {
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: TENANT,
      flow: "repair",
      execution_id: "9c2f1a5e-7b3d-4c8a-9e1f-2d3c4b5a6978",
    };
    await account(baseParams(meta), ctx.db);
    const rows = await ctx.db.select().from(llmUsage);
    expect(rows[0]?.execution_id).toBe("9c2f1a5e-7b3d-4c8a-9e1f-2d3c4b5a6978");
  });

  it("returns the correct drift_pct and recorded token counts", async () => {
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: TENANT,
      flow: "generate",
    };
    const result = await account({ ...baseParams(meta), estimated_prompt_tokens: 80 }, ctx.db);
    expect(result.drift_pct).toBeCloseTo(0.25, 5);
    expect(result.recorded_input_tokens).toBe(100);
    expect(result.recorded_output_tokens).toBe(50);
  });
});

describe("usageAttribution", () => {
  test("links a usage row to its run and conversation, and drops ids it could not store", () => {
    const execution_id = "5b2a7c1e-3f4d-4e8a-9b1c-2d3e4f5a6b7c";
    expect(usageAttribution({ execution_id, conversation_id: "not-a-uuid", flow: "x" })).toEqual({
      execution_id,
    });
    expect(usageAttribution(undefined)).toEqual({});
  });
});
