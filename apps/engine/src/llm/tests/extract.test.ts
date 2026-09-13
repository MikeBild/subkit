import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { runExtractFlow } from "../flows/extract.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("extract");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("llm/flows/extract", () => {
  test("returns a schema with a fields array for a csv sample", async () => {
    const sample = "id,name\n1,Ada\n2,Linus";
    const out = await runExtractFlow(
      { tenant_id: ctx.tenant_id, sample, hint: "users" },
      ctx.testDb.db,
    );
    expect(out.schema).toBeTruthy();
    const schema = out.schema as { fields?: unknown };
    expect(Array.isArray(schema.fields)).toBe(true);
    const fields = schema.fields as Array<{ name: string; type: string }>;
    expect(fields.length).toBeGreaterThan(0);
    expect(fields[0]?.name).toBeTruthy();
  });
});
