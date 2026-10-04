import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectors, executions } from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { classifyFailure } from "../classify.ts";
import { runExecution } from "../engine.ts";
import { deriveExecutionOutcome } from "../outcome.ts";
import {
  createEngineCtx,
  createMockServer,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let mock: MockServer;
let prodId: string;
let devTwinId: string;
let upstreamHits = 0;

beforeAll(async () => {
  ctx = await createEngineCtx("disabled-connector");

  mock = await createMockServer((_req, res) => {
    upstreamHits += 1;
    jsonResponse(res, 200, { ok: true });
  });

  const [prod] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "mail-oauth",
      display_name: "Mail",
      driver: "http",
      environment: "prod",
      auth_type: "none",
      base_url: mock.baseUrl,
      config: {},
    })
    .returning();
  prodId = prod!.id;
  const [dev] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "mail-oauth",
      display_name: "Mail (dev)",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: mock.baseUrl,
      config: {},
      enabled: false,
    })
    .returning();
  devTwinId = dev!.id;
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

async function devTwin() {
  const rows = await ctx.testDb.db.select().from(connectors).where(eq(connectors.id, devTwinId));
  return rows[0]!;
}

function previewDraft(steps: unknown[]) {
  return runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "draft", definition: { name: "preview", steps } },
    input: null,
    options: { execution_mode: "dev", hold_writes: true },
  });
}

const readStep = (connector_id: string) => ({
  kind: "request",
  id: "list",
  method: "GET",
  connector_id,
  path: "/messages",
  max_retries: 0,
});

describe("a disabled connector refuses the step as itself", () => {
  test("draft preview against a disabled dev twin answers connector_disabled, naming the twin", async () => {
    upstreamHits = 0;
    const result = await previewDraft([readStep(prodId)]);

    expect(result.status).toBe("failed");
    const error = result.steps[0]?.error as {
      code?: string;
      message?: string;
      details?: Record<string, unknown>;
    } | null;
    expect(error?.code).toBe("connector_disabled");
    expect(error?.details).toEqual({
      step_id: "list",
      connector_id: devTwinId,
      connector_slug: "mail-oauth",
      connector_name: "Mail (dev)",
      environment: "dev",
      reason: "disabled",
    });
    expect(error?.message).toBe(
      'Connector "mail-oauth" in dev is disabled; enable it before this workflow can run.',
    );
    expect(upstreamHits).toBe(0);
    const twin = await devTwin();
    expect(twin.circuit_failure_count).toBe(0);
    expect(twin.circuit_state).toBe("closed");
  });

  test("the refusal wins over an open breaker on the same twin", async () => {
    upstreamHits = 0;
    await ctx.testDb.db
      .update(connectors)
      .set({ circuit_state: "open", circuit_opened_at: new Date(getTestNow()) })
      .where(eq(connectors.id, devTwinId));
    try {
      const result = await previewDraft([readStep(prodId)]);
      const error = result.steps[0]?.error as { code?: string } | null;
      expect(error?.code).toBe("connector_disabled");
      expect(error?.code).not.toBe("circuit_open");
      expect(upstreamHits).toBe(0);
    } finally {
      await ctx.testDb.db
        .update(connectors)
        .set({ circuit_state: "closed", circuit_opened_at: null })
        .where(eq(connectors.id, devTwinId));
    }
  });

  test("the failed run reads connector_unavailable and names the twin to enable", async () => {
    const result = await previewDraft([readStep(prodId)]);
    expect(result.error?.code).toBe("connector_disabled");

    const [row] = await ctx.testDb.db
      .select()
      .from(executions)
      .where(eq(executions.id, result.execution_id));
    expect(row?.failure?.connector).toEqual({ connector_id: devTwinId, reason: "disabled" });

    const outcome = deriveExecutionOutcome(
      { status: row!.status, failure: row!.failure, output_contract: row!.output_contract },
      [],
      [{ id: "list", kind: "request" }],
    );
    expect(outcome.cause_class).toBe("connector_unavailable");
    expect(outcome.error_code).toBe("connector_disabled");
    expect(outcome.connector).toEqual({ connector_id: devTwinId, reason: "disabled" });
  });

  test("the exact code classifies before the message matchers", () => {
    expect(
      classifyFailure({
        status: "failed",
        retry_count: 0,
        duration_ms: 0,
        error: {
          code: "connector_disabled",
          message:
            'Connector "mail-oauth" in dev is disabled; enable it before this workflow can run.',
        },
      }),
    ).toBe("connector_unavailable");
  });

  test("once the twin is enabled again the same preview reaches the remote", async () => {
    upstreamHits = 0;
    await ctx.testDb.db
      .update(connectors)
      .set({ enabled: true })
      .where(eq(connectors.id, devTwinId));
    try {
      const result = await previewDraft([readStep(prodId)]);
      expect(result.status).toBe("succeeded");
      expect(upstreamHits).toBe(1);
    } finally {
      await ctx.testDb.db
        .update(connectors)
        .set({ enabled: false })
        .where(eq(connectors.id, devTwinId));
    }
  });
});
