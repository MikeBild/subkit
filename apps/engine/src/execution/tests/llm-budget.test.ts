import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { _resetConfigForTests, getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import { auditLog } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let mock: MockServer;
let configDir: string;
let previousProviderHosts: string[];

beforeAll(async () => {
  ctx = await createEngineCtx("llm-budget");
  configDir = mkdtempSync(join(tmpdir(), "subkit-llm-budget-"));
  _resetConfigForTests();
  await loadConfig({
    env: { NODE_ENV: "test", DATABASE_URL: ctx.testDb.url },
    configPathOverride: join(configDir, "subkit.config.json"),
  });
  mock = await createMockServer((_, res) => {
    jsonResponse(res, 200, {
      id: "resp_test",
      model: "gpt-4.1-mini",
      output_text: "ok",
      usage: {
        prompt_tokens: 40,
        completion_tokens: 20,
        total_tokens: 60,
      },
    });
  });
  previousProviderHosts = [...getConfig().egress.provider_hosts_extra];
  await setConfigKey("egress.provider_hosts_extra", ["127.0.0.1"], { force: true });
});

afterAll(async () => {
  await setConfigKey("egress.provider_hosts_extra", previousProviderHosts, { force: true });
  await mock.close();
  await ctx.cleanup();
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
});

describe("execution · per-run LLM token budget", () => {
  test("fails with llm_budget_exceeded when cumulative usage would exceed cap", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "llm-budget-test",
      max_llm_tokens_per_run: 100,
      steps: [
        {
          kind: "request",
          id: "first_call",
          method: "POST",
          url: `${mock.baseUrl}/responses`,
          body: { model: "gpt-4.1-mini", input: "hi" },
        },
        {
          kind: "request",
          id: "second_call",
          method: "POST",
          url: `${mock.baseUrl}/responses`,
          body: { model: "gpt-4.1-mini", input: "again" },
        },
      ],
    });
    const callsBefore = mock.callCount();
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    const callsAfter = mock.callCount();

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("llm_budget_exceeded");
    expect(callsAfter - callsBefore).toBe(1);

    const auditRows = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, "external_write")));
    expect(auditRows.length).toBeGreaterThan(0);
    const llmAudit = auditRows.find((r) => {
      const meta = r.metadata as Record<string, unknown> | null;
      return meta && (meta.provider as string)?.startsWith("127.0.0.1");
    });
    expect(llmAudit).toBeTruthy();
    const llmMeta = llmAudit?.metadata as Record<string, unknown>;
    expect(llmMeta.prompt_tokens).toBe(40);
    expect(llmMeta.completion_tokens).toBe(20);
    expect(llmMeta.total_tokens).toBe(60);
    expect(llmMeta.run_total_tokens).toBe(60);
    expect(llmMeta.model).toBe("gpt-4.1-mini");

    const execAudits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, "execution.completed")));
    const execAudit = execAudits.find(
      (r) => (r.resource_id as string | null) === result.execution_id,
    );
    expect(execAudit).toBeTruthy();
    const execMeta = execAudit?.metadata as Record<string, unknown>;
    expect(execMeta.total_llm_tokens).toBe(60);
    expect(execMeta.max_llm_tokens_per_run).toBe(100);
  });

  test("uncapped run accumulates total_llm_tokens without enforcing", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "llm-budget-uncapped",
      steps: [
        {
          kind: "request",
          id: "call_a",
          method: "POST",
          url: `${mock.baseUrl}/responses`,
          body: { model: "gpt-4.1-mini", input: "a" },
        },
        {
          kind: "request",
          id: "call_b",
          method: "POST",
          url: `${mock.baseUrl}/responses`,
          body: { model: "gpt-4.1-mini", input: "b" },
        },
      ],
    });
    const callsBefore = mock.callCount();
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    expect(mock.callCount() - callsBefore).toBe(2);

    const execAudits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, "execution.completed")));
    const execAudit = execAudits.find(
      (r) => (r.resource_id as string | null) === result.execution_id,
    );
    expect(execAudit).toBeTruthy();
    const execMeta = execAudit?.metadata as Record<string, unknown>;
    expect(execMeta.total_llm_tokens).toBe(120);
    expect(execMeta.max_llm_tokens_per_run).toBeUndefined();
  });
});
