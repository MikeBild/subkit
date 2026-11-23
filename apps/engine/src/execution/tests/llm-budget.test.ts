import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { auditLog, llmUsage, tenants } from "../../db/schema/index.ts";
import { currentMonthBucket } from "../../llm/accounting/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { now } from "../../utils/clock.ts";
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
let upstream: MockServer;
let provider: MockServer;
let configDir: string;

const answer = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };

function modelStep(id: string, prompt: string) {
  return { kind: "model", id, prompt, output_schema: answer, max_output_tokens: 40 } as const;
}

function workflowStepCalls(): number {
  return getMockProvider().calls.filter((call) => call.flow === "workflow_step").length;
}

async function completedAudit(execution_id: string): Promise<Record<string, unknown>> {
  const rows = await ctx.testDb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, "execution.completed")));
  const row = rows.find((r) => (r.resource_id as string | null) === execution_id);
  return (row?.metadata ?? {}) as Record<string, unknown>;
}

function providerCall(id: string, input: string) {
  return {
    kind: "request",
    id,
    method: "POST",
    url: `${provider.baseUrl}/responses`,
    body: { model: "gpt-4.1-mini", input },
  } as const;
}

async function withProviderHost<T>(run: () => Promise<T>): Promise<T> {
  await setConfigKey("egress.provider_hosts_extra", ["127.0.0.1"], { force: true });
  try {
    return await run();
  } finally {
    await setConfigKey("egress.provider_hosts_extra", [], { force: true });
  }
}

async function reachSpendLimit(): Promise<void> {
  const at = new Date(now());
  await ctx.testDb.db.insert(llmUsage).values({
    tenant_id: ctx.tenantId,
    flow: "converse",
    model: "claude-sonnet-4-5",
    completion_tokens: 1_000_000,
    total_tokens: 1_000_000,
    result: "success",
    month_bucket: currentMonthBucket(at),
    created_at: at,
  });
  await ctx.testDb.db
    .update(tenants)
    .set({ spend_limit_usd: 1 })
    .where(eq(tenants.id, ctx.tenantId));
}

async function usageTotal(execution_id: string): Promise<number> {
  const rows = await ctx.testDb.db
    .select({ prompt: llmUsage.prompt_tokens, completion: llmUsage.completion_tokens })
    .from(llmUsage)
    .where(and(eq(llmUsage.tenant_id, ctx.tenantId), eq(llmUsage.execution_id, execution_id)));
  return rows.reduce((sum, row) => sum + Number(row.prompt) + Number(row.completion), 0);
}

beforeAll(async () => {
  ctx = await createEngineCtx("llm-budget");
  configDir = mkdtempSync(join(tmpdir(), "subkit-llm-budget-"));
  _resetConfigForTests();
  await loadConfig({
    env: { NODE_ENV: "test", DATABASE_URL: ctx.testDb.url, LLM_PROVIDER: "mock" },
    configPathOverride: join(configDir, "subkit.config.json"),
  });
  upstream = await createMockServer((_, res) => jsonResponse(res, 200, { ok: true }));
  provider = await createMockServer((_, res) =>
    jsonResponse(res, 200, {
      id: "resp_test",
      model: "gpt-4.1-mini",
      output_text: "ok",
      usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
    }),
  );
});

afterEach(() => {
  getMockProvider().reset();
});

afterAll(async () => {
  await upstream.close();
  await provider.close();
  await ctx.cleanup();
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
});

describe("execution · per-run LLM token budget", () => {
  test("fails with llm_budget_exceeded when cumulative usage would exceed cap", async () => {
    getMockProvider().generateOverrides.workflow_step = () => ({ ok: true });
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "llm-budget-test",
      max_llm_tokens_per_run: 80,
      steps: [modelStep("first_call", "hi"), modelStep("second_call", "again")],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("llm_budget_exceeded");
    expect(workflowStepCalls()).toBe(1);
    const spent = await usageTotal(result.execution_id);
    expect(spent).toBeGreaterThan(0);
    const meta = await completedAudit(result.execution_id);
    expect(meta.total_llm_tokens).toBe(spent);
    expect(meta.max_llm_tokens_per_run).toBe(80);
  });

  test("uncapped run accumulates total_llm_tokens without enforcing", async () => {
    getMockProvider().generateOverrides.workflow_step = () => ({ ok: true });
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "llm-budget-uncapped",
      steps: [modelStep("call_a", "a"), modelStep("call_b", "b")],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    expect(workflowStepCalls()).toBe(2);
    const meta = await completedAudit(result.execution_id);
    expect(meta.total_llm_tokens).toBe(await usageTotal(result.execution_id));
    expect(meta.max_llm_tokens_per_run).toBeUndefined();
  });

  test("a reached AI budget stops the model step before the call, other steps still run", async () => {
    const at = new Date(now());
    await ctx.testDb.db.insert(llmUsage).values({
      tenant_id: ctx.tenantId,
      flow: "converse",
      model: "claude-sonnet-4-5",
      completion_tokens: 1_000_000,
      total_tokens: 1_000_000,
      result: "success",
      month_bucket: currentMonthBucket(at),
      created_at: at,
    });
    await ctx.testDb.db
      .update(tenants)
      .set({ spend_limit_usd: 1 })
      .where(eq(tenants.id, ctx.tenantId));
    try {
      const { workflow_id } = await createWorkflowRow(ctx, {
        name: "llm-budget-spend",
        steps: [
          { kind: "request", id: "plain_call", method: "GET", url: `${upstream.baseUrl}/plain` },
          modelStep("model_call", "hi"),
        ],
      });
      const callsBefore = upstream.callCount();
      const result = await runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id },
        input: null,
      });
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("llm_spend_limit_reached");
      expect(upstream.callCount() - callsBefore).toBe(1);
      expect(workflowStepCalls()).toBe(0);
    } finally {
      await ctx.testDb.db
        .update(tenants)
        .set({ spend_limit_usd: 50 })
        .where(eq(tenants.id, ctx.tenantId));
    }
  });
});

describe("execution · raw calls to a model provider host", () => {
  test("a request step to a provider host is accounted like a model step", async () => {
    await withProviderHost(async () => {
      const { workflow_id } = await createWorkflowRow(ctx, {
        name: "raw-provider-accounted",
        steps: [providerCall("raw_call", "hi")],
      });
      const result = await runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id },
        input: null,
      });
      expect(result.status).toBe("succeeded");
      expect(await usageTotal(result.execution_id)).toBe(60);
      const audits = await ctx.testDb.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, "external_write")));
      const llmAudit = audits.find((r) => r.resource_id === result.execution_id);
      const meta = (llmAudit?.metadata ?? {}) as Record<string, unknown>;
      expect(meta.provider).toBe("127.0.0.1");
      expect(meta.model).toBe("gpt-4.1-mini");
      expect(meta.total_tokens).toBe(60);
      expect((await completedAudit(result.execution_id)).total_llm_tokens).toBe(60);
    });
  });

  test("the per-run token cap stops the second raw provider call", async () => {
    await withProviderHost(async () => {
      const { workflow_id } = await createWorkflowRow(ctx, {
        name: "raw-provider-capped",
        max_llm_tokens_per_run: 100,
        steps: [providerCall("first_call", "hi"), providerCall("second_call", "again")],
      });
      const callsBefore = provider.callCount();
      const result = await runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id },
        input: null,
      });
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("llm_budget_exceeded");
      expect(provider.callCount() - callsBefore).toBe(1);
    });
  });

  test("a reached AI budget refuses the raw provider call before it leaves", async () => {
    await withProviderHost(async () => {
      await reachSpendLimit();
      try {
        const { workflow_id } = await createWorkflowRow(ctx, {
          name: "raw-provider-spend",
          steps: [providerCall("raw_call", "hi")],
        });
        const callsBefore = provider.callCount();
        const result = await runExecution({
          db: ctx.testDb.db,
          tenant_id: ctx.tenantId,
          source: { kind: "saved", workflow_id },
          input: null,
        });
        expect(result.status).toBe("failed");
        expect(result.error?.code).toBe("llm_spend_limit_reached");
        expect(provider.callCount() - callsBefore).toBe(0);
      } finally {
        await ctx.testDb.db
          .update(tenants)
          .set({ spend_limit_usd: 50 })
          .where(eq(tenants.id, ctx.tenantId));
      }
    });
  });
});
