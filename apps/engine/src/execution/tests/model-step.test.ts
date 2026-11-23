import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig } from "../../config/loader.ts";
import { llmUsage } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
let configDir: string;

const verdict = {
  type: "object",
  required: ["category"],
  properties: { category: { type: "string" } },
};

beforeAll(async () => {
  ctx = await createEngineCtx("model-step");
  configDir = mkdtempSync(join(tmpdir(), "subkit-model-step-"));
  _resetConfigForTests();
  await loadConfig({
    env: { NODE_ENV: "test", DATABASE_URL: ctx.testDb.url, LLM_PROVIDER: "mock" },
    configPathOverride: join(configDir, "subkit.config.json"),
  });
});

afterEach(() => {
  getMockProvider().reset();
});

afterAll(async () => {
  await ctx.cleanup();
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
});

async function run(steps: unknown[], input: unknown = null) {
  const { workflow_id } = await createWorkflowRow(ctx, { name: "model step", steps });
  return runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input,
  });
}

describe("model step", () => {
  test("sends the author's system prompt and filled-in prompt, and returns the checked answer", async () => {
    getMockProvider().generateOverrides.workflow_step = () => ({ category: "billing" });
    const result = await run(
      [
        {
          id: "prepare",
          kind: "transform",
          language: "javascript",
          expression: "return { topic: 'invoice' };",
        },
        {
          id: "classify",
          kind: "model",
          system: "You sort support messages.",
          prompt: "Classify this ${scope.prepare.data.topic} message.",
          input: { text: "${input.text}", prepared: "${scope.prepare.data}" },
          output_schema: verdict,
        },
        {
          id: "result",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.classify.data;",
        },
      ],
      { text: "I was charged twice" },
    );

    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ category: "billing" });
    const [call] = getMockProvider().calls;
    expect(call?.flow).toBe("workflow_step");
    expect(call?.system).toBe("You sort support messages.");
    expect(call?.last_user).toContain("Classify this invoice message.");
    expect(call?.last_user).toContain('"text": "I was charged twice"');
    expect(call?.last_user).toContain('"prepared": {\n    "topic": "invoice"\n  }');
    expect(call?.included_skill_ids).toEqual([]);
    expect(call?.included_knowledge_chunk_ids).toEqual([]);
    expect(call?.included_chunk_ids).toEqual([]);

    const usage = await ctx.testDb.db
      .select({ flow: llmUsage.flow })
      .from(llmUsage)
      .where(
        and(eq(llmUsage.tenant_id, ctx.tenantId), eq(llmUsage.execution_id, result.execution_id)),
      );
    expect(usage).toEqual([{ flow: "workflow_step" }]);
  });

  test("an answer that misses the output_schema fails the step", async () => {
    getMockProvider().generateOverrides.workflow_step = () => ({ label: "billing" });
    const result = await run([
      { id: "classify", kind: "model", prompt: "Classify", output_schema: verdict },
    ]);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("model_output_invalid");
  });

  test("a secret placeholder is refused before any call", async () => {
    const result = await run([
      {
        id: "leak",
        kind: "model",
        prompt: "Here is ${cred.github.token}",
        output_schema: verdict,
      },
    ]);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("model_step_secret_placeholder");
    expect(getMockProvider().calls).toHaveLength(0);
  });
});
